from __future__ import annotations

import json
import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

from .config import PATHS

_DB_LOCK = threading.Lock()


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()


def db_path() -> Path:
    return PATHS.data / "studio.db"


@contextmanager
def connect() -> Iterator[sqlite3.Connection]:
    conn = sqlite3.connect(db_path(), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


SCHEMA = """
CREATE TABLE IF NOT EXISTS profiles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    base_config TEXT DEFAULT '',
    created_at TEXT,
    updated_at TEXT,
    tags TEXT DEFAULT '[]',
    notes TEXT DEFAULT '',
    meta TEXT DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL,
    status TEXT NOT NULL,
    stage TEXT DEFAULT '',
    progress REAL DEFAULT 0,
    created_at TEXT,
    started_at TEXT,
    finished_at TEXT,
    build_id TEXT DEFAULT '',
    config_path TEXT DEFAULT '',
    db_path TEXT DEFAULT '',
    log_path TEXT DEFAULT '',
    error TEXT DEFAULT '',
    meta TEXT DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS query_sets (
    id TEXT PRIMARY KEY,
    profile_id TEXT DEFAULT '',
    name TEXT NOT NULL,
    query_ids TEXT DEFAULT '[]',
    region_filter TEXT DEFAULT '{}',
    created_at TEXT
);
CREATE TABLE IF NOT EXISTS results (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    query_set_id TEXT DEFAULT '',
    name TEXT NOT NULL,
    path TEXT NOT NULL,
    rows INTEGER DEFAULT 0,
    created_at TEXT,
    meta TEXT DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_runs_profile ON runs(profile_id);
CREATE INDEX IF NOT EXISTS idx_results_run ON results(run_id);
"""


def init_db() -> None:
    db_path().parent.mkdir(parents=True, exist_ok=True)
    with _DB_LOCK, connect() as conn:
        conn.executescript(SCHEMA)


def row_to_dict(row: sqlite3.Row | None) -> dict[str, Any] | None:
    if row is None:
        return None
    d = dict(row)
    for key in ("tags", "meta", "query_ids", "region_filter"):
        if key in d and isinstance(d[key], str):
            try:
                d[key] = json.loads(d[key])
            except Exception:
                pass
    return d


def list_rows(sql: str, params: tuple = ()) -> list[dict[str, Any]]:
    with connect() as conn:
        return [row_to_dict(r) for r in conn.execute(sql, params).fetchall()]  # type: ignore[list-item]


def get_row(sql: str, params: tuple = ()) -> dict[str, Any] | None:
    with connect() as conn:
        return row_to_dict(conn.execute(sql, params).fetchone())
