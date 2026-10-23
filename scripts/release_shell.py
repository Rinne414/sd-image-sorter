"""The desktop shell (desktop/, SD Image Sorter.exe) inside the Windows release package.

The shell is built from its lockfile with electron-builder as an unpacked
folder and copied to the top of the Windows portable package, so the user
double-clicks ``SD Image Sorter.exe`` next to ``run-portable.bat``. It is
added after the package manifest is written: the in-app updater only ever
replaces the files in that manifest, and it must never try to replace the
shell's files (they are locked while the shell runs). The shell has its own
version (desktop/package.json); the release manifest records it together
with the oldest shell the release still works with (``min_shell_version``).
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

SHELL_DIRNAME = "desktop"
SHELL_EXE_NAME = "SD Image Sorter.exe"
UNPACKED_RELATIVE = Path("dist") / "win-unpacked"


def read_shell_version(root: Path) -> str:
    package = json.loads(
        (root / SHELL_DIRNAME / "package.json").read_text(encoding="utf-8")
    )
    version = str(package.get("version") or "").strip()
    if not version:
        raise RuntimeError("desktop/package.json has no version")
    return version


def build_desktop_shell(root: Path) -> Path:
    """Build the unpacked Windows shell from its lockfile and return the folder.

    A release must not ship without the shell, so a missing npm or a failed
    build stops the release instead of packaging a stale desktop/dist.
    """
    shell_dir = root / SHELL_DIRNAME
    npm = shutil.which("npm")
    if npm is None:
        raise RuntimeError(
            "npm was not found on PATH. Install Node.js (it includes npm) to build the "
            "desktop shell; the Windows package must not ship without SD Image Sorter.exe."
        )
    unpacked = shell_dir / UNPACKED_RELATIVE
    if (shell_dir / "dist").exists():
        shutil.rmtree(shell_dir / "dist")
    for npm_args in (["ci"], ["run", "dist"]):
        print(f"[release] {SHELL_DIRNAME}: npm {' '.join(npm_args)}")
        subprocess.run([npm, *npm_args], cwd=shell_dir, check=True)
    if not (unpacked / SHELL_EXE_NAME).is_file():
        raise RuntimeError(
            f"The shell build did not produce {unpacked / SHELL_EXE_NAME}"
        )
    return unpacked


def stage_desktop_shell(unpacked: Path, stage_dir: Path) -> list[str]:
    """Copy the unpacked shell to the top of the package; returns the relative paths added.

    A shell file that would overwrite a package file (or the reverse) is a
    packaging bug, so it stops the build instead of silently replacing one.
    """
    if not (unpacked / SHELL_EXE_NAME).is_file():
        raise FileNotFoundError(f"{SHELL_EXE_NAME} is missing from {unpacked}")
    added: list[str] = []
    for source in sorted(unpacked.rglob("*")):
        if source.is_dir():
            continue
        relative = source.relative_to(unpacked)
        destination = stage_dir / relative
        if destination.exists():
            raise RuntimeError(
                f"The shell file {relative.as_posix()} collides with a package file"
            )
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)
        added.append(relative.as_posix())
    return added


def shell_manifest_fields(root: Path, min_shell_version: str) -> dict[str, str]:
    """The release-manifest fields the in-app updater reads (backend/services/shell_compat.py)."""
    return {
        "shell_version": read_shell_version(root),
        "min_shell_version": min_shell_version,
    }
