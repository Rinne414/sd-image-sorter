"""Scan-token manifests must live under the configured temp root, not backend/data."""

from __future__ import annotations

import os
import sys
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import config  # noqa: E402
import services.dataset_session_service as dss  # noqa: E402
import services.dataset_session.manifest_store as manifest_store  # noqa: E402

TOKEN = "a" * 32


@pytest.fixture
def temp_root(tmp_path, monkeypatch):
    root = tmp_path / "isolated-tmp"
    monkeypatch.setattr(config, "TEMP_DIR", root)
    monkeypatch.setattr(dss, "_SCAN_DIR", None)
    return root


def _age(path: Path, seconds: int) -> None:
    stamp = time.time() - seconds
    os.utime(path, (stamp, stamp))


def test_scan_dir_resolves_under_configured_temp_dir(temp_root):
    scan_dir = dss._get_scan_dir()

    assert scan_dir == temp_root / "dataset-scans"
    assert scan_dir.is_dir()


def test_scan_dir_follows_temp_dir_change_after_cache_reset(temp_root, tmp_path, monkeypatch):
    dss._get_scan_dir()
    other = tmp_path / "other-tmp"
    monkeypatch.setattr(config, "TEMP_DIR", other)
    monkeypatch.setattr(dss, "_SCAN_DIR", None)

    assert dss._get_scan_dir() == other / "dataset-scans"


def test_purge_sweeps_expired_files_in_legacy_dir(temp_root, tmp_path, monkeypatch):
    legacy = tmp_path / "legacy-backend" / "data" / "dataset-scans"
    legacy.mkdir(parents=True)
    stale = legacy / f"{TOKEN}.json"
    fresh = legacy / f"{'b' * 32}.json"
    unrelated = legacy / "notes.txt"
    for f in (stale, fresh, unrelated):
        f.write_text("x")
    _age(stale, manifest_store.SCAN_TOKEN_TTL_SECONDS + 60)
    _age(unrelated, manifest_store.SCAN_TOKEN_TTL_SECONDS + 60)
    monkeypatch.setattr(manifest_store, "_legacy_scan_dir", lambda: legacy)

    removed = manifest_store.purge_legacy_scan_manifests()

    assert removed == 1
    assert not stale.exists()
    assert fresh.exists()
    assert unrelated.exists()


def test_legacy_purge_is_noop_when_dir_missing(temp_root, tmp_path, monkeypatch):
    missing = tmp_path / "nope" / "dataset-scans"
    monkeypatch.setattr(manifest_store, "_legacy_scan_dir", lambda: missing)

    assert manifest_store.purge_legacy_scan_manifests() == 0
    assert not missing.exists()
