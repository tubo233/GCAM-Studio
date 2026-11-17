"""Local-address checks and one-level directory listings for the host PC."""

from __future__ import annotations

import os
import re
import socket
import string
import subprocess
import time
from pathlib import Path

_IPV4 = re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b")
_CACHE_SECONDS = 30.0
_cached_ips: tuple[float, set[str]] | None = None
_MAX_ENTRIES = 4000


class HostPathError(ValueError):
    """The host file browser was given a path it should not open."""


def normalize_client_host(host: str | None) -> str:
    text = (host or "").strip().lower()
    if text.startswith("::ffff:"):
        text = text[7:]
    if "%" in text:
        text = text.split("%", 1)[0]
    return text


def _collect_local_ips() -> set[str]:
    found: set[str] = {"127.0.0.1", "::1"}
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None):
            addr = info[4][0]
            if addr:
                found.add(normalize_client_host(addr))
    except OSError:
        pass
    try:
        probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            # Select the LAN interface without sending a packet.
            probe.connect(("192.168.255.255", 9))
            found.add(probe.getsockname()[0])
        finally:
            probe.close()
    except OSError:
        pass
    if os.name == "nt":
        try:
            proc = subprocess.run(
                ["ipconfig"],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=5,
                check=False,
            )
            found.update(_IPV4.findall(proc.stdout or ""))
        except (OSError, subprocess.TimeoutExpired):
            pass
    return found


def local_ip_addresses() -> set[str]:
    global _cached_ips
    now = time.monotonic()
    if _cached_ips and now - _cached_ips[0] < _CACHE_SECONDS:
        return set(_cached_ips[1])
    found = _collect_local_ips()
    _cached_ips = (now, found)
    return set(found)


def is_local_client(host: str | None, local_ips: set[str] | None = None) -> bool:
    """True when the TCP peer is this computer (loopback or one of its NICs)."""
    text = normalize_client_host(host)
    if not text:
        return False
    if text == "localhost" or text == "::1" or text.startswith("127."):
        return True
    ips = local_ips if local_ips is not None else local_ip_addresses()
    return text in {normalize_client_host(ip) for ip in ips}


def _usable_lan_ipv4(ip: str) -> bool:
    return bool(ip) and ":" not in ip and not ip.startswith(("127.", "0.", "255."))


def lan_ipv4_addresses() -> list[str]:
    """IPv4 addresses on this computer, skipping loopback and netmasks."""
    addresses: list[str] = []
    for ip in sorted(local_ip_addresses()):
        if _usable_lan_ipv4(ip):
            addresses.append(ip)
    return addresses


def primary_lan_ipv4() -> str:
    """Address of the interface used for the default route, when there is one."""
    try:
        probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            probe.connect(("8.8.8.8", 80))
            ip = probe.getsockname()[0]
        finally:
            probe.close()
    except OSError:
        return ""
    return ip if _usable_lan_ipv4(ip) else ""


def list_drives() -> list[dict[str, str]]:
    if os.name != "nt":
        return [{"name": "/", "path": "/"}]
    drives: list[dict[str, str]] = []
    for letter in string.ascii_uppercase:
        root = Path(f"{letter}:\\")
        if root.exists():
            drives.append({"name": f"{letter}:", "path": str(root)})
    return drives


def list_directory(path: str) -> dict[str, object]:
    """List one directory level. Does not recurse."""
    raw = (path or "").strip()
    if not raw or "\x00" in raw:
        raise HostPathError("请选择一个绝对路径。")
    folder = Path(raw)
    if not folder.is_absolute():
        raise HostPathError("请使用绝对路径。")
    try:
        folder = folder.resolve()
    except OSError as exc:
        raise HostPathError(f"无法打开目录：{exc}") from exc
    if not folder.is_dir():
        raise HostPathError("该路径不是文件夹。")
    try:
        entries = list(folder.iterdir())
    except OSError as exc:
        raise HostPathError(f"无法读取目录：{exc}") from exc
    dirs: list[dict[str, str]] = []
    files: list[dict[str, str]] = []
    for entry in entries:
        try:
            item = {"name": entry.name, "path": str(entry)}
            if entry.is_dir():
                dirs.append(item)
            elif entry.is_file():
                files.append(item)
        except OSError:
            continue
    dirs.sort(key=lambda item: item["name"].lower())
    files.sort(key=lambda item: item["name"].lower())
    truncated = False
    if len(dirs) > _MAX_ENTRIES:
        dirs = dirs[:_MAX_ENTRIES]
        files = []
        truncated = True
    elif len(dirs) + len(files) > _MAX_ENTRIES:
        files = files[: _MAX_ENTRIES - len(dirs)]
        truncated = True
    parent = None if folder.parent == folder else str(folder.parent)
    return {
        "path": str(folder),
        "parent": parent,
        "dirs": dirs,
        "files": files,
        "truncated": truncated,
    }
