from __future__ import annotations

import sys
import os
import subprocess
import json
import hashlib
import shutil
from pathlib import Path
from types import SimpleNamespace

import pytest

TOOLS = Path(__file__).resolve().parents[2] / 'tools'
sys.path.insert(0, str(TOOLS))
import start_source as launcher
import package_source


@pytest.fixture
def source(tmp_path):
    for name in ('package.json', 'package-lock.json', 'frontend/index.html', 'frontend/tsconfig.json', 'frontend/vite.config.ts'):
        path = tmp_path / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('{}')
    (tmp_path / 'frontend/src').mkdir()
    (tmp_path / 'frontend/src/main.tsx').write_text('initial')
    (tmp_path / 'frontend/dist/assets').mkdir(parents=True)
    (tmp_path / 'frontend/dist/index.html').write_text('web')
    (tmp_path / 'frontend/dist/assets/app.js').write_text('compiled')
    launcher.stamp_web(tmp_path)
    return tmp_path


def test_bundled_web_skips_node_and_invalidates_on_source_or_asset_change(source, monkeypatch):
    monkeypatch.setattr(launcher.shutil, 'which', lambda _: pytest.fail('Node should not be needed'))
    launcher.prepare_web(source)
    (source / 'frontend/src/main.tsx').write_text('changed')
    assert not launcher.web_ready(source)
    launcher.stamp_web(source)
    assert launcher.web_ready(source)
    (source / 'frontend/dist/assets/app.js').write_text('corrupt')
    assert not launcher.web_ready(source)


def test_line_endings_do_not_rebuild_bundled_web(source, monkeypatch):
    script = source / 'frontend/src/main.tsx'
    script.write_bytes(b'export const value = 1;\n')
    launcher.stamp_web(source)
    script.write_bytes(b'export const value = 1;\r\n')
    monkeypatch.setattr(launcher.shutil, 'which', lambda _: pytest.fail('Only line endings changed; Node is not needed'))
    launcher.prepare_web(source)
    assert launcher.web_ready(source)


def test_missing_vite_is_reinstalled_even_when_tsc_and_lock_marker_exist(source, monkeypatch):
    (source / 'node_modules/typescript/bin').mkdir(parents=True)
    (source / 'node_modules/typescript/bin/tsc').write_text('compiler exists')
    marker = source / 'node_modules/.studio-lock-sha256'
    marker.write_text(hashlib.sha256((source / 'package-lock.json').read_bytes()).hexdigest())
    monkeypatch.setattr(launcher, 'web_ready', lambda _: False)
    monkeypatch.setattr(launcher.shutil, 'which', lambda name: name)
    monkeypatch.setattr(launcher.subprocess, 'check_output', lambda *a, **kw: 'v22.12.0')
    probes = iter([False, True])
    monkeypatch.setattr(launcher, 'usable_web_dependencies', lambda *a: next(probes))
    downloads, builds = [], []
    monkeypatch.setattr(launcher, 'download', lambda command, **kw: downloads.append((command, kw)))
    monkeypatch.setattr(launcher.subprocess, 'run', lambda command, **kw: builds.append(command) or SimpleNamespace(returncode=0))
    launcher.prepare_web(source)
    assert len(downloads) == 1
    assert '--bin-links=true' in downloads[0][0] and '--include=dev' in downloads[0][0]
    assert downloads[0][1]['env']['ELECTRON_SKIP_BINARY_DOWNLOAD'] == '1'
    assert builds == [['npm.cmd', 'run', 'build:web']]


def test_build_script_runs_without_npm_bin_command_shims(tmp_path):
    npm = shutil.which('npm.cmd' if os.name == 'nt' else 'npm')
    if not npm or not shutil.which('node'):
        pytest.skip('Node/npm are needed for this CLI portability regression')
    script = json.loads((TOOLS.parent / 'package.json').read_text())['scripts']['build:web']
    (tmp_path / 'package.json').write_text(json.dumps({'scripts': {'build:web': script}}))
    (tmp_path / 'tools').mkdir()
    (tmp_path / 'tools/package-web.cjs').write_text('console.log("web bundle called")')
    for relative, marker in [('typescript/bin/tsc', 'compiler called'), ('vite/bin/vite.js', 'vite called')]:
        entry = tmp_path / 'node_modules' / relative
        entry.parent.mkdir(parents=True)
        entry.write_text(f'console.log({json.dumps(marker)})')
    assert not (tmp_path / 'node_modules/.bin').exists()
    result = subprocess.run([npm, 'run', 'build:web'], cwd=tmp_path, capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=20)
    assert result.returncode == 0, result.stdout + result.stderr
    assert 'compiler called' in result.stdout and 'vite called' in result.stdout


def test_download_falls_back_only_after_three_proxy_failures(tmp_path, monkeypatch):
    calls = []
    def run(command, **kwargs):
        calls.append(kwargs['env'])
        return SimpleNamespace(returncode=1 if len(calls) < 4 else 0)
    monkeypatch.setattr(launcher.subprocess, 'run', run)
    launcher.download(['example'], cwd=tmp_path, env={'HTTP_PROXY': 'old', 'CUSTOM': 'keep'})
    assert len(calls) == 4
    assert all(call['HTTP_PROXY'] == launcher.PROXY for call in calls[:3])
    assert calls[3]['HTTP_PROXY'] == '' and calls[3]['CUSTOM'] == 'keep'


def test_download_stops_after_proxy_success(tmp_path, monkeypatch):
    calls = []
    def run(command, **kwargs):
        calls.append(kwargs['env'])
        return SimpleNamespace(returncode=0)
    monkeypatch.setattr(launcher.subprocess, 'run', run)
    launcher.download(['example'], cwd=tmp_path)
    assert len(calls) == 1 and calls[0]['HTTPS_PROXY'] == launcher.PROXY


@pytest.mark.parametrize('command', [['python', '-m', 'pip', 'install', 'example'], ['npm.cmd', 'ci']])
def test_explicit_proxy_overrides_pip_npm_configuration(tmp_path, monkeypatch, command):
    calls = []
    def run(args, **kwargs):
        calls.append((args, kwargs['env']))
        return SimpleNamespace(returncode=1 if len(calls) < 4 else 0)
    monkeypatch.setattr(launcher.subprocess, 'run', run)
    launcher.download(command, cwd=tmp_path, env={'PIP_PROXY': 'wrong', 'npm_config_proxy': 'wrong', 'NPM_CONFIG_HTTPS_PROXY': 'wrong'})
    assert len(calls) == 4
    assert all(env['PIP_PROXY'] == launcher.PROXY and env['npm_config_proxy'] == launcher.PROXY for _, env in calls[:3])
    assert calls[3][1]['PIP_PROXY'] == calls[3][1]['NPM_CONFIG_HTTPS_PROXY'] == ''
    if command[0] == 'python':
        assert calls[0][0][3:5] == ['--proxy', launcher.PROXY]
        assert calls[3][0][3:5] == ['--proxy', '']
    else:
        assert '--proxy=' + launcher.PROXY in calls[0][0]
        assert '--proxy=' in calls[3][0] and '--https-proxy=' in calls[3][0]


@pytest.mark.skipif(os.name != 'nt', reason='Windows process tree lifetime')
def test_windows_job_terminates_children_when_launcher_exits(tmp_path):
    import ctypes
    from ctypes import wintypes
    script = ('from tools.start_source import own_process_tree; import subprocess,sys,pathlib; '
              'own_process_tree(); child=subprocess.Popen([sys.executable,"-c","import time; time.sleep(60)"]); '
              f'pathlib.Path({str(tmp_path / "child.pid")!r}).write_text(str(child.pid))')
    subprocess.run([sys.executable, '-c', script], cwd=TOOLS.parent, check=True, timeout=10)
    pid = int((tmp_path / 'child.pid').read_text())
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    handle = kernel.OpenProcess(0x00100000, False, pid)
    if handle:
        try:
            result = kernel.WaitForSingleObject(handle, 5000)
            if result != 0:
                subprocess.run(['taskkill', '/PID', str(pid), '/T', '/F'], capture_output=True)
            assert result == 0, 'Launcher left a running child process'
        finally:
            kernel.CloseHandle(handle)


def test_overlay_preserves_data_runtime_settings_release_and_custom_files(source, tmp_path):
    import zipfile
    for name in ('backend/app/example.py', 'desktop/main.js', 'tools/start_source.py', 'build/backend.spec', 'README.md', '.gitignore', '.gitattributes', '启动.bat'):
        path = source / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('new source')
    package = tmp_path / 'update.zip'
    package_source.build_archive(source, package)
    target = tmp_path / 'existing/GCAM-Studio'
    sentinels = {'data/settings.json': b'personal settings', 'data/profiles/one/input.csv': b'CSV edits',
                 'runtime/venv/pyvenv.cfg': b'local Python', 'release/own.exe': b'own build',
                 'custom-settings.json': b'other configuration'}
    for name, content in sentinels.items():
        path = target / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
    with zipfile.ZipFile(package) as archive:
        names = archive.namelist()
        assert [n for n in names if n.endswith('.bat')] == ['GCAM-Studio/启动.bat']
        assert not any('/data/' in n or '/runtime/' in n or '/release/' in n for n in names)
        archive.extractall(target.parent)
    assert all((target / name).read_bytes() == content for name, content in sentinels.items())
    assert (target / 'backend/app/example.py').read_text() == 'new source'


def test_cleanup_removes_only_recognized_obsolete_files(tmp_path):
    old = tmp_path / '启动 GCAM Studio.bat'
    old.write_text('ELECTRON_RUN_AS_NODE win-unpacked', encoding='utf-8')
    custom = tmp_path / 'my-custom.bat'
    custom.write_text('custom')
    settings = tmp_path / 'data/settings.json'
    settings.parent.mkdir()
    settings.write_text('{}')
    launcher.cleanup_legacy(tmp_path)
    assert not old.exists() and custom.exists() and settings.exists()
    old.write_text('custom launcher', encoding='utf-8')
    launcher.cleanup_legacy(tmp_path)
    assert old.exists()
