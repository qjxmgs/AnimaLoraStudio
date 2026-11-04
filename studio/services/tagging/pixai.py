"""PixAI v1.0, pinned 1008px FP32 export with raw logits."""
import json
import logging
from importlib.util import find_spec
from pathlib import Path

import numpy as np
from PIL import Image, ImageOps

from ... import secrets
from ..models import pixai as assets
from .onnx_base import OnnxTaggerBase

logger = logging.getLogger(__name__)
SPLITS = [["general", 15043], ["character", 8308], ["copyright", 2460],
          ["style", 4917], ["meta", 145], ["rating", 4]]


class PixAITagger(OnnxTaggerBase):
    name = "pixai"

    def __init__(self, overrides: dict | None = None):
        super().__init__()
        updates = {k: v for k, v in (overrides or {}).items() if v is not None}
        self.cfg = secrets.PixAIConfig(**(secrets.load().pixai.model_dump() | updates))
        self.blocked = {tag.replace("_", " ").strip().casefold() for tag in self.cfg.blacklist_tags}

    def _get_batch_size_cfg(self):
        return 1

    def is_available(self):
        if find_spec("onnxruntime") is None:
            return False, "请安装 onnxruntime 或 onnxruntime-directml / onnxruntime-gpu"
        missing = assets.status()["missing"]
        if missing:
            return False, f"需下载模型 PixAI Tagger v1.0: {', '.join(missing)}"
        return True, "PixAI Tagger v1.0"

    def prepare(self):
        if self._session is not None:
            return

        ok, message = self.is_available()
        if not ok:
            raise RuntimeError(message)
        folder = assets.model_dir()
        config = json.loads((folder / "config.json").read_text(encoding="utf-8"))
        labels = config["tags"]
        if (config["tags_split"] != SPLITS or config["num_classes"] != 30877
                or len(labels) != 30877 or not all(isinstance(t, str) and t for t in labels)):
            raise ValueError("Invalid PixAI vocabulary or category offsets")
        self.labels = labels
        self._create_session(folder / assets.GRAPH)
        logger.info("PixAI ONNX providers: %s", self._session.get_providers())

    def _graph_for_provider(self, model_path: Path, provider: str | None) -> Path:
        if provider == "DmlExecutionProvider":
            return assets.directml_graph(model_path)
        return model_path

    def _preprocess(self, img):
        # Resize the float RGB tensor with antialiasing, before black padding.
        # PIL's F mode avoids the intermediate 8-bit rounding of RGB.resize().
        img = ImageOps.exif_transpose(img).convert("RGBA")
        rgb = Image.new("RGB", img.size, "white")
        rgb.paste(img, mask=img.getchannel("A"))
        scale = 1008 / max(img.size)
        w, h = (max(1, int(d * scale)) for d in img.size)
        out = np.full((3, 1008, 1008), -1, dtype=np.float32)
        x, y = (1008 - w) // 2, (1008 - h) // 2
        for c, channel in enumerate(rgb.split()):
            plane = channel.convert("F").resize((w, h), Image.Resampling.BILINEAR)
            out[c, y:y+h, x:x+w] = np.asarray(plane) / 127.5 - 1
        return out

    def _postprocess_one(self, logits):
        if logits.shape != (30877,) or not np.isfinite(logits).all():
            raise ValueError("Invalid PixAI output logits")
        scores = 1 / (1 + np.exp(-np.clip(logits, -80, 80)))
        selected = []
        offset = 0
        for category, count in SPLITS:
            if getattr(self.cfg, f"add_{category}_tag"):
                threshold = getattr(self.cfg, f"threshold_{category}")
                for index in np.flatnonzero(scores[offset:offset+count] >= threshold) + offset:
                    name = self.labels[index].replace("_", " ")
                    if name.strip().casefold() not in self.blocked:
                        selected.append((name, float(scores[index])))
            offset += count
        selected.sort(key=lambda item: -item[1])
        return [name for name, _ in selected], dict(selected)
