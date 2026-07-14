"""Smart Tag result shaping + persistence (DB write-back, results jsonl).

Owns caption assembly (assemble_caption + tag normalization), the tag-row
shaping stages (_normalize_tag_rows / _prepare_smart_tag_rows /
_booru_partial_from_tag_result / _assemble_result_dict / _score_sets_from_raw
/ _rating_row_from), the DB write-back (_persist_result), and the
path-source caption-results jsonl store (_append_caption_result /
_close_caption_results / get_caption_results_page).

Split verbatim out of services/smart_tag_service.py.
"""
from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple

from services.export_template_engine import is_kaomoji_tag
from services.smart_tag.consensus import _SCORE_RE, filter_noise_tags, is_noise_tag
from services.smart_tag.jobs import SMART_TAG_RECENT_RESULT_LIMIT, SmartTagJobState
from services.smart_tag.prompts import filter_tags_by_training_purpose
from services.smart_tag.request import SmartTagRequest

# Shared logger: keep the historical channel name so log capture, filtering,
# and support-log diagnostics behave exactly as before the decomposition.
logger = logging.getLogger("services.smart_tag_service")


# ---------------------------------------------------------------------------
# Caption assembly + trigger injection
# ---------------------------------------------------------------------------


def _normalize_tag(tag: str) -> str:
    """Normalize a single tag: strip, lowercase, swap underscores to spaces.

    The score_N family is preserved verbatim because the upstream Pony /
    Animagine prompt prefix relies on the literal ``score_7_up`` form, and
    emoticon tags keep their underscores (``^_^`` must not become ``^ ^``).
    """
    stripped = (tag or "").strip()
    if not stripped:
        return ""
    lowered = stripped.lower()
    if _SCORE_RE.match(lowered) or is_kaomoji_tag(lowered):
        return lowered
    return lowered.replace("_", " ")


def _dedupe_preserving_order(items: Iterable[str]) -> List[str]:
    seen: Set[str] = set()
    out: List[str] = []
    for item in items:
        if not item:
            continue
        if item in seen:
            continue
        seen.add(item)
        out.append(item)
    return out


def assemble_caption(
    *,
    rating: Optional[str],
    general_tags: List[str],
    character_tags: List[str],
    nl_text: str,
    trigger_word: Optional[str],
    auto_strip_noise: bool,
    include_rating_prefix: bool = False,
) -> str:
    """Assemble the final training caption.

    Layout (local smart-caption pipeline, simplified):
        [trigger] [character_tags] [general_tags] [NL_text]

    Notes:
    * ``rating`` is ignored unless ``include_rating_prefix`` is True; we keep
      it off by default because most LoRA recipes do not want a literal
      ``rating:explicit`` token in the caption.
    * ``auto_strip_noise`` removes quality / score / safety / meta / time
      noise tags from the *final* caption regardless of what the VLM emits
      - the VLM was already told not to produce them, but the local tagger
      may have added them to the WD14 list.
    * ``trigger_word`` is injected as the very first token. If the trigger
      already appears anywhere in the WD14 tags we leave it where it is to
      preserve user intent, otherwise we prepend it.
    """
    pieces: List[str] = []

    nl = (nl_text or "").strip()

    general_norm = [_normalize_tag(t) for t in (general_tags or []) if t]
    character_norm = [_normalize_tag(t) for t in (character_tags or []) if t]

    if auto_strip_noise:
        general_norm, _g_stripped = filter_noise_tags(general_norm)
        character_norm, _c_stripped = filter_noise_tags(character_norm)

    general_norm = _dedupe_preserving_order(general_norm)
    character_norm = _dedupe_preserving_order(character_norm)

    trigger_clean = (trigger_word or "").strip().lower()
    if trigger_clean:
        # If trigger is already buried in the WD14 tags (case insensitive),
        # leave it - the user explicitly tagged with it.
        already_present = any(
            t.strip().lower() == trigger_clean for t in general_norm + character_norm
        )
        if not already_present:
            pieces.append(trigger_clean)

    if include_rating_prefix and rating:
        rating_norm = str(rating).strip().lower()
        if rating_norm and rating_norm != "unknown":
            pieces.append(rating_norm)

    pieces.extend(character_norm)
    pieces.extend(general_norm)

    tag_section = ", ".join(_dedupe_preserving_order(pieces))
    if nl and tag_section:
        return f"{tag_section}, {nl}"
    if nl:
        return nl
    return tag_section


def _flatten_tag_names(items: List[Any]) -> List[str]:
    out: List[str] = []
    for item in items or []:
        if isinstance(item, dict):
            tag = item.get("tag")
            if tag:
                out.append(str(tag))
        elif isinstance(item, str):
            out.append(item)
    return out


_RATING_LABEL_CANON = {
    "general": "general", "g": "general", "safe": "general",
    "rating:general": "general", "rating:safe": "general",
    "sensitive": "sensitive", "s": "sensitive", "rating:sensitive": "sensitive",
    "questionable": "questionable", "q": "questionable",
    "rating:questionable": "questionable",
    "explicit": "explicit", "e": "explicit", "rating:explicit": "explicit",
}


def _rating_row_from(rating: Any) -> Tuple[str, float]:
    """Normalize a pipeline rating (``{label, score}`` dict or plain string)
    to the bare danbooru word + confidence the plain tagging pipeline stores.
    Returns ``("", 0.0)`` when there is no usable rating."""
    label, score = "", 1.0
    if isinstance(rating, dict):
        label = str(rating.get("label") or "").strip().lower()
        try:
            score = float(rating.get("score") or 1.0)
        except (TypeError, ValueError):
            score = 1.0
    elif rating:
        label = str(rating).strip().lower()
    canon = _RATING_LABEL_CANON.get(label, "")
    if not canon:
        return "", 0.0
    return canon, max(0.0, min(1.0, score))


def _normalize_tag_rows(items: List[Any], category: str) -> List[Dict[str, Any]]:
    """Keep model confidence rows intact while accepting legacy string tags."""
    rows: List[Dict[str, Any]] = []
    for item in items or []:
        if isinstance(item, dict):
            tag = str(item.get("tag") or "").strip()
            if not tag:
                continue
            try:
                confidence = float(item.get("confidence", 1.0))
            except (TypeError, ValueError):
                confidence = 1.0
            row = dict(item)
            row["tag"] = tag
            row["confidence"] = confidence
            row["category"] = str(row.get("category") or category)
            rows.append(row)
        elif item:
            tag = str(item).strip()
            if tag:
                rows.append({"tag": tag, "confidence": 1.0, "category": category})
    return rows


def _strip_noise_tag_rows(rows: List[Dict[str, Any]]) -> Tuple[List[Dict[str, Any]], int]:
    kept: List[Dict[str, Any]] = []
    stripped = 0
    for row in rows:
        if is_noise_tag(str(row.get("tag") or "")):
            stripped += 1
        else:
            kept.append(row)
    return kept, stripped


def _top_tag_rows(rows: List[Dict[str, Any]], limit: int) -> List[Dict[str, Any]]:
    if not limit or limit <= 0 or len(rows) <= limit:
        return rows
    return sorted(
        rows,
        key=lambda row: -float(row.get("confidence") or 0.0),
    )[:limit]


def _prepare_smart_tag_rows(
    general_rows: List[Dict[str, Any]],
    copyright_rows: List[Dict[str, Any]],
    character_rows: List[Dict[str, Any]],
    *,
    auto_strip_noise: bool,
    max_tags_per_image: int,
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]], List[Dict[str, Any]], int]:
    noise_stripped = 0
    if auto_strip_noise:
        general_rows, g_stripped = _strip_noise_tag_rows(general_rows)
        copyright_rows, c_stripped = _strip_noise_tag_rows(copyright_rows)
        character_rows, ch_stripped = _strip_noise_tag_rows(character_rows)
        noise_stripped = g_stripped + c_stripped + ch_stripped

    max_tags = int(max_tags_per_image or 0)
    if max_tags <= 0:
        return general_rows, copyright_rows, character_rows, noise_stripped

    # Character and copyright tags carry identity context and are usually few;
    # preserve them first, then use the remaining budget for general tags.
    reserved_count = len(character_rows) + len(copyright_rows)
    if reserved_count >= max_tags:
        kept_reserved = _top_tag_rows(character_rows + copyright_rows, max_tags)
        return [], [
            row for row in kept_reserved
            if str(row.get("category") or "").lower() == "copyright"
        ], [
            row for row in kept_reserved
            if str(row.get("category") or "").lower() == "character"
        ], noise_stripped

    general_budget = max_tags - reserved_count
    return _top_tag_rows(general_rows, general_budget), copyright_rows, character_rows, noise_stripped


def _score_sets_from_raw(
    raw: Dict[str, Any], score_model: Optional[str]
) -> List[Dict[str, Any]]:
    """BE-1: normalize a raw tagger/consensus result into tag_scores write
    sets. Multi-tagger fusion attaches ready-made ``tag_score_sets`` (one per
    model); a single-tagger result carries flat ``tag_scores`` and needs the
    model name from the caller."""
    sets = raw.get("tag_score_sets")
    if sets:
        return [s for s in sets if isinstance(s, dict)]
    scores = raw.get("tag_scores")
    if scores and score_model:
        return [{"model": str(score_model), "scores": scores}]
    return []


def _booru_partial_from_tag_result(
    raw: Dict[str, Any],
    req: "SmartTagRequest",
    score_model: Optional[str] = None,
) -> Dict[str, Any]:
    """Stage-1 of the pipeline: turn a raw tagger/consensus result into the
    normalized + noise-stripped + capped tag partial the caption builder needs.

    Shared by ``_process_one_image`` (single + consensus) and the windowed
    single-tagger pipeline so the two paths can never diverge.
    """
    general_rows = _normalize_tag_rows(raw.get("general_tags") or [], "general")
    copyright_rows = _normalize_tag_rows(raw.get("copyright_tags") or [], "copyright")
    character_rows = _normalize_tag_rows(raw.get("character_tags") or [], "character")
    general_rows, copyright_rows, character_rows, noise_stripped = _prepare_smart_tag_rows(
        general_rows,
        copyright_rows,
        character_rows,
        auto_strip_noise=req.auto_strip_noise,
        max_tags_per_image=req.max_tags_per_image,
    )
    return {
        "general_rows": general_rows,
        "copyright_rows": copyright_rows,
        "character_rows": character_rows,
        "general_names": _flatten_tag_names(general_rows),
        "copyright_names": _flatten_tag_names(copyright_rows),
        "character_names": _flatten_tag_names(character_rows),
        "rating": raw.get("rating") or None,
        "noise_stripped": noise_stripped,
        "tag_score_sets": _score_sets_from_raw(raw, score_model),
    }


def _assemble_result_dict(
    partial: Dict[str, Any],
    nl_text: str,
    image_id: int,
    req: "SmartTagRequest",
) -> Dict[str, Any]:
    """Stage-3 of the pipeline: assemble the final caption + result payload from
    a tag partial and the natural-language text. Output shape matches what
    ``_persist_result`` / ``_append_caption_result`` consume."""
    selected_tags = filter_tags_by_training_purpose(
        req.training_purpose,
        partial["general_names"],
        partial["copyright_names"],
        partial["character_names"],
        req.trigger_word,
    )
    selected_keys = {
        str(tag or "").strip().lower().replace(" ", "_")
        for tag in selected_tags
    }

    def _selected_names(items: List[str]) -> List[str]:
        return [
            tag for tag in items
            if str(tag or "").strip().lower().replace(" ", "_") in selected_keys
        ]

    def _selected_rows(items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        return [
            row for row in items
            if str(row.get("tag") or "").strip().lower().replace(" ", "_") in selected_keys
        ]

    general_names = _selected_names(partial["general_names"])
    copyright_names = _selected_names(partial["copyright_names"])
    character_names = _selected_names(partial["character_names"])

    def _compose_caption(natural_language_text: str) -> str:
        return assemble_caption(
            rating=partial["rating"],
            general_tags=general_names + copyright_names,
            character_tags=character_names,
            nl_text=natural_language_text,
            trigger_word=req.trigger_word,
            auto_strip_noise=req.auto_strip_noise,
        )

    booru_text = _compose_caption("")
    caption = _compose_caption(nl_text)
    return {
        "image_id": image_id,
        "caption": caption,
        "booru_text": booru_text,
        "general_tags": general_names,
        "copyright_tags": copyright_names,
        "character_tags": character_names,
        "general_tag_rows": _selected_rows(partial["general_rows"]),
        "copyright_tag_rows": _selected_rows(partial["copyright_rows"]),
        "character_tag_rows": _selected_rows(partial["character_rows"]),
        "rating": partial["rating"],
        "nl_text": nl_text,
        "noise_stripped_count": partial["noise_stripped"],
        "tag_score_sets": partial.get("tag_score_sets") or [],
        # Persisted by _persist_result as a top-confidence tag row so
        # tags-mode exports keep a subject token even after character-mode
        # filtering removed the character name (P1-16).
        "trigger_word": (req.trigger_word or "").strip(),
    }


def _persist_result(image_id: int, result: Dict[str, Any], merge_strategy: str) -> None:
    """Write the caption back to the DB so it shows up in the Caption Editor.

    We reuse ``database.add_tags_batch`` (the same write path the regular
    tagging worker uses) so this plays nicely with the rest of the app's
    tag-display, search, and export plumbing. ``ai_caption`` carries the
    final composed caption (trigger + tags + NL sentences); the per-tag
    rows carry the individual tag/confidence pairs.
    """
    try:
        import database as db
    except Exception as exc:
        logger.error("smart-tag DB import failed: %s", exc)
        return

    caption = (result.get("caption") or "").strip()
    general = result.get("general_tags") or []
    copyright = result.get("copyright_tags") or []
    character = result.get("character_tags") or []
    general_rows = _normalize_tag_rows(
        result.get("general_tag_rows") if result.get("general_tag_rows") is not None else general,
        "general",
    )
    copyright_rows = _normalize_tag_rows(
        result.get("copyright_tag_rows") if result.get("copyright_tag_rows") is not None else copyright,
        "copyright",
    )
    character_rows = _normalize_tag_rows(
        result.get("character_tag_rows") if result.get("character_tag_rows") is not None else character,
        "character",
    )

    # On append, glue the new caption onto whatever was there before.
    final_caption = caption
    # Pure natural-language sentence (no booru tags). Kept separate from the
    # composed ``final_caption`` so the dataset maker can show / export the
    # booru tags and the NL sentence independently.
    nl_text = (result.get("nl_text") or "").strip()
    final_nl = nl_text
    if merge_strategy == "append":
        try:
            existing_rows = db.get_image_tags(image_id) or []
            # ai_caption / nl_caption aren't returned by get_image_tags; pull
            # from the row directly to honour append semantics.
            row = db.get_images_by_ids([image_id]).get(image_id) or {}
            prior = (row.get("ai_caption") or "").strip()
            if prior and prior != caption:
                final_caption = f"{prior}, {caption}".strip(", ")
            prior_nl = (row.get("nl_caption") or "").strip()
            if prior_nl and prior_nl != nl_text:
                final_nl = f"{prior_nl} {nl_text}".strip()
            del existing_rows  # not used; kept for documentation of intent
        except Exception as exc:  # noqa: BLE001
            logger.warning("smart-tag append-merge fallback to replace for %s: %s", image_id, exc)

    # Build the per-tag rows the way add_tags_batch expects.
    tag_rows: List[Dict[str, Any]] = []
    tag_rows.extend(character_rows)
    tag_rows.extend(general_rows)
    tag_rows.extend(copyright_rows)

    # P1-16: persist the trigger as a top-confidence tag row. The caption
    # string alone does not survive a ``content_mode=tags`` export, so after
    # character-mode filtering removed the character name the exported
    # captions would carry no subject token at all.
    trigger_word = str(result.get("trigger_word") or "").strip()
    if trigger_word:
        existing_keys = {
            str(row.get("tag") or "").strip().lower().replace(" ", "_")
            for row in tag_rows
        }
        if trigger_word.lower().replace(" ", "_") not in existing_keys:
            tag_rows.insert(
                0,
                {"tag": trigger_word, "confidence": 1.0, "source": "trigger", "category": "trigger"},
            )

    # P0-1: persist the tagger's rating verdict as a tag row — the same
    # convention the plain tagging pipeline uses — so {rating}/{safety}
    # template slots resolve per image no matter which pipeline tagged it.
    rating_label, rating_score = _rating_row_from(result.get("rating"))
    if rating_label:
        tag_rows.append(
            {"tag": rating_label, "confidence": rating_score, "category": "rating"}
        )

    try:
        db.add_tags_batch(
            [
                {
                    "image_id": image_id,
                    "tags": tag_rows,
                    "ai_caption": final_caption or None,
                    "nl_caption": final_nl or None,
                    "tag_scores": result.get("tag_score_sets") or None,
                }
            ],
            default_source="tagger",
            replace_scope="pipeline",
        )
    except Exception as exc:  # noqa: BLE001
        logger.error("smart-tag DB write failed for %s: %s", image_id, exc)


def _get_caption_results_dir() -> Path:
    # Decomposition note (2026-07): this code moved one directory deeper
    # (services/smart_tag/), so one more .parent keeps the historical
    # backend/data/smart-tag-results location unchanged.
    data_dir = Path(__file__).resolve().parent.parent.parent / "data" / "smart-tag-results"
    data_dir.mkdir(parents=True, exist_ok=True)
    return data_dir


def _append_caption_result(
    job: SmartTagJobState,
    path: str,
    caption: str,
    booru_text: str,
    nl_text: str,
) -> None:
    row = {
        "path": str(path),
        "caption": str(caption or ""),
        "booru_text": str(booru_text or ""),
        "nl_text": str(nl_text or ""),
    }
    if job.caption_results_path is None:
        target = _get_caption_results_dir() / f"{job.job_id}.jsonl"
        job.caption_results_path = str(target)
        job._caption_results_handle = target.open("a", encoding="utf-8")
    handle = job._caption_results_handle
    handle.write(json.dumps(row, ensure_ascii=False) + "\n")
    handle.flush()
    job.caption_result_count += 1
    preview = {
        "path": row["path"],
        "caption": row["caption"][:200],
        "booru_text": row["booru_text"][:200],
        "nl_text": row["nl_text"][:200],
    }
    job.recent_caption_results.append(preview)
    if len(job.recent_caption_results) > SMART_TAG_RECENT_RESULT_LIMIT:
        del job.recent_caption_results[:-SMART_TAG_RECENT_RESULT_LIMIT]


def _close_caption_results(job: SmartTagJobState) -> None:
    handle = getattr(job, "_caption_results_handle", None)
    if handle is not None:
        try:
            handle.close()
        finally:
            job._caption_results_handle = None


def get_caption_results_page(
    job: SmartTagJobState,
    *,
    offset: int = 0,
    limit: int = 1000,
) -> Dict[str, Any]:
    start = max(0, int(offset or 0))
    page_limit = max(1, min(5000, int(limit or 1000)))
    end = start + page_limit
    results: List[Dict[str, str]] = []
    path = job.caption_results_path
    if path:
        try:
            with open(path, "r", encoding="utf-8") as handle:
                for index, line in enumerate(handle):
                    if index < start:
                        continue
                    if index >= end:
                        break
                    try:
                        row = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if isinstance(row, dict):
                        results.append({
                            "path": str(row.get("path") or ""),
                            "caption": str(row.get("caption") or ""),
                            "booru_text": str(row.get("booru_text") or ""),
                            "nl_text": str(row.get("nl_text") or ""),
                        })
        except OSError:
            results = []
    return {
        "job_id": job.job_id,
        "offset": start,
        "limit": page_limit,
        "total": job.caption_result_count,
        "results": results,
        "has_more": end < job.caption_result_count,
    }
