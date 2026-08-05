"""Readable launcher-console formatting for model preparation events."""
from __future__ import annotations

import logging


_QUIET_INFO_LOGGER_PREFIXES = (
    "httpx",
    "open_clip",
)
_QUIET_ROOT_INFO_MARKERS = (
    "Parsing model identifier.",
    "Loaded built-in ",
    "Instantiating model architecture:",
    "Loading full pretrained weights from:",
    "Final image preprocessing configuration set:",
    " creation process complete.",
)
_QUIET_INFO_MARKERS = (
    "Created model directory:",
)
_QUIET_WARNING_MARKERS = (
    "QuickGELU mismatch",
    "unauthenticated requests to the HF Hub",
)


def _format_size(size_bytes: int) -> str:
    """Format a non-negative byte count for the launcher console."""
    value = float(max(0, size_bytes))
    for unit in ("B", "KiB", "MiB", "GiB"):
        if value < 1024.0 or unit == "GiB":
            return f"{value:.0f} {unit}" if unit == "B" else f"{value:.1f} {unit}"
        value /= 1024.0
    raise AssertionError("unreachable size unit")


def format_starter_console_record(record: logging.LogRecord) -> str:
    """Return one concise, actionable launcher-console line."""
    message = " ".join(record.getMessage().split())
    artifact_file = getattr(record, "artifact_file", None)
    artifact_status = getattr(record, "status", None)
    model_id = getattr(record, "model_id", None)
    if artifact_file and artifact_status and model_id:
        revision = getattr(record, "revision", None) or "unpinned"
        endpoint = getattr(record, "endpoint", None) or "unknown"
        raw_size = getattr(record, "size_bytes", 0)
        size_bytes = raw_size if isinstance(raw_size, int) else 0
        return (
            f"[MODEL] {artifact_status} model_id={model_id} file={artifact_file} "
            f"size={_format_size(size_bytes)} revision={revision} endpoint={endpoint}"
        )
    if message.startswith("[MODEL]"):
        starter_message = getattr(record, "starter_console_message", None)
        if isinstance(starter_message, str) and starter_message.strip():
            return " ".join(starter_message.split())
        return message
    if record.levelno >= logging.ERROR:
        return f"[ERROR] {message}"
    if record.levelno >= logging.WARNING:
        return f"[WARNING] {message}"
    return message


class StarterConsoleFilter(logging.Filter):
    """Hide support-log detail that is not actionable in the launcher console."""

    def filter(self, record: logging.LogRecord) -> bool:
        if getattr(record, "starter_console_suppress", False):
            return False
        message = record.getMessage()
        if record.levelno < logging.WARNING and record.name.startswith(
            _QUIET_INFO_LOGGER_PREFIXES
        ):
            return False
        if (
            record.levelno < logging.WARNING
            and record.name == "root"
            and any(marker in message for marker in _QUIET_ROOT_INFO_MARKERS)
        ):
            return False
        if record.levelno < logging.WARNING and any(
            marker in message for marker in _QUIET_INFO_MARKERS
        ):
            return False
        if any(marker in message for marker in _QUIET_WARNING_MARKERS):
            return False
        return True


class StarterConsoleFormatter(logging.Formatter):
    """Logging adapter for the human-facing starter console."""

    def format(self, record: logging.LogRecord) -> str:
        return format_starter_console_record(record)


__all__ = [
    "StarterConsoleFilter",
    "StarterConsoleFormatter",
    "format_starter_console_record",
]
