"""Conservative pre-run estimates from completed local task snapshots."""
import json
import math
from pathlib import Path
from statistics import median

import yaml

from ..domain.training import TrainingConfig
from ..domain.config_rules import eval_show_when
from ..paths import task_monitor_state_path
from .task_snapshot import read_snapshot_config

# Data/model paths deliberately remain in the match: equal resolution alone does
# not imply equal bucket sizes, token counts or model execution cost.
IGNORED = {"epochs", "max_steps", "output_dir", "output_name", "seed", "sample_seed", "eval_validation_split_seed"}


def fingerprint(config):
    values = TrainingConfig.model_validate(config).model_dump(mode="json")
    if values.get("resume_state") or values.get("resume_lora"):
        return None
    return {key: value for key, value in values.items()
            if key not in IGNORED and eval_show_when(
                (TrainingConfig.model_fields[key].json_schema_extra or {}).get("show_when"), values)}


def estimate_duration(config, total_steps, tasks):
    empty = {"seconds": None, "task_ids": []}
    try:
        target = fingerprint(config)
    except (ValueError, TypeError):
        return empty
    if target is None or not math.isfinite(total_steps) or total_steps <= 0:
        return empty
    samples = []
    for task in tasks:
        if task.get("status") != "done" or task.get("task_type", "train") != "train":
            continue
        if task.get("paused_at") or task.get("paused_step"):
            continue
        try:
            elapsed = float(task["finished_at"]) - float(task["started_at"])
            if not math.isfinite(elapsed) or elapsed <= 0:
                continue
            snapshot = read_snapshot_config(task["id"])
            if not snapshot or fingerprint(snapshot["config"]) != target:
                continue
            path = task.get("monitor_state_path") or task_monitor_state_path(task["id"])
            state = json.loads(Path(path).read_text(encoding="utf-8"))
            monitor_start = float(state["start_time"])
            # Restored monitor state keeps the original start time whereas a
            # resumed task gets a new started_at. Do not divide partial time by full steps.
            if not math.isfinite(monitor_start) or not float(task["started_at"]) - 1 <= monitor_start < float(task["finished_at"]):
                continue
            if state.get("config", {}).get("resume_state"):
                continue
            steps = float(state["total_steps"])
            completed = float(state["step"])
            if not math.isfinite(steps) or not math.isfinite(completed) or steps < 20 or completed < steps:
                continue
            # Avoid extrapolating fixed loading/cache costs over vastly different runs.
            if not 0.5 <= total_steps / steps <= 2:
                continue
            samples.append((task["id"], elapsed / steps * total_steps))
        except (OSError, ValueError, TypeError, KeyError, AttributeError, yaml.YAMLError):
            continue
        if len(samples) == 5:
            break
    if not samples:
        return empty
    return {"seconds": max(1, round(median(seconds for _, seconds in samples))),
            "task_ids": [task_id for task_id, _ in samples]}
