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
