#!/usr/bin/env python3
"""
Security check script for SD Image Sorter.

Runs dependency vulnerability scanning using pip-audit so the check works
without an external Safety login session.

Usage:
    python scripts/security_check.py

Exit codes:
    0 - No vulnerabilities found
    1 - Vulnerabilities found or error occurred
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
import venv
from pathlib import Path


# Accepted-vulnerability allowlist.
#
# pip-audit now scans the FULL resolved dependency tree (no --no-deps), so it
# surfaces advisories in transitive/framework-pinned packages we cannot fix by
# upgrading without breaking the AI runtime / web stack. Each entry MUST be a
# deliberate, reviewed decision and MUST document: the package, why it cannot be
# upgraded right now, and the residual risk for this localhost-only tool. Remove
# an entry as soon as a compatible fixed version can be pinned.
#
# Curate this list before flipping the audit to blocking in run_ci.py: any newly
# firing advisory that is NOT listed here will (correctly) fail the build.
IGNORED_VULN_IDS: tuple[str, ...] = (
    # starlette 0.52.1 (pinned transitively by fastapi==0.136.1). Fix is 1.0.1,
    # which is a breaking upgrade for the pinned FastAPI. Advisory is Host-header
    # path injection; mitigated by the loopback-only middleware in backend/main.py.
    "PYSEC-2026-161",
    # torch 2.11.0 (AI runtime pin). CVE-2025-3000: memory corruption in
    # torch.jit.script with a LOCAL attack vector (CVSS4 AV:L, low C/I/A) and
    # NO fixed release published (pip-audit Fix Versions is empty). Reviewed
    # 2026-06-11: this codebase never calls torch.jit.* (grep: zero matches —
    # taggers run via ONNX Runtime; torch only does direct inference on
    # bundled/vetted model weights), and a local attacker able to feed
    # TorchScript to torch.jit.script can already run arbitrary code as that
    # user. Residual risk for this localhost-only tool: none beyond baseline.
    # Remove when a fixed torch version compatible with the CUDA runtime ships.
    "CVE-2025-3000",
)


def _python_has_pip_audit(python_executable: str) -> bool:
    """Check if pip-audit is importable by the given interpreter."""
    result = subprocess.run(
        [python_executable, "-c", "import pip_audit"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    return result.returncode == 0


def _venv_python(venv_dir: Path) -> Path:
    if os.name == "nt":
        return venv_dir / "Scripts" / "python.exe"
    return venv_dir / "bin" / "python"


def _create_pip_audit_venv(venv_dir: Path) -> bool:
    try:
        venv.EnvBuilder(with_pip=True).create(venv_dir)
        if _venv_python(venv_dir).exists():
            return True
    except (Exception, SystemExit) as exc:
        print(f"WARNING: Standard venv creation failed: {exc}")

    shutil.rmtree(venv_dir, ignore_errors=True)
    try:
        subprocess.check_call([
            sys.executable,
            "-m",
            "venv",
            "--without-pip",
            "--system-site-packages",
            str(venv_dir),
        ])
        return _venv_python(venv_dir).exists()
    except subprocess.CalledProcessError as exc:
        print(f"ERROR: Failed to create fallback pip-audit virtual environment: {exc}")
        return False


def install_pip_audit(python_executable: str) -> bool:
    """Install pip-audit into a dedicated interpreter."""
    print("Installing pip-audit package...")
    try:
        subprocess.check_call([python_executable, "-m", "pip", "install", "pip-audit>=2.9.0,<3.0.0"])
        return True
    except subprocess.CalledProcessError:
        print("ERROR: Failed to install pip-audit")
        return False


def ensure_pip_audit_runner() -> str | None:
    """Return a Python executable that can run pip-audit.

    System Python can be externally managed by PEP 668, so missing pip-audit is
    installed into a disposable temp venv instead of the global interpreter.
    """
    if _python_has_pip_audit(sys.executable):
        return sys.executable

    venv_dir = Path(tempfile.gettempdir()) / f"sd-image-sorter-pip-audit-py{sys.version_info.major}{sys.version_info.minor}"
    python_executable = _venv_python(venv_dir)
    if not python_executable.exists():
        print(f"Creating pip-audit virtual environment: {venv_dir}")
        if not _create_pip_audit_venv(venv_dir):
            return None

    if not _python_has_pip_audit(str(python_executable)) and not install_pip_audit(str(python_executable)):
        return None

    return str(python_executable)


def run_pip_audit(requirements_path: str, python_executable: str) -> int:
    """Run pip-audit against the full resolved backend dependency tree.

    --no-deps is intentionally omitted so transitive packages are audited too.
    Accepted advisories are suppressed explicitly via IGNORED_VULN_IDS so the
    allowlist is auditable in source control rather than hidden behind a flag
    that skips the dependency graph entirely.
    """
    print(f"Scanning {requirements_path} (full dependency tree) for known vulnerabilities...")
    if IGNORED_VULN_IDS:
        print(f"Ignoring {len(IGNORED_VULN_IDS)} reviewed advisory id(s): {', '.join(IGNORED_VULN_IDS)}")
    print("-" * 60)

    command = [
        python_executable,
        "-m",
        "pip_audit",
        "-r",
        requirements_path,
        "--progress-spinner",
        "off",
    ]
    for vuln_id in IGNORED_VULN_IDS:
        command.extend(["--ignore-vuln", vuln_id])

    try:
        result = subprocess.run(
            command,
            capture_output=False,
            text=True,
        )
        return result.returncode
    except subprocess.CalledProcessError as exc:
        print(f"ERROR: pip-audit failed with error: {exc}")
        return 1


def main() -> None:
    """Main entry point."""
    script_dir = os.path.dirname(os.path.abspath(__file__))
    project_root = os.path.dirname(script_dir)
    requirements_path = os.path.join(project_root, "backend", "requirements.txt")

    if not os.path.exists(requirements_path):
        print(f"ERROR: Requirements file not found: {requirements_path}")
        sys.exit(1)

    audit_python = ensure_pip_audit_runner()
    if audit_python is None:
        sys.exit(1)

    print("=" * 60)
    print("SD Image Sorter - Dependency Security Check")
    print("=" * 60)

    exit_code = run_pip_audit(requirements_path, audit_python)

    print("-" * 60)
    if exit_code == 0:
        print("SUCCESS: No known vulnerabilities found in dependencies")
    else:
        print("WARNING: Vulnerabilities found or scan failed")
        print("Please review the output above and update affected packages")

    sys.exit(exit_code)


if __name__ == "__main__":
    main()
