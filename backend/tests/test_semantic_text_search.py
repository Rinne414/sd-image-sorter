"""Semantic text-to-image search (POST /api/similarity/search-text).

The text tower is stubbed (embed_text monkeypatch) so these tests pin the
wiring: ranking against stored embeddings, pagination shape, and the 503
model-not-ready path. Encoder pairing evidence (same ViT-B/32 checkpoint,
same 512-dim space) is cited in similarity.py.
"""
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

import database as db
import similarity


def _seed_embedded_image(path, vector):
    image_id = db.add_image(path=path, filename=path.rsplit("/", 1)[-1], metadata_json="{}")
    with db.get_db() as conn:
        conn.cursor().execute(
            "UPDATE images SET embedding = ? WHERE id = ?",
            (similarity.embedding_to_bytes(np.array(vector, dtype=np.float32)), image_id),
        )
    return image_id


@pytest.fixture
def embedded_trio(test_db):
    close = _seed_embedded_image("/test/sem/close.png", [1.0, 0.0, 0.0, 0.0])
    mid = _seed_embedded_image("/test/sem/mid.png", [0.7, 0.7, 0.0, 0.0])
    far = _seed_embedded_image("/test/sem/far.png", [0.0, 0.0, 1.0, 0.0])
    return close, mid, far


def test_ranks_by_cosine_against_stored_embeddings(test_client, embedded_trio, monkeypatch):
    close, mid, far = embedded_trio
    monkeypatch.setattr(
        similarity, "embed_text",
        lambda query: np.array([1.0, 0.0, 0.0, 0.0], dtype=np.float32),
    )
    response = test_client.post("/api/similarity/search-text", json={"query": "a red dress"})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["query"] == "a red dress"
    ids = [r["id"] for r in body["results"]]
    assert ids[0] == close
    assert ids.index(close) < ids.index(mid), "cosine order"


def test_model_not_ready_maps_to_503(test_client, embedded_trio, monkeypatch):
    def _raise(query):
        raise RuntimeError("CLIP text model is not ready yet")
    monkeypatch.setattr(similarity, "embed_text", _raise)
    response = test_client.post("/api/similarity/search-text", json={"query": "anything"})
    assert response.status_code == 503
    assert "not ready" in response.json()["error"]


def test_empty_query_rejected_by_schema(test_client):
    response = test_client.post("/api/similarity/search-text", json={"query": ""})
    # The app's validation handler maps RequestValidationError to 400.
    assert response.status_code == 400


def test_pagination_shape(test_client, embedded_trio, monkeypatch):
    monkeypatch.setattr(
        similarity, "embed_text",
        lambda query: np.array([1.0, 0.0, 0.0, 0.0], dtype=np.float32),
    )
    response = test_client.post("/api/similarity/search-text", json={"query": "x", "limit": 1})
    body = response.json()
    assert body["limit"] == 1 and len(body["results"]) == 1
    assert body["has_more"] is True and body["total"] >= 2
