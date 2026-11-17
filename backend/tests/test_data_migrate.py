from __future__ import annotations

import json
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend.app.services.data_migrate import DataMigrateError, migrate_data_dir


def _seed(root: Path) -> dict[str, str]:
    run = root / "profiles" / "ssp" / "runs" / "r1"
    run.mkdir(parents=True)
    config = run / "configuration.xml"
    database = run / "database_basexdb"
    log_path = run / "gcam.log"
    xml_dir = root / "profiles" / "ssp" / "builds" / "b1" / "xml"
    outside = Path(r"G:\TFYXLab\input\gcamdata\xml")
    manifest = {
        "config": str(config),
        "db": str(database),
        "log": str(log_path),
        "xml_dir": str(xml_dir),
        "posix_db": database.as_posix(),
        "outside": str(outside),
        "note": str(root) + "-backup",
    }
    (run / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    config.write_text(
        f"<files><db>{database}</db><db2>{database.as_posix()}</db2><keep>{root}-backup</keep></files>",
        encoding="utf-8",
    )
    database.mkdir()
    (database / "tbl.basex").write_bytes(b"\xff" + str(root).encode("utf-8"))
    (database / "configuration.xml").write_bytes(b"\x00" + str(database).encode("utf-8"))
    log_path.write_text("ok", encoding="utf-8")
    (root / "cache").mkdir()
    (root / "cache" / "catalog.json").write_text("{}", encoding="utf-8")
    (root / "logs").mkdir()
    (root / "logs" / "studio.log").write_text("log", encoding="utf-8")
    (root / "settings.json").write_text('{"data_dir":"stay"}', encoding="utf-8")

    db = root / "studio.db"
    conn = sqlite3.connect(db)
    conn.execute("CREATE TABLE results (id TEXT PRIMARY KEY, path TEXT, meta TEXT)")
    conn.execute(
        "CREATE TABLE runs (id TEXT PRIMARY KEY, config_path TEXT, db_path TEXT, log_path TEXT, meta TEXT)"
    )
    conn.execute("CREATE TABLE profiles (id TEXT PRIMARY KEY, meta TEXT)")
    csv_path = run / "results.csv"
    conn.execute(
        "INSERT INTO results VALUES (?,?,?)",
        ("1", str(csv_path), json.dumps({"csv": str(csv_path), "keep": str(root) + "-backup"}, ensure_ascii=False)),
    )
    conn.execute(
        "INSERT INTO runs VALUES (?,?,?,?,?)",
        ("1", str(config), str(database), str(log_path), json.dumps({"log": str(log_path)}, ensure_ascii=False)),
    )
    conn.execute(
        "INSERT INTO profiles VALUES (?,?)",
        ("ssp", json.dumps({"db": str(database)}, ensure_ascii=False)),
    )
    conn.commit()
    conn.close()
    return manifest


def test_migrate_moves_payload_and_rewrites_paths(tmp_path: Path) -> None:
    old = tmp_path / "old"
    new = tmp_path / "new"
    old.mkdir()
    original = _seed(old)
    basex = old / "profiles" / "ssp" / "runs" / "r1" / "database_basexdb" / "tbl.basex"
    poison = (old / "profiles" / "ssp" / "runs" / "r1" / "database_basexdb" / "configuration.xml").read_bytes()
    basex_bytes = basex.read_bytes()

    moved = migrate_data_dir(old, new)

    assert moved is not None
    assert moved["from"] == str(old)
    assert moved["to"] == str(new)
    assert (old / "settings.json").read_text(encoding="utf-8") == '{"data_dir":"stay"}'
    assert not (old / "profiles").exists()
    assert not (old / "cache").exists()
    assert not (old / "logs").exists()
    assert not (old / "studio.db").exists()
    assert not (old / "studio.db-wal").exists()

    run = new / "profiles" / "ssp" / "runs" / "r1"
    manifest = json.loads((run / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["config"] == str(run / "configuration.xml")
    assert manifest["db"] == str(run / "database_basexdb")
    assert manifest["log"] == str(run / "gcam.log")
    assert manifest["xml_dir"] == str(new / "profiles" / "ssp" / "builds" / "b1" / "xml")
    assert manifest["posix_db"] == (run / "database_basexdb").as_posix()
    assert manifest["outside"] == original["outside"]
    assert manifest["note"] == str(old) + "-backup"
    xml = (run / "configuration.xml").read_text(encoding="utf-8")
    assert str(run / "database_basexdb") in xml
    assert (run / "database_basexdb").as_posix() in xml
    assert f"{old}-backup" in xml
    assert (run / "database_basexdb" / "tbl.basex").read_bytes() == basex_bytes
    assert (run / "database_basexdb" / "configuration.xml").read_bytes() == poison
    assert (new / "cache" / "catalog.json").is_file()
    assert (new / "logs").is_dir()

    conn = sqlite3.connect(new / "studio.db")
    try:
        result = conn.execute("SELECT path, meta FROM results WHERE id='1'").fetchone()
        run_row = conn.execute("SELECT config_path, db_path, log_path, meta FROM runs WHERE id='1'").fetchone()
        profile = conn.execute("SELECT meta FROM profiles WHERE id='ssp'").fetchone()
    finally:
        conn.close()
    assert result[0] == str(run / "results.csv")
    meta = json.loads(result[1])
    assert meta["csv"] == str(run / "results.csv")
    assert meta["keep"] == str(old) + "-backup"
    assert run_row[0] == str(run / "configuration.xml")
    assert run_row[1] == str(run / "database_basexdb")
    assert run_row[2] == str(run / "gcam.log")
    assert json.loads(run_row[3])["log"] == str(run / "gcam.log")
    assert json.loads(profile[0])["db"] == str(run / "database_basexdb")


def test_sidecar_files_move_with_the_database(tmp_path: Path) -> None:
    old = tmp_path / "old"
    new = tmp_path / "new"
    old.mkdir()
    (old / "logs").mkdir()
    (old / "logs" / "studio.log").write_text("log", encoding="utf-8")
    db = old / "studio.db"
    conn = sqlite3.connect(db)
    conn.execute("CREATE TABLE profiles (id TEXT PRIMARY KEY, meta TEXT)")
    conn.execute("INSERT INTO profiles VALUES ('ssp', '{}')")
    conn.commit()
    conn.close()
    (old / "studio.db-wal").write_bytes(b"wal")
    (old / "studio.db-shm").write_bytes(b"shm")

    moved = migrate_data_dir(old, new)

    assert moved is not None
    assert not (old / "studio.db").exists()
    assert not (old / "studio.db-wal").exists()
    assert not (old / "studio.db-shm").exists()
    conn = sqlite3.connect(new / "studio.db")
    try:
        assert conn.execute("SELECT id FROM profiles").fetchone()[0] == "ssp"
    finally:
        conn.close()
    assert (new / "logs" / "studio.log").is_file()


def test_same_path_and_empty_directory_do_not_move(tmp_path: Path) -> None:
    old = tmp_path / "old"
    old.mkdir()
    (old / "settings.json").write_text("{}", encoding="utf-8")
    assert migrate_data_dir(old, old) is None
    assert migrate_data_dir(old, Path(str(old) + "\\")) is None
    assert (old / "settings.json").is_file()
    assert migrate_data_dir(old, tmp_path / "new") is None
    assert not (tmp_path / "new").exists()


def test_empty_scaffold_does_not_overwrite_existing_data(tmp_path: Path) -> None:
    old = tmp_path / "old"
    new = tmp_path / "new"
    old.mkdir()
    (old / "profiles").mkdir()
    (old / "cache").mkdir()
    (old / "logs").mkdir()
    db = old / "studio.db"
    conn = sqlite3.connect(db)
    conn.execute("CREATE TABLE profiles (id TEXT PRIMARY KEY)")
    conn.commit()
    conn.close()
    (new / "profiles" / "ssp").mkdir(parents=True)
    (new / "profiles" / "ssp" / "profile.json").write_text('{"id":"ssp"}', encoding="utf-8")

    assert migrate_data_dir(old, new) is None
    assert (new / "profiles" / "ssp" / "profile.json").is_file()
    assert (old / "studio.db").is_file()


def test_empty_destination_directory_does_not_nest_profiles(tmp_path: Path) -> None:
    old = tmp_path / "old"
    new = tmp_path / "new"
    old.mkdir()
    (old / "profiles").mkdir()
    (old / "profiles" / "keep.txt").write_text("old", encoding="utf-8")
    (new / "profiles").mkdir(parents=True)

    moved = migrate_data_dir(old, new)

    assert moved is not None
    assert (new / "profiles" / "keep.txt").read_text(encoding="utf-8") == "old"
    assert not (new / "profiles" / "profiles").exists()


def test_reject_nested_directories(tmp_path: Path) -> None:
    old = tmp_path / "old"
    old.mkdir()
    (old / "profiles").mkdir()
    nested = old / "nested"
    try:
        migrate_data_dir(old, nested)
    except DataMigrateError as exc:
        assert "不能" in str(exc)
    else:
        raise AssertionError("expected nested destination to be rejected")
    assert (old / "profiles").is_dir()
    assert not nested.exists()

    parent = tmp_path / "parent"
    child = parent / "child"
    child.mkdir(parents=True)
    (child / "logs").mkdir()
    try:
        migrate_data_dir(child, parent)
    except DataMigrateError as exc:
        assert "不能" in str(exc)
    else:
        raise AssertionError("expected parent destination to be rejected")
    assert (child / "logs").is_dir()


def test_reject_when_destination_already_has_payload(tmp_path: Path) -> None:
    old = tmp_path / "old"
    new = tmp_path / "new"
    old.mkdir()
    new.mkdir()
    (old / "profiles").mkdir()
    (old / "profiles" / "keep.txt").write_text("old", encoding="utf-8")
    (new / "profiles").mkdir()
    (new / "profiles" / "keep.txt").write_text("new", encoding="utf-8")

    try:
        migrate_data_dir(old, new)
    except DataMigrateError as exc:
        assert "已有数据" in str(exc)
    else:
        raise AssertionError("expected occupied destination to be rejected")
    assert (old / "profiles" / "keep.txt").read_text(encoding="utf-8") == "old"
    assert (new / "profiles" / "keep.txt").read_text(encoding="utf-8") == "new"


def test_rollback_when_rewrite_fails(tmp_path: Path, monkeypatch) -> None:
    old = tmp_path / "old"
    new = tmp_path / "new"
    old.mkdir()
    _seed(old)

    def boom(*_args, **_kwargs):
        raise RuntimeError("boom")

    monkeypatch.setattr("backend.app.services.data_migrate._rewrite_tree", boom)
    try:
        migrate_data_dir(old, new)
    except DataMigrateError as exc:
        assert "boom" in str(exc)
    else:
        raise AssertionError("expected rewrite failure to roll back")
    assert (old / "profiles" / "ssp" / "runs" / "r1" / "manifest.json").is_file()
    assert (old / "studio.db").is_file()
    assert (old / "settings.json").is_file()
    assert not (new / "profiles").exists()
    assert not (new / "studio.db").exists()
