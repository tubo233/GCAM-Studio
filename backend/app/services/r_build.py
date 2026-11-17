from __future__ import annotations

import json
import hashlib
import os
import shutil
import subprocess
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from ..config import HOME, PATHS, SETTINGS, env_for_tools, require_file
from . import csv_engine, profiles
from .processes import run_streaming

MIRROR_DIRS = ["R", "inst", "data", "exec"]
MIRROR_FILES = ["DESCRIPTION", "NAMESPACE"]


def now_id() -> str:
    return datetime.now().strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:4]


def has_data_overlay(profile_id: str) -> bool:
    root = profiles.overlay_root(profile_id) / "gcamdata"
    return root.is_dir() and any(p.is_file() for p in root.rglob("*"))


def _hardlink_or_copy(src: Path, dst: Path) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    if dst.exists():
        dst.unlink()
    try:
        os.link(src, dst)
    except OSError:
        shutil.copy2(src, dst)


def prepare_mirror(profile_id: str, build_dir: Path) -> tuple[Path, dict[str, Any]]:
    """Create a hardlink mirror of gcamdata and inject the profile's CSV overlays."""
    src = PATHS.gcamdata
    dst = build_dir / "gcamdata"
    if dst.exists():
        shutil.rmtree(dst)
    dst.mkdir(parents=True, exist_ok=True)
    counts = {"linked": 0, "copied": 0}
    for name in MIRROR_FILES:
        s = src / name
        if s.is_file():
            _hardlink_or_copy(s, dst / name)
            counts["linked"] += 1
    for name in MIRROR_DIRS:
        sroot = src / name
        if not sroot.is_dir():
            continue
        for dirpath, _dirnames, filenames in os.walk(sroot):
            d = Path(dirpath)
            for fn in filenames:
                s = d / fn
                rel = s.relative_to(src)
                t = dst / rel
                _hardlink_or_copy(s, t)
                counts["linked"] += 1
    # Inject overlay files (real copies, never hardlinks)
    ov_root = profiles.overlay_root(profile_id) / "gcamdata"
    injected = 0
    if ov_root.is_dir():
        for p in ov_root.rglob("*"):
            if not p.is_file():
                continue
            rel = p.relative_to(ov_root)
            t = dst / "inst" / "extdata" / rel
            t.parent.mkdir(parents=True, exist_ok=True)
            if t.exists():
                t.unlink()
            shutil.copy2(p, t)
            injected += 1
    # The Studio only uses driver(), not driver_drake().  The lockfile includes
    # drake/devtools, which pull heavy compiled dependencies; drop them so a small
    # binary-only R library is enough to build XML.
    desc = dst / "DESCRIPTION"
    if desc.is_file():
        text = desc.read_text(encoding="utf-8", errors="replace")
        text = text.replace("    devtools,\n", "    pkgload,\n")
        text = text.replace("    drake (>= 6.2.1)\n", "")
        text = text.replace("    drake (>= 6.2.1),", "")
        private = desc.with_suffix(".studio-tmp")
        private.write_text(text, encoding="utf-8")
        private.replace(desc)

    # Patch the one packageVersion() call that would require gcamdata to be installed.
    driver = dst / "R" / "driver.R"
    if driver.is_file():
        text = driver.read_text(encoding="utf-8", errors="replace")
        text2 = text.replace('as.character(utils::packageVersion("gcamdata"))', '"8.2"')
        if text2 != text:
            private = driver.with_suffix(".studio-tmp")
            private.write_text(text2, encoding="utf-8")
            private.replace(driver)
    return dst, {"linked": counts["linked"], "injected": injected}


R_SCRIPT = r"""
args <- commandArgs(trailingOnly=TRUE)
mirror <- args[[1]]
xmldir <- args[[2]]
outdir <- args[[3]]
options(warn = 1, java.parameters = c("-Xmx4g"))
cat("GCAM Studio: loading gcamdata from", mirror, "\n")
setwd(mirror)
pkgload::load_all(mirror, quiet = FALSE, export_all = TRUE, helpers = FALSE)
ns <- asNamespace("gcamdata")
driver_fn <- get("driver", envir = ns)
dir.create(xmldir, recursive = TRUE, showWarnings = FALSE)
dir.create(outdir, recursive = TRUE, showWarnings = FALSE)
cat("GCAM Studio: starting driver()\n")
driver_fn(write_outputs = FALSE, write_xml = TRUE, outdir = outdir, xmldir = xmldir, quiet = FALSE)
cat("GCAM Studio: driver() finished\n")
"""


def _run_build(
    profile_id: str,
    log_fn: Callable[[str], None] | None = None,
    process_cb: Callable[[subprocess.Popen], None] | None = None,
    timeout: int = 4 * 3600,
    _build_id: str | None = None,
) -> dict[str, Any]:
    profile = profiles.load_profile(profile_id)
    build_id = _build_id or now_id()
    build_dir = profiles.profile_dir(profile_id) / "builds" / build_id
    xml_dir = build_dir / "xml"
    out_dir = build_dir / "outputs"
    build_dir.mkdir(parents=True, exist_ok=True)
    signature = input_signature(profile_id)

    def log(msg: str) -> None:
        if log_fn:
            log_fn(msg)

    # Fast path: no CSV changes -> reuse the baseline XML tree
    if not has_data_overlay(profile_id):
        manifest = {
            "build_id": build_id,
            "profile_id": profile_id,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "reused_baseline": True,
            "xml_dir": str(PATHS.baseline_xml),
            "status": "success",
            "message": "没有修改任何 CSV，直接复用基线 XML",
            "input_signature": signature,
        }
        (build_dir / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
        log("没有修改 CSV，跳过 gcamdata，直接复用基线 XML。")
        return manifest

    log(f"准备 gcamdata 硬链接镜像：{build_dir}")
    mirror, counts = prepare_mirror(profile_id, build_dir)
    log(f"镜像完成：{counts['linked']} 个文件硬链接，{counts['injected']} 个覆盖文件。")

    script = build_dir / "run_gcamdata.R"
    script.write_text(R_SCRIPT, encoding="utf-8")
    log_file = build_dir / "build.log"
    require_file(SETTINGS.rscript, "Rscript.exe")
    if not PATHS.gcamdata.is_dir():
        raise RuntimeError(f"找不到 gcamdata：{PATHS.gcamdata}。请在「设置」页填写 GCAM 模型根目录。")
    cmd = [SETTINGS.rscript, "--vanilla", str(script), str(mirror), str(xml_dir), str(out_dir)]
    log("运行 R：" + " ".join(cmd))
    t0 = time.time()
    last_progress = -1
    returncode = run_streaming(cmd, cwd=build_dir, env=env_for_tools(SETTINGS),
                               log_path=log_file, log_fn=log, process_cb=process_cb, timeout=timeout)
    elapsed = time.time() - t0
    if returncode != 0:
        raise RuntimeError(f"gcamdata 构建失败，退出码 {returncode}，日志：{log_file}")
    if input_signature(profile_id) != signature:
        raise RuntimeError("构建期间输入发生变化，请重新生成 XML。")
    xml_files = sorted(xml_dir.glob("*.xml"))
    if not xml_files:
        raise RuntimeError(f"gcamdata 完成但没有生成 XML：{xml_dir}")
    log(f"XML 生成完成：{len(xml_files)} 个，用时 {elapsed:.1f}s")

    # Replace byte-identical XML with hardlinks to the baseline to save disk.
    deduped = 0
    for p in xml_files:
        base = PATHS.baseline_xml / p.name
        if base.is_file() and base.stat().st_size == p.stat().st_size:
            try:
                if csv_engine.file_sha256(p) == csv_engine.file_sha256(base):
                    link = p.with_suffix(".dedup-tmp")
                    os.link(base, link)
                    link.replace(p)
                    deduped += 1
            except OSError:
                pass
    if deduped:
        log(f"XML 去重：{deduped} 个文件与基线相同，已改为硬链接。")

    manifest = {
        "build_id": build_id,
        "profile_id": profile_id,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "reused_baseline": False,
        "xml_dir": str(xml_dir),
        "xml_count": len(xml_files),
        "deduped": deduped,
        "elapsed_sec": round(elapsed, 1),
        "log": str(log_file),
        "status": "success",
        "input_signature": signature,
        "files": [{"name": p.name, "size": p.stat().st_size} for p in xml_files],
    }
    (build_dir / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    return manifest


def run_build(profile_id: str, log_fn=None, process_cb=None, timeout: int = 4 * 3600) -> dict[str, Any]:
    build_id = now_id()
    directory = profiles.profile_dir(profile_id) / "builds" / build_id
    directory.mkdir(parents=True, exist_ok=True)
    manifest = {"build_id": build_id, "profile_id": profile_id, "status": "running",
                "created_at": datetime.now(timezone.utc).isoformat(), "model_root": str(PATHS.root),
                "log": str(directory / "build.log")}
    target = directory / "manifest.json"
    target.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    try:
        return _run_build(profile_id, log_fn, process_cb, timeout, _build_id=build_id)
    except Exception as exc:
        cancelled = bool(getattr(getattr(process_cb, "__self__", None), "cancel_requested", False))
        manifest.update(status="cancelled" if cancelled else "failed", error=str(exc),
                        finished_at=datetime.now(timezone.utc).isoformat())
        target.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
        raise


def input_signature(profile_id: str) -> str:
    """Content identity includes deletions, restored files and the selected model."""
    root = profiles.overlay_root(profile_id) / "gcamdata"
    overlays = [(p.relative_to(root).as_posix(), csv_engine.file_sha256(p))
                for p in sorted(root.rglob("*")) if p.is_file()] if root.is_dir() else []
    baseline = [(p.name, p.stat().st_size, p.stat().st_mtime_ns)
                for p in sorted(PATHS.baseline_xml.glob("*.xml"))]
    raw = json.dumps([str(PATHS.root.resolve()), overlays, baseline], ensure_ascii=True)
    return hashlib.sha256(raw.encode()).hexdigest()


def build_is_stale(profile_id: str, build: dict[str, Any]) -> bool:
    return (not Path(build.get("xml_dir") or "__missing_xml__").is_dir()
            or build.get("input_signature") != input_signature(profile_id))


def latest_build(profile_id: str, valid_only: bool = True) -> dict[str, Any] | None:
    root = profiles.profile_dir(profile_id) / "builds"
    if not root.is_dir():
        return None
    items = sorted(root.iterdir(), key=lambda p: p.name, reverse=True)
    for d in items:
        m = d / "manifest.json"
        if not m.is_file():
            continue
        try:
            data = json.loads(m.read_text(encoding="utf-8"))
        except Exception:
            continue
        if valid_only and data.get("status") != "success":
            continue
        data["build_dir"] = str(d)
        return data
    return None
