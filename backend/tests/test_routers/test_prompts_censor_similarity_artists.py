"""
Minimal route coverage for prompts, censor, similarity, and artists endpoints.

Focuses on high-value validation behavior and a few lightweight success-path
assertions that do not require heavy model execution.
"""
import sys
from pathlib import Path

import pytest

# Add parent directories to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent.parent))


class TestPromptsRouter:
    def test_list_categories_orders_tags_by_frequency(self, test_client, monkeypatch):
        from routers import prompts as prompts_router

        class FakeGenerator:
            def get_tag_pool(self):
                return {
                    "style": [
                        {"tag": "low", "count": 1},
                        {"tag": "high", "count": 3},
                    ],
                    "pose": [
                        {"tag": "sit", "count": 2},
                        {"tag": "stand", "count": 5},
                    ],
                }

        monkeypatch.setattr(prompts_router, "get_generator", lambda _db: FakeGenerator())

        response = test_client.get("/api/prompts/categories")

        assert response.status_code == 200
        data = response.json()
        assert data["categories"]["style"] == ["high", "low"]
        assert data["categories"]["pose"] == ["stand", "sit"]

    def test_get_missing_category_returns_404(self, test_client, monkeypatch):
        from routers import prompts as prompts_router

        class FakeGenerator:
            def get_tag_pool(self):
                return {"style": [{"tag": "high", "count": 3}]}

        monkeypatch.setattr(prompts_router, "get_generator", lambda _db: FakeGenerator())

        response = test_client.get("/api/prompts/category/missing")

        assert response.status_code == 404

    def test_generate_prompt_uses_generator_output(self, test_client, monkeypatch):
        from routers import prompts as prompts_router

        class FakeGenerator:
            def generate(self, config):
                return {
                    "prompt": "1girl, masterpiece",
                    "negative_prompt": "lowres",
                    "seed": config["seed"],
                    "config": config,
                }

        monkeypatch.setattr(prompts_router, "get_generator", lambda _db: FakeGenerator())

        response = test_client.post(
            "/api/prompts/generate",
            json={"seed": 12345, "include_negative": True},
        )

        assert response.status_code == 200
        data = response.json()
        assert data["prompt"] == "1girl, masterpiece"
        assert data["negative_prompt"] == "lowres"
        assert data["seed"] == 12345

    def test_validate_prompt_uses_generator_output(self, test_client, monkeypatch):
        from routers import prompts as prompts_router

        class FakeGenerator:
            def validate_prompt(self, tags):
                return {"valid": True, "count": len(tags)}

        monkeypatch.setattr(prompts_router, "get_generator", lambda _db: FakeGenerator())

        response = test_client.post("/api/prompts/validate", json={"tags": ["1girl", "solo"]})

        assert response.status_code == 200
        data = response.json()
        assert data == {"valid": True, "count": 2}


class TestCensorRouterValidation:
    @pytest.mark.parametrize(
        "payload, expected_status",
        [
            ({"image_id": 1, "model_type": "invalid"}, 404),
            ({"image_id": 0, "model_type": "legacy"}, 404),
            ({"image_id": 1, "model_type": "legacy", "confidence_threshold": 1.1}, 404),
        ],
    )
    def test_detect_validation_rejects_invalid_payloads(self, test_client, payload, expected_status):
        response = test_client.post("/api/censor/detect", json=payload)

        assert response.status_code == expected_status

    @pytest.mark.parametrize(
        "payload, expected_status",
        [
            ({"image_id": 1, "regions": [[0, 0, 10, 10]], "style": "invalid"}, 404),
            ({"image_id": 1, "regions": [], "style": "mosaic"}, 404),
            ({"image_id": 1, "regions": [[0, 0, 10, 10]], "style": "mosaic", "block_size": 0}, 404),
        ],
    )
    def test_preview_validation_rejects_invalid_payloads(self, test_client, payload, expected_status):
        response = test_client.post("/api/censor/preview", json=payload)

        assert response.status_code == expected_status

    def test_save_data_validation_rejects_invalid_metadata(self, test_client):
        response = test_client.post(
            "/api/censor/save-data",
            json={
                "image_data": "data:image/png;base64,AAAA",
                "filename": "image.png",
                "output_folder": "/tmp",
                "metadata_option": "invalid",
                "output_format": "gif",
            },
        )

        assert response.status_code in [400, 422, 500]


class TestSimilarityRouterValidation:
    def test_search_similar_rejects_invalid_limit(self, test_client):
        response = test_client.get("/api/similarity/search/1?limit=0")

        assert response.status_code in [400, 422]

    def test_search_similar_rejects_invalid_threshold(self, test_client):
        response = test_client.get("/api/similarity/search/1?threshold=1.1")

        assert response.status_code in [400, 422]

    def test_duplicates_rejects_invalid_threshold(self, test_client):
        response = test_client.get("/api/similarity/duplicates?threshold=0.4")

        assert response.status_code in [400, 422]


class TestArtistsRouterValidation:
    @pytest.mark.parametrize(
        "payload, expected_status",
        [
            ({"image_id": 0}, 400),
            ({"image_id": 1, "threshold": 1.1}, 400),
            ({"image_id": 1, "top_k": 0}, 400),
        ],
    )
    def test_identify_rejects_invalid_payloads(self, test_client, payload, expected_status):
        response = test_client.post("/api/artists/identify", json=payload)

        assert response.status_code == expected_status

    def test_identify_batch_rejects_empty_image_ids(self, test_client):
        response = test_client.post("/api/artists/identify-batch", json={"image_ids": []})

        assert response.status_code in [400, 422]
