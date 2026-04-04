"""
Image similarity search using FastEmbed CLIP embeddings.

Generates 512-dim CLIP embeddings per image and stores them in SQLite.
Supports finding similar images by ID, by upload, and finding duplicates.
"""
import io
import logging
import os
import tempfile
import threading
from typing import Dict, List, Optional, Tuple, Any

import numpy as np
from PIL import Image, UnidentifiedImageError

from config import (
    CLIP_MODEL_NAME,
    SIMILARITY_DEFAULT_LIMIT,
    SIMILARITY_DEFAULT_THRESHOLD,
    DUPLICATE_THRESHOLD,
    EMBEDDING_BATCH_SIZE,
    DUPLICATE_CHUNK_SIZE,
)


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
                    _embed_model = ImageEmbedding(
                        model_name=CLIP_MODEL_NAME,
                    )
                except ImportError:
                    raise RuntimeError(
                        "fastembed not installed. Run: pip install fastembed"
                    )
    return _embed_model


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
        self._progress = {
            "running": False,
            "total": 0,
            "processed": 0,
            "errors": 0,
            "message": "",
        }

    def get_progress(self) -> Dict[str, Any]:
        """Get current embedding progress."""
        return dict(self._progress)

    def embed_batch(self, image_ids: Optional[List[int]] = None):
        """
        Embed images in batch.

        If image_ids is None, embeds all images without embeddings.
        """
        if self._progress["running"]:
            return {"error": "Embedding already in progress"}

        self._progress = {
            "running": True,
            "total": 0,
            "processed": 0,
            "errors": 0,
            "message": "Preparing embedding job...",
        }

        try:
            with self.db.get_db() as conn:
                cursor = conn.cursor()

                if image_ids:
                    placeholders = ",".join("?" * len(image_ids))
                    cursor.execute(
                        f"SELECT id, path FROM images WHERE id IN ({placeholders}) AND embedding IS NULL",
                        image_ids,
                    )
                else:
                    cursor.execute(
                        "SELECT id, path FROM images WHERE embedding IS NULL"
                    )

                rows = cursor.fetchall()
                self._progress["total"] = len(rows)

            if not rows:
                self._progress["message"] = "No images pending embeddings."
                return {
                    "processed": 0,
                    "errors": 0,
                    "total": 0,
                    "message": self._progress["message"],
                }

            self._progress["message"] = "Loading embedding model..."
            try:
                model = _get_embed_model()
            except Exception as exc:
                self._progress["errors"] = len(rows)
                self._progress["message"] = f"Embedding unavailable: {exc}"
                logger.error("Similarity embedding unavailable: %s", exc)
                return {
                    "processed": 0,
                    "errors": self._progress["errors"],
                    "total": self._progress["total"],
                    "message": self._progress["message"],
                }

            # Process in small batches to allow progress tracking
            batch_size = EMBEDDING_BATCH_SIZE
            for i in range(0, len(rows), batch_size):
                batch = rows[i:i + batch_size]
                self._progress["message"] = f"Embedding batch {min(i + len(batch), len(rows))}/{len(rows)}..."

                # Filter to existing files
                valid = [(r[0], r[1]) for r in batch if os.path.exists(r[1])]

                # Batch update embeddings - collect all updates first
                updates = []
                for img_id, img_path in valid:
                    embedding = embed_image_file(img_path, model=model)
                    if embedding is not None:
                        updates.append((embedding_to_bytes(embedding), img_id))
                        self._progress["processed"] += 1
                    else:
                        self._progress["errors"] += 1

                # Single batch UPDATE for all embeddings in this chunk
                if updates:
                    with self.db.get_db() as conn:
                        cursor = conn.cursor()
                        cursor.executemany(
                            "UPDATE images SET embedding = ? WHERE id = ?",
                            updates
                        )

                # Count non-existent files as errors
                self._progress["errors"] += len(batch) - len(valid)

            self._progress["message"] = (
                f"Completed embeddings: {self._progress['processed']} processed"
                + (f", {self._progress['errors']} failed." if self._progress["errors"] else ".")
            )

        finally:
            self._progress["running"] = False

        return {
            "processed": self._progress["processed"],
            "errors": self._progress["errors"],
            "total": self._progress["total"],
            "message": self._progress["message"],
        }

    def search_by_id(
        self, image_id: int, limit: int = SIMILARITY_DEFAULT_LIMIT, threshold: float = SIMILARITY_DEFAULT_THRESHOLD
    ) -> List[Dict[str, Any]]:
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
                "SELECT id, path, filename, embedding FROM images WHERE embedding IS NOT NULL AND id != ?",
                (image_id,),
            )
            candidates = cursor.fetchall()

        return self._rank_candidates(query_emb, candidates, limit, threshold)

    def search_by_upload(
        self, image_data: bytes, limit: int = SIMILARITY_DEFAULT_LIMIT, threshold: float = SIMILARITY_DEFAULT_THRESHOLD
    ) -> List[Dict[str, Any]]:
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
                "SELECT id, path, filename, embedding FROM images WHERE embedding IS NOT NULL"
            )
            candidates = cursor.fetchall()

        return self._rank_candidates(query_emb, candidates, limit, threshold)

    def find_duplicates(
        self, threshold: float = DUPLICATE_THRESHOLD, limit: int = 100
    ) -> List[Dict[str, Any]]:
        """Find near-duplicate image pairs above similarity threshold."""
        with self.db.get_db() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "SELECT id, path, filename, embedding FROM images WHERE embedding IS NOT NULL"
            )
            rows = cursor.fetchall()

        if len(rows) < 2:
            raise SimilarityInsufficientEmbeddingsError(len(rows))

        # Build embedding matrix
        ids = [r[0] for r in rows]
        paths = [r[1] for r in rows]
        filenames = [r[2] for r in rows]
        embeddings = np.array([bytes_to_embedding(r[3]) for r in rows])

        # Normalize for efficient cosine similarity
        norms = np.linalg.norm(embeddings, axis=1, keepdims=True)
        norms[norms == 0] = 1
        normalized = embeddings / norms

        # Find pairs above threshold using matrix multiplication
        # Process in chunks to avoid memory issues
        duplicates = []
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
                            duplicates.append({
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
                            })

                            if len(duplicates) >= limit:
                                return sorted(
                                    duplicates,
                                    key=lambda x: x["similarity"],
                                    reverse=True,
                                )

        return sorted(duplicates, key=lambda x: x["similarity"], reverse=True)

    def _rank_candidates(
        self,
        query_emb: np.ndarray,
        candidates: list,
        limit: int,
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
        return results[:limit]


# Singleton
_index = None


def get_similarity_index(db_module=None) -> SimilarityIndex:
    """Get the singleton similarity index."""
    global _index
    if _index is None:
        _index = SimilarityIndex(db_module=db_module)
    return _index
