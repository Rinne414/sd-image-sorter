"""Tests for POST /api/images/count (Smart Folders v1 live counts).

The endpoint accepts the exact same filter payload as
``/api/images/selection-ids`` and returns ``{"count": int, "exact": bool}``
via the same DB COUNT path the selection-token endpoint already uses.
"""


class TestImagesCountEndpoint:
    def test_count_all_images_with_empty_payload(
        self, test_client, test_db_with_images
    ):
        """An empty filter payload counts the whole library exactly."""
        response = test_client.post("/api/images/count", json={})

        assert response.status_code == 200
        assert response.json() == {
            "count": len(test_db_with_images["image_ids"]),
            "exact": True,
        }

    def test_count_respects_generator_filter(self, test_client, test_db_with_images):
        response = test_client.post(
            "/api/images/count",
            json={
                "generators": ["comfyui"],
            },
        )

        assert response.status_code == 200
        assert response.json() == {"count": 1, "exact": True}

    def test_count_respects_exclude_tags(self, test_client, test_db_with_images):
        """Exclude filters from the gallery contract must reach the COUNT."""
        total = len(test_db_with_images["image_ids"])

        response = test_client.post(
            "/api/images/count",
            json={
                "excludeTags": ["1girl"],
            },
        )

        assert response.status_code == 200
        assert response.json() == {"count": total - 1, "exact": True}

    def test_count_marks_exact_prompt_terms_as_estimate(
        self, test_client, test_db_with_images
    ):
        """Prompt terms in exact mode are post-filtered after SQL: exact=False."""
        response = test_client.post(
            "/api/images/count",
            json={
                "prompts": ["landscape"],
                "promptMatchMode": "exact",
            },
        )

        assert response.status_code == 200
        payload = response.json()
        assert payload["count"] == 1
        assert payload["exact"] is False

    def test_count_contains_prompt_terms_stay_exact(
        self, test_client, test_db_with_images
    ):
        response = test_client.post(
            "/api/images/count",
            json={
                "prompts": ["landscape"],
                "promptMatchMode": "contains",
            },
        )

        assert response.status_code == 200
        assert response.json() == {"count": 1, "exact": True}

    def test_count_rejects_invalid_prompt_match_mode(
        self, test_client, test_db_with_images
    ):
        """Validation errors map to 400 with an ``error`` body (app contract)."""
        response = test_client.post(
            "/api/images/count",
            json={
                "promptMatchMode": "fuzzy",
            },
        )

        assert response.status_code == 400
        assert "error" in response.json()

    def test_count_rejects_invalid_sort(self, test_client, test_db_with_images):
        """The shared filter contract still validates sortBy even though a COUNT ignores order."""
        response = test_client.post(
            "/api/images/count",
            json={
                "sortBy": "not-a-real-sort",
            },
        )

        assert response.status_code == 400
        assert "error" in response.json()

    def test_count_treats_empty_aspect_ratio_as_no_filter(
        self, test_client, test_db_with_images
    ):
        """Frontend empty aspect-ratio values must not fail the count (parity with selection-ids)."""
        response = test_client.post(
            "/api/images/count",
            json={
                "aspectRatio": "",
            },
        )

        assert response.status_code == 200
        assert response.json()["count"] == len(test_db_with_images["image_ids"])
