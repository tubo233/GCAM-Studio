"""Create an overlay update containing source and web assets, never user data."""
from __future__ import annotations

import argparse
import json
import zipfile
from pathlib import Path

from start_source import ROOT, prepare_web, web_ready
from source_update import STATE, revision, snapshot


def source_files(root: Path) -> list[Path]:
    paths = set()
    for folder in ('backend', 'frontend/src', 'desktop', 'tools'):
        for path in (root / folder).rglob('*'):
            if path.is_file() and '__pycache__' not in path.parts and path.suffix in {'.py', '.txt', '.ts', '.tsx', '.css', '.js', '.cjs', '.ps1'}:
                paths.add(path)
    for name in ('frontend/index.html', 'frontend/tsconfig.json', 'frontend/vite.config.ts', 'build/backend.spec',
                 'package.json', 'package-lock.json', 'README.md', '.gitignore', '.gitattributes', '启动.bat'):
        paths.add(root / name)
    paths.update(path for path in (root / 'frontend/dist').rglob('*') if path.is_file())
    paths.update(root / name for name in ('distribution/web.zip', 'distribution/web.json') if (root / name).is_file())
    return sorted(paths)


def build_archive(root: Path, destination: Path) -> None:
    if not web_ready(root):
        raise RuntimeError('网页文件与源码不一致，无法生成覆盖更新包。')
    paths = source_files(root)
    assert [p.name for p in paths if p.suffix == '.bat'] == ['启动.bat']
    destination.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(destination, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for path in paths:
            archive.write(path, 'GCAM-Studio/' + path.relative_to(root).as_posix())
        names = [path.relative_to(root).as_posix() for path in paths]
        archive.writestr('GCAM-Studio/' + STATE, json.dumps(snapshot(root, revision(root), names), ensure_ascii=False, indent=2))
    with zipfile.ZipFile(destination) as archive:
        bad = archive.testzip()
        if bad:
            raise RuntimeError(f'ZIP 校验失败：{bad}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('destination', nargs='?', type=Path)
    args = parser.parse_args()
    version = json.loads((ROOT / 'package.json').read_text(encoding='utf-8'))['version']
    target = args.destination or ROOT.parent / f'GCAM-China-Studio-{version}-source.zip'
    prepare_web(ROOT)
    build_archive(ROOT, target)
    print(target.resolve())
