from __future__ import annotations

import csv
import gzip
import hashlib
import io
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable

import pandas as pd

YEAR_RE = re.compile(r"^(19|20|21)\d{2}$")
HEADER_SEP_RE = re.compile(r"^#\s*-{3,}\s*$")
META_RE = re.compile(r"^#\s*([A-Za-z][A-Za-z0-9 _/.-]*):\s*(.*)$")


def detect_encoding(path: Path) -> str:
    """Most gcamdata CSVs are UTF-8; a handful are GBK/cp1252 legacy files."""
    try:
        opener = gzip.open if str(path).lower().endswith(".gz") else open
        with opener(path, "rb") as fh:
            sample = fh.read(65536)
    except Exception:
        return "utf-8-sig"
    try:
        sample.decode("utf-8-sig")
        return "utf-8-sig"
    except UnicodeDecodeError:
        pass
    try:
        text = sample.decode("gbk")
        if any("\u4e00" <= ch <= "\u9fff" for ch in text):
            return "gbk"
    except UnicodeDecodeError:
        pass
    return "cp1252"


def open_text(path: Path, encoding: str | None = None):
    enc = encoding or detect_encoding(path)
    if str(path).lower().endswith(".gz"):
        return gzip.open(path, "rt", encoding=enc, newline="")
    return open(path, "r", encoding=enc, newline="")


@dataclass
class CsvHeader:
    header_lines: list[str] = field(default_factory=list)
    columns: list[str] = field(default_factory=list)
    meta: dict[str, str] = field(default_factory=dict)
    data_start_line: int = 0  # zero-based line index of the header row
    encoding: str = "utf-8-sig"

    @property
    def title(self) -> str:
        return self.meta.get("Title", "")

    @property
    def units(self) -> str:
        return self.meta.get("Units", "")

    @property
    def description(self) -> str:
        return self.meta.get("Description", "")

    @property
    def column_types(self) -> str:
        return self.meta.get("Column types", "")

    @property
    def year_columns(self) -> list[str]:
        return [c for c in self.columns if YEAR_RE.match(c.strip())]

    @property
    def is_long(self) -> bool:
        return any(c.strip().lower() == "year" for c in self.columns)

    @property
    def key_columns(self) -> list[str]:
        years = set(self.year_columns)
        return [c for c in self.columns if c not in years and c.strip().lower() != "year"]


def read_header(path: Path) -> CsvHeader:
    """Read the gcamdata CSV header block and column names without loading all data."""
    h = CsvHeader()
    h.encoding = detect_encoding(path)
    with open_text(path, h.encoding) as fh:
        for i, line in enumerate(fh):
            raw = line.rstrip("\n").rstrip("\r")
            if HEADER_SEP_RE.match(raw):
                h.header_lines.append(raw)
                header_line = next(fh, "")
                header_line = header_line.rstrip("\n").rstrip("\r")
                h.header_lines.append(header_line)
                h.data_start_line = i + 1
                h.columns = next(csv.reader([header_line]))
                break
            if raw.startswith("#"):
                h.header_lines.append(raw)
                m = META_RE.match(raw)
                if m:
                    h.meta[m.group(1).strip()] = m.group(2).strip()
                continue
            # No header block: first non-comment line is the header
            h.data_start_line = i
            h.columns = next(csv.reader([raw]))
            h.header_lines = []
            break
    return h


def unique_names(columns: list[str]) -> list[str]:
    seen: dict[str, int] = {}
    out: list[str] = []
    for c in columns:
        if c not in seen:
            seen[c] = 0
            out.append(c)
        else:
            seen[c] += 1
            out.append(f"{c}__{seen[c]}")
    return out


def read_dataframe(path: Path, header: CsvHeader | None = None) -> pd.DataFrame:
    h = header or read_header(path)
    if not h.columns:
        return pd.DataFrame()
    df = pd.read_csv(
        path,
        skiprows=h.data_start_line + 1,
        header=None,
        names=unique_names(h.columns),
        dtype=str,
        keep_default_na=False,
        na_filter=False,
        encoding=h.encoding,
        quoting=csv.QUOTE_MINIMAL,
        engine="python",
    )
    # Normalise column names (strip BOM / stray whitespace)
    df.columns = [str(c).strip() for c in df.columns]
    return df


def write_dataframe(path: Path, df: pd.DataFrame, header: CsvHeader) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    buf = io.StringIO(newline="")
    if header.header_lines:
        for line in header.header_lines[:-1]:
            buf.write(line + "\n")
        buf.write(header.header_lines[-1] + "\n")
    df.to_csv(buf, index=False, header=not bool(header.header_lines), lineterminator="\n", quoting=csv.QUOTE_MINIMAL)
    text = buf.getvalue()
    enc = header.encoding or "utf-8-sig"
    if str(path).lower().endswith(".gz"):
        with gzip.open(path, "wt", encoding=enc, newline="") as fh:
            fh.write(text)
    else:
        # Write atomically (important for the profile overlay)
        tmp = path.with_suffix(path.suffix + ".tmp")
        try:
            tmp.write_text(text, encoding=enc, newline="")
        except UnicodeEncodeError:
            tmp.write_text(text, encoding="utf-8-sig", newline="")
        tmp.replace(path)


def file_sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def count_lines(path: Path) -> int:
    n = 0
    opener = gzip.open if str(path).lower().endswith(".gz") else open
    with opener(path, "rb") as fh:
        while True:
            block = fh.read(1024 * 1024)
            if not block:
                break
            n += block.count(b"\n")
    return n


def file_info(path: Path) -> dict[str, Any]:
    h = read_header(path)
    data_rows = max(0, count_lines(path) - h.data_start_line - 1)
    years = h.year_columns
    long_year = h.is_long
    return {
        "path": str(path),
        "title": h.title,
        "units": h.units,
        "description": h.description,
        "column_types": h.column_types,
        "columns": h.columns,
        "key_columns": h.key_columns,
        "year_columns": years,
        "long_format": long_year,
        "rows": data_rows,
        "size": path.stat().st_size,
        "mtime": path.stat().st_mtime,
    }


def page_frame(
    df: pd.DataFrame,
    offset: int = 0,
    limit: int = 200,
    filters: dict[str, Any] | None = None,
    sort_by: str | None = None,
    sort_desc: bool = False,
    search: str | None = None,
) -> dict[str, Any]:
    view = df
    filters = filters or {}
    for col, val in filters.items():
        if col not in view.columns or val in (None, "", []):
            continue
        if isinstance(val, list):
            view = view[view[col].isin([str(v) for v in val])]
        else:
            view = view[view[col].astype(str) == str(val)]
    if search:
        mask = view.apply(lambda s: s.astype(str).str.contains(search, case=False, regex=False, na=False)).any(axis=1)
        view = view[mask]
    total = len(view)
    if sort_by and sort_by in view.columns:
        view = view.sort_values(by=sort_by, ascending=not sort_desc, kind="stable")
    page = view.iloc[offset : offset + limit]
    return {
        "total": total,
        "offset": offset,
        "limit": limit,
        "columns": list(df.columns),
        "row_ids": [int(i) for i in page.index.tolist()],
        "rows": page.fillna("").astype(str).values.tolist(),
    }


def detect_types(df: pd.DataFrame, header: CsvHeader) -> dict[str, str]:
    """Best-effort per-column type map from gcamdata's column-type string."""
    cols = list(df.columns)
    code = header.column_types.replace(" ", "")
    mapping = {"c": "string", "n": "number", "i": "integer", "l": "boolean", "d": "number"}
    out: dict[str, str] = {}
    for i, col in enumerate(cols):
        out[col] = mapping.get(code[i].lower(), "string") if i < len(code) else "string"
    return out


def diff_frames(old: pd.DataFrame, new: pd.DataFrame, key_columns: list[str], max_rows: int = 2000) -> list[dict[str, Any]]:
    """Return cell-level differences keyed by key_columns. Falls back to positional keys."""
    if old.shape == new.shape and list(old.columns) == list(new.columns):
        keys = [c for c in key_columns if c in old.columns]
        if not keys:
            keys = [old.columns[0]] if len(old.columns) else []
        diffs: list[dict[str, Any]] = []
        old_f = old.fillna("").astype(str)
        new_f = new.fillna("").astype(str)
        for r in range(min(len(old_f), len(new_f))):
            for c in range(min(len(old_f.columns), len(new_f.columns))):
                a, b = old_f.iat[r, c], new_f.iat[r, c]
                if a != b:
                    diffs.append(
                        {
                            "row": r,
                            "key": {k: old_f.iat[r, old_f.columns.get_loc(k)] for k in keys},
                            "column": old_f.columns[c],
                            "old": a,
                            "new": b,
                        }
                    )
                    if len(diffs) >= max_rows:
                        return diffs
        return diffs
    return [{"summary": f"shape changed: {old.shape} -> {new.shape}"}]


def normalize_scalar(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)
