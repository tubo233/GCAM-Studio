from __future__ import annotations

import json
import os
import re
import subprocess
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from lxml import etree

from ..config import PATHS, SETTINGS, alias_path, env_for_tools, require_file
from . import profiles, r_build
from .processes import JobCancelled, run_streaming

FILE_KEYS = {
    "xmlInputFileName": "modeltime.xml", "xmldb-location": "database_basexdb",
    "restart": "restart/restart", "xmlDebugFileName": "debug.xml", "climatFileName": "gas.emk",
    "costCurvesOutputFileName": "cost_curves.xml", "supplyDemandOutputFileName": "SDCurves.csv",
    "flow-graph": "gcam-flow-graph.dot", "dependencyGraphName": "DependencyGraph.dot",
    "landAllocatorGraphName": "LandAllocatorGraph.dot", "batchCSVOutputFile": "batch-csv-out.csv",
}


def now_id() -> str:
    return datetime.now().strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:8]


def _resolve_component(path_text: str, build_xml: Path, profile_id: str) -> str:
    p = path_text.strip()
    if not p:
        return p
    norm = p.replace("\\", "/")
    for prefix, kind, base in (("input/gcamdata/xml/", "xml", build_xml),
                               ("input/policy/", "policy", PATHS.policy_dir),
                               ("input/extra/", "extra", PATHS.extra_dir)):
        for relative in ("../" + prefix, prefix):
            if norm.startswith(relative):
                rel = norm[len(relative):]
                overlay = profiles.overlay_path(profile_id, kind, rel)
                return str(alias_path(overlay if overlay.is_file() else profiles.safe_relative(base, rel)))
    if not Path(p).is_absolute():
        return str(alias_path((PATHS.exe_dir / p).resolve()))
    return str(alias_path(p))


def _set_value(root, tag: str, name: str, value) -> None:
    if value is None:
        return
    parent = root.find(tag)
    if parent is None:
        parent = etree.SubElement(root, tag)
    node = next((v for v in parent.findall("Value") if v.get("name") == name), None)
    if node is None:
        node = etree.SubElement(parent, "Value", name=name)
    node.text = str(value)


def generate_config(profile_id: str, build: dict[str, Any], run_dir: Path,
                    scenario_name: str = "Reference", stop_year: int | None = None,
                    stop_period: int | None = None, max_parallelism: int | None = None,
                    fast_mode: bool = False, extra_int=None, extra_bool=None) -> Path:
    run_dir.mkdir(parents=True, exist_ok=True)
    tree = etree.parse(str(profiles.profile_dir(profile_id) / "config.xml"))
    root = tree.getroot()
    build_xml = Path(build["xml_dir"])
    if fast_mode:
        stop_year = min(stop_year or 2025, 2025)
        stop_period = -1
    for value in root.findall("./Files/Value"):
        name = value.get("name", "")
        if name in FILE_KEYS:
            target = build_xml / "modeltime.xml" if name == "xmlInputFileName" else run_dir / FILE_KEYS[name]
            if name == "xmlInputFileName":
                overlay = profiles.overlay_path(profile_id, "xml", "modeltime.xml")
                if overlay.is_file():
                    target = overlay
            value.text = str(alias_path(target))
        elif name in ("policy-target-file", "GHGInputFileName") and value.text:
            value.text = _resolve_component(value.text, build_xml, profile_id)
    for value in root.findall("./ScenarioComponents/Value"):
        if value.text:
            value.text = _resolve_component(value.text, build_xml, profile_id)
    _set_value(root, "Strings", "scenarioName", scenario_name)
    _set_value(root, "Ints", "stop-year", stop_year)
    _set_value(root, "Ints", "stop-period", -1 if stop_year is not None and stop_period is None else stop_period)
    _set_value(root, "Ints", "max-parallelism", max_parallelism)
    for k, v in (extra_int or {}).items():
        _set_value(root, "Ints", k, v)
    for k, v in (extra_bool or {}).items():
        _set_value(root, "Bools", k, v)
    out = run_dir / "configuration.xml"
    tree.write(str(out), encoding="UTF-8", xml_declaration=True, pretty_print=True)
    return out


def _prepare_logs(run_dir: Path) -> Path:
    source = require_file(PATHS.exe_dir / "log_conf.xml", "GCAM 日志配置 log_conf.xml")
    tree = etree.parse(str(source))
    destination = run_dir / "logs"
    destination.mkdir(exist_ok=True)
    for node in tree.findall(".//FileName"):
        node.text = str(alias_path(destination / Path((node.text or "log.txt").replace("\\", "/")).name))
    target = run_dir / "log_conf.xml"
    tree.write(str(target), encoding="UTF-8", xml_declaration=True, pretty_print=True)
    return target


@contextmanager
def _model_lock():
    path = PATHS.exe_dir / ".studio-run.lock"
    with path.open("a+b") as handle:
        handle.seek(0)
        if not handle.read(1):
            handle.write(b"0")
            handle.flush()
        handle.seek(0)
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            raise RuntimeError("这套模型已有另一个 Studio 正在求解，请等待该任务完成。") from exc
        try:
            yield
        finally:
            handle.seek(0)
            if os.name == "nt":
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def _save_manifest(run_dir: Path, meta: dict) -> None:
    tmp = run_dir / "manifest.tmp"
    tmp.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(run_dir / "manifest.json")


def run_gcam(profile_id: str, build: dict[str, Any] | None = None,
             scenario_name: str = "Reference", stop_year: int | None = None,
             stop_period: int | None = None, max_parallelism: int | None = None,
             fast_mode: bool = False, log_fn: Callable[[str], None] | None = None,
             process_cb=None, dry_run: bool = False, timeout: int = 24 * 3600, rebuild: bool = False) -> dict[str, Any]:
    profiles.load_profile(profile_id)
    if fast_mode:
        stop_year, stop_period = min(stop_year or 2025, 2025), -1
    run_id = now_id()
    run_dir = profiles.profile_dir(profile_id) / "runs" / run_id
    run_dir.mkdir(parents=True, exist_ok=True)
    log_path = run_dir / "gcam.log"
    meta = {"run_id": run_id, "profile_id": profile_id, "scenario_name": scenario_name,
            "status": "running", "stage": "build", "created_at": datetime.now(timezone.utc).isoformat(),
            "run_dir": str(run_dir), "log": str(log_path), "stop_year": stop_year,
            "stop_period": stop_period, "fast_mode": fast_mode, "validation_only": fast_mode,
            "solver_precision": "standard", "model_root": str(PATHS.root), "failed_periods": [],
            "completed_periods": [], "calibration_warnings": []}
    started = time.monotonic()

    def log(msg):
        if log_fn:
            log_fn(msg)

    _save_manifest(run_dir, meta)
    try:
        if build is None:
            build = r_build.latest_build(profile_id)
        if rebuild or build is None or r_build.build_is_stale(profile_id, build):
            log("输入与现有构建不一致，生成本次 XML…")
            build = r_build.run_build(profile_id, log_fn=log_fn, process_cb=process_cb)
        meta.update(build_id=build.get("build_id", ""), xml_dir=build["xml_dir"],
                    input_signature=build.get("input_signature"), stage="configure")
        _save_manifest(run_dir, meta)
        config_path = generate_config(profile_id, build, run_dir, scenario_name, stop_year,
                                      stop_period, max_parallelism, fast_mode)
        meta["config"] = str(config_path)
        log(f"生成配置：{config_path}")
        log(f"XML 来源：{build['xml_dir']}（{'基线' if build.get('reused_baseline') else 'CSV 构建'}）")
        if fast_mode:
            log("快速验证：保留标准求解精度，计算至 2025 年或更早。正式情景请关闭快速验证。")
        if dry_run:
            meta["status"] = "dry-run"
            return meta
        require_file(PATHS.gcam_exe, "gcam.exe")
        tree = etree.parse(str(config_path))
        inputs = tree.findall("./ScenarioComponents/Value") + tree.findall("./Files/Value[@name='xmlInputFileName']")
        target_file = tree.findtext("./Files/Value[@name='policy-target-file']", "").strip()
        enabled = {node.get("name") for node in tree.findall("./Bools/Value") if (node.text or "").strip().lower() in {"1", "true"}}
        if "find-path" in enabled and "BatchMode" not in enabled:
            if not target_file or not Path(target_file).is_file():
                raise RuntimeError(f"已启用政策目标搜索（find-path），但找不到政策目标文件：{target_file or '未设置'}。请检查当前 Profile 的模型配置。")
            log(f"已启用政策目标搜索，目标文件：{target_file}")
        for node in inputs:
            require_file((node.text or "").strip(), f"模型输入 {node.get('name', '')}")
        (run_dir / "restart").mkdir(exist_ok=True)
        log_config = _prepare_logs(run_dir)
        cmd = [str(alias_path(PATHS.gcam_exe)), "-C", str(alias_path(config_path)), "-L", str(alias_path(log_config))]
        meta.update(stage="solve", command=cmd, db=str(run_dir / "database_basexdb"))
        _save_manifest(run_dir, meta)
        log("启动 GCAM：" + " ".join(cmd))
        all_solved = False

        def on_line(line):
            nonlocal all_solved
            log("[GCAM] " + line)
            if "Model run beginning." in line:
                all_solved = False
                if meta["stage"] != "solve":
                    meta["stage"] = "solve"
                    _save_manifest(run_dir, meta)
                for key in ("failed_periods", "completed_periods", "calibration_warnings"):
                    meta[key] = []
                meta.pop("current_year", None)
                meta.pop("calculated_through", None)
            year = re.match(r"Period\s+\d+:\s*(\d{4})", line)
            if year:
                meta["current_year"] = int(year[1])
            if "Model solved normally." in line or "Model solved with last period's prices." in line:
                meta["calculated_through"] = meta.get("current_year")
            for pattern, key in ((r"Model did not solve period (\d+)", "failed_periods"),
                                 (r"Model solved normally\. Iterations period (\d+)", "completed_periods"),
                                 (r"Model did not calibrate successfully in period (\d+)", "calibration_warnings")):
                match = re.search(pattern, line)
                if match and int(match[1]) not in meta[key]:
                    meta[key].append(int(match[1]))
            if "All model periods solved correctly." in line:
                all_solved = True
            if "Failed due to invalid trial price generated by solver." in line:
                meta["target_error"] = "求解器给出了无效的试算价格。这不等于用完了迭代次数。请核对政策目标文件及其对应的碳市场配置。"
                log("政策目标搜索出现无效的试算价格；随后写出数据库不代表达成了目标。")
            elif "Exiting target finding search as the iterations limit was reached." in line:
                meta["target_error"] = "政策目标搜索已达到迭代上限。请检查目标文件和目标搜索的迭代设置。"
            if "Starting output to XML Database." in line and meta["stage"] != "output":
                meta["stage"] = "output"
                _save_manifest(run_dir, meta)
                log("正在写入结果数据库；这一步可能暂时没有新日志，请等进程退出后再判断是否成功。")

        with _model_lock():
            code = run_streaming(cmd, cwd=alias_path(PATHS.exe_dir), env=env_for_tools(SETTINGS),
                                 log_path=log_path, log_fn=on_line, process_cb=process_cb, timeout=timeout)
        meta["exit_code"] = code
        if meta.get("target_error"):
            report = run_dir / "logs/target_finder_log.txt"
            raise RuntimeError(f"政策目标搜索失败（退出码 {code}）：{meta['target_error']}"
                               f"诊断日志：{report if report.is_file() else log_path}。")
        if meta["failed_periods"]:
            raise RuntimeError(f"模型计算期未收敛：{meta['failed_periods']}（退出码 {code}）。日志：{log_path}")
        if code != 0:
            detail = "模型已报告各计算期收敛，但整个任务未成功。" if all_solved else "日志中未定位到具体未收敛期。"
            raise RuntimeError(f"GCAM 退出码 {code}。{detail}日志：{log_path}")
        if not all_solved:
            raise RuntimeError(f"日志缺少所有计算期收敛的确认。日志：{log_path}")
        database = Path(meta["db"])
        if not database.is_dir() or not any(database.glob("*.basex")):
            raise RuntimeError(f"GCAM 未生成有效 BaseX 数据库：{database}")
        if meta["calibration_warnings"]:
            raise RuntimeError(f"历史期校准检查未通过：{meta['calibration_warnings']}；请检查 CSV 数据和单位。")
        meta.update(status="success", stage="complete")
        log(f"{'快速验证通过' if fast_mode else 'GCAM 运行成功'}，数据库：{database}")
        return meta
    except Exception as exc:
        cancelled = isinstance(exc, JobCancelled) or bool(getattr(getattr(process_cb, "__self__", None), "cancel_requested", False))
        meta.update(status="cancelled" if cancelled else "failed", error=str(exc))
        if isinstance(exc, OSError) and getattr(exc, "winerror", None) == 4551:
            meta["error"] = f"Windows 应用控制策略阻止启动 {PATHS.gcam_exe}（WinError 4551）。请联系 IT 配置允许规则。"
            raise RuntimeError(meta["error"]) from exc
        raise
    finally:
        meta.update(elapsed_sec=round(time.monotonic() - started, 1), finished_at=datetime.now(timezone.utc).isoformat())
        _save_manifest(run_dir, meta)


def find_run(run_id: str) -> dict[str, Any]:
    if not re.fullmatch(r"[A-Za-z0-9_-]+", run_id):
        raise FileNotFoundError(f"Run not found: {run_id}")
    for item in list_runs():
        if item["run_id"] == run_id:
            return item
    raise FileNotFoundError(f"Run not found: {run_id}")


def list_runs(profile_id: str | None = None) -> list[dict[str, Any]]:
    out = []
    if not PATHS.profiles.is_dir():
        return out
    for pd in PATHS.profiles.iterdir():
        if not pd.is_dir() or (profile_id and pd.name != profile_id):
            continue
        for manifest in (pd / "runs").glob("*/manifest.json"):
            try:
                data = json.loads(manifest.read_text(encoding="utf-8"))
                data.update(run_id=manifest.parent.name, run_dir=str(manifest.parent), profile_id=pd.name)
                out.append(data)
            except (OSError, ValueError):
                continue
    return sorted(out, key=lambda x: x.get("created_at", ""), reverse=True)


def recover_interrupted_runs() -> None:
    for item in list_runs():
        if item.get("status") == "running":
            item.update(status="interrupted", error="上次后端在任务完成前退出。请查看日志并重新运行。")
            _save_manifest(Path(item["run_dir"]), item)


def last_calculated_year(run: dict[str, Any]) -> int | None:
    if run.get("calculated_through"):
        return int(run["calculated_through"])
    current = last = None
    log_file = Path(run.get("log") or "__missing_gcam_log__")
    if log_file.is_file():
        with log_file.open(encoding="utf-8", errors="replace") as stream:
            for line in stream:
                if "Model run beginning." in line:
                    current = last = None
                match = re.match(r"Period\s+\d+:\s*(\d{4})", line)
                if match:
                    current = int(match[1])
                if "Model solved normally." in line or "Model solved with last period's prices." in line:
                    last = current
    return last or (int(run["stop_year"]) if run.get("stop_year") and int(run["stop_year"]) > 0 else None)
