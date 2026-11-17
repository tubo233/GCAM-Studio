"""Move Studio user data when the settings data directory changes.

``settings.json`` is not part of the payload. It stays in the bootstrap
directory so the next launch can still find the new ``data_dir``.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import sqlite3
from pathlib import Path
from urllib.parse import quote

PAYLOAD_NAMES = (
    "profiles",
    "cache",
    "logs",
    "studio.db",
    "studio.db-wal",
    "studio.db-shm",
)

_DB_COLUMNS = {
    "results": ("path", "meta"),
    "runs": ("config_path", "db_path", "log_path", "meta"),
    "profiles": ("meta",),
}


class DataMigrateError(ValueError):
    """Raised when a data-directory change must be refused or rolled back."""


def canonical(path: Path | str) -> str:
    return os.path.normcase(os.path.abspath(os.path.normpath(str(path))))


def same_data_dir(left: Path | str, right: Path | str) -> bool:
    return canonical(left) == canonical(right)


def _is_inside(child: Path, parent: Path) -> bool:
    child_key = canonical(child)
    parent_key = canonical(parent)
    if child_key == parent_key:
        return False
    prefix = parent_key if parent_key.endswith(os.sep) else parent_key + os.sep
    return child_key.startswith(prefix)


def _absolute(path: Path) -> str:
    return os.path.abspath(os.path.normpath(str(path))).rstrip("\\/")


def _slash_forms(path: Path) -> list[str]:
    absolute = _absolute(path)
    forms = [absolute.replace("/", "\\"), absolute.replace("\\", "/")]
    unique: list[str] = []
    seen: set[str] = set()
    for form in forms:
        if not form:
            continue
        key = form.casefold()
        if key in seen:
            continue
        seen.add(key)
        unique.append(form)
    return unique


def _form_pairs(old: Path, new: Path) -> list[tuple[str, str]]:
    old_forms = _slash_forms(old)
    new_forms = _slash_forms(new)
    if len(old_forms) != len(new_forms):
        return []
    return list(zip(old_forms, new_forms))


def rewrite_string(value: str, old: Path, new: Path) -> str:
    """Replace ``value`` when it is ``old`` or a path inside ``old``."""
    if not value:
        return value
    for old_form, new_form in _form_pairs(old, new):
        if len(value) < len(old_form):
            continue
        head = value[: len(old_form)]
        # normcase() also rewrites "/" to "\" on Windows, which would glue a
        # backslash prefix onto a forward-slash remainder.
        if head.casefold() != old_form.casefold():
            continue
        if len(value) == len(old_form) or value[len(old_form)] in "\\/":
            return new_form + value[len(old_form) :]
    return value


def replace_path_prefixes(text: str, old: Path, new: Path) -> str:
    for old_form, new_form in _form_pairs(old, new):
        pattern = re.compile(re.escape(old_form) + r"(?=$|[\\/])", re.IGNORECASE)

        def repl(match: re.Match[str], replacement: str = new_form) -> str:
            return replacement

        text = pattern.sub(repl, text)
    return text


def _rewrite_obj(value: object, old: Path, new: Path) -> object:
    if isinstance(value, str):
        return rewrite_string(value, old, new)
    if isinstance(value, list):
        return [_rewrite_obj(item, old, new) for item in value]
    if isinstance(value, dict):
        return {key: _rewrite_obj(item, old, new) for key, item in value.items()}
    return value


def _rewrite_cell(value: object, old: Path, new: Path) -> object:
    if not isinstance(value, str) or not value:
        return value
    stripped = value.lstrip()
    if stripped.startswith("{") or stripped.startswith("["):
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return replace_path_prefixes(value, old, new)
        return json.dumps(_rewrite_obj(parsed, old, new), ensure_ascii=False)
    return rewrite_string(value, old, new)


def _rewrite_json_file(path: Path, old: Path, new: Path) -> None:
    raw = path.read_text(encoding="utf-8")
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        updated = replace_path_prefixes(raw, old, new)
        if updated != raw:
            path.write_text(updated, encoding="utf-8")
        return
    rewritten = _rewrite_obj(data, old, new)
    if rewritten == data:
        return
    path.write_text(json.dumps(rewritten, ensure_ascii=False, indent=2), encoding="utf-8")


def _rewrite_text_file(path: Path, old: Path, new: Path) -> None:
    raw = path.read_text(encoding="utf-8")
    updated = replace_path_prefixes(raw, old, new)
    if updated != raw:
        path.write_text(updated, encoding="utf-8")


def _rewrite_sqlite(path: Path, old: Path, new: Path) -> None:
    conn = sqlite3.connect(path)
    try:
        tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        for table, columns in _DB_COLUMNS.items():
            if table not in tables:
                continue
            present = {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}
            if "id" not in present:
                continue
            use = [column for column in columns if column in present]
            if not use:
                continue
            rows = conn.execute(f"SELECT id, {', '.join(use)} FROM {table}").fetchall()
            for row in rows:
                changed: dict[str, object] = {}
                for index, column in enumerate(use, start=1):
                    updated = _rewrite_cell(row[index], old, new)
                    if updated != row[index]:
                        changed[column] = updated
                if not changed:
                    continue
                assignments = ", ".join(f"{column}=?" for column in changed)
                conn.execute(
                    f"UPDATE {table} SET {assignments} WHERE id=?",
                    [*changed.values(), row[0]],
                )
        conn.commit()
    finally:
        conn.close()


def _rewrite_tree(root: Path, old: Path, new: Path) -> None:
    profiles = root / "profiles"
    if profiles.is_dir():
        for dirpath, dirnames, filenames in os.walk(profiles):
            dirnames[:] = [name for name in dirnames if name != "database_basexdb"]
            for name in filenames:
                file_path = Path(dirpath) / name
                if name == "manifest.json":
                    _rewrite_json_file(file_path, old, new)
                elif name == "configuration.xml":
                    _rewrite_text_file(file_path, old, new)
    database = root / "studio.db"
    if database.is_file():
        _rewrite_sqlite(database, old, new)


def _same_volume(left: Path, right: Path) -> bool:
    return os.path.splitdrive(canonical(left))[0] == os.path.splitdrive(canonical(right))[0]


def _remove(path: Path) -> None:
    if path.is_dir():
        shutil.rmtree(path)
    elif path.exists():
        path.unlink()


def _relocate(src: Path, dst: Path) -> str:
    if _same_volume(src, dst):
        shutil.move(str(src), str(dst))
        return "move"
    try:
        if src.is_dir():
            shutil.copytree(src, dst)
        else:
            shutil.copy2(src, dst)
    except Exception:
        if dst.is_dir():
            shutil.rmtree(dst, ignore_errors=True)
        elif dst.exists():
            dst.unlink()
        raise
    return "copy"


def _verified(src: Path, dst: Path) -> None:
    if not dst.exists():
        raise DataMigrateError(f"复制后缺少目标：{dst}")
    if src.is_file() and dst.is_file() and src.stat().st_size != dst.stat().st_size:
        raise DataMigrateError(f"复制后大小不一致：{dst.name}")


def _restore_copy(src: Path, dst: Path) -> None:
    if src.exists() or not dst.exists():
        return
    if dst.is_dir():
        shutil.copytree(dst, src)
    else:
        src.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(dst, src)


def _commit_copies(moved: list[tuple[Path, Path, str]]) -> None:
    removed: list[tuple[Path, Path]] = []
    try:
        for src, dst, method in moved:
            if method != "copy":
                continue
            _verified(src, dst)
            _remove(src)
            removed.append((src, dst))
    except Exception:
        restore_failed = False
        for src, dst in reversed(removed):
            try:
                _restore_copy(src, dst)
            except Exception:
                restore_failed = True
        if restore_failed:
            raise DataMigrateError("迁移失败，且未能把已复制的数据移回原目录。")
        raise


def _rollback(moved: list[tuple[Path, Path, str]]) -> None:
    for src, dst, method in reversed(moved):
        try:
            if method == "move":
                if dst.exists() and not src.exists():
                    src.parent.mkdir(parents=True, exist_ok=True)
                    shutil.move(str(dst), str(src))
                continue
            if not src.exists() and dst.exists():
                continue
            if dst.is_dir():
                shutil.rmtree(dst)
            elif dst.exists():
                dst.unlink()
        except Exception:
            continue


def _contains_file(path: Path) -> bool:
    if path.is_file():
        return path.stat().st_size > 0
    if not path.is_dir():
        return False
    for _, _, filenames in os.walk(path):
        if filenames:
            return True
    return False


def _db_has_rows(path: Path) -> bool:
    """True when studio.db holds profiles, runs, or query results.

    ``init_db()`` creates an empty schema file on startup. That file must not
    block a later switch onto a directory that already has real Studio data.
    """
    if not path.is_file():
        return False
    uri = "file:///" + quote(path.resolve().as_posix(), safe="/:") + "?mode=ro"
    try:
        conn = sqlite3.connect(uri, uri=True)
    except sqlite3.Error:
        return True
    try:
        tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        for table in ("profiles", "runs", "results"):
            if table not in tables:
                continue
            count = conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()
            if count and count[0]:
                return True
        return False
    except sqlite3.Error:
        return True
    finally:
        conn.close()


def _real_payload(root: Path) -> list[str]:
    names: list[str] = []
    for name in ("profiles", "cache", "logs"):
        if _contains_file(root / name):
            names.append(name)
    if _db_has_rows(root / "studio.db"):
        names.append("studio.db")
        for extra in ("studio.db-wal", "studio.db-shm"):
            if (root / extra).exists():
                names.append(extra)
    return names


def _destination_blocks(path: Path) -> bool:
    if path.name == "studio.db":
        return _db_has_rows(path)
    return _contains_file(path)


def migrate_data_dir(old: Path | str, new: Path | str) -> dict[str, str] | None:
    """Move Studio payload from ``old`` to ``new``.

    Returns ``{"from", "to"}`` when something was moved. Returns ``None`` when
    the paths are the same or the old directory has no payload. Raises
    ``DataMigrateError`` without changing ``old`` when the move is refused or
    fails after rollback.
    """
    old_path = Path(old)
    new_path = Path(new)
    if same_data_dir(old_path, new_path):
        return None
    if _is_inside(new_path, old_path) or _is_inside(old_path, new_path):
        raise DataMigrateError("新数据目录不能放在当前数据目录里面，当前数据目录也不能放在新目录里面。")
    if old_path.exists() and not old_path.is_dir():
        raise DataMigrateError("当前数据目录不是文件夹。")
    if new_path.exists() and not new_path.is_dir():
        raise DataMigrateError("目标路径不是文件夹。")
    if not old_path.is_dir():
        return None
    payload = _real_payload(old_path)
    if not payload:
        return None
    if new_path.exists():
        blocked = [name for name in payload if _destination_blocks(new_path / name)]
        if blocked:
            raise DataMigrateError(f"目标目录已有数据（{'、'.join(blocked)}），请换一个空目录。")

    new_path.mkdir(parents=True, exist_ok=True)
    for name in payload:
        dst = new_path / name
        if dst.exists():
            _remove(dst)
    moved: list[tuple[Path, Path, str]] = []
    try:
        for name in payload:
            src = old_path / name
            dst = new_path / name
            method = _relocate(src, dst)
            moved.append((src, dst, method))
        _rewrite_tree(new_path, old_path, new_path)
        _commit_copies(moved)
    except DataMigrateError:
        _rollback(moved)
        raise
    except Exception as exc:
        _rollback(moved)
        raise DataMigrateError(f"迁移数据目录失败：{exc}") from exc
    return {"from": str(old_path), "to": str(new_path)}
