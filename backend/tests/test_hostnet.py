from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend.app.hostnet import HostPathError, is_local_client, list_directory


def test_loopback_and_own_nic_are_local() -> None:
    local = {"192.168.1.20", "::ffff:10.0.0.8"}
    assert is_local_client("127.0.0.1", local)
    assert is_local_client("::1", local)
    assert is_local_client("::ffff:127.0.0.1", local)
    assert is_local_client("192.168.1.20", local)
    assert is_local_client("10.0.0.8", local)
    assert is_local_client("fe80::1%12", {"fe80::1"})


def test_other_computers_are_not_local() -> None:
    local = {"192.168.1.20"}
    assert not is_local_client("192.168.1.21", local)
    assert not is_local_client("", local)
    assert not is_local_client(None, local)


def test_list_directory_is_one_level(tmp_path: Path) -> None:
    nested = tmp_path / "nested"
    nested.mkdir()
    (tmp_path / "note.txt").write_text("a", encoding="utf-8")
    (nested / "inner.txt").write_text("b", encoding="utf-8")

    listing = list_directory(str(tmp_path))
    assert listing["path"] == str(tmp_path.resolve())
    assert [item["name"] for item in listing["dirs"]] == ["nested"]
    assert [item["name"] for item in listing["files"]] == ["note.txt"]
    assert listing["parent"] == str(tmp_path.resolve().parent)


def test_list_directory_rejects_relative_path() -> None:
    try:
        list_directory("relative\\folder")
    except HostPathError:
        return
    raise AssertionError("relative path should be rejected")
