"""Reviewed applications, provenance-aware replacement, and guarded undo."""
from __future__ import annotations

import io
import base64
import hashlib
import json
from pathlib import Path
import time
import uuid

import numpy as np
from PIL import Image

from studio.domain.errors import ConflictError, NotFoundError, ValidationError
from . import head_mask as hm, masks, mask_transaction as tx


def _json(value: dict) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def _png(array: np.ndarray) -> bytes:
    stream = io.BytesIO()
    Image.fromarray(array).save(stream, "PNG")
    return stream.getvalue()


def _state(job_id: int) -> dict:
    try:
        state = json.loads(hm.apply_state_path(job_id).read_text(encoding="utf-8"))
        if state.get("undone") or not state.get("records"):
            raise ValueError("no active application")
        identity = str(state.get("apply_id", ""))
        expected = hm.apply_state_path(job_id).parent / "undo" / identity
        if (state.get("job_id") != job_id or not identity.isalnum()
                or Path(state.get("backup_dir", "")).resolve() != expected.resolve()):
            raise ValueError("invalid snapshot location or identity")
        return state
    except (OSError, ValueError, TypeError, AttributeError) as exc:
        raise ConflictError("No usable automatic-mask application snapshot",
                            code="preprocess.head_mask_undo_missing") from exc


def _snapshot_path(state: dict, relative: str) -> Path:
    root = Path(state['backup_dir']).resolve()
    candidate = (root / relative).resolve()
    if not candidate.is_relative_to(root) or candidate == root:
        raise ConflictError('Invalid snapshot file location', code='preprocess.head_mask_snapshot_invalid')
    return candidate


def _selected(job_id: int, train_dir: Path, selections: dict[str, list[str]]) -> list[tuple[dict, list[dict]]]:
    result = hm.load_result(job_id)
    by_name = {item["name"]: item for item in result["images"]}
    if set(selections) - set(by_name):
        raise ValidationError("Unknown proposal images", code="preprocess.head_mask_selection_invalid", http_status=400)
    stale = [{"name": item["name"], "reason": reason} for item in result["images"]
             if selections.get(item["name"]) and (reason := hm.proposal_stale_reason(item, train_dir))]
    if stale:
        raise ConflictError("Source images changed; detect again", code="preprocess.head_mask_proposals_stale",
                            details={"images": stale})
    selected = []
    for name, ids in selections.items():
        # Names originate from persisted proposals, but still constrain disk access.
        from .core import _validate_rel_name
        _validate_rel_name(name)
        item = by_name[name]
        regions = {r["id"]: r for r in item["regions"]}
        if set(ids) - set(regions):
            raise ValidationError("Unknown proposal region", code="preprocess.head_mask_selection_invalid", http_status=400)
        if ids:
            selected.append((item, [regions[i] for i in dict.fromkeys(ids)]))
    return selected


def _baseline(old: dict, train_dir: Path, item: dict) -> np.ndarray:
    name = item["name"]
    record = next((r for r in old["records"] if r["name"] == name), None)
    if not record or name in old.get("replaced", {}):
        raise ConflictError("Image has no replaceable source application", code="preprocess.head_mask_replace_unavailable")
    target = masks.mask_path_for(train_dir, name)
    if tx.sha(target) != record["applied_sha256"]:
        raise ConflictError("Mask was edited after automatic application", code="preprocess.head_mask_undo_modified",
                            details={"images": [name]})
    old_result = hm.load_result(old["job_id"])
    prior = next((i for i in old_result["images"] if i["name"] == name), None)
    if not prior or hm.proposal_stale_reason(prior, train_dir):
        raise ConflictError("Old source proposal is stale", code="preprocess.head_mask_proposals_stale")
    size = tuple(item["size"])
    backup = _snapshot_path(old, record.get("baseline_rel", record["backup_rel"]))
    if record.get("baseline_rel") or record["before_exists"]:
        expected = record.get("baseline_sha256", record.get("before_sha256"))
        if not backup.is_file() or (expected and tx.sha(backup) != expected):
            raise ConflictError("Previous mask snapshot is missing or damaged", code="preprocess.head_mask_snapshot_invalid")
        baseline = hm._load_existing_mask(backup, size)
    else:
        baseline = np.full((size[1], size[0]), 255, np.uint8)
    # Legacy v1 snapshots have no before hash. Validate their format and replay
    # against the recorded application instead of silently trusting any PNG.
    ids = set(record["selected_region_ids"])
    regions = [r for r in prior["regions"] if r["id"] in ids]
    if len(regions) != len(ids) or not np.array_equal(
        np.minimum(baseline, hm.render_auto_mask(size, regions, job_id=old["job_id"])),
        hm._load_existing_mask(target, size),
    ):
        raise ConflictError("Previous snapshot cannot reproduce the applied mask",
                            code="preprocess.head_mask_snapshot_invalid")
    return baseline


def replacement_info(job_id: int, train_dir: Path) -> dict | None:
    with tx.lock(train_dir):
        try:
            old = _state(job_id)
        except ConflictError:
            return None
        try:
            result = hm.load_result(job_id)
        except (ConflictError, NotFoundError) as exc:
            return {"job_id": job_id, "apply_id": old["apply_id"], "images": [
                {"name": r["name"], "eligible": False, "reason": str(exc)} for r in old["records"]]}
        images = []
        for item in result["images"]:
            if not any(r["name"] == item["name"] for r in old["records"]):
                continue
            reason = None
            try:
                _baseline(old, train_dir, item)
            except (ConflictError, OSError, ValueError) as exc:
                reason = str(exc)
            images.append({"name": item["name"], "eligible": reason is None, "reason": reason})
        return {"job_id": job_id, "apply_id": old["apply_id"], "images": images}


def _replacement(replace_from: dict | None, current_job: int) -> dict | None:
    if not replace_from:
        return None
    if replace_from["job_id"] == current_job:
        raise ConflictError("Run a new detection before replacing an old application",
                            code="preprocess.head_mask_replace_unavailable")
    old = _state(replace_from["job_id"])
    if old["apply_id"] != replace_from["apply_id"]:
        raise ConflictError("Selected application changed; reload its snapshot",
                            code="preprocess.head_mask_replace_unavailable")
    return old


def preview(job_id: int, train_dir: Path, selections: dict, replace_from: dict) -> dict:
    with tx.lock(train_dir):
        selected = _selected(job_id, train_dir, selections)
        old = _replacement(replace_from, job_id)
        images = []
        for item, regions in selected:
            size = tuple(item["size"])
            current = hm._load_existing_mask(masks.mask_path_for(train_dir, item["name"]), size)
            after = np.minimum(_baseline(old, train_dir, item), hm.render_auto_mask(size, regions, job_id=job_id))
            images.append({"name": item["name"], "restored_pixels": int(np.count_nonzero(after > current)),
                           "ignored_pixels": int(np.count_nonzero(after < current)),
                           "before_url": "data:image/png;base64," + base64.b64encode(_png(current)).decode(),
                           "after_url": "data:image/png;base64," + base64.b64encode(_png(after)).decode()})
        return {"images": images, "replace_from": replace_from}


def apply(job_id: int, train_dir: Path, selections: dict, *, replace_from: dict | None = None) -> dict:
    with tx.lock(train_dir):
        selected = _selected(job_id, train_dir, selections)
        old = _replacement(replace_from, job_id)
        apply_id = uuid.uuid4().hex
        backup_dir = hm.apply_state_path(job_id).parent / "undo" / apply_id
        records, changes = [], {}
        for item, regions in selected:
            name, size = item["name"], tuple(item["size"])
            path = masks.mask_path_for(train_dir, name)
            current = hm._load_existing_mask(path, size)
            baseline = _baseline(old, train_dir, item) if old else current
            merged = np.minimum(baseline, hm.render_auto_mask(size, regions, job_id=job_id))
            if np.array_equal(current, merged) and path.is_file():
                continue
            rel = f"{len(records)}.before"
            before_sha = tx.sha(path)
            if before_sha:
                tx.durable_write(backup_dir / rel, path.read_bytes())
            data = _png(merged)
            record = {"name": name, "backup_rel": rel, "before_exists": before_sha is not None,
                      "before_sha256": before_sha, "selected_region_ids": [r["id"] for r in regions],
                      "applied_sha256": hashlib.sha256(data).hexdigest()}
            if old:
                record["baseline_rel"] = f"{len(records)}.baseline"
                tx.durable_write(backup_dir / record["baseline_rel"], _png(baseline))
                record["baseline_sha256"] = tx.sha(backup_dir / record["baseline_rel"])
            records.append(record)
            changes[path] = data
        if not records:
            return {"job_id": job_id, "applied": 0, "images": [], "undo_available": hm.undo_available(job_id)}
        state = {"schema_version": 2, "job_id": job_id, "apply_id": apply_id, "applied_at": time.time(),
                 "backup_dir": str(backup_dir), "records": records, "undone": False}
        if old:
            state["replaced_source"] = {"job_id": old["job_id"], "apply_id": old["apply_id"]}
            for record in records:
                old.setdefault("replaced", {})[record["name"]] = {"job_id": job_id, "apply_id": apply_id}
            changes[hm.apply_state_path(old["job_id"])] = _json(old)
        changes[hm.apply_state_path(job_id)] = _json(state)
        # Recheck all source snapshots immediately before the first disk mutation.
        _selected(job_id, train_dir, selections)
        tx.commit(train_dir, changes)
        return {"job_id": job_id, "apply_id": apply_id, "applied": len(records),
                "images": [r["name"] for r in records], "undo_available": True}


def undo(job_id: int, train_dir: Path) -> dict:
    with tx.lock(train_dir):
        if not hm.apply_state_path(job_id).is_file():
            raise NotFoundError("No automatic masking to undo", code="preprocess.head_mask_undo_missing")
        state = _state(job_id)
        changes = {}
        for record in state["records"]:
            name = record["name"]
            path = masks.mask_path_for(train_dir, name)
            if name in state.get("replaced", {}) or tx.sha(path) != record["applied_sha256"]:
                raise ConflictError("Masks changed after automatic application; undo refused",
                                    code="preprocess.head_mask_undo_modified", details={"images": [name]})
            backup = _snapshot_path(state, record["backup_rel"])
            if record["before_exists"]:
                if not backup.is_file() or ("before_sha256" in record and tx.sha(backup) != record["before_sha256"]):
                    raise ConflictError("Undo snapshot is damaged", code="preprocess.head_mask_snapshot_invalid")
                changes[path] = backup.read_bytes()
            else:
                changes[path] = None
        if source := state.get("replaced_source"):
            old = _state(source["job_id"])
            if old["apply_id"] != source["apply_id"]:
                raise ConflictError("Source application changed; undo refused", code="preprocess.head_mask_undo_modified")
            for record in state["records"]:
                if old.get("replaced", {}).get(record["name"]) != {"job_id": job_id, "apply_id": state["apply_id"]}:
                    raise ConflictError("Replacement history changed", code="preprocess.head_mask_undo_modified")
                del old["replaced"][record["name"]]
            changes[hm.apply_state_path(old["job_id"])] = _json(old)
        state.update(undone=True, undone_at=time.time())
        changes[hm.apply_state_path(job_id)] = _json(state)
        tx.commit(train_dir, changes)
        return {"job_id": job_id, "undone": len(state["records"]), "images": [r["name"] for r in state["records"]]}
