from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from lxml import etree

from ..config import PATHS
from . import csv_engine

MODULE_LABELS = {
    "energy": "能源",
    "gcam-china": "中国省级",
    "gcam-usa": "美国模块（中国模型不使用）",
    "aglu": "农业与土地利用",
    "water": "水资源",
    "emissions": "排放",
    "socioeconomics": "社会经济",
    "common": "通用",
    "tests": "测试",
}

MODULE_ORDER = ["gcam-china", "energy", "aglu", "water", "emissions", "socioeconomics", "common", "gcam-usa", "tests"]


def classify_xml(name: str, parent: str) -> str:
    n = name.lower()
    if parent == "policy":
        return "政策"
    if parent == "extra":
        return "额外组件"
    if "usa" in n:
        return "USA 专用"
    if re.search(r"ssp[1-5]", n):
        return "SSP 情景"
    if any(k in n for k in ("hector", "magicc", "climate")):
        return "气候"
    if any(k in n for k in ("ccs", "nuclear", "wind", "solar", "geo", "hydro", "cost")):
        return "技术成本/资源"
    if any(k in n for k in ("policy", "tax", "cap", "budget", "uct", "subsid")):
        return "政策"
    return "核心"


def build_catalog(force: bool = False) -> dict[str, Any]:
    cache = PATHS.cache / "catalog.json"
    if cache.is_file() and not force:
        try:
            data = json.loads(cache.read_text(encoding="utf-8"))
            if data.get("gcam_root") == str(PATHS.root):
                return data
        except Exception:
            pass
    data = scan_catalog()
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    return data


def scan_xml_dir(base: Path, kind: str, cached=()) -> list[dict[str, Any]]:
    known = {item["path"]: item for item in cached}
    items = []
    for path in sorted(base.glob("*.xml")):
        stat = path.stat()
        old = known.get(path.name)
        if old and old.get("mtime") == stat.st_mtime and old.get("size") == stat.st_size:
            items.append(old)
            continue
        scenario = ""
        try:
            with path.open("rb") as stream:
                _, root = next(etree.iterparse(stream, events=("start",), huge_tree=True))
                if root.tag == "scenario":
                    scenario = root.get("name", "")
        except (OSError, etree.XMLSyntaxError, StopIteration):
            pass
        items.append({"id": f"{kind}:{path.name}", "kind": kind, "path": path.name, "name": path.stem,
                      "category": classify_xml(path.name, kind), "scenario_name": scenario,
                      "size": stat.st_size, "mtime": stat.st_mtime})
    return items


def scan_catalog() -> dict[str, Any]:
    files: list[dict[str, Any]] = []
    extdata = PATHS.extdata
    for p in sorted(extdata.rglob("*")):
        if not p.is_file():
            continue
        suffix = p.suffix.lower()
        if suffix not in (".csv", ".gz", ".xlsx"):
            continue
        if suffix == ".gz" and not p.name.lower().endswith(".csv.gz"):
            continue
        rel = p.relative_to(extdata).as_posix()
        parts = rel.split("/")
        module = parts[0] if len(parts) > 1 else "common"
        item: dict[str, Any] = {
            "id": rel,
            "kind": "data",
            "path": rel,
            "module": module,
            "module_label": MODULE_LABELS.get(module, module),
            "subdir": "/".join(parts[1:-1]),
            "name": p.name,
            "size": p.stat().st_size,
            "mtime": p.stat().st_mtime,
            "file_type": "xlsx" if suffix == ".xlsx" else "csv",
            "china_relevant": module != "gcam-usa",
        }
        if suffix == ".xlsx":
            item.update({"title": p.stem, "units": "", "columns": [], "rows": 0, "year_columns": [], "long_format": False})
        else:
            try:
                info = csv_engine.file_info(p)
                item.update(
                    {
                        "title": info["title"] or p.stem,
                        "units": info["units"],
                        "description": info["description"],
                        "columns": info["columns"],
                        "column_types": info["column_types"],
                        "rows": info["rows"],
                        "year_columns": info["year_columns"],
                        "long_format": info["long_format"],
                        "key_columns": info["key_columns"],
                    }
                )
            except Exception as exc:
                item.update({"title": p.stem, "units": "", "columns": [], "rows": 0, "error": str(exc)})
        files.append(item)

    xmls = [item for base, kind in ((PATHS.baseline_xml, "xml"), (PATHS.policy_dir, "policy"), (PATHS.extra_dir, "extra"))
            for item in scan_xml_dir(base, kind)]
    queries = scan_queries()
    modules = []
    for m in MODULE_ORDER:
        count = sum(1 for f in files if f["module"] == m)
        if count:
            modules.append({"id": m, "label": MODULE_LABELS.get(m, m), "file_count": count})

    return {
        "gcam_root": str(PATHS.root),
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "files": files,
        "xml": xmls,
        "queries": queries,
        "modules": modules,
        "stats": {
            "files": len(files),
            "xml": len(xmls),
            "queries": count_query_leaves(queries),
        },
    }


def parse_query_groups(node: etree._Element, path: list[str], out: list[dict[str, Any]], counter: list[int]) -> None:
    for child in node:
        if not isinstance(child.tag, str):
            continue
        if child.tag == "queryGroup":
            name = child.get("name", "未命名")
            parse_query_groups(child, path + [name], out, counter)
        else:
            title = child.get("title") or child.get("name")
            if not title:
                continue
            counter[0] += 1
            out.append(
                {
                    "id": f"q{counter[0]:04d}",
                    "title": title,
                    "tag": etree.QName(child).localname,
                    "group": " / ".join(path),
                    "groups": path,
                }
            )


def scan_queries() -> list[dict[str, Any]]:
    p = PATHS.main_queries
    if not p.is_file():
        return []
    try:
        root = etree.parse(str(p)).getroot()
    except Exception:
        return []
    out: list[dict[str, Any]] = []
    parse_query_groups(root, [], out, [0])
    return out


def count_query_leaves(queries: list[dict[str, Any]]) -> int:
    return len(queries)


def query_tree(queries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Build a nested tree for the frontend."""
    root: list[dict[str, Any]] = []
    index: dict[tuple, dict[str, Any]] = {}

    def ensure(path: tuple) -> list[dict[str, Any]]:
        if not path:
            return root
        if path in index:
            return index[path]["children"]
        parent = ensure(path[:-1])
        node = {"key": "/".join(path), "title": path[-1], "children": []}
        parent.append(node)
        index[path] = node
        return node["children"]

    for q in queries:
        children = ensure(tuple(q["groups"]))
        children.append({"key": q["id"], "title": q["title"], "leaf": True, "tag": q["tag"], "group": q["group"]})
    return root
