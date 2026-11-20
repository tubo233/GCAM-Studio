"""Parameter identities and per-cell edits shared by the editor and the GCAM runner."""

from __future__ import annotations

from collections import Counter
from functools import lru_cache
import hashlib
import json
from pathlib import Path
from threading import RLock

from lxml import etree

from ..config import PATHS
from . import profiles, r_build, scenario_config

EDIT_LOCK = RLock()
LABELS = {
    "totalPop": "人口",
    "GDP": "GDP",
    "constraint": "排放或数量上限",
    "fixedTax": "固定碳价",
    "target-value": "全球目标值",
    "target-type": "目标类型",
    "tax-name": "目标碳市场",
    "capital-overnight": "隔夜投资成本",
    "OM-fixed": "固定运维成本",
    "OM-var": "可变运维成本",
    "input-cost": "投入成本",
    "efficiency": "技术效率",
    "share-of-sector-output": "部门产出占比",
}


def read_tree(path):
    return etree.parse(
        str(path),
        etree.XMLParser(no_network=True, resolve_entities=False, huge_tree=True),
    )


def file_key(text):
    path = (PATHS.exe_dir / text.strip()).resolve()
    return (
        path.relative_to(PATHS.root.resolve()).as_posix()
        if path.is_relative_to(PATHS.root.resolve())
        else str(path)
    )


def config_values(root):
    return {
        f"{group}/{node.get('name')}": (node.text or "").strip()
        for group in ("Strings", "Bools", "Ints", "Doubles", "Files")
        for node in root.findall(group + "/Value")
    }


def edit_file(pid):
    return profiles.overlay_root(pid) / "parameters.json"


def edits(pid):
    path = edit_file(pid)
    return json.loads(path.read_text("utf-8")) if path.is_file() else {}


@lru_cache(maxsize=8192)
def _digest(path, size, stamp, inode):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def digest(path):
    stat = path.stat()
    return _digest(path, stat.st_size, stat.st_mtime_ns, stat.st_ino)


def _landmark(node):
    return node.tag, tuple(
        sorted((k, v) for k, v in node.attrib.items() if k not in ("unit", "units"))
    )


def _row_context(node, parent, ordinal, inherited):
    tag, attrs = _landmark(node)
    token = json.dumps(
        [parent, tag, attrs, ordinal], ensure_ascii=False, separators=(",", ":")
    )
    key = hashlib.blake2b(token.encode(), digest_size=16).hexdigest()
    context = inherited.copy()
    name = node.get("name")
    if name:
        if tag == "region":
            context["region"] = name
        if "sector" in tag:
            context["sector"] = name
        if "technology" in tag:
            context["technology"] = name
        if "policy" in tag:
            context["policy"] = name
        if tag.startswith("input-") or tag.endswith("-input"):
            context["input"] = name
    if node.get("year"):
        context["year"] = node.get("year")
    unit = (
        node.get("unit")
        or node.get("units")
        or {"totalPop": "千人", "share-of-sector-output": "比例"}.get(tag)
    )
    if unit:
        context["unit"] = unit
    return key, context


def _walk(events, wanted, release):
    stack = []
    for event, node in events:
        if not isinstance(node.tag, str):
            continue
        if event == "start":
            parent, scope, siblings = stack[-1] if stack else ("", {}, Counter())
            landmark = _landmark(node)
            key, context = _row_context(node, parent, siblings[landmark], scope)
            siblings[landmark] += 1
            if "policy" in node.tag and node.findtext("market"):
                context["market"] = node.findtext("market").strip()
            stack.append((key, context, Counter()))
            continue
        key, context, children = stack.pop()
        value = (node.text or "").strip()
        if node.tag == "market" and stack:
            stack[-1][1]["market"] = value
        if not children and value and (not wanted or node.tag in wanted):
            yield (
                key,
                node,
                dict(
                    context,
                    field=node.tag,
                    label=LABELS.get(node.tag, node.tag),
                    value=value,
                ),
            )
        if release:
            node.clear()
            while node.getprevious() is not None:
                del node.getparent()[0]


def rows(root, wanted=None):
    return _walk(etree.iterwalk(root, events=("start", "end")), wanted, False)


def file_rows(path, wanted=None):
    # Small policy files can place the market after the year/value records.
    if path.stat().st_size <= 8_000_000:
        yield from rows(read_tree(path).getroot(), wanted)
    else:
        with path.open("rb") as stream:
            events = etree.iterparse(
                stream,
                events=("start", "end"),
                no_network=True,
                resolve_entities=False,
                huge_tree=True,
            )
            yield from _walk(events, wanted, True)


def apply_edits(source, changes, dest):
    if not changes:
        return 0
    tree = read_tree(source)
    remaining = set(changes)
    for key, node, _ in rows(tree.getroot()):
        if key in remaining:
            node.text = changes[key]
            remaining.remove(key)
            if not remaining:
                break
    dest.parent.mkdir(parents=True, exist_ok=True)
    scenario_config.write_config(
        dest, etree.tostring(tree, encoding="UTF-8", xml_declaration=True)
    )
    return len(remaining)


def effective_file(pid, key, source, overrides, directory=None, warnings=None):
    changes = overrides.get(key)
    if not changes or not source.is_file():
        return source
    identity = [key, digest(source), changes]
    checksum = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()
    dest = (
        (directory or profiles.profile_dir(pid) / "parameter-cache")
        / checksum
        / ("policy" if key.lower().startswith("input/policy/") else "xml")
        / source.name
    )
    marker = dest.parent / (dest.name + ".unmatched")
    if not dest.is_file() or not marker.is_file():
        missing = apply_edits(source, changes, dest)
        scenario_config.write_config(marker, str(missing).encode("ascii"))
    if warnings is not None:
        missing = int(marker.read_text("ascii"))
        if missing:
            warnings.append(
                f"{source.name} 有 {missing} 项指定值已找不到对应参数。本次使用其余可匹配的指定值，可在统一参数表中清除此文件指定值。"
            )
    return dest


def sources(pid, *, build_dir=None, materialize=True, include_auxiliary=False):
    from .gcam_run import _resolve_component

    tree = scenario_config.parse_config(
        (profiles.profile_dir(pid) / "config.xml").read_bytes()
    )
    build = r_build.latest_build(pid) if build_dir is None else None
    xml_dir = build_dir or (Path(build["xml_dir"]) if build else PATHS.baseline_xml)
    selected = tree.findall("ScenarioComponents/Value")
    if scenario_config.summary(tree)["find_path"]:
        selected += tree.findall("Files/Value[@name='policy-target-file']")
    if include_auxiliary:
        selected += [
            n
            for n in tree.findall("Files/Value")
            if n.get("name") in ("xmlInputFileName", "GHGInputFileName")
        ]
    overrides = edits(pid) if materialize else {}
    result = {}
    for node in selected:
        text = (node.text or "").strip()
        if text:
            key = file_key(text)
            path = Path(_resolve_component(text, xml_dir, pid))
            result[key] = effective_file(pid, key, path, overrides)
    return result


def source_for(pid, source, materialize=False):
    path = sources(pid, materialize=materialize).get(source)
    if not path or not path.is_file():
        raise ValueError("该文件未启用或不存在，请重新选择来源。")
    return path


def search_rows(pid, source, query="", fields="", offset=0, limit=60):
    path = source_for(pid, source)
    overrides = edits(pid).get(source, {})
    words = query.replace("四川", "SC").replace("重庆", "CQ").casefold().split()
    found = []
    skipped = 0
    for key, _, row in file_rows(path, set(fields.split(",")) if fields else None):
        row.update(
            id=key,
            original=row["value"],
            value=overrides.get(key, row["value"]),
            specified=key in overrides,
        )
        context = " ".join(str(v) for v in [source, *row.values()]).casefold()
        if not all(word in context for word in words):
            continue
        if skipped < offset:
            skipped += 1
            continue
        found.append(row)
        if len(found) > limit:
            break
    return {
        "rows": found[:limit],
        "more": len(found) > limit,
        "source": source,
        "overrides": len(overrides),
    }


def save_rows(pid, source, updates, clear=False):
    path = source_for(pid, source)
    with EDIT_LOCK:
        settings = edits(pid)
        changes = settings.setdefault(source, {})
        if clear:
            changes.clear()
        else:
            requested = {r["id"]: r for r in updates}
            if not requested:
                raise ValueError("请选择要修改的参数。")
            for key, _, row in file_rows(path):
                if key not in requested:
                    continue
                update = requested.pop(key)
                if changes.get(key, row["value"]) != update["before"]:
                    raise ValueError("该项已被修改，请刷新后重试。")
                if update.get("value") in (None, row["value"]):
                    changes.pop(key, None)
                else:
                    changes[key] = str(update["value"])
                if not requested:
                    break
            if requested:
                raise ValueError("参数所在位置已改变，请刷新后重试。")
        if not changes:
            settings.pop(source, None)
        p = edit_file(pid)
        p.parent.mkdir(parents=True, exist_ok=True)
        scenario_config.write_config(
            p, json.dumps(settings, ensure_ascii=False).encode()
        )


@lru_cache(maxsize=8192)
def _fields_present(path, size, stamp, fields):
    import mmap

    if not size:
        return False
    with (
        path.open("rb") as stream,
        mmap.mmap(stream.fileno(), 0, access=mmap.ACCESS_READ) as data,
    ):
        return any(
            data.find(("<" + field + ending).encode()) >= 0
            for field in fields
            for ending in (">", " ")
        )


def list_sources(pid, requested):
    paths = sources(pid, materialize=False)
    if not requested:
        return list(paths)
    fields = tuple(
        f for f in requested.split(",") if f in LABELS or f == "first-tax-year"
    )
    selected = []
    for key, path in paths.items():
        if path.is_file():
            stat = path.stat()
            if _fields_present(path, stat.st_size, stat.st_mtime_ns, fields):
                selected.append(key)

    def priority(key):
        name = Path(key).name.lower()
        if "totalPop" in fields or "GDP" in fields:
            return 0 if name.startswith("socioeconomics_china") else 1
        if "constraint" in fields or "target-value" in fields:
            return 0 if "/policy/" in key else 1
        return (
            0
            if name.startswith("electricity_china")
            else 1
            if name.startswith("electricity")
            else 2
        )

    return sorted(selected, key=priority)


def raw_overlay(pid, key):
    for prefix, kind in [
        ("input/gcamdata/xml/", "xml"),
        ("input/policy/", "policy"),
        ("input/extra/", "extra"),
    ]:
        if key.startswith(prefix):
            return profiles.overlay_path(pid, kind, key[len(prefix) :])
    return (
        profiles.overlay_root(pid)
        / "component-files"
        / hashlib.sha256(key.encode()).hexdigest()
        / Path(key).name
    )


@lru_cache(maxsize=512)
def policy_overview(path, checksum):
    tree = read_tree(path)
    root = tree.getroot()
    if root.tag == "policy-target-runner":
        return " · ".join(
            i
            for i in (
                root.findtext("target-type"),
                root.findtext("target-value"),
                root.findtext("tax-name"),
            )
            if i
        )
    regions, markets, years = [], [], set()
    for region in root.iter("region"):
        for policy in region.xpath(
            ".//ghgpolicy | .//policy-portfolio-standard | .//linked-ghg-policy"
        ):
            name = region.get("name")
            if name and name not in regions:
                regions.append(name)
            market = policy.findtext("market")
            if market and market not in markets:
                markets.append(market)
            years.update(
                int(n.get("year")) for n in policy if (n.get("year") or "").isdecimal()
            )
    display = {"SC": "四川", "CQ": "重庆"}
    parts = [
        "、".join(display.get(r, r) for r in regions[:5])
        + (f" 等 {len(regions)} 个地区" if len(regions) > 5 else "")
    ]
    if years:
        parts.append(
            str(min(years))
            if min(years) == max(years)
            else f"{min(years)}–{max(years)}"
        )
    if markets:
        parts.append("市场 " + "、".join(markets[:5]))
    return " · ".join(filter(bool, parts))


def summaries(paths):
    result = {}
    for key, path in paths.items():
        if not path.is_file():
            continue
        stat = path.stat()
        # Component folders alone are insufficient for hand-written policy files.
        if "/policy/" not in key.replace("\\", "/").lower() and (
            stat.st_size > 2_000_000
            or not _fields_present(
                path,
                stat.st_size,
                stat.st_mtime_ns,
                (
                    "ghgpolicy",
                    "policy-portfolio-standard",
                    "linked-ghg-policy",
                    "policy-target-runner",
                ),
            )
        ):
            continue
        try:
            result[key] = policy_overview(path, digest(path))
        except etree.XMLSyntaxError:
            result[key] = "自定义 XML"
    return result
