"""Inspect the inputs selected by a GCAM configuration before launching the model."""
from __future__ import annotations

import hashlib
import mmap
import re
import threading
import uuid
from functools import lru_cache
from pathlib import Path, PureWindowsPath

from lxml import etree


def read_xml(path: Path):
    try:
        return etree.parse(str(path), etree.XMLParser(resolve_entities=False, no_network=True))
    except etree.XMLSyntaxError as exc:
        raise ValueError(f"{path.name} 第 {exc.lineno} 行 XML 无法解析：{exc.msg}") from exc


def parse_config(raw: bytes):
    try:
        return etree.fromstring(raw, etree.XMLParser(resolve_entities=False, no_network=True))
    except etree.XMLSyntaxError as exc:
        raise ValueError(f"主配置第 {exc.lineno} 行 XML 无法解析：{exc.msg}。可导入手工主配置修复当前 Profile。") from exc


def imported_config(raw: bytes):
    """Repair only the two unambiguous standalone typos found in China templates."""
    parser = etree.XMLParser(resolve_entities=False, no_network=True)
    try:
        root = etree.fromstring(raw, parser)
        repairs = 0
    except etree.XMLSyntaxError:
        raw, n = re.subn(rb'(?m)^([ \t]*)<--(Value\b[^<\r\n]*>[^<\r\n]*</Value-->)', rb'\1<!--\2', raw)
        raw, m = re.subn(rb'(?m)^([ \t]*<Value\s+name\s*=\s*"bio_elec_w_feed_limit"\s*>[^<\r\n]*/water_elec_liquids_limits\.xml)</Value-->', rb'\1</Value>', raw)
        repairs = n + m
        try:
            root = etree.fromstring(raw, parser)
        except etree.XMLSyntaxError as exc:
            raise ValueError(f"主配置第 {exc.lineno} 行 XML 无法解析：{exc.msg}") from exc
    if root.tag != "Configuration" or root.getroottree().docinfo.doctype:
        raise ValueError("请选择 GCAM 主配置 XML（Configuration 根节点，不支持 DTD）。")
    return raw, repairs


def portable_import(raw: bytes, model_root: Path):
    """Rebase only input paths belonging to the same missing installation as modeltime."""
    root = parse_config(raw)
    modeltime = PureWindowsPath(root.findtext("./Files/Value[@name='xmlInputFileName']", "").strip())
    if not modeltime.is_absolute() or tuple(p.lower() for p in modeltime.parts[-4:-1]) != ("input", "gcamdata", "xml"):
        return raw, 0
    old_root = modeltime.parents[3]
    if Path(old_root).is_dir():
        return raw, 0
    updated = 0
    for node in root.findall("Files/Value") + root.findall("ScenarioComponents/Value"):
        path = PureWindowsPath((node.text or "").strip())
        if path.is_relative_to(old_root / "input"):
            rel = path.relative_to(old_root)
            if ".." not in rel.parts and model_root.joinpath(*rel.parts).is_file():
                node.text = "../" + rel.as_posix()
                updated += 1
    return (etree.tostring(root.getroottree(), encoding="UTF-8", xml_declaration=True) if updated else raw), updated


_write_lock = threading.Lock()


class ConfigChanged(ValueError):
    pass


def write_config(path: Path, raw: bytes, expected_revision: str | None = None):
    tmp = path.with_suffix(f".{uuid.uuid4().hex}.tmp")
    try:
        tmp.write_bytes(raw)
        with _write_lock:
            if expected_revision and revision(path.read_bytes()) != expected_revision:
                raise ConfigChanged("此配置已更新，请重新加载后再保存。")
            tmp.replace(path)
    finally:
        tmp.unlink(missing_ok=True)


def summary(root):
    components = [v.text.strip() for v in root.findall("./ScenarioComponents/Value") if v.text and v.text.strip()]
    def filename(value):
        return value.replace("\\", "/").rsplit("/", 1)[-1]
    def policies(values):
        return [filename(p) for p in values if "/policy/" in ("/" + p.replace("\\", "/")).lower()]
    disabled = []
    for comment in root.xpath("./ScenarioComponents/comment()"):
        disabled.extend(re.findall(r'>\s*([^<>]*?\.xml)\s*</Value\b', comment.text or "", re.I))
    enabled = {v.get("name") for v in root.findall("./Bools/Value") if (v.text or "").strip().lower() in {"1", "true"}}
    active_policies = policies(components)
    return {
        "socioeconomics": [filename(p) for p in components if filename(p).lower().startswith("socioeconomics")],
        "policies": active_policies, "commented_policies": [p for p in policies(disabled) if p not in active_policies],
        "component_count": len(components), "find_path": "find-path" in enabled and "BatchMode" not in enabled,
        "target_file": filename(root.findtext("./Files/Value[@name='policy-target-file']", "").strip()),
        "scenario_name": root.findtext("./Strings/Value[@name='scenarioName']", "").strip(),
        "stop_year": root.findtext("./Ints/Value[@name='stop-year']", "").strip(),
    }


def apply_template(exe_dir: Path, filename: str, current: list[dict]) -> list[dict]:
    """Replace bundled model components, retaining custom additions near their original anchors."""
    if Path(filename).name != filename or not filename.startswith("configuration") or not filename.endswith(".xml"):
        raise ValueError("请选择模型目录中的配置模板。")
    selected = exe_dir / filename
    if not selected.is_file():
        raise ValueError("模板文件不存在。")

    def key(value):
        name = "/" + value.replace("\\", "/").casefold()
        return name.split("/input/", 1)[-1]

    def rows(path):
        raw, _ = imported_config(path.read_bytes())
        return [{"name": el.get("name", ""), "value": (el.text or "").strip()}
                for el in parse_config(raw).findall("./ScenarioComponents/Value")]

    desired = rows(selected)
    standard = set()
    for path in exe_dir.glob("configuration*.xml"):
        if not re.fullmatch(r"configuration(?:_china(?:_ssp[1-5])?)?\.xml", path.name, re.I):
            continue
        try:
            standard.update(key(row["value"]) for row in rows(path))
        except ValueError:
            continue
    # Policies belong to the user's experiment; keep active entries including repeated loads.
    active_keys = {key(row["value"]) for row in current}
    desired = [r for r in desired if not (key(r["value"]).startswith("policy/") and key(r["value"]) in active_keys)]
    anchors = {key(row["value"]): i for i, row in enumerate(desired)}
    insert_at = len(desired)
    retained = [[] for _ in range(len(desired) + 1)]
    for row in reversed(current):
        k = key(row["value"])
        if k in anchors:
            insert_at = min(insert_at, anchors[k])
        elif k not in standard or k.startswith("policy/"):
            retained[insert_at].append(row)
    result = []
    for index, bucket in enumerate(retained):
        result.extend(reversed(bucket))
        if index < len(desired):
            result.append(desired[index])
    return result


def revision(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


@lru_cache(maxsize=1024)
def _uses_ltg_price(path: Path, size: int, modified_ns: int) -> bool:
    # Most GCAM inputs are large sector files with no mention of the target market.
    with path.open("rb") as stream:
        if not size:
            return False
        with mmap.mmap(stream.fileno(), 0, access=mmap.ACCESS_READ) as data:
            encoded = data[:4].startswith((b"\xff\xfe", b"\xfe\xff", b"\0<", b"<\0"))
            if not encoded and data.find(b"CO2_LTG") == -1 and data.find(b"&#") == -1:
                return False
        for _, node in etree.iterparse(stream, events=("end",), resolve_entities=False, no_network=True, huge_tree=True):
            # A ghgpolicy declares a trial price. A link, emission or other input must consume it.
            if (node.tag != "ghgpolicy" and
                    (node.get("name") == "CO2_LTG" or (node.text or "").strip() == "CO2_LTG")):
                return True
            node.clear()
            while node.getprevious() is not None:
                del node.getparent()[0]
    return False


def validate_inputs(tree, info, *, fast_mode: bool):
    components = [Path((node.text or "").strip()) for node in tree.findall("./ScenarioComponents/Value")]
    modeltime = tree.findtext("./Files/Value[@name='xmlInputFileName']", "").strip()
    warnings = []
    for path in components + ([Path(modeltime)] if modeltime else []):
        if not path.is_file():
            raise RuntimeError(f"找不到启用的模型输入：{path}。请核对当前 Profile 的配置。")
        if path in components and "policy" in [part.lower() for part in path.parts]:
            try:
                if read_xml(path).getroot().tag != "scenario":
                    warnings.append(f"{path.name} 的根节点不是 scenario。请核对文件用途。")
            except ValueError as exc:
                warnings.append(str(exc))
    if not info["find_path"]:
        return warnings
    target = Path(tree.findtext("./Files/Value[@name='policy-target-file']", "").strip())
    if not target.is_file():
        raise RuntimeError(f"找不到政策目标文件：{target}。请检查当前 Profile 的模型配置。")
    runner = read_xml(target).getroot()
    if runner.tag != "policy-target-runner":
        warnings.append(f"{target.name} 的根节点不是标准的 policy-target-runner，请核对目标文件。")
    if (runner.findtext("tax-name") or "CO2").strip() == "CO2_LTG":
        candidates = sorted(((p, p.stat()) for p in components), key=lambda item: item[1].st_size)
        try:
            uses_price = any(_uses_ltg_price(p, st.st_size, st.st_mtime_ns) for p, st in candidates)
        except etree.XMLSyntaxError as exc:
            warnings.append(f"无法确认长期碳市场连接：{exc}")
            uses_price = True
        if not uses_price:
            warnings.append("已启用 CO2_LTG 目标搜索，但启用的组件中未发现使用该碳价的排放或市场连接。请在模型配置中添加与研究方案匹配的长期碳市场和排放连接组件（如 2025_target_finder.xml），并保存。")
    stop = info["stop_year"]
    period = tree.findtext("./Ints/Value[@name='stop-period']", "").strip()
    end_year = read_xml(Path(modeltime)).findtext(".//modeltime/end-year") if modeltime else None
    if fast_mode or period.isdecimal() or (stop.isdecimal() and stop != end_year):
        warnings.append(f"目标搜索按模型完整时段运行至 {end_year or '模型末年'}。短期试跑可关闭政策目标搜索。")
    return warnings
