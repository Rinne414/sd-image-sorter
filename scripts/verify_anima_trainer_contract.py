#!/usr/bin/env python3
"""Verify one Anima TOML with the pinned external anima_lora checkout."""

from __future__ import annotations

import argparse
import json
import os
import shlex
import subprocess
import sys
from pathlib import Path
from typing import Optional, Sequence, TypedDict


ROOT = Path(__file__).resolve().parents[1]
BACKEND_ROOT = ROOT / "backend"
sys.path.insert(0, str(BACKEND_ROOT))

from services.dataset_export.anima_contract import (  # noqa: E402
    ANIMA_UPSTREAM_COMMIT,
    AnimaTrainerContractError,
    validate_anima_toml_text,
)


COMMAND_TIMEOUT_SECONDS = 120
_MODULE_PATH_PREFIX = "SD_IMAGE_SORTER_ANIMA_MODULE="


class AnimaVerifierError(RuntimeError):
    """Raised when pinned upstream verification cannot be completed."""


class AnimaVerificationResult(TypedDict):
    status: str
    upstream_commit: str
    config: str
    masked: bool
    module_path: str
    command: list[str]
    upstream_schema_validated: bool
    artifact_completeness_validated: bool


def _require_directory(path: Path, label: str) -> Path:
    resolved = path.resolve()
    if not resolved.exists():
        raise AnimaVerifierError(f"{label} does not exist: {resolved}")
    if not resolved.is_dir():
        raise AnimaVerifierError(f"{label} is not a directory: {resolved}")
    return resolved


def _require_file(path: Path, label: str) -> Path:
    resolved = path.resolve()
    if not resolved.exists():
        raise AnimaVerifierError(f"{label} does not exist: {resolved}")
    if not resolved.is_file():
        raise AnimaVerifierError(f"{label} is not a file: {resolved}")
    return resolved


def _run_git(command: list[str], phase: str) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(
            command,
            capture_output=True,
            text=True,
            check=False,
            timeout=COMMAND_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired as exc:
        raise AnimaVerifierError(
            "anima_lora git command timed out: "
            f"phase={phase!r}, timeout_seconds={COMMAND_TIMEOUT_SECONDS}, "
            f"command={shlex.join(command)!r}"
        ) from exc


def _checkout_commit(anima_lora_root: Path) -> str:
    command = ["git", "-C", str(anima_lora_root), "rev-parse", "HEAD"]
    result = _run_git(command, "read pinned commit")
    if result.returncode != 0:
        raise AnimaVerifierError(
            "Could not read anima_lora git commit: "
            f"command={shlex.join(command)!r}, returncode={result.returncode}, "
            f"stdout={result.stdout.strip()!r}, stderr={result.stderr.strip()!r}"
        )
    return result.stdout.strip().lower()


def _require_clean_checkout(anima_lora_root: Path, phase: str) -> None:
    command = [
        "git",
        "-C",
        str(anima_lora_root),
        "status",
        "--porcelain=v1",
        "--untracked-files=no",
    ]
    result = _run_git(command, phase)
    if result.returncode != 0:
        raise AnimaVerifierError(
            "Could not inspect anima_lora tracked checkout state: "
            f"phase={phase!r}, command={shlex.join(command)!r}, "
            f"returncode={result.returncode}, stdout={result.stdout.strip()!r}, "
            f"stderr={result.stderr.strip()!r}"
        )
    tracked_changes = result.stdout.strip()
    if tracked_changes:
        raise AnimaVerifierError(
            "anima_lora tracked checkout is dirty: "
            f"phase={phase!r}, root={anima_lora_root}, "
            f"tracked_changes={tracked_changes!r}. Restore or commit these tracked "
            "changes before verifying the pinned contract."
        )


def _module_path_command(python_executable: Path) -> list[str]:
    probe = (
        "from pathlib import Path; "
        "import library.config.loader as module; "
        f"print({_MODULE_PATH_PREFIX!r} + str(Path(module.__file__).resolve(strict=True)))"
    )
    return [str(python_executable), "-c", probe]


def _native_import_command(
    python_executable: Path,
    config_path: Path,
) -> list[str]:
    return [
        str(python_executable),
        "-m",
        "library.config.loader",
        "--support_dropout",
        str(config_path),
    ]


def _run_upstream(
    command: list[str],
    anima_lora_root: Path,
    environment: dict[str, str],
    phase: str,
) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(
            command,
            cwd=anima_lora_root,
            env=environment,
            capture_output=True,
            text=True,
            check=False,
            timeout=COMMAND_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired as exc:
        raise AnimaVerifierError(
            f"anima_lora {phase} timed out after {COMMAND_TIMEOUT_SECONDS} seconds: "
            f"command={shlex.join(command)!r}, root={anima_lora_root}"
        ) from exc


def _probe_module_path(
    python_executable: Path,
    anima_lora_root: Path,
    environment: dict[str, str],
) -> Path:
    expected = _require_file(
        anima_lora_root / "library" / "config" / "loader.py",
        "Pinned anima_lora config module",
    )
    command = _module_path_command(python_executable)
    result = _run_upstream(
        command,
        anima_lora_root,
        environment,
        "module path probe",
    )
    if result.returncode != 0:
        raise AnimaVerifierError(
            "Could not resolve the anima_lora module path: "
            f"command={shlex.join(command)!r}, root={anima_lora_root}, "
            f"returncode={result.returncode}, stdout={result.stdout.strip()!r}, "
            f"stderr={result.stderr.strip()!r}"
        )
    matches = [
        line.removeprefix(_MODULE_PATH_PREFIX)
        for line in result.stdout.splitlines()
        if line.startswith(_MODULE_PATH_PREFIX)
    ]
    if len(matches) != 1 or not matches[0]:
        raise AnimaVerifierError(
            "anima_lora module path probe returned an invalid response: "
            f"expected_prefix={_MODULE_PATH_PREFIX!r}, stdout={result.stdout.strip()!r}, "
            f"stderr={result.stderr.strip()!r}"
        )
    actual = Path(matches[0]).resolve()
    if not actual.is_file():
        raise AnimaVerifierError(
            "Resolved anima_lora module is not a file: "
            f"expected={expected}, actual={actual}, python={python_executable}"
        )
    if actual != expected:
        raise AnimaVerifierError(
            "anima_lora module path mismatch: "
            f"expected={expected}, actual={actual}, python={python_executable}, "
            f"root={anima_lora_root}"
        )
    return actual


def verify_contract(
    anima_lora_root: Path,
    python_executable: Path,
    config_path: Path,
) -> AnimaVerificationResult:
    root = _require_directory(anima_lora_root, "anima_lora root")
    python_path = _require_file(python_executable, "anima_lora Python")
    config = _require_file(config_path, "Anima config")
    try:
        options = validate_anima_toml_text(config.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, AnimaTrainerContractError) as exc:
        raise AnimaVerifierError(
            f"Anima config failed local schema validation: {exc}"
        ) from exc
    actual_commit = _checkout_commit(root)
    if actual_commit != ANIMA_UPSTREAM_COMMIT:
        raise AnimaVerifierError(
            "anima_lora commit mismatch: "
            f"expected={ANIMA_UPSTREAM_COMMIT}, actual={actual_commit}, root={root}"
        )
    environment = dict(os.environ)
    _require_clean_checkout(root, "before module path probe")
    try:
        module_path = _probe_module_path(python_path, root, environment)
    finally:
        _require_clean_checkout(root, "after module path probe")
    _require_clean_checkout(root, "before upstream config import")
    command = _native_import_command(python_path, config)
    try:
        result = _run_upstream(
            command,
            root,
            environment,
            "native config import",
        )
    finally:
        _require_clean_checkout(root, "after upstream config import")
    if result.returncode != 0:
        raise AnimaVerifierError(
            "Pinned anima_lora native importer rejected the Anima contract: "
            f"command={shlex.join(command)!r}, root={root}, "
            f"returncode={result.returncode}, stdout={result.stdout.strip()!r}, "
            f"stderr={result.stderr.strip()!r}"
        )
    return {
        "status": "verified",
        "upstream_commit": actual_commit,
        "config": str(config),
        "masked": options.mask_dir is not None,
        "module_path": str(module_path),
        "command": command,
        "upstream_schema_validated": True,
        "artifact_completeness_validated": False,
    }


def parse_args(arguments: Optional[Sequence[str]]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--anima-lora-root", type=Path, required=True)
    parser.add_argument("--anima-lora-python", type=Path, required=True)
    parser.add_argument("config", type=Path)
    return parser.parse_args(arguments)


def main(arguments: Optional[Sequence[str]]) -> int:
    args = parse_args(arguments)
    try:
        result = verify_contract(
            args.anima_lora_root,
            args.anima_lora_python,
            args.config,
        )
    except AnimaVerifierError as exc:
        print(f"Anima trainer contract verification failed: {exc}", file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
