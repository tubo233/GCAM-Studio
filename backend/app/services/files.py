from __future__ import annotations

import io
import json
import math
import shutil
from pathlib import Path
from typing import Any

import pandas as pd

from ..config import PATHS
from . import csv_engine, profiles

_CACHE: dict[tuple[str, float, int], tuple[pd.DataFrame, csv_engine.CsvHeader]] = {}
_CACHE_LIMIT = 24


def _validate_numbers(df, header) -> None:
    for column, kind in csv_engine.detect_types(df, header).items():
        if kind not in ("integer", "number"):
            continue
        for raw in df[column]:
            if str(raw).strip() in ("", "NA"):
                continue
            try:
                number = float(raw)
            except (TypeError, ValueError) as exc:
                raise ValueError(f"列 {column} 需要数值：{raw}") from exc
            if not math.isfinite(number) or (kind == "integer" and not number.is_integer()):
                raise ValueError(f"列 {column} 的数值无效：{raw}")


def _cache_get(path: Path, header: csv_engine.CsvHeader) -> pd.DataFrame:
    key = (str(path), path.stat().st_mtime, path.stat().st_size)
    if key in _CACHE:
        return _CACHE[key][0].copy()
    df = csv_engine.read_dataframe(path, header)
    if len(_CACHE) >= _CACHE_LIMIT:
        _CACHE.pop(next(iter(_CACHE)))
    _CACHE[key] = (df, header)
    return df.copy()


def _cache_put(path: Path, header: csv_engine.CsvHeader, df: pd.DataFrame) -> None:
    key = (str(path), path.stat().st_mtime, path.stat().st_size)
    _CACHE[key] = (df.copy(), header)


def info(profile_id: str, kind: str, rel: str) -> dict[str, Any]:
    path, is_overlay = profiles.resolve_file(profile_id, kind, rel)
    h = csv_engine.read_header(path)
    df = _cache_get(path, h)
    base = profiles.source_path(kind, rel)
    out = {
        "kind": kind,
        "path": rel,
        "resolved_path": str(path),
        "is_overlay": is_overlay,
        "title": h.title,
        "units": h.units,
        "description": h.description,
        "column_types": csv_engine.detect_types(df, h),
        "columns": list(df.columns),
        "key_columns": [c for c in h.key_columns if c in df.columns],
        "year_columns": [c for c in h.year_columns if c in df.columns],
        "long_format": h.is_long,
        "rows": len(df),
        "size": path.stat().st_size,
        "mtime": path.stat().st_mtime,
        "diff_count": len(diff(profile_id, kind, rel, max_rows=100000)) if is_overlay and base.is_file() else 0,
    }
    return out


def page(
    profile_id: str,
    kind: str,
    rel: str,
    offset: int = 0,
    limit: int = 200,
    filters: dict[str, Any] | None = None,
    search: str | None = None,
    sort_by: str | None = None,
    sort_desc: bool = False,
) -> dict[str, Any]:
    path, _ = profiles.resolve_file(profile_id, kind, rel)
    h = csv_engine.read_header(path)
    df = _cache_get(path, h)
    return csv_engine.page_frame(df, offset=offset, limit=limit, filters=filters, search=search, sort_by=sort_by, sort_desc=sort_desc)


def edit_cells(profile_id: str, kind: str, rel: str, edits: list[dict[str, Any]]) -> dict[str, Any]:
    """edits: [{row: <original dataframe index>, column: str, value: str}]"""
    ov = profiles.ensure_overlay(profile_id, kind, rel)
    h = csv_engine.read_header(ov)
    df = _cache_get(ov, h)
    types = csv_engine.detect_types(df, h)
    changed = 0
    for e in edits:
        try:
            row = int(e["row"])
            col = str(e["column"])
        except Exception:
            continue
        if col not in df.columns or row < 0 or row >= len(df):
            continue
        value = str(e.get("value", ""))
        ctype = types.get(col, "string")
        if value.strip() and value.strip() != "NA":
            if ctype == "integer":
                try:
                    f = float(value)
                    if not f.is_integer():
                        raise ValueError(f"列 {col} 是整数列，不能填小数：{value}")
                except ValueError:
                    raise
            elif ctype == "number":
                try:
                    if not math.isfinite(float(value)):
                        raise ValueError(f"列 {col} 需要有限数值，不能填 NaN 或 Infinity。")
                except ValueError:
                    raise ValueError(f"列 {col} 是数值列，无法解析：{value}")
        if str(df.iat[row, df.columns.get_loc(col)]) != value:
            df.iat[row, df.columns.get_loc(col)] = value
            changed += 1
    if changed:
        _validate_numbers(df, h)
        csv_engine.write_dataframe(ov, df, h)
        _cache_put(ov, h, df)
    return {"changed": changed, "rows": len(df)}


def bulk(
    profile_id: str,
    kind: str,
    rel: str,
    operation: str,
    column: str,
    value: float | str | None = None,
    factor: float | None = None,
    filters: dict[str, Any] | None = None,
    year_start: int | None = None,
    year_end: int | None = None,
) -> dict[str, Any]:
    ov = profiles.ensure_overlay(profile_id, kind, rel)
    h = csv_engine.read_header(ov)
    df = _cache_get(ov, h)
    if column not in df.columns:
        raise ValueError(f"列不存在：{column}")
    mask = pd.Series([True] * len(df), index=df.index)
    for col, val in (filters or {}).items():
        if col in df.columns and val not in (None, "", []):
            if isinstance(val, list):
                mask &= df[col].isin([str(v) for v in val])
            else:
                mask &= df[col].astype(str) == str(val)
    col_idx = df.columns.get_loc(column)
    changed = 0
    if operation == "set":
        for i in df.index[mask]:
            if str(df.iat[i, col_idx]) != str(value):
                df.iat[i, col_idx] = str(value)
                changed += 1
    elif operation == "scale":
        f = float(factor if factor is not None else value or 1.0)
        for i in df.index[mask]:
            raw = str(df.iat[i, col_idx]).strip()
            if raw == "":
                continue
            try:
                new = float(raw) * f
            except ValueError:
                continue
            df.iat[i, col_idx] = format(new, ".12g")
            changed += 1
    elif operation == "interpolate":
        years = sorted([c for c in df.columns if csv_engine.YEAR_RE.match(str(c))], key=int)
        for i in df.index[mask]:
            vals: list[tuple[int, float]] = []
            for y in years:
                raw = str(df.iat[i, df.columns.get_loc(y)]).strip()
                if raw:
                    try:
                        vals.append((int(y), float(raw)))
                    except ValueError:
                        pass
            if len(vals) >= 2:
                for y in years:
                    yi = int(y)
                    if yi < (year_start or 0) or yi > (year_end or 9999):
                        continue
                    if str(df.iat[i, df.columns.get_loc(y)]).strip():
                        continue
                    lo = max([v for v in vals if v[0] < yi], default=None)
                    hi = min([v for v in vals if v[0] > yi], default=None)
                    if lo and hi:
                        frac = (yi - lo[0]) / (hi[0] - lo[0])
                        df.iat[i, df.columns.get_loc(y)] = format(lo[1] + (hi[1] - lo[1]) * frac, ".12g")
                        changed += 1
    else:
        raise ValueError(f"未知操作：{operation}")
    if changed:
        _validate_numbers(df, h)
        csv_engine.write_dataframe(ov, df, h)
        _cache_put(ov, h, df)
    return {"changed": changed}


def diff(profile_id: str, kind: str, rel: str, max_rows: int = 5000) -> list[dict[str, Any]]:
    ov = profiles.overlay_path(profile_id, kind, rel)
    base = profiles.source_path(kind, rel)
    if not ov.is_file() or not base.is_file():
        return []
    h1 = csv_engine.read_header(base)
    h2 = csv_engine.read_header(ov)
    old = csv_engine.read_dataframe(base, h1)
    new = csv_engine.read_dataframe(ov, h2)
    return csv_engine.diff_frames(old, new, h1.key_columns, max_rows=max_rows)


def revert(profile_id: str, kind: str, rel: str) -> None:
    profiles.revert_file(profile_id, kind, rel)


def export_path(profile_id: str, kind: str, rel: str) -> Path:
    path, _ = profiles.resolve_file(profile_id, kind, rel)
    return path


def import_file(profile_id: str, kind: str, rel: str, uploaded: bytes) -> dict[str, Any]:
    ov = profiles.overlay_path(profile_id, kind, rel)
    ov.parent.mkdir(parents=True, exist_ok=True)
    if ov.suffix.lower() == ".csv":
        # Normalise through the CSV engine so the header/line endings stay valid
        tmp = ov.with_suffix(".upload.tmp")
        tmp.write_bytes(uploaded)
        h = csv_engine.read_header(tmp)
        df = csv_engine.read_dataframe(tmp, h)
        csv_engine.write_dataframe(ov, df, h)
        tmp.unlink(missing_ok=True)
    else:
        ov.write_bytes(uploaded)
    return {"path": str(ov), "size": ov.stat().st_size}
