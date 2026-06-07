"""Tests for the two new CLIP similarity endpoints (point 5/6):

* ``GET /api/similarity/compare?id_a&id_b`` — cosine similarity of two images.
* ``GET /api/similarity/near/{image_id}`` — top-K nearest images (wraps the
  previously-unwired ``SimilarityIndex.top_k_similar``).

These exercise the read-only compare path and the near/dedup path against a
temp DB seeded with hand-crafted embedding vectors.
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1].parent))


def _seed(test_client, monkeypatch, vectors):
    """Create one image per vector (``None`` = no embedding) and rebuild the
    module similarity index from the test DB. Returns the new image ids."""
    import similarity as similarity_module

    ids = []
    for i, vec in enumerate(vectors):
        image_id = test_client.test_db.add_image(
            path=f"/tmp/cmpnear-{i}.png",
            filename=f"cmpnear-{i}.png",
            metadata_json="{}",
        )
        if vec is not None:
            blob = similarity_module.embedding_to_bytes(np.asarray(vec, dtype=np.float32))
            with test_client.test_db.get_db() as conn:
                conn.execute("UPDATE images SET embedding = ? WHERE id = ?", (blob, image_id))
        ids.append(image_id)
    monkeypatch.setattr(
        similarity_module, "_index", similarity_module.SimilarityIndex(test_client.test_db)
    )
    return ids


class TestSimilarityCompare:
    def test_identical_vectors_score_one(self, test_client, monkeypatch):
        a, b = _seed(test_client, monkeypatch, [[1, 0, 0, 0], [1, 0, 0, 0]])
        response = test_client.get(f"/api/similarity/compare?id_a={a}&id_b={b}")
        assert response.status_code == 200
        data = response.json()
        assert data["id_a"] == a and data["id_b"] == b
        assert data["similarity"] == 1.0
        assert data["filename_a"] == "cmpnear-0.png"

    def test_orthogonal_vectors_score_zero(self, test_client, monkeypatch):
        a, b = _seed(test_client, monkeypatch, [[1, 0, 0, 0], [0, 1, 0, 0]])
        response = test_client.get(f"/api/similarity/compare?id_a={a}&id_b={b}")
        assert response.status_code == 200
        assert response.json()["similarity"] == 0.0

    def test_missing_image_is_404(self, test_client, monkeypatch):
        (a,) = _seed(test_client, monkeypatch, [[1, 0, 0, 0]])
        response = test_client.get(f"/api/similarity/compare?id_a={a}&id_b=999999")
        assert response.status_code == 404

    def test_unembedded_image_is_409(self, test_client, monkeypatch):
        a, b = _seed(test_client, monkeypatch, [[1, 0, 0, 0], None])
        response = test_client.get(f"/api/similarity/compare?id_a={a}&id_b={b}")
        assert response.status_code == 409


class TestSimilarityNear:
    def test_returns_closest_first_excluding_self(self, test_client, monkeypatch):
        query, near, far = _seed(
            test_client, monkeypatch, [[1, 0, 0, 0], [0.96, 0.02, 0, 0], [0, 1, 0, 0]]
        )
        response = test_client.get(f"/api/similarity/near/{query}?limit=10")
        assert response.status_code == 200
        data = response.json()
        assert data["query_image_id"] == query
        ids = [item["id"] for item in data["results"]]
        assert query not in ids  # excludes the query image itself
        assert ids[0] == near  # most-similar first
        assert far in ids

    def test_missing_image_is_404(self, test_client, monkeypatch):
        _seed(test_client, monkeypatch, [[1, 0, 0, 0]])
        response = test_client.get("/api/similarity/near/999999")
        assert response.status_code == 404

    def test_unembedded_image_is_409(self, test_client, monkeypatch):
        (a,) = _seed(test_client, monkeypatch, [None])
        response = test_client.get(f"/api/similarity/near/{a}")
        assert response.status_code == 409
