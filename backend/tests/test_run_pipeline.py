from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

import pytest
from lxml import etree

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend.app import config, db, api
from backend.app.services import profiles, r_build, gcam_run, queries, jobs, csv_engine, files
from backend.app.services.processes import run_streaming


@pytest.fixture
def model(tmp_path, monkeypatch):
    settings = config.AppSettings(gcam_root=str(tmp_path / "model"), data_dir=str(tmp_path / "data"))
    old = dict(vars(config.PATHS))
    config.PATHS.__init__(settings)
    config.PATHS.ensure()
    root = config.PATHS.root
    (root / "exe").mkdir(parents=True)
    (root / "exe" / "gcam.exe").write_bytes(b"fake executable, never launched")
    (root / "exe" / "log_conf.xml").write_text('<LoggerFactory><Logger><FileName>logs/main_log.txt</FileName></Logger></LoggerFactory>')
    config.PATHS.baseline_xml.mkdir(parents=True)
    for name in ("modeltime.xml", "sample.xml"):
        (config.PATHS.baseline_xml / name).write_text("<scenario/>")
    (root / "input" / "solution").mkdir()
    (root / "input" / "solution" / "cal_broyden_config.xml").write_text('<scenario><max-model-calcs>15000</max-model-calcs></scenario>')
    (root / "exe" / "configuration_china.xml").write_text('''<Configuration><Files>
      <Value name="xmlInputFileName">../input/gcamdata/xml/modeltime.xml</Value>
      <Value name="xmldb-location">database_basexdb</Value></Files><ScenarioComponents>
      <Value name="data">../input/gcamdata/xml/sample.xml</Value>
      <Value name="solver">../input/solution/cal_broyden_config.xml</Value>
      </ScenarioComponents><Strings/><Ints/><Bools/></Configuration>''')
    db.init_db()
    pid = profiles.create_profile("sample")["id"]
    yield pid
    vars(config.PATHS).clear()
    vars(config.PATHS).update(old)


def test_fast_validation_keeps_solver_and_limits_horizon(model, tmp_path):
    build = r_build.run_build(model)
    result = gcam_run.run_gcam(model, build=build, fast_mode=True, dry_run=True)
    tree = etree.parse(result["config"])
    assert tree.findtext('./Ints/Value[@name="stop-year"]') == "2025"
    assert tree.findtext('./Ints/Value[@name="stop-period"]') == "-1"
    assert tree.findtext('./ScenarioComponents/Value[@name="solver"]').endswith("cal_broyden_config.xml")
    assert result["solver_precision"] == "standard"
    assert result["validation_only"] is True
    assert not list(Path(result["run_dir"]).glob("solver_fast.xml"))


def test_restore_delete_and_model_change_invalidate_build(model, tmp_path):
    overlay = profiles.overlay_path(model, "data", "test.csv")
    overlay.parent.mkdir(parents=True)
    overlay.write_text("year,value\n2025,2\n")
    build = {"input_signature": r_build.input_signature(model), "xml_dir": str(config.PATHS.baseline_xml)}
    assert not r_build.build_is_stale(model, build)
    profiles.revert_file(model, "data", "test.csv")
    assert r_build.build_is_stale(model, build)
    baseline = r_build.run_build(model)
    old_root = config.PATHS.root
    config.PATHS.root = tmp_path / "another-model"
    try:
        assert r_build.build_is_stale(model, baseline)
    finally:
        config.PATHS.root = old_root


def test_overlay_xml_is_actual_run_input(model, tmp_path):
    overlay = profiles.overlay_path(model, "xml", "sample.xml")
    overlay.parent.mkdir(parents=True)
    overlay.write_text('<scenario name="modified"/>')
    build = r_build.run_build(model)
    result = gcam_run.run_gcam(model, build=build, dry_run=True)
    tree = etree.parse(result["config"])
    assert Path(tree.findtext('./ScenarioComponents/Value[@name="data"]')) == overlay


def test_mirror_patches_never_modify_hardlinked_baseline(model, tmp_path):
    src = config.PATHS.gcamdata
    (src / "R").mkdir()
    description = 'Package: gcamdata\nImports:\n    devtools,\n    drake (>= 6.2.1)\n'
    driver = 'version <- as.character(utils::packageVersion("gcamdata"))\n'
    (src / "DESCRIPTION").write_text(description)
    (src / "R" / "driver.R").write_text(driver)
    mirror, _ = r_build.prepare_mirror(model, tmp_path / "mirror")
    assert (src / "DESCRIPTION").read_text() == description
    assert (src / "R" / "driver.R").read_text() == driver
    assert "pkgload" in (mirror / "DESCRIPTION").read_text()
    assert '"8.2"' in (mirror / "R" / "driver.R").read_text()


@pytest.mark.parametrize("returncode,lines,expected", [
    (1, ["Model did not solve period 11 within set iteration 300"], "failed"),
    (0, ["Model run completed."], "failed"),
    (0, ["Model did not calibrate successfully in period 5", "All model periods solved correctly."], "failed"),
    (0, ["All model periods solved correctly."], "success"),
])
def test_run_manifest_and_quality_checks(model, monkeypatch, returncode, lines, expected):
    def process(cmd, **kwargs):
        cfg = etree.parse(cmd[cmd.index("-C") + 1])
        database = Path(cfg.findtext('./Files/Value[@name="xmldb-location"]'))
        database.mkdir()
        (database / "tbl.basex").write_bytes(b"fixture")
        kwargs["log_path"].write_text("\n".join(lines))
        for line in lines:
            kwargs["log_fn"](line)
        return returncode
    monkeypatch.setattr(gcam_run, "run_streaming", process)
    if expected == "success":
        result = gcam_run.run_gcam(model)
        assert result["status"] == "success"
    else:
        with pytest.raises(RuntimeError):
            gcam_run.run_gcam(model)
    saved = gcam_run.list_runs(model)[0]
    assert saved["status"] == expected
    assert Path(saved["log"]).is_file()
    assert (Path(saved["run_dir"]) / "logs").is_dir()
    assert saved["exit_code"] == returncode


def test_clone_only_copies_inputs(model):
    original = r_build.run_build(model)
    clone = profiles.clone_profile(model, "clone")["id"]
    assert r_build.latest_build(clone) is None
    assert gcam_run.list_runs(clone) == []


@pytest.mark.parametrize("code", [0, 1])
def test_invalid_target_price_not_masked_by_solved_years_or_database(model, monkeypatch, code):
    def process(cmd, **kwargs):
        run_dir = kwargs["log_path"].parent
        report = run_dir / "logs/target_finder_log.txt"
        report.touch()
        (run_dir / "database_basexdb").mkdir()
        (run_dir / "database_basexdb/tbl.basex").touch()
        for line in ["Period 21: 2100", "Model solved normally. Iterations period 21: 158",
                     "All model periods solved correctly.", "Model run completed.",
                     "ERROR:Failed due to invalid trial price generated by solver.",
                     "Starting output to XML Database.", "Model exiting successfully."]:
            kwargs["log_fn"](line)
        assert gcam_run.list_runs(model)[0]["stage"] == "output"
        return code
    monkeypatch.setattr(gcam_run, "run_streaming", process)
    with pytest.raises(RuntimeError, match="政策目标搜索失败.*target_finder_log.txt"):
        gcam_run.run_gcam(model)
    saved = gcam_run.list_runs(model)[0]
    assert saved["status"] == "failed" and saved["calculated_through"] == 2100
    assert saved["failed_periods"] == [] and "未收敛期" not in saved["error"]


def test_target_iteration_limit_has_its_own_diagnosis(model, monkeypatch):
    def process(cmd, **kwargs):
        kwargs["log_fn"]("All model periods solved correctly.")
        kwargs["log_fn"]("ERROR:Exiting target finding search as the iterations limit was reached.")
        return 1
    monkeypatch.setattr(gcam_run, "run_streaming", process)
    with pytest.raises(RuntimeError, match="政策目标搜索已达到迭代上限"):
        gcam_run.run_gcam(model)


def test_find_path_requires_its_target_file_before_starting(model, monkeypatch):
    config_path = profiles.profile_dir(model) / "config.xml"
    tree = etree.parse(str(config_path))
    etree.SubElement(tree.find("./Bools"), "Value", name="find-path").text = "1"
    etree.SubElement(tree.find("./Files"), "Value", name="policy-target-file").text = "../input/policy/missing.xml"
    tree.write(str(config_path))
    monkeypatch.setattr(gcam_run, "run_streaming", lambda *args, **kwargs: pytest.fail("should not start GCAM"))
    with pytest.raises(RuntimeError, match="政策目标文件.*missing.xml"):
        gcam_run.run_gcam(model)


def test_quiet_job_poll_omits_log_history(monkeypatch):
    job = jobs.Job(id="quiet", kind="run", title="fixture")
    job.log("last line")
    monkeypatch.setattr(jobs.MANAGER, "get", lambda _: job)
    assert "logs" not in api.api_job(job.id, include_logs=False)["data"]
    assert api.api_job(job.id)["data"]["logs"][-1].endswith("last line")


@pytest.mark.parametrize("kind,rel", [("xml", "../../escape.xml"), ("xml", "C:/escape.xml"), ("../xml", "escape.xml")])
def test_overlay_cannot_escape_profile(model, kind, rel):
    with pytest.raises(ValueError):
        profiles.overlay_path(model, kind, rel)


def test_failed_query_cannot_reuse_old_csv_and_escapes_xml(model, tmp_path, monkeypatch):
    out = tmp_path / "results & exports"
    out.mkdir()
    (out / "results.csv").write_text("stale previous result")
    monkeypatch.setattr(queries, "get_db_regions", lambda *a, **k: [])
    monkeypatch.setattr(queries, "build_filtered_query_file", lambda *a, **k: 1)
    monkeypatch.setattr(queries, "require_file", lambda *a: None)
    monkeypatch.setattr(queries, "run_streaming", lambda *a, **k: 9)
    with pytest.raises(RuntimeError, match="9"):
        queries.run_queries("r1", tmp_path / "db", ["q0001"], out)
    assert not (out / "results.csv").exists()
    etree.parse(str(out / "batch.xml"))


def test_streaming_includes_last_line_and_honors_timeout(tmp_path):
    got = []
    code = run_streaming([sys.executable, "-c", "print('last line', end='')"], cwd=tmp_path,
                         env=os.environ.copy(), log_path=tmp_path / "stdout.log", log_fn=got.append)
    assert code == 0 and got == ["last line"]
    with pytest.raises(TimeoutError):
        run_streaming([sys.executable, "-c", "import time; time.sleep(10)"], cwd=tmp_path,
                      env=os.environ.copy(), log_path=tmp_path / "timeout.log", timeout=0.2)


def test_cancellation_is_not_reported_failed():
    manager = jobs.JobManager()
    def work(job):
        job.cancel_requested = True
        raise RuntimeError("process killed")
    job = manager.submit("run", "cancel test", work)
    deadline = time.monotonic() + 3
    while job.finished_at is None and time.monotonic() < deadline:
        time.sleep(.01)
    assert job.status == "cancelled"


def test_log_sequence_survives_buffer_truncation():
    job = jobs.Job(id="logs", kind="run", title="large log")
    for i in range(20005):
        job.log(str(i))
    assert job.log_offset + len(job.logs) == 20005
    assert job.log_offset > 0
    assert job.to_dict()["log_count"] == 20005


def test_gzip_csv_roundtrip_and_row_count(tmp_path):
    import gzip
    path = tmp_path / "data.csv.gz"
    with gzip.open(path, "wt", encoding="utf-8") as stream:
        stream.write('# Title: 中文数据\n# Column types: cn\n# ----------\nregion,2025\nChina,2\n')
    header = csv_engine.read_header(path)
    assert header.title == "中文数据"
    frame = csv_engine.read_dataframe(path, header)
    assert frame.iloc[0, 1] == "2"
    csv_engine.write_dataframe(path, frame, header)
    assert csv_engine.file_info(path)["rows"] == 1


def test_bulk_rejects_nonfinite_values_without_saving(model):
    source = config.PATHS.extdata / "numeric.csv"
    source.parent.mkdir(parents=True, exist_ok=True)
    source.write_text('# Column types: cn\n# ----------\nregion,2025\nChina,2\n')
    with pytest.raises(ValueError):
        files.bulk(model, "data", "numeric.csv", "set", "2025", value="NaN")
    overlay = profiles.overlay_path(model, "data", "numeric.csv")
    assert "NaN" not in overlay.read_text()


@pytest.mark.skipif(os.name != "nt", reason="Windows R locale")
def test_windows_tools_replace_inherited_unix_locale(monkeypatch):
    monkeypatch.setenv("LANG", "C.UTF-8")
    monkeypatch.setenv("LC_CTYPE", "C.UTF-8")
    env = config.env_for_tools(config.AppSettings())
    assert env["LC_ALL"] == "English_United States.utf8"
    assert "LANG" not in env and "LC_CTYPE" not in env


def test_custom_policy_is_visible_in_profile_catalog(model):
    path = profiles.overlay_path(model, "policy", "custom.xml")
    path.parent.mkdir(parents=True)
    path.write_text('<scenario name="custom"/>')
    items = api.api_catalog_xml(kind="policy", profile_id=model)["data"]
    assert any(item["path"] == "custom.xml" and item["kind"] == "policy" for item in items)


def test_year_2100_is_preserved_in_inputs_and_result_comparisons(tmp_path):
    source = tmp_path / "input.csv"
    source.write_text('region,2095,2100\nChina,1,2\n')
    assert csv_engine.read_header(source).year_columns == ['2095', '2100']
    result = tmp_path / "result.csv"
    result.write_text('Primary energy\nscenario,region,2095,2100\nBaseline,China,1,2\n')
    compared = queries.compare_result_files([{'id': 'r1', 'path': str(result)}])
    assert {item['year'] for item in compared['rows']} == {2095, 2100}


def test_partial_run_exports_only_calculated_years(tmp_path):
    log = tmp_path / 'gcam.log'
    log.write_text("Model run beginning.\nPeriod 6: 2025\nModel solved normally. Iterations period 6: 1320\n")
    assert gcam_run.last_calculated_year({'log': str(log)}) == 2025
    result = tmp_path / 'results.csv'
    result.write_text('Primary energy\nscenario,region,2021,2025,2035,2100\nQuick,China,1,2,999,999\n\nGDP\nscenario,region,2025,2050\nQuick,China,3,999\n')
    queries.trim_result_years(result, 2025)
    rows = queries.parse_result_csv(result)
    assert len(rows) == 2
    assert rows[0]['2025'] == '2' and rows[1]['2025'] == '3'
    assert all(not any(key in row for key in ('2035', '2050', '2100')) for row in rows)

def test_market_warnings_are_advisory_and_overlays_are_used(model, monkeypatch):
    cfg = profiles.profile_dir(model) / "config.xml"
    tree = etree.parse(str(cfg))
    etree.SubElement(tree.find("Bools"), "Value", name="find-path").text = "1"
    etree.SubElement(tree.find("Ints"), "Value", name="stop-year").text = "2060"
    policy = config.PATHS.policy_dir
    policy.mkdir(parents=True)
    target = policy / "target.xml"
    target.write_text("<policy-target-runner><tax-name>CO2_LTG</tax-name></policy-target-runner>")
    etree.SubElement(tree.find("Files"), "Value", name="policy-target-file").text = str(target)
    link = policy / "custom.xml"
    link.write_text("<scenario><!-- <linked-policy>CO2_LTG</linked-policy> --></scenario>")
    etree.SubElement(tree.find("ScenarioComponents"), "Value", name="custom").text = str(link)
    tree.find("ScenarioComponents").append(etree.Comment('Value name="other">../input/policy/inactive.xml</Value'))
    tree.write(str(cfg))
    (config.PATHS.baseline_xml / "modeltime.xml").write_text("<scenario><modeltime><end-year>2100</end-year></modeltime></scenario>")

    result = gcam_run.run_gcam(model, dry_run=True)
    assert result["inputs"]["commented_policies"] == ["inactive.xml"]
    assert result["inputs"]["policies"] == ["custom.xml"]
    assert len(result["input_warnings"]) == 2
    assert "CO2_LTG" in result["input_warnings"][0]
    assert "2100" in result["input_warnings"][1]

    def process(cmd, **kwargs):
        db_dir = kwargs["log_path"].parent / "database_basexdb"
        db_dir.mkdir()
        (db_dir / "tbl.basex").touch()
        kwargs["log_fn"]("All model periods solved correctly.")
        return 0
    monkeypatch.setattr(gcam_run, "run_streaming", process)
    assert gcam_run.run_gcam(model)["status"] == "success"
    overlay = profiles.overlay_path(model, "policy", "custom.xml")
    overlay.parent.mkdir(parents=True, exist_ok=True)
    overlay.write_text("<scenario><linked-ghg-policy name='my-link'><linked-policy>CO2_LTG</linked-policy></linked-ghg-policy></scenario>")
    corrected = gcam_run.run_gcam(model, dry_run=True, stop_year=2100)
    assert not corrected["input_warnings"]
    assert str(overlay) in Path(corrected["config"]).read_text()


def test_manual_config_edits_survive_template_switch_and_save(model):
    from backend.app.services import scenario_config
    cfg = profiles.profile_dir(model) / "config.xml"
    tree = etree.parse(str(cfg))
    comps = tree.find("ScenarioComponents")
    comps.append(etree.Comment('Value name="disabled">../input/policy/disabled.xml</Value'))
    custom = etree.SubElement(comps, "Value", name="provincial", version="manual")
    custom.text = "../input/policy/user.xml"
    tree.write(str(cfg))
    selected = config.PATHS.exe_dir / "configuration_china_ssp3.xml"
    selected.write_text("<Configuration><ScenarioComponents><Value name='socio'>../input/gcamdata/xml/socioeconomics_SSP3.xml</Value>"
                        '<--Value name="sc">../input/policy/sc.xml</Value--></ScenarioComponents></Configuration>'.replace('<--Value', '\n<--Value'))
    data = api.api_get_config(model)["data"]
    data["components"] = api.api_template_components(model, {"template":selected.name,"components":data["components"]})["data"]
    assert [r["name"] for r in data["components"]] == ["socio","provincial"]
    data["strings"] = [{"name":"scenarioName","value":"My scenario"}]
    api.api_put_config(model,data)
    with pytest.raises(api.HTTPException, match="409"):
        api.api_put_config(model,data)
    saved = etree.parse(str(cfg))
    assert saved.find("./ScenarioComponents/Value[@name='provincial']").get("version") == "manual"
    assert scenario_config.summary(saved)["commented_policies"] == ["disabled.xml"]
    assert saved.findtext("./Strings/Value[@name='scenarioName']") == "My scenario"
    assert b"<--Value" in selected.read_bytes()


def test_new_disk_policies_show_up_after_catalog_is_cached(model):
    config.PATHS.policy_dir.mkdir(parents=True,exist_ok=True)
    assert api.api_catalog_xml(kind="policy",profile_id=model)["data"] == []
    path = config.PATHS.policy_dir / "dropped.xml"
    path.write_text("<scenario name='regional'/>")
    assert api.api_catalog_xml(kind="policy",profile_id=model)["data"][0]["path"] == path.name
    path.unlink()
    assert api.api_catalog_xml(kind="policy",profile_id=model)["data"] == []


def test_import_rebases_only_existing_inputs_from_the_missing_install(model):
    from backend.app.services import scenario_config
    raw = br'<Configuration><Files><Value name="xmlInputFileName">Z:\not-a-real-install\input\gcamdata\xml\modeltime.xml</Value></Files><ScenarioComponents><Value name="core">Z:\not-a-real-install\input\gcamdata\xml\sample.xml</Value><Value name="outside">Z:\external\custom.xml</Value></ScenarioComponents></Configuration>'
    data, count = scenario_config.portable_import(raw, config.PATHS.root)
    assert count == 2
    xml = etree.fromstring(data)
    assert xml.findtext('ScenarioComponents/Value') == '../input/gcamdata/xml/sample.xml'
    assert xml.findtext("ScenarioComponents/Value[@name='outside']") == r'Z:\external\custom.xml'

def test_csv_rebuild_honors_external_edits_and_explicit_request(model, monkeypatch):
    source = config.PATHS.extdata / "external.csv"
    source.parent.mkdir(parents=True, exist_ok=True)
    source.write_text("year,value\n2025,2\n")
    baseline = r_build.run_build(model)
    assert baseline["reused_baseline"]
    source.write_text("year,value\n2025,13\n")
    assert r_build.build_is_stale(model, baseline)

    def enter_r_build(*args):
        raise RuntimeError("constructing R input mirror")
    monkeypatch.setattr(r_build, "prepare_mirror", enter_r_build)
    with pytest.raises(RuntimeError, match="constructing R input mirror"):
        r_build.run_build(model)
    clone = profiles.clone_profile(model, "without-history")["id"]
    with pytest.raises(RuntimeError, match="constructing R input mirror"):
        r_build.run_build(clone, force_from_data=True)

def test_running_profile_can_be_cloned_for_further_edits(model, monkeypatch):
    job = jobs.Job(id="running-test", kind="run", title="test", profile_id=model)
    job.status = "running"
    monkeypatch.setattr(jobs.MANAGER, "jobs", {job.id:job})
    clone = api.api_clone_profile(model, {"name":"new scenario"})["data"]["id"]
    cfg = api.api_get_config(clone)["data"]
    cfg["strings"] = [{"name":"scenarioName", "value":"edited copy"}]
    api.api_put_config(clone, cfg)
    assert api.api_run_inputs(clone)["data"]["scenario_name"] == "edited copy"
    assert api.api_run_inputs(model)["data"]["scenario_name"] != "edited copy"

def test_direct_xml_edit_starts_from_built_inputs_and_can_revert(model, tmp_path):
    document = tmp_path / "built-xml"
    document.mkdir()
    (document / "sample.xml").write_text("<scenario><GDP>12</GDP></scenario>")
    manifest = profiles.profile_dir(model) / "builds" / "built" / "manifest.json"
    manifest.parent.mkdir(parents=True)
    manifest.write_text(json.dumps({"status":"success","xml_dir":str(document),"input_signature":r_build.input_signature(model)}))
    loaded = api.api_xml_content(model, "xml", "sample.xml", run_input=True)["data"]
    assert loaded["source"] == "当前 CSV 构建" and "<GDP>12</GDP>" in loaded["text"]
    api.api_xml_save({"profile_id": model,"kind":"xml","path":"sample.xml","text":"<scenario><GDP>13</GDP></scenario>"})
    assert api.api_xml_content(model, "xml", "sample.xml", run_input=True)["data"]["is_overlay"]
    api.api_file_revert({"profile_id": model,"kind":"xml","path":"sample.xml"})
    assert api.api_xml_content(model, "xml", "sample.xml", run_input=True)["data"]["text"] == loaded["text"]
