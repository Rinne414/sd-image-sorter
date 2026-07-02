"""Support diagnostics and log-file opening helpers."""

from __future__ import annotations

import re
import shutil
import subprocess
import sys
import logging
from pathlib import Path
from typing import Any, Optional

from fastapi import HTTPException

from app_info import APP_VERSION
import config


logger = logging.getLogger("sd-image-sorter")


def _read_tail_lines(path: Path, max_lines: int) -> tuple[list[str], int]:
    if max_lines <= 0 or not path.exists() or not path.is_file():
        return [], 0
    try:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return [], 0
    return lines[-max_lines:], len(lines)


def _redact_support_log_text(text: str) -> str:
    """Redact likely local filesystem paths before exposing logs to the browser."""
    field_boundary = r"(?=(?:\s+[-A-Za-z0-9_]+[:=])|[\r\n\"'<>]|$)"
    text = re.sub(rf"[A-Za-z]:\\.*?{field_boundary}", "<PATH>", text)
    text = re.sub(rf"(?<!\w)/(?:mnt|home|Users|var|tmp|Volumes|media)/.*?{field_boundary}", "<PATH>", text)
    return text


def build_support_diagnostics(max_lines: int = 200) -> dict[str, Any]:
    """Return a bounded, redacted diagnostics payload users can copy from the UI."""
    log_path = Path(config.LOG_FILE_PATH)
    lines, line_count = _read_tail_lines(log_path, max(1, min(int(max_lines or 200), 1000)))
    redacted_lines = [_redact_support_log_text(line) for line in lines]
    recent_log_text = "\n".join(redacted_lines)
    return {
        "app_version": APP_VERSION,
        "log_level": config.LOG_LEVEL.upper(),
        "access_log_enabled": bool(config.LOG_ACCESS_ENABLED),
        "log_file_enabled": bool(config.LOG_FILE_ENABLED),
        "log_file_path": str(log_path),
        "log_file_path_redacted": _redact_support_log_text(str(log_path)),
        "log_file_exists": log_path.exists(),
        "log_file_max_bytes": config.LOG_FILE_MAX_BYTES,
        "log_file_backup_count": config.LOG_FILE_BACKUP_COUNT,
        "log_line_count": line_count,
        "recent_log_text": recent_log_text,
        "recent_log_lines": redacted_lines,
    }


def _build_file_manager_command(path: Path) -> Optional[list[str]]:
    """Build an OS file-manager command for a trusted local path, if one exists."""
    normalized_path = str(path.resolve())
    if sys.platform == "win32":
        return ["explorer", "/select,", normalized_path] if path.is_file() else ["explorer", normalized_path]
    if sys.platform == "darwin":
        opener = shutil.which("open")
        if not opener:
            return None
        return [opener, "-R", normalized_path] if path.is_file() else [opener, normalized_path]

    opener = shutil.which("xdg-open")
    if not opener:
        return None
    target = normalized_path if path.is_dir() else str(path.parent.resolve())
    return [opener, target]


def _open_path_in_file_manager(path: Path) -> bool:
    """Open a known local path in the OS file manager without accepting user input."""
    command = _build_file_manager_command(path)
    if not command:
        return False
    subprocess.Popen(
        command,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    return True


def open_support_log_file() -> dict[str, Any]:
    """Open the configured support log location in the user's file manager."""
    if not config.LOG_FILE_ENABLED:
        raise HTTPException(status_code=409, detail="Support log file is disabled")

    log_path = Path(config.LOG_FILE_PATH)

    try:
        log_path.parent.mkdir(parents=True, exist_ok=True)
        if not log_path.exists():
            log_path.touch()
        opened = _open_path_in_file_manager(log_path)
    except OSError as exc:
        logger.warning("Failed to open support log file %s: %s", config.LOG_FILE_PATH, exc)
        raise HTTPException(
            status_code=500,
            detail="Failed to open support log file.",
        ) from exc

    payload: dict[str, Any] = {
        "success": opened,
        "opened": opened,
        "path": str(log_path),
        "path_redacted": _redact_support_log_text(str(log_path)),
        "exists": log_path.exists(),
    }
    if not opened:
        payload["message"] = "No OS file manager command is available; copy the log path manually."
    return payload
