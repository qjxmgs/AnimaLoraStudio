"""v20 → v21: projects.custom_tags — 项目级常驻标签列表。"""
from __future__ import annotations

import sqlite3

from ._v2_projects import _add_column_if_missing


def migrate(conn: sqlite3.Connection) -> None:
    _add_column_if_missing(
        conn,
        "projects",
        "custom_tags",
        "custom_tags TEXT NOT NULL DEFAULT '[]'",
    )
