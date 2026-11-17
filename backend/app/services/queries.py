from __future__ import annotations

import copy
import json
import re
import subprocess
import uuid
from pathlib import Path
from typing import Any, Iterable

from lxml import etree

from ..config import PATHS, SETTINGS, alias_path, env_for_tools, require_file
from .catalog import build_catalog
from .processes import JobCancelled, run_streaming


def _load_query_root() -> etree._Element:
    return etree.parse(str(PATHS.main_queries)).getroot()


def _find_leaf_nodes(root: etree._Element) -> list[etree._Element]:
    leaves: list[etree._Element] = []

    def walk(node: etree._Element) -> None:
        for child in node:
            if not isinstance(child.tag, str):
                continue
            if child.tag == "queryGroup":
                walk(child)
            else:
                leaves.append(child)

    walk(root)
    return leaves


def get_db_regions(db_path: Path, process_cb=None, log_path: Path | None = None) -> list[str]:
    """Read the region names from a GCAM BaseX database."""
    try:
        basex = PATHS.root / "libs" / "jars" / "BaseX-9.5.2.jar"
        parent = alias_path(db_path.parent)
        cmd = [
            SETTINGS.java,
            f"-Dorg.basex.DBPATH={parent}",
            "-cp",
            str(alias_path(basex)),
            "org.basex.BaseX",
            "-c",
            f"OPEN {db_path.name}",
            "-q",
            "concat('GCAM_REGIONS:',string-join(collection()/scenario/world/*[@type='region']/@name/string(), '|'))",
        ]
        output = log_path or (db_path.parent / "regions.log")
        code = run_streaming(cmd, cwd=alias_path(PATHS.root), env=env_for_tools(SETTINGS),
                             log_path=output, process_cb=process_cb, timeout=300)
        text = output.read_text(encoding="utf-8").strip()
        if code == 0 and "GCAM_REGIONS:" in text:
            return [r for r in text.rsplit("GCAM_REGIONS:", 1)[1].strip().split("|") if r]
    except JobCancelled:
        raise
    except Exception:
        pass
    # Fallback: a safe union of all known regions/provinces/grids.
    regions: list[str] = []
    for rel in ("common/GCAM_region_names.csv", "gcam-china/province_names_mappings.csv"):
        p = PATHS.extdata / rel
        if not p.is_file():
            continue
        try:
            h = __import__("backend.app.services.csv_engine", fromlist=["read_dataframe"]).read_header(p)
            df = __import__("backend.app.services.csv_engine", fromlist=["read_dataframe"]).read_dataframe(p, h)
            col = "region" if "region" in df.columns else ("province" if "province" in df.columns else "")
            if col:
                regions.extend([str(v) for v in df[col].tolist() if str(v)])
        except Exception:
            pass
    for extra in ("Central China Grid", "China Southern Power Grid", "East China Grid", "North China Grid", "Northeast China Grid", "Northwest China Grid"):
        if extra not in regions:
            regions.append(extra)
    return list(dict.fromkeys(regions))


def build_filtered_query_file(query_ids: list[str], out_path: Path, regions: list[str] | None = None) -> int:
    """Write a batch-compatible query file (``<aQuery>`` wrappers).

    ModelInterface's batch mode does not accept the GUI's nested ``<queryGroup>``
    structure, so each selected query is wrapped in an ``<aQuery>`` with the
    database's region list.
    """
    root = _load_query_root()
    leaves = _find_leaf_nodes(root)
    selected = set(query_ids)
    new_root = etree.Element("queries")
    count = 0
    for i, leaf in enumerate(leaves, start=1):
        qid = f"q{i:04d}"
        title = leaf.get("title") or leaf.get("name") or ""
        if qid not in selected and title not in selected:
            continue
        a = etree.SubElement(new_root, "aQuery")
        for r in regions or []:
            etree.SubElement(a, "region", name=str(r))
        a.append(copy.deepcopy(leaf))
        count += 1
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_bytes(etree.tostring(new_root, pretty_print=True, xml_declaration=True, encoding="UTF-8"))
    return count


def run_queries(
    run_id: str,
    db_path: Path,
    query_ids: list[str],
    out_dir: Path,
    log_fn=None,
    process_cb=None,
    stop_year: int | None = None,
) -> dict[str, Any]:
    out_dir.mkdir(parents=True, exist_ok=True)
    query_file = out_dir / "selected_queries.xml"
    regions = get_db_regions(db_path, process_cb=process_cb, log_path=out_dir / "regions.log")
    if log_fn:
        log_fn(f"从数据库读取区域：{len(regions)} 个")
    n = build_filtered_query_file(query_ids, query_file, regions=regions)
    if n == 0:
        raise ValueError("没有选择任何查询")
    out_csv = out_dir / "results.csv"
    from xml.sax.saxutils import escape
    batch = f"""<ModelInterfaceBatch>
  <class name="ModelInterface.ModelGUI2.DbViewer">
    <command name="XMLDB Batch File">
      <queryFile>{escape(alias_path(query_file).as_posix())}</queryFile>
      <outFile>{escape(alias_path(out_csv).as_posix())}</outFile>
      <xmldbLocation>{escape(alias_path(db_path).as_posix())}</xmldbLocation>
      <batchQueryResultsInDifferentSheets>false</batchQueryResultsInDifferentSheets>
      <batchQueryIncludeCharts>false</batchQueryIncludeCharts>
      <batchQuerySplitRunsInDifferentSheets>false</batchQuerySplitRunsInDifferentSheets>
      <batchQueryReplaceResults>true</batchQueryReplaceResults>
    </command>
  </class>
</ModelInterfaceBatch>
"""
    batch_file = out_dir / "batch.xml"
    batch_file.write_text(batch, encoding="utf-8")
    log_file = out_dir / "model_interface.log"
    require_file(SETTINGS.java, "java.exe")
    require_file(PATHS.model_interface_jar, "ModelInterface.jar")
    classpath = str(alias_path(PATHS.root / "libs" / "jars" / "*")) + ";" + str(alias_path(PATHS.model_interface_jar))
    cmd = [
        SETTINGS.java,
        "-Xmx8g",
        "-cp",
        classpath,
        "ModelInterface.InterfaceMain",
        "-b",
        str(alias_path(batch_file)),
        "-l",
        str(alias_path(log_file)),
    ]
    if log_fn:
        log_fn("运行 ModelInterface：" + " ".join(cmd))
    out_csv.unlink(missing_ok=True)
    returncode = run_streaming(cmd, cwd=alias_path(PATHS.root), env=env_for_tools(SETTINGS),
                               log_path=out_dir / "java.log", log_fn=log_fn, process_cb=process_cb, timeout=7200)
    if returncode != 0:
        raise RuntimeError(f"ModelInterface 查询失败，退出码 {returncode}；日志：{log_file}")
    if not out_csv.exists():
        raise RuntimeError(f"ModelInterface 没有生成结果文件。日志：{log_file}")
    if stop_year is not None:
        trim_result_years(out_csv, stop_year)
    rows = parse_result_csv(out_csv)
    if not rows:
        raise RuntimeError(f"查询没有返回数据；请核对查询与区域。日志：{log_file}")
    return {
        "csv": str(out_csv),
        "rows": len(rows),
        "queries": n,
        "log": str(log_file),
        "data": rows[:5000],
        "calculated_through": stop_year,
    }


def trim_result_years(path: Path, last_year: int) -> None:
    """GCAM may export initialized future values even when those years were not run."""
    import csv

    temporary = path.with_suffix(".trim.tmp")
    keep = None
    with path.open("r", encoding="utf-8-sig", newline="") as source, temporary.open("w", encoding="utf-8", newline="") as output:
        writer = csv.writer(output, lineterminator="\n")
        for row in csv.reader(source):
            if row and row[0].strip().lower() == "scenario":
                keep = [i for i, column in enumerate(row) if not re.fullmatch(r"(19|20|21)\d{2}", column.strip()) or int(column) <= last_year]
            elif len([value for value in row if value.strip()]) == 1:
                keep = None
            writer.writerow([row[i] if i < len(row) else "" for i in keep] if keep is not None and len(row) > 1 else row)
    temporary.replace(path)


def parse_result_csv(path: Path) -> list[dict[str, Any]]:
    """Parse ModelInterface batch CSV which may contain multiple titled sections."""
    import csv

    rows: list[dict[str, Any]] = []
    with open(path, "r", encoding="utf-8-sig", newline="") as fh:
        reader = csv.reader(fh)
        header: list[str] | None = None
        section = ""
        for raw in reader:
            if not raw:
                continue
            first = raw[0].strip()
            if first.startswith('"') and first.endswith('"'):
                first = first[1:-1]
            # A title line is a single non-empty cell followed by a header line starting with scenario
            if len([c for c in raw if c.strip()]) == 1 and not first.lower().startswith("scenario"):
                section = first
                header = None
                continue
            if first.lower() == "scenario":
                header = [c.strip() for c in raw]
                continue
            if header and len(raw) >= 2:
                rec = {header[i]: raw[i] for i in range(min(len(header), len(raw))) if header[i]}
                rec["__section"] = section
                rows.append(rec)
    return rows


def compare_result_files(
    items: list[dict[str, Any]],
    section: str = "",
    group_by: str = "total",
) -> dict[str, Any]:
    """Build a long-format comparison dataset from several exported result CSVs."""
    import re

    rows: list[dict[str, Any]] = []
    sections: set[str] = set()
    for item in items:
        path = Path(item["path"])
        if not path.is_file():
            continue
        for rec in parse_result_csv(path):
            sec = rec.get("__section", "")
            if not sec:
                continue
            sections.add(sec)
            if section and sec != section:
                continue
            year_cols = [c for c in rec.keys() if re.fullmatch(r"(19|20|21)\d{2}", str(c))]
            if not year_cols:
                continue
            if group_by == "region":
                group = rec.get("region") or rec.get("province") or "National"
            elif group_by == "sector":
                group = rec.get("sector") or rec.get("subsector") or rec.get("fuel") or "Total"
            else:
                group = "Total"
            for y in year_cols:
                raw = rec.get(y, "")
                try:
                    val = float(raw)
                except (TypeError, ValueError):
                    continue
                rows.append(
                    {
                        "result_id": item["id"],
                        "run_id": item.get("run_id", ""),
                        "name": item.get("name", item["id"]),
                        "section": sec,
                        "group": str(group),
                        "year": int(y),
                        "value": val,
                    }
                )
    return {
        "sections": sorted(sections),
        "group_by": group_by,
        "rows": rows[:200000],
        "total": len(rows),
    }


def result_preview(path: Path, offset: int = 0, limit: int = 200) -> dict[str, Any]:
    rows = parse_result_csv(path)
    return {
        "total": len(rows),
        "offset": offset,
        "limit": limit,
        "columns": list(rows[0].keys()) if rows else [],
        "rows": rows[offset : offset + limit],
    }
