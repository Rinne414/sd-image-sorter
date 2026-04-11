"""
Minimal route coverage for prompts, censor, similarity, and artists endpoints.

Focuses on high-value validation behavior and a few lightweight success-path
assertions that do not require heavy model execution.
"""
import base64
import sys
from pathlib import Path

import pytest

# Add parent directories to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent.parent))


class TestPromptsRouter:
    def test_list_categories_returns_builtin_fallback_when_library_is_empty(self, test_client):
        response = test_client.get("/api/prompts/categories")

        assert response.status_code == 200
        data = response.json()
        assert "categories" in data
        assert data["categories"]["outfit"]
        assert data["categories"]["pose"]
        assert data["categories"]["style"]

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
                assert config["categories"]["style"]["tags"] == ["cinematic_lighting"]
                assert config["categories"]["pose"]["tags"] == ["standing"]
                assert config["tag_sets"] == ["Outfit Combo"]
                assert config["quality_preset"] == "none"
                assert config["count_tag"] == ""
                assert config["include_negative"] is False
                return {
                    "prompt": "1girl, masterpiece",
                    "negative_prompt": "lowres",
                    "seed": config["seed"],
                    "config": config,
                }

        monkeypatch.setattr(prompts_router, "get_generator", lambda _db: FakeGenerator())

        response = test_client.post(
            "/api/prompts/generate",
            json={
                "seed": 12345,
                "include_negative": False,
                "quality_preset": "none",
                "count_tag": "",
                "tag_sets": ["Outfit Combo"],
                "categories": {
                    "style": {"tags": ["cinematic_lighting"], "weight": 1.0, "locked": True},
                    "pose": {"tags": ["standing"], "weight": 0.5, "locked": False},
                },
            },
        )

        assert response.status_code == 200
        data = response.json()
        assert data["prompt"] == "1girl, masterpiece"
        assert data["negative_prompt"] == "lowres"
        assert data["seed"] == 12345
        assert data["config"]["categories"]["style"]["locked"] is True

    def test_validate_prompt_uses_generator_output(self, test_client, monkeypatch):
        from routers import prompts as prompts_router

        class FakeGenerator:
            def validate_prompt(self, tags):
                return {"valid": True, "violations": [], "suggestions": []}

        monkeypatch.setattr(prompts_router, "get_generator", lambda _db: FakeGenerator())

        response = test_client.post("/api/prompts/validate", json={"tags": ["1girl", "solo"]})

        assert response.status_code == 200
        data = response.json()
        assert data == {"valid": True, "violations": [], "suggestions": []}


class TestCensorRouterValidation:
    @pytest.mark.parametrize(
        "payload, expected_status",
        [
            ({"image_id": 1, "model_type": "invalid"}, 400),
            ({"image_id": 0, "model_type": "legacy"}, 400),
            ({"image_id": 1, "model_type": "legacy", "confidence_threshold": 1.1}, 400),
        ],
    )
    def test_detect_validation_rejects_invalid_payloads(self, test_client, payload, expected_status):
        response = test_client.post("/api/censor/detect", json=payload)

        assert response.status_code == expected_status

    @pytest.mark.parametrize(
        "payload, expected_status",
        [
            ({"image_id": 1, "regions": [[0, 0, 10, 10]], "style": "invalid"}, 400),
            ({"image_id": 1, "regions": [], "style": "mosaic"}, 400),
            ({"image_id": 1, "regions": [[0, 0, 10, 10]], "style": "mosaic", "block_size": 0}, 400),
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

        assert response.status_code == 400

    def test_save_data_accepts_minimal_metadata_with_jpg_output(self, test_client, tmp_path):
        from PIL import Image, PngImagePlugin

        source_path = tmp_path / "source.png"
        pnginfo = PngImagePlugin.PngInfo()
        pnginfo.add_text("prompt", "manual metadata test")
        Image.new("RGB", (32, 32), color="blue").save(source_path, pnginfo=pnginfo, dpi=(300, 300))

        image_id = test_client.test_db.add_image(
            path=str(source_path),
            filename="source.png",
            metadata_json="{}",
        )

        output_folder = tmp_path / "out"
        payload_image = base64.b64encode(source_path.read_bytes()).decode("ascii")

        response = test_client.post(
            "/api/censor/save-data",
            json={
                "image_data": f"data:image/png;base64,{payload_image}",
                "filename": "saved-image.png",
                "output_folder": str(output_folder),
                "metadata_option": "minimal",
                "output_format": "jpg",
                "original_image_id": image_id,
            },
        )

        assert response.status_code == 200
        data = response.json()
        assert data["filename"].endswith(".jpg")
        assert (output_folder / data["filename"]).exists()

    def test_detect_legacy_uses_local_default_model_when_path_is_blank(self, test_client, monkeypatch, tmp_path):
        from PIL import Image
        import censor as censor_module
        from services import censor_service as censor_service_module

        image_path = tmp_path / "censor-test.png"
        Image.new("RGB", (64, 64), color="red").save(image_path)
        image_id = test_client.test_db.add_image(
            path=str(image_path),
            filename="censor-test.png",
            metadata_json="{}",
        )

        captured = {}

        class FakeDetector:
            def __init__(self, model_path):
                self.model_path = model_path
                self.session = None

            def load(self):
                self.session = object()
                captured["model_path"] = self.model_path

            def detect(self, _image_path, _threshold):
                return [{"class": "breasts", "confidence": 0.9, "box": [0, 0, 16, 16]}]

        monkeypatch.setattr(censor_service_module, "get_default_legacy_model_path", lambda: str(tmp_path / "wenaka_yolov8s-seg.onnx"))
        monkeypatch.setattr(censor_module, "CensorDetector", FakeDetector)

        response = test_client.post(
            "/api/censor/detect",
            json={"image_id": image_id, "model_type": "legacy", "confidence_threshold": 0.5},
        )

        assert response.status_code == 200
        assert captured["model_path"].endswith("wenaka_yolov8s-seg.onnx")
        assert response.json()["detections"][0]["class"] == "breasts"

    def test_combined_mask_uses_transparent_alpha_png(self):
        from io import BytesIO
        from PIL import Image
        from services.censor_service import CensorService
        import base64

        data_url = CensorService._build_combined_mask_data_url(
            (32, 32),
            [{"class": "breasts", "box": [4, 4, 20, 20], "polygon": [[4, 4], [20, 4], [20, 20], [4, 20]]}],
        )

        assert data_url and data_url.startswith("data:image/png;base64,")
        encoded = data_url.split(",", 1)[1]
        image = Image.open(BytesIO(base64.b64decode(encoded))).convert("RGBA")
        assert image.getpixel((0, 0))[3] == 0
        assert image.getpixel((10, 10))[3] == 255

    def test_combined_mask_can_include_box_only_regions(self):
        from io import BytesIO
        from PIL import Image
        from services.censor_service import CensorService
        import base64

        data_url = CensorService._build_combined_mask_data_url(
            (32, 32),
            [{"class": "anus", "box": [4, 4, 20, 20]}],
            include_boxes=True,
        )

        assert data_url and data_url.startswith("data:image/png;base64,")
        encoded = data_url.split(",", 1)[1]
        image = Image.open(BytesIO(base64.b64decode(encoded))).convert("RGBA")
        assert image.getpixel((0, 0))[3] == 0
        assert image.getpixel((10, 10))[3] == 255

    def test_filter_detections_matches_buttocks_family_aliases(self):
        from services.censor_service import CensorService

        detections = [
            {"class": "buttocks_exposed", "box": [0, 0, 10, 10]},
            {"class": "female_breast_exposed", "box": [0, 0, 10, 10]},
            {"class": "face", "box": [0, 0, 10, 10]},
        ]

        filtered = CensorService._filter_detections_by_targets(detections, ["buttocks", "breasts"])

        classes = [item["class"] for item in filtered]
        assert "buttocks_exposed" in classes
        assert "female_breast_exposed" in classes
        assert "face" not in classes

    def test_detect_filters_target_classes_and_returns_combined_mask(self, test_client, monkeypatch, tmp_path):
        from PIL import Image
        import censor as censor_module
        from services import censor_service as censor_service_module

        image_path = tmp_path / "censor-mask-test.png"
        Image.new("RGB", (80, 80), color="blue").save(image_path)
        image_id = test_client.test_db.add_image(
            path=str(image_path),
            filename="censor-mask-test.png",
            metadata_json="{}",
        )

        class FakeDetector:
            def __init__(self, model_path):
                self.model_path = model_path
                self.session = None

            def load(self):
                self.session = object()

            def detect(self, _image_path, _threshold):
                return [
                    {
                        "class": "breasts",
                        "confidence": 0.92,
                        "box": [0, 0, 24, 24],
                        "polygon": [[0, 0], [24, 0], [24, 24], [0, 24]],
                    },
                    {
                        "class": "anus",
                        "confidence": 0.88,
                        "box": [40, 40, 60, 60],
                    },
                ]

        monkeypatch.setattr(
            censor_service_module,
            "get_default_legacy_model_path",
            lambda: str(tmp_path / "wenaka_yolov8s-seg.onnx"),
        )
        monkeypatch.setattr(censor_module, "CensorDetector", FakeDetector)

        response = test_client.post(
            "/api/censor/detect",
            json={
                "image_id": image_id,
                "model_type": "legacy",
                "confidence_threshold": 0.5,
                "target_classes": ["anus"],
            },
        )

        assert response.status_code == 200
        data = response.json()
        assert [d["class"] for d in data["detections"]] == ["anus"]
        assert data["geometry_mode"] == "box"
        assert data["combined_mask"].startswith("data:image/png;base64,")

    def test_censor_models_returns_recommended_backend(self, test_client):
        response = test_client.get("/api/censor/models")

        assert response.status_code == 200
        data = response.json()
        assert "models" in data
        assert "recommended_backend" in data


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

    def test_search_similar_returns_404_for_missing_image(self, test_client):
        response = test_client.get("/api/similarity/search/999999")

        assert response.status_code == 404
        assert response.json()["error"] == "Image 999999 was not found."

    def test_search_similar_requires_embedding_for_existing_image(self, test_client):
        image_id = test_client.test_db.add_image(
            path="/tmp/no_embedding.png",
            filename="no_embedding.png",
            metadata_json="{}",
        )

        response = test_client.get(f"/api/similarity/search/{image_id}")

        assert response.status_code == 409
        assert "has no embedding yet" in response.json()["error"]

    def test_search_upload_rejects_invalid_image_content(self, test_client):
        response = test_client.post(
            "/api/similarity/search-upload",
            files={"file": ("not-image.txt", b"definitely not an image", "text/plain")},
        )

        assert response.status_code == 400
        assert response.json()["error"] == "Invalid image file. Upload a readable PNG, JPG, or WebP image."

    def test_duplicates_report_insufficient_embeddings_instead_of_fake_empty(self, test_client):
        response = test_client.get("/api/similarity/duplicates?threshold=0.95")

        assert response.status_code == 200
        data = response.json()
        assert data["duplicates"] == []
        assert data["count"] == 0
        assert data["reason"] == "insufficient_embeddings"
        assert data["embedded_count"] == 0
        assert data["minimum_required"] == 2

    def test_model_status_reports_clip_readiness_payload(self, test_client):
        response = test_client.get("/api/similarity/model-status")

        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "ok"
        assert "model_name" in data
        assert "available" in data


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

    def test_identify_batch_rejects_local_model_without_path(self, test_client):
        response = test_client.post(
            "/api/artists/identify-batch",
            json={"image_ids": [1], "model_source": "local"},
        )

        assert response.status_code == 400

    def test_identify_batch_rejects_missing_local_model_file(self, test_client):
        response = test_client.post(
            "/api/artists/identify-batch",
            json={"image_ids": [1], "model_source": "local", "model_path": "C:/missing/artist.onnx"},
        )

        assert response.status_code == 400

    def test_identify_returns_503_when_model_is_unavailable(self, test_client, monkeypatch, tmp_path):
        from routers import artists as artists_router
        from PIL import Image

        image_path = tmp_path / "artist_test.png"
        Image.new("RGB", (64, 64), color="purple").save(image_path)
        image_id = test_client.test_db.add_image(
            path=str(image_path),
            filename="artist_test.png",
            metadata_json="{}",
        )

        class FakeIdentifier:
            def identify(self, _image_path, top_k=5):
                return {"error": "Artist model unavailable. Install the required dependencies and restart the app."}

        monkeypatch.setattr(artists_router, "get_artist_identifier", lambda **kwargs: FakeIdentifier())

        response = test_client.post("/api/artists/identify", json={"image_id": image_id})

        assert response.status_code == 503
        assert "Artist model unavailable" in response.json()["error"]

    def test_identify_uses_low_default_threshold(self, test_client, monkeypatch, tmp_path):
        from artist_identifier import ARTIST_THRESHOLD_DEFAULT
        from routers import artists as artists_router
        from PIL import Image

        image_path = tmp_path / "artist_threshold.png"
        Image.new("RGB", (64, 64), color="orange").save(image_path)
        image_id = test_client.test_db.add_image(
            path=str(image_path),
            filename="artist_threshold.png",
            metadata_json="{}",
        )

        captured = {}

        class FakeIdentifier:
            def identify(self, _image_path, top_k=5):
                return {
                    "artist": "undefined",
                    "confidence": 0.02,
                    "top_predictions": [{"artist": "artist_a", "confidence": 0.02}],
                    "model_loaded": True,
                }

        def fake_get_identifier(**kwargs):
            captured.update(kwargs)
            return FakeIdentifier()

        monkeypatch.setattr(artists_router, "get_artist_identifier", fake_get_identifier)

        response = test_client.post("/api/artists/identify", json={"image_id": image_id})

        assert response.status_code == 200
        assert captured["threshold"] == ARTIST_THRESHOLD_DEFAULT

    def test_identify_batch_passes_model_configuration_to_background_task(self, test_client, monkeypatch, tmp_path):
        from routers import artists as artists_router

        captured = {}
        model_path = tmp_path / "artist.onnx"
        model_path.write_bytes(b"fake-model")

        def fake_run_batch(image_ids, threshold, top_k, model_source, model_path):
            captured["image_ids"] = image_ids
            captured["threshold"] = threshold
            captured["top_k"] = top_k
            captured["model_source"] = model_source
            captured["model_path"] = model_path

        monkeypatch.setattr(artists_router, "_run_batch_identification", fake_run_batch)

        response = test_client.post(
            "/api/artists/identify-batch",
            json={
                "image_ids": [1, 2],
                "threshold": 0.42,
                "top_k": 7,
                "model_source": "local",
                "model_path": str(model_path),
            },
        )

        assert response.status_code == 200
        assert captured == {
            "image_ids": [1, 2],
            "threshold": 0.42,
            "top_k": 7,
            "model_source": "local",
            "model_path": str(model_path.resolve()),
        }

    def test_identify_batch_uses_low_default_threshold(self, test_client, monkeypatch):
        from artist_identifier import ARTIST_THRESHOLD_DEFAULT
        from routers import artists as artists_router

        captured = {}
        artists_router._batch_progress = {
            "running": False,
            "total": 0,
            "processed": 0,
            "errors": 0,
            "results": [],
            "step": "idle",
            "message": "",
            "current_item": None,
            "started_at": None,
            "updated_at": None,
        }

        def fake_run_batch(image_ids, threshold, top_k, model_source, model_path):
            captured["image_ids"] = image_ids
            captured["threshold"] = threshold
            captured["top_k"] = top_k
            captured["model_source"] = model_source
            captured["model_path"] = model_path

        monkeypatch.setattr(artists_router, "_run_batch_identification", fake_run_batch)

        response = test_client.post("/api/artists/identify-batch", json={"image_ids": [1, 2]})

        assert response.status_code == 200
        assert captured["threshold"] == ARTIST_THRESHOLD_DEFAULT
        assert captured["top_k"] == 5
        assert captured["model_source"] == "huggingface"
        assert captured["model_path"] is None

    def test_artist_diagnostics_returns_runtime_payload(self, test_client):
        response = test_client.get("/api/artists/diagnostics")

        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "ok"
        assert "available" in data
        assert "message" in data


class TestPromptGenerator:
    def test_generate_uses_manual_promptlab_categories_without_random_fallbacks(self):
        from prompt_generator import PromptGenerator

        generator = PromptGenerator()
        result = generator.generate(
            {
                "quality_preset": "low",
                "count_tag": "",
                "include_negative": False,
                "categories": {
                    "style": {"tags": ["cinematic_lighting"], "weight": 1.0, "locked": True},
                    "pose": {"tags": ["standing"], "weight": 0.5, "locked": False},
                    "background": {"tags": ["city_night"], "weight": 1.0, "locked": False},
                },
            }
        )

        assert result["positive_prompt"] == "cinematic_lighting, standing, city_night"
        assert result["negative_prompt"] == ""
        assert [tag["tag"] for tag in result["tags_used"]] == [
            "cinematic_lighting",
            "standing",
            "city_night",
        ]

    def test_load_from_db_resets_user_state_and_moves_recategorized_tags(self, test_db):
        from prompt_generator import PromptGenerator

        image_a = test_db.add_image(path="/tmp/a.png", filename="a.png", metadata_json="{}")
        image_b = test_db.add_image(path="/tmp/b.png", filename="b.png", metadata_json="{}")
        test_db.add_tags(image_a, [{"tag": "school_uniform", "confidence": 0.9}])
        test_db.add_tags(image_b, [{"tag": "school_uniform", "confidence": 0.8}])

        with test_db.get_db() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "INSERT INTO tag_categories (tag, category, is_user_defined) VALUES (?, ?, 1)",
                ("school_uniform", "style"),
            )
            cursor.execute(
                "INSERT INTO tag_sets (name, description, category) VALUES (?, ?, ?)",
                ("Uniform Combo", "test set", "outfit"),
            )
            set_id = cursor.lastrowid
            cursor.execute(
                "INSERT INTO tag_set_members (set_id, tag, weight, is_required) VALUES (?, ?, ?, ?)",
                (set_id, "school_uniform", 1.0, 1),
            )
            cursor.execute(
                "INSERT INTO tag_exclusions (rule_name, description) VALUES (?, ?)",
                ("No Uniform Clash", "test rule"),
            )
            rule_id = cursor.lastrowid
            cursor.execute(
                "INSERT INTO tag_exclusion_conditions (exclusion_id, condition_tag, condition_type) VALUES (?, ?, ?)",
                (rule_id, "school_uniform", "present"),
            )
            cursor.execute(
                "INSERT INTO tag_exclusion_targets (exclusion_id, excluded_tag, excluded_category) VALUES (?, ?, ?)",
                (rule_id, "swimsuit", "outfit"),
            )

        generator = PromptGenerator(db_module=test_db)
        generator.load_from_db()
        generator.load_from_db()

        pool = generator.get_tag_pool()
        assert any(tag["tag"] == "school_uniform" for tag in pool.get("style", []))
        assert not any(tag["tag"] == "school_uniform" for tag in pool.get("outfit", []))

        user_sets = [tag_set for tag_set in generator.get_all_tag_sets() if tag_set.get("id") == set_id]
        user_rules = [rule for rule in generator.get_all_rules() if rule.get("id") == rule_id]
        assert len(user_sets) == 1
        assert len(user_rules) == 1

    def test_resolve_tag_sets_supports_stable_ids_and_legacy_indexes(self):
        from prompt_generator import PromptGenerator

        generator = PromptGenerator()
        first_set = generator.get_all_tag_sets()[0]

        resolved = generator._resolve_tag_sets([first_set["id"], "1", first_set["name"]])

        assert resolved == [first_set]
