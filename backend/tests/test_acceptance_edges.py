"""Independent acceptance tests; all model files and processes are fixtures."""
from __future__ import annotations

import asyncio
import json

import pytest

from backend.tests.test_run_pipeline import model
from backend.app import api
from backend.app.services import gcam_run, jobs, r_build, queries
from backend.app.services.processes import JobCancelled


def test_sse_rebases_cursor_when_buffer_truncates_during_delivery(monkeypatch):
    job = jobs.Job(id="acceptance-log", kind="run", title="acceptance")
    job.log("initial")
    monkeypatch.setattr(api.jobs.MANAGER, "get", lambda _: job)

    class Request:
        headers = {}
        async def is_disconnected(self):
            return False

    async def check():
        response = await api.api_job_events(job.id, Request())
        stream = response.body_iterator
        first = await anext(stream)
        assert "id: 0\n" in first
        # Emulate a client paused while the model emits enough output to evict
        # two buffers. A live stream must resume at the earliest retained ID.
        for index in range(40000):
            job.log(str(index))
        event = await anext(stream)
        assert event.startswith(f"id: {job.log_offset}\n")
        await stream.aclose()

    asyncio.run(check())


def test_run_request_records_history_when_requested_rebuild_fails(model, monkeypatch):
    captured = {}
    job = jobs.Job(id="acceptance-build", kind="run", title="acceptance", profile_id=model)

    def submit(kind, title, fn, **kwargs):
        captured["fn"] = fn
        return job

    def fail_build(*args, **kwargs):
        raise RuntimeError("fixture R failure")

    monkeypatch.setattr(api.jobs.MANAGER, "submit", submit)
    monkeypatch.setattr(r_build, "run_build", fail_build)
    api.api_start_run(model, {"rebuild": True})
    with pytest.raises(RuntimeError, match="fixture R failure"):
        captured["fn"](job)
    history = gcam_run.list_runs(model)
    assert len(history) == 1
    assert history[0]["status"] == "failed"
    assert history[0]["stage"] == "build"


def test_region_discovery_propagates_cancellation(model, tmp_path, monkeypatch):
    callback = object()
    def cancelled(*args, **kwargs):
        assert kwargs["process_cb"] is callback
        raise JobCancelled("fixture cancelled before Java")
    monkeypatch.setattr(queries, "run_streaming", cancelled)
    with pytest.raises(JobCancelled):
        queries.get_db_regions(tmp_path / "database", process_cb=callback)


@pytest.mark.parametrize("cancelled,expected", [(False, "failed"), (True, "cancelled")])
def test_build_failure_manifest_survives(model, monkeypatch, cancelled, expected):
    job = jobs.Job(id="build-evidence", kind="build", title="acceptance", cancel_requested=cancelled)
    def failed(*args, **kwargs):
        raise RuntimeError("fixture build stopped")
    monkeypatch.setattr(r_build, "_run_build", failed)
    with pytest.raises(RuntimeError, match="fixture build stopped"):
        r_build.run_build(model, process_cb=job.register_process)
    from backend.app.services import profiles
    manifests = list((profiles.profile_dir(model) / "builds").glob("*/manifest.json"))
    assert len(manifests) == 1
    data = json.loads(manifests[0].read_text(encoding="utf-8"))
    assert data["status"] == expected
    assert data["finished_at"]
    assert "fixture build stopped" in data["error"]


def test_numeric_edit_preserves_existing_gcam_na_markers(model):
    from backend.app import config
    from backend.app.services import profiles, files
    source = config.PATHS.extdata / "missing.csv"
    source.parent.mkdir(parents=True, exist_ok=True)
    source.write_text(
        "# Column types: cnn\n# ----------\nregion,pcGDP_start_NSPS,NSPS_start_year\nChina,NA,2025\n",
        encoding="utf-8",
    )
    result = files.edit_cells(model, "data", "missing.csv", [{"row": 0, "column": "NSPS_start_year", "value": "2030"}])
    assert result["changed"] == 1
    assert "China,NA,2030" in profiles.overlay_path(model, "data", "missing.csv").read_text(encoding="utf-8-sig")


def test_calculated_year_resets_for_new_run_and_ignores_unsolved_attempt(tmp_path):
    log = tmp_path / "gcam.log"
    log.write_text(
        "Model run beginning.\nPeriod 21: 2100\nModel solved normally. Iterations period 21: 10\n"
        "Model run beginning.\nPeriod 5: 2021\nModel solved with last period's prices.\n"
        "Period 6: 2025\nModel solved normally. Iterations period 6: 100\n"
        "Period 7: 2030\nModel did not solve period 7 within set iteration 15000\n",
        encoding="utf-8",
    )
    assert gcam_run.last_calculated_year({"log": str(log), "stop_year": 2100}) == 2025
