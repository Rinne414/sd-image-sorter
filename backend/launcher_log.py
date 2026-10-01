"""Record why a launcher decided to (re)install dependencies.

Called by run.bat, run.sh, run-portable.bat and run-portable.sh. Prints one
bilingual line to the console and appends one line to ``data/logs/launcher.log``:

    <ISO time> <launcher> reason=<code> detail=<text>

Standard library only (it runs before any dependency is installed) and it never
fails: a locked log file or a missing argument must not stop the launcher.
Batch files pass hashes and file names as ``--key=value``; the Python error
text arrives through ``--detail-file`` so cmd never has to quote it.
"""

from __future__ import annotations

import argparse
import locale
import os
import sys
from datetime import datetime
from pathlib import Path

LOG_NAME = "launcher.log"
MAX_LOG_BYTES = 1024 * 1024
MAX_DETAIL_CHARS = 300
SHORT_HASH_CHARS = 8

# reason code -> (Chinese, English); {file}/{old}/{new}/{error} are filled in.
MESSAGES: dict[str, tuple[str, str]] = {
    "first_run": (
        "首次启动，需要建立运行环境并安装依赖",
        "First run: the environment needs to be created and dependencies installed",
    ),
    "hash_missing": (
        "没有找到依赖安装记录 backend/.requirements_hash",
        "backend/.requirements_hash is missing (no install record)",
    ),
    "hash_changed": (
        "{file} 已变更（旧 {old} → 新 {new}）",
        "{file} changed (old {old} -> new {new})",
    ),
    "certutil_missing": (
        "找不到文件哈希工具（certutil / md5sum），无法比对依赖清单",
        "No file-hash tool (certutil / md5sum) was found, so the requirements file cannot be compared",
    ),
    "import_failed": (
        "已安装的包导入失败：{error}",
        "Installed packages failed to import: {error}",
    ),
    "rebuild_requested": (
        "收到轻量运行环境重建请求（rebuild-core-venv.json）",
        "A lightweight runtime rebuild was requested (rebuild-core-venv.json)",
    ),
}


def _clean(text: str) -> str:
    return " ".join(text.split())[:MAX_DETAIL_CHARS]


def _short(value: str) -> str:
    value = value.strip()
    if len(value) <= SHORT_HASH_CHARS:
        return value or "?"
    return value[:SHORT_HASH_CHARS] + "…"


def _last_line(path: str) -> str:
    """Last non-empty line of a captured stderr file, deleting the file."""
    try:
        raw = Path(path).read_bytes()
    except OSError:
        return ""
    finally:
        try:
            os.remove(path)
        except OSError:
            pass
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        # PYTHONIOENCODING is ignored by some embedded builds: stderr then
        # arrives in the Windows code page (cp950 on a zh-TW system).
        text = raw.decode(locale.getpreferredencoding(False), errors="replace")
    lines = [ln.strip() for ln in text.splitlines()]
    lines = [ln for ln in lines if ln]
    return lines[-1] if lines else ""


def _log_dir(explicit: str) -> Path:
    if explicit:
        return Path(explicit)
    data_dir = os.environ.get("SD_IMAGE_SORTER_DATA_DIR")
    return (Path(data_dir) if data_dir else Path("data")) / "logs"


def _append(log_dir: Path, line: str) -> None:
    log_dir.mkdir(parents=True, exist_ok=True)
    log_path = log_dir / LOG_NAME
    try:
        if log_path.stat().st_size > MAX_LOG_BYTES:
            os.replace(log_path, log_dir / (LOG_NAME + ".1"))
    except FileNotFoundError:
        pass
    with log_path.open("a", encoding="utf-8", errors="replace", newline="\n") as handle:
        handle.write(line + "\n")


def _print(text: str) -> None:
    try:
        print(text, flush=True)
    except UnicodeEncodeError:
        # Redirected output in a legacy code page: keep the line, mark what it cannot hold.
        encoding = sys.stdout.encoding or "ascii"
        print(text.encode(encoding, "replace").decode(encoding), flush=True)


def run(argv: list[str]) -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--launcher", default="unknown")
    parser.add_argument("--reason", required=True)
    parser.add_argument("--file", default="")
    parser.add_argument("--old", default="")
    parser.add_argument("--new", default="")
    parser.add_argument("--detail", default="")
    parser.add_argument("--detail-file", default="")
    parser.add_argument("--log-dir", default="")
    args = parser.parse_args(argv)

    error = _last_line(args.detail_file) if args.detail_file else ""
    detail = args.detail
    if args.reason == "hash_changed":
        detail = f"file={args.file} old={args.old} new={args.new}"
    elif args.reason == "import_failed":
        detail = error or "unknown import error"
    elif args.reason == "certutil_missing" and not detail:
        detail = args.file or "no hash tool on PATH"
    elif args.reason == "rebuild_requested" and not detail:
        detail = "data/state/rebuild-core-venv.json"

    line = f"{datetime.now().astimezone().isoformat(timespec='seconds')} "
    line += f"{args.launcher} reason={args.reason} detail={_clean(detail) or '-'}"
    try:
        _append(_log_dir(args.log_dir), line)
    except OSError:
        pass

    messages = MESSAGES.get(args.reason)
    if messages is None:
        return
    fields = {
        "file": args.file or "requirements",
        "old": _short(args.old),
        "new": _short(args.new),
        "error": _clean(error) or "unknown import error",
    }
    zh, en = (text.format(**fields) for text in messages)
    _print(f"[INFO] 依赖需要重新检查：{zh} / Dependencies need a recheck: {en}")


def main() -> int:
    try:
        run(sys.argv[1:])
    except (Exception, SystemExit):  # noqa: BLE001 - logging must never stop the launcher
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
