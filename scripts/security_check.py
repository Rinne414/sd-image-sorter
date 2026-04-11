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
import subprocess
import sys


def check_pip_audit_installed() -> bool:
    """Check if pip-audit is installed in the current interpreter."""
    try:
        import pip_audit  # type: ignore  # noqa: F401
        return True
    except ImportError:
        return False


def install_pip_audit() -> bool:
    """Install pip-audit."""
    print("Installing pip-audit package...")
    try:
        subprocess.check_call([sys.executable, "-m", "pip", "install", "pip-audit>=2.9.0,<3.0.0"])
        return True
    except subprocess.CalledProcessError:
        print("ERROR: Failed to install pip-audit")
        return False


def run_pip_audit(requirements_path: str) -> int:
    """Run pip-audit against the backend requirements file."""
    print(f"Scanning {requirements_path} for known vulnerabilities...")
    print("-" * 60)

    try:
        result = subprocess.run(
            [
                sys.executable,
                "-m",
                "pip_audit",
                "-r",
                requirements_path,
                "--progress-spinner",
                "off",
            ],
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

    if not check_pip_audit_installed():
        if not install_pip_audit():
            sys.exit(1)

    print("=" * 60)
    print("SD Image Sorter - Dependency Security Check")
    print("=" * 60)

    exit_code = run_pip_audit(requirements_path)

    print("-" * 60)
    if exit_code == 0:
        print("SUCCESS: No known vulnerabilities found in dependencies")
    else:
        print("WARNING: Vulnerabilities found or scan failed")
        print("Please review the output above and update affected packages")

    sys.exit(exit_code)


if __name__ == "__main__":
    main()
