from __future__ import annotations

import argparse
import os
import sys

for _stream in (sys.stdout, sys.stderr):
    if _stream is not None and hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")

# PyInstaller entry point: make the backend package importable as `app`.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import uvicorn  # noqa: E402
from app.hostnet import lan_ipv4_addresses, primary_lan_ipv4  # noqa: E402
from app.main import app  # noqa: E402


def print_startup(host: str, port: int) -> None:
    exposed = host in {"0.0.0.0", "::"}
    print("GCAM-China Studio 已启动", flush=True)
    if exposed:
        print(f"  本机访问  http://127.0.0.1:{port}", flush=True)
        primary = primary_lan_ipv4()
        addresses = lan_ipv4_addresses()
        if primary:
            print(f"  同事访问  http://{primary}:{port}", flush=True)
        others = [ip for ip in addresses if ip != primary]
        if not primary and not others:
            print("  局域网    没有发现可用的 IPv4 地址", flush=True)
        for ip in others:
            print(f"  其他网卡  http://{ip}:{port}", flush=True)
        print(f"若 Windows 弹出防火墙提示，请允许专用网络访问端口 {port}。", flush=True)
    else:
        shown = "127.0.0.1" if host in {"127.0.0.1", "localhost"} else host
        print(f"  仅本机    http://{shown}:{port}", flush=True)
    print("按 Ctrl+C 停止。", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--host", default="127.0.0.1")
    args = parser.parse_args()
    print_startup(args.host, args.port)
    uvicorn.run(app, host=args.host, port=args.port, log_level="info", access_log=False)


if __name__ == "__main__":
    main()
