"""Tests for v3.2.2 T-power-PR2 (H): post-tag completion stats helper.

The helper builds the snapshot the frontend uses to pop the stats modal
once per run. It must be:
  - Defensive (never raise — the terminal send is on the critical path).
  - Predictable in its top_tags ordering.
  - Tolerant of empty / 0 inputs (a cancelled-before-tagging run still
    emits a stats payload).
"""
from __future__ import annotations

import sys
import time
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from services.tagging_service import _build_last_run_stats  # noqa: E402


def test_basic_run():
    counter = Counter({"1girl": 50, "blue_hair": 35, "score_9": 20})
    out = _build_last_run_stats(
        start_time=time.time() - 10.0,
        total_processed=50,
        total_tagged=48,
        total_errors=2,
        top_tags_counter=counter,
    )
    assert out["total_processed"] == 50
    assert out["total_tagged"] == 48
    assert out["total_errors"] == 2
    assert out["elapsed_seconds"] >= 9.5
    # avg = 48/50 = 0.96
    assert abs(out["avg_tags_per_image"] - 0.96) < 0.01
    # top tags by count desc, capped at 10
    names = [t["tag"] for t in out["top_tags"]]
    assert names[0] == "1girl"
    assert names[1] == "blue_hair"
    assert names[2] == "score_9"


def test_empty_inputs_dont_crash():
    out = _build_last_run_stats(
        start_time=0.0,  # cancelled before any work
        total_processed=0,
        total_tagged=0,
        total_errors=0,
        top_tags_counter=Counter(),
    )
    assert out["total_processed"] == 0
    assert out["avg_tags_per_image"] == 0.0
    assert out["elapsed_seconds"] == 0.0
    assert out["top_tags"] == []


def test_tolerates_non_counter_topn():
    """Defensive: if a future caller passes something without
    .most_common(), the helper still returns a valid payload."""
    class NotACounter:
        pass

    out = _build_last_run_stats(
        start_time=time.time(),
        total_processed=1,
        total_tagged=1,
        total_errors=0,
        top_tags_counter=NotACounter(),
    )
    assert out["top_tags"] == []
    assert out["total_processed"] == 1


def test_top_tags_capped_at_10():
    counter = Counter({f"tag_{i}": 100 - i for i in range(20)})
    out = _build_last_run_stats(
        start_time=time.time(),
        total_processed=100,
        total_tagged=100,
        total_errors=0,
        top_tags_counter=counter,
    )
    assert len(out["top_tags"]) == 10
    # Most common first
    assert out["top_tags"][0]["tag"] == "tag_0"
    assert out["top_tags"][0]["count"] == 100


def test_skips_empty_tag_names():
    counter = Counter({"": 5, "1girl": 3, None: 2})
    out = _build_last_run_stats(
        start_time=time.time(),
        total_processed=3,
        total_tagged=3,
        total_errors=0,
        top_tags_counter=counter,
    )
    names = [t["tag"] for t in out["top_tags"]]
    assert names == ["1girl"]
