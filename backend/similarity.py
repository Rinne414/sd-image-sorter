"""
Image similarity search using FastEmbed CLIP embeddings.

Generates 512-dim CLIP embeddings per image and stores them in SQLite.
Supports finding similar images by ID, by upload, and finding duplicates.
"""
import io
import heapq
import logging
import os
import tempfile
import threading
import time
from typing import Dict, List, Optional, Tuple, Any

import numpy as np
from PIL import Image, UnidentifiedImageError

from config import (
    CLIP_MODEL_NAME,
    get_clip_model_dir,
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
from services.derived_state_service import write_image_embeddings
from utils.source_paths import resolve_existing_indexed_image_path


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


# Lazy-loaded FastEmbed model
_embed_model = None
_embed_lock = threading.Lock()


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
        pass
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

    def embed_batch(self, image_ids: Optional[List[int]] = None):
        """
        Embed images in batch.

        If image_ids is None, embeds all images without embeddings.
        """
        with _embed_lock:
            if self._progress["running"]:
                return {"error": "Embedding already in progress"}
            self._progress["running"] = True

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
                    with self.db.get_db() as conn:
                        cursor = conn.cursor()
                        write_image_embeddings(cursor, updates)

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
    ) -> Dict[str, Any]:
        """Find images similar to a given image ID."""
        with self.db.get_db() as conn:
            cursor = conn.cursor()

            # Get query embedding
            cursor.execute("SELECT id, embedding FROM images WHERE id = ?", (image_id,))
            row = cursor.fetchone()
            if not row:
                raise SimilarityImageNotFoundError(image_id)
            if not row[1]:
                raise SimilarityEmbeddingMissingError(image_id)

            query_emb = bytes_to_embedding(row[1])

            # Get all embeddings
            cursor.execute(
                """
                SELECT id, path, filename, embedding
                FROM images
                WHERE embedding IS NOT NULL
                  AND COALESCE(is_readable, 1) = 1
                  AND id != ?
                """,
                (image_id,),
            )
            candidates = cursor.fetchall()

        ranked = self._rank_candidates(query_emb, candidates, threshold)
        page, total, has_more = self._paginate_ranked_results(ranked, limit, offset)
        return {
            "results": page,
            "total": total,
            "has_more": has_more,
            "offset": offset,
            "limit": limit,
        }

    def search_by_upload(
        self,
        image_data: bytes,
        limit: int = SIMILARITY_DEFAULT_LIMIT,
        threshold: float = SIMILARITY_DEFAULT_THRESHOLD,
        offset: int = 0,
    ) -> Dict[str, Any]:
        """Find images similar to an uploaded image."""
        try:
            pil_image = Image.open(io.BytesIO(image_data))
            pil_image.load()
        except (UnidentifiedImageError, OSError) as exc:
            raise SimilarityInvalidImageError() from exc

        query_emb = embed_image_pil(pil_image)
        if query_emb is None:
            return []

        with self.db.get_db() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                SELECT id, path, filename, embedding
                FROM images
                WHERE embedding IS NOT NULL
                  AND COALESCE(is_readable, 1) = 1
                """
            )
            candidates = cursor.fetchall()

        ranked = self._rank_candidates(query_emb, candidates, threshold)
        page, total, has_more = self._paginate_ranked_results(ranked, limit, offset)
        return {
            "results": page,
            "total": total,
            "has_more": has_more,
            "offset": offset,
            "limit": limit,
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

    def _rank_candidates(
        self,
        query_emb: np.ndarray,
        candidates: list,
        threshold: float,
    ) -> List[Dict[str, Any]]:
        """Rank candidate images by similarity to query embedding."""
        if not candidates:
            return []

        # Vectorized similarity computation
        candidate_embs = np.array([bytes_to_embedding(c[3]) for c in candidates])
        query_norm = np.linalg.norm(query_emb)
        if query_norm == 0:
            return []

        candidate_norms = np.linalg.norm(candidate_embs, axis=1)
        candidate_norms[candidate_norms == 0] = 1

        similarities = candidate_embs @ query_emb / (candidate_norms * query_norm)

        # Filter and sort
        results = []
        for idx, sim in enumerate(similarities):
            if sim >= threshold:
                results.append({
                    "id": candidates[idx][0],
                    "path": candidates[idx][1],
                    "filename": candidates[idx][2],
                    "similarity": round(float(sim), 4),
                })

        results.sort(key=lambda x: x["similarity"], reverse=True)
        return results

    def _paginate_ranked_results(
        self,
        ranked_results: List[Dict[str, Any]],
        limit: int,
        offset: int,
    ) -> Tuple[List[Dict[str, Any]], int, bool]:
        """Slice an already-ranked result list and report pagination metadata."""
        page_limit = max(1, limit)
        page_offset = max(0, offset)
        total = len(ranked_results)
        page = ranked_results[page_offset:page_offset + page_limit]
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
