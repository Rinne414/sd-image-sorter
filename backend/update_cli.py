"""Command-line updater for when the web UI cannot be opened."""

from __future__ import annotations

import argparse
import os
import socket
import sys
from pathlib import Path
from typing import Any, Callable, TextIO

_THIS_DIR = str(Path(__file__).resolve().parent)
if _THIS_DIR not in sys.path:
    sys.path.insert(0, _THIS_DIR)

from app_info import APP_VERSION
from config import ensure_directories
from launcher_port import DEFAULT_HOST, DEFAULT_PORT
from services.update_service import UpdateService
from update_worker import apply_update


def _print_status_line(message: str, *, stdout: TextIO) -> None:
    print(message, file=stdout, flush=True)


def _is_port_listening(host: str, port: int, timeout: float = 0.5) -> bool:
    """Return True if a TCP listener accepts a connection on ``host:port``."""
    try:
        infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except socket.gaierror:
        return False
    for family, socktype, proto, _canonname, sockaddr in infos:
        try:
            with socket.socket(family, socktype, proto) as sock:
                sock.settimeout(timeout)
                if sock.connect_ex(sockaddr) == 0:
                    return True
        except OSError:
            continue
    return False


def _detect_running_instance() -> str:
    """Return a human-readable URL if a local instance is listening, else ''."""
    raw_port = (os.environ.get("SD_IMAGE_SORTER_PORT") or "").strip()
    try:
        port = int(raw_port) if raw_port else DEFAULT_PORT
    except ValueError:
        port = DEFAULT_PORT
    host = (os.environ.get("SD_IMAGE_SORTER_BIND_HOST") or "").strip() or DEFAULT_HOST
    if _is_port_listening(host, port):
        return f"http://{host}:{port}"
    return ""


def apply_external_update(
    *,
    force_check: bool = True,
    relaunch: bool = True,
    check_only: bool = False,
    force: bool = False,
    service: UpdateService | None = None,
    update_applier: Callable[[Path], int] = apply_update,
    instance_probe: Callable[[], str] = _detect_running_instance,
    stdout: TextIO = sys.stdout,
    stderr: TextIO = sys.stderr,
) -> int:
    """Check, download, and apply an update without requiring the FastAPI app."""
    updater = service or UpdateService()
    try:
        ensure_directories()

        # Refuse to overwrite app files while a live instance is still running.
        # Windows allows overwriting .py files in-place, but the relaunch step
        # would race the existing web app for the same localhost port and the
        # user would end up with two instances on different ports. --force lets
        # advanced users bypass this when the existing window is hung.
        if not check_only and not force:
            running_instance_url = instance_probe()
            if running_instance_url:
                raise RuntimeError(
                    f"SD Image Sorter is already running at {running_instance_url}. "
                    "Close that window first, then re-run update.bat. "
                    "Use --force to override if the existing window is hung."
                )

        _print_status_line("[Info] Checking for SD Image Sorter updates...", stdout=stdout)
        status: dict[str, Any] = updater.get_status(force=force_check)

        if status.get("error"):
            raise RuntimeError(str(status["error"]))
        if status.get("update_unavailable_reason"):
            raise RuntimeError(str(status["update_unavailable_reason"]))
        if not status.get("has_update"):
            current_version = status.get("current_version") or APP_VERSION
            latest_version = status.get("latest_version") or current_version
            _print_status_line(
                f"[OK] Already up to date. Current: {current_version}; latest: {latest_version}.",
                stdout=stdout,
            )
            return 0

        asset = status.get("asset") or {}
        latest_version = str(status.get("latest_version") or APP_VERSION)
        if check_only:
            _print_status_line(
                f"[OK] Update available: {status.get('current_version') or APP_VERSION} -> {latest_version}; "
                f"asset: {asset.get('name') or 'update package'}.",
                stdout=stdout,
            )
            return 0

        _print_status_line(
            f"[Info] Downloading {asset.get('name') or 'update package'}...",
            stdout=stdout,
        )
        archive_path = updater._download_asset(asset, latest_version)
        manifest_path = updater._write_pending_manifest(
            archive_path=archive_path,
            version=latest_version,
            relaunch=relaunch,
            current_pid=0,
        )

        _print_status_line("[Info] Applying update with backup protection...", stdout=stdout)
        result = update_applier(manifest_path)
        if result != 0:
            raise RuntimeError(f"Update worker exited with status {result}")

        _print_status_line(f"[OK] Updated to {latest_version}.", stdout=stdout)
        return 0
    except Exception as exc:
        print(f"[ERROR] {exc}", file=stderr, flush=True)
        return 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Update SD Image Sorter without opening the web UI.")
    parser.add_argument("--no-force-check", action="store_true", help="Use cached update status when available.")
    parser.add_argument("--no-relaunch", action="store_true", help="Do not relaunch the app after applying an update.")
    parser.add_argument("--check-only", action="store_true", help="Only check update availability; do not download or apply.")
    parser.add_argument(
        "--force",
        action="store_true",
        help="Apply the update even if an SD Image Sorter instance is detected on the configured localhost port.",
    )
    args = parser.parse_args(argv)

    return apply_external_update(
        force_check=not args.no_force_check,
        relaunch=not args.no_relaunch,
        check_only=args.check_only,
        force=args.force,
    )


if __name__ == "__main__":
    raise SystemExit(main())
