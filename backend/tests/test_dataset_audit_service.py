"""Tests for the v3.2.2 Dataset Audit service (T9).

Audit checks aesthetic + phash + tag-presence + dimension. All
thresholds are optional and default to ``None`` (= don't flag).

The user explicitly asked for no hard limits in v3.2.2: every flag
must be opt-in via the request payload.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from services.dataset_audit_service import (  # noqa: E402
    _build_duplicate_groups,
    _hamming_distance_hex,
    audit_dataset,
)


# ============== _hamming_distance_hex ==============

def test_hamming_zero_for_identical():
    assert _hamming_distance_hex("abcdef", "abcdef") == 0


def test_hamming_counts_bit_diffs():
    # 0xff vs 0x00 = 8 bit diffs
    assert _hamming_distance_hex("ff", "00") == 8


def test_hamming_huge_for_different_length():
    """Different-length hex strings can't be meaningfully compared."""
    assert _hamming_distance_hex("abcdef", "abcdefab") == 999


def test_hamming_huge_for_invalid_hex():
    assert _hamming_distance_hex("zzz", "fff") == 999


# ============== _build_duplicate_groups ==============

def test_duplicate_groups_clusters_close_phashes():
    rows = [
        {"image_id": 1, "abs_path": "/a", "phash_hex": "ff00ff00ff00ff00"},
        {"image_id": 2, "abs_path": "/b", "phash_hex": "ff00ff00ff00ff01"},  # 1 bit diff
        {"image_id": 3, "abs_path": "/c", "phash_hex": "0000000000000000"},  # very different
    ]
    groups = _build_duplicate_groups(rows, phash_max=2)
    assert len(groups) == 1
    assert sorted(groups[0]["image_ids"]) == [1, 2]


def test_duplicate_groups_strict_threshold_zero():
    """phash_max=0 only matches exact duplicates."""
    rows = [
        {"image_id": 1, "abs_path": "/a", "phash_hex": "ff00ff00ff00ff00"},
        {"image_id": 2, "abs_path": "/b", "phash_hex": "ff00ff00ff00ff00"},
        {"image_id": 3, "abs_path": "/c", "phash_hex": "ff00ff00ff00ff01"},
    ]
    groups = _build_duplicate_groups(rows, phash_max=0)
    assert len(groups) == 1
    assert sorted(groups[0]["image_ids"]) == [1, 2]


def test_duplicate_groups_skips_rows_without_phash():
    rows = [
        {"image_id": 1, "abs_path": "/a", "phash_hex": None},
        {"image_id": 2, "abs_path": "/b", "phash_hex": "ff00ff00ff00ff00"},
    ]
    assert _build_duplicate_groups(rows, phash_max=5) == []


def test_duplicate_groups_large_dataset_uses_exact_hash_fallback():
    rows = [
        {"image_id": i, "abs_path": f"/img{i}.png", "phash_hex": f"{i:016x}"}
        for i in range(5001)
    ]
    rows[10]["phash_hex"] = "abc0000000000000"
    rows[20]["phash_hex"] = "abc0000000000000"
    rows[30]["phash_hex"] = "abc0000000000001"  # near, but not exact

    groups = _build_duplicate_groups(rows, phash_max=4)

    assert len(groups) == 1
    assert sorted(groups[0]["image_ids"]) == [10, 20]


# ============== audit_dataset (path-mode) ==============

@pytest.fixture
def audit_sandbox(tmp_path: Path):
    """Three small images in different sizes to exercise dim_min."""
    folder = tmp_path / "audit"
    folder.mkdir()
    paths = []
    # 800x800 — passes dim_min=512
    p1 = folder / "ok.png"
    Image.new("RGB", (800, 800), color=(120, 200, 60)).save(p1)
    paths.append(p1)
    # 400x400 — fails dim_min=512
    p2 = folder / "small.png"
    Image.new("RGB", (400, 400), color=(50, 50, 50)).save(p2)
    paths.append(p2)
    # 768x768
    p3 = folder / "med.png"
    Image.new("RGB", (768, 768), color=(200, 50, 50)).save(p3)
    paths.append(p3)
    return paths


def test_audit_returns_summary_and_items(audit_sandbox):
    """Default (no thresholds) flags only ``untagged`` since path-mode
    items have no DB tags."""
    paths = [str(p) for p in audit_sandbox]
    report = audit_dataset(image_paths=paths)
    assert report["summary"]["total"] == 3
    # No aesthetic_max -> no low_quality flags
    assert report["summary"]["low_quality_count"] == 0
    # No phash_max -> no duplicate detection
    assert report["summary"]["duplicate_pairs"] == 0
    # tag_count is 0 for path-mode items so all 3 are untagged
    assert report["summary"]["untagged_count"] == 3
    # No dim_min -> no small flag
    assert report["summary"]["small_count"] == 0


def test_audit_dim_min_flags_small_images(audit_sandbox):
    paths = [str(p) for p in audit_sandbox]
    report = audit_dataset(image_paths=paths, dim_min=512)
    assert report["summary"]["small_count"] == 1
    small_items = [it for it in report["items"] if "small" in it["flags"]]
    assert len(small_items) == 1
    assert small_items[0]["filename"] == "small.png"


def test_audit_extra_tag_counts_handles_local_captions(audit_sandbox):
    """The frontend supplies localStorage caption presence info via
    ``extra_tag_counts``. Items with non-zero counts shouldn't be
    flagged ``untagged``."""
    paths = [str(p) for p in audit_sandbox]
    report = audit_dataset(
        image_paths=paths,
        extra_tag_counts={str(audit_sandbox[0]): 5, str(audit_sandbox[2]): 3},
    )
    untagged = [it["filename"] for it in report["items"] if "untagged" in it["flags"]]
    assert untagged == ["small.png"]


def test_audit_no_thresholds_means_no_flags_other_than_untagged(audit_sandbox):
    """User asked for no-hard-limit defaults. With every threshold
    omitted the audit should not surface ``low_quality`` or ``small``
    flags — only ``untagged`` (which is unconditional)."""
    report = audit_dataset(image_paths=[str(p) for p in audit_sandbox])
    for item in report["items"]:
        for flag in item["flags"]:
            assert flag != "low_quality", f"low_quality flagged without aesthetic_max: {item}"
            assert flag != "small", f"small flagged without dim_min: {item}"


def test_audit_disable_aesthetic_skips_inference(audit_sandbox, monkeypatch):
    """``enable_aesthetic=False`` must not call into the aesthetic
    backend. We monkey-patch ``_safe_aesthetic_score`` to a tripwire."""
    import services.dataset_audit_service as dass

    calls = []
    def tripwire(p):
        calls.append(p)
        return None
    monkeypatch.setattr(dass, "_safe_aesthetic_score", tripwire)

    audit_dataset(
        image_paths=[str(p) for p in audit_sandbox],
        aesthetic_max=5.5,
        enable_aesthetic=False,
    )
    assert calls == [], f"_safe_aesthetic_score was called {len(calls)} times despite enable_aesthetic=False"


def test_audit_disable_phash_skips_inference(audit_sandbox, monkeypatch):
    import services.dataset_audit_service as dass

    calls = []
    def tripwire(p):
        calls.append(p)
        return None
    monkeypatch.setattr(dass, "_safe_phash_hex", tripwire)

    audit_dataset(
        image_paths=[str(p) for p in audit_sandbox],
        phash_max=5,
        enable_phash=False,
    )
    assert calls == []


def test_audit_recognises_missing_gallery_ids(test_db, audit_sandbox):
    """An image_id that doesn't exist in the DB should be reported with
    a ``missing`` flag rather than crashing the audit."""
    report = audit_dataset(
        image_ids=[9_999_999],  # almost certainly not in test DB
        image_paths=[str(audit_sandbox[0])],
    )
    missing = [it for it in report["items"] if "missing" in it["flags"]]
    assert len(missing) == 1
    assert missing[0]["image_id"] == 9_999_999
    assert report["summary"]["missing_count"] == 1


# ============== route layer ==============

def test_route_audit_requires_at_least_one_input(test_client):
    resp = test_client.post("/api/dataset/audit", json={"image_ids": [], "image_paths": []})
    assert resp.status_code == 400


def test_route_audit_runs_path_only_with_no_thresholds(test_client, audit_sandbox):
    resp = test_client.post("/api/dataset/audit", json={
        "image_paths": [str(p) for p in audit_sandbox],
        "image_ids": [],
    })
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["summary"]["total"] == 3
    assert body["summary"]["low_quality_count"] == 0
    assert body["summary"]["small_count"] == 0


def test_route_audit_dim_min_filter(test_client, audit_sandbox):
    resp = test_client.post("/api/dataset/audit", json={
        "image_paths": [str(p) for p in audit_sandbox],
        "image_ids": [],
        "dim_min": 512,
    })
    assert resp.status_code == 200
    assert resp.json()["summary"]["small_count"] == 1
