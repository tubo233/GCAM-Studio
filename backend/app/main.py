from __future__ import annotations

import os
from pathlib import Path

from fastapi import Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles

from .api import app
from .config import HOME
from .db import init_db
from .services.gcam_run import recover_interrupted_runs

init_db()
recover_interrupted_runs()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:5173", "http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def web_dir() -> Path:
    env = os.environ.get("GCAM_STUDIO_WEB_DIR")
    if env:
        return Path(env)
    return HOME / "frontend" / "dist"


_dist = web_dir()
if (_dist / "assets").is_dir():
    app.mount("/assets", StaticFiles(directory=str(_dist / "assets")), name="assets")


@app.get("/{full_path:path}", include_in_schema=False)
async def spa(full_path: str, request: Request):
    index = _dist / "index.html"
    if index.is_file() and not full_path.startswith("api/"):
        return FileResponse(str(index))
    return HTMLResponse(
        "<h1>GCAM-China Studio API</h1><p>前端尚未构建。请运行 <code>npm run build:web</code>，"
        "或在开发模式下访问 <code>http://127.0.0.1:5173</code>。</p>"
    )
