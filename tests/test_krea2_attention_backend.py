"""Krea2 fast attention: padding, GQA, gradients, loader and daemon hooks."""
from __future__ import annotations

import copy
import sys
import types

import pytest
import torch
from torch.nn import functional as F

from modeling import attention as attn
from modeling.krea2 import Attention, SingleStreamDiT
from tests.test_krea2_modeling import _tiny_config, _tiny_inputs


def _reference(q, k, v):
    repeat = q.shape[2] // k.shape[2]
    return F.scaled_dot_product_attention(
        q.transpose(1, 2), k.repeat_interleave(repeat, 2).transpose(1, 2),
        v.repeat_interleave(repeat, 2).transpose(1, 2),
    ).transpose(1, 2)


@pytest.fixture
def fake_backends(monkeypatch):
    calls = []

    def dense(q, k, v):
        calls.append(("flash", q.shape, k.shape))
        return _reference(q, k, v)

    def varlen(q, k, v, cuq, cuk, maxq, maxk):
        assert cuq.dtype == torch.int32
        assert torch.equal(cuq, cuk)
        lengths = (cuq[1:] - cuq[:-1]).tolist()
        assert maxq == maxk == max(lengths)
        calls.append(("varlen", q.shape, k.shape))
        return torch.cat([
            _reference(qs[None], ks[None], vs[None])[0]
            for qs, ks, vs in zip(q.split(lengths), k.split(lengths), v.split(lengths))
        ])

    def xformers(q, k, v, attn_bias=None):
        assert q.ndim == k.ndim == v.ndim == 4
        assert q.shape[2] == k.shape[2] == v.shape[2]
        calls.append(("xformers", q.shape, k.shape))
        if attn_bias is None:
            return _reference(q, k, v)
        return torch.cat([
            _reference(qs, ks, vs)
            for qs, ks, vs in zip(q.split(attn_bias, 1), k.split(attn_bias, 1),
                                  v.split(attn_bias, 1))
        ], 1)

    def unexpected_fallback(*args):
        pytest.fail(f"Unexpected attention fallback: {args}")

    monkeypatch.setattr(attn, "_flash_attn_func", lambda: dense)
    monkeypatch.setattr(attn, "_flash_attn_varlen_func", lambda: varlen)
    monkeypatch.setattr(attn, "_xformers_attention", lambda: xformers)
    monkeypatch.setattr(attn, "_block_diagonal_mask", lambda lengths: lengths)
    monkeypatch.setattr(attn, "_warn_fallback", unexpected_fallback)
    return calls


@pytest.mark.parametrize("backend", ["flash_attn", "xformers"])
@pytest.mark.parametrize("checkpoint", [False, True])
@pytest.mark.parametrize("mask_kind", ["none", "full", "ragged", "holes", "empty"])
def test_model_outputs_and_all_gradients_match_sdpa(fake_backends, backend, checkpoint, mask_kind):
    torch.manual_seed(42)
    reference = SingleStreamDiT(_tiny_config()).train()
    model = copy.deepcopy(reference)
    model.set_attention_backend(backend)
    x, t, context, mask = _tiny_inputs()
    if mask_kind == "none":
        mask = None
    elif mask_kind == "full":
        mask[:] = True
    elif mask_kind == "holes":
        mask = torch.tensor([[False, True, False, True, False], [True, False, True, True, False]])
    elif mask_kind == "empty":
        mask[0] = False
    inputs = [(x.clone().requires_grad_(), context.clone().requires_grad_()) for _ in range(2)]
    outputs = []
    for module, (xi, ci) in zip((reference, model), inputs):
        output = module(xi, t, ci, mask, use_checkpoint=checkpoint)
        output.square().mean().backward()
        outputs.append(output)
    torch.testing.assert_close(outputs[1], outputs[0], atol=2e-6, rtol=2e-5)
    for a, b in zip(inputs[0], inputs[1]):
        torch.testing.assert_close(a.grad, b.grad, atol=2e-6, rtol=2e-4)
    for (name, a), (_, b) in zip(reference.named_parameters(), model.named_parameters()):
        assert a.grad is not None and b.grad is not None, name
        torch.testing.assert_close(a.grad, b.grad, atol=2e-6, rtol=2e-4, msg=name)
    assert fake_backends
    if backend == "flash_attn":
        assert any(q[-2] > k[-2] for _, q, k in fake_backends)
        if mask_kind in ("ragged", "holes", "full"):
            assert any(kind == "varlen" for kind, _, _ in fake_backends)


@pytest.mark.parametrize("backend", ["flash_attn", "xformers"])
def test_single_sample_unpadding_and_all_empty_text(fake_backends, backend):
    torch.manual_seed(9)
    model = SingleStreamDiT(_tiny_config()).train()
    x, t, ctx, mask = (v[:1] for v in _tiny_inputs())
    for valid in (True, False):
        mask[:] = valid
        model.set_attention_backend("none")
        ref = model(x, t, ctx, mask)
        model.set_attention_backend(backend)
        out = model(x, t, ctx, mask)
        torch.testing.assert_close(out, ref, atol=2e-6, rtol=2e-5)
        out.mean().backward()
    assert all(kind != "varlen" for kind, _, _ in fake_backends)


@pytest.mark.parametrize("backend", ["flash_attn", "xformers"])
def test_missing_or_failing_backend_preserves_padding_and_gqa(monkeypatch, backend):
    def boom(*args, **kwargs):
        raise RuntimeError("unsupported kernel")

    for fn in (None, boom):
        monkeypatch.setattr(attn, "_flash_attn_func", lambda: fn)
        monkeypatch.setattr(attn, "_flash_attn_varlen_func", lambda: fn)
        monkeypatch.setattr(attn, "_xformers_attention", lambda: fn)
        model = SingleStreamDiT(_tiny_config())
        values = _tiny_inputs()
        ref = model(*values)
        model.set_attention_backend(backend)
        out = model(*values)
        torch.testing.assert_close(out, ref, atol=2e-6, rtol=2e-5)
        out.mean().backward()


def test_backend_is_per_instance_and_does_not_change_state_dict():
    model = SingleStreamDiT(_tiny_config())
    other = SingleStreamDiT(_tiny_config())
    keys = set(model.state_dict())
    model.enable_xformers_memory_efficient_attention()
    assert model.attention_backend == "xformers"
    assert all(m.attention_backend == "xformers" for m in model.modules() if isinstance(m, Attention))
    assert other.attention_backend == "none"
    assert set(model.state_dict()) == keys
    with pytest.raises(ValueError):
        model.set_attention_backend("invalid")


@pytest.mark.parametrize("backend", ["flash_attn", "xformers"])
def test_fp8_lora_checkpoint_gradients_match_sdpa(fake_backends, backend):
    from training.families.krea2.preset import KREA2_PRESET
    from training.families.krea2.quant_fp8 import patch_fp8_linears
    from utils.lycoris_adapter import LycorisAdapter

    results = []
    values = _tiny_inputs()
    for selected in ("none", backend):
        torch.manual_seed(71)
        model = SingleStreamDiT(_tiny_config()).requires_grad_(False)
        scales = {}
        for name, module in model.named_modules():
            if isinstance(module, torch.nn.Linear):
                module.weight.data = (module.weight.data / 0.02).to(torch.float8_e4m3fn)
                scales[name] = torch.tensor(0.02)
        patch_fp8_linears(model, scales)
        adapter = LycorisAdapter(preset=KREA2_PRESET, algo="lora", rank=2, alpha=2)
        adapter.inject(model)
        # Nonzero up/down matrices exercise both LoRA gradient branches.
        parameters = list(adapter.get_params())
        with torch.no_grad():
            for p in parameters:
                p.normal_(std=0.01)
        model.train()
        model.enable_gradient_checkpointing()
        model.set_attention_backend(selected)
        output = model(*values)
        output.square().mean().backward()
        assert all(p.grad is not None and torch.isfinite(p.grad).all() for p in parameters)
        results.append((output.detach(), [p.grad.clone() for p in parameters]))
        adapter.detach()
    torch.testing.assert_close(results[0][0], results[1][0], atol=2e-6, rtol=2e-5)
    for a, b in zip(results[0][1], results[1][1]):
        torch.testing.assert_close(a, b, atol=2e-6, rtol=2e-4)


@pytest.mark.parametrize("purpose", ["train", "generate"])
@pytest.mark.parametrize("backend", ["none", "flash_attn", "xformers"])
def test_family_loader_applies_backend(monkeypatch, fake_backends, purpose, backend):
    from training.families.krea2 import Krea2Family
    from training.families.krea2 import loader
    from training.model_loading import enable_xformers

    calls = []
    def load(*args, **kwargs):
        calls.append(kwargs)
        return SingleStreamDiT(_tiny_config())
    monkeypatch.setattr(loader, "load_krea2_model", load)
    package = types.ModuleType("xformers")
    ops = types.ModuleType("xformers.ops")
    ops.memory_efficient_attention = _reference
    package.ops = ops
    monkeypatch.setitem(sys.modules, "xformers", package)
    monkeypatch.setitem(sys.modules, "xformers.ops", ops)
    model = Krea2Family().load_dit("test", "cpu", torch.float32,
                                  purpose=purpose, blocks_to_swap=2, attention_backend=backend)
    assert model.attention_backend == backend
    assert calls == [{"purpose": purpose, "blocks_to_swap": 2}]
    # The daemon invokes this hook separately after loading.
    assert enable_xformers(model)
    assert model.attention_backend == "xformers"


@pytest.mark.skipif(not torch.cuda.is_available(), reason="requires an idle CUDA GPU")
@pytest.mark.parametrize("backend", ["flash_attn", "xformers"])
@pytest.mark.parametrize("batch", [1, 2])
def test_real_cuda_kernel_outputs_and_gradients(monkeypatch, backend, batch):
    if not attn.backend_available(backend):
        pytest.skip(f"{backend} is not installed")
    monkeypatch.setattr(attn, "_warn_fallback", lambda *args: pytest.fail(f"fallback: {args}"))
    torch.manual_seed(19)
    mask = torch.tensor([[True, True, False, True, False], [True, False, True, True, True]], device="cuda")[:batch]
    packing = attn.AttentionPacking.from_mask(mask)
    tensors = [torch.randn(batch, 5, h, 64, device="cuda", dtype=torch.bfloat16) for h in (8, 2, 2)]
    results = []
    for selected in ("none", backend):
        q, k, v = [t.detach().clone().requires_grad_() for t in tensors]
        out = attn.attention_padded_bshd(q, k, v, packing, selected)
        out.float().square().mean().backward()
        results.append((out, q.grad, k.grad, v.grad))
    for a, b in zip(*results):
        torch.testing.assert_close(a, b, atol=1e-2, rtol=5e-2)
        relative_error = (a.float() - b.float()).norm() / a.float().norm().clamp_min(1e-12)
        assert relative_error.item() < 0.03
