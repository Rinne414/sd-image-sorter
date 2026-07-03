"""Migration 020: activity_log table (v4.0 Aurora entry page — backend delta #4).

Daily activity counters that feed the entry page identity block ("N 天连着整理 ·
今天过手 M 张") and streak computation. One row per (local calendar day, kind);
kinds are open-ended strings recorded by the write paths that touch images
(added / tagged / moved / censored / rated). Rows are tiny and bounded by
days × kinds, so no pruning is needed.

``day`` is the user's LOCAL date as ``YYYY-MM-DD`` (this is a local-first
desktop tool; streaks follow the user's own calendar, not UTC).
"""
from __future__ import annotations

import sqlite3


VERSION = 20
NAME = "activity_log"


def apply(conn: sqlite3.Connection) -> None:
    """Create the activity_log table (idempotent)."""
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS activity_log (
            day TEXT NOT NULL,
            kind TEXT NOT NULL,
            count INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (day, kind)
        )
        """
    )
