"""Queue task snapshot（PR-6 commit 6 从 server.py 抽出）。

2 routes：
    GET /api/queue/{task_id}/snapshot/config    ADR-0007 §11.7 task 启动 freeze 的 config
    POST /api/training/estimate-duration       只读历史训练耗时估算

历史：本文件曾有 /api/queue/export + /api/queue/import（预设池时代的队列 JSON
分享）。R-5 删除——现代任务 config 是 version 私有，导出恒空、导入恒跳过，
UI 按钮已先行下线（PR #359 反馈轮）；项目级分享由项目 bundle 导入导出覆盖。
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel, Field

from .... import db
from ....domain.errors import NotFoundError
from ....services import task_snapshot

router = APIRouter()


@router.get("/api/queue/{task_id}/snapshot/config")
def get_task_snapshot_config(task_id: int) -> dict[str, Any]:
    """ADR-0007 §11.7：返回 task 启动时冻结的 config。

    返回 ``{"yaml": str, "config": dict}``。task 不存在 / 无 snapshot → 404。
    UI [关联配置] tab 用此 + 触发 "套用此配置" 路由跳转到 ⑦ 训练 phase + prefill。
    """
    with db.connection_for() as conn:
        task = db.get_task(conn, task_id)
    if not task:
        raise NotFoundError("Task not found", code="task.not_found", details={"task_id": task_id})
    data = task_snapshot.read_snapshot_config(task_id)
    if data is None:
        raise NotFoundError(
            "No saved configuration for this task",
            code="task.snapshot_not_found", details={"task_id": task_id},
        )
    return data


class DurationEstimateRequest(BaseModel):
    config: dict[str, Any]
    total_steps: int = Field(gt=0, le=1_000_000_000)


@router.post("/api/training/estimate-duration")
def estimate_training_duration(request: DurationEstimateRequest) -> dict[str, Any]:
    """Read-only estimate. Never enqueue, run training, or change configuration."""
    from ....services.training_duration import estimate_duration
    with db.connection_for() as conn:
        tasks = db.list_tasks_page(conn, statuses=("done",), types=("train",), limit=100)
    return estimate_duration(request.config, request.total_steps, tasks)
