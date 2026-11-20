from __future__ import annotations

import json
import re
import shutil
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ..config import PATHS, SETTINGS
from . import scenario_config
from ..db import connect, get_row, list_rows, row_to_dict, utcnow


def slugify(name: str) -> str:
    # Keep ids ASCII-only: GCAM/Java cannot reliably open paths with Chinese names.
    s = re.sub(r"[^0-9a-zA-Z_-]+", "-", name.strip()).strip("-").lower()
    return s or f"profile-{uuid.uuid4().hex[:8]}"


def profile_dir(profile_id: str) -> Path:
    if not re.fullmatch(r"[A-Za-z0-9_-]+", profile_id or ""):
        raise ValueError("Profile id 只能包含英文字母、数字、下划线和连字符。")
    return PATHS.profiles / profile_id


def load_profile(profile_id: str) -> dict[str, Any]:
    pid = profile_id
    # Accept profile name as well as id
    d = profile_dir(profile_id)
    if not d.is_dir():
        row = get_row("SELECT id FROM profiles WHERE name = ? OR id = ?", (profile_id, profile_id))
        if row:
            pid = row["id"]
            d = profile_dir(pid)
    meta_path = d / "profile.json"
    if not meta_path.is_file():
        raise FileNotFoundError(f"Profile not found: {profile_id}")
    data = json.loads(meta_path.read_text(encoding="utf-8"))
    data["id"] = pid
    return data


def save_profile(meta: dict[str, Any]) -> None:
    d = profile_dir(meta["id"])
    d.mkdir(parents=True, exist_ok=True)
    meta["updated_at"] = utcnow()
    (d / "profile.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    with connect() as conn:
        conn.execute(
            """INSERT INTO profiles(id,name,description,base_config,created_at,updated_at,tags,notes,meta)
               VALUES(?,?,?,?,?,?,?,?,?)
               ON CONFLICT(id) DO UPDATE SET name=excluded.name, description=excluded.description,
                 base_config=excluded.base_config, updated_at=excluded.updated_at,
                 tags=excluded.tags, notes=excluded.notes, meta=excluded.meta""",
            (
                meta["id"], meta.get("name", meta["id"]), meta.get("description", ""),
                meta.get("base_config", ""), meta.get("created_at", utcnow()), meta.get("updated_at"),
                json.dumps(meta.get("tags", []), ensure_ascii=False),
                meta.get("notes", ""), json.dumps(meta, ensure_ascii=False),
            ),
        )


def list_profiles() -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    if not PATHS.profiles.is_dir():
        return out
    for d in sorted(PATHS.profiles.iterdir()):
        p = d / "profile.json"
        if not p.is_file():
            continue
        try:
            meta = json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            continue
        meta["id"] = d.name
        meta["overlay_files"] = count_overlay_files(d.name)
        meta["builds"] = len(list((d / "builds").glob("*"))) if (d / "builds").is_dir() else 0
        meta["runs"] = len(list((d / "runs").glob("*"))) if (d / "runs").is_dir() else 0
        out.append(meta)
    return out


def count_overlay_files(profile_id: str) -> int:
    root = profile_dir(profile_id) / "overlay"
    if not root.is_dir():
        return 0
    return sum(1 for p in root.rglob("*") if p.is_file())


def create_profile(name: str, template: str = "configuration_china.xml", description: str = "", *,
                   config_bytes: bytes | None = None) -> dict[str, Any]:
    if Path(template).name != template or "/" in template or "\\" in template:
        raise ValueError("配置模板必须是模型 exe 目录中的文件名。")
    base = PATHS.exe_dir / template
    if config_bytes is None and not base.is_file():
        # allow bare names
        alt = PATHS.exe_dir / f"configuration_{template}.xml"
        if alt.is_file():
            base = alt
        else:
            raise FileNotFoundError(f"Configuration template not found: {template}")
    from_archive = config_bytes is not None
    config_bytes, repairs = scenario_config.imported_config(config_bytes if from_archive else base.read_bytes())
    if from_archive:
        config_bytes, _ = scenario_config.portable_import(config_bytes, PATHS.root)
    pid = slugify(name)
    # ensure unique
    if profile_dir(pid).exists():
        pid = f"{pid}-{uuid.uuid4().hex[:4]}"
    d = profile_dir(pid)
    for sub in ("overlay", "builds", "runs", "snapshots"):
        (d / sub).mkdir(parents=True, exist_ok=True)
    (d / "config.xml").write_bytes(config_bytes)
    meta = {
        "id": pid,
        "name": name,
        "description": description,
        "base_config": base.name,
        "config_repairs": repairs,
        "created_at": utcnow(),
        "updated_at": utcnow(),
        "tags": [],
        "notes": "",
        "config_file": "config.xml",
        "active": False,
    }
    save_profile(meta)
    return meta


def clone_profile(profile_id: str, new_name: str) -> dict[str, Any]:
    src = load_profile(profile_id)
    src_dir = profile_dir(src["id"])
    pid = slugify(new_name)
    if profile_dir(pid).exists():
        pid = f"{pid}-{uuid.uuid4().hex[:4]}"
    dst = profile_dir(pid)
    dst.mkdir(parents=True, exist_ok=True)
    for sub in ("overlay", "builds", "runs", "snapshots"):
        s = src_dir / sub
        if sub == "overlay" and s.is_dir():
            shutil.copytree(s, dst / sub, dirs_exist_ok=True)
        else:
            (dst / sub).mkdir(parents=True, exist_ok=True)
    shutil.copy2(src_dir / "config.xml", dst / "config.xml")
    meta = dict(src)
    meta.update(
        {
            "id": pid,
            "name": new_name,
            "created_at": utcnow(),
            "updated_at": utcnow(),
            "cloned_from": src["id"],
        }
    )
    save_profile(meta)
    return meta


def delete_profile(profile_id: str) -> None:
    d = profile_dir(profile_id)
    if d.is_dir():
        shutil.rmtree(d)
    with connect() as conn:
        conn.execute("DELETE FROM profiles WHERE id = ?", (profile_id,))


def set_active(profile_id: str) -> None:
    with connect() as conn:
        conn.execute("UPDATE profiles SET meta = json_set(meta, '$.active', 0)")
        conn.execute("UPDATE profiles SET meta = json_set(meta, '$.active', 1) WHERE id = ?", (profile_id,))


def overlay_root(profile_id: str) -> Path:
    return profile_dir(profile_id) / "overlay"


def overlay_path(profile_id: str, kind: str, rel: str) -> Path:
    """Overlay path for kind in {data, xml, policy, extra}."""
    mapping = {
        "data": Path("gcamdata"),
        "xml": Path("xml"),
        "policy": Path("policy"),
        "extra": Path("extra"),
    }
    if kind not in mapping:
        raise ValueError(f"未知文件类型：{kind}")
    return safe_relative(overlay_root(profile_id) / mapping[kind], rel)


def safe_relative(base: Path, rel: str) -> Path:
    raw = str(rel).replace("\\", "/")
    path = Path(raw)
    if not raw or path.is_absolute() or path.drive or ".." in path.parts or ":" in raw:
        raise ValueError("文件名必须是工作目录内的相对路径。")
    target = (base / path).resolve()
    if target == base.resolve() or not target.is_relative_to(base.resolve()):
        raise ValueError("文件路径超出工作目录。")
    return target


def source_path(kind: str, rel: str) -> Path:
    if kind == "data":
        return safe_relative(PATHS.extdata, rel)
    if kind == "xml":
        return safe_relative(PATHS.baseline_xml, rel)
    if kind == "policy":
        return safe_relative(PATHS.policy_dir, rel)
    if kind == "extra":
        return safe_relative(PATHS.extra_dir, rel)
    raise ValueError(f"Unknown kind: {kind}")


def resolve_file(profile_id: str, kind: str, rel: str) -> tuple[Path, bool]:
    """Return (path, is_overlay). Prefer the profile overlay if present."""
    ov = overlay_path(profile_id, kind, rel)
    if ov.is_file():
        return ov, True
    return source_path(kind, rel), False


def ensure_overlay(profile_id: str, kind: str, rel: str) -> Path:
    ov = overlay_path(profile_id, kind, rel)
    if ov.is_file():
        return ov
    src = source_path(kind, rel)
    if not src.is_file():
        raise FileNotFoundError(str(src))
    ov.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, ov)
    return ov


def revert_file(profile_id: str, kind: str, rel: str) -> None:
    ov = overlay_path(profile_id, kind, rel)
    if ov.is_file():
        ov.unlink()


def list_overlay(profile_id: str) -> list[dict[str, Any]]:
    root = overlay_root(profile_id)
    out: list[dict[str, Any]] = []
    if not root.is_dir():
        return out
    for p in root.rglob("*"):
        if not p.is_file():
            continue
        rel = p.relative_to(root)
        kind = rel.parts[0] if rel.parts else ""
        kind_map = {"gcamdata": "data", "xml": "xml", "policy": "policy", "extra": "extra"}
        out.append(
            {
                "kind": kind_map.get(kind, kind),
                "path": str(Path(*rel.parts[1:])).replace("\\", "/") if len(rel.parts) > 1 else "",
                "size": p.stat().st_size,
                "mtime": p.stat().st_mtime,
            }
        )
    return out


def snapshot(profile_id: str, label: str = "auto") -> str:
    d = profile_dir(profile_id) / "snapshots" / f"{datetime.now().strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:4]}"
    d.mkdir(parents=True, exist_ok=True)
    src = overlay_root(profile_id)
    if src.is_dir():
        shutil.copytree(src, d / "overlay", dirs_exist_ok=True)
    shutil.copy2(profile_dir(profile_id) / "config.xml", d / "config.xml")
    (d / "snapshot.json").write_text(json.dumps({"label": label, "created_at": utcnow()}, ensure_ascii=False), encoding="utf-8")
    return str(d)
