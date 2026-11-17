"""Independent updater acceptance: synthetic archives, no network or model runs."""
from __future__ import annotations

import io
import json
import os
import shutil
import stat
import subprocess
import sys
import zipfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
from tools import source_update as updater
from tools.start_source import stamp_web

OLD = "1" * 40
NEW = "2" * 40


def candidate(root: Path, version: str = "0.1.3") -> Path:
    contents = {
        "package.json": json.dumps({"name": "gcam-china-studio", "version": version}),
        "package-lock.json": "{}",
        ".gitattributes": "*.bat text eol=crlf\n",
        "启动.bat": "@echo off\n",
        "tools/start_source.py": "print('candidate')\n",
        "tools/start-source.ps1": "Write-Host candidate\n",
        "backend/run_server.py": "print('server')\n",
        "frontend/index.html": "<html>source</html>",
        "frontend/tsconfig.json": "{}",
        "frontend/vite.config.ts": "export default {}\n",
        "frontend/src/main.tsx": "export const version = '" + version + "'\n",
        "frontend/dist/index.html": "<html>built " + version + "</html>",
        "frontend/dist/assets/main.js": "console.log('" + version + "')",
    }
    for name, content in contents.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8", newline="")
    stamp_web(root)
    return root


def bytes_under(root: Path) -> dict[str, bytes]:
    return {p.relative_to(root).as_posix(): p.read_bytes() for p in root.rglob("*") if p.is_file()
            and not p.relative_to(root).as_posix().startswith("runtime/updates/")}


def archive_bytes(root: Path, prefix: str, omit_dist: bool = False) -> bytes:
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        for path in root.rglob("*"):
            if path.is_file() and not (omit_dist and path.relative_to(root).as_posix().startswith("frontend/dist/")):
                archive.write(path, prefix + path.relative_to(root).as_posix())
    return output.getvalue()


@pytest.fixture
def installed(tmp_path):
    root = candidate(tmp_path / "installed", "0.1.2")
    (root / "backend/obsolete.py").write_text("old = True\n")
    names = [p.relative_to(root).as_posix() for p in root.rglob("*") if p.is_file()]
    # Intentionally prepare the state without trusting production whitelist code.
    import hashlib
    (root / updater.STATE).write_text(json.dumps({"repository": updater.REPOSITORY, "branch": updater.BRANCH,
        "commit": OLD, "files": {n: hashlib.sha256((root / n).read_bytes()).hexdigest() for n in names}}))
    for name in ("data/settings.json", "data/profiles/p/input.csv", "runtime/r-lib/private.txt",
                 "release/own.exe", "personal-settings.json", "tools/private-options.json"):
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(("personal: " + name).encode())
    return root


def test_declining_update_is_a_read_only_local_fallback(installed, monkeypatch):
    before = bytes_under(installed)
    urls = []
    def fetch(url, **kwargs):
        urls.append(url)
        assert "codeload" not in url
        return json.dumps({"version": "0.1.3"} if url.endswith("package.json") else {"sha": NEW}).encode()
    monkeypatch.setattr(updater, "fetch", fetch)
    assert updater.check_updates(installed, confirm=lambda _: False) is False
    assert bytes_under(installed) == before
    assert len(urls) == 2


def test_network_failure_keeps_local_installation(installed, monkeypatch):
    before = bytes_under(installed)
    def failure(*args, **kwargs):
        raise OSError("fixture offline")
    monkeypatch.setattr(updater, "fetch", failure)
    assert updater.check_updates(installed, confirm=lambda _: pytest.fail("must not prompt offline")) is False
    assert bytes_under(installed) == before


def test_fetch_overrides_no_proxy_and_falls_back_after_three_failures(monkeypatch):
    monkeypatch.setenv("NO_PROXY", "*")
    monkeypatch.setenv("no_proxy", "*")
    modes = []
    def opener(handler):
        modes.append(dict(handler.proxies))
        class Opener:
            def open(self, request, timeout):
                assert os.environ["NO_PROXY"] == "localhost,127.0.0.1"
                if len(modes) < 4:
                    raise OSError("fixture proxy offline")
                return io.BytesIO(b"fixture body")
        return Opener()
    monkeypatch.setattr(updater.urllib.request, "build_opener", opener)
    assert updater.fetch("https://example.invalid/fixture") == b"fixture body"
    assert modes[:3] == [{"http": updater.PROXY, "https": updater.PROXY}] * 3
    assert modes[3] == {}
    assert os.environ["NO_PROXY"] == os.environ["no_proxy"] == "*"


def test_http_error_does_not_trigger_unnecessary_direct_fallback(monkeypatch):
    calls = []
    def opener(handler):
        calls.append(handler)
        class Opener:
            def open(self, request, timeout):
                raise updater.urllib.error.HTTPError(request.full_url, 403, "fixture rate limit", {}, None)
        return Opener()
    monkeypatch.setattr(updater.urllib.request, "build_opener", opener)
    with pytest.raises(ValueError, match="403"):
        updater.fetch("https://example.invalid/fixture")
    assert len(calls) == 1


def test_pinned_sha_archive_updates_code_and_preserves_local_files(installed, tmp_path, monkeypatch):
    stage = candidate(tmp_path / "remote")
    import hashlib
    (stage / "distribution").mkdir()
    with zipfile.ZipFile(stage / "distribution/web.zip", "w") as bundle:
        for path in (stage / "frontend/dist").rglob("*"):
            if path.is_file():
                bundle.write(path, path.relative_to(stage).as_posix())
    (stage / "distribution/web.json").write_text(json.dumps({"sha256": hashlib.sha256((stage / "distribution/web.zip").read_bytes()).hexdigest()}))
    payload = archive_bytes(stage, "GCAM-Studio-" + NEW + "/", omit_dist=True)
    private = {name: value for name, value in bytes_under(installed).items()
               if name.startswith(("data/", "runtime/", "release/")) or name in {"personal-settings.json", "tools/private-options.json"}}
    urls, prompts = [], []
    def fetch(url, **kwargs):
        urls.append(url)
        if "codeload" in url:
            assert url.endswith("/" + NEW), "must use confirmed SHA, never moving main"
            return payload
        if url.endswith("package.json"):
            assert "/" + NEW + "/" in url
            return (stage / "package.json").read_bytes()
        return json.dumps({"sha": NEW, "commit": {"message": "fixture update"}}).encode()
    monkeypatch.setattr(updater, "fetch", fetch)
    assert updater.check_updates(installed, confirm=lambda prompt: prompts.append(prompt) or True)
    assert len(prompts) == 1 and len(urls) == 3
    assert updater.revision(installed) == NEW
    assert json.loads((installed / "package.json").read_text())["version"] == "0.1.3"
    assert not (installed / "backend/obsolete.py").exists()
    assert all((installed / name).read_bytes() == value for name, value in private.items())


@pytest.mark.parametrize("name", ["../escape.py", "/abs.py", "C:/escape.py", "\\\\host\\share\\x",
    "backend/../data/settings.json", "backend/CON.py", "tools/a.py.", "tools/a.py ", "backend//a.py"])
def test_unsafe_paths_are_rejected(name):
    with pytest.raises(ValueError):
        updater.clean_name(name)


@pytest.mark.parametrize("names", [("repo/backend/a.py", "repo/backend/A.py"), ("wrong/backend/a.py",)])
def test_archive_duplicate_or_wrong_root_is_rejected(tmp_path, names):
    data = io.BytesIO()
    with zipfile.ZipFile(data, "w") as archive:
        for name in names:
            archive.writestr(name, "pass")
    data.seek(0)
    with zipfile.ZipFile(data) as archive, pytest.raises(ValueError):
        updater.extract_checked(archive, tmp_path / "stage", "repo/", updater.program_file)


def test_archive_symlinks_are_rejected(tmp_path):
    data = io.BytesIO()
    with zipfile.ZipFile(data, "w") as archive:
        item = zipfile.ZipInfo("repo/tools/link.py")
        item.create_system = 3
        item.external_attr = (stat.S_IFLNK | 0o777) << 16
        archive.writestr(item, "../../data/settings.json")
    data.seek(0)
    with zipfile.ZipFile(data) as archive, pytest.raises(ValueError):
        updater.extract_checked(archive, tmp_path / "stage", "repo/", updater.program_file)


@pytest.mark.parametrize("name", ["data/settings.json", "runtime/local.py", "release/own.exe", ".git/config", "private.json"])
def test_protected_targets_cannot_be_written(tmp_path, name):
    with pytest.raises(ValueError):
        updater.target_path(tmp_path, name)


@pytest.mark.parametrize("failure_point", ["file", "commit-journal"])
def test_partial_install_restores_replaced_deleted_and_metadata(installed, tmp_path, monkeypatch, failure_point):
    stage = candidate(tmp_path / "remote")
    before = bytes_under(installed)
    transaction = installed / "runtime/updates/fixture-failure"
    real_write, triggered = updater.write_atomic, []
    def write(path, content):
        fail = (failure_point == "file" and path == installed / "frontend/index.html"
                or failure_point == "commit-journal" and path == transaction / "transaction.json"
                and b'"complete"' in content)
        if fail and not triggered:
            triggered.append(True)
            assert not (installed / "backend/obsolete.py").exists(), "exercise deletion rollback"
            raise OSError("fixture write failure")
        return real_write(path, content)
    monkeypatch.setattr(updater, "write_atomic", write)
    with pytest.raises(OSError, match="fixture write failure"):
        updater.install(installed, stage, NEW, transaction)
    assert triggered
    assert bytes_under(installed) == before
    assert json.loads((transaction / "transaction.json").read_text(encoding="utf-8"))["status"] == "rolled-back"


def test_crash_recovery_restores_files_and_removes_new_entries(installed):
    before = bytes_under(installed)
    transaction = installed / "runtime/updates/crashed"
    operations = []
    for name in ("package.json", "backend/obsolete.py", updater.STATE, "backend/new.py"):
        target = installed / name
        existed = target.is_file()
        if existed:
            saved = transaction / "backup" / name
            saved.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(target, saved)
        operations.append({"path": name, "existed": existed})
    (installed / "package.json").write_text('{"version":"partial"}')
    (installed / "backend/obsolete.py").unlink()
    (installed / "backend/new.py").write_text("partial=True")
    (installed / updater.STATE).write_text('{}')
    updater.save_json(transaction / "transaction.json", {"status": "applying", "commit": NEW, "git_before": None, "operations": operations})
    updater.recover(installed)
    assert bytes_under(installed) == before
    assert json.loads((transaction / "transaction.json").read_text(encoding="utf-8"))["status"] == "rolled-back"
    updater.recover(installed)
    assert bytes_under(installed) == before


def test_same_source_root_cannot_be_updated_by_two_processes(tmp_path):
    script = "from pathlib import Path; from tools.source_update import source_lock; import sys\nwith source_lock(Path(sys.argv[1])): print('acquired')"
    with updater.source_lock(tmp_path):
        other = subprocess.run([sys.executable, "-c", script, str(tmp_path)], cwd=ROOT,
                               capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=10)
        assert other.returncode != 0 and "acquired" not in other.stdout
    other = subprocess.run([sys.executable, "-c", script, str(tmp_path)], cwd=ROOT,
                           capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=10)
    assert other.returncode == 0 and "acquired" in other.stdout


def test_internal_directory_link_cannot_redirect_program_writes_to_user_data(tmp_path):
    root = tmp_path / "install"
    (root / "data").mkdir(parents=True)
    if os.name == "nt":
        # Junctions work without symlink/developer-mode privileges on Windows.
        result = subprocess.run(["cmd", "/c", "mklink", "/J", str(root / "tools"), str(root / "data")], capture_output=True)
        if result.returncode:
            pytest.skip("directory junction unavailable")
    else:
        (root / "tools").symlink_to(root / "data", target_is_directory=True)
    with pytest.raises(ValueError):
        updater.target_path(root, "tools/personal.json")


@pytest.fixture
def git_install(tmp_path):
    if not shutil.which("git"):
        pytest.skip("Git unavailable")
    root = candidate(tmp_path / "git-install", "0.1.2")
    def git(*args):
        return subprocess.check_output(["git", "-C", str(root), *args], text=True, encoding="utf-8", stderr=subprocess.STDOUT).strip()
    git("init", "-b", "main")
    git("config", "user.name", "Updater Acceptance")
    git("config", "user.email", "updater-test@example.invalid")
    git("config", "core.autocrlf", "false")
    git("add", ".")
    git("commit", "-m", "old fixture")
    old = git("rev-parse", "HEAD")
    git("checkout", "-b", "fixture-upstream")
    candidate(root, "0.1.3")
    git("add", ".")
    git("commit", "-m", "new fixture")
    new = git("rev-parse", "HEAD")
    git("checkout", "main")
    stage = candidate(tmp_path / "git-stage", "0.1.3")
    return root, stage, old, new, git


def test_git_checkout_fast_forwards_only_to_verified_commit(git_install):
    root, stage, old, new, git = git_install
    (root / "data").mkdir()
    (root / "data/settings.json").write_bytes(b"private settings")
    updater.install(root, stage, new, root / "runtime/updates/git-success")
    assert git("rev-parse", "HEAD") == new
    assert git("branch", "--show-current") == "main"
    # Git for Windows can keep a stat-only BAT M after CRLF normalization.
    # The code/index must match HEAD, and a subsequent update must be allowed.
    git("diff", "--quiet", "HEAD", "--")
    git("diff", "--cached", "--quiet", "HEAD", "--")
    names = updater.validate_candidate(stage)
    assert updater.prepare_git(root, new, names) == new
    assert (root / "data/settings.json").read_bytes() == b"private settings"


def test_git_dirty_source_is_preserved_without_update(git_install):
    root, stage, old, new, git = git_install
    (root / "backend/run_server.py").write_bytes(b"local_change = True\n")
    before = {name: value for name, value in bytes_under(root).items() if not name.startswith(".git/")}
    with pytest.raises(RuntimeError):
        updater.install(root, stage, new, root / "runtime/updates/git-dirty")
    assert git("rev-parse", "HEAD") == old
    assert {name: value for name, value in bytes_under(root).items() if not name.startswith(".git/")} == before


def test_git_staged_change_is_preserved_even_when_worktree_matches_head(git_install):
    root, stage, old, new, git = git_install
    target = root / "backend/run_server.py"
    original = target.read_bytes()
    target.write_bytes(b"staged_local_edit = True\n")
    git("add", "backend/run_server.py")
    target.write_bytes(original)
    git("diff", "--quiet", "HEAD", "--")  # Worktree alone looks clean.
    with pytest.raises(RuntimeError):
        updater.prepare_git(root, new, updater.validate_candidate(stage))
    assert git("rev-parse", "HEAD") == old
    assert git("show", ":backend/run_server.py") == "staged_local_edit = True"
    assert target.read_bytes() == original


def test_git_ignored_private_file_is_not_replaced_by_new_program_file(git_install):
    root, stage, old, new, git = git_install
    with (root / ".git/info/exclude").open("a", encoding="utf-8") as stream:
        stream.write("\ntools/private-options.json\n")
    private = root / "tools/private-options.json"
    private.write_bytes(b'{"private":"keep"}')
    (stage / "tools/private-options.json").write_bytes(b'{"remote":"different"}')
    with pytest.raises((RuntimeError, ValueError)):
        updater.install(root, stage, new, root / "runtime/updates/private-collision")
    assert private.read_bytes() == b'{"private":"keep"}'
    assert git("rev-parse", "HEAD") == old


def test_zip_unowned_private_file_collision_aborts_without_changes(installed, tmp_path):
    stage = candidate(tmp_path / "private-collision-stage")
    (stage / "tools/private-options.json").write_bytes(b'{"remote":"different"}')
    before = bytes_under(installed)
    with pytest.raises((RuntimeError, ValueError)):
        updater.install(installed, stage, NEW, installed / "runtime/updates/private-collision")
    assert bytes_under(installed) == before


@pytest.mark.skipif(os.name != "nt", reason="Windows PowerShell/Job Object handoff")
def test_powershell_exit_42_restarts_outside_old_job_and_skips_one_check(tmp_path):
    powershell = shutil.which("powershell.exe")
    if not powershell:
        pytest.skip("PowerShell unavailable")
    tools_dir = tmp_path / "source with spaces" / "tools"
    tools_dir.mkdir(parents=True)
    shutil.copy2(ROOT / "tools/start-source.ps1", tools_dir / "start-source.ps1")
    stub = f'''
import ctypes, json, pathlib, subprocess, sys
from ctypes import wintypes
sys.path.insert(0, {str(ROOT)!r})
from tools.start_source import own_process_tree
own_process_tree()
root = pathlib.Path(__file__).resolve().parent.parent
if '--skip-update' not in sys.argv:
    child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])
    (root / 'first-child.pid').write_text(str(child.pid))
    (root / 'passes.json').write_text(json.dumps(['first']))
    raise SystemExit(42)
kernel = ctypes.WinDLL('kernel32', use_last_error=True)
kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
kernel.OpenProcess.restype = wintypes.HANDLE
kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
kernel.CloseHandle.argtypes = [wintypes.HANDLE]
handle = kernel.OpenProcess(0x00100000, False, int((root / 'first-child.pid').read_text()))
if handle:
    assert kernel.WaitForSingleObject(handle, 3000) == 0, 'old Job child survived'
    kernel.CloseHandle(handle)
(root / 'passes.json').write_text(json.dumps(['first', 'restarted', sys.argv.count('--skip-update')]))
'''
    (tools_dir / "start_source.py").write_text(stub, encoding="utf-8")
    result = subprocess.run([powershell, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
                             str(tools_dir / "start-source.ps1"), "-NoBrowser"],
                            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=45,
                            creationflags=subprocess.CREATE_NO_WINDOW)
    assert result.returncode == 0, result.stdout + result.stderr
    assert json.loads((tools_dir.parent / "passes.json").read_text()) == ["first", "restarted", 1]
