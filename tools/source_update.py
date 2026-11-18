"""Recoverable source updates for both ZIP and Git installations."""
from __future__ import annotations

import contextlib
import hashlib
import json
import os
import re
import shutil
import socket
import stat
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid
import zipfile
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath

REPOSITORY = 'tubo233/GCAM-Studio'
BRANCH = 'main'
PROXY = 'http://127.0.0.1:1080'
STATE = '.studio-version.json'
ROOT_FILES = {'package.json', 'package-lock.json', 'README.md', '.gitignore', '.gitattributes', '启动.bat', 'build/backend.spec', 'frontend/index.html'}
REQUIRED = {'package.json', 'package-lock.json', '启动.bat', 'tools/start_source.py', 'tools/start-source.ps1', 'backend/run_server.py', 'frontend/index.html'}


class RecoveryError(RuntimeError):
    pass


def program_file(name: str) -> bool:
    if name in ROOT_FILES:
        return True
    parts = PurePosixPath(name).parts
    if len(parts) < 2 or any(p in {'.git', '__pycache__', 'node_modules', 'data', 'runtime', 'release'} for p in parts):
        return False
    extension = PurePosixPath(name).suffix.lower()
    return (parts[0] == 'backend' and extension in {'.py', '.txt', '.json'}
            or parts[0] == 'tools' and extension in {'.py', '.ps1', '.cjs', '.js', '.json'}
            or parts[0] == 'desktop' and extension in {'.js', '.json'}
            or name in {'frontend/tsconfig.json', 'frontend/vite.config.ts'}
            or name.startswith('frontend/src/') and extension in {'.ts', '.tsx', '.css', '.js', '.json', '.svg', '.png'}
            or name.startswith('frontend/dist/') and extension in {'.js', '.css', '.json', '.html', '.svg', '.ttf', '.png', '.ico', '.map'}
            or name in {'distribution/web.zip', 'distribution/web.json'})


def clean_name(name: str) -> str:
    if not name or name.startswith('/') or '\\' in name or ':' in name or '\x00' in name:
        raise ValueError('更新包中包含非法路径。')
    parts = name.rstrip('/').split('/')
    if any(p in {'', '.', '..'} or p[-1:] in {' ', '.'} or re.match(r'(?i)^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)', p) for p in parts):
        raise ValueError('更新包中包含不安全的文件名。')
    return '/'.join(parts)


def target_path(root: Path, name: str) -> Path:
    name = clean_name(name)
    if name != STATE and not program_file(name):
        raise ValueError(f'更新禁止覆盖该路径：{name}')
    path = root / name
    if not path.resolve().is_relative_to(root.resolve()) or path.is_symlink():
        raise ValueError(f'更新路径指向程序目录以外：{name}')
    current = root
    for part in PurePosixPath(name).parts:
        current = current / part
        if current.exists() or current.is_symlink():
            attributes = getattr(current.lstat(), 'st_file_attributes', 0)
            if current.is_symlink() or attributes & 0x400:  # Windows junction/reparse point
                raise ValueError(f'更新路径包含目录或文件链接：{name}')
    return path


def write_atomic(path: Path, content: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name('.' + path.name + '.studio-' + uuid.uuid4().hex + '.tmp')
    try:
        with temporary.open('wb') as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def save_json(path: Path, value: dict) -> None:
    write_atomic(path, json.dumps(value, ensure_ascii=False, indent=2).encode('utf-8'))


@contextlib.contextmanager
def source_lock(root: Path):
    path = root / 'runtime/source-launch.lock'
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('a+b') as stream:
        if path.stat().st_size == 0:
            stream.write(b'0'); stream.flush()
        stream.seek(0)
        try:
            if os.name == 'nt':
                import msvcrt
                msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            raise RuntimeError('此源码目录已有启动窗口，请先关闭它再启动或更新。') from exc
        try:
            yield
        finally:
            stream.seek(0)
            if os.name == 'nt':
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(stream, fcntl.LOCK_UN)


def fetch(url: str, *, limit: int = 1024 * 1024, timeout: int = 15) -> bytes:
    def request(proxy):
        handler = urllib.request.ProxyHandler({'http': proxy, 'https': proxy} if proxy else {})
        opener = urllib.request.build_opener(handler)
        req = urllib.request.Request(url, headers={'User-Agent': 'GCAM-Studio-source-updater', 'Accept': 'application/vnd.github+json'})
        old_bypass = {key: os.environ.get(key) for key in ('NO_PROXY', 'no_proxy')}
        try:
            # Explicit proxy selection must not inherit NO_PROXY=*.
            os.environ['NO_PROXY'] = os.environ['no_proxy'] = 'localhost,127.0.0.1'
            with opener.open(req, timeout=timeout) as response:
                chunks, length, started = [], 0, time.monotonic()
                while True:
                    block = getattr(response, 'read1', response.read)(min(65536, limit + 1 - length))
                    if not block:
                        return b''.join(chunks)
                    chunks.append(block); length += len(block)
                    if length > limit:
                        raise ValueError('GitHub 返回的更新文件超过大小限制。')
                    if time.monotonic() - started > 60:
                        raise TimeoutError('更新下载超过60秒。')
        except urllib.error.HTTPError as exc:
            # A server response is not a proxy connection failure.
            raise ValueError(f'GitHub 返回 HTTP {exc.code}，本次暂不检查更新。') from exc
        finally:
            for key, value in old_bypass.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value
    for attempt in range(1, 4):
        try:
            return request(PROXY)
        except (OSError, TimeoutError) as exc:
            print(f'[更新] 本地代理连接失败 {attempt}/3：{type(exc).__name__}', flush=True)
    print('[更新] 代理连续失败三次，改为直连。', flush=True)
    return request('')


def git(root: Path, *args: str, check=True) -> subprocess.CompletedProcess:
    command = shutil.which('git')
    if not command:
        raise RuntimeError('Git 检出目录需要安装 Git 后才能自动更新。')
    result = subprocess.run([command, '-C', str(root), *args], capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=30)
    if check and result.returncode:
        raise RuntimeError((result.stderr or result.stdout).strip()[-800:])
    return result


def git_root(root: Path) -> bool:
    if not (root / '.git').exists():
        return False
    return Path(git(root, 'rev-parse', '--show-toplevel').stdout.strip()).resolve() == root.resolve()


def read_state(root: Path) -> dict:
    try:
        data = json.loads((root / STATE).read_text(encoding='utf-8'))
        if isinstance(data, dict) and data.get('repository') == REPOSITORY and data.get('branch') == BRANCH:
            return data
    except (OSError, ValueError):
        pass
    return {}


def revision(root: Path) -> str | None:
    if git_root(root):
        return git(root, 'rev-parse', 'HEAD').stdout.strip()
    sha = read_state(root).get('commit')
    return sha if isinstance(sha, str) and re.fullmatch('[0-9a-f]{40}', sha) else None


def snapshot(root: Path, commit: str | None, names: list[str]) -> dict:
    return {'repository': REPOSITORY, 'branch': BRANCH, 'commit': commit,
            'version': json.loads((root / 'package.json').read_text(encoding='utf-8')).get('version', 'unknown'),
            'files': {name: hashlib.sha256(target_path(root, name).read_bytes()).hexdigest() for name in sorted(names)}}


def extract_checked(archive: zipfile.ZipFile, destination: Path, prefix: str, allowed) -> list[str]:
    seen, selected, size = set(), [], 0
    if len(archive.infolist()) > 5000:
        raise ValueError('更新包文件数量异常。')
    for info in archive.infolist():
        name = clean_name(info.filename)
        if not name.startswith(prefix) and name != prefix.rstrip('/'):
            raise ValueError('更新包目录与指定提交不一致。')
        relative = name[len(prefix):]
        if not relative or info.is_dir():
            continue
        if stat.S_IFMT(info.external_attr >> 16) == stat.S_IFLNK or relative.casefold() in seen:
            raise ValueError('更新包包含链接或重复文件名。')
        seen.add(relative.casefold())
        size += info.file_size
        if info.file_size > 20 * 1024 * 1024 or size > 100 * 1024 * 1024:
            raise ValueError('更新包解压大小超过限制。')
        if allowed(relative):
            path = target_path(destination, relative)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(archive.read(info))
            selected.append(relative)
    return selected


def validate_candidate(stage: Path) -> list[str]:
    from tools.start_source import web_ready
    if any(not (stage / name).is_file() for name in REQUIRED):
        raise ValueError('更新包缺少启动所需的源码文件。')
    package = json.loads((stage / 'package.json').read_text(encoding='utf-8'))
    if package.get('name') != 'gcam-china-studio' or not isinstance(package.get('version'), str):
        raise ValueError('更新包不是 GCAM-China Studio。')
    bundle = stage / 'distribution/web.zip'
    description = stage / 'distribution/web.json'
    if bundle.is_file() and description.is_file():
        manifest = json.loads(description.read_text(encoding='utf-8'))
        if hashlib.sha256(bundle.read_bytes()).hexdigest() != manifest['sha256']:
            raise ValueError('网页更新包校验失败。')
        with zipfile.ZipFile(bundle) as archive:
            extract_checked(archive, stage, '', lambda name: name.startswith('frontend/dist/') and program_file(name))
    if not web_ready(stage):
        raise ValueError('远端尚未提供与源码一致的网页文件，本次继续使用本地版本。')
    # Check Python syntax without importing or executing downloaded application code.
    for path in stage.rglob('*.py'):
        compile(path.read_bytes(), path.as_posix(), 'exec')
    return sorted(p.relative_to(stage).as_posix() for p in stage.rglob('*') if p.is_file())


def prepare_git(root: Path, commit: str, names: list[str]) -> str | None:
    if not git_root(root):
        return None
    if git(root, 'branch', '--show-current').stdout.strip() != BRANCH:
        raise RuntimeError('当前 Git 分支不是 main，本次保留当前分支。')
    # Git for Windows can report an unchanged CRLF .bat as stat-dirty after
    # atomic replacement. Compare actual content, and check the index separately
    # so staged changes cannot disappear behind a working copy equal to HEAD.
    if (git(root, 'diff', '--quiet', 'HEAD', '--', check=False).returncode
            or git(root, 'diff', '--cached', '--quiet', 'HEAD', '--', check=False).returncode):
        raise RuntimeError('本地有未提交的源码修改，请先提交或备份；本次继续本地版本。')
    collisions = set(git(root, 'ls-files', '--others', '--exclude-standard').stdout.splitlines()) & set(names)
    if collisions:
        raise RuntimeError('更新将与本地未跟踪文件重名，请先处理：' + ', '.join(sorted(collisions)[:5]))
    if git(root, 'cat-file', '-e', commit + '^{commit}', check=False).returncode:
        from tools.start_source import download
        download([shutil.which('git'), '-c', 'http.proxy=' + PROXY, '-C', str(root), 'fetch', 'https://github.com/' + REPOSITORY + '.git', commit], cwd=root,
                 env={**os.environ, 'GIT_TERMINAL_PROMPT': '0', 'GCM_INTERACTIVE': 'never'})
    old = git(root, 'rev-parse', 'HEAD').stdout.strip()
    if git(root, 'merge-base', '--is-ancestor', old, commit, check=False).returncode:
        raise RuntimeError('本地提交与远端不能快进合并，本次保留本地版本。')
    changed = git(root, 'diff', '--name-only', '-z', old, commit).stdout.split('\x00')
    if any(name and not program_file(name) for name in changed):
        raise RuntimeError('远端提交包含程序更新范围以外的路径，本次保留本地版本。')
    return old


def restore(root: Path, transaction: Path, record: dict) -> None:
    for operation in record['operations']:
        name = operation['path']
        target = target_path(root, name)
        if operation['existed']:
            saved = transaction / 'backup' / clean_name(name)
            if not saved.resolve().is_relative_to((transaction / 'backup').resolve()):
                raise ValueError('备份路径无效。')
            write_atomic(target, saved.read_bytes())
        else:
            target.unlink(missing_ok=True)
    if record.get('git_before'):
        current = git(root, 'rev-parse', 'HEAD').stdout.strip()
        if current not in {record['git_before'], record['commit']}:
            raise RecoveryError('Git 分支在更新期间被其他程序修改，请根据备份恢复。')
        git(root, 'reset', '--mixed', record['git_before'])
    record['status'] = 'rolled-back'
    save_json(transaction / 'transaction.json', record)


def recover(root: Path) -> None:
    for path in sorted((root / 'runtime/updates').glob('*/transaction.json')):
        record = json.loads(path.read_text(encoding='utf-8'))
        if record.get('status') == 'applying':
            try:
                restore(root, path.parent, record)
                print('[更新] 已恢复上次中断的源码更新。', flush=True)
            except Exception as exc:
                raise RecoveryError(f'更新恢复失败，备份位于 {path.parent}：{exc}') from exc


def install(root: Path, stage: Path, commit: str, transaction: Path) -> None:
    names = validate_candidate(stage)
    old_git = prepare_git(root, commit, names)
    recorded = read_state(root).get('files', {})
    old_names = {name for name in recorded if program_file(name)}
    if not old_git:
        for name in sorted(old_names):
            target = target_path(root, name)
            if not target.is_file() or hashlib.sha256(target.read_bytes()).hexdigest() != recorded[name]:
                raise ValueError(f'本地程序文件已修改或删除，已保留：{name}。请先备份并恢复原文件再更新。')
    if old_git:
        old_names |= {name for name in git(root, 'ls-files', '-z').stdout.split('\x00') if program_file(name)}
    try:
        web = json.loads((root / 'frontend/dist/.studio-build.json').read_text(encoding='utf-8'))
        old_names |= {'frontend/dist/' + name for name in web['files'] if program_file('frontend/dist/' + name)}
        old_names.add('frontend/dist/.studio-build.json')
    except (OSError, ValueError, KeyError, TypeError):
        pass
    # Never overwrite an unknown private file just because the remote introduced
    # a source file with the same name, including files ignored by Git.
    for name in set(names) - old_names:
        target = target_path(root, name)
        if target.is_file() and target.read_bytes().replace(b'\r\n', b'\n') != (stage / name).read_bytes().replace(b'\r\n', b'\n'):
            raise ValueError(f'本地文件不在原源码清单中，已保留：{name}。请先备份并处理重名文件。')
    operations = []
    for name in sorted(set(names) | old_names | {STATE}):
        target = target_path(root, name)
        if target.exists() and not target.is_file():
            raise ValueError(f'目标路径不是文件：{name}')
        existed = target.is_file()
        if existed:
            backup = transaction / 'backup' / name
            backup.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(target, backup)
        operations.append({'path': name, 'existed': existed})
    record = {'status': 'applying', 'commit': commit, 'git_before': old_git, 'operations': operations}
    save_json(transaction / 'transaction.json', record)
    try:
        for operation in operations:
            name = operation['path']
            if name == STATE:
                continue
            target = target_path(root, name)
            if name in names:
                content = (stage / name).read_bytes()
                if name.endswith('.bat'):
                    content = content.replace(b'\r\n', b'\n').replace(b'\n', b'\r\n')
                write_atomic(target, content)
            else:
                target.unlink(missing_ok=True)
        save_json(root / STATE, snapshot(root, commit, names))
        if old_git:
            git(root, 'reset', '--mixed', commit)
        record['status'] = 'complete'
        save_json(transaction / 'transaction.json', record)
    except BaseException:
        try:
            restore(root, transaction, record)
        except Exception as exc:
            raise RecoveryError(f'更新失败且未能恢复；请保留备份 {transaction}：{exc}') from exc
        raise


def confirm_update(message: str) -> bool:
    if not sys.stdin or not sys.stdin.isatty():
        print(message + '\n[更新] 当前没有交互式输入，本次继续本地版本。', flush=True)
        return False
    try:
        return input(message + '\n是否现在更新？[y/N] ').strip().lower() in {'y', 'yes', '是'}
    except (EOFError, KeyboardInterrupt):
        print('\n[更新] 已取消更新。', flush=True)
        return False


def check_updates(root: Path, confirm=None) -> bool:
    try:
        print(f'[更新] 正在检查 GitHub {REPOSITORY} / {BRANCH}…', flush=True)
        head = json.loads(fetch(f'https://api.github.com/repos/{REPOSITORY}/commits/{BRANCH}'))
        commit = head['sha']
        if not re.fullmatch('[0-9a-f]{40}', commit):
            raise ValueError('GitHub 提交号无效。')
        local = revision(root)
        if local == commit:
            print('[更新] 已是远端最新提交。', flush=True)
            return False
        if git_root(root) and git(root, 'cat-file', '-e', commit + '^{commit}', check=False).returncode == 0:
            if git(root, 'merge-base', '--is-ancestor', commit, 'HEAD', check=False).returncode == 0:
                print('[更新] 本地包含尚未发布的提交，继续使用本地源码。', flush=True)
                return False
        package = json.loads(fetch(f'https://raw.githubusercontent.com/{REPOSITORY}/{commit}/package.json'))
        current_version = json.loads((root / 'package.json').read_text(encoding='utf-8'))['version']
        title = ''.join(c if c.isprintable() else ' ' for c in head.get('commit', {}).get('message', '').split('\n')[0])[:180]
        label = '发现更新' if local else '本地没有提交记录，可同步远端源码'
        message = f'[更新] {label}：{current_version} → {package["version"]}，{commit[:8]}\n{title}\n更新前将备份程序源码，现有数据、配置和 release 保留。'
        if confirm is None and local and (git_root(root) or read_state(root).get('files')):
            print(message + '\n[更新] 正在自动更新。', flush=True)
        elif not (confirm or confirm_update)(message):
            print('[更新] 本次不更新，继续使用本地版本。', flush=True)
            return False
        # The approved SHA is immutable even if main moves during the download.
        content = fetch(f'https://codeload.github.com/{REPOSITORY}/zip/{commit}', limit=50 * 1024 * 1024, timeout=15)
        transaction = root / 'runtime/updates' / (datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S') + '-' + uuid.uuid4().hex[:8])
        stage = transaction / 'new'
        stage.mkdir(parents=True)
        package_path = transaction / 'source.zip'
        package_path.write_bytes(content)
        with zipfile.ZipFile(package_path) as archive:
            extract_checked(archive, stage, 'GCAM-Studio-' + commit + '/', program_file)
        install(root, stage, commit, transaction)
        print(f'[更新] 已更新至 {commit[:8]}，源码备份：{transaction / "backup"}', flush=True)
        return True
    except RecoveryError:
        raise
    except (OSError, ValueError, KeyError, TypeError, RuntimeError, subprocess.SubprocessError, zipfile.BadZipFile) as exc:
        print(f'[更新] 未完成更新，继续本地版本：{exc}', flush=True)
        return False
