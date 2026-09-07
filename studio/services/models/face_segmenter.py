"""Pinned face model preparation. Export dependencies never enter Studio's venv."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import uuid

from .paths import models_root
from . import sources

REPO = "Anzhc/Anzhcs_YOLOs"
REVISION = "f5a2306d7fed4f3cfc26c25ff1ab2e3f3cfce855"
FILENAME = "Anzhc Face seg 640 v4 y11n.pt"
SIZE = 6_020_644
SHA256 = "1e77ad7bd349babd8a4a90478bfc965348642b63a8d95d3b43ee13db42fd0a64"
EXPORT_VERSION = 1
EXPORT_PACKAGES = (
    "ultralytics==8.3.216", "onnx==1.19.0", "onnxruntime==1.22.1",
    "numpy==2.2.6", "pillow==11.3.0",
)


def model_dir(root: Path | None = None) -> Path:
    return (root or models_root()) / "preprocess" / "face_segmenter"


def digest(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def status(root: Path | None = None) -> dict:
    folder = model_dir(root)
    try:
        manifest = json.loads((folder / "ready.json").read_text(encoding="utf-8"))
        artifact = manifest["artifact"]
        if not isinstance(artifact, str) or not artifact.isalnum():
            raise ValueError("Invalid artifact identity")
        target = folder / artifact / "model.onnx"
        valid = (
            manifest["source_sha256"] == SHA256
            and manifest["revision"] == REVISION
            and manifest["export_version"] == EXPORT_VERSION
            and manifest["parity_passed"] is True
            and target.stat().st_size == manifest["size"]
            and digest(target) == manifest["sha256"]
        )
        return {**manifest, "valid": valid, "exists": target.is_file(), "target_path": str(target)}
    except (OSError, ValueError, KeyError, TypeError):
        return {"valid": False, "exists": False, "size": 0, "target_path": ""}


def target(root: Path | None = None) -> Path:
    info = status(root)
    if not info["valid"]:
        raise RuntimeError("Face segmenter is missing or damaged; download and prepare it first")
    return Path(info["target_path"])


def _run(args: list[str], log, *, cwd: Path, env: dict[str, str]) -> None:
    with subprocess.Popen(
        args, cwd=cwd, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, encoding="utf-8", errors="replace",
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
    ) as proc:
        assert proc.stdout is not None
        for line in proc.stdout:
            log.info("%s", line.rstrip())
        if proc.wait():
            raise RuntimeError(f"Face model preparation failed (exit {proc.returncode}); see preparation log")


def prepare(root: Path | None = None, *, on_log) -> bool:
    if status(root)["valid"]:
        on_log.info("Face segmenter already verified")
        return True
    folder = model_dir(root)
    folder.mkdir(parents=True, exist_ok=True)
    # A new immutable artifact plus a single ready pointer: failed exports cannot
    # replace any installed model, including failures between model/metadata writes.
    artifact = uuid.uuid4().hex
    staging = folder / artifact
    staging.mkdir()
    source = staging / "source.pt"
    if not sources.download_flat(REPO, FILENAME, source, revision=REVISION, on_log=on_log):
        return False
    if source.stat().st_size != SIZE or digest(source) != SHA256:
        on_log.error("Face checkpoint failed size/SHA-256 validation; conversion refused")
        return False
    export_env = folder / "export-env-v1"
    python = export_env / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    env = dict(os.environ)
    env.pop("PYTHONPATH", None)
    env.pop("PYTHONHOME", None)
    (folder / "export-config").mkdir(exist_ok=True)
    env.update(PYTHONUTF8="1", PYTHONNOUSERSITE="1", YOLO_CONFIG_DIR=str(folder / "export-config"),
               PIP_DEFAULT_TIMEOUT="120", PIP_RETRIES="5", PIP_PROGRESS_BAR="off")
    if not python.is_file():
        on_log.info("Creating independent export environment (Studio packages are unchanged)")
        _run([sys.executable, "-m", "venv", str(export_env)], on_log, cwd=folder, env=env)
    marker = export_env / "prepared-v1.json"
    if not marker.is_file():
        on_log.info("Installing pinned CPU export dependencies (first preparation only)")
        _run([str(python), "-m", "pip", "install", "pip==25.3"], on_log, cwd=folder, env=env)
        _run([str(python), "-m", "pip", "install", "torch==2.5.1", "torchvision==0.20.1",
              "--index-url", "https://download.pytorch.org/whl/cpu"], on_log, cwd=folder, env=env)
        _run([str(python), "-m", "pip", "install", *EXPORT_PACKAGES], on_log, cwd=folder, env=env)
        marker.write_text(json.dumps(list(EXPORT_PACKAGES)), encoding="utf-8")
    script = Path(__file__).with_name("face_segmenter_export.py")
    on_log.info("Exporting face model and verifying PyTorch/ONNX output parity")
    _run([str(python), str(script), str(source)], on_log, cwd=staging, env=env)
    report = json.loads((staging / "parity.json").read_text(encoding="utf-8"))
    if report.get("parity_passed") is not True:
        raise RuntimeError("Face ONNX output parity validation failed")
    output = staging / "model.onnx"
    manifest = {
        **report, "artifact": artifact, "revision": REVISION, "source_sha256": SHA256,
        "export_version": EXPORT_VERSION, "size": output.stat().st_size, "sha256": digest(output),
    }
    pending = folder / f"ready-{artifact}.tmp"
    pending.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    os.replace(pending, folder / "ready.json")
    on_log.info("Face segmenter prepared and verified: %s", output)
    return True
