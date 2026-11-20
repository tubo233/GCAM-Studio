"""Bounded, cancellable subprocesses with lossless line streaming."""
from __future__ import annotations

import os
import queue
import subprocess
import threading
import time
from pathlib import Path


class JobCancelled(RuntimeError):
    pass


def terminate_tree(proc) -> None:
    if proc.poll() is not None:
        return
    if os.name == "nt":
        result = subprocess.run(
            ["taskkill", "/T", "/F", "/PID", str(proc.pid)], capture_output=True,
            timeout=20, creationflags=subprocess.CREATE_NO_WINDOW,
        )
        if result.returncode == 0:
            return
    proc.kill()


def run_streaming(cmd, *, cwd, env, log_path: Path, log_fn=None, process_cb=None, timeout=14400, on_started=None):
    proc = subprocess.Popen(
        cmd, cwd=str(cwd), env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, encoding="utf-8", errors="replace", bufsize=1,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
    )
    lines: queue.Queue = queue.Queue()

    def read() -> None:
        try:
            for line in proc.stdout:
                lines.put(line)
        finally:
            lines.put(None)

    reader = threading.Thread(target=read, daemon=True)
    started = time.monotonic()
    try:
        if on_started:
            on_started()
        if process_cb:
            process_cb(proc)
        reader.start()
        with log_path.open("w", encoding="utf-8") as output:
            while True:
                if time.monotonic() - started > timeout:
                    raise TimeoutError(f"运行超过 {timeout / 3600:g} 小时，已停止进程。日志：{log_path}")
                try:
                    line = lines.get(timeout=0.5)
                except queue.Empty:
                    continue
                if line is None:
                    break
                output.write(line)
                output.flush()
                if log_fn and line.strip():
                    log_fn(line.rstrip("\r\n"))
        proc.wait(timeout=30)
        if getattr(getattr(process_cb, "__self__", None), "cancel_requested", False):
            raise JobCancelled("任务已取消")
        return proc.returncode
    finally:
        if proc.poll() is None:
            terminate_tree(proc)
        if reader.ident is not None:
            reader.join(timeout=5)
        if proc.stdout:
            proc.stdout.close()
