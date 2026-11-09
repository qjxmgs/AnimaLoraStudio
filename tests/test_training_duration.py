import json
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from studio.services import training_duration as duration
from studio.domain.training import TrainingConfig


@pytest.fixture
def history(tmp_path, monkeypatch):
    config = TrainingConfig().model_dump(mode="json")
    monkeypatch.setattr(duration, "read_snapshot_config", lambda task_id: {"config": config})
    state = tmp_path / "state.json"
    state.write_text(json.dumps({"step": 100, "total_steps": 100, "start_time": 105}), encoding="utf8")
    task = {"id": 1, "task_type": "train", "status": "done", "started_at": 100,
            "finished_at": 400, "monitor_state_path": str(state)}
    return config, state, task


def test_matches_epochs_and_scales_total_wall_time(history):
    config, _, task = history
    result = duration.estimate_duration({**config, "epochs": 2, "seed": 99, "output_name": "new"}, 200, [task])
    assert result == {"seconds": 600, "task_ids": [1]}


@pytest.mark.parametrize("change", [{"batch_size": 4}, {"resolution": [512]}, {"grad_accum": 3},
    {"data_dir": "other"}, {"transformer_path": "other"}, {"blocks_to_swap": 2}, {"resume_state": "checkpoint.pt"}])
def test_rejects_incompatible_settings(history, change):
    config, _, task = history
    assert duration.estimate_duration({**config, **change}, 100, [task])["seconds"] is None


@pytest.mark.parametrize("change", [{"status": "failed"}, {"status": "canceled"}, {"task_type": "generate"},
    {"paused_step": 50}, {"finished_at": None}, {"finished_at": 90}, {"started_at": 200}])
def test_rejects_incomplete_or_resumed_runs(history, change):
    config, _, task = history
    assert duration.estimate_duration(config, 100, [{**task, **change}])["seconds"] is None


def test_missing_corrupt_incomplete_state_and_large_extrapolation(history):
    config, state, task = history
    assert duration.estimate_duration(config, 100, []) == {"seconds": None, "task_ids": []}
    assert duration.estimate_duration(config, 1000, [task])["seconds"] is None
    state.write_text('{broken', encoding="utf8")
    assert duration.estimate_duration(config, 100, [task])["seconds"] is None
    state.write_text(json.dumps({"start_time": 105, "step": 20, "total_steps": 100}), encoding="utf8")
    assert duration.estimate_duration(config, 100, [task])["seconds"] is None
    state.unlink()
    assert duration.estimate_duration(config, 100, [task])["seconds"] is None


def test_median_uses_at_most_five_recent_matches(history):
    config, _, task = history
    tasks = [{**task, "id": i, "finished_at": 100 + seconds} for i, seconds in enumerate([300, 400, 2000, 350, 320, 9999])]
    assert duration.estimate_duration(config, 100, tasks) == {"seconds": 350, "task_ids": [0, 1, 2, 3, 4]}


def test_read_only_endpoint_validation(history, monkeypatch):
    from contextlib import nullcontext
    from studio.api.routers.queue import io
    config, _, task = history
    monkeypatch.setattr(io.db, "connection_for", lambda: nullcontext(None))
    monkeypatch.setattr(io.db, "list_tasks_page", lambda *a, **kw: [task])
    app = FastAPI()
    app.include_router(io.router)
    client = TestClient(app)
    assert client.post('/api/training/estimate-duration', json={"config": config, "total_steps": 100}).json()["seconds"] == 300
    assert client.post('/api/training/estimate-duration', json={"config": config, "total_steps": 0}).status_code == 422
