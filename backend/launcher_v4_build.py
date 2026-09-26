"""Build the V4 interface (/v4/) for a source checkout before the app starts.

run.bat and run.sh call this. Release packages ship frontend-v4/dist already
built and carry no sources, so there it does nothing. In a source checkout it
runs ``npm ci`` when node_modules is missing or older than package-lock.json,
then ``npm run build`` when the build is missing or older than its inputs.

It never stops V3.5 from starting: every outcome exits 0, and a skipped or
failed V4 build prints one plain line in Chinese and English.
"""

from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

FRONTEND_DIRNAME = "frontend-v4"
# Files and folders whose change makes frontend-v4/dist out of date.
BUILD_INPUTS = (
    "src",
    "index.html",
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "vite.config.ts",
)
# npm rewrites this file on every install, so it dates node_modules.
INSTALL_STAMP = Path("node_modules") / ".package-lock.json"

NO_NODE_MESSAGE = (
    "[INFO] V4 界面（/v4/）需要 Node.js 才能构建，本次跳过；V3.5 界面照常可用。"
    " / The V4 interface (/v4/) needs Node.js to build and is skipped; V3.5 still works."
)
FAILED_MESSAGE = (
    "[WARN] V4 界面（/v4/）构建失败，本次跳过；V3.5 界面照常可用。"
    " / The V4 interface (/v4/) failed to build and is skipped; V3.5 still works."
)


def _mtime(path: Path) -> float | None:
    try:
        return path.stat().st_mtime
    except OSError:
        return None


def _newest_input_mtime(frontend_dir: Path) -> float:
    newest = 0.0
    for name in BUILD_INPUTS:
        path = frontend_dir / name
        files = path.rglob("*") if path.is_dir() else (path,)
        for file_path in files:
            mtime = _mtime(file_path) if file_path.is_file() else None
            if mtime is not None and mtime > newest:
                newest = mtime
    return newest


def plan_build(frontend_dir: Path) -> str:
    """Return "none", "build" (npm run build) or "install" (npm ci, then build)."""
    if not (frontend_dir / "package.json").is_file():
        return "none"
    built_at = _mtime(frontend_dir / "dist" / "index.html")
    if built_at is not None and built_at >= _newest_input_mtime(frontend_dir):
        return "none"
    installed_at = _mtime(frontend_dir / INSTALL_STAMP)
    lock_at = _mtime(frontend_dir / "package-lock.json") or 0.0
    if installed_at is None or installed_at < lock_at:
        return "install"
    return "build"


def _run_npm(npm: str, npm_args: list[str], frontend_dir: Path) -> bool:
    print(f"[Info] V4: npm {' '.join(npm_args)}", flush=True)
    try:
        result = subprocess.run([npm, *npm_args], cwd=frontend_dir)
    except OSError as exc:
        print(f"[WARN] V4: npm {' '.join(npm_args)} could not start: {exc}", flush=True)
        return False
    return result.returncode == 0


def build_if_needed(frontend_dir: Path) -> int:
    step = plan_build(frontend_dir)
    if step == "none":
        return 0
    npm = shutil.which("npm")
    if npm is None:
        print(NO_NODE_MESSAGE, flush=True)
        return 0
    print("[Info] Building the V4 interface (/v4/)...", flush=True)
    npm_steps = [["ci"], ["run", "build"]] if step == "install" else [["run", "build"]]
    for npm_args in npm_steps:
        if not _run_npm(npm, npm_args, frontend_dir):
            print(FAILED_MESSAGE, flush=True)
            return 0
    print("[OK] V4 interface built: /v4/", flush=True)
    return 0


def main() -> int:
    # A console with a legacy code page must not turn the Chinese line into a crash.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(errors="replace")
    frontend_dir = Path(__file__).resolve().parent.parent / FRONTEND_DIRNAME
    try:
        return build_if_needed(frontend_dir)
    except Exception as exc:  # noqa: BLE001 - a V4 problem must never block V3.5
        print(f"{FAILED_MESSAGE} ({exc})", flush=True)
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
