from __future__ import annotations

import json
import queue
import threading
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable

from .processes import JobCancelled, terminate_tree


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass
class Job:
    id: str
    kind: str
    title: str
    status: str = "queued"  # queued|running|success|failed|cancelled
    progress: float = 0.0
    logs: list[str] = field(default_factory=list)
    result: Any = None
    error: str = ""
    created_at: str = field(default_factory=utcnow)
    started_at: str | None = None
    finished_at: str | None = None
    cancel_requested: bool = False
    process: Any = None
    profile_id: str = ""
    log_offset: int = 0
    updated_at: str = field(default_factory=utcnow)
    _log_lock: Any = field(default_factory=threading.RLock, repr=False)

    def log(self, line: str) -> None:
        stamp = datetime.now().strftime("%H:%M:%S")
        with self._log_lock:
            self.logs.append(f"[{stamp}] {line}")
            self.updated_at = utcnow()
            if len(self.logs) > 20000:
                self.log_offset += len(self.logs) - 10000
                self.logs = self.logs[-10000:]

    def logs_since(self, idx: int):
        with self._log_lock:
            start = max(idx, self.log_offset)
            return start, self.logs[start - self.log_offset:].copy()

    def check_cancelled(self) -> None:
        if self.cancel_requested:
            raise JobCancelled("任务已取消")

    def register_process(self, proc) -> None:
        self.process = proc
        if self.cancel_requested:
            terminate_tree(proc)
            self.check_cancelled()

    def to_dict(self, include_logs: bool = False) -> dict[str, Any]:
        d = {
            "id": self.id,
            "kind": self.kind,
            "title": self.title,
            "status": self.status,
            "progress": self.progress,
            "error": self.error,
            "created_at": self.created_at,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "log_count": self.log_offset + len(self.logs),
            "log_offset": self.log_offset,
            "profile_id": self.profile_id,
            "updated_at": self.updated_at,
        }
        if include_logs:
            d["logs"] = self.logs
        if self.result is not None:
            d["result"] = self.result
        return d


class JobManager:
    def __init__(self) -> None:
        self.jobs: dict[str, Job] = {}
        self.queue: queue.Queue[str] = queue.Queue()
        self.lock = threading.Lock()
        self.worker = threading.Thread(target=self._loop, daemon=True, name="gcam-studio-worker")
        self.worker.start()

    def submit(self, kind: str, title: str, fn: Callable[[Job], Any], profile_id: str = "") -> Job:
        job = Job(id=uuid.uuid4().hex[:12], kind=kind, title=title, profile_id=profile_id)
        with self.lock:
            self.jobs[job.id] = job
        setattr(job, "_fn", fn)
        self.queue.put(job.id)
        return job

    def get(self, job_id: str) -> Job | None:
        return self.jobs.get(job_id)

    def list(self) -> list[dict[str, Any]]:
        return [j.to_dict() for j in sorted(self.jobs.values(), key=lambda x: x.created_at, reverse=True)]

    def cancel(self, job_id: str) -> bool:
        job = self.jobs.get(job_id)
        if not job:
            return False
        if job.status in ("success", "failed", "cancelled"):
            return False
        job.cancel_requested = True
        job.log("收到取消请求…")
        proc = job.process
        if proc is not None:
            try:
                terminate_tree(proc)
            except Exception as exc:
                job.log(f"终止进程失败：{exc}")
        return True

    def _loop(self) -> None:
        while True:
            job_id = self.queue.get()
            job = self.jobs.get(job_id)
            if not job:
                continue
            if job.cancel_requested:
                job.status = "cancelled"
                job.finished_at = utcnow()
                continue
            job.status = "running"
            job.started_at = utcnow()
            fn = getattr(job, "_fn", None)
            try:
                if fn is None:
                    raise RuntimeError("job function missing")
                result = fn(job)
                if job.cancel_requested:
                    job.status = "cancelled"
                else:
                    job.result = result
                    job.progress = 1.0
                    job.status = "success"
            except Exception as exc:
                cancelled = job.cancel_requested or isinstance(exc, JobCancelled)
                job.error = str(exc)
                job.log(f"{'已取消' if cancelled else '失败'}：{exc}")
                job.status = "cancelled" if cancelled else "failed"
            finally:
                job.finished_at = utcnow()
                job.process = None


MANAGER = JobManager()
