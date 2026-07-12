"""Pre-write tag filtering and batch-iteration helpers for the tagging worker.

Moved verbatim from services/tagging/worker.py (2026-07 follow-up slim; the
worker module was the last file over the 800-line ceiling after the
services/tagging decomposition). Pure functions only — no process state, no
heavy imports — so they are safe to import from both the parent process and
the multiprocessing spawn child. The facade (services/tagging_service.py)
still resolves these names through the worker module's imported bindings, so
existing `from services.tagging_service import _apply_pre_tag_filters`
consumers and patch semantics are unchanged.
"""

from typing import Any, Dict, List


def _iter_rescaling_batches(all_ids, get_batch_size):
    """Yield (batch_start, batch_ids) slices while re-reading batch_size.

    The worker mutates batch_size mid-run whenever memory pressure hits, but
    ``range(0, total, batch_size)`` captures its step at creation time — so the
    old for-range loop kept stepping by the ORIGINAL batch_size and silently
    skipped images after a reduction. This helper re-queries the current size
    each iteration and advances by the actual slice length so every id is
    visited exactly once, regardless of how many times batch_size shrinks.
    """
    batch_start = 0
    total = len(all_ids)
    while batch_start < total:
        batch_size = max(1, int(get_batch_size()))
        batch_ids = all_ids[batch_start : batch_start + batch_size]
        if not batch_ids:
            break
        yield batch_start, batch_ids
        batch_start += len(batch_ids)


def _iter_rescaling_chunk_source(id_chunks, get_batch_size):
    """Yield dynamically sized batches from a chunk iterator without materializing all IDs."""
    carry: List[int] = []
    batch_start = 0
    for id_chunk in id_chunks:
        carry.extend(id_chunk)
        while carry:
            batch_size = max(1, int(get_batch_size()))
            if len(carry) < batch_size:
                break
            batch_ids = carry[:batch_size]
            del carry[:batch_size]
            yield batch_start, batch_ids
            batch_start += len(batch_ids)
    while carry:
        batch_size = max(1, int(get_batch_size()))
        batch_ids = carry[:batch_size]
        del carry[:batch_size]
        yield batch_start, batch_ids
        batch_start += len(batch_ids)


def _apply_pre_tag_filters(
    tags: List[Dict[str, Any]],
    *,
    blacklist: List[str],
    max_tags: int,
) -> List[Dict[str, Any]]:
    """Apply v3.2.2 T-power-PR1 pre-tag filters before DB write.

    Filters in order:

    1. **Blacklist** — drop any tag whose name matches one of
       ``blacklist`` after normalisation (lowercase, underscores
       collapsed to spaces, leading/trailing whitespace stripped).
       Score-style prefixes such as ``score_9_up`` are kept verbatim
       on the tag side because Pony / NoobAI recipes need them, but
       blacklist entries are also normalised so the user can write
       either ``score_9_up`` or ``score 9 up`` in their list.
    2. **max_tags** — keep the top N content tags by confidence,
       descending. 0 = unlimited (legacy behaviour). The rating verdict
       row (category == "rating") is exempt from the trim (BE-3): it is
       metadata, not a content tag, and dropping it would make the image
       read as unrated downstream.

    Returns a new list; the caller's tag list is not mutated.
    """
    if not tags:
        return []

    def _norm(s: str) -> str:
        return " ".join(str(s or "").strip().lower().replace("_", " ").split())

    blocked = {_norm(b) for b in (blacklist or []) if str(b or "").strip()}
    out: List[Dict[str, Any]] = []
    for tag in tags:
        name = tag.get("tag") if isinstance(tag, dict) else str(tag)
        if not name:
            continue
        if blocked and _norm(name) in blocked:
            continue
        out.append(
            tag if isinstance(tag, dict) else {"tag": str(tag), "confidence": 1.0}
        )

    if max_tags and max_tags > 0:
        rating_rows: List[Dict[str, Any]] = []
        content_rows: List[Dict[str, Any]] = []
        for entry in out:
            if isinstance(entry, dict) and entry.get("category") == "rating":
                rating_rows.append(entry)
            else:
                content_rows.append(entry)
        if len(content_rows) > max_tags:
            content_rows = sorted(
                content_rows,
                key=lambda t: (
                    -float(t.get("confidence") or 0.0) if isinstance(t, dict) else 0.0
                ),
            )[: int(max_tags)]
        out = content_rows + rating_rows
    return out


def _build_last_run_stats(
    start_time: float,
    total_processed: int,
    total_tagged: int,
    total_errors: int,
    top_tags_counter: Any,
) -> Dict[str, Any]:
    """Snapshot of the just-finished tagging run for the post-completion
    stats modal (v3.2.2 T-power-PR2 / H).

    Only ever populated on terminal progress states (done / cancelled /
    error). The frontend uses the presence of this key to know it's
    safe to pop the modal exactly once.
    """
    import time as _time

    elapsed = max(0.0, _time.time() - float(start_time)) if start_time else 0.0
    avg = (total_tagged / total_processed) if total_processed else 0.0
    top = []
    try:
        # ``top_tags_counter`` is a collections.Counter from the worker.
        for tag, count in top_tags_counter.most_common(10):
            if tag and count:
                top.append({"tag": str(tag), "count": int(count)})
    except Exception:
        # Defensive: never break the terminal send because of stats math.
        top = []
    return {
        "elapsed_seconds": round(elapsed, 1),
        "total_processed": int(total_processed),
        "total_tagged": int(total_tagged),
        "total_errors": int(total_errors),
        "avg_tags_per_image": round(avg, 2),
        "top_tags": top,
    }
