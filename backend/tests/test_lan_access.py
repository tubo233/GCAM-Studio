from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from fastapi.testclient import TestClient

from backend.app.api import app


def test_remote_client_cannot_change_settings_or_browse(tmp_path: Path) -> None:
    settings = ROOT / "data" / "settings.json"
    original = settings.read_bytes() if settings.is_file() else None
    remote = TestClient(app, client=("203.0.113.10", 50000))
    try:
        health = remote.get("/api/health")
        assert health.status_code == 200
        assert health.json()["data"]["can_edit_settings"] is False
        denied = remote.put("/api/settings", json={"gcam_root": r"C:\not-allowed"})
        assert denied.status_code == 403
        assert remote.get("/api/fs/drives").status_code == 403
        assert remote.get("/api/fs/list", params={"path": str(tmp_path)}).status_code == 403
    finally:
        if original is not None and settings.is_file() and settings.read_bytes() != original:
            settings.write_bytes(original)


def test_local_client_can_browse_one_directory(tmp_path: Path) -> None:
    (tmp_path / "nested").mkdir()
    (tmp_path / "note.txt").write_text("a", encoding="utf-8")
    local = TestClient(app, client=("127.0.0.1", 50000))
    health = local.get("/api/health")
    assert health.status_code == 200
    assert health.json()["data"]["can_edit_settings"] is True
    listing = local.get("/api/fs/list", params={"path": str(tmp_path)})
    assert listing.status_code == 200
    body = listing.json()["data"]
    assert [item["name"] for item in body["dirs"]] == ["nested"]
    assert [item["name"] for item in body["files"]] == ["note.txt"]
    assert local.get("/api/fs/list", params={"path": "relative\\folder"}).status_code == 400
