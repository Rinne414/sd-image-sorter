#!/usr/bin/env python3
"""Verify one generated Kohya TOML with a pinned official sd-scripts checkout."""

from __future__ import annotations

import argparse
import json
import os
import shlex
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BACKEND_ROOT = ROOT / "backend"
sys.path.insert(0, str(BACKEND_ROOT))

from services.dataset_export.kohya_contract import (  # noqa: E402
    KOHYA_UPSTREAM_COMMIT,
    KohyaTrainerContractError,
    validate_kohya_toml_text,
)


class KohyaVerifierError(RuntimeError):
    """Raised when the explicit upstream verification cannot be completed."""


_MODULE_PATH_PREFIX = "SD_IMAGE_SORTER_KOHYA_MODULE="


def _require_directory(path: Path, label: str) -> Path:
    resolved = path.resolve()
    if not resolved.exists():
        raise KohyaVerifierError(f"{label} does not exist: {resolved}")
    if not resolved.is_dir():
        raise KohyaVerifierError(f"{label} is not a directory: {resolved}")
    return resolved


def _require_file(path: Path, label: str) -> Path:
    resolved = path.resolve()
    if not resolved.exists():
        raise KohyaVerifierError(f"{label} does not exist: {resolved}")
    if not resolved.is_file():
        raise KohyaVerifierError(f"{label} is not a file: {resolved}")
    return resolved


def _checkout_commit(sd_scripts_root: Path) -> str:
    command = ["git", "-C", str(sd_scripts_root), "rev-parse", "HEAD"]
    result = subprocess.run(command, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        raise KohyaVerifierError(
            "Could not read sd-scripts git commit: "
            f"command={shlex.join(command)!r}, returncode={result.returncode}, "
            f"stdout={result.stdout.strip()!r}, stderr={result.stderr.strip()!r}"
        )
    return result.stdout.strip().lower()


def _require_clean_checkout(sd_scripts_root: Path, phase: str) -> None:
    command = [
        "git",
        "-C",
        str(sd_scripts_root),
        "status",
        "--porcelain=v1",
        "--untracked-files=no",
    ]
    result = subprocess.run(command, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        raise KohyaVerifierError(
            "Could not inspect sd-scripts tracked checkout state: "
            f"phase={phase!r}, command={shlex.join(command)!r}, "
            f"returncode={result.returncode}, stdout={result.stdout.strip()!r}, "
            f"stderr={result.stderr.strip()!r}"
        )
    tracked_changes = result.stdout.strip()
    if tracked_changes:
        raise KohyaVerifierError(
            "sd-scripts tracked checkout is dirty: "
            f"phase={phase!r}, root={sd_scripts_root}, "
            f"tracked_changes={tracked_changes!r}. Restore or commit these tracked "
            "changes before verifying the pinned contract."
        )


def _upstream_command(
    python_executable: Path,
    config_path: Path,
    *,
    supports_conditioning: bool,
) -> list[str]:
    command = [
        str(python_executable),
        "-m",
        "library.config_util",
        "--support_dreambooth",
        "--support_finetuning",
        "--support_dropout",
    ]
    if supports_conditioning:
        command.append("--support_controlnet")
    command.append(str(config_path))
    return command


def _module_path_command(python_executable: Path) -> list[str]:
    probe = (
        "from pathlib import Path; "
        "import library.config_util as module; "
        f"print({_MODULE_PATH_PREFIX!r} + str(Path(module.__file__).resolve(strict=True)))"
    )
    return [str(python_executable), "-c", probe]


def _probe_module_path(
    python_executable: Path,
    sd_scripts_root: Path,
    environment: dict[str, str],
) -> Path:
    expected = _require_file(
        sd_scripts_root / "library" / "config_util.py",
        "Pinned sd-scripts config module",
    )
    command = _module_path_command(python_executable)
    try:
        result = subprocess.run(
            command,
            cwd=sd_scripts_root,
            env=environment,
            capture_output=True,
            text=True,
            check=False,
            timeout=120,
        )
    except subprocess.TimeoutExpired as exc:
        raise KohyaVerifierError(
            "sd-scripts module path probe timed out after 120 seconds: "
            f"command={shlex.join(command)!r}, root={sd_scripts_root}"
        ) from exc
    if result.returncode != 0:
        raise KohyaVerifierError(
            "Could not resolve the sd-scripts module path: "
            f"command={shlex.join(command)!r}, returncode={result.returncode}, "
            f"stdout={result.stdout.strip()!r}, stderr={result.stderr.strip()!r}"
        )
    matches = [
        line.removeprefix(_MODULE_PATH_PREFIX)
        for line in result.stdout.splitlines()
        if line.startswith(_MODULE_PATH_PREFIX)
    ]
    if len(matches) != 1 or not matches[0]:
        raise KohyaVerifierError(
            "sd-scripts module path probe returned an invalid response: "
            f"expected_prefix={_MODULE_PATH_PREFIX!r}, stdout={result.stdout.strip()!r}, "
            f"stderr={result.stderr.strip()!r}"
        )
    actual = Path(matches[0]).resolve()
    if not actual.is_file():
        raise KohyaVerifierError(
            "Resolved sd-scripts module is not a file: "
            f"expected={expected}, actual={actual}, python={python_executable}"
        )
    if actual != expected:
        raise KohyaVerifierError(
            "sd-scripts module path mismatch: "
            f"expected={expected}, actual={actual}, python={python_executable}, "
            f"root={sd_scripts_root}"
        )
    return actual


def verify_contract(
    sd_scripts_root: Path,
    python_executable: Path,
    config_path: Path,
) -> dict[str, object]:
    root = _require_directory(sd_scripts_root, "sd-scripts root")
    python_path = _require_file(python_executable, "sd-scripts Python")
    config = _require_file(config_path, "Kohya config")
    try:
        options = validate_kohya_toml_text(config.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, KohyaTrainerContractError) as exc:
        raise KohyaVerifierError(f"Kohya config failed local contract validation: {exc}") from exc
    actual_commit = _checkout_commit(root)
    if actual_commit != KOHYA_UPSTREAM_COMMIT:
        raise KohyaVerifierError(
            "sd-scripts commit mismatch: "
            f"expected={KOHYA_UPSTREAM_COMMIT}, actual={actual_commit}, root={root}"
        )
    _require_clean_checkout(root, "before module path probe")
    environment = dict(os.environ)
    module_path = _probe_module_path(python_path, root, environment)
    _require_clean_checkout(root, "before upstream config import")
    command = _upstream_command(
        python_path,
        config,
        supports_conditioning=options.conditioning_data_dir is not None,
    )
    try:
        result = subprocess.run(
            command,
            cwd=root,
            env=environment,
            capture_output=True,
            text=True,
            check=False,
            timeout=120,
        )
    except subprocess.TimeoutExpired as exc:
        raise KohyaVerifierError(
            f"Upstream config import timed out after 120 seconds: command={shlex.join(command)!r}"
        ) from exc
    _require_clean_checkout(root, "after upstream config import")
    if result.returncode != 0:
        raise KohyaVerifierError(
            "Upstream config import rejected the Kohya contract: "
            f"command={shlex.join(command)!r}, returncode={result.returncode}, "
            f"stdout={result.stdout.strip()!r}, stderr={result.stderr.strip()!r}"
        )
    return {
        "status": "verified",
        "upstream_commit": actual_commit,
        "config": str(config),
        "conditioning": options.conditioning_data_dir is not None,
        "module_path": str(module_path),
        "command": command,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sd-scripts-root", type=Path, required=True)
    parser.add_argument("--sd-scripts-python", type=Path, required=True)
    parser.add_argument("config", type=Path)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        result = verify_contract(
            args.sd_scripts_root,
            args.sd_scripts_python,
            args.config,
        )
    except KohyaVerifierError as exc:
        print(f"Kohya trainer contract verification failed: {exc}", file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
