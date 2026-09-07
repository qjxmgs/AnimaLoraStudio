"""Executed ONLY with the independent export interpreter, never imported by Studio."""
from __future__ import annotations

import json
import logging
from pathlib import Path
import sys


def main() -> None:
    import importlib.metadata
    import numpy as np
    import onnx
    import onnxruntime as ort
    import torch
    from ultralytics import YOLO

    source = Path(sys.argv[1]).resolve()
    torch.set_num_threads(2)
    yolo = YOLO(str(source))
    exported = Path(yolo.export(
        format="onnx", imgsz=640, batch=1, half=False, dynamic=False,
        simplify=False, opset=17, nms=False, device="cpu",
    ))
    model = onnx.load(str(exported))
    onnx.checker.check_model(model)
    session = ort.InferenceSession(str(exported), providers=["CPUExecutionProvider"])
    # Configure the unfused PyTorch reference identically to the raw export head.
    reference = yolo.model.cpu().float().eval()
    reference.fuse()
    head = reference.model[-1]
    head.export, head.format, head.dynamic = True, "onnx", False
    max_errors = []
    for seed in (0, 7, 42):
        tensor = np.random.default_rng(seed).random((1, 3, 640, 640), dtype=np.float32)
        with torch.inference_mode():
            expected = reference(torch.from_numpy(tensor))
        actual = session.run(None, {session.get_inputs()[0].name: tensor})
        if len(expected) != 2 or len(actual) != 2:
            raise RuntimeError("Expected raw face predictions and mask prototypes")
        for ref, got in zip(expected, actual):
            wanted = ref.cpu().numpy()
            np.testing.assert_allclose(got, wanted, rtol=2e-3, atol=2e-3)
            max_errors.append(float(np.max(np.abs(got - wanted))))
    exported.replace(source.with_name("model.onnx"))
    report = {
        "parity_passed": True, "parity_max_abs_errors": max_errors,
        "input_size": [640, 640], "opset": 17, "dtype": "float32",
        "packages": {p: importlib.metadata.version(p) for p in (
            "ultralytics", "torch", "torchvision", "onnx", "onnxruntime", "numpy", "pillow",
        )},
    }
    source.with_name("parity.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    logging.basicConfig(level=logging.INFO)
    logging.getLogger(__name__).info("PyTorch / ONNX parity passed")


if __name__ == "__main__":
    main()
