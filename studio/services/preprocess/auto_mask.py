"""Proposal-only multi-target masking. A failed target never hides its peers."""
from __future__ import annotations

from pathlib import Path
import time
from typing import Callable

from PIL import Image

from studio.services import models
from studio.services.models import background_segmenter, face_segmenter
from . import head_mask as hm
from .background_mask import BackgroundSegmenter
from .face_contour import FaceSegmenter, save_bitmap


class MultiTargetDetector:
    def __init__(self, params: dict) -> None:
        self.params = params
        self.targets = list(dict.fromkeys(params["mask_targets"]))
        self.sessions: dict = {}
        self.errors: dict[str, str] = {}
        self.models: dict = {}
        required = []
        if any(t in self.targets for t in ("head_box", "face_contour")):
            required.append("head_detector")
        if "face_contour" in self.targets:
            required.append("face_segmenter")
        if "background" in self.targets:
            required.append("background_segmenter")
        for key in required:
            try:
                if key == "head_detector":
                    identity, path, builtin = models.resolve_head_detector(params.get("model"))
                    if builtin and not models.head_detector_status()["valid"]:
                        raise RuntimeError("Head detector is missing or damaged")
                    session = hm.HeadDetector(path)
                    info = {"identity": identity, "path": str(path),
                            "sha256": face_segmenter.digest(path)}
                else:
                    module = face_segmenter if key == "face_segmenter" else background_segmenter
                    path = module.target()
                    session = FaceSegmenter(path) if key == "face_segmenter" else BackgroundSegmenter(path)
                    info = {"path": str(path), "revision": module.REVISION,
                            "sha256": module.status()["sha256"]}
                self.sessions[key] = session
                self.models[key] = {**info, "provider": session.provider,
                                    "input_size": [1024, 1024] if key == "background_segmenter" else [640, 640]}
            except Exception as exc:
                self.errors[key] = str(exc)[:300]

    def propose(self, job_id: int, name: str, path: Path,
                canceled: Callable[[], bool]) -> dict:
        snapshot = hm.source_snapshot(path)
        with Image.open(path) as image:
            size = image.size
        proposal = {"name": name, "size": list(size), "status": "done", "error": None,
                    "source_mtime_ns": snapshot["mtime_ns"], "source_file_size": snapshot["file_size"],
                    "regions": [], "target_statuses": {}, "review_status": "ready"}
        heads, head_error = [], self.errors.get("head_detector")
        if "head_detector" in self.sessions:
            try:
                _, heads = self.sessions["head_detector"].detect(
                    path, confidence=self.params["confidence"], iou_threshold=self.params["iou_threshold"],
                )
            except Exception as exc:
                head_error = str(exc)
        for target in self.targets:
            if canceled():
                raise InterruptedError("Automatic mask detection canceled")
            try:
                regions, reason, state = [], "ready", "done"
                if target in ("head_box", "face_contour") and head_error:
                    raise RuntimeError(head_error)
                if target == "head_box":
                    regions = hm.make_image_proposal(name, path, size, heads,
                        padding_ratio=self.params["padding_ratio"],
                        feather_ratio=self.params["feather_ratio"])["regions"]
                    for index, region in enumerate(regions):
                        weights = hm.render_auto_mask(size, [region])
                        r = region["mask_region"]
                        x, y = max(0, r["x1"] - r["feather_x"]), max(0, r["y1"] - r["feather_y"])
                        right, bottom = min(size[0], r["x2"] + r["feather_x"]), min(size[1], r["y2"] + r["feather_y"])
                        bitmap = save_bitmap(job_id, name, index, (x, y), weights[y:bottom, x:right], target=target)
                        region.update(id=bitmap["id"], kind="bitmap", bitmap=bitmap)
                    if not regions:
                        reason, state = "no_head", "empty"
                elif target == "face_contour":
                    if "face_segmenter" in self.errors:
                        raise RuntimeError(self.errors["face_segmenter"])
                    face = self.sessions["face_segmenter"].propose(job_id, name, path, heads,
                        confidence=self.params.get("face_confidence", .25),
                        iou_threshold=self.params["iou_threshold"],
                        threshold=self.params.get("mask_threshold", .5),
                        feather_px=self.params.get("feather_px", 0), canceled=canceled)
                    regions = face["regions"]
                    if face["issues"]:
                        reason, state = "face_incomplete", "partial" if regions else "failed"
                    elif not regions:
                        reason, state = "no_face", "empty"
                elif target == "background":
                    if "background_segmenter" in self.errors:
                        raise RuntimeError(self.errors["background_segmenter"])
                    regions, reason = self.sessions["background_segmenter"].propose(job_id, name, path,
                        threshold=self.params.get("background_threshold", .5),
                        protect_px=self.params.get("background_protect_px", 0),
                        feather_px=self.params.get("background_feather_px", 0))
                    state = "done" if regions else "empty"
                else:
                    raise ValueError(f"Unknown mask target: {target}")
                proposal["regions"].extend({**r, "target": target} for r in regions)
                proposal["target_statuses"][target] = {"status": state, "reason": reason, "count": len(regions)}
            except InterruptedError:
                raise
            except Exception as exc:
                proposal["target_statuses"][target] = {"status": "failed", "reason": "detection_failed",
                                                        "count": 0, "error": str(exc)[:300]}
        if snapshot != hm.source_snapshot(path):
            raise RuntimeError("Source image changed during automatic mask detection")
        states = list(proposal["target_statuses"].values())
        if any(s["status"] != "done" and s["reason"] != "no_background" for s in states):
            proposal["review_status"] = "needs_review"
        if all(s["status"] == "failed" for s in states):
            proposal["status"] = "failed"
            proposal["error"] = {"code": "preprocess.auto_mask_failed", "message": "All selected targets failed"}
        return proposal


def run_job(job_id: int, train_dir: Path, sources: list[str], params: dict,
            log, emit_event, canceled: Callable[[], bool]) -> int:
    detector = MultiTargetDetector(params)
    proposals = []
    total = len(sources)
    for idx, name in enumerate(sources, 1):
        if canceled():
            return 130
        try:
            item = detector.propose(job_id, name, train_dir / name, canceled)
        except InterruptedError:
            return 130
        except Exception as exc:
            log.warning("Automatic mask failed for %s: %s", name, exc)
            item = hm.unsuccessful_image(name, skipped=not (train_dir / name).is_file())
            item.update(review_status="needs_review", target_statuses={
                t: {"status": item["status"], "count": 0, "reason": "detection_failed", "error": str(exc)[:300]}
                for t in detector.targets
            })
        proposals.append(item)
        emit_event("head_mask_progress", idx=idx, total=total, name=name,
                   status="done" if item["status"] == "done" else "fail",
                   detections=len(item["regions"]), target_statuses=item["target_statuses"])
    if canceled():
        return 130
    # Record the provider after inference, including any runtime CPU fallback.
    for key, session in detector.sessions.items():
        detector.models[key]["provider"] = session.provider
    result = hm.with_outcomes({"schema_version": 3, "job_id": job_id, "models": detector.models,
        "parameters": {key: value for key, value in params.items()
                       if key not in {"names", "stage", "scope", "model", "mask_mode"}},
        "created_at": time.time(), "images": proposals})
    if any(i["review_status"] == "needs_review" for i in proposals):
        result["status"] = "partial"
    hm.write_result(job_id, result)
    log.info("Automatic mask proposals ready: %d images, targets=%s", total, detector.targets)
    return 0
