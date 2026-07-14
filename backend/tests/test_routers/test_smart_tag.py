"""Smart Tag router request-contract tests."""

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
