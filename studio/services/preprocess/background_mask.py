"""Anime foreground segmentation converted to background loss masks."""
from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image
from scipy.ndimage import distance_transform_edt, zoom

from studio.services.models import background_segmenter
from .face_contour import save_bitmap
from .head_mask import HeadDetector

INPUT_SIZE = 1024


def prepare_input(image: Image.Image) -> tuple[np.ndarray, tuple[int, int, int, int]]:
    """Author's RGB [0,1], aspect-preserving resize and centered zero padding."""
    width, height = image.size
    w, h = ((max(1, int(INPUT_SIZE * width / height)), INPUT_SIZE)
            if height > width else (INPUT_SIZE, max(1, int(INPUT_SIZE * height / width))))
    left, top = (INPUT_SIZE - w) // 2, (INPUT_SIZE - h) // 2
    # Resize floating channels without antialiasing, matching cv2.INTER_LINEAR.
    pixels = np.asarray(image.convert("RGB"), dtype=np.float32) / 255
    resized = zoom(pixels, (h / height, w / width, 1), order=1,
                   mode="nearest", prefilter=False, grid_mode=True)
    tensor = np.zeros((INPUT_SIZE, INPUT_SIZE, 3), dtype=np.float32)
    tensor[top:top+h, left:left+w] = resized
    return np.ascontiguousarray(tensor.transpose(2, 0, 1)[None]), (left, top, w, h)


def restore_probability(output: np.ndarray, size: tuple[int, int],
                        content: tuple[int, int, int, int]) -> np.ndarray:
    probability = np.asarray(output, dtype=np.float32)
    if probability.shape != (1, 1, INPUT_SIZE, INPUT_SIZE) or not np.isfinite(probability).all():
        raise RuntimeError("Invalid background segmentation output")
    left, top, w, h = content
    cropped = probability[0, 0, top:top+h, left:left+w]
    return np.clip(zoom(cropped, (size[1] / h, size[0] / w), order=1,
                        mode="nearest", prefilter=False, grid_mode=True), 0, 1)


def background_weights(probability: np.ndarray, *, threshold: float = .5,
                       protect_px: int = 0, feather_px: int = 0) -> tuple[np.ndarray | None, str]:
    foreground = probability >= threshold
    if not foreground.any():
        return None, "no_foreground"
    if protect_px:
        foreground = distance_transform_edt(~foreground) <= protect_px
    if foreground.all():
        return None, "no_background"
    weights = np.where(foreground, 255, 0).astype(np.uint8)
    if feather_px:
        distance = distance_transform_edt(~foreground)
        # Only reduce masking on the background side; foreground stays white.
        weights = np.rint(np.clip(1 - distance / (feather_px + 1), 0, 1) * 255).astype(np.uint8)
    return weights, "ready"


class BackgroundSegmenter(HeadDetector):
    def __init__(self, model_path: Path | None = None) -> None:
        super().__init__(model_path or background_segmenter.target(), input_size=INPUT_SIZE)

    def propose(self, job_id: int, name: str, path: Path, *, threshold: float = .5,
                protect_px: int = 0, feather_px: int = 0) -> tuple[list[dict], str]:
        with Image.open(path) as raw:
            image = raw.convert("RGB")
        tensor, content = prepare_input(image)
        probability = restore_probability(self.run_outputs(tensor)[0], image.size, content)
        weights, reason = background_weights(probability, threshold=threshold,
                                             protect_px=protect_px, feather_px=feather_px)
        if weights is None:
            return [], reason
        bitmap = save_bitmap(job_id, name, 0, (0, 0), weights, target="background")
        width, height = image.size
        return [{"id": bitmap["id"], "kind": "bitmap", "target": "background",
                 "bitmap": bitmap, "coverage": float(np.mean(1 - weights.astype(np.float32) / 255)),
                 "box": [0, 0, width, height],
                 "mask_region": {"x1": 0, "y1": 0, "x2": width, "y2": height,
                                 "feather_x": 0, "feather_y": 0}}], reason
