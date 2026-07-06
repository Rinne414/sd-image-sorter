"""Entry page API router (v4.0 Aurora shell — Phase 2).

One aggregate endpoint so the entry page renders with a single request.
Resume-slab data intentionally lives elsewhere (the page reuses the existing
``GET /api/sort/current`` and job-progress endpoints), keeping this router a
thin read-only view over ``entry_stats_service``.
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, Query

from services import entry_stats_service


logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/entry", tags=["entry"])


@router.get(
    "/summary",
    summary="Aggregate stats for the entry page",
    description=(
        "Library totals, added-today / not-yet-seen counts, activity streak, "
        "and the deterministic daily ★5 hero pick. ``last_seen`` is the "
        "``server_now`` watermark from a previous call; ``hero_seed`` offsets "
        "the daily pick (换一张)."
    ),
)
def get_entry_summary(
    last_seen: str | None = Query(default=None, max_length=32),
    hero_seed: int = Query(default=0, ge=0, le=1_000_000),
):
    return entry_stats_service.get_entry_summary(
        last_seen=last_seen,
        hero_seed=hero_seed,
    )


@router.get(
    "/hero-pool",
    summary="Image ids for the entry page's slideshow / film display modes",
    description=(
        "★5-rated images first, then the newest library images up to "
        "``limit``. The client renders them via the thumbnail endpoint."
    ),
)
def get_hero_pool(limit: int = Query(default=60, ge=1, le=200)):
    return entry_stats_service.get_hero_pool(limit=limit)
