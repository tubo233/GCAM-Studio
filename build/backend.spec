# -*- mode: python ; coding: utf-8 -*-
import os
from PyInstaller.utils.hooks import collect_all, collect_submodules

ROOT = os.path.abspath(os.getcwd())
datas = []
binaries = []
hiddenimports = []

for pkg in ("uvicorn", "fastapi", "starlette", "pydantic", "pandas", "duckdb", "lxml", "openpyxl", "sse_starlette"):
    try:
        d, b, h = collect_all(pkg, include_py_files=False,
                              filter_submodules=lambda name: ".tests" not in name)
        datas += d
        binaries += b
        hiddenimports += h
    except Exception:
        pass

hiddenimports += collect_submodules("uvicorn")
hiddenimports += [
    "app.main",
    "app.api",
    "app.config",
    "app.db",
    "app.services.data_migrate",
    "app.services.processes",
    "app.services.diagnostics",
    "app.services.gcam_run",
    "app.services.r_build",
    "app.services.queries",
    "app.services.profiles",
    "app.services.catalog",
    "app.services.files",
    "app.services.csv_engine",
    "app.services.jobs",
]

a = Analysis(
    [os.path.join(ROOT, "backend", "run_server.py")],
    pathex=[os.path.join(ROOT, "backend"), ROOT],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=["tkinter", "matplotlib", "pytest", "pandas.tests", "numpy.tests"],
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="gcam-studio-backend",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="gcam-studio-backend",
)
