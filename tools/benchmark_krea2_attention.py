"""Idle-GPU-only Krea2 attention fwd+bwd benchmark, not whole-training speed.

Never loads model weights, installs packages, edits configs, or stops processes.
Refuses to initialize CUDA while another compute process is present.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import statistics
import subprocess
import sys
import time
import xml.etree.ElementTree as ET


REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))


def require_idle_gpu(*, check_utilization: bool = False) -> None:
    """Fail closed on unavailable telemetry; call before CUDA and each case."""
    result = subprocess.run(
        ["nvidia-smi", "-q", "-x"],
        capture_output=True, text=True, check=True, timeout=10,
    )
    try:
        devices = ET.fromstring(result.stdout).findall("gpu")
    except ET.ParseError as exc:
        raise RuntimeError("Cannot parse GPU telemetry") from exc
    if not devices:
        raise RuntimeError("No GPU telemetry available")
    for device in devices:
        if device.find("processes") is None:
            raise RuntimeError("GPU process telemetry unavailable")
        for process in device.findall("processes/process_info"):
            pid = int(process.findtext("pid", "-1"))
            kind = process.findtext("type", "")
            name = process.findtext("process_name", "")
            # WDDM lists desktop windows as C+G even when they only render UI.
            # Still reject Python and all pure-compute/unknown processes.
            compute = kind not in ("G", "C+G") or "python" in name.lower()
            if pid != os.getpid() and compute:
                raise RuntimeError(f"GPU busy: PID {pid} ({name}); benchmark not started")
        if check_utilization:
            usage = device.findtext("utilization/gpu_util", "").removesuffix("%").strip()
            if not usage.isdigit() or int(usage) > 10:
                raise RuntimeError(f"GPU not idle (utilization={usage!r}); benchmark not started")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--image-tokens", type=int, default=4096)
    parser.add_argument("--text-tokens", type=int, default=512)
    parser.add_argument("--valid-text-tokens", type=int, default=192)
    parser.add_argument("--batch", type=int, default=1)
    parser.add_argument("--iterations", type=int, default=20)
    args = parser.parse_args()
    if (args.image_tokens < 1 or args.batch < 1 or args.iterations < 3
            or not 0 <= args.valid_text_tokens <= args.text_tokens):
        parser.error("positive image tokens/batch, >=3 iterations, and valid text within padded length required")
    # Do not even import torch until the running training has been excluded.
    try:
        require_idle_gpu(check_utilization=True)
    except (RuntimeError, subprocess.SubprocessError, OSError) as exc:
        print(str(exc), file=sys.stderr)
        return 2

    import torch
    from torch.nn import functional as F
    from modeling import attention as attn

    if not torch.cuda.is_available():
        raise RuntimeError("CUDA is unavailable")
    torch.manual_seed(42)
    length = args.image_tokens + args.text_tokens
    mask = torch.ones(args.batch, length, device="cuda", dtype=torch.bool)
    mask[:, args.valid_text_tokens:args.text_tokens] = False
    if args.batch > 1:
        mask[1, max(0, args.valid_text_tokens // 2):args.text_tokens] = False
    packing = attn.AttentionPacking.from_mask(mask)
    tensors = [torch.randn(args.batch, length, heads, 128, device="cuda", dtype=torch.bfloat16)
               for heads in (48, 12, 12)]
    upstream = torch.randn_like(tensors[0]) * mask[:, :, None, None]
    # A benchmark must never report a silently fallen-back kernel as fast.
    def forbid_fallback(*details):
        raise RuntimeError(f"Backend fell back to SDPA: {details}")
    attn._warn_fallback = forbid_fallback

    def step(backend):
        q, k, v = [t.detach().requires_grad_() for t in tensors]
        if backend == "legacy_sdpa":
            out = F.scaled_dot_product_attention(
                q.transpose(1, 2), k.repeat_interleave(4, 2).transpose(1, 2),
                v.repeat_interleave(4, 2).transpose(1, 2), attn_mask=mask[:, None, None, :],
            ).transpose(1, 2)
        else:
            out = attn.attention_padded_bshd(q, k, v, packing, backend, stage="benchmark")
        out.backward(upstream)
        return out.detach(), q.grad, k.grad, v.grad

    report = {
        "scope": "attention only; forward+backward; excludes projections/MLP/optimizer/FP8 conversion",
        "metadata_cost": "packing built once, outside timing, as reused across model layers",
        "torch": torch.__version__, "gpu": torch.cuda.get_device_name(),
        "shape": {k: v for k, v in vars(args).items() if k != "output"},
        "results": {},
    }
    require_idle_gpu()
    reference = tuple(t.cpu() for t in step("legacy_sdpa"))
    for backend in ("legacy_sdpa", "none", "flash_attn", "xformers"):
        require_idle_gpu()
        if backend not in ("legacy_sdpa", "none") and not attn.backend_available(backend):
            report["results"][backend] = {"status": "not installed/importable"}
            continue
        try:
            actual = step(backend)
            errors = []
            for index, (a, b) in enumerate(zip(actual, reference)):
                a = a.cpu().float()
                b = b.float()
                if index == 0:
                    a, b = a[mask.cpu()], b[mask.cpu()]
                relative = (a - b).norm().item() / max(b.norm().item(), 1e-12)
                errors.append(relative)
                if relative > 0.03:
                    raise RuntimeError(f"Output/gradient {index} relative error {relative:.4g} > 0.03")
            del actual
            for _ in range(3):
                step(backend)
            torch.cuda.synchronize()
            torch.cuda.reset_peak_memory_stats()
            elapsed = []
            for _ in range(args.iterations):
                require_idle_gpu()
                start, end = torch.cuda.Event(enable_timing=True), torch.cuda.Event(enable_timing=True)
                start.record()
                step(backend)
                end.record()
                end.synchronize()
                elapsed.append(start.elapsed_time(end))
            report["results"][backend] = {
                "status": "passed", "median_ms": statistics.median(elapsed),
                "min_ms": min(elapsed), "max_ms": max(elapsed),
                "peak_allocated_bytes": torch.cuda.max_memory_allocated(),
                "relative_errors_output_q_k_v": errors,
            }
        except RuntimeError as exc:
            report["results"][backend] = {"status": "failed", "error": str(exc)}
    baseline = report["results"].get("legacy_sdpa", {}).get("median_ms")
    if baseline:
        for result in report["results"].values():
            if "median_ms" in result:
                result["attention_speedup_vs_legacy"] = baseline / result["median_ms"]
    report["completed_at"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))
    return int(any(r["status"] == "failed" for r in report["results"].values()))


if __name__ == "__main__":
    raise SystemExit(main())
