"""Anime face instance masks; head boxes are input crops, never output masks."""
from __future__ import annotations

import hashlib
from pathlib import Path
import re
from typing import Any, Callable

import numpy as np
from PIL import Image

from studio.domain.errors import ConflictError, NotFoundError
from studio.infrastructure.paths import task_dir
from studio.services.models import face_segmenter
from .head_mask import HeadDetector, _letterbox, expand_detection, nms, source_snapshot

DEFAULT_FACE_CONFIDENCE = 0.25
DEFAULT_MASK_THRESHOLD = 0.5


def decode_masks(outputs: list[np.ndarray], crop_size: tuple[int, int], *,
                 confidence: float, iou_threshold: float, threshold: float) -> list[dict]:
    """Decode raw xywh/class/coefficients plus prototypes from the pinned export.

    Reconstruct logits, undo letterbox in floating point, then threshold at the
    source resolution. Do not convex-hull, fill holes, or replace with a box.
    """
    if len(outputs) != 2:
        raise RuntimeError("Face model must return predictions and prototypes")
    prediction, proto = (np.asarray(v, dtype=np.float32) for v in outputs)
    if proto.ndim != 4 or proto.shape[0] != 1 or prediction.ndim != 3:
        raise RuntimeError("Invalid face segmentation output dimensions")
    proto = proto[0]
    channels, ph, pw = proto.shape
    if prediction.shape[0] != 1 or prediction.shape[1] != 5 + channels:
        raise RuntimeError("Expected one-class YOLO instance segmentation output")
    rows = prediction[0].T
    rows = rows[np.isfinite(rows).all(axis=1) & (rows[:, 4] >= confidence)]
    if not len(rows):
        return []
    boxes = np.concatenate((rows[:, :2] - rows[:, 2:4] / 2,
                            rows[:, :2] + rows[:, 2:4] / 2), axis=1)
    keep = nms(boxes, rows[:, 4], iou_threshold)
    width, height = crop_size
    scale = min(640 / width, 640 / height)
    nw, nh = max(1, round(width * scale)), max(1, round(height * scale))
    left, top = (640 - nw) // 2, (640 - nh) // 2
    results = []
    for idx in keep:
        logits = (rows[idx, 5:] @ proto.reshape(channels, -1)).reshape(ph, pw)
        if not np.isfinite(logits).all():
            raise RuntimeError("Non-finite face mask logits")
        # Bilinear float interpolation matches the export's native-mask path.
        restored = Image.fromarray(logits).resize((640, 640), Image.Resampling.BILINEAR)
        restored = restored.crop((left, top, left + nw, top + nh)).resize(
            (width, height), Image.Resampling.BILINEAR,
        )
        logit_threshold = np.log(threshold / (1 - threshold))
        foreground = np.asarray(restored) >= logit_threshold
        box = boxes[idx].copy()
        box[[0, 2]] = np.clip((box[[0, 2]] - left) * width / nw, 0, width)
        box[[1, 3]] = np.clip((box[[1, 3]] - top) * height / nh, 0, height)
        yy, xx = np.ogrid[:height, :width]
        foreground &= (xx >= box[0]) & (xx < box[2]) & (yy >= box[1]) & (yy < box[3])
        if np.any(foreground):
            results.append({"score": float(rows[idx, 4]), "box": box.tolist(), "foreground": foreground})
    return results


def loss_weights(foreground: np.ndarray, feather_px: int = 0) -> np.ndarray:
    result = np.where(foreground, 0, 255).astype(np.uint8)
    if feather_px:
        from scipy.ndimage import distance_transform_edt
        # Pad with background so image/crop edges are treated as boundaries too.
        distance = distance_transform_edt(np.pad(foreground, 1))[1:-1, 1:-1]
        inward = np.clip(1 - distance / (feather_px + 1), 0, 1)
        result[foreground] = np.rint(inward[foreground] * 255).astype(np.uint8)
    return result


def bitmap_path(job_id: int, mask_id: str) -> Path:
    if not re.fullmatch(r"[0-9a-f]{32}", mask_id):
        raise NotFoundError("Unknown face mask", code="preprocess.face_mask_missing")
    return task_dir(job_id) / "head-mask" / "masks" / f"{mask_id}.png"


def save_bitmap(job_id: int, name: str, index: int, origin: tuple[int, int],
                weights: np.ndarray) -> dict:
    mask_id = hashlib.sha256(f"{name}:{index}".encode()).hexdigest()[:32]
    path = bitmap_path(job_id, mask_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(weights).save(path, "PNG")
    return {"id": mask_id, "origin": list(origin), "size": [weights.shape[1], weights.shape[0]],
            "sha256": face_segmenter.digest(path)}


def load_bitmap(job_id: int, region: dict) -> np.ndarray:
    info = region["bitmap"]
    path = bitmap_path(job_id, info["id"])
    try:
        if face_segmenter.digest(path) != info["sha256"]:
            raise ValueError("checksum mismatch")
        with Image.open(path) as image:
            image.load()
            if image.mode != "L" or list(image.size) != info["size"]:
                raise ValueError("size or mode mismatch")
            return np.array(image)
    except (OSError, ValueError) as exc:
        raise ConflictError("Face mask proposal is missing or damaged; detect again",
                            code="preprocess.face_mask_invalid") from exc


class FaceSegmenter(HeadDetector):
    def __init__(self, model_path: Path | None = None) -> None:
        super().__init__(model_path or face_segmenter.target())

    def propose(self, job_id: int, name: str, image_path: Path, heads: list[dict], *,
                confidence: float = DEFAULT_FACE_CONFIDENCE, iou_threshold: float = 0.7,
                threshold: float = DEFAULT_MASK_THRESHOLD, feather_px: int = 0,
                canceled: Callable[[], bool] = lambda: False) -> dict[str, Any]:
        snapshot = source_snapshot(image_path)
        with Image.open(image_path) as raw:
            image = raw.convert("RGB")
        candidates = []
        failures = []
        for index, head in enumerate(heads):
            if canceled():
                raise InterruptedError("Face segmentation canceled")
            roi = expand_detection(head, image.size, padding_ratio=0.10, feather_ratio=0)["mask_region"]
            origin = (roi["x1"], roi["y1"])
            crop = image.crop((*origin, roi["x2"], roi["y2"]))
            try:
                tensor, _, _, _ = _letterbox(crop)
                faces = decode_masks(self.run_outputs(tensor), crop.size, confidence=confidence,
                                     iou_threshold=iou_threshold, threshold=threshold)
                if not faces:
                    failures.append({"head_index": index, "reason": "no_face"})
                for face in faces:
                    box = np.array(face["box"]) + np.array([*origin, *origin])
                    candidates.append({**face, "box": box.tolist(), "origin": origin})
            except Exception as exc:
                failures.append({"head_index": index, "reason": "segmentation_failed", "error": str(exc)[:200]})
        keep = nms(np.array([c["box"] for c in candidates]),
                   np.array([c["score"] for c in candidates]), iou_threshold)
        regions = []
        for index in keep:
            face = candidates[index]
            weights = loss_weights(face["foreground"], feather_px)
            bitmap = save_bitmap(job_id, name, index, face["origin"], weights)
            x, y = bitmap["origin"]
            w, h = bitmap["size"]
            regions.append({"id": bitmap["id"], "kind": "bitmap", "score": face["score"],
                            "box": face["box"], "bitmap": bitmap,
                            "mask_region": {"x1": x, "y1": y, "x2": x+w, "y2": y+h,
                                            "feather_x": 0, "feather_y": 0}})
        if snapshot != source_snapshot(image_path):
            raise RuntimeError("Source image changed during face segmentation")
        return {"name": name, "size": list(image.size), "source_mtime_ns": snapshot["mtime_ns"],
                "source_file_size": snapshot["file_size"], "regions": regions, "issues": failures,
                "review_status": "needs_review" if failures else ("ready" if regions else "no_face")}
