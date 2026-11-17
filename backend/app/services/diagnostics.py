"""Cached executable checks; existence alone does not establish a usable runtime."""
from __future__ import annotations

import os
import re
import subprocess
import time
import threading
from pathlib import Path

from ..config import SETTINGS, PATHS, env_for_tools

_cache: tuple[tuple, float, dict] | None = None
_lock = threading.Lock()


def tool_checks() -> dict:
    with _lock:
        return _tool_checks()


def _tool_checks() -> dict:
    global _cache
    key = (SETTINGS.java, SETTINGS.rscript, str(PATHS.r_lib))
    if _cache and _cache[0] == key and time.monotonic() - _cache[1] < 120:
        return dict(_cache[2])
    result = {"java_ok": False, "rscript_ok": False, "java_message": "未配置 Java", "rscript_message": "未配置 Rscript"}
    env = env_for_tools(SETTINGS)

    def command(args, timeout=5):
        proc = subprocess.run(args, env=env, capture_output=True, text=True, encoding="utf-8", errors="replace",
                              timeout=timeout, creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
        text = ((proc.stdout or "") + (proc.stderr or "")).strip()
        if proc.returncode:
            raise RuntimeError(text[-800:] or f"退出码 {proc.returncode}")
        return text

    if SETTINGS.java:
        try:
            java = Path(SETTINGS.java).resolve()
            version = command([str(java), "-version"])
            if not re.search(r'version "21(?:\.|\")', version) or "64-Bit" not in version:
                raise RuntimeError("需要 64 位 JDK 21。" + version[:250])
            if not (java.parent / "server" / "jvm.dll").is_file():
                raise RuntimeError("Java 目录缺少 bin/server/jvm.dll，请选择完整 64 位 JDK 21。")
            result.update(java_ok=True, java_message=version.splitlines()[0])
        except Exception as exc:
            result["java_message"] = str(exc)
    if SETTINGS.rscript:
        try:
            version = command([SETTINGS.rscript, "--version"])
            packages = 'for(p in c("pkgload","dplyr","tidyr","readr","data.table","stringr","xml2","assertthat")) loadNamespace(p); cat("R packages OK")'
            command([SETTINGS.rscript, "--vanilla", "-e", packages], timeout=15)
            result.update(rscript_ok=True, rscript_message=version.splitlines()[0])
        except Exception as exc:
            result["rscript_message"] = str(exc)
    _cache = (key, time.monotonic(), result)
    return dict(result)
