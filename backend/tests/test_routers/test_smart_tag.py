"""Smart Tag router request-contract tests."""

from pathlib import Path

import pytest


def test_start_rejects_unknown_caption_profile_with_normalized_400(test_client) -> None:
    response = test_client.post(
        "/api/smart-tag/start",
        json={
            "image_ids": [],
            "enable_wd14": False,
            "enable_vlm": False,
            "caption_profile": "unsupported_profile",
        },
    )

    assert response.status_code == 400
    payload = response.json()
    assert payload["error"] == "Invalid request parameters"
    assert payload["type"] == "ValidationError"
    field_error = next(
        error for error in payload["details"]
        if error.get("field") == "body.caption_profile"
    )
    assert "krea2_long_nl" in field_error["message"]


@pytest.mark.parametrize(
    ("request_options", "expected_error"),
    [
        (
            {"enable_vlm": False, "natural_language_mode": "vlm"},
            "caption_profile requires enable_vlm=true",
        ),
        (
            {"enable_vlm": True, "natural_language_mode": "toriigate"},
            "caption_profile requires natural_language_mode='vlm'",
        ),
        (
            {"enable_vlm": True, "natural_language_mode": "banana"},
            "caption_profile requires natural_language_mode='vlm'",
        ),
        (
            {"enable_vlm": True, "natural_language_mode": "off"},
            "caption_profile requires natural_language_mode='vlm'",
        ),
    ],
)
def test_start_rejects_caption_profile_without_vlm_mode_with_explicit_400(
    test_client,
    request_options: dict[str, object],
    expected_error: str,
) -> None:
    response = test_client.post(
        "/api/smart-tag/start",
        json={
            "image_ids": [1],
            "enable_wd14": False,
            "caption_profile": "krea2_long_nl",
            **request_options,
        },
    )

    assert response.status_code == 400
    payload = response.json()
    assert payload["type"] == "HTTPException"
    assert expected_error in payload["error"]


def test_results_read_failure_returns_actionable_500(
    monkeypatch,
    test_client,
    tmp_path: Path,
) -> None:
    import routers.smart_tag as smart_tag_router
    from services.smart_tag_service import SmartTagJobState

    missing_path = tmp_path / "missing-smart-tag-results.jsonl"
    job = SmartTagJobState(job_id="missing-results-api", caption_result_count=1)
    job.caption_results_path = str(missing_path)
    monkeypatch.setattr(smart_tag_router, "get_job", lambda _job_id: job)

    response = test_client.get(
        "/api/smart-tag/results",
        params={"job_id": job.job_id, "offset": 0, "limit": 1000},
    )

    assert response.status_code == 500
    payload = response.json()
    assert payload["type"] == "HTTPException"
    assert "job_id='missing-results-api'" in payload["error"]
    assert str(missing_path) in payload["error"]
