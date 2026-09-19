"""Pinned, directly runnable anime foreground ONNX model."""
from __future__ import annotations

import os
import tempfile
from pathlib import Path

from . import sources
from .face_segmenter import digest
from .paths import models_root

REPO = "skytnt/anime-seg"
REVISION = "493cb60893f47441b26ec4fb9a306bce9e342982"
FILENAME = "isnetis.onnx"
SIZE = 176_069_933
SHA256 = "f15622d853e8260172812b657053460e20806f04b9e05147d49af7bed31a6e99"
_verified: dict[str, tuple[tuple[int, int, int], bool]] = {}


def model_path(root: Path | None = None) -> Path:
    return (root or models_root()) / "preprocess" / "background_segmenter" / FILENAME


def status(root: Path | None = None, *, force_verify: bool = False) -> dict:
    path = model_path(root)
    valid, size = False, 0
    try:
        stat = path.stat()
        size = stat.st_size
        signature = (size, stat.st_mtime_ns, stat.st_ctime_ns)
        cached = _verified.get(str(path))
        if force_verify or cached is None or cached[0] != signature:
            valid = size == SIZE and digest(path) == SHA256
            _verified[str(path)] = (signature, valid)
        else:
            valid = cached[1]
    except OSError:
        _verified.pop(str(path), None)
    return {"valid": valid, "exists": path.is_file(), "size": size,
            "target_path": str(path), "sha256": SHA256}


def target(root: Path | None = None) -> Path:
    # Rehash at the inference boundary even if a filesystem timestamp was reused.
    if not status(root, force_verify=True)["valid"]:
        raise RuntimeError("Background segmenter is missing or damaged; download it first")
    return model_path(root)


def download(root: Path | None = None, *, on_log) -> bool:
    if status(root, force_verify=True)["valid"]:
        on_log.info("Background segmenter already verified")
        return True
    path = model_path(root)
    path.parent.mkdir(parents=True, exist_ok=True)
    # HF materializes the repository filename in target.parent before renaming.
    # Keep that directory private until the artifact passes both integrity checks.
    with tempfile.TemporaryDirectory(prefix=".download-", dir=path.parent) as staging_dir:
        staging = Path(staging_dir) / FILENAME
        if not sources.download_flat(REPO, FILENAME, staging, revision=REVISION, on_log=on_log):
            return False
        if staging.stat().st_size != SIZE or digest(staging) != SHA256:
            on_log.error("Background segmenter failed size/SHA-256 validation")
            return False
        os.replace(staging, path)
        return status(root, force_verify=True)["valid"]
