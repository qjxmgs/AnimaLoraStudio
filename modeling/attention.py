"""族无关的注意力后端分发：flash-attn 包 / xformers / PyTorch SDPA。

Windows 版 PyTorch 没有把 FlashAttention 内核编进 SDPA（torch 2.11 + RTX 5090 实测：
SDPA 自动落到 EFFICIENT 内核，单层 fwd+bwd 比 flash-attn 包 / xformers 慢约 4 倍），
所以选用专用包是实打实的提速，不是可有可无的选项。

后端按模型实例设置（族的 ``load_dit`` 经 ``training.model_loading.apply_attention_backend``
调模型的 ``set_attention_backend``），不做进程级全局开关：daemon 里先后加载的不同族
模型互不影响。Anima 的 ``cosmos_predict2_modeling`` 有自己的历史状态机，不走本模块。

``attention_bshd`` 只覆盖无 mask 的稠密注意力，带 padding mask 的调用方须先去 pad
（varlen）再进来；NaViT 打包序列走 ``attention_block_diagonal_bshd``（每段只看自己）。
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from functools import cache

import torch
from torch.nn import functional as F

logger = logging.getLogger(__name__)

SDPA = "none"
FLASH_ATTN = "flash_attn"
XFORMERS = "xformers"
ATTENTION_BACKENDS = (SDPA, FLASH_ATTN, XFORMERS)

_FALLBACK_WARNED: set[tuple[str, str]] = set()


@cache
def _flash_attn_func():
    try:
        from flash_attn import flash_attn_func
    except Exception:  # noqa: BLE001  未装 / 与 torch ABI 不匹配都按不可用
        return None
    return flash_attn_func


@cache
def _flash_attn_varlen_func():
    try:
        from flash_attn import flash_attn_varlen_func
    except Exception:  # noqa: BLE001
        return None
    return flash_attn_varlen_func


@cache
def _xformers_attention():
    try:
        from xformers.ops import memory_efficient_attention
    except Exception:  # noqa: BLE001  同上
        return None
    return memory_efficient_attention


def _backend_fn(backend: str):
    if backend == FLASH_ATTN:
        return _flash_attn_func()
    if backend == XFORMERS:
        return _xformers_attention()
    return None


def backend_available(backend: str) -> bool:
    """``backend`` 所需的包能否导入；SDPA 恒可用。"""
    return backend == SDPA or _backend_fn(backend) is not None


def attention_bshd(q: torch.Tensor, k: torch.Tensor, v: torch.Tensor,
                   backend: str = SDPA, *, stage: str = "attention") -> torch.Tensor:
    """无 mask 的多头注意力，输入输出都是 ``[B, S, H, D]``。

    选中的包不可用或调用失败（如 fp32 输入）时退回 SDPA，同一 (backend, stage) 只警告一次。
    """
    # FlashAttention supports native GQA. xformers' 5D GQA path has no
    # backward, so use ordinary 4D MHA with contiguous groups of repeated KV.
    if backend != FLASH_ATTN:
        k, v = _expand_kv_heads(q, k, v)
    fn = _backend_fn(backend)
    if fn is not None:
        try:
            return fn(q, k, v)
        except Exception as exc:  # noqa: BLE001  fast path 失败一律退回 SDPA
            _warn_fallback(backend, stage, tuple(q.shape), q.dtype, exc)
    k, v = _expand_kv_heads(q, k, v)
    out = F.scaled_dot_product_attention(q.transpose(1, 2), k.transpose(1, 2), v.transpose(1, 2))
    return out.transpose(1, 2)


def _expand_kv_heads(q, k, v):
    if q.shape[-2] != k.shape[-2]:
        if q.shape[-2] % k.shape[-2] or k.shape[-2] != v.shape[-2]:
            raise ValueError("GQA requires query heads divisible by equal key/value heads")
        repeat = q.shape[-2] // k.shape[-2]
        k = k.repeat_interleave(repeat, dim=-2)
        v = v.repeat_interleave(repeat, dim=-2)
    return k, v


@dataclass(frozen=True)
class AttentionPacking:
    """Reusable self-attention padding metadata; no per-layer CUDA .item().

    Only valid queries are returned. Padded outputs are zero, so callers must
    continue masking these tokens in subsequent layers (or discard them).
    Empty samples are omitted from the packed batch, preserving their zeros.
    """

    indices: torch.Tensor
    seqlens: tuple[int, ...]
    cu_seqlens: torch.Tensor
    batch: int
    padded_length: int

    @classmethod
    def from_mask(cls, mask: torch.Tensor) -> AttentionPacking:
        if mask.ndim != 2 or mask.dtype != torch.bool:
            raise ValueError("AttentionPacking requires a boolean [B, S] mask")
        lengths = tuple(int(n) for n in mask.sum(1).tolist() if n)
        cu = torch.tensor((0, *lengths), device=mask.device, dtype=torch.int32).cumsum(0, dtype=torch.int32)
        return cls(mask.flatten().nonzero().flatten(), lengths, cu, *mask.shape)


def attention_padded_bshd(q: torch.Tensor, k: torch.Tensor, v: torch.Tensor,
                          packing: AttentionPacking, backend: str = SDPA, *,
                          stage: str = "attention") -> torch.Tensor:
    """Unpad self-attention, run dense/varlen GQA, restore [B,S,H,D].

    FlashAttention uses native GQA; xformers uses 4D repeated KV and a block
    diagonal bias. Fallback remains per-sample, never mixing batch members.
    Metadata should be constructed once per model forward and reused by all
    layers, including gradient-checkpoint recomputation.
    """
    if any(t.shape[:2] != (packing.batch, packing.padded_length) for t in (q, k, v)):
        raise ValueError("Attention packing does not match Q/K/V batch and sequence")
    if not packing.seqlens:
        return q * 0 + (k.sum() + v.sum()) * 0
    qp, kp, vp = (t.flatten(0, 1).index_select(0, packing.indices) for t in (q, k, v))
    if len(packing.seqlens) == 1:
        out = attention_bshd(qp[None], kp[None], vp[None], backend, stage=stage)[0]
    else:
        out = None
        if backend == FLASH_ATTN:
            fn = _flash_attn_varlen_func()
            if fn is not None:
                try:
                    maximum = max(packing.seqlens)
                    out = fn(qp, kp, vp, packing.cu_seqlens, packing.cu_seqlens,
                             maximum, maximum)
                except Exception as exc:  # noqa: BLE001
                    _warn_fallback(backend, stage, tuple(q.shape), q.dtype, exc)
            else:
                _warn_fallback(backend, stage, tuple(q.shape), q.dtype,
                               RuntimeError("flash_attn_varlen_func unavailable"))
        elif backend == XFORMERS:
            fn = _xformers_attention()
            if fn is not None:
                try:
                    kp, vp = _expand_kv_heads(qp, kp, vp)
                    out = fn(qp[None], kp[None], vp[None],
                             attn_bias=_block_diagonal_mask(packing.seqlens))[0]
                except Exception as exc:  # noqa: BLE001
                    _warn_fallback(backend, stage, tuple(q.shape), q.dtype, exc)
        if out is None:
            out = torch.cat([
                attention_bshd(qs[None], ks[None], vs[None], SDPA, stage=stage)[0]
                for qs, ks, vs in zip(qp.split(packing.seqlens), kp.split(packing.seqlens),
                                      vp.split(packing.seqlens))
            ])
    restored = out.new_zeros((packing.batch * packing.padded_length, *out.shape[1:]))
    return restored.index_copy(0, packing.indices, out).reshape_as(q)


@cache
def _block_diagonal_mask(seqlens: tuple[int, ...]):
    """xformers ``BlockDiagonalMask``（纯 CPU 元数据，按段长缓存，跨层 / 重算复用）。"""
    from xformers.ops.fmha import BlockDiagonalMask

    return BlockDiagonalMask.from_seqlens(list(seqlens))


def attention_block_diagonal_bshd(q: torch.Tensor, k: torch.Tensor, v: torch.Tensor,
                                  seqlens, backend: str = SDPA, *,
                                  stage: str = "attention") -> torch.Tensor:
    """块对角多头注意力：``[1, ΣS, H, D]`` 按 ``seqlens`` 切段，每段只注意自己。

    xformers 走 ``BlockDiagonalMask`` 的 varlen 内核；其余后端（或 xformers 失败）
    逐段调 ``attention_bshd``，数值等价、速度较慢。
    """
    seqlens = tuple(int(n) for n in seqlens)
    if q.shape[0] != 1 or sum(seqlens) != q.shape[1]:
        raise ValueError(f"块对角注意力要求 [1, ΣS, H, D] 且段长之和 = S，实际 {tuple(q.shape)} / {seqlens}")
    if len(seqlens) == 1:
        return attention_bshd(q, k, v, backend, stage=stage)
    fn = _xformers_attention() if backend == XFORMERS else None
    if fn is not None:
        try:
            return fn(q, k, v, attn_bias=_block_diagonal_mask(seqlens))
        except Exception as exc:  # noqa: BLE001  fast path 失败一律逐段
            _warn_fallback(backend, stage, tuple(q.shape), q.dtype, exc)
    parts = [
        attention_bshd(qs, ks, vs, backend, stage=stage)
        for qs, ks, vs in zip(q.split(seqlens, 1), k.split(seqlens, 1), v.split(seqlens, 1))
    ]
    return torch.cat(parts, 1)


def _warn_fallback(backend: str, stage: str, shape: tuple, dtype, exc: Exception) -> None:
    key = (backend, stage)
    if key in _FALLBACK_WARNED:
        return
    _FALLBACK_WARNED.add(key)
    logger.warning(
        "%s fallback at %s shape=%s dtype=%s: %s — attention runs on PyTorch SDPA "
        "(warns only once per stage)", backend, stage, shape, dtype, exc,
    )
