"""Smart Tag source streaming: id/path chunking, windows, skip-existing.

Owns the chunked source iterators that feed the pipelines
(_iter_request_source_chunks / _iter_request_sources / _iter_windows),
gallery-id -> path resolution, and the skip_existing filter.

Split verbatim out of services/smart_tag_service.py.
"""
from __future__ import annotations

import logging
from typing import Any, Dict, Iterable, Iterator, List, Optional, Tuple

from services.smart_tag.jobs import SmartTagJobState
from services.smart_tag.request import SmartTagRequest
from services.tag_export_service import iter_selection_token_id_chunks

# Shared logger: keep the historical channel name so log capture, filtering,
# and support-log diagnostics behave exactly as before the decomposition.
logger = logging.getLogger("services.smart_tag_service")


SMART_TAG_ID_CHUNK_SIZE = 500
SMART_TAG_PATH_CHUNK_SIZE = 500


def _iter_request_sources(
    req: "SmartTagRequest",
    job: Optional[SmartTagJobState] = None,
) -> Iterator[Tuple[str, int, str]]:
    """Flatten the chunked source stream into individual (key, id, path) items."""
    for source_chunk in _iter_request_source_chunks(req, job):
        for source in source_chunk:
            yield source


def _iter_windows(
    req: "SmartTagRequest",
    window_size: int,
    job: Optional[SmartTagJobState] = None,
) -> Iterator[List[Tuple[str, int, str]]]:
    """Yield source items in fixed-size windows for the booru->VLM pipeline."""
    size = max(1, int(window_size or 1))
    window: List[Tuple[str, int, str]] = []
    for source in _iter_request_sources(req, job):
        window.append(source)
        if len(window) >= size:
            yield window
            window = []
    if window:
        yield window


def _resolve_image_paths(image_ids: List[int]) -> Dict[int, str]:
    """Return ``{image_id: file_path}`` for every id that exists in the DB."""
    try:
        import database as db
    except Exception as exc:
        logger.error("smart-tag DB import failed: %s", exc)
        return {}
    rows = db.get_images_by_ids(list(image_ids))
    out: Dict[int, str] = {}
    for image_id, record in (rows or {}).items():
        path = record.get("path") if isinstance(record, dict) else getattr(record, "path", None)
        if path:
            out[int(image_id)] = str(path)
    return out


def _iter_chunks(items: Iterable[Any], chunk_size: int) -> Iterator[List[Any]]:
    normalized_size = max(1, int(chunk_size or 1))
    chunk: List[Any] = []
    for item in items or []:
        chunk.append(item)
        if len(chunk) >= normalized_size:
            yield chunk
            chunk = []
    if chunk:
        yield chunk


def _sources_from_image_id_chunk(image_ids: List[int]) -> List[Tuple[str, int, str]]:
    paths = _resolve_image_paths(image_ids)
    sources: List[Tuple[str, int, str]] = []
    for raw_id in image_ids:
        image_id = int(raw_id)
        sources.append((str(image_id), image_id, paths.get(image_id, "")))
    return sources


def _iter_dataset_scan_token_path_chunks(scan_token: str, chunk_size: int = SMART_TAG_PATH_CHUNK_SIZE) -> Iterator[List[str]]:
    from services.dataset_session_service import iter_scan_manifest_paths

    yield from _iter_chunks(iter_scan_manifest_paths(scan_token), chunk_size)


def _already_tagged_ids(image_ids: List[int]) -> set:
    """Seam over the DB lookup so tests can fake it without a real database."""
    import database as db

    return db.get_image_ids_already_tagged(image_ids)


def _apply_skip_existing(
    sources: List[Tuple[str, int, str]],
    req: SmartTagRequest,
    job: Optional[SmartTagJobState],
) -> List[Tuple[str, int, str]]:
    """Drop DB-backed sources that are already tagged when skip_existing is on.

    Path-only sources (image_id == 0, Dataset Maker local files) are never
    skipped — they have no DB tag state to check. On lookup failure the chunk
    is processed in full (fail-open: worst case is re-tagging, never silently
    dropping requested work). Skipped images are counted into ``processed``
    so N/M progress still reaches M.
    """
    if not req.skip_existing:
        return sources
    db_ids = [image_id for (_key, image_id, _path) in sources if image_id > 0]
    if not db_ids:
        return sources
    try:
        tagged_ids = _already_tagged_ids(db_ids)
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "skip_existing: tagged-state lookup failed, processing all %d image(s): %s",
            len(db_ids), exc,
        )
        return sources
    if not tagged_ids:
        return sources
    kept = [source for source in sources if not (source[1] > 0 and source[1] in tagged_ids)]
    skipped = len(sources) - len(kept)
    if skipped and job is not None:
        job.skipped += skipped
        job.processed += skipped
        if job.total > 0:
            job.phase_completion = min(1.0, job.processed / job.total)
    return kept


def _iter_request_source_chunks(
    req: SmartTagRequest,
    job: Optional[SmartTagJobState] = None,
) -> Iterator[List[Tuple[str, int, str]]]:
    for id_chunk in _iter_chunks(req.image_ids, SMART_TAG_ID_CHUNK_SIZE):
        yield _apply_skip_existing(
            _sources_from_image_id_chunk([int(image_id) for image_id in id_chunk]),
            req,
            job,
        )

    if req.selection_token:
        # snapshot=True: the windowed pipeline persists tags/captions per
        # window while this iterator is still live. If the token filters on
        # tags the run rewrites (tag X scope, excludeTags), offset pagination
        # would skip images as the matching set mutates underneath it.
        for id_chunk in iter_selection_token_id_chunks(
            req.selection_token, chunk_size=SMART_TAG_ID_CHUNK_SIZE, snapshot=True
        ):
            yield _apply_skip_existing(
                _sources_from_image_id_chunk([int(image_id) for image_id in id_chunk]),
                req,
                job,
            )

    for path_chunk in _iter_chunks(req.image_paths, SMART_TAG_PATH_CHUNK_SIZE):
        yield [(str(path), 0, str(path)) for path in path_chunk]

    if req.dataset_scan_token:
        for path_chunk in _iter_dataset_scan_token_path_chunks(req.dataset_scan_token, SMART_TAG_PATH_CHUNK_SIZE):
            yield [(str(path), 0, str(path)) for path in path_chunk]
