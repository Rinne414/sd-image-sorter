"""Regression tests for /api/images query parameter aliases.

UX-4 (MEDIUM): The /api/images endpoint declared its generator filter
as ``generators`` (plural) but most callers (humans, the OpenAPI
example doc, my own test scripts during the bug hunt) reach for the
natural singular form ``?generator=nai`` first. FastAPI silently
ignores unknown query params, so ``?generator=nai`` returned the
ENTIRE unfiltered library (71,182 images on the user's machine)
instead of just the 2,291 NAI ones. There was no warning, no 400.

Fix: accept ``generator`` (singular) as an alias for ``generators``.
If both are passed they are merged and deduped.
"""
from __future__ import annotations

import pytest


def test_singular_generator_alias_filters(test_client, test_db_with_images):
    """``?generator=X`` (singular) must filter the same as ``?generators=X``."""
    r_singular = test_client.get("/api/images?generator=comfyui&limit=200")
    r_plural = test_client.get("/api/images?generators=comfyui&limit=200")
    assert r_singular.status_code == 200, r_singular.text
    assert r_plural.status_code == 200, r_plural.text
    assert r_singular.json()["total"] == r_plural.json()["total"], (
        "Singular ``generator`` must produce the same total as plural ``generators``."
    )


def test_singular_generator_does_not_return_unfiltered(test_client, test_db_with_images):
    """Ensure ``?generator=nai`` does NOT silently fall through to "no filter"
    (which was the original bug)."""
    # First fetch the unfiltered total
    r_total = test_client.get("/api/images?limit=1")
    assert r_total.status_code == 200
    total_unfiltered = r_total.json()["total"]

    # If there's only 1 generator in the test DB, this test would be vacuous.
    # Skip if so.
    r_stats = test_client.get("/api/stats")
    assert r_stats.status_code == 200
    generators = r_stats.json().get("generators", [])
    if len([g for g in generators if g.get("count", 0) > 0]) <= 1:
        pytest.skip("Need >1 generator in test DB to verify filtering")

    # Pick a generator that doesn't include all images
    gen = next((g["generator"] for g in generators if 0 < g.get("count", 0) < total_unfiltered), None)
    if not gen:
        pytest.skip("Need a generator with partial coverage")

    r_filtered = test_client.get(f"/api/images?generator={gen}&limit=1")
    assert r_filtered.status_code == 200
    assert r_filtered.json()["total"] < total_unfiltered, (
        f"?generator={gen} must narrow the result. Original bug: it was silently "
        f"ignored and returned the full {total_unfiltered}-image library. "
        f"Got: {r_filtered.json()['total']}"
    )


def test_singular_and_plural_generator_combined(test_client, test_db_with_images):
    """When both ``generator`` and ``generators`` are passed, they should be
    treated as a union (combined comma-separated list passed to the
    underlying filter)."""
    r_stats = test_client.get("/api/stats").json()
    gen_counts = {g["generator"]: g.get("count", 0) for g in r_stats.get("generators", [])}
    valid = [g for g, c in gen_counts.items() if c > 0]
    if len(valid) < 2:
        pytest.skip("Need at least 2 generators with images for this test")

    a, b = valid[0], valid[1]
    # Verify that ``generators=a,b`` works (baseline, the existing behavior)
    r_combined_plural = test_client.get(f"/api/images?generators={a},{b}&limit=1")
    assert r_combined_plural.status_code == 200
    expected = r_combined_plural.json()["total"]

    # Now verify the singular alias is folded in correctly. The merged
    # query string should be functionally equivalent to the comma-joined plural.
    r_combined = test_client.get(f"/api/images?generator={a}&generators={b}&limit=1")
    assert r_combined.status_code == 200
    assert r_combined.json()["total"] == expected, (
        f"Mixing generator={a} (singular) and generators={b} (plural) should be "
        f"equivalent to generators={a},{b} (which returned {expected}), but got "
        f"{r_combined.json()['total']}."
    )


def test_dedup_when_singular_equals_plural(test_client, test_db_with_images):
    """``?generator=X&generators=X`` should not double-count."""
    r_stats = test_client.get("/api/stats").json()
    gen = next((g["generator"] for g in r_stats.get("generators", []) if g.get("count", 0) > 0), None)
    if not gen:
        pytest.skip("Need at least one generator with images")

    r_dup = test_client.get(f"/api/images?generator={gen}&generators={gen}&limit=1")
    r_single = test_client.get(f"/api/images?generators={gen}&limit=1")
    assert r_dup.status_code == 200 and r_single.status_code == 200
    assert r_dup.json()["total"] == r_single.json()["total"], (
        "Dup of same generator value should not inflate the result count."
    )
