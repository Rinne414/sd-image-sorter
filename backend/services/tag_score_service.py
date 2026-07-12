"""Virtual re-threshold over stored tag_scores (BE-1).

``build_tags_from_scores`` mirrors ``WD14Tagger._process_probs`` gating
exactly — that equivalence IS the product guarantee ("re-threshold(t) gives
the same tags as re-running inference at t") and is pinned by a property
test. ``rethreshold_images`` orchestrates the read-back + rewrite through
the normal add_tags path so provenance rules (manual rows survive) hold
automatically.
"""
import logging
from typing import Any, Dict, List, Optional, Tuple

from pydantic import BaseModel, Field

import config
import database as db

logger = logging.getLogger(__name__)


class RethresholdRequest(BaseModel):
    """POST /api/tags/rethreshold — virtual re-threshold from stored scores."""

    image_ids: Optional[List[int]] = Field(default=None)
    selection_token: Optional[str] = Field(default=None, min_length=1)
    # A model name with stored scores, or "consensus" to fuse every stored
    # model's scores with compute_consensus_tags (weight 1.0 each).
    model: str = Field(..., min_length=1, max_length=256)
    threshold: Optional[float] = Field(default=None, ge=0.0, le=1.0)
    character_threshold: Optional[float] = Field(default=None, ge=0.0, le=1.0)
    consensus_min: int = Field(default=2, ge=1, le=8)
    dry_run: bool = True
    # Same write-time filters the tagging worker applies, so a re-threshold
    # can honour the user's blacklist instead of resurrecting pruned tags.
    pre_tag_blacklist: List[str] = Field(default_factory=list, max_length=500)
    max_tags_per_image: int = Field(default=0, ge=0, le=2000)


class CoverageGapsRequest(BaseModel):
    """POST /api/tags/coverage-gaps — images that ALMOST have a tag (N2)."""

    tag: str = Field(..., min_length=1, max_length=256)
    image_ids: Optional[List[int]] = Field(default=None)
    selection_token: Optional[str] = Field(default=None, min_length=1)
    model: Optional[str] = Field(default=None, max_length=256)
    band_low: Optional[float] = Field(default=None, ge=0.0, le=1.0)
    band_high: Optional[float] = Field(default=None, ge=0.0, le=1.0)
    limit: int = Field(default=200, ge=1, le=2000)


class ScorePurgeRequest(BaseModel):
    """POST /api/tags/scores/purge — drop stored scores (all or one model)."""

    model: Optional[str] = Field(default=None, max_length=256)


def resolve_scope_ids(
    image_ids: Optional[List[int]], selection_token: Optional[str]
) -> List[int]:
    """Explicit ids win; otherwise expand the selection token (snapshot).
    Same contract as the consistency/trait endpoints."""
    if image_ids:
        seen = set()
        ids: List[int] = []
        for value in image_ids:
            image_id = int(value)
            if image_id > 0 and image_id not in seen:
                seen.add(image_id)
                ids.append(image_id)
        return ids
    if selection_token:
        from services.tag_export_service import iter_selection_token_id_chunks

        ids = []
        for chunk in iter_selection_token_id_chunks(
            selection_token, chunk_size=500, snapshot=True
        ):
            ids.extend(int(i) for i in chunk)
        return ids
    return []


def build_tags_from_scores(
    scores: List[Dict[str, Any]],
    threshold: float,
    character_threshold: float,
    copyright_threshold: Optional[float] = None,
) -> List[Dict[str, Any]]:
    """Re-derive the tag list a tagger would emit at the given thresholds.

    Mirrors ``WD14Tagger._process_probs``: general/character/copyright gate
    on their thresholds (copyright falls back to the general threshold), the
    rating verdict is an argmax over rating rows and is never thresholded.
    Unknown/absent categories gate like general — the same treatment
    ``_process_probs`` gives its category overrides.
    """
    copyright_gate = (
        float(copyright_threshold) if copyright_threshold is not None else float(threshold)
    )
    out: List[Dict[str, Any]] = []
    rating_rows: List[Dict[str, Any]] = []
    for row in scores or []:
        if not isinstance(row, dict):
            continue
        tag = str(row.get("tag") or "")
        if not tag:
            continue
        try:
            score = float(row.get("score", 0.0))
        except (TypeError, ValueError):
            continue
        category = row.get("category") or "general"
        if category == "rating":
            rating_rows.append({"tag": tag, "score": score})
            continue
        if category == "character":
            gate = float(character_threshold)
        elif category == "copyright":
            gate = copyright_gate
        else:
            gate = float(threshold)
        if score >= gate:
            out.append({"tag": tag, "confidence": score, "category": category})

    if rating_rows:
        best = max(rating_rows, key=lambda item: item["score"])
        out.append(
            {"tag": best["tag"], "confidence": best["score"], "category": "rating"}
        )

    out.sort(key=lambda item: -item["confidence"])
    return out


def _split_rows_by_category(
    tags: List[Dict[str, Any]],
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]], List[Dict[str, Any]], Optional[Dict[str, Any]]]:
    """Split flat tag rows into the per-category shape compute_consensus_tags
    expects; the rating row becomes a {label, score} dict."""
    general: List[Dict[str, Any]] = []
    copyright_rows: List[Dict[str, Any]] = []
    character: List[Dict[str, Any]] = []
    rating: Optional[Dict[str, Any]] = None
    for row in tags:
        category = row.get("category") or "general"
        if category == "rating":
            rating = {"label": row["tag"], "score": float(row["confidence"])}
        elif category == "character":
            character.append(row)
        elif category == "copyright":
            copyright_rows.append(row)
        else:
            general.append(row)
    return general, copyright_rows, character, rating


def _apply_write_filters(
    tags: List[Dict[str, Any]],
    blacklist: List[str],
    max_tags: int,
) -> List[Dict[str, Any]]:
    """Run the rebuilt list through the SAME pre-write filters the tagging
    worker uses, so a re-threshold honours the user's blacklist instead of
    resurrecting pruned tags. Imported lazily — tagging_service is heavy."""
    if not blacklist and not max_tags:
        return tags
    from services.tagging_service import _apply_pre_tag_filters

    return _apply_pre_tag_filters(tags, blacklist=blacklist or [], max_tags=max_tags or 0)


def _diff_and_apply(
    ids: List[int],
    tags_by_image: Dict[int, List[Dict[str, Any]]],
    *,
    dry_run: bool,
    meta: Dict[str, Any],
) -> Dict[str, Any]:
    """Shared tail for both rethreshold modes: report the pipeline-row diff,
    then (unless dry_run) rewrite through the normal add_tags path so
    provenance rules (manual rows survive) hold automatically."""
    updates: List[Dict[str, Any]] = []
    diffs: List[Dict[str, Any]] = []
    added_total = 0
    removed_total = 0
    current_map = db.get_image_tags_map(list(tags_by_image.keys())) if tags_by_image else {}

    for image_id, new_tags in tags_by_image.items():
        new_names = {t["tag"].lower() for t in new_tags}
        # Diff against the rows a pipeline write would replace (pipeline
        # sources + legacy NULL); manual rows are untouched either way.
        current_pipeline = {
            str(row.get("tag") or "").lower()
            for row in current_map.get(image_id, [])
            if (row.get("source") or "tagger") in ("tagger", "vlm", "trigger")
        }
        added = sorted(new_names - current_pipeline)
        removed = sorted(current_pipeline - new_names)
        added_total += len(added)
        removed_total += len(removed)
        if added or removed:
            diffs.append(
                {
                    "image_id": image_id,
                    "added": added[:50],
                    "removed": removed[:50],
                    "added_count": len(added),
                    "removed_count": len(removed),
                }
            )
        updates.append({"image_id": image_id, "tags": new_tags})

    if not dry_run and updates:
        db.add_tags_batch(updates, default_source="tagger", replace_scope="pipeline")

    report = {
        "dry_run": bool(dry_run),
        "requested": len(ids),
        "with_scores": len(tags_by_image),
        "skipped_no_scores": len(ids) - len(tags_by_image),
        "images_changed": len(diffs),
        "tags_added": added_total,
        "tags_removed": removed_total,
        "diffs": diffs[:200],
        "applied": bool(not dry_run and updates),
    }
    report.update(meta)
    return report


def rethreshold_images(
    image_ids: List[int],
    model: str,
    threshold: float,
    character_threshold: float,
    *,
    dry_run: bool = True,
    pre_tag_blacklist: Optional[List[str]] = None,
    max_tags_per_image: int = 0,
) -> Dict[str, Any]:
    """Rewrite tag rows for ``image_ids`` from stored ``model`` scores at new
    thresholds — zero inference. Images with no stored scores for the model
    are reported, not touched."""
    ids = [int(i) for i in (image_ids or []) if int(i) > 0]
    scores_map = db.get_scores_for_images(ids, model)
    tags_by_image = {
        image_id: _apply_write_filters(
            build_tags_from_scores(scores, threshold, character_threshold),
            pre_tag_blacklist or [],
            max_tags_per_image,
        )
        for image_id, scores in scores_map.items()
    }
    return _diff_and_apply(
        ids,
        tags_by_image,
        dry_run=dry_run,
        meta={
            "model": model,
            "threshold": threshold,
            "character_threshold": character_threshold,
        },
    )


def rethreshold_consensus_images(
    image_ids: List[int],
    threshold: float,
    character_threshold: float,
    *,
    consensus_min: int = 2,
    dry_run: bool = True,
    pre_tag_blacklist: Optional[List[str]] = None,
    max_tags_per_image: int = 0,
) -> Dict[str, Any]:
    """Consensus re-threshold: rebuild each stored model's verdicts at the new
    thresholds, then fuse them with the SAME voting function the Smart Tag
    pipeline uses (weight 1.0 per model), so a stored-score consensus can
    never diverge from a live multi-tagger run at those thresholds."""
    from services.smart_tag_service import compute_consensus_tags

    ids = [int(i) for i in (image_ids or []) if int(i) > 0]
    models = [entry["model"] for entry in db.list_score_models(image_ids=ids)]
    per_model_maps = {model: db.get_scores_for_images(ids, model) for model in models}

    tags_by_image: Dict[int, List[Dict[str, Any]]] = {}
    covered_ids = set()
    for scores_map in per_model_maps.values():
        covered_ids.update(scores_map.keys())

    for image_id in covered_ids:
        outputs = []
        for model in models:
            scores = per_model_maps[model].get(image_id)
            if not scores:
                continue
            rebuilt = build_tags_from_scores(scores, threshold, character_threshold)
            general, copyright_rows, character, rating = _split_rows_by_category(rebuilt)
            outputs.append(
                {
                    "model": model,
                    "weight": 1.0,
                    "general_tags": general,
                    "copyright_tags": copyright_rows,
                    "character_tags": character,
                    "rating": rating,
                }
            )
        if not outputs:
            continue
        fused = compute_consensus_tags(outputs, consensus_min=consensus_min)
        new_tags = list(fused.get("general_tags") or [])
        new_tags.extend(fused.get("copyright_tags") or [])
        new_tags.extend(fused.get("character_tags") or [])
        rating_label = str(fused.get("rating") or "").strip()
        if rating_label:
            rating_score = max(
                (
                    float(o["rating"]["score"])
                    for o in outputs
                    if isinstance(o.get("rating"), dict)
                    and o["rating"].get("label") == rating_label
                ),
                default=1.0,
            )
            new_tags.append(
                {"tag": rating_label, "confidence": rating_score, "category": "rating"}
            )
        tags_by_image[image_id] = _apply_write_filters(
            new_tags, pre_tag_blacklist or [], max_tags_per_image
        )

    return _diff_and_apply(
        ids,
        tags_by_image,
        dry_run=dry_run,
        meta={
            "model": "consensus",
            "models_used": models,
            "consensus_min": consensus_min,
            "threshold": threshold,
            "character_threshold": character_threshold,
        },
    )


def get_stats() -> Dict[str, Any]:
    """Router-facing passthrough (routers do not touch the database module)."""
    return db.get_tag_score_stats()


def purge(model: Optional[str] = None) -> int:
    """Router-facing passthrough (routers do not touch the database module)."""
    return db.purge_tag_scores(model)


def find_gaps_for_request(request: CoverageGapsRequest) -> Dict[str, Any]:
    """Resolve scope + band defaults, then run the gap query.

    Band defaults: ``band_high`` falls back to the model's default general
    threshold (0.35 when no/unknown model); ``band_low`` to 0.10 under that,
    clamped to the storage floor — "just missed the cut" out of the box."""
    ids = resolve_scope_ids(request.image_ids, request.selection_token)
    band_high = request.band_high
    if band_high is None:
        band_high = 0.35
        if request.model:
            from services.tagging_service import resolve_request_thresholds

            band_high, _ = resolve_request_thresholds(request.model, None, None)
    floor = float(config.TAG_SCORES_FLOOR)
    band_low = request.band_low
    if band_low is None:
        band_low = max(floor, float(band_high) - 0.10)
    gaps = db.find_coverage_gaps(
        request.tag,
        band_low=float(band_low),
        band_high=float(band_high),
        image_ids=ids or None,
        model=request.model,
        limit=request.limit,
    )
    return {
        "tag": request.tag,
        "band_low": float(band_low),
        "band_high": float(band_high),
        "model": request.model,
        "scope_images": len(ids),
        "gaps": gaps,
        "total": len(gaps),
    }
