#!/usr/bin/env python3
"""
Security check script for SD Image Sorter.

Runs dependency vulnerability scanning using safety.
Run this before releases to check for known CVEs in dependencies.

Usage:
    python scripts/security_check.py

Exit codes:
    0 - No vulnerabilities found
    1 - Vulnerabilities found or error occurred
"""
import subprocess
import sys
import os


def check_safety_installed() -> bool:
    """Check if safety is installed."""
    try:
        import safety
        return True
    except ImportError:
        return False


def install_safety() -> bool:
    """Install safety package."""
    print("Installing safety package...")
    try:
        subprocess.check_call([sys.executable, "-m", "pip", "install", "safety"])
        return True
    except subprocess.CalledProcessError:
        print("ERROR: Failed to install safety package")
        return False


def run_safety_check(requirements_path: str) -> int:
    """Run safety check on requirements file."""
    print(f"Checking {requirements_path} for known vulnerabilities...")
    print("-" * 60)

    try:
        # Run safety check
        result = subprocess.run(
            [sys.executable, "-m", "safety", "check", "-r", requirements_path],
            capture_output=False,
            text=True
        )
        return result.returncode
    except subprocess.CalledProcessError as e:
        print(f"ERROR: Safety check failed with error: {e}")
        return 1


def main():
    """Main entry point."""
    # Find requirements.txt
    script_dir = os.path.dirname(os.path.abspath(__file__))
    project_root = os.path.dirname(script_dir)
    requirements_path = os.path.join(project_root, "backend", "requirements.txt")

    if not os.path.exists(requirements_path):
        print(f"ERROR: Requirements file not found: {requirements_path}")
        sys.exit(1)

    # Check if safety is installed
    if not check_safety_installed():
        if not install_safety():
            sys.exit(1)

    print("=" * 60)
    print("SD Image Sorter - Dependency Security Check")
    print("=" * 60)

    # Run safety check
    exit_code = run_safety_check(requirements_path)

    print("-" * 60)
    if exit_code == 0:
        print("SUCCESS: No known vulnerabilities found in dependencies")
    else:
        print("WARNING: Vulnerabilities found or check failed")
        print("Please review the output above and update affected packages")

    sys.exit(exit_code)


if __name__ == "__main__":
    main()
