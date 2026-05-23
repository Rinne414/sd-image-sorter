"""Regression tests for the BatchMoveRequest "at least one filter" guard.

Background
==========
Real-world bug observed during deep validation: a script that POSTed
``{"destination_folder": "...", "operation": "move", "image_ids": [a, b, c]}``
to ``/api/batch-move`` had its ``image_ids`` silently dropped because
``BatchMoveRequest`` only inherits filter fields from ``SortFilterRequest``
(no ``image_ids``). With every filter field empty, ``get_filtered_image_count``
returned the entire library (71,251 images for the affected user) and the
worker started moving them all to one folder. By the time the run was
cancelled, 634 images had been displaced and had to be rescued by hand.

The fix: ``BatchMoveRequest`` now requires at least one filter to be
specified. Callers that legitimately want "move every image in the library
into one folder" must use ``/api/move`` with an explicit selection_token.
"""
from __future__ import annotations

import pytest
from pydantic import ValidationError

from services.sorting_service import BatchMoveRequest


def test_batch_move_with_no_filters_is_rejected():
    with pytest.raises(ValidationError) as exc_info:
        BatchMoveRequest(destination_folder="L:\\test", operation="move")
    error_text = str(exc_info.value)
    assert "at least one filter" in error_text


def test_batch_move_with_empty_lists_is_rejected():
    """Empty list values must not satisfy the filter requirement."""
    with pytest.raises(ValidationError):
        BatchMoveRequest(
            destination_folder="L:\\test",
            operation="move",
            generators=[],
            tags=[],
            ratings=[],
            checkpoints=[],
            loras=[],
            prompts=[],
        )


def test_batch_move_with_empty_search_string_is_rejected():
    with pytest.raises(ValidationError):
        BatchMoveRequest(
            destination_folder="L:\\test",
            operation="move",
            search="",
            artist="",
        )


@pytest.mark.parametrize(
    "field,value",
    [
        ("generators", ["webui"]),
        ("tags", ["1girl"]),
        ("ratings", ["general"]),
        ("checkpoints", ["sd_xl_base_1.0"]),
        ("loras", ["detail_tweaker"]),
        ("prompts", ["masterpiece"]),
        ("exclude_tags", ["bad_quality"]),
        ("exclude_generators", ["unknown"]),
        ("exclude_ratings", ["explicit"]),
        ("exclude_checkpoints", ["test_model"]),
        ("exclude_loras", ["weird_lora"]),
        ("artist", "kazutake hazano"),
        ("search", "landscape"),
        ("min_width", 1024),
        ("max_width", 2048),
        ("min_height", 1024),
        ("max_height", 2048),
        ("aspect_ratio", "landscape"),
        ("min_aesthetic", 5.0),
        ("max_aesthetic", 9.0),
    ],
)
def test_batch_move_with_any_filter_passes(field, value):
    """Each individual filter must be enough to satisfy the guard."""
    kwargs = {"destination_folder": "L:\\test", "operation": "move", field: value}
    parsed = BatchMoveRequest(**kwargs)
    assert getattr(parsed, field) == value


def test_batch_move_aesthetic_range_alone_passes():
    parsed = BatchMoveRequest(
        destination_folder="L:\\test",
        operation="copy",
        min_aesthetic=4.0,
        max_aesthetic=8.0,
    )
    assert parsed.min_aesthetic == 4.0
    assert parsed.max_aesthetic == 8.0


def test_batch_move_dimension_range_alone_passes():
    parsed = BatchMoveRequest(
        destination_folder="L:\\test",
        operation="move",
        min_width=512,
        max_width=2048,
    )
    assert parsed.min_width == 512


def test_batch_move_endpoint_returns_400_for_empty_filter_set(test_client, test_db_with_images):
    """The HTTP layer should translate the validation error to a 400/422
    so a user-facing message is returned instead of the worker silently
    starting to move the whole library."""
    response = test_client.post(
        "/api/batch-move",
        json={
            "destination_folder": "/tmp/foo",
            "operation": "move",
        },
    )
    assert response.status_code in (400, 422), response.text
    body = response.json()
    payload = body.get("details") or body.get("detail") or body
    assert "filter" in str(payload).lower()
