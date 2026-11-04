"""Verified assets for the 1008px FP32 PixAI Tagger v1.0 export."""
import hashlib
import os
import tempfile
from functools import lru_cache
from pathlib import Path

from . import sources
from .face_segmenter import digest
from .paths import models_root

REPO = "HentaiSL/pixai-tagger-v1.0-onnx-1008-672-336-ft"
REVISION = "29c4dc4ade24556f69694ecbd9abdd9046363442"
GRAPH = "tagger_1008_fp32.onnx"
FILES = {
    GRAPH: (397712, "fe5fed9c1c61481a730151013f540462ef7239242609535165976d67b38890a4"),
    GRAPH + ".data": (1955123200, "874330c32048ce8884a7f72eb86f6e72db22b2855702b75dc70ec86ad0182438"),
    "config.json": (693918, "f8a19b38661c37dc5fd519f2137be70f6f897972021b4ebc17b7d35a0e27b9dd"),
}
DML_SHA256 = "72ed26456fe0b51df18f3314dff97ab7f9053fdfa0ea369825fc4a593765983f"


def model_dir(root: Path | None = None) -> Path:
    return (root or models_root()) / "pixai-tagger-v1.0"


@lru_cache(maxsize=32)
def _digest(path: Path, inode: int, mtime: int, ctime: int) -> str:
    return digest(path)


def _valid(path: Path) -> bool:
    size, expected = FILES[path.name]
    try:
        stat = path.stat()
        return stat.st_size == size and _digest(path, stat.st_ino, stat.st_mtime_ns, stat.st_ctime_ns) == expected
    except OSError:
        return False


def status(root: Path | None = None) -> dict:
    folder = model_dir(root)
    missing = [name for name in FILES if not _valid(folder / name)]
    return {"valid": not missing, "missing": missing, "target_dir": str(folder)}


def download(root: Path | None = None, *, on_log) -> bool:
    folder = model_dir(root)
    folder.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=folder) as staging:
        for name in FILES:
            target = folder / name
            if _valid(target):
                continue
            candidate = Path(staging) / name
            if not sources.download_flat(REPO, name, candidate, revision=REVISION, on_log=on_log):
                return False
            if not _valid(candidate):
                on_log.error("PixAI: size or SHA-256 mismatch in %s", name)
                return False
            os.replace(candidate, target)
    return True


def directml_graph(original: Path) -> Path:
    graph = original.read_bytes()
    if hashlib.sha256(graph).hexdigest() != FILES[GRAPH][1]:
        raise ValueError("Unexpected PixAI graph")
    dest = original.with_name("model.directml-reshape-v1.onnx")
    if dest.is_file() and digest(dest) == DML_SHA256:
        return dest
    # In this exact export all 313 Reshape shape inputs have no zero dimensions.
    # Setting allowzero=0 preserves their semantics and works around ORT 1.24 DML.
    before = bytes.fromhex("0a09616c6c6f777a65726f1801a00102")
    after = bytes.fromhex("0a09616c6c6f777a65726f1800a00102")
    patched = graph.replace(before, after)
    if graph.count(before) != 313 or hashlib.sha256(patched).hexdigest() != DML_SHA256:
        raise ValueError("PixAI DirectML graph verification failed")
    with tempfile.TemporaryDirectory(dir=original.parent) as staging:
        temp = Path(staging) / dest.name
        temp.write_bytes(patched)
        os.replace(temp, dest)
    return dest
