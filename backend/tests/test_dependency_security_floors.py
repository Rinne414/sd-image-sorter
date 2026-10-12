"""Every compiled lock installs a fixed version of each package with a known advisory.

The floors live in the .in files (one commented line each); this checks the
compiled locks that users actually install from, so a lock refreshed from an
old cache or edited by hand cannot quietly bring a vulnerable version back.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest
from packaging.version import Version

BACKEND = Path(__file__).resolve().parents[1]
LOCKS = ("requirements-core.txt", "requirements.txt", "requirements-dev.txt")

# package -> first fixed version (advisory)
SECURITY_FLOORS = {
    # CVE-2026-104851 / GHSA-27vj-qcqg-25rc: ReferenceFileSystem renders a
    # reference document through un-sandboxed jinja2 (code execution).
    "fsspec": "2026.6.0",
}


def _pinned_version(lock_text: str, package: str) -> str | None:
    match = re.search(
        rf"^{re.escape(package)}==([^\s;]+)", lock_text, re.MULTILINE | re.IGNORECASE
    )
    return match.group(1) if match else None


@pytest.mark.parametrize("lock", LOCKS)
@pytest.mark.parametrize(("package", "fixed"), sorted(SECURITY_FLOORS.items()))
def test_locks_pin_a_fixed_version(lock, package, fixed):
    pinned = _pinned_version((BACKEND / lock).read_text(encoding="utf-8"), package)
    if pinned is None:
        pytest.skip(f"{lock} does not install {package}")
    assert Version(pinned) >= Version(fixed), (
        f"{lock} pins {package}=={pinned}; {fixed} fixes the advisory"
    )


@pytest.mark.parametrize("source", ("requirements-core.in", "requirements.in"))
@pytest.mark.parametrize(("package", "fixed"), sorted(SECURITY_FLOORS.items()))
def test_inputs_declare_the_floor(source, package, fixed):
    lines = (BACKEND / source).read_text(encoding="utf-8").splitlines()

    assert f"{package}>={fixed}" in lines
