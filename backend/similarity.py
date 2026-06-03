"""
Image similarity search using FastEmbed CLIP embeddings.

Generates 512-dim CLIP embeddings per image and stores them in SQLite.
Supports finding similar images by ID, by upload, and finding duplicates.
"""
import gc
import io
import heapq
import json
import logging
import os
import tempfile
import threading
import time
from pathlib import Path
from typing import Dict, List, Optional, Set, Tuple, Any

import numpy as np
from PIL import Image, UnidentifiedImageError

from config import (
    CLIP_MODEL_NAME,
    get_clip_model_dir,
    get_state_dir,
    SIMILARITY_DEFAULT_LIMIT,
    SIMILARITY_DEFAULT_THRESHOLD,
    DUPLICATE_THRESHOLD,
    EMBEDDING_BATCH_SIZE,
    DUPLICATE_CHUNK_SIZE,
    DUPLICATE_SYNC_MAX_EMBEDDINGS,
)
from image_fingerprint import compute_image_content_fingerprint
from metadata_parser import verify_image_readable
from model_health import get_clip_local_model_path
from model_download_sources import apply_hf_endpoint_monkeypatch, endpoint_label, get_hf_endpoint_order
from utils.source_paths import resolve_existing_indexed_image_path
from ai_runtime_guard import exclusive_ai_runtime


logger = logging.getLogger(__name__)


class SimilarityError(RuntimeError):
    """Base class for similarity workflow errors."""


class SimilarityImageNotFoundError(SimilarityError):
    """Raised when the requested image id does not exist."""

    def __init__(self, image_id: int):
        super().__init__(f"Image {image_id} was not found.")
        self.image_id = image_id


class SimilarityEmbeddingMissingError(SimilarityError):
    """Raised when the requested image does not have an embedding yet."""

    def __init__(self, image_id: int):
        super().__init__(f"Image {image_id} has no embedding yet. Generate embeddings first.")
        self.image_id = image_id


class SimilarityInvalidImageError(SimilarityError):
    """Raised when an uploaded image cannot be decoded."""

    def __init__(self):
        super().__init__("Invalid image file. Upload a readable PNG, JPG, or WebP image.")


class SimilarityInsufficientEmbeddingsError(SimilarityError):
    """Raised when duplicate detection does not have enough embedded images."""

    def __init__(self, embedded_count: int, minimum_required: int = 2):
        super().__init__(
            f"Need at least {minimum_required} embedded images before duplicate search is meaningful."
        )
        self.embedded_count = embedded_count
        self.minimum_required = minimum_required


class SimilarityDuplicateSearchTooLargeError(SimilarityError):
    """Raised when synchronous duplicate search would compare too many embeddings."""

    def __init__(self, embedded_count: int, max_embeddings: int):
        super().__init__(
            f"Duplicate search is limited to {max_embeddings} embedded images for synchronous checks."
        )
        self.embedded_count = embedded_count
        self.max_embeddings = max_embeddings


class SimilaritySearchWindowTooLargeError(SimilarityError):
    """Raised when offset + limit would require an unsafe ranking window."""

    def __init__(self, requested_window: int, max_window: int):
        super().__init__(
            f"Similarity pagination window is limited to {max_window} ranked results per request."
        )
        self.requested_window = requested_window
        self.max_window = max_window


# Lazy-loaded FastEmbed model
_embed_model = None
_embed_lock = threading.Lock()

SIMILARITY_SEARCH_CHUNK_SIZE = max(
    64,
    min(8192, int(os.environ.get("SD_SIMILARITY_SEARCH_CHUNK_SIZE", "2048") or 2048)),
)
SIMILARITY_SEARCH_MAX_WINDOW = max(
    1000,
    min(200000, int(os.environ.get("SD_SIMILARITY_SEARCH_MAX_WINDOW", "50000") or 50000)),
)

# In-memory vectorized embedding cache (PERF-1).
#
# The streaming search re-reads and re-decodes every embedding BLOB from SQLite
# on each query (e.g. ~400MB of I/O for 200k images), which dominates latency.
# Caching a single L2-normalized float32 matrix in RAM turns each search into one
# vectorized matmul. This is a pure accelerator: the streaming scan below stays as
# the always-available fallback, so results are never capped or degraded — if the
# cache cannot be built (memory pressure, odd DB shape) we silently fall back.
#
# Opt-out via SD_SIMILARITY_DISABLE_VECTOR_CACHE=1 (ops escape hatch, not a feature
# cap — the feature works at full fidelity either way).
SIMILARITY_VECTOR_CACHE_ENABLED = (
    os.environ.get("SD_SIMILARITY_DISABLE_VECTOR_CACHE", "").strip().lower()
    not in ("1", "true", "yes", "on")
)


def _get_embed_model():
    """Get or create the FastEmbed CLIP model (singleton)."""
    global _embed_model
    if _embed_model is None:
        with _embed_lock:
            if _embed_model is None:
                try:
                    from fastembed import ImageEmbedding  # type: ignore
                    local_model_path = get_clip_local_model_path()
                    model_kwargs = {
                        "model_name": CLIP_MODEL_NAME,
                        "cache_dir": get_clip_model_dir(),
                    }
                    if local_model_path:
                        model_kwargs.update(
                            {
                                "local_files_only": True,
                                "specific_model_path": local_model_path,
                            }
                        )
                    if not local_model_path:
                        endpoint = get_hf_endpoint_order(model_name="CLIP Similarity")[0]
                        apply_hf_endpoint_monkeypatch(endpoint, purpose="CLIP Similarity / FastEmbed")
                        logger.info("FastEmbed CLIP will use %s unless a local cache is already valid.", endpoint_label(endpoint))
                    with exclusive_ai_runtime("clip-similarity-load"):
                        _embed_model = ImageEmbedding(
                            **model_kwargs,
                        )
                except ImportError:
                    raise RuntimeError(
                        "fastembed not installed. Run: pip install fastembed"
                    )
                except Exception as exc:
                    if get_clip_local_model_path():
                        raise RuntimeError(
                            "Local CLIP model exists but FastEmbed could not open it. "
                            f"Checked: {get_clip_local_model_path()}. Error: {exc}"
                        ) from exc
                    raise RuntimeError(
                        "CLIP embedding model is not ready yet. "
                        "Download the local model first or allow the first-run model download."
                    ) from exc
    return _embed_model


def ensure_clip_model_ready() -> Optional[str]:
    """Trigger FastEmbed model initialization/download and return the local model path if available."""
    model = _get_embed_model()
    # Try the standard health-check path first
    local_path = get_clip_local_model_path()
    if local_path:
        return local_path
    # FastEmbed loaded successfully but the file isn't at the canonical path.
    # Try to extract the actual model directory from the loaded model object.
    try:
        model_dir = getattr(model, "model_dir", None) or getattr(model.model, "_model_dir", None)
        if model_dir:
            return str(model_dir)
    except Exception:
        logger.debug("Could not introspect FastEmbed model directory", exc_info=True)
    # Model is loaded in memory — return a sentinel so callers know it works
    return "fastembed:in-memory"


def embedding_to_bytes(embedding: np.ndarray) -> bytes:
    """Convert a numpy embedding to bytes for SQLite storage."""
    return embedding.astype(np.float32).tobytes()


def bytes_to_embedding(data: bytes) -> np.ndarray:
    """Convert bytes from SQLite back to numpy embedding."""
    return np.frombuffer(data, dtype=np.float32)


def cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
    """Compute cosine similarity between two vectors."""
    norm_a = np.linalg.norm(a)
    norm_b = np.linalg.norm(b)
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return float(np.dot(a, b) / (norm_a * norm_b))


def embed_image_file(image_path: str, model=None) -> Optional[np.ndarray]:
    """Generate CLIP embedding for a single image file."""
    try:
        model = model or _get_embed_model()
        # FastEmbed accepts file paths
        with exclusive_ai_runtime("clip-similarity-inference"):
            embeddings = list(model.embed([image_path]))
        if embeddings:
            return np.array(embeddings[0], dtype=np.float32)
    except Exception as e:
        logger.warning("[Similarity] Error embedding %s: %s", image_path, e)
    return None


def embed_image_pil(pil_image: Image.Image) -> Optional[np.ndarray]:
    """Generate CLIP embedding for a PIL Image."""
    tmp_path = None
    try:
        model = _get_embed_model()
        # Save to temp bytes, then embed
        buf = io.BytesIO()
        pil_image.save(buf, format="PNG")
        buf.seek(0)

        # FastEmbed needs a file path or bytes — use temp file
        with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tmp:
            tmp.write(buf.getvalue())
            tmp_path = tmp.name

        with exclusive_ai_runtime("clip-similarity-upload"):
            embeddings = list(model.embed([tmp_path]))
        if embeddings:
            return np.array(embeddings[0], dtype=np.float32)
    except Exception as e:
        logger.error("[Similarity] Error embedding PIL image: %s", e)
    finally:
        # Clean up temp file with existence check
        if tmp_path is not None:
            try:
                if os.path.exists(tmp_path):
                    os.unlink(tmp_path)
            except OSError as e:
                logger.debug("[Similarity] Failed to delete temp file %s: %s", tmp_path, e)
    return None


class SimilarityIndex:
    """Manages image embeddings and similarity search."""

    def __init__(self, db_module=None):
        self.db = db_module
        self._cancel_requested = False
        self._progress_lock = threading.Lock()
        self._progress = {
            "running": False,
            "total": 0,
            "processed": 0,
            "embedded": 0,
            "errors": 0,
            "skipped": 0,
            "unreadable": 0,
            "failed": 0,
            "message": "",
            "step": "idle",
            "current_item": None,
            "recent_issues": [],
            "started_at": None,
            "updated_at": None,
            "current_batch": 0,
            "total_batches": 0,
        }
        # Vectorized embedding cache (PERF-1). Guarded by _vector_cache_lock.
        # _vector_cache holds {"matrix", "ids", "paths", "filenames", "dim",
        # "signature"} once built; None means "not built / invalidated".
        self._vector_cache_lock = threading.Lock()
        self._vector_cache: Optional[Dict[str, Any]] = None

    def get_progress(self) -> Dict[str, Any]:
        """Get current embedding progress (snapshot guarded by lock)."""
        with self._progress_lock:
            snapshot = dict(self._progress)
            snapshot["recent_issues"] = list(self._progress["recent_issues"])
            return snapshot

    def _record_issue(self, kind: str, image_id: int, image_path: str, reason: str) -> None:
        entry = {
            "kind": kind,
            "image_id": image_id,
            "filename": os.path.basename(image_path),
            "path": image_path,
            "reason": reason,
        }
        with self._progress_lock:
            issues = self._progress["recent_issues"]
            issues.append(entry)
            self._progress["recent_issues"] = issues[-10:]

    def request_cancel(self) -> bool:
        if not self._progress.get("running"):
            return False
        self._cancel_requested = True
        return True

    def embed_batch(self, image_ids: Optional[List[int]] = None):
        """
        Embed images in batch.

        If image_ids is None, embeds all images without embeddings.
        """
        with _embed_lock:
            if self._progress["running"]:
                return {"error": "Embedding already in progress"}
            self._progress["running"] = True
            self._cancel_requested = False

        with self._progress_lock:
            self._progress = {
                "running": True,
                "total": 0,
                "processed": 0,
                "embedded": 0,
                "errors": 0,
                "skipped": 0,
                "unreadable": 0,
                "failed": 0,
                "message": "Preparing embedding job...",
                "step": "preparing",
                "current_item": None,
                "recent_issues": [],
                "started_at": time.time(),
                "updated_at": time.time(),
                "current_batch": 0,
                "total_batches": 0,
            }

        try:
            with self.db.get_db() as conn:
                cursor = conn.cursor()

                if image_ids:
                    placeholders = ",".join("?" * len(image_ids))
                    cursor.execute(
                        f"SELECT id, path FROM images WHERE id IN ({placeholders}) AND embedding IS NULL AND COALESCE(is_readable, 1) = 1",
                        image_ids,
                    )
                else:
                    cursor.execute(
                        "SELECT id, path FROM images WHERE embedding IS NULL AND COALESCE(is_readable, 1) = 1"
                    )

                rows = cursor.fetchall()
                self._progress["total"] = len(rows)
                self._progress["updated_at"] = time.time()

            if not rows:
                self._progress["message"] = "No images pending embeddings."
                self._progress["step"] = "idle"
                return {
                    "processed": 0,
                    "errors": 0,
                    "total": 0,
                    "message": self._progress["message"],
                }

            self._progress["message"] = "Loading embedding model..."
            self._progress["step"] = "loading_model"
            self._progress["updated_at"] = time.time()
            try:
                model = _get_embed_model()
            except Exception as exc:
                self._progress["errors"] = len(rows)
                self._progress["failed"] = len(rows)
                self._progress["message"] = f"Embedding unavailable: {exc}"
                self._progress["step"] = "error"
                self._progress["updated_at"] = time.time()
                logger.error("Similarity embedding unavailable: %s", exc)
                return {
                    "processed": 0,
                    "errors": self._progress["errors"],
                    "total": self._progress["total"],
                    "message": self._progress["message"],
                }

            # Process in small batches to allow progress tracking
            batch_size = EMBEDDING_BATCH_SIZE
            total_batches = max(1, int(np.ceil(len(rows) / batch_size)))
            self._progress["total_batches"] = total_batches
            for i in range(0, len(rows), batch_size):
                if self._cancel_requested:
                    logger.info("Similarity embedding cancelled at %d/%d", self._progress["processed"], len(rows))
                    break
                batch = rows[i:i + batch_size]
                batch_index = (i // batch_size) + 1
                self._progress["message"] = f"Embedding batch {batch_index}/{total_batches}..."
                self._progress["step"] = "embedding"
                self._progress["current_batch"] = batch_index
                self._progress["updated_at"] = time.time()

                # Batch update embeddings - collect all updates first
                updates = []
                for img_id, img_path in batch:
                    resolved_path = resolve_existing_indexed_image_path(img_path, backend_file=__file__)
                    self._progress["current_item"] = os.path.basename(resolved_path or img_path)
                    self._progress["updated_at"] = time.time()

                    if not resolved_path:
                        self._progress["processed"] += 1
                        self._progress["errors"] += 1
                        self._progress["skipped"] += 1
                        self._record_issue("skipped", img_id, img_path, "File not found")
                        if hasattr(self.db, "mark_image_unreadable"):
                            self.db.mark_image_unreadable(img_id, "File not found")
                        continue

                    readable, read_error = verify_image_readable(resolved_path)
                    if not readable:
                        self._progress["processed"] += 1
                        self._progress["errors"] += 1
                        self._progress["unreadable"] += 1
                        self._record_issue("unreadable", img_id, img_path, read_error or "Unreadable image")
                        if hasattr(self.db, "mark_image_unreadable"):
                            self.db.mark_image_unreadable(img_id, read_error or "Unreadable image")
                        continue

                    embedding = embed_image_file(resolved_path, model=model)
                    self._progress["processed"] += 1
                    if embedding is not None:
                        content_fingerprint = None
                        try:
                            content_fingerprint = compute_image_content_fingerprint(resolved_path)
                        except Exception as exc:
                            logger.warning("Could not compute content fingerprint for %s: %s", resolved_path, exc)
                        updates.append((embedding_to_bytes(embedding), content_fingerprint, img_id))
                        self._progress["embedded"] += 1
                    else:
                        self._progress["errors"] += 1
                        self._progress["failed"] += 1
                        self._record_issue("failed", img_id, img_path, "Embedding backend returned no vector")

                # Single batch UPDATE for all embeddings in this chunk
                if updates:
                    from services.derived_state_service import write_image_embeddings

                    with self.db.get_db() as conn:
                        cursor = conn.cursor()
                        write_image_embeddings(cursor, updates)

                    # Embeddings changed → the vectorized search cache is stale.
                    # Drop it so the next search rebuilds from fresh vectors.
                    self.invalidate_vector_cache()

                gc.collect()

            if self._cancel_requested:
                # Cancel happy-path: distinguish "user cancelled mid-run" from
                # "completed normally" so the UI can show the right toast and
                # the progress endpoint isn't stuck on the success message.
                self._progress["message"] = (
                    f"Cancelled at {self._progress['processed']}/{len(rows)}."
                )
                self._progress["step"] = "cancelled"
            else:
                self._progress["message"] = (
                    f"Completed embeddings: {self._progress['embedded']} embedded"
                    + (
                        f", {self._progress['skipped']} skipped, "
                        f"{self._progress['unreadable']} unreadable, "
                        f"{self._progress['failed']} failed."
                        if self._progress["errors"]
                        else "."
                    )
                )
                self._progress["step"] = "done"
            self._progress["current_item"] = None
            self._progress["updated_at"] = time.time()

        except Exception as exc:
            # Without this branch a crash in the embed loop just propagates
            # into FastAPI's BackgroundTasks logger, leaving the progress
            # endpoint pinned at running=False + step="embedding" — visually
            # indistinguishable from "still in progress". Surface it instead.
            logger.exception("Similarity embedding failed: %s", exc)
            self._progress["step"] = "error"
            self._progress["message"] = f"Embedding failed: {exc}"
            self._progress["current_item"] = None
            self._progress["updated_at"] = time.time()

        finally:
            self._progress["running"] = False

        return {
            "processed": self._progress["processed"],
            "embedded": self._progress["embedded"],
            "errors": self._progress["errors"],
            "skipped": self._progress["skipped"],
            "unreadable": self._progress["unreadable"],
            "failed": self._progress["failed"],
            "total": self._progress["total"],
            "message": self._progress["message"],
            "recent_issues": list(self._progress["recent_issues"]),
        }

    def search_by_id(
        self,
        image_id: int,
        limit: int = SIMILARITY_DEFAULT_LIMIT,
        threshold: float = SIMILARITY_DEFAULT_THRESHOLD,
        offset: int = 0,
        allowed_ids: Optional[Set[int]] = None,
    ) -> Dict[str, Any]:
        """Find images similar to a given image ID.

        When ``allowed_ids`` is provided, results are restricted to that set of
        image ids (e.g. a collection or Favorites). ``None`` searches the whole
        library — the long-standing default behavior.
        """
        with self.db.get_db() as conn:
            cursor = conn.cursor()

            cursor.execute("SELECT id, embedding FROM images WHERE id = ?", (image_id,))
            row = cursor.fetchone()
            if not row:
                raise SimilarityImageNotFoundError(image_id)
            if not row[1]:
                raise SimilarityEmbeddingMissingError(image_id)

            query_emb = bytes_to_embedding(row[1])

        page_limit = max(1, int(limit))
        page_offset = max(0, int(offset))
        page, total, has_more = self._search_ranked_candidates(
            query_emb,
            threshold,
            page_limit,
            page_offset,
            exclude_id=image_id,
            allowed_ids=allowed_ids,
        )
        return {
            "results": page,
            "total": total,
            "has_more": has_more,
            "offset": page_offset,
            "limit": page_limit,
        }

    def search_by_upload(
        self,
        image_data: bytes,
        limit: int = SIMILARITY_DEFAULT_LIMIT,
        threshold: float = SIMILARITY_DEFAULT_THRESHOLD,
        offset: int = 0,
        allowed_ids: Optional[Set[int]] = None,
    ) -> Dict[str, Any]:
        """Find images similar to an uploaded image.

        When ``allowed_ids`` is provided, results are restricted to that set of
        image ids (e.g. a collection or Favorites). ``None`` searches the whole
        library — the long-standing default behavior.
        """
        try:
            pil_image = Image.open(io.BytesIO(image_data))
            pil_image.load()
        except (UnidentifiedImageError, OSError) as exc:
            raise SimilarityInvalidImageError() from exc

        query_emb = embed_image_pil(pil_image)
        if query_emb is None:
            page_limit = max(1, int(limit))
            page_offset = max(0, int(offset))
            return {
                "results": [],
                "total": 0,
                "has_more": False,
                "offset": page_offset,
                "limit": page_limit,
            }

        page_limit = max(1, int(limit))
        page_offset = max(0, int(offset))
        page, total, has_more = self._search_ranked_candidates(
            query_emb,
            threshold,
            page_limit,
            page_offset,
            allowed_ids=allowed_ids,
        )
        return {
            "results": page,
            "total": total,
            "has_more": has_more,
            "offset": page_offset,
            "limit": page_limit,
        }

    def find_duplicates(
        self,
        threshold: float = DUPLICATE_THRESHOLD,
        limit: int = 100,
        offset: int = 0,
    ) -> Dict[str, Any]:
        """Find near-duplicate image pairs above similarity threshold."""
        with self.db.get_db() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                SELECT COUNT(*)
                FROM images
                WHERE embedding IS NOT NULL
                  AND COALESCE(is_readable, 1) = 1
                """
            )
            embedded_count = int(cursor.fetchone()[0] or 0)

            if embedded_count < 2:
                raise SimilarityInsufficientEmbeddingsError(embedded_count)

            if embedded_count > DUPLICATE_SYNC_MAX_EMBEDDINGS:
                raise SimilarityDuplicateSearchTooLargeError(
                    embedded_count,
                    DUPLICATE_SYNC_MAX_EMBEDDINGS,
                )

            cursor.execute(
                """
                SELECT id, path, filename, embedding
                FROM images
                WHERE embedding IS NOT NULL
                  AND COALESCE(is_readable, 1) = 1
                """
            )
            rows = cursor.fetchall()

        # Build embedding matrix
        ids = [r[0] for r in rows]
        paths = [r[1] for r in rows]
        filenames = [r[2] for r in rows]
        embeddings = np.array([bytes_to_embedding(r[3]) for r in rows])

        # Normalize for efficient cosine similarity
        norms = np.linalg.norm(embeddings, axis=1, keepdims=True)
        norms[norms == 0] = 1
        normalized = embeddings / norms

        # Find the globally best duplicates above threshold using a bounded heap.
        # This avoids the old "stop when limit is reached" behavior that could
        # silently hide better matches later in the scan.
        total_matches = 0
        top_matches_heap: List[Tuple[float, int, int, Dict[str, Any]]] = []
        page_limit = max(1, limit)
        page_offset = max(0, offset)
        keep_count = page_limit + page_offset + 1
        chunk_size = DUPLICATE_CHUNK_SIZE

        for i in range(0, len(rows), chunk_size):
            chunk = normalized[i:i + chunk_size]
            # Compare chunk against all embeddings after it
            for j in range(i, len(rows), chunk_size):
                other = normalized[j:j + chunk_size]
                sim_matrix = chunk @ other.T

                for ci in range(sim_matrix.shape[0]):
                    for cj in range(sim_matrix.shape[1]):
                        actual_i = i + ci
                        actual_j = j + cj
                        if actual_i >= actual_j:
                            continue  # Skip self and already-compared pairs

                        sim = float(sim_matrix[ci, cj])
                        if sim >= threshold:
                            total_matches += 1
                            pair = {
                                "image_a": {
                                    "id": ids[actual_i],
                                    "path": paths[actual_i],
                                    "filename": filenames[actual_i],
                                },
                                "image_b": {
                                    "id": ids[actual_j],
                                    "path": paths[actual_j],
                                    "filename": filenames[actual_j],
                                },
                                "similarity": round(sim, 4),
                            }

                            if len(top_matches_heap) < keep_count:
                                heapq.heappush(top_matches_heap, (sim, ids[actual_i], ids[actual_j], pair))
                            elif sim > top_matches_heap[0][0]:
                                heapq.heapreplace(top_matches_heap, (sim, ids[actual_i], ids[actual_j], pair))

        ranked_duplicates = [
            pair for _similarity, _id_a, _id_b, pair in sorted(
                top_matches_heap,
                key=lambda item: item[0],
                reverse=True,
            )
        ]
        page = ranked_duplicates[page_offset:page_offset + page_limit]
        has_more = total_matches > (page_offset + len(page))
        return {
            "duplicates": page,
            "total": total_matches,
            "has_more": has_more,
            "offset": page_offset,
            "limit": page_limit,
            "threshold": threshold,
        }

    def _normalize_similarity_window(self, limit: int, offset: int) -> Tuple[int, int, int]:
        page_limit = max(1, int(limit))
        page_offset = max(0, int(offset))
        keep_count = page_limit + page_offset + 1
        if keep_count > SIMILARITY_SEARCH_MAX_WINDOW:
            raise SimilaritySearchWindowTooLargeError(keep_count, SIMILARITY_SEARCH_MAX_WINDOW)
        return page_limit, page_offset, keep_count

    def _rank_candidate_rows(
        self,
        query_emb: np.ndarray,
        candidates: list,
        threshold: float,
    ) -> List[Dict[str, Any]]:
        """Rank one bounded chunk of candidate images by similarity."""
        if not candidates:
            return []

        query_norm = np.linalg.norm(query_emb)
        if query_norm == 0:
            return []

        valid_rows = []
        embeddings = []
        for candidate in candidates:
            embedding = bytes_to_embedding(candidate[3])
            if embedding.shape != query_emb.shape:
                logger.warning(
                    "Skipping similarity candidate %s because embedding shape %s does not match query shape %s",
                    candidate[0],
                    embedding.shape,
                    query_emb.shape,
                )
                continue
            valid_rows.append(candidate)
            embeddings.append(embedding)

        if not embeddings:
            return []

        candidate_embs = np.vstack(embeddings).astype(np.float32, copy=False)
        candidate_norms = np.linalg.norm(candidate_embs, axis=1)
        candidate_norms[candidate_norms == 0] = 1
        similarities = candidate_embs @ query_emb / (candidate_norms * query_norm)

        results = []
        for idx, sim in enumerate(similarities):
            if sim >= threshold:
                row = valid_rows[idx]
                results.append({
                    "id": row[0],
                    "path": row[1],
                    "filename": row[2],
                    "similarity": round(float(sim), 4),
                })
        return results

    def _iter_embedding_candidate_chunks(self, exclude_id: Optional[int] = None):
        """Yield readable embedding rows in DB-sized chunks without materializing all rows."""
        with self.db.get_db() as conn:
            cursor = conn.cursor()
            params: Tuple[Any, ...] = ()
            exclude_clause = ""
            if exclude_id is not None:
                exclude_clause = "AND id != ?"
                params = (exclude_id,)

            cursor.execute(
                f"""
                SELECT id, path, filename, embedding
                FROM images
                WHERE embedding IS NOT NULL
                  AND COALESCE(is_readable, 1) = 1
                  {exclude_clause}
                ORDER BY id
                """,
                params,
            )
            while True:
                rows = cursor.fetchmany(SIMILARITY_SEARCH_CHUNK_SIZE)
                if not rows:
                    break
                yield rows

    def _search_ranked_candidates(
        self,
        query_emb: np.ndarray,
        threshold: float,
        limit: int,
        offset: int,
        *,
        exclude_id: Optional[int] = None,
        allowed_ids: Optional[Set[int]] = None,
    ) -> Tuple[List[Dict[str, Any]], int, bool]:
        """Rank candidates, preferring the in-memory vectorized cache.

        Validates the pagination window once, then tries the cached matmul path.
        If the cache is unavailable (disabled, not buildable, dimension mismatch,
        or any failure) it transparently falls back to the streaming heap scan so
        results are identical and never capped.

        When ``allowed_ids`` is set, both paths restrict candidates to that id set
        (collection / Favorites scope) before threshold filtering and pagination,
        so ``total`` / ``has_more`` reflect the scoped result set.
        """
        page_limit, page_offset, keep_count = self._normalize_similarity_window(limit, offset)

        cached = self._try_cached_ranked_candidates(
            query_emb, threshold, page_limit, page_offset,
            exclude_id=exclude_id, allowed_ids=allowed_ids,
        )
        if cached is not None:
            return cached

        return self._stream_ranked_candidates(
            query_emb, threshold, page_limit, page_offset, keep_count,
            exclude_id=exclude_id, allowed_ids=allowed_ids,
        )

    def _stream_ranked_candidates(
        self,
        query_emb: np.ndarray,
        threshold: float,
        page_limit: int,
        page_offset: int,
        keep_count: int,
        *,
        exclude_id: Optional[int] = None,
        allowed_ids: Optional[Set[int]] = None,
    ) -> Tuple[List[Dict[str, Any]], int, bool]:
        """Stream candidates through a bounded heap to avoid loading every embedding at once.

        When ``allowed_ids`` is set, candidates outside that id set are skipped so
        ``total`` counts only scoped matches, keeping pagination/``has_more`` correct.
        """
        total = 0
        top_heap: List[Tuple[float, int, Dict[str, Any]]] = []

        for chunk in self._iter_embedding_candidate_chunks(exclude_id=exclude_id):
            for result in self._rank_candidate_rows(query_emb, chunk, threshold):
                if allowed_ids is not None and int(result["id"]) not in allowed_ids:
                    continue
                total += 1
                item = (float(result["similarity"]), -int(result["id"]), result)
                if len(top_heap) < keep_count:
                    heapq.heappush(top_heap, item)
                elif item[:2] > top_heap[0][:2]:
                    heapq.heapreplace(top_heap, item)

        ranked = [
            result for _similarity, _negative_id, result in sorted(
                top_heap,
                key=lambda item: item[:2],
                reverse=True,
            )
        ]
        page = ranked[page_offset:page_offset + page_limit]
        has_more = total > (page_offset + len(page))
        return page, total, has_more

    # ------------------------------------------------------------------
    # Vectorized in-memory cache (PERF-1)
    # ------------------------------------------------------------------

    def invalidate_vector_cache(self) -> None:
        """Drop the cached embedding matrix so the next search rebuilds it."""
        with self._vector_cache_lock:
            self._vector_cache = None
            self._delete_persisted_vector_cache()

    # ------------------------------------------------------------------
    # On-disk persistence of the exact vector cache (v3.3.2 Phase 1)
    #
    # Persisting the built matrix to STATE_DIR/similarity-index/ lets a cold
    # start (or the first search after a restart) skip re-reading and
    # re-normalizing every embedding BLOB from SQLite. It stays EXACT — the
    # same normalized matrix the in-RAM path uses, just loaded from disk — so
    # results never change. Keyed on the (count, max_id) signature: any row
    # add/delete invalidates by mismatch; re-embeds (same signature, new
    # vectors) are invalidated explicitly via invalidate_vector_cache().
    # All disk I/O is best-effort: any failure silently falls back to rebuilding
    # in RAM, so persistence can never break or cap search.
    # ------------------------------------------------------------------

    _PERSIST_MATRIX_NAME = "matrix.npy"
    _PERSIST_IDS_NAME = "ids.npy"
    _PERSIST_META_NAME = "meta.json"

    def _get_index_dir(self) -> Path:
        return Path(get_state_dir()) / "similarity-index"

    def _persist_vector_cache(self, cache: Dict[str, Any]) -> None:
        """Best-effort write of the normalized matrix + parallel arrays to disk."""
        try:
            index_dir = self._get_index_dir()
            index_dir.mkdir(parents=True, exist_ok=True)
            tmp_matrix = index_dir / (self._PERSIST_MATRIX_NAME + ".tmp")
            tmp_ids = index_dir / (self._PERSIST_IDS_NAME + ".tmp")
            tmp_meta = index_dir / (self._PERSIST_META_NAME + ".tmp")

            # Save to a file handle so np.save does not append a second ".npy".
            with open(tmp_matrix, "wb") as handle:
                np.save(handle, np.ascontiguousarray(cache["matrix"], dtype=np.float32))
            with open(tmp_ids, "wb") as handle:
                np.save(handle, np.asarray(cache["ids"], dtype=np.int64))
            meta = {
                "dim": int(cache["dim"]),
                "signature": [int(cache["signature"][0]), int(cache["signature"][1])],
                "paths": list(cache["paths"]),
                "filenames": list(cache["filenames"]),
            }
            tmp_meta.write_text(json.dumps(meta), encoding="utf-8")

            os.replace(tmp_matrix, index_dir / self._PERSIST_MATRIX_NAME)
            os.replace(tmp_ids, index_dir / self._PERSIST_IDS_NAME)
            os.replace(tmp_meta, index_dir / self._PERSIST_META_NAME)
            logger.debug(
                "[Similarity] Persisted vector cache (%s vectors) to %s",
                len(cache["paths"]),
                index_dir,
            )
        except Exception as exc:
            logger.debug("[Similarity] Could not persist vector cache: %s", exc)
            # A partial write is worse than none — clear it so we never load junk.
            self._delete_persisted_vector_cache()

    def _load_persisted_vector_cache(self, signature: Tuple[int, int]) -> Optional[Dict[str, Any]]:
        """Load a persisted cache iff it matches the signature and is self-consistent.

        Returns None (caller rebuilds) when the files are missing, the stored
        signature differs, or any shape/parse check fails. The signature gate makes
        a stale on-disk cache from a different library state simply ignored.
        """
        try:
            index_dir = self._get_index_dir()
            meta_path = index_dir / self._PERSIST_META_NAME
            matrix_path = index_dir / self._PERSIST_MATRIX_NAME
            ids_path = index_dir / self._PERSIST_IDS_NAME
            if not (meta_path.exists() and matrix_path.exists() and ids_path.exists()):
                return None

            meta = json.loads(meta_path.read_text(encoding="utf-8"))
            stored_sig = meta.get("signature")
            if (
                not isinstance(stored_sig, list)
                or len(stored_sig) != 2
                or (int(stored_sig[0]), int(stored_sig[1])) != signature
            ):
                return None

            matrix = np.load(matrix_path)
            ids = np.load(ids_path)
            paths = meta.get("paths") or []
            filenames = meta.get("filenames") or []
            dim = int(meta.get("dim", 0))
            rows = int(matrix.shape[0]) if matrix.ndim == 2 else -1
            # Self-consistency: the parallel arrays must all describe the same rows.
            # (rows may be < signature count when build skipped odd-dim embeddings.)
            if not (
                matrix.ndim == 2
                and dim > 0
                and matrix.shape[1] == dim
                and int(ids.shape[0]) == rows
                and len(paths) == rows
                and len(filenames) == rows
            ):
                logger.debug("[Similarity] Persisted cache shape mismatch; ignoring.")
                return None

            return {
                "matrix": np.ascontiguousarray(matrix, dtype=np.float32),
                "ids": np.asarray(ids, dtype=np.int64),
                "paths": list(paths),
                "filenames": list(filenames),
                "dim": dim,
                "signature": signature,
            }
        except Exception as exc:
            logger.debug("[Similarity] Could not load persisted vector cache: %s", exc)
            return None

    def _delete_persisted_vector_cache(self) -> None:
        """Best-effort removal of any persisted cache files (incl. temp writes)."""
        try:
            index_dir = self._get_index_dir()
            for name in (
                self._PERSIST_MATRIX_NAME,
                self._PERSIST_IDS_NAME,
                self._PERSIST_META_NAME,
                self._PERSIST_MATRIX_NAME + ".tmp",
                self._PERSIST_IDS_NAME + ".tmp",
                self._PERSIST_META_NAME + ".tmp",
            ):
                target = index_dir / name
                if target.exists():
                    target.unlink()
        except Exception as exc:
            logger.debug("[Similarity] Could not delete persisted vector cache: %s", exc)

    def _compute_embedding_signature(self) -> Optional[Tuple[int, int]]:
        """Cheap (count, max_id) fingerprint of readable embeddings.

        Returns None when the signature cannot be determined (e.g. a minimal DB
        mock that doesn't answer the aggregate query) — the caller then skips the
        cache and uses the streaming scan.
        """
        try:
            with self.db.get_db() as conn:
                cursor = conn.cursor()
                cursor.execute(
                    """
                    SELECT COUNT(*), COALESCE(MAX(id), 0)
                    FROM images
                    WHERE embedding IS NOT NULL
                      AND COALESCE(is_readable, 1) = 1
                    """
                )
                row = cursor.fetchone()
        except Exception as exc:
            logger.debug("[Similarity] Could not compute embedding signature: %s", exc)
            return None

        if not row or len(row) < 2 or row[0] is None:
            return None
        try:
            return (int(row[0]), int(row[1]))
        except (TypeError, ValueError):
            return None

    def _ensure_vector_cache(self) -> Optional[Dict[str, Any]]:
        """Return a fresh embedding cache, building it if missing or stale.

        Returns None (caller falls back to streaming) when the cache is disabled,
        the DB signature is undeterminable, there are no embeddings, or building
        the matrix fails (including MemoryError on very large libraries).
        """
        if not SIMILARITY_VECTOR_CACHE_ENABLED:
            return None

        signature = self._compute_embedding_signature()
        if signature is None or signature[0] == 0:
            return None

        cache = self._vector_cache
        if cache is not None and cache.get("signature") == signature:
            return cache

        with self._vector_cache_lock:
            cache = self._vector_cache
            if cache is not None and cache.get("signature") == signature:
                return cache

            # Prefer a persisted matrix (exact, just deserialized) over re-reading
            # and re-normalizing every embedding BLOB from SQLite.
            loaded = self._load_persisted_vector_cache(signature)
            if loaded is not None:
                self._vector_cache = loaded
                return loaded

            try:
                built = self._build_vector_cache(signature)
            except MemoryError:
                logger.warning(
                    "[Similarity] Not enough memory to build vectorized cache "
                    "(%s embeddings); falling back to streaming search.",
                    signature[0],
                )
                self._vector_cache = None
                return None
            except Exception as exc:
                logger.warning("[Similarity] Failed to build vectorized cache: %s", exc)
                self._vector_cache = None
                return None
            self._vector_cache = built
            if built is not None:
                self._persist_vector_cache(built)
            return built

    def _build_vector_cache(self, signature: Tuple[int, int]) -> Optional[Dict[str, Any]]:
        """Materialize an L2-normalized matrix + parallel id/path/filename arrays.

        Streams rows via fetchmany (never fetchall) so memory stays bounded during
        the build. Rows whose embedding dimension differs from the modal dimension
        are skipped, matching the streaming path's per-row shape guard.
        """
        ids: List[int] = []
        paths: List[str] = []
        filenames: List[str] = []
        vectors: List[np.ndarray] = []
        dim: Optional[int] = None
        skipped = 0

        for chunk in self._iter_embedding_candidate_chunks(exclude_id=None):
            for row in chunk:
                embedding = bytes_to_embedding(row[3])
                if dim is None:
                    dim = int(embedding.shape[0])
                if embedding.shape[0] != dim:
                    skipped += 1
                    continue
                ids.append(int(row[0]))
                paths.append(row[1])
                filenames.append(row[2])
                vectors.append(embedding)

        if not vectors or dim is None:
            return None

        matrix = np.vstack(vectors).astype(np.float32, copy=False)
        norms = np.linalg.norm(matrix, axis=1)
        norms[norms == 0] = 1.0
        matrix = matrix / norms[:, None]

        if skipped:
            logger.info(
                "[Similarity] Vector cache skipped %s embedding(s) with mismatched dimension.",
                skipped,
            )

        return {
            "matrix": matrix,
            "ids": np.asarray(ids, dtype=np.int64),
            "paths": paths,
            "filenames": filenames,
            "dim": dim,
            "signature": signature,
        }

    def _try_cached_ranked_candidates(
        self,
        query_emb: np.ndarray,
        threshold: float,
        page_limit: int,
        page_offset: int,
        *,
        exclude_id: Optional[int] = None,
        allowed_ids: Optional[Set[int]] = None,
    ) -> Optional[Tuple[List[Dict[str, Any]], int, bool]]:
        """Vectorized ranking over the cached matrix.

        Returns None to signal the caller should fall back to streaming. Result
        ordering matches _stream_ranked_candidates exactly: filter on the raw
        cosine (>= threshold), sort by the 4-decimal-rounded similarity descending
        with ascending id as the tie-break.

        When ``allowed_ids`` is set, a boolean membership mask over ``cache["ids"]``
        is folded into the threshold/exclude mask before sort + pagination, so the
        scoped result matches the streaming path exactly.
        """
        cache = self._ensure_vector_cache()
        if cache is None:
            return None
        if int(query_emb.shape[0]) != cache["dim"]:
            # Dimension mismatch — streaming handles per-row shape skipping.
            return None

        query_norm = float(np.linalg.norm(query_emb))
        if query_norm == 0:
            return [], 0, False

        query_unit = (query_emb.astype(np.float32, copy=False)) / query_norm
        sims = cache["matrix"] @ query_unit  # cosine, matrix rows are unit vectors

        ids = cache["ids"]
        mask = sims >= threshold
        if exclude_id is not None:
            mask &= ids != int(exclude_id)
        if allowed_ids is not None:
            # Restrict to the scoped id set (collection / Favorites) before ranking.
            allowed_arr = np.fromiter(allowed_ids, dtype=np.int64, count=len(allowed_ids))
            mask &= np.isin(ids, allowed_arr)

        valid_idx = np.nonzero(mask)[0]
        total = int(valid_idx.size)
        if total == 0:
            return [], 0, False

        sub_rounded = np.round(sims[valid_idx], 4)
        sub_ids = ids[valid_idx]
        # lexsort sorts by the LAST key first: primary = -rounded (asc => rounded
        # desc), tie-break = id ascending.
        order = np.lexsort((sub_ids, -sub_rounded))
        ordered_idx = valid_idx[order]

        page_idx = ordered_idx[page_offset:page_offset + page_limit]
        paths = cache["paths"]
        filenames = cache["filenames"]
        page = [
            {
                "id": int(ids[i]),
                "path": paths[i],
                "filename": filenames[i],
                "similarity": round(float(sims[i]), 4),
            }
            for i in page_idx
        ]
        has_more = total > (page_offset + len(page))
        return page, total, has_more


# Singleton
_index = None


def get_similarity_index(db_module=None) -> SimilarityIndex:
    """Get the singleton similarity index."""
    global _index
    if _index is None:
        _index = SimilarityIndex(db_module=db_module)
    return _index
