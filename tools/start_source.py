"""Run the source edition without Electron, PyInstaller or administrator rights."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.request
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PROXY = 'http://127.0.0.1:1080'
_JOB_HANDLE = None  # Kept open until the launcher process exits; never inherited.
R_PACKAGES = ('pkgload', 'dplyr', 'tidyr', 'readr', 'data.table', 'stringr', 'xml2', 'assertthat')
PROBE = '''import importlib.metadata as m, sys, struct, re
assert sys.version_info >= (3,11) and struct.calcsize('P') == 8
import uvicorn, fastapi, pandas, lxml, openpyxl, pydantic, multipart
for package, minimum in [('fastapi',(0,115)),('uvicorn',(0,30)),('pydantic',(2,7)),('python-multipart',(0,0,9)),('pandas',(2,2)),('lxml',(5,0)),('openpyxl',(3,1))]:
    version=tuple(int(x) for x in re.match(r'([0-9.]+)',m.version(package))[1].split('.'))
    assert version >= minimum, package
'''


def say(message: str) -> None:
    print(message, flush=True)


def own_process_tree() -> None:
    """Windows closes this handle even when the user closes the console window."""
    global _JOB_HANDLE
    if os.name != 'nt' or _JOB_HANDLE is not None:
        return
    import ctypes
    from ctypes import wintypes

    class BasicLimits(ctypes.Structure):
        _fields_ = [('process_time', ctypes.c_longlong), ('job_time', ctypes.c_longlong),
                    ('flags', wintypes.DWORD), ('min_working', ctypes.c_size_t), ('max_working', ctypes.c_size_t),
                    ('active_limit', wintypes.DWORD), ('affinity', ctypes.c_size_t),
                    ('priority', wintypes.DWORD), ('scheduling', wintypes.DWORD)]

    class IoCounters(ctypes.Structure):
        _fields_ = [(name, ctypes.c_ulonglong) for name in ('read_ops', 'write_ops', 'other_ops', 'read_bytes', 'write_bytes', 'other_bytes')]

    class ExtendedLimits(ctypes.Structure):
        _fields_ = [('basic', BasicLimits), ('io', IoCounters), ('process_memory', ctypes.c_size_t),
                    ('job_memory', ctypes.c_size_t), ('peak_process_memory', ctypes.c_size_t), ('peak_job_memory', ctypes.c_size_t)]

    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
    kernel.CreateJobObjectW.restype = wintypes.HANDLE
    kernel.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
    kernel.SetInformationJobObject.restype = wintypes.BOOL
    kernel.GetCurrentProcess.restype = wintypes.HANDLE
    kernel.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    kernel.AssignProcessToJobObject.restype = wintypes.BOOL
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    handle = kernel.CreateJobObjectW(None, None)
    if not handle:
        raise ctypes.WinError(ctypes.get_last_error())
    limits = ExtendedLimits()
    limits.basic.flags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    if (not kernel.SetInformationJobObject(handle, 9, ctypes.byref(limits), ctypes.sizeof(limits))
            or not kernel.AssignProcessToJobObject(handle, kernel.GetCurrentProcess())):
        error = ctypes.get_last_error()
        kernel.CloseHandle(handle)
        raise ctypes.WinError(error)
    _JOB_HANDLE = handle


def download(command: list[str], *, cwd: Path, env: dict[str, str] | None = None) -> None:
    """Each installation operation gets three explicit proxy attempts first."""
    original = dict(env if env is not None else os.environ)
    def network_mode(proxy):
        env = original.copy()
        proxy_keys = {'http_proxy', 'https_proxy', 'all_proxy', 'pip_proxy', 'npm_config_proxy', 'npm_config_https_proxy', 'npm_config_http_proxy'}
        for key in set(env) | {name.upper() for name in proxy_keys} | proxy_keys:
            if key.lower() in proxy_keys:
                env[key] = proxy
        env['NO_PROXY'] = env['no_proxy'] = 'localhost,127.0.0.1'
        args = list(command)
        if '-m' in args and args[args.index('-m') + 1] == 'pip':
            index = args.index('-m') + 2
            args[index:index] = ['--proxy', proxy]
        elif Path(args[0]).name.lower() in ('npm', 'npm.cmd'):
            args += [f'--proxy={proxy}', f'--https-proxy={proxy}', '--noproxy=localhost,127.0.0.1']
        return args, env

    proxied_command, proxied = network_mode(PROXY)
    for attempt in range(1, 4):
        say(f'[网络] 本地代理下载尝试 {attempt}/3')
        if subprocess.run(proxied_command, cwd=cwd, env=proxied).returncode == 0:
            return
    say('[网络] 本次操作通过本地代理连续失败三次，改为直连。')
    direct_command, direct = network_mode('')
    if subprocess.run(direct_command, cwd=cwd, env=direct).returncode:
        raise RuntimeError('依赖下载失败，请检查网络后重新运行启动.bat。')


def usable_backend(python: Path) -> bool:
    if not python.is_file():
        return False
    try:
        return subprocess.run([str(python), '-X', 'utf8', '-c', PROBE], capture_output=True, timeout=30).returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def backend_python(root: Path) -> Path:
    for python in (root / 'runtime/venv-source/Scripts/python.exe', root / 'runtime/venv-local/Scripts/python.exe',
                   root / 'runtime/venv/Scripts/python.exe'):
        if usable_backend(python):
            say(f'[环境] 复用 Python：{python}')
            return python
    environment = root / 'runtime/venv-source'
    python = environment / 'Scripts/python.exe'
    say('[环境] 正在配置本机 Python 环境；原有环境和数据会保留。')
    # A copied virtualenv may reference a Python installation from another PC.
    if Path(sys.executable).resolve() != python.resolve():
        subprocess.run([sys.executable, '-m', 'venv', str(environment)], cwd=root, check=True)
    download([str(python), '-m', 'pip', 'install', '--upgrade', '--retries', '0', '--timeout', '20',
              '--disable-pip-version-check', '-r', str(root / 'backend/requirements.txt')], cwd=root)
    if not usable_backend(python):
        raise RuntimeError('Python 依赖无法加载，请查看上方输出。')
    return python


def web_signature(root: Path) -> str:
    names = ['package.json', 'package-lock.json', 'frontend/index.html', 'frontend/tsconfig.json', 'frontend/vite.config.ts']
    names += sorted(p.relative_to(root).as_posix() for p in (root / 'frontend/src').rglob('*') if p.is_file())
    digest = hashlib.sha256()
    for name in names:
        content = (root / name).read_bytes()
        if Path(name).suffix.lower() in {'.json', '.html', '.ts', '.tsx', '.js', '.jsx', '.css', '.scss', '.svg'}:
            content = content.replace(b'\r\n', b'\n')
        digest.update(name.encode('utf-8') + b'\0' + content + b'\0')
    return digest.hexdigest()


def stamp_web(root: Path) -> None:
    dist = root / 'frontend/dist'
    files = {p.relative_to(dist).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
             for p in sorted(dist.rglob('*')) if p.is_file() and p.name != '.studio-build.json'}
    if 'index.html' not in files or not any(name.startswith('assets/') for name in files):
        raise RuntimeError('前端构建产物不完整。')
    (dist / '.studio-build.json').write_text(json.dumps({'source': web_signature(root), 'files': files}), encoding='utf-8')


def web_ready(root: Path) -> bool:
    dist = root / 'frontend/dist'
    try:
        stamp = json.loads((dist / '.studio-build.json').read_text(encoding='utf-8'))
        return (stamp['source'] == web_signature(root) and 'index.html' in stamp['files']
                and any(name.startswith('assets/') for name in stamp['files'])
                and all((dist / name).resolve().is_relative_to(dist.resolve()) and hashlib.sha256((dist / name).read_bytes()).hexdigest() == expected
                        for name, expected in stamp['files'].items()))
    except (OSError, ValueError, KeyError, TypeError):
        return False


def usable_web_dependencies(root: Path, node: str) -> bool:
    for relative in ('node_modules/typescript/bin/tsc', 'node_modules/vite/bin/vite.js'):
        entry = root / relative
        if not entry.is_file():
            return False
        try:
            if subprocess.run([node, str(entry), '--version'], cwd=root, capture_output=True, timeout=20).returncode:
                return False
        except (OSError, subprocess.TimeoutExpired):
            return False
    return True


def prepare_web(root: Path) -> None:
    if web_ready(root):
        say('[前端] 使用与源码一致的网页文件，无需 Node.js 或 exe。')
        return
    node, npm = shutil.which('node'), shutil.which('npm.cmd')
    if not node or not npm:
        raise RuntimeError('网页源码已变化或网页文件缺失。请安装 Node.js 20.19+（或22.12+），然后重新运行启动.bat。')
    version = subprocess.check_output([node, '--version'], text=True).strip()
    parts = tuple(int(x) for x in version.lstrip('v').split('.')[:2])
    if not (parts[0] == 20 and parts >= (20, 19) or parts >= (22, 12)):
        raise RuntimeError(f'Node.js {version} 不支持当前前端，请安装 Node.js 20.19+ 或22.12+。')
    marker = root / 'node_modules/.studio-lock-sha256'
    lock = hashlib.sha256((root / 'package-lock.json').read_bytes()).hexdigest()
    dependencies_ok = usable_web_dependencies(root, node)
    if not marker.is_file() and dependencies_ok:
        installed = subprocess.run([npm, 'ls', '--depth=0'], cwd=root, capture_output=True)
        if installed.returncode == 0:
            marker.write_text(lock, encoding='ascii')
    if not dependencies_ok or not marker.is_file() or marker.read_text().strip() != lock:
        env = os.environ.copy()
        # Running the source edition needs web dependencies, not Electron.exe.
        env['ELECTRON_SKIP_BINARY_DOWNLOAD'] = '1'
        download([npm, 'ci', '--include=dev', '--bin-links=true', '--fetch-retries=0', '--fetch-timeout=20000'], cwd=root, env=env)
        if not usable_web_dependencies(root, node):
            raise RuntimeError('前端依赖安装后仍无法加载 TypeScript 或 Vite，请检查上方安装输出。')
        marker.write_text(lock, encoding='ascii')
    say('[前端] 正在根据当前源码更新网页文件……')
    subprocess.run([npm, 'run', 'build:web'], cwd=root, check=True)
    stamp_web(root)


def prepare_r(root: Path) -> None:
    sys.path.insert(0, str(root))
    from backend.app.config import SETTINGS, env_for_tools
    if not SETTINGS.rscript:
        say('[R] 尚未找到 Rscript，可在打开后的“设置与诊断”中配置；保存后重新启动即可安装所需 R 包。')
        return
    env = env_for_tools(SETTINGS)
    packages = ','.join(json.dumps(p) for p in R_PACKAGES)
    check = f'for(p in c({packages})) loadNamespace(p)'
    probe = subprocess.run([SETTINGS.rscript, '--vanilla', '-e', check], env=env, capture_output=True, timeout=60)
    if probe.returncode == 0:
        say('[R] 所需 R 包已就绪。')
        return
    say('[R] 正在为本机安装所需 R 包，首次安装需要联网。')
    lib = root / 'runtime/r-lib'
    lib.mkdir(parents=True, exist_ok=True)
    install = (f'pkgs<-c({packages}); lib<-Sys.getenv("R_LIBS_USER"); .libPaths(c(lib,.libPaths())); '
               'need<-pkgs[!vapply(pkgs,function(p) tryCatch({loadNamespace(p);TRUE},error=function(e) FALSE),logical(1))]; '
               'options(download.file.method="libcurl"); '
               'if(length(need)) install.packages(need,lib=lib,repos="https://cloud.r-project.org",type="binary"); '
               'for(p in pkgs) loadNamespace(p)')
    download([SETTINGS.rscript, '--vanilla', '-e', install], cwd=root, env=env)


def cleanup_legacy(root: Path) -> None:
    signatures = {'启动 GCAM Studio.bat': ('ELECTRON_RUN_AS_NODE', 'win-unpacked'),
                  '验收与故障说明.txt': ('GCAM-China Studio 0.1.1 修复与验收说明',)}
    for name, required in signatures.items():
        path = root / name
        if path.is_file() and all(text in path.read_text(encoding='utf-8-sig', errors='replace') for text in required):
            path.unlink()
            say(f'[更新] 已清理旧文件：{name}')


def open_when_ready(url: str, server: subprocess.Popen) -> None:
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    for _ in range(120):
        if server.poll() is not None:
            return
        try:
            with opener.open(url, timeout=1) as response:
                if response.status == 200:
                    webbrowser.open(url)
                    return
        except OSError:
            pass
        time.sleep(0.5)
    say(f'[浏览器] 请手动打开 {url}')


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=int(os.environ.get('GCAM_STUDIO_PORT', '8765')))
    parser.add_argument('--no-browser', action='store_true', default=os.environ.get('GCAM_STUDIO_NO_BROWSER') == '1')
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        raise RuntimeError('端口必须为1–65535。')
    own_process_tree()
    os.chdir(ROOT)
    os.environ['PYTHONUTF8'] = '1'
    os.environ['GCAM_STUDIO_HOME'] = str(ROOT)
    os.environ['GCAM_STUDIO_WEB_DIR'] = str(ROOT / 'frontend/dist')
    os.environ.setdefault('GCAM_STUDIO_DATA_DIR', str(ROOT / 'data'))
    version = json.loads((ROOT / 'package.json').read_text(encoding='utf-8'))['version']
    say(f'[源码启动器] GCAM-China Studio {version}')
    cleanup_legacy(ROOT)
    python = backend_python(ROOT)
    prepare_web(ROOT)
    # Run R setup in the selected environment, where backend dependencies exist.
    subprocess.run([str(python), '-X', 'utf8', '-c', 'from tools.start_source import prepare_r, ROOT; prepare_r(ROOT)'], cwd=ROOT, check=True)
    if args.check:
        say('[完成] 源码运行环境检查通过。')
        return 0
    with socket.socket() as listener:
        try:
            listener.bind(('0.0.0.0', args.port))
        except OSError as exc:
            raise RuntimeError(f'端口 {args.port} 已被占用，请先关闭旧的启动窗口。') from exc
    url = f'http://127.0.0.1:{args.port}'
    say(f'[启动] 正在直接运行源码：{url}\n关闭此窗口或按 Ctrl+C 停止服务。')
    server = subprocess.Popen([str(python), '-X', 'utf8', str(ROOT / 'backend/run_server.py'), '--host', '0.0.0.0', '--port', str(args.port)], cwd=ROOT)
    if not args.no_browser:
        threading.Thread(target=open_when_ready, args=(url, server), daemon=True).start()
    try:
        return server.wait()
    except KeyboardInterrupt:
        return 0
    finally:
        if server.poll() is None:
            server.terminate()
            try:
                server.wait(timeout=10)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait()


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (RuntimeError, OSError, subprocess.SubprocessError) as error:
        say(f'\n[错误] {error}')
        raise SystemExit(1)
