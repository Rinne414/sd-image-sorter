"""The desktop shell (desktop/) inside the Windows release package.

Two things are built: the Electron shell (from its lockfile with
electron-builder, an unpacked folder of about 20 loose files plus
``locales/`` and ``resources/``) and a tiny native launcher
(``desktop/launcher``, Rust). The package shows the user only
``SD Image Sorter.exe`` (the launcher) next to ``run-portable.bat``; every
Electron file goes into the ``desktop`` subfolder, where the launcher starts
``desktop/sd-image-sorter-shell.exe``. Both are added after the package
manifest is written: the in-app updater only ever replaces the files in that
manifest, and it must never try to replace the shell's files (they are locked
while the shell runs). The shell has its own version (desktop/package.json);
the release manifest records it together with the oldest shell the release
still works with (``min_shell_version``).
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path
from typing import NamedTuple

# The source folder desktop/ and the folder desktop/ inside the package share
# a name on purpose: <package>/desktop/<SHELL_EXE_NAME> is the Electron shell,
# <package>/<LAUNCHER_EXE_NAME> the launcher the user double-clicks.
SHELL_DIRNAME = "desktop"
SHELL_EXE_NAME = "sd-image-sorter-shell.exe"
LAUNCHER_EXE_NAME = "SD Image Sorter.exe"
UNPACKED_RELATIVE = Path("dist") / "win-unpacked"
LAUNCHER_DIRNAME = "launcher"
LAUNCHER_CARGO_BIN = "sd-image-sorter-launcher.exe"


class ShellBuild(NamedTuple):
    """What a shell build produced: the Electron folder and the launcher exe."""

    unpacked: Path
    launcher: Path


def read_shell_version(root: Path) -> str:
    package = json.loads(
        (root / SHELL_DIRNAME / "package.json").read_text(encoding="utf-8")
    )
    version = str(package.get("version") or "").strip()
    if not version:
        raise RuntimeError("desktop/package.json has no version")
    return version


def build_launcher(root: Path) -> Path:
    """Build the native launcher with cargo and return the exe (named by cargo).

    A release must not ship without it: a missing cargo stops the build with
    the reason instead of packaging a shell the user cannot start by
    double-click.
    """
    cargo = shutil.which("cargo")
    if cargo is None:
        raise RuntimeError(
            "cargo was not found on PATH. Install Rust (https://rustup.rs) to build the "
            f"launcher in {SHELL_DIRNAME}/{LAUNCHER_DIRNAME}; the Windows package must "
            f"not ship without {LAUNCHER_EXE_NAME}."
        )
    launcher_dir = root / SHELL_DIRNAME / LAUNCHER_DIRNAME
    print(f"[release] {SHELL_DIRNAME}/{LAUNCHER_DIRNAME}: cargo build --release")
    subprocess.run(
        [cargo, "build", "--release", "--locked"], cwd=launcher_dir, check=True
    )
    built = launcher_dir / "target" / "release" / LAUNCHER_CARGO_BIN
    if not built.is_file():
        raise RuntimeError(f"The launcher build did not produce {built}")
    return built


def build_desktop_shell(root: Path) -> ShellBuild:
    """Build the launcher and the unpacked Windows shell from its lockfile.

    A release must not ship without the shell, so a missing npm or cargo or a
    failed build stops the release instead of packaging a stale desktop/dist.
    """
    shell_dir = root / SHELL_DIRNAME
    npm = shutil.which("npm")
    if npm is None:
        raise RuntimeError(
            "npm was not found on PATH. Install Node.js (it includes npm) to build the "
            f"desktop shell; the Windows package must not ship without {LAUNCHER_EXE_NAME}."
        )
    launcher = build_launcher(root)
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
    return ShellBuild(unpacked=unpacked, launcher=launcher)


def _copy_new(source: Path, destination: Path, label: str) -> None:
    if destination.exists():
        raise RuntimeError(f"The shell file {label} collides with a package file")
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, destination)


def stage_desktop_shell(build: ShellBuild, stage_dir: Path) -> list[str]:
    """Put the launcher at the top of the package and the Electron files in desktop/.

    Returns the relative paths added. A shell file that would overwrite a
    package file (or the reverse) is a packaging bug, so it stops the build
    instead of silently replacing one.
    """
    if not (build.unpacked / SHELL_EXE_NAME).is_file():
        raise FileNotFoundError(f"{SHELL_EXE_NAME} is missing from {build.unpacked}")
    if not build.launcher.is_file():
        raise FileNotFoundError(f"The launcher {build.launcher} is missing")
    _copy_new(build.launcher, stage_dir / LAUNCHER_EXE_NAME, LAUNCHER_EXE_NAME)
    added = [LAUNCHER_EXE_NAME]
    for source in sorted(build.unpacked.rglob("*")):
        if source.is_dir():
            continue
        relative = (Path(SHELL_DIRNAME) / source.relative_to(build.unpacked)).as_posix()
        _copy_new(source, stage_dir / relative, relative)
        added.append(relative)
    return added


def shell_manifest_fields(root: Path, min_shell_version: str) -> dict[str, str]:
    """The release-manifest fields the in-app updater reads (backend/services/shell_compat.py)."""
    return {
        "shell_version": read_shell_version(root),
        "min_shell_version": min_shell_version,
    }
