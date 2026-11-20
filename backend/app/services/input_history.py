"""Compare the current effective inputs with the last process launched for this profile."""

from __future__ import annotations

import json
from itertools import islice
import shutil
import sqlite3
import tempfile
import uuid
from pathlib import Path

from lxml import etree

from ..config import PATHS
from . import r_build, csv_engine, parameter_editor as editor, profiles, scenario_config


def _blob(checksum, source):
    # Keep extensions for compressed CSV readers. Copies are never linked to editable sources.
    suffix = (
        ".csv.gz" if source.lower().endswith(".csv.gz") else Path(source).suffix.lower()
    )
    return PATHS.data / "input-history" / checksum[:2] / (checksum + suffix)


def data_files(pid):
    result = {}
    for base in (PATHS.extdata, profiles.overlay_root(pid) / "gcamdata"):
        for path in base.rglob("*"):
            if path.is_file() and path.suffix.lower() in (".csv", ".gz", ".xlsx"):
                result["data/" + path.relative_to(base).as_posix()] = path
    return result


def state(pid, *, build_dir=None, capture=False, actual=None):
    root = scenario_config.parse_config(
        (profiles.profile_dir(pid) / "config.xml").read_bytes()
    )
    files = (
        editor.sources(pid, build_dir=build_dir, include_auxiliary=True)
        if actual is None
        else actual["files"]
    )
    selected = [
        editor.file_key(n.text)
        for n in root.findall("ScenarioComponents/Value")
        if n.text
    ]
    paths = {**files, **data_files(pid)}
    hashes = {}
    for key, path in paths.items():
        checksum = editor.digest(path) if path.is_file() else ""
        hashes[key] = checksum
        if capture and checksum:
            blob = _blob(checksum, key)
            if not blob.is_file():
                blob.parent.mkdir(parents=True, exist_ok=True)
                tmp = blob.with_suffix("." + uuid.uuid4().hex + ".tmp")
                try:
                    shutil.copyfile(path, tmp)
                    if editor.digest(tmp) != checksum:
                        raise ValueError(f"输入文件在启动时发生变化：{path.name}")
                    tmp.replace(blob)
                finally:
                    tmp.unlink(missing_ok=True)
    config = editor.config_values(root) if actual is None else actual["config"]
    if actual is not None:
        selected = actual["order"]
    return {"files": hashes, "order": selected, "config": config}, paths


def capture(pid, directory, actual):
    snapshot, _ = state(pid, capture=True, actual=actual)
    scenario_config.write_config(
        directory / "input-snapshot.json",
        json.dumps(snapshot, ensure_ascii=False).encode(),
    )


def reference(pid):
    from .gcam_run import list_runs

    for run in list_runs(pid):
        if run.get("model_started_at") or (
            "snapshot_version" not in run
            and (run.get("exit_code") is not None or run.get("current_year"))
        ):
            snapshot = Path(run["run_dir"]) / "input-snapshot.json"
            return (
                {
                    k: run.get(k)
                    for k in ("run_id", "created_at", "model_started_at", "status")
                },
                json.loads(snapshot.read_bytes()) if snapshot.is_file() else None,
            )
    return None, None


def comparison(pid):
    ref, previous = reference(pid)
    files = editor.sources(pid, materialize=False)
    build = r_build.latest_build(pid)
    pending = (
        r_build.build_is_stale(pid, build) if build else r_build.has_data_overlay(pid)
    )
    summaries = editor.summaries(files)
    result = {
        "policy_summaries": summaries,
        "pending": pending,
        "reference": ref,
        "recorded": previous is not None,
        "sources": list(files),
        "changes": [],
    }
    if previous is None:
        result["custom"] = list(editor.edits(pid)) + [
            p.relative_to(profiles.overlay_root(pid)).as_posix()
            for p in profiles.overlay_root(pid).rglob("*")
            if p.is_file() and p != editor.edit_file(pid)
        ]
        return result
    current, _ = state(pid)
    changes = result["changes"]
    for key in dict.fromkeys([*current["files"], *previous["files"]]):
        old, new = previous["files"].get(key), current["files"].get(key)
        if old != new:
            entry = {
                "source": key,
                "type": "新增" if old is None else "停用" if new is None else "修改",
                "summary": summaries.get(key, ""),
            }
            if (
                key in summaries
                and old
                and new
                and files[key].stat().st_size <= 250_000
            ):
                try:
                    preview = detail(pid, key, 0, 1)
                    if not preview["more"] and preview["rows"]:
                        entry["single"] = preview["rows"][0]
                except ValueError as exc:
                    entry["summary"] = str(exc)
            changes.append(entry)
    common = set(previous["order"]) & set(current["order"])
    if [k for k in previous["order"] if k in common] != [
        k for k in current["order"] if k in common
    ]:
        changes.append(
            {
                "source": "组件加载顺序",
                "type": "调整",
                "before": " → ".join(map(lambda k: Path(k).name, previous["order"])),
                "after": " → ".join(Path(k).name for k in current["order"]),
            }
        )
    for key in current["config"].keys() | previous["config"].keys():
        old, new = previous["config"].get(key), current["config"].get(key)
        if old != new:
            changes.append({"source": key, "type": "配置", "before": old, "after": new})
    return result


def detail(pid, source, offset, limit):
    _, previous = reference(pid)
    old_hash = (previous or {}).get("files", {}).get(source)
    before = _blob(old_hash, source) if old_hash else None
    paths = (
        data_files(pid)
        if source.startswith("data/")
        else editor.sources(pid, include_auxiliary=True)
    )
    after = paths.get(source)
    if before and not before.is_file():
        raise ValueError("上次值未记录")
    if source not in paths and not before:
        raise ValueError("找不到此项输入")
    if source.lower().endswith((".csv", ".csv.gz")) and before and after:
        a, b = csv_engine.read_header(before), csv_engine.read_header(after)
        diffs = csv_engine.diff_frames(
            csv_engine.read_dataframe(before, a),
            csv_engine.read_dataframe(after, b),
            a.key_columns,
            offset + limit + 1,
        )
        result = [
            {
                "label": r.get("summary")
                or " · ".join([*map(str, r.get("key", {}).values()), r["column"]]),
                "before": r.get("old"),
                "after": r.get("new"),
            }
            for r in diffs
        ]
        return {
            "rows": result[offset : offset + limit],
            "more": len(result) > offset + limit,
        }
    if not source.lower().endswith(".xml"):
        return {"rows": [], "more": False}

    def items(path):
        if path and path.is_file():
            yield from ((k, row) for k, _, row in editor.file_rows(path))

    try:

        def differences():
            if not before:
                for _, row in items(after):
                    yield dict(row, before=None, after=row["value"])
                return
            if not after:
                for _, row in items(before):
                    yield dict(row, before=row["value"], after=None)
                return
            if before.stat().st_size < 16_000_000:
                old = dict(items(before))
                for key, row in items(after):
                    prior = old.pop(key, None)
                    if prior != row:
                        yield dict(
                            row, before=prior and prior["value"], after=row["value"]
                        )
                for row in old.values():
                    yield dict(row, before=row["value"], after=None)
                return
            # Some China sector files are hundreds of MB. Spill old cells to disk.
            with tempfile.TemporaryDirectory() as work:
                db = sqlite3.connect(str(Path(work) / "cells.sqlite"))
                try:
                    db.execute(
                        "CREATE TABLE cells(id TEXT PRIMARY KEY, data TEXT) WITHOUT ROWID"
                    )
                    db.executemany(
                        "INSERT INTO cells VALUES (?,?)",
                        ((k, json.dumps(v)) for k, v in items(before)),
                    )
                    for key, row in items(after):
                        record = db.execute(
                            "SELECT data FROM cells WHERE id=?", (key,)
                        ).fetchone()
                        prior = json.loads(record[0]) if record else None
                        if record:
                            db.execute("DELETE FROM cells WHERE id=?", (key,))
                        if prior != row:
                            yield dict(
                                row, before=prior and prior["value"], after=row["value"]
                            )
                    for (raw,) in db.execute("SELECT data FROM cells"):
                        row = json.loads(raw)
                        yield dict(row, before=row["value"], after=None)
                finally:
                    db.close()

        result = list(islice(differences(), offset, offset + limit + 1))
    except etree.XMLSyntaxError as exc:
        raise ValueError(f"可在 XML 源码中查看此文件：{exc.msg}") from exc
    return {"rows": result[:limit], "more": len(result) > limit}
