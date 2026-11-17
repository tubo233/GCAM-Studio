from __future__ import annotations

import asyncio
import io
import json
import shutil
import zipfile
import uuid
from pathlib import Path
from typing import Any

from fastapi import Body, FastAPI, File, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from lxml import etree

from .config import HOME, PATHS, SETTINGS, AppSettings, env_for_tools, load_settings, save_settings
from .hostnet import HostPathError, is_local_client, list_directory, list_drives
from .db import connect, get_row, list_rows, utcnow
from .services import catalog as catalog_svc
from .services import files as files_svc
from .services import gcam_run, jobs, profiles, queries, r_build
from .services.data_migrate import DataMigrateError, migrate_data_dir, same_data_dir
from .services.processes import JobCancelled
from .services.diagnostics import tool_checks

app = FastAPI(title="GCAM-China Studio API", version="0.1.3")


@app.exception_handler(ValueError)
async def invalid_input(request: Request, exc: ValueError):
    return JSONResponse(status_code=400, content={"detail": str(exc)})


# --------------------------------------------------------------------------- helpers
def _ok(data: Any = None, **extra: Any) -> dict[str, Any]:
    out = {"ok": True}
    if data is not None:
        out["data"] = data
    out.update(extra)
    return out


def _require_profile(pid: str) -> dict[str, Any]:
    try:
        return profiles.load_profile(pid)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


# --------------------------------------------------------------------------- system
def _client_host(request: Request) -> str:
    return request.client.host if request.client else ""


def _require_local(request: Request) -> None:
    if not is_local_client(_client_host(request)):
        raise HTTPException(403, "JDK、GCAM 等本机路径只能在运行模型的电脑上修改。")


@app.get("/api/health")
def health(request: Request) -> dict[str, Any]:
    return _ok({
        **tool_checks(),
        "app": "GCAM-China Studio",
        "version": "0.1.3",
        "home": str(HOME),
        "gcam_root": str(PATHS.root),
        "gcam_root_exists": PATHS.gcam_exe.is_file() and PATHS.baseline_xml.is_dir(),
        "gcam_exe": str(PATHS.gcam_exe),
        "gcam_exe_exists": PATHS.gcam_exe.is_file(),
        "java": SETTINGS.java,
        "java_exists": Path(SETTINGS.java).is_file() if SETTINGS.java else False,
        "rscript": SETTINGS.rscript,
        "rscript_exists": Path(SETTINGS.rscript).is_file() if SETTINGS.rscript else False,
        "model_interface": str(PATHS.model_interface_jar),
        "model_interface_exists": PATHS.model_interface_jar.is_file(),
        "profiles": len(profiles.list_profiles()),
        "can_edit_settings": is_local_client(_client_host(request)),
    })


@app.get("/api/settings")
def get_settings() -> dict[str, Any]:
    return _ok(SETTINGS.model_dump())


def _running_job() -> str | None:
    for job in jobs.MANAGER.jobs.values():
        if job.status in ("queued", "running"):
            return job.title or job.id
    return None


def _require_idle_profile(pid: str) -> None:
    if any(j.status in ("queued", "running") and j.profile_id == pid for j in jobs.MANAGER.jobs.values()):
        raise HTTPException(409, "该 Profile 有任务正在排队或运行，请结束后再修改输入或删除。")


@app.put("/api/settings")
def put_settings(request: Request, body: dict[str, Any] = Body(...)) -> dict[str, Any]:
    _require_local(request)
    merged = SETTINGS.model_dump()
    merged.update({k: v for k, v in body.items() if k in merged})
    new = AppSettings(**merged).resolved()
    if _running_job() and any(getattr(new, k) != getattr(SETTINGS, k) for k in ("gcam_root", "java", "rscript", "data_dir")):
        raise HTTPException(409, "有任务正在排队或运行，请结束后再修改模型、工具或数据目录。")
    old_dir = Path(SETTINGS.data_dir)
    new_dir = Path(new.data_dir)
    if not str(new.gcam_root).strip() or not Path(new.gcam_root).is_absolute():
        raise HTTPException(400, "GCAM 模型根目录需要填写绝对路径。")
    if not str(new.data_dir).strip() or not new_dir.is_absolute():
        raise HTTPException(400, "Studio 数据目录需要填写绝对路径。")
    migration = None
    if not same_data_dir(old_dir, new_dir):
        busy = _running_job()
        if busy:
            raise HTTPException(400, f"有任务正在进行（{busy}），完成后再修改数据目录。")
        try:
            migration = migrate_data_dir(old_dir, new_dir)
        except DataMigrateError as exc:
            raise HTTPException(400, str(exc)) from exc
    # mutate the shared object so every service sees the new values
    for k, v in new.model_dump().items():
        setattr(SETTINGS, k, v)
    save_settings(SETTINGS)
    PATHS.__init__(SETTINGS)
    PATHS.ensure()
    payload = SETTINGS.model_dump()
    payload["migration"] = migration
    return _ok(payload)


@app.get("/api/fs/drives")
def fs_drives(request: Request) -> dict[str, Any]:
    _require_local(request)
    return _ok(list_drives())


@app.get("/api/fs/list")
def fs_list(request: Request, path: str = Query(...)) -> dict[str, Any]:
    _require_local(request)
    try:
        return _ok(list_directory(path))
    except HostPathError as exc:
        raise HTTPException(400, str(exc)) from exc


@app.get("/api/stats")
def stats() -> dict[str, Any]:
    cat = catalog_svc.build_catalog()
    profs = profiles.list_profiles()
    runs = gcam_run.list_runs()
    return _ok(
        {
            "catalog": cat.get("stats", {}),
            "modules": cat.get("modules", []),
            "profiles": len(profs),
            "runs": len(runs),
            "recent_runs": runs[:5],
        }
    )


# --------------------------------------------------------------------------- profiles
@app.get("/api/profiles")
def api_list_profiles() -> dict[str, Any]:
    return _ok(profiles.list_profiles())


@app.post("/api/profiles")
def api_create_profile(body: dict[str, Any] = Body(...)) -> dict[str, Any]:
    name = (body.get("name") or "").strip()
    if not name:
        raise HTTPException(400, "名称不能为空")
    try:
        meta = profiles.create_profile(name, body.get("template") or "configuration_china.xml", body.get("description") or "")
    except FileNotFoundError as exc:
        raise HTTPException(400, f"找不到模型配置模板。请先把 GCAM 模型根目录设对。{exc}") from exc
    return _ok(meta)


@app.get("/api/profiles/{pid}")
def api_get_profile(pid: str) -> dict[str, Any]:
    meta = _require_profile(pid)
    meta["overlay"] = profiles.list_overlay(pid)
    meta["builds"] = [b.get("build_id") for b in _list_builds(pid)]
    meta["runs"] = gcam_run.list_runs(pid)[:20]
    return _ok(meta)


@app.patch("/api/profiles/{pid}")
def api_update_profile(pid: str, body: dict[str, Any] = Body(...)) -> dict[str, Any]:
    meta = _require_profile(pid)
    for key in ("name", "description", "notes", "tags"):
        if key in body:
            meta[key] = body[key]
    profiles.save_profile(meta)
    return _ok(meta)


@app.delete("/api/profiles/{pid}")
def api_delete_profile(pid: str) -> dict[str, Any]:
    _require_profile(pid)
    _require_idle_profile(pid)
    profiles.delete_profile(pid)
    return _ok()


@app.post("/api/profiles/{pid}/clone")
def api_clone_profile(pid: str, body: dict[str, Any] = Body(...)) -> dict[str, Any]:
    _require_profile(pid)
    _require_idle_profile(pid)
    return _ok(profiles.clone_profile(pid, body.get("name") or "副本"))


@app.get("/api/profiles/{pid}/export")
def api_export_profile(pid: str) -> FileResponse:
    meta = _require_profile(pid)
    root = profiles.profile_dir(pid)
    out = PATHS.cache / f"profile-{pid}.zip"
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for name in ("profile.json", "config.xml"):
            p = root / name
            if p.is_file():
                z.write(p, name)
        ov = root / "overlay"
        if ov.is_dir():
            for p in ov.rglob("*"):
                if p.is_file():
                    z.write(p, p.relative_to(root).as_posix())
    return FileResponse(str(out), filename=f"{meta.get('name', pid)}.zip")


@app.post("/api/profiles/import")
async def api_import_profile(file: UploadFile = File(...)) -> dict[str, Any]:
    import tempfile

    data = await file.read()
    with tempfile.TemporaryDirectory() as td:
        zpath = Path(td) / "profile.zip"
        zpath.write_bytes(data)
        with zipfile.ZipFile(zpath) as z:
            z.extractall(td)
        meta_path = Path(td) / "profile.json"
        if not meta_path.is_file():
            raise HTTPException(400, "不是有效的 Profile 压缩包（缺少 profile.json）")
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        name = meta.get("name", "导入的 Profile") + " (导入)"
        new = profiles.create_profile(name, meta.get("base_config", "configuration_china.xml"), meta.get("description", ""))
        root = profiles.profile_dir(new["id"])
        cfg = Path(td) / "config.xml"
        if cfg.is_file():
            shutil.copy2(cfg, root / "config.xml")
        ov = Path(td) / "overlay"
        if ov.is_dir():
            shutil.copytree(ov, root / "overlay", dirs_exist_ok=True)
        return _ok(new)


@app.get("/api/profiles/{pid}/overlay")
def api_overlay(pid: str) -> dict[str, Any]:
    _require_profile(pid)
    return _ok(profiles.list_overlay(pid))


@app.post("/api/profiles/{pid}/snapshot")
def api_snapshot(pid: str, body: dict[str, Any] = Body(default={})) -> dict[str, Any]:
    _require_profile(pid)
    return _ok({"path": profiles.snapshot(pid, body.get("label", "manual"))})


@app.get("/api/profiles/{pid}/diff")
def api_profile_diff(pid: str, kind: str = "data", path: str = "") -> dict[str, Any]:
    _require_profile(pid)
    if not path:
        raise HTTPException(400, "path 不能为空")
    return _ok(files_svc.diff(pid, kind, path))


# --------------------------------------------------------------------------- catalog
@app.get("/api/catalog")
def api_catalog(force: bool = False) -> dict[str, Any]:
    return _ok(catalog_svc.build_catalog(force=force))


@app.get("/api/catalog/files")
def api_catalog_files(
    module: str = "",
    search: str = "",
    china_only: bool = False,
    modified: str = "",
) -> dict[str, Any]:
    cat = catalog_svc.build_catalog()
    items = cat["files"]
    if module:
        items = [f for f in items if f["module"] == module]
    if china_only:
        items = [f for f in items if f.get("china_relevant")]
    if search:
        s = search.lower()
        items = [
            f
            for f in items
            if s in f["path"].lower()
            or s in (f.get("title") or "").lower()
            or any(s in str(c).lower() for c in f.get("columns", []))
        ]
    if modified:
        prof = profiles.load_profile(modified)
        ov = {f"{o['kind']}:{o['path']}" for o in profiles.list_overlay(prof["id"])}
        items = [f for f in items if f"data:{f['path']}" in ov]
    return _ok(items)


@app.get("/api/catalog/xml")
def api_catalog_xml(kind: str = "", category: str = "", search: str = "", profile_id: str = "") -> dict[str, Any]:
    cat = catalog_svc.build_catalog()
    items = list(cat["xml"])
    if profile_id:
        _require_profile(profile_id)
        known = {item["id"] for item in items}
        for overlay in profiles.list_overlay(profile_id):
            file_kind, rel = overlay["kind"], overlay["path"]
            key = f"{file_kind}:{rel}"
            if file_kind in ("xml", "policy", "extra") and rel.lower().endswith(".xml") and key not in known:
                items.append({"id": key, "kind": file_kind, "path": rel, "name": Path(rel).stem,
                              "category": catalog_svc.classify_xml(Path(rel).name, file_kind),
                              "scenario_name": "", "size": overlay["size"]})
    if kind:
        items = [x for x in items if x["kind"] == kind]
    if category:
        items = [x for x in items if x["category"] == category]
    if search:
        s = search.lower()
        items = [x for x in items if s in x["name"].lower() or s in (x.get("scenario_name") or "").lower()]
    return _ok(items)


@app.get("/api/catalog/queries")
def api_catalog_queries() -> dict[str, Any]:
    cat = catalog_svc.build_catalog()
    flat = cat["queries"]
    return _ok({"flat": flat, "tree": catalog_svc.query_tree(flat), "count": len(flat)})


# --------------------------------------------------------------------------- files
@app.get("/api/files/info")
def api_file_info(profile_id: str, kind: str, path: str) -> dict[str, Any]:
    _require_profile(profile_id)
    return _ok(files_svc.info(profile_id, kind, path))


@app.get("/api/files/page")
def api_file_page(
    profile_id: str,
    kind: str,
    path: str,
    offset: int = 0,
    limit: int = 200,
    search: str = "",
    sort_by: str = "",
    sort_desc: bool = False,
    filters: str = "",
) -> dict[str, Any]:
    _require_profile(profile_id)
    try:
        f = json.loads(filters) if filters else {}
    except Exception:
        f = {}
    return _ok(
        files_svc.page(
            profile_id, kind, path, offset=offset, limit=limit, filters=f, search=search or None,
            sort_by=sort_by or None, sort_desc=sort_desc,
        )
    )


@app.patch("/api/files/cells")
def api_file_cells(body: dict[str, Any] = Body(...)) -> dict[str, Any]:
    pid = body["profile_id"]
    _require_profile(pid)
    _require_idle_profile(pid)
    try:
        return _ok(files_svc.edit_cells(pid, body["kind"], body["path"], body.get("edits", [])))
    except ValueError as exc:
        raise HTTPException(400, str(exc))


@app.post("/api/files/bulk")
def api_file_bulk(body: dict[str, Any] = Body(...)) -> dict[str, Any]:
    pid = body["profile_id"]
    _require_profile(pid)
    _require_idle_profile(pid)
    return _ok(
        files_svc.bulk(
            pid,
            body["kind"],
            body["path"],
            body["operation"],
            body["column"],
            value=body.get("value"),
            factor=body.get("factor"),
            filters=body.get("filters"),
            year_start=body.get("year_start"),
            year_end=body.get("year_end"),
        )
    )


@app.post("/api/files/revert")
def api_file_revert(body: dict[str, Any] = Body(...)) -> dict[str, Any]:
    pid = body["profile_id"]
    _require_profile(pid)
    _require_idle_profile(pid)
    files_svc.revert(pid, body["kind"], body["path"])
    return _ok()


@app.get("/api/files/export")
def api_file_export(profile_id: str, kind: str, path: str) -> FileResponse:
    _require_profile(profile_id)
    p = files_svc.export_path(profile_id, kind, path)
    if not p.is_file():
        raise HTTPException(404, "文件不存在")
    return FileResponse(str(p), filename=p.name)


@app.post("/api/files/import")
async def api_file_import(
    profile_id: str,
    kind: str,
    path: str,
    file: UploadFile = File(...),
) -> dict[str, Any]:
    _require_profile(profile_id)
    _require_idle_profile(profile_id)
    data = await file.read()
    return _ok(files_svc.import_file(profile_id, kind, path, data))


# --------------------------------------------------------------------------- XML / config
@app.get("/api/xml/content")
def api_xml_content(profile_id: str, kind: str, path: str) -> dict[str, Any]:
    _require_profile(profile_id)
    p, is_overlay = profiles.resolve_file(profile_id, kind, path)
    if not p.is_file():
        raise HTTPException(404, "文件不存在")
    text = p.read_text(encoding="utf-8", errors="replace")
    return _ok({"text": text, "is_overlay": is_overlay, "size": p.stat().st_size, "path": str(p)})


@app.put("/api/xml/content")
def api_xml_save(body: dict[str, Any] = Body(...)) -> dict[str, Any]:
    pid = body["profile_id"]
    _require_profile(pid)
    _require_idle_profile(pid)
    try:
        etree.fromstring(body["text"].encode("utf-8"))
    except etree.XMLSyntaxError as exc:
        raise HTTPException(400, f"XML 格式有误，未保存：{exc}") from exc
    ov = profiles.overlay_path(pid, body["kind"], body["path"])
    ov.parent.mkdir(parents=True, exist_ok=True)
    ov.write_text(body["text"], encoding="utf-8")
    # validate well-formedness
    try:
        etree.fromstring(body["text"].encode("utf-8"))
        valid = True
        error = ""
    except Exception as exc:
        valid = False
        error = str(exc)
    return _ok({"valid": valid, "error": error, "path": str(ov)})


@app.post("/api/xml/validate")
def api_xml_validate(body: dict[str, Any] = Body(...)) -> dict[str, Any]:
    try:
        etree.fromstring(body["text"].encode("utf-8"))
        return _ok({"valid": True})
    except Exception as exc:
        return _ok({"valid": False, "error": str(exc)})


@app.get("/api/profiles/{pid}/config")
def api_get_config(pid: str) -> dict[str, Any]:
    _require_profile(pid)
    p = profiles.profile_dir(pid) / "config.xml"
    tree = etree.parse(str(p))
    root = tree.getroot()
    out: dict[str, Any] = {"files": [], "components": [], "strings": [], "bools": [], "ints": [], "doubles": []}
    for v in root.findall("./Files/Value"):
        out["files"].append({"name": v.get("name", ""), "value": v.text or "", "write_output": v.get("write-output", ""), "append_scenario_name": v.get("append-scenario-name", "")})
    for v in root.findall("./ScenarioComponents/Value"):
        out["components"].append({"name": v.get("name", ""), "value": v.text or ""})
    for tag, key in (("Strings", "strings"), ("Bools", "bools"), ("Ints", "ints"), ("Doubles", "doubles")):
        for v in root.findall(f"./{tag}/Value"):
            out[key].append({"name": v.get("name", ""), "value": v.text or ""})
    return _ok(out)


@app.put("/api/profiles/{pid}/config")
def api_put_config(pid: str, body: dict[str, Any] = Body(...)) -> dict[str, Any]:
    _require_profile(pid)
    _require_idle_profile(pid)
    p = profiles.profile_dir(pid) / "config.xml"
    tree = etree.parse(str(p))
    root = tree.getroot()
    for v in root.findall("./Files/Value"):
        name = v.get("name", "")
        for item in body.get("files", []):
            if item.get("name") == name:
                v.text = item.get("value", "")
                if "write_output" in item:
                    v.set("write-output", str(item["write_output"]))
                if "append_scenario_name" in item:
                    v.set("append-scenario-name", str(item["append_scenario_name"]))
    comps = root.find("./ScenarioComponents")
    if comps is not None and "components" in body:
        for child in list(comps):
            comps.remove(child)
        for item in body["components"]:
            el = etree.SubElement(comps, "Value", name=item.get("name", ""))
            el.text = item.get("value", "")
    for tag, key in (("Strings", "strings"), ("Bools", "bools"), ("Ints", "ints"), ("Doubles", "doubles")):
        parent = root.find(f"./{tag}")
        if parent is None:
            parent = etree.SubElement(root, tag)
        for item in body.get(key, []):
            for v in parent.findall("Value"):
                if v.get("name") == item.get("name"):
                    v.text = str(item.get("value", ""))
                    break
    tree.write(str(p), encoding="UTF-8", xml_declaration=True, pretty_print=True)
    return _ok({"path": str(p)})


# --------------------------------------------------------------------------- builds / runs
def _list_builds(pid: str) -> list[dict[str, Any]]:
    root = profiles.profile_dir(pid) / "builds"
    out = []
    if root.is_dir():
        for d in sorted(root.iterdir(), key=lambda x: x.name, reverse=True):
            m = d / "manifest.json"
            if m.is_file():
                try:
                    data = json.loads(m.read_text(encoding="utf-8"))
                    data["build_dir"] = str(d)
                    out.append(data)
                except Exception:
                    pass
    return out


@app.get("/api/profiles/{pid}/builds")
def api_builds(pid: str) -> dict[str, Any]:
    _require_profile(pid)
    return _ok(_list_builds(pid))


@app.post("/api/profiles/{pid}/build")
def api_start_build(pid: str, body: dict[str, Any] = Body(default={})) -> dict[str, Any]:
    _require_profile(pid)

    def fn(job: jobs.Job) -> Any:
        job.log(f"开始生成 XML：{pid}")
        job.check_cancelled()
        return r_build.run_build(pid, log_fn=job.log, process_cb=job.register_process)

    job = jobs.MANAGER.submit("build", f"生成 XML · {pid}", fn, profile_id=pid)
    return _ok(job.to_dict())


@app.post("/api/profiles/{pid}/run")
def api_start_run(pid: str, body: dict[str, Any] = Body(default={})) -> dict[str, Any]:
    _require_profile(pid)
    for key in ("stop_year", "stop_period", "max_parallelism"):
        if body.get(key) is not None and (isinstance(body[key], bool) or not isinstance(body[key], int)):
            raise HTTPException(400, f"{key} 必须是整数。")
    if body.get("stop_year") is not None and not 1975 <= body["stop_year"] <= 2100:
        raise HTTPException(400, "停止年必须在 1975–2100 之间。")

    def fn(job: jobs.Job) -> Any:
        job.check_cancelled()
        build = None
        build_id = body.get("build_id")
        if build_id:
            for b in _list_builds(pid):
                if b.get("build_id") == build_id:
                    build = b
                    break
        job.check_cancelled()
        return gcam_run.run_gcam(
            pid,
            build=build,
            scenario_name=body.get("scenario_name") or "Reference",
            stop_year=body.get("stop_year"),
            stop_period=body.get("stop_period"),
            max_parallelism=body.get("max_parallelism"),
            fast_mode=bool(body.get("fast_mode")),
            log_fn=job.log,
            process_cb=job.register_process,
            dry_run=bool(body.get("dry_run")),
            rebuild=bool(body.get("rebuild")),
        )

    job = jobs.MANAGER.submit("run", f"运行 GCAM · {pid}", fn, profile_id=pid)
    return _ok(job.to_dict())


@app.get("/api/runs")
def api_runs(profile_id: str = "") -> dict[str, Any]:
    return _ok(gcam_run.list_runs(profile_id or None))


@app.get("/api/runs/{run_id}")
def api_run_detail(run_id: str) -> dict[str, Any]:
    try:
        data = gcam_run.find_run(run_id)
    except FileNotFoundError as exc:
        raise HTTPException(404, str(exc))
    data["results"] = list_rows("SELECT * FROM results WHERE run_id = ? ORDER BY created_at DESC", (run_id,))
    return _ok(data)


@app.get("/api/runs/{run_id}/results")
def api_run_results(run_id: str) -> dict[str, Any]:
    return _ok(list_rows("SELECT * FROM results WHERE run_id = ? ORDER BY created_at DESC", (run_id,)))


@app.post("/api/runs/{run_id}/query")
def api_run_query(run_id: str, body: dict[str, Any] = Body(...)) -> dict[str, Any]:
    try:
        run = gcam_run.find_run(run_id)
    except FileNotFoundError as exc:
        raise HTTPException(404, str(exc))
    query_ids = body.get("query_ids") or []
    name = body.get("name") or "查询结果"
    db_path = Path(run["db"]) if run.get("db") else None
    if run.get("status") != "success" or db_path is None or not db_path.is_dir() or not any(db_path.glob("*.basex")):
        raise HTTPException(400, "该运行尚未成功完成，或没有有效数据库。")

    def fn(job: jobs.Job) -> Any:
        result_id = f"{run_id}-{len(job.logs)}"
        job.check_cancelled()
        out_dir = Path(run["run_dir"]) / "results" / f"query-{uuid.uuid4().hex}"
        job.log(f"开始查询 {len(query_ids)} 条，数据库：{db_path}")
        res = queries.run_queries(run_id, db_path, query_ids, out_dir, log_fn=job.log,
                                  process_cb=job.register_process, stop_year=gcam_run.last_calculated_year(run))
        job.check_cancelled()
        result_id = f"{run_id}-{uuid.uuid4().hex[:12]}"
        with connect() as conn:
            conn.execute(
                "INSERT OR REPLACE INTO results(id,run_id,query_set_id,name,path,rows,created_at,meta) VALUES(?,?,?,?,?,?,?,?)",
                (result_id, run_id, body.get("query_set_id", ""), name, res["csv"], res["rows"], jobs.utcnow(), json.dumps(res, ensure_ascii=False)),
            )
        res["result_id"] = result_id
        return res

    job = jobs.MANAGER.submit("query", f"查询导出 · {run_id}", fn, profile_id=run["profile_id"])
    return _ok(job.to_dict())


# --------------------------------------------------------------------------- jobs
@app.get("/api/jobs")
def api_jobs() -> dict[str, Any]:
    return _ok(jobs.MANAGER.list())


@app.get("/api/jobs/{job_id}")
def api_job(job_id: str) -> dict[str, Any]:
    job = jobs.MANAGER.get(job_id)
    if not job:
        raise HTTPException(404, "任务不存在")
    return _ok(job.to_dict(include_logs=True))


@app.post("/api/jobs/{job_id}/cancel")
def api_job_cancel(job_id: str) -> dict[str, Any]:
    return _ok({"cancelled": jobs.MANAGER.cancel(job_id)})


@app.get("/api/jobs/{job_id}/events")
async def api_job_events(job_id: str, request: Request, after: int = -1):
    async def gen():
        idx = max(after + 1, int(request.headers.get("last-event-id", "-1")) + 1)
        while True:
            if await request.is_disconnected():
                break
            job = jobs.MANAGER.get(job_id)
            if not job:
                yield "event: error\ndata: not found\n\n"
                break
            idx, chunk = job.logs_since(idx)
            for line in chunk:
                event_id = idx
                idx += 1
                yield f"id: {event_id}\ndata: " + json.dumps({"line": line, "status": job.status, "progress": job.progress}, ensure_ascii=False) + "\n\n"
            if job.status in ("success", "failed", "cancelled"):
                if idx >= job.log_offset + len(job.logs):
                    yield "event: done\ndata: " + json.dumps(job.to_dict(), ensure_ascii=False) + "\n\n"
                    break
            await asyncio.sleep(0.4)

    return StreamingResponse(gen(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# --------------------------------------------------------------------------- results
@app.get("/api/results")
def api_results(run_id: str = "") -> dict[str, Any]:
    if run_id:
        return _ok(list_rows("SELECT * FROM results WHERE run_id = ? ORDER BY created_at DESC", (run_id,)))
    return _ok(list_rows("SELECT * FROM results ORDER BY created_at DESC"))


@app.get("/api/compare/results")
def api_compare_results(ids: str, section: str = "", group_by: str = "total") -> dict[str, Any]:
    result_ids = [x for x in ids.split(",") if x]
    if len(result_ids) < 2:
        raise HTTPException(400, "至少选择两个结果")
    items: list[dict[str, Any]] = []
    for rid in result_ids:
        row = get_row("SELECT * FROM results WHERE id = ?", (rid,))
        if row:
            items.append(row)
    if len(items) < 2:
        raise HTTPException(404, "结果记录不足")
    return _ok(queries.compare_result_files(items, section=section, group_by=group_by))


@app.get("/api/results/{result_id}/preview")
def api_result_preview(result_id: str, offset: int = 0, limit: int = 200) -> dict[str, Any]:
    row = get_row("SELECT * FROM results WHERE id = ?", (result_id,))
    if not row:
        raise HTTPException(404, "结果不存在")
    return _ok(queries.result_preview(Path(row["path"]), offset=offset, limit=limit))


@app.get("/api/results/{result_id}/download")
def api_result_download(result_id: str) -> FileResponse:
    row = get_row("SELECT * FROM results WHERE id = ?", (result_id,))
    if not row or not Path(row["path"]).is_file():
        raise HTTPException(404, "结果文件不存在")
    return FileResponse(row["path"], filename=Path(row["path"]).name)


@app.get("/api/results/{result_id}/export.xlsx")
def api_result_export_xlsx(result_id: str) -> FileResponse:
    row = get_row("SELECT * FROM results WHERE id = ?", (result_id,))
    if not row or not Path(row["path"]).is_file():
        raise HTTPException(404, "结果文件不存在")
    from openpyxl import Workbook

    rows = queries.parse_result_csv(Path(row["path"]))
    wb = Workbook(write_only=True)
    ws = wb.create_sheet("results")
    if rows:
        cols = [c for c in rows[0].keys() if c != "__section"]
        ws.append(cols)
        for r in rows:
            ws.append([r.get(c, "") for c in cols])
    out = Path(row["path"]).with_suffix(".xlsx")
    wb.save(out)
    return FileResponse(str(out), filename=out.name)
