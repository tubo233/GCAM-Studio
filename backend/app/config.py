from __future__ import annotations

import json
import os
import shutil
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field


def _app_home() -> Path:
    """Return the GCAM-Studio home directory (works in dev and packaged mode)."""
    env = os.environ.get("GCAM_STUDIO_HOME")
    if env:
        return Path(env).resolve()
    # backend/app/config.py -> backend/app -> backend -> GCAM-Studio
    return Path(__file__).resolve().parents[2]


HOME: Path = _app_home()
DEFAULT_GCAM_ROOT = str(HOME.parent) if (HOME.parent / "exe" / "gcam.exe").is_file() else ""


class AppSettings(BaseModel):
    gcam_root: str = os.environ.get("GCAM_STUDIO_GCAM_ROOT", DEFAULT_GCAM_ROOT)
    data_dir: str = os.environ.get("GCAM_STUDIO_DATA_DIR", str(HOME / "data"))
    rscript: str = ""
    java: str = ""
    max_builds: int = 3
    max_runs_kept: int = 20
    theme: str = "light"
    language: str = "zh-CN"

    def resolved(self) -> "AppSettings":
        data = AppSettings(**self.model_dump())
        # settings.json may come from another machine (source zip handed to a
        # colleague); re-detect tools whose saved path does not exist here.
        if not data.rscript or not Path(data.rscript).is_file():
            data.rscript = detect_rscript()
        if not data.java or not Path(data.java).is_file():
            data.java = detect_java()
        return data


def detect_rscript() -> str:
    candidates = [
        os.environ.get("GCAM_STUDIO_RSCRIPT", ""),
        r"F:\Environment Dependency\R-4.4.2\bin\Rscript.exe",
        r"C:\Program Files\R\R-4.4.2\bin\Rscript.exe",
    ]
    for c in candidates:
        if c and Path(c).is_file():
            return c
    found = shutil.which("Rscript")
    return found or ""


def detect_java() -> str:
    candidates = [
        os.environ.get("GCAM_STUDIO_JAVA", ""),
        r"F:\Environment Dependency\jdk-21.0.13.0.2\bin\java.exe",
        r"C:\Program Files\Microsoft\jdk-21.0.13.0.2\bin\java.exe",
    ]
    for c in candidates:
        if c and Path(c).is_file():
            return c
    found = shutil.which("java")
    return found or ""


def require_file(path: str | Path, label: str) -> Path:
    """Raise a readable error when a configured tool or model file is missing."""
    text = str(path or "").strip()
    file_path = Path(text) if text else None
    if file_path is None or not file_path.is_file():
        shown = text or "未设置"
        raise RuntimeError(f"找不到{label}：{shown}。请在「设置」页填写本机实际路径后保存。")
    return file_path


def settings_path() -> Path:
    data = Path(os.environ.get("GCAM_STUDIO_DATA_DIR", str(HOME / "data")))
    return data / "settings.json"


def load_settings() -> AppSettings:
    p = settings_path()
    if p.is_file():
        try:
            raw = json.loads(p.read_text(encoding="utf-8"))
            s = AppSettings(**raw).resolved()
        except Exception:
            s = None
        if s is not None:
            # A data_dir from another machine (e.g. G:\... absent here) would
            # crash PATHS.ensure(); fall back to the folder holding settings.json.
            if not Path(s.data_dir).is_dir():
                # In memory only: an unplugged drive must not rewrite the file.
                s.data_dir = str(p.parent)
            return s
    s = AppSettings().resolved()
    save_settings(s)
    return s


def save_settings(s: AppSettings) -> None:
    p = settings_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(s.model_dump(), ensure_ascii=False, indent=2), encoding="utf-8")


class Paths:
    """Convenience accessors bound to the current settings."""

    def __init__(self, settings: AppSettings):
        self.settings = settings
        self.root = Path(settings.gcam_root)
        self.data = Path(settings.data_dir)
        self.profiles = self.data / "profiles"
        self.cache = self.data / "cache"
        self.logs = self.data / "logs"

    def ensure(self) -> None:
        for p in (self.data, self.profiles, self.cache, self.logs):
            p.mkdir(parents=True, exist_ok=True)

    # Baseline locations -------------------------------------------------
    @property
    def gcamdata(self) -> Path:
        return self.root / "input" / "gcamdata"

    @property
    def extdata(self) -> Path:
        return self.gcamdata / "inst" / "extdata"

    @property
    def baseline_xml(self) -> Path:
        return self.gcamdata / "xml"

    @property
    def exe_dir(self) -> Path:
        return self.root / "exe"

    @property
    def gcam_exe(self) -> Path:
        return self.exe_dir / "gcam.exe"

    @property
    def model_interface_jar(self) -> Path:
        return self.root / "output" / "modelinterface" / "ModelInterface.jar"

    @property
    def main_queries(self) -> Path:
        return self.root / "output" / "queries" / "Main_queries.xml"

    @property
    def policy_dir(self) -> Path:
        return self.root / "input" / "policy"

    @property
    def extra_dir(self) -> Path:
        return self.root / "input" / "extra"

    @property
    def r_lib(self) -> Path:
        return HOME / "runtime" / "r-lib"


def env_for_tools(settings: AppSettings) -> dict[str, str]:
    """Environment for R / Java / gcam child processes."""
    env = os.environ.copy()
    if os.name == "nt":
        # Unix C.UTF-8 inherited from terminals is not a valid Windows R locale.
        # It makes existing packages under Unicode paths look missing.
        for key in list(env):
            if key.startswith("LC_") or key in ("LANG", "LANGUAGE"):
                env.pop(key)
        env["LC_ALL"] = "English_United States.utf8"
    java = Path(settings.java).resolve() if settings.java else None
    if java and java.is_file():
        env["JAVA_HOME"] = str(java.parent.parent)
        env["PATH"] = str(java.parent) + os.pathsep + str(java.parent / "server") + os.pathsep + env.get("PATH", "")
    if settings.rscript:
        rscript = Path(settings.rscript)
        env["R_HOME"] = str(rscript.parents[2] if rscript.parent.name.lower() == "x64" else rscript.parent.parent)
    rlib = str(HOME / "runtime" / "r-lib")
    env["R_LIBS_USER"] = rlib
    env["R_LIBS"] = rlib
    env.setdefault("R_USER", str(HOME / "runtime"))
    return env


SETTINGS: AppSettings = load_settings()
PATHS: Paths = Paths(SETTINGS)
PATHS.ensure()

# GCAM (C++/Java) cannot reliably open paths containing Chinese characters.
# A SUBST drive is better than a junction: Java's File.getCanonicalPath() does not
# resolve SUBST mappings back to the Chinese real path.
MODEL_ALIAS = Path(os.environ.get("GCAM_STUDIO_MODEL_ALIAS", "R:/"))


def _needs_alias() -> bool:
    """Only Chinese/non-ASCII roots need the SUBST alias.

    On an ASCII root (for example D:\\GCAM_CHINA\\GCAM_TOOL) using the real path
    avoids application-control policies that do not resolve SUBST drives.
    """
    if os.environ.get("GCAM_STUDIO_FORCE_ALIAS") == "1":
        return True
    try:
        return any(ord(ch) > 127 for ch in str(PATHS.root))
    except Exception:
        return True


_ALIAS_CACHE: dict[str, Path] = {}


def _ensure_alias(root: Path, letters: list[str]) -> Path:
    import subprocess
    key = str(root.resolve()).casefold()
    cached = _ALIAS_CACHE.get(key)
    if cached:
        try:
            if os.path.samefile(cached, root):
                return cached
        except OSError:
            pass
    subst = str(Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32" / "subst.exe")
    for letter in dict.fromkeys(letters):
        candidate = Path(f"{letter.upper()}:/")
        if candidate.exists():
            try:
                if os.path.samefile(candidate, root):
                    _ALIAS_CACHE[key] = candidate
                    return candidate
            except OSError:
                pass
            continue
        proc = subprocess.run([subst, f"{letter.upper()}:", str(root)], capture_output=True, timeout=10,
                              creationflags=subprocess.CREATE_NO_WINDOW)
        try:
            if proc.returncode == 0 and os.path.samefile(candidate, root):
                _ALIAS_CACHE[key] = candidate
                return candidate
        except OSError:
            pass
    raise RuntimeError(f"无法为中文目录建立英文盘符：{root}。请使用纯英文目录，或释放盘符 {', '.join(letters)}。")


def ensure_model_alias() -> None:
    if os.name == "nt" and _needs_alias() and PATHS.root.is_dir():
        globals()["MODEL_ALIAS"] = _ensure_alias(PATHS.root, [MODEL_ALIAS.drive.rstrip(":") or "R", "S", "T", "U"])


def alias_path(path: str | Path) -> Path:
    """Validate aliases against the current roots, including a separate data root."""
    p = Path(path).resolve()
    if os.name != "nt":
        return p
    for root, letters in ((PATHS.root, ["R", "S", "T", "U"]), (PATHS.data, ["V", "W", "X", "Y", "Z"])):
        if p.is_relative_to(root.resolve()) and (any(ord(ch) > 127 for ch in str(root)) or
                (root == PATHS.root and os.environ.get("GCAM_STUDIO_FORCE_ALIAS") == "1")):
            if not root.is_dir():
                raise RuntimeError(f"目录不存在：{root}")
            alias = _ensure_alias(root, letters)
            return alias / p.relative_to(root.resolve())
    if any(ord(ch) > 127 for ch in str(p)):
        raise RuntimeError(f"工具输入文件需要英文路径：{p}。请将该文件放入模型或 Studio 数据目录。")
    return p
