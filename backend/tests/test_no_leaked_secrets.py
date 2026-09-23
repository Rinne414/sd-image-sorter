"""Tracked sources must not embed live-looking API keys.

A one-off Playwright script committed a real AIHubMix key in 2026-05. GitHub
visitors could read it from main. This pin scans the git index so a later
working-tree-only cleanup cannot hide the same class of leak.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]


def _load_security_check():
    script_path = REPO_ROOT / "scripts" / "security_check.py"
    spec = importlib.util.spec_from_file_location("security_check_for_secrets", script_path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_tracked_sources_do_not_embed_live_api_keys():
    leaks = _load_security_check().find_live_secrets(REPO_ROOT)
    assert not leaks, (
        "tracked files embed a live-looking secret. Use an environment variable. "
        "Offending files:\n  " + "\n  ".join(leaks)
    )
