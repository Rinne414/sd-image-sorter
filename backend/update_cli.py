"""Command-line updater for when the web UI cannot be opened."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Any, Callable, TextIO

_THIS_DIR = str(Path(__file__).resolve().parent)
if _THIS_DIR not in sys.path:
    sys.path.insert(0, _THIS_DIR)

from app_info import APP_VERSION
from config import ensure_directories
from services.update_service import UpdateService
from update_worker import apply_update


def _print_status_line(message: str, *, stdout: TextIO) -> None:
    print(message, file=stdout, flush=True)


def apply_external_update(
    *,
    force_check: bool = True,
    relaunch: bool = True,
    check_only: bool = False,
    service: UpdateService | None = None,
    update_applier: Callable[[Path], int] = apply_update,
    stdout: TextIO = sys.stdout,
    stderr: TextIO = sys.stderr,
) -> int:
    """Check, download, and apply an update without requiring the FastAPI app."""
    updater = service or UpdateService()
    try:
        ensure_directories()
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
    args = parser.parse_args(argv)

    return apply_external_update(
        force_check=not args.no_force_check,
        relaunch=not args.no_relaunch,
        check_only=args.check_only,
    )


if __name__ == "__main__":
    raise SystemExit(main())
