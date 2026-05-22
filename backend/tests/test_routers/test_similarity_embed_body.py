"""Regression tests for /api/similarity/embed body parsing.

Background
==========
The original POST handler declared ``image_ids: Optional[list] = None``
without a Pydantic body model. FastAPI treats a non-pydantic plain-list
parameter on POST as a *query* parameter, so a JSON body of
``{"image_ids": [1, 2, 3]}`` was silently ignored - the worker then ran
``embed_batch(image_ids=None)`` and started embedding the entire library
(71,241 images for the user) instead of the requested subset.

A direct user-visible symptom: clicking "Generate embeddings for selected
images" on a few hand-picked rows kicked off a multi-hour run that
consumed CPU/GPU and could not be selectively cancelled to just the
selected work.
"""
from __future__ import annotations

from typing import List, Optional
from unittest.mock import MagicMock, patch

import pytest

from routers.similarity import EmbedRequest


class _RecordedService:
    """Stand-in for SimilarityService that records what was asked of it."""

    def __init__(self):
        self.calls: list[Optional[List[int]]] = []

    def embed_images(self, _bg, image_ids):
        self.calls.append(image_ids)
        return {"status": "started", "image_ids_received": image_ids}

    def cancel_embedding(self):
        return True

    def get_embed_progress(self):
        return {"running": False, "total": 0}


@pytest.fixture
def recorded_service(test_client):
    """Replace the similarity service with a recorder that captures image_ids."""
    from routers import similarity as similarity_router

    provider = similarity_router._similarity_service_provider
    original = provider.get()
    recorder = _RecordedService()
    similarity_router.set_similarity_service(recorder)
    try:
        yield recorder
    finally:
        # Restore whatever the fixture installed initially.
        similarity_router.set_similarity_service(original)


def test_embed_endpoint_forwards_image_ids_from_json_body(test_client, recorded_service):
    response = test_client.post(
        "/api/similarity/embed",
        json={"image_ids": [101, 202, 303]},
    )
    assert response.status_code == 200, response.text
    assert recorded_service.calls == [[101, 202, 303]]


def test_embed_endpoint_with_no_body_embeds_all(test_client, recorded_service):
    """Old behaviour without a body must still work - means 'embed everything'."""
    response = test_client.post("/api/similarity/embed")
    assert response.status_code == 200, response.text
    assert recorded_service.calls == [None]


def test_embed_endpoint_with_empty_object_embeds_all(test_client, recorded_service):
    response = test_client.post("/api/similarity/embed", json={})
    assert response.status_code == 200, response.text
    assert recorded_service.calls == [None]


def test_embed_endpoint_with_explicit_null_embeds_all(test_client, recorded_service):
    response = test_client.post(
        "/api/similarity/embed",
        json={"image_ids": None},
    )
    assert response.status_code == 200, response.text
    assert recorded_service.calls == [None]


def test_embed_endpoint_rejects_non_integer_ids(test_client, recorded_service):
    response = test_client.post(
        "/api/similarity/embed",
        json={"image_ids": ["abc", "def"]},
    )
    assert response.status_code in (400, 422), response.text


def test_embed_request_pydantic_model_smoke():
    parsed = EmbedRequest.model_validate({"image_ids": [1, 2, 3]})
    assert parsed.image_ids == [1, 2, 3]
    parsed = EmbedRequest.model_validate({})
    assert parsed.image_ids is None
    parsed = EmbedRequest.model_validate({"image_ids": None})
    assert parsed.image_ids is None


def test_embed_request_rejects_wrong_types():
    with pytest.raises(Exception):  # pydantic.ValidationError
        EmbedRequest.model_validate({"image_ids": "not-a-list"})
