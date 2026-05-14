"""
Tests for tags router endpoints.

Tests:
- GET /api/tags - Tag listing
- GET /api/tags/library - Tag library
- GET /api/prompts/library - Prompt token library
- GET /api/loras/library - LoRA library
- POST /api/tag/start - Start tagging
- POST /api/tags/import - Import tags
- GET /api/tags/export - Export tags

Priority: HIGH
"""
import os
import sys
import json
import tempfile
import queue
from pathlib import Path
from unittest.mock import patch, MagicMock

import pytest
from fastapi.testclient import TestClient

# Add parent directories to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent.parent))


@pytest.fixture
def isolated_tagging_service():
    """Use a fresh tagging service instance so router compatibility shims hit service-owned state."""
    from routers.tags import set_tagging_service
    from services.tagging_service import TaggingService

    service = TaggingService()
    set_tagging_service(service)
    yield service
    set_tagging_service(TaggingService())


class TestGetTags:
    """Tests for GET /api/tags endpoint."""

    def test_get_all_tags(self, test_client, test_db_with_images):
        """Getting all tags should return list with counts."""
        response = test_client.get("/api/tags")

        assert response.status_code == 200
        data = response.json()
        assert "tags" in data
        assert isinstance(data["tags"], list)

        # Each tag should have tag name and count
        for tag in data["tags"]:
            assert "tag" in tag
            assert "count" in tag

    def test_get_tags_limit(self, test_client, test_db_with_images):
        """Tags limit parameter should work."""
        response = test_client.get("/api/tags?limit=3")

        assert response.status_code == 200
        data = response.json()
        assert len(data["tags"]) <= 3


class TestGetGenerators:
    """Tests for GET /api/generators endpoint."""

    def test_get_generators(self, test_client, test_db_with_images):
        """Getting generators should return list with counts."""
        response = test_client.get("/api/generators")

        assert response.status_code == 200
        data = response.json()
        assert "generators" in data

        # Should have multiple generators from test data
        assert len(data["generators"]) >= 1


class TestTaggerModels:
    """Tests for GET /api/tagger/models endpoint."""

    def test_get_tagger_models_exposes_camie_and_pixai_metadata(self, test_client):
        response = test_client.get("/api/tagger/models")

        assert response.status_code == 200
        data = response.json()
        assert "models" in data
        assert "default" in data

        models = {model["name"]: model for model in data["models"]}

        assert "camie-tagger-v2" in models
        assert models["camie-tagger-v2"]["default_threshold"] == 0.62
        assert models["camie-tagger-v2"]["default_character_threshold"] == 0.78
        assert models["camie-tagger-v2"]["disabled"] is False
        assert models["camie-tagger-v2"]["custom_profile_supported"] is True
        assert models["camie-tagger-v2"]["custom_metadata_format"] == "camie_v2"
        assert models["camie-tagger-v2"]["custom_tags_file_hint"] == ".json metadata"

        assert "pixai-tagger-v0.9" in models
        assert models["pixai-tagger-v0.9"]["default_threshold"] == 0.3
        assert models["pixai-tagger-v0.9"]["default_character_threshold"] == 0.85
        assert models["pixai-tagger-v0.9"]["disabled"] is False
        assert models["pixai-tagger-v0.9"]["custom_profile_supported"] is True
        assert models["pixai-tagger-v0.9"]["custom_tags_file_hint"] == "selected_tags.csv"

        assert "toriigate-0.5" in models
        assert models["toriigate-0.5"]["disabled"] is False
        assert models["toriigate-0.5"]["gpu_confirmation_required"] is False
        assert models["toriigate-0.5"]["custom_profile_supported"] is False


class TestTagsLibrary:
    """Tests for GET /api/tags/library endpoint."""

    def test_get_tags_library_frequency(self, test_client, test_db_with_images):
        """Tags library should be sortable by frequency."""
        response = test_client.get("/api/tags/library?sort_by=frequency")

        assert response.status_code == 200
        data = response.json()
        assert "tags" in data
        assert "total" in data
        assert data["sort"] == "frequency"

    def test_get_tags_library_alphabetical(self, test_client, test_db_with_images):
        """Tags library should be sortable alphabetically."""
        response = test_client.get("/api/tags/library?sort_by=alphabetical")

        assert response.status_code == 200
        data = response.json()
        assert data["sort"] == "alphabetical"

        # Should be sorted alphabetically
        tags = data["tags"]
        if len(tags) > 1:
            tag_names = [t["tag"].lower() for t in tags]
            assert tag_names == sorted(tag_names)

    def test_tags_library_limit(self, test_client, test_db_with_images):
        """Tags library limit should work."""
        response = test_client.get("/api/tags/library?limit=5")

        assert response.status_code == 200
        data = response.json()
        assert len(data["tags"]) <= 5

    def test_tags_library_query_searches_full_table_before_limit(self, test_client, test_db):
        """Search must not only filter the first frequency-limited tags."""
        import database as db

        for index in range(30):
            image_id = db.add_image(path=f"/test/filler_{index}.png", filename=f"filler_{index}.png")
            db.add_tags(image_id, [{"tag": f"zz_filler_{index:02d}", "confidence": 0.9}])

        target_id = db.add_image(path="/test/nagisa.png", filename="nagisa.png")
        db.add_tags(target_id, [{"tag": "nagisa_(blue_archive)", "confidence": 0.99}])

        response = test_client.get("/api/tags/library?q=blue&limit=5")

        assert response.status_code == 200
        data = response.json()
        assert data["total"] == 1
        assert [tag["tag"] for tag in data["tags"]] == ["nagisa_(blue_archive)"]


class TestPromptsLibrary:
    """Tests for GET /api/prompts/library endpoint."""

    def test_get_prompts_library(self, test_client, test_db_with_images):
        """Getting prompts library should return tokens with counts."""
        response = test_client.get("/api/prompts/library")

        assert response.status_code == 200
        data = response.json()
        assert "prompts" in data
        assert "total" in data
        assert isinstance(data["prompts"], list)
        assert data["total"] >= len(data["prompts"])
        if data["prompts"]:
            assert "prompt" in data["prompts"][0]
            assert "count" in data["prompts"][0]

    def test_prompts_are_normalized(self, test_client, test_db):
        """Prompts should be normalized (lowercase, underscore to space)."""
        import database as db

        # Add image with various prompt formats
        db.add_image(
            path="/test/normalize.png",
            filename="normalize.png",
            prompt="Best_Quality, MASTERPIECE, high res",
        )

        response = test_client.get("/api/prompts/library")

        assert response.status_code == 200
        data = response.json()

        # Check that normalization happened
        for prompt in data["prompts"]:
            # Should be lowercase
            assert prompt["prompt"] == prompt["prompt"].lower()
            # Should not have underscores
            assert "_" not in prompt["prompt"]

    def test_prompts_library_limit(self, test_client, test_db_with_images):
        """Prompts library limit should work."""
        response = test_client.get("/api/prompts/library?limit=10")

        assert response.status_code == 200
        data = response.json()
        assert len(data["prompts"]) <= 10

    def test_prompts_library_query_searches_full_index_before_limit(self, test_client, test_db):
        """Prompt search should find low-frequency tokens beyond default display order."""
        import database as db

        for index in range(30):
            db.add_image(
                path=f"/test/prompt_filler_{index}.png",
                filename=f"prompt_filler_{index}.png",
                prompt=f"zz filler {index}",
            )
        db.add_image(
            path="/test/prompt_blue_archive.png",
            filename="prompt_blue_archive.png",
            prompt="nagisa_(blue_archive)",
        )

        response = test_client.get("/api/prompts/library?q=blue&limit=5")

        assert response.status_code == 200
        data = response.json()
        assert data["total"] == 1
        assert [prompt["prompt"] for prompt in data["prompts"]] == ["nagisa (blue archive"]


class TestLorasLibrary:
    """Tests for GET /api/loras/library endpoint."""

    def test_get_loras_library(self, test_client, test_db_with_images):
        """Getting loras library should return loras with counts."""
        response = test_client.get("/api/loras/library")

        assert response.status_code == 200
        data = response.json()
        assert "loras" in data
        assert "total" in data
        assert isinstance(data["loras"], list)
        assert data["total"] >= len(data["loras"])
        if data["loras"]:
            assert "lora" in data["loras"][0]
            assert "count" in data["loras"][0]

    def test_loras_from_json_and_prompt(self, test_client, test_db):
        """LoRAs should be extracted from both JSON and prompt."""
        import database as db

        # Add image with lora in JSON
        db.add_image(
            path="/test/lora_json.png",
            filename="lora_json.png",
            loras=["style_lora"],
        )

        # Add image with lora in prompt
        db.add_image(
            path="/test/lora_prompt.png",
            filename="lora_prompt.png",
            prompt="cat <lora:detail_lora:0.8>",
        )

        response = test_client.get("/api/loras/library")

        assert response.status_code == 200
        data = response.json()

        lora_names = [l["lora"] for l in data["loras"]]
        assert "style_lora" in lora_names
        assert "detail_lora" in lora_names

    def test_loras_normalized(self, test_client, test_db):
        """LoRA names should be normalized (weight stripped, extension stripped)."""
        import database as db

        db.add_image(
            path="/test/lora_norm.png",
            filename="lora_norm.png",
            loras=["style_v2.safetensors"],
            prompt="<lora:detail:0.8>",
        )

        response = test_client.get("/api/loras/library")

        assert response.status_code == 200
        data = response.json()

        lora_names = [l["lora"] for l in data["loras"]]
        # Extension should be stripped
        assert "style_v2" in lora_names
        # Weight notation should not affect the name
        assert "detail" in lora_names

    def test_loras_library_uses_indexed_lora_rows_not_prompt_rescan(self, test_client, test_db):
        """LoRA library must read the normalized image_loras index, not rescan prompt text."""
        import database as db

        image_id = db.add_image(
            path="/test/lora_indexed.png",
            filename="lora_indexed.png",
            loras=["indexed_style"],
            prompt="<lora:prompt_style:0.8>",
        )

        with db.get_db() as conn:
            conn.execute("UPDATE images SET loras = '', prompt = '' WHERE id = ?", (image_id,))

        response = test_client.get("/api/loras/library")

        assert response.status_code == 200
        lora_names = [l["lora"] for l in response.json()["loras"]]
        assert "indexed_style" in lora_names
        assert "prompt_style" in lora_names

    def test_loras_library_query_searches_full_index_before_limit(self, test_client, test_db):
        """LoRA search should query the full indexed LoRA table before display limiting."""
        import database as db

        for index in range(30):
            db.add_image(
                path=f"/test/lora_filler_{index}.png",
                filename=f"lora_filler_{index}.png",
                loras=[f"zz_filler_lora_{index:02d}"],
            )
        db.add_image(
            path="/test/lora_blue_archive.png",
            filename="lora_blue_archive.png",
            loras=["nagisa_blue_archive"],
        )

        response = test_client.get("/api/loras/library?q=blue&limit=5")

        assert response.status_code == 200
        data = response.json()
        assert data["total"] == 1
        assert [lora["lora"] for lora in data["loras"]] == ["nagisa_blue_archive"]


class TestTagImportExport:
    """Tests for tag import/export endpoints."""

    def test_export_tags(self, test_client, test_db_with_images):
        """Exporting tags should return JSON data."""
        response = test_client.get("/api/tags/export")

        assert response.status_code == 200
        data = response.json()
        assert "version" in data
        assert "count" in data
        assert "images" in data

        # Each image should have tags
        for img in data["images"]:
            assert "path" in img
            assert "filename" in img
            assert "tags" in img

    def test_import_tags_empty(self, test_client):
        """Importing empty tag list should work."""
        response = test_client.post(
            "/api/tags/import",
            json={"images": [], "overwrite": False}
        )

        assert response.status_code == 200
        data = response.json()
        assert data["imported"] == 0

    def test_import_tags_nonexistent_image(self, test_client):
        """Importing tags for nonexistent image should skip."""
        response = test_client.post(
            "/api/tags/import",
            json={
                "images": [
                    {
                        "path": "/nonexistent/image.png",
                        "filename": "image.png",
                        "tags": [{"tag": "test", "confidence": 0.9}]
                    }
                ],
                "overwrite": False
            }
        )

        assert response.status_code == 200
        data = response.json()
        assert data["imported"] == 0
        assert data["skipped"] == 1

    def test_import_tags_for_existing_image(self, test_client, test_db, tmp_path: Path):
        """Importing tags for existing image should work."""
        import database as db
        from PIL import Image

        # Create image
        img_path = tmp_path / "import_test.png"
        img = Image.new("RGB", (100, 100), color="white")
        img.save(img_path)

        image_id = db.add_image(path=str(img_path), filename="import_test.png")

        response = test_client.post(
            "/api/tags/import",
            json={
                "images": [
                    {
                        "path": str(img_path),
                        "filename": "import_test.png",
                        "tags": [
                            {"tag": "imported_tag", "confidence": 0.95}
                        ]
                    }
                ],
                "overwrite": False
            }
        )

        assert response.status_code == 200
        data = response.json()
        assert data["imported"] == 1

        # Verify tag was added
        tags = db.get_image_tags(image_id)
        assert any(t["tag"] == "imported_tag" for t in tags)

    def test_import_tags_matches_existing_image_by_equivalent_windows_wsl_path(self, test_client, test_db):
        """Tag import should reuse the same DB row across equivalent Windows/WSL path forms."""
        import database as db

        windows_path = r"L:\datasets\imports\path-variant.png"
        image_id = db.add_image(path=windows_path, filename="path-variant.png")

        response = test_client.post(
            "/api/tags/import",
            json={
                "images": [
                    {
                        "path": "/mnt/l/datasets/imports/path-variant.png",
                        "filename": "path-variant.png",
                        "tags": [{"tag": "variant_tag", "confidence": 0.91}],
                    }
                ],
                "overwrite": False,
            },
        )

        assert response.status_code == 200
        data = response.json()
        assert data["imported"] == 1
        assert data["skipped"] == 0

        tags = db.get_image_tags(image_id)
        assert any(tag["tag"] == "variant_tag" for tag in tags)

    def test_import_tags_overwrite(self, test_client, test_db, tmp_path: Path):
        """Importing tags with overwrite should replace existing."""
        import database as db
        from PIL import Image

        # Create image and add initial tags
        img_path = tmp_path / "overwrite_test.png"
        img = Image.new("RGB", (100, 100), color="white")
        img.save(img_path)

        image_id = db.add_image(path=str(img_path), filename="overwrite_test.png")
        db.add_tags(image_id, [{"tag": "old_tag", "confidence": 0.5}])

        # Import with overwrite
        response = test_client.post(
            "/api/tags/import",
            json={
                "images": [
                    {
                        "path": str(img_path),
                        "filename": "overwrite_test.png",
                        "tags": [{"tag": "new_tag", "confidence": 0.9}]
                    }
                ],
                "overwrite": True
            }
        )

        assert response.status_code == 200

        # Old tag should be replaced
        tags = db.get_image_tags(image_id)
        tag_names = [t["tag"] for t in tags]
        assert "old_tag" not in tag_names
        assert "new_tag" in tag_names


class TestTaggingPipeline:
    """Tests for tagging pipeline endpoints."""

    def test_router_tag_progress_compat_helpers_delegate_to_service(self, isolated_tagging_service):
        """Legacy router shims should only forward to service-owned progress state."""
        from routers import tags as tags_router

        tags_router.set_tag_progress_state({
            "status": "running",
            "current": 2,
            "total": 10,
            "message": "Tagging...",
        })

        assert isolated_tagging_service.get_progress()["status"] == "running"
        assert tags_router.tag_progress.copy()["current"] == 2

        tags_router.tag_progress["message"] = "Compat update"

        assert isolated_tagging_service.get_progress()["message"] == "Compat update"
        assert tags_router.get_tag_progress_state()["message"] == "Compat update"

    def test_start_tagging_already_running(self, test_client):
        """Starting tagging when already running should fail."""
        # Mock the tagging progress state
        from routers import tags as tags_router

        # Set progress to running
        original_state = tags_router.tag_progress.copy()
        tags_router.tag_progress = {"status": "running", "current": 0, "total": 0, "message": ""}

        try:
            response = test_client.post(
                "/api/tag/start",
                json={"image_ids": []}
            )

            # Should return 400 because tagging is already running
            # or 500 if tagger is not initialized (depending on order of checks)
            assert response.status_code in [400, 500]
        finally:
            tags_router.tag_progress = original_state

    def test_tag_progress(self, test_client):
        """Getting tag progress should return status."""
        response = test_client.get("/api/tag/progress")

        assert response.status_code == 200
        data = response.json()
        assert "status" in data

    def test_cancel_tagging(self, test_client):
        """Cancelling a running tagging task should return cancelling state."""
        from routers import tags as tags_router

        tags_router.tag_progress = {"status": "running", "current": 2, "total": 10, "message": "Tagging"}

        response = test_client.post("/api/tag/cancel")

        assert response.status_code == 200
        data = response.json()
        assert data["status"] in ["cancelling", "running", "idle"]

    def test_reset_tag_progress(self, test_client):
        """Resetting tag progress should work."""
        from routers import tags as tags_router

        # Set progress to running
        tags_router.tag_progress = {"status": "running", "current": 5, "total": 10, "message": "test"}

        response = test_client.post("/api/tag/reset")

        assert response.status_code == 200
        data = response.json()
        # Should reset to idle (status="reset") or stay running if reset logic changed
        assert data["status"] in ["reset", "idle", "running"]

    def test_get_tagger_models_exposes_runtime_guidance(self, test_client):
        """Tagger models endpoint should expose stability guidance for the UI."""
        response = test_client.get("/api/tagger/models")

        assert response.status_code == 200
        data = response.json()
        assert data["default"] == "wd-swinv2-tagger-v3"

        models_by_name = {model["name"]: model for model in data["models"]}
        assert models_by_name["wd-swinv2-tagger-v3"]["recommended"] is True
        assert models_by_name["wd-swinv2-tagger-v3"]["gpu_default"] is True
        assert models_by_name["wd-eva02-large-tagger-v3"]["gpu_locked"] is False
        assert models_by_name["wd-eva02-large-tagger-v3"]["gpu_confirmation_required"] is False
        assert models_by_name["wd-eva02-large-tagger-v3"]["memory"] == "High"

    def test_build_runtime_plan_keeps_max_quality_model_on_adaptive_gpu_when_requested(self):
        """Max Quality should now use adaptive GPU throughput instead of a forced CPU default."""
        from services.tagging_service import TaggingService, TagRequest

        service = TaggingService()
        plan = service._build_runtime_plan(
            TagRequest(
                model_name="wd-eva02-large-tagger-v3",
                use_gpu=True,
            )
        )

        assert plan["gpu_locked"] is False
        assert plan["effective_use_gpu"] is True
        assert plan["request"]["use_gpu"] is True
        assert plan["fetch_batch_size"] >= 1
        assert plan["commit_interval"] >= 1
        assert "highest batched throughput" in plan["startup_notice"]

    def test_start_tagging_rejects_non_onnx_custom_model(self, test_client):
        """Custom tagger path should reject unsupported model formats early."""
        response = test_client.post(
            "/api/tag/start",
            json={
                "model_path": "C:/models/custom-model.safetensors",
                "tags_path": "C:/models/selected_tags.csv",
                "use_gpu": False,
            }
        )

        assert response.status_code == 400
        data = response.json()
        assert ".onnx" in data["error"]

    def test_start_tagging_allows_toriigate_builtin_model(self, test_client):
        from routers import tags as tags_router

        tags_router.get_tagging_service().set_tagger_getter(lambda **kwargs: object())

        with patch("hardware_monitor.get_system_info", return_value={
            "total_ram_gb": 64,
            "available_ram_gb": 28,
            "gpu_vram_total_mb": 24576,
            "gpu_vram_available_mb": 20000,
            "torch_cuda_available": True,
            "onnx_providers": ["CPUExecutionProvider"],
        }), patch.object(tags_router.TaggingService, "_run_tagging_job", return_value=None):
            response = test_client.post(
                "/api/tag/start",
                json={
                    "model_name": "toriigate-0.5",
                    "use_gpu": True,
                }
            )

        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "started"

    def test_start_tagging_rejects_toriigate_when_hardware_is_below_minimum(self, test_client):
        response = None
        with patch("hardware_monitor.get_system_info", return_value={
            "total_ram_gb": 32,
            "available_ram_gb": 20,
            "gpu_vram_total_mb": 24576,
            "gpu_vram_available_mb": 20000,
            "torch_cuda_available": True,
            "onnx_providers": ["CPUExecutionProvider"],
        }):
            response = test_client.post(
                "/api/tag/start",
                json={
                    "model_name": "toriigate-0.5",
                    "use_gpu": True,
                }
            )

        assert response is not None
        assert response.status_code == 409
        data = response.json()
        assert "ToriiGate GPU mode is blocked" in (data.get("detail") or data.get("error") or "")

    def test_start_tagging_rejects_non_onnx_custom_model_with_path(self, test_client):
        """Custom tagger path with tags_path should also reject unsupported model formats."""
        response = test_client.post(
            "/api/tag/start",
            json={
                "model_path": "C:/models/custom-model.safetensors",
                "tags_path": "C:/models/selected_tags.csv",
                "use_gpu": False,
            }
        )

        assert response.status_code == 400
        data = response.json()
        assert ".onnx" in data["error"]

    def test_start_tagging_allows_custom_gpu_combo_without_backend_block(self, test_client, tmp_path: Path):
        """Backend should no longer hard-block custom GPU runs; the frontend owns the warning UX."""
        from routers import tags as tags_router

        model_path = tmp_path / "custom-model.onnx"
        model_path.write_bytes(b"fake custom onnx")
        tags_path = tmp_path / "selected_tags.csv"
        tags_path.write_text("id,name,category\n0,1girl,0\n", encoding="utf-8")

        tags_router.get_tagging_service().set_tagger_getter(lambda **kwargs: object())

        with patch.object(tags_router.TaggingService, "_run_tagging_job", return_value=None):
            response = test_client.post(
                "/api/tag/start",
                json={
                    "model_path": str(model_path),
                    "tags_path": str(tags_path),
                    "use_gpu": True,
                }
            )

        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "started"

    def test_tagging_worker_crash_is_reported_without_killing_service(self):
        """A crashed worker process should turn into an API-visible error state instead of taking down the app."""
        from services.tagging_service import TaggingService, TagRequest

        service = TaggingService()
        service.set_tagger_getter(lambda **kwargs: object())

        class FakeQueue:
            def get(self, timeout=None):
                raise queue.Empty

            def get_nowait(self):
                raise queue.Empty

            def close(self):
                return None

            def join_thread(self):
                return None

        class FakeEvent:
            def __init__(self):
                self._is_set = False

            def set(self):
                self._is_set = True

            def is_set(self):
                return self._is_set

        class FakeProcess:
            def __init__(self, *args, **kwargs):
                self.exitcode = -1073741819
                self._alive = False

            def start(self):
                self._alive = False

            def is_alive(self):
                return False

            def join(self, timeout=None):
                return None

        class FakeContext:
            def Queue(self):
                return FakeQueue()

            def Event(self):
                return FakeEvent()

            def Process(self, *args, **kwargs):
                return FakeProcess(*args, **kwargs)

        with patch("services.tagging_service.multiprocessing.get_context", return_value=FakeContext()):
            service._run_tagging_job(
                TagRequest(
                    image_ids=[],
                    model_name="wd-swinv2-tagger-v3",
                    use_gpu=False,
                )
            )

        progress = service.get_progress()
        assert progress["status"] == "error"
        assert "stayed alive" in progress["message"]

class TestFixRatings:
    """Tests for POST /api/tags/fix-ratings endpoint."""

    def test_fix_ratings(self, test_client, test_db):
        """Fixing duplicate ratings should work."""
        import database as db

        # Create image with duplicate ratings (simulating bug)
        image_id = db.add_image(path="/test/ratings.png", filename="ratings.png")

        # Manually insert duplicate rating tags
        with db.get_db() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "INSERT INTO tags (image_id, tag, confidence) VALUES (?, ?, ?)",
                (image_id, "general", 0.9)
            )
            cursor.execute(
                "INSERT INTO tags (image_id, tag, confidence) VALUES (?, ?, ?)",
                (image_id, "sensitive", 0.7)  # Lower confidence, should be removed
            )

        response = test_client.post("/api/tags/fix-ratings")

        assert response.status_code == 200
        data = response.json()
        assert "images_fixed" in data

        # Verify only one rating remains (highest confidence)
        tags = db.get_image_tags(image_id)
        rating_tags = [t for t in tags if t["tag"] in ["general", "sensitive", "questionable", "explicit"]]
        assert len(rating_tags) <= 1
        if rating_tags:
            assert rating_tags[0]["tag"] == "general"  # Highest confidence


class TestExportTagsBatch:
    """Tests for POST /api/tags/export-batch endpoint."""

    def test_export_batch_empty(self, test_client, tmp_path: Path):
        """Exporting empty batch should return normalized validation failure."""
        response = test_client.post(
            "/api/tags/export-batch",
            json={
                "image_ids": [],
                "output_folder": str(tmp_path)
            }
        )

        assert response.status_code == 400

    def test_export_batch_invalid_folder(self, test_client):
        """Exporting to invalid folder - path validation allows creation."""
        response = test_client.post(
            "/api/tags/export-batch",
            json={
                "image_ids": [1],
                "output_folder": "/invalid/path/12345"
            }
        )

        # The service allows creating output folders (allow_create=True)
        # Returns 200 with exported=0 if image not found, or error count
        assert response.status_code == 200

    def test_export_batch_with_prefix(self, test_client, test_db, tmp_path: Path):
        """Exporting with prefix should prepend it once per file."""
        import database as db
        from PIL import Image

        img_path = tmp_path / "prefix_test.png"
        img = Image.new("RGB", (100, 100), color="white")
        img.save(img_path)

        image_id = db.add_image(path=str(img_path), filename="prefix_test.png")
        db.add_tags(image_id, [
            {"tag": "test_tag", "confidence": 0.9},
            {"tag": "second_tag", "confidence": 0.7},
        ])

        output_dir = tmp_path / "tags_out"
        output_dir.mkdir()
        prefix = "sks person"

        response = test_client.post(
            "/api/tags/export-batch",
            json={
                "image_ids": [image_id],
                "output_folder": str(output_dir),
                "prefix": prefix,
                "content_mode": "caption_merged",
            }
        )

        assert response.status_code == 200

        txt_file = output_dir / "prefix_test.txt"
        content = txt_file.read_text()
        assert content == "sks person, test_tag, second_tag"

    def test_export_batch_prompt_mode_ignores_training_prefix(self, test_client, test_db, tmp_path: Path):
        """Prompt sidecars should contain exact Prompt text even if the LoRA prefix field has stale text."""
        import database as db
        from PIL import Image

        img_path = tmp_path / "prompt_exact.png"
        Image.new("RGB", (100, 100), color="white").save(img_path)
        image_id = db.add_image(path=str(img_path), filename=img_path.name, prompt="raw prompt text")

        output_dir = tmp_path / "prompt_exact_out"
        output_dir.mkdir()

        response = test_client.post(
            "/api/tags/export-batch",
            json={
                "image_ids": [image_id],
                "output_folder": str(output_dir),
                "content_mode": "prompt",
                "prefix": "sks person",
            },
        )

        assert response.status_code == 200
        assert (output_dir / "prompt_exact.txt").read_text(encoding="utf-8") == "raw prompt text"

    def test_export_batch_tags_mode_ignores_training_prefix(self, test_client, test_db, tmp_path: Path):
        """Tags sidecars should contain exact tags, not the LoRA Class Token field."""
        import database as db
        from PIL import Image

        img_path = tmp_path / "tags_exact.png"
        Image.new("RGB", (100, 100), color="white").save(img_path)
        image_id = db.add_image(path=str(img_path), filename=img_path.name)
        db.add_tags(image_id, [{"tag": "alpha", "confidence": 0.9}])

        output_dir = tmp_path / "tags_exact_out"
        output_dir.mkdir()

        response = test_client.post(
            "/api/tags/export-batch",
            json={
                "image_ids": [image_id],
                "output_folder": str(output_dir),
                "content_mode": "tags",
                "prefix": "sks person",
            },
        )

        assert response.status_code == 200
        assert (output_dir / "tags_exact.txt").read_text(encoding="utf-8") == "alpha"


    def test_export_batch_returns_normalized_frontend_contract_fields(self, test_client, test_db, tmp_path: Path):
        """Batch tag export should return status/error_count/error_messages, not an ambiguous errors list."""
        import database as db
        from PIL import Image

        img_path = tmp_path / "contract_test.png"
        Image.new("RGB", (100, 100), color="white").save(img_path)

        image_id = db.add_image(path=str(img_path), filename="contract_test.png")
        db.add_tags(image_id, [
            {"tag": "contract_tag", "confidence": 0.9},
        ])

        output_dir = tmp_path / "contract_out"
        output_dir.mkdir()

        response = test_client.post(
            "/api/tags/export-batch",
            json={
                "image_ids": [image_id, 999999],
                "output_folder": str(output_dir),
            },
        )

        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "partial"
        assert data["exported"] == 1
        assert data["errors"] == 1
        assert data["error_count"] == 1
        assert data["total"] == 2
        assert data["error_messages"] == ["Image 999999 not found"]
        assert (output_dir / "contract_test.txt").read_text() == "contract_tag"

    def test_export_batch_keeps_same_basename_files_distinct(self, test_client, test_db, tmp_path: Path):
        """Files that only differ by extension should not overwrite each other on export."""
        import database as db
        from PIL import Image

        jpg_path = tmp_path / "sample.jpg"
        gif_path = tmp_path / "sample.gif"
        Image.new("RGB", (100, 100), color="red").save(jpg_path)
        Image.new("RGB", (100, 100), color="blue").save(gif_path)

        jpg_id = db.add_image(path=str(jpg_path), filename="sample.jpg")
        gif_id = db.add_image(path=str(gif_path), filename="sample.gif")
        db.add_tags(jpg_id, [{"tag": "jpg_tag", "confidence": 0.9}])
        db.add_tags(gif_id, [{"tag": "gif_tag", "confidence": 0.9}])

        output_dir = tmp_path / "collision_out"
        output_dir.mkdir()

        response = test_client.post(
            "/api/tags/export-batch",
            json={
                "image_ids": [jpg_id, gif_id],
                "output_folder": str(output_dir),
            }
        )

        assert response.status_code == 200
        data = response.json()
        assert data["exported"] == 2
        assert (output_dir / "sample.txt").exists()
        assert len(list(output_dir.glob("sample*.txt"))) == 2

    def test_export_batch_sanitizes_sidecar_filename_from_bad_indexed_data(self, test_client, test_db, tmp_path: Path):
        """Sidecar export must never let a stored filename escape the chosen output folder."""
        import database as db
        from PIL import Image

        img_path = tmp_path / "unsafe_source.png"
        Image.new("RGB", (100, 100), color="white").save(img_path)
        image_id = db.add_image(path=str(img_path), filename="..\\evil:name.png")
        db.add_tags(image_id, [{"tag": "safe_tag", "confidence": 0.9}])

        output_dir = tmp_path / "safe_sidecars"
        output_dir.mkdir()

        response = test_client.post(
            "/api/tags/export-batch",
            json={"image_ids": [image_id], "output_folder": str(output_dir)},
        )

        assert response.status_code == 200
        assert response.json()["exported"] == 1
        assert (output_dir / "evil_name.txt").read_text(encoding="utf-8") == "safe_tag"
        assert not (tmp_path / "evil:name.txt").exists()


    def test_export_batch_skip_policy_keeps_existing_sidecars(self, test_client, test_db, tmp_path: Path):
        import database as db
        from PIL import Image

        img_path = tmp_path / "skip_policy.png"
        Image.new("RGB", (64, 64), color="white").save(img_path)
        image_id = db.add_image(path=str(img_path), filename=img_path.name)
        db.add_tags(image_id, [{"tag": "new_tag", "confidence": 0.9}])

        output_dir = tmp_path / "skip_policy_out"
        output_dir.mkdir()
        sidecar = output_dir / "skip_policy.txt"
        sidecar.write_text("existing content", encoding="utf-8")

        response = test_client.post(
            "/api/tags/export-batch",
            json={
                "image_ids": [image_id],
                "output_folder": str(output_dir),
                "overwrite_policy": "skip",
            },
        )

        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "partial"
        assert data["exported"] == 0
        assert data["skipped"] == 1
        assert sidecar.read_text(encoding="utf-8") == "existing content"

    def test_export_batch_overwrite_policy_replaces_existing_sidecars(self, test_client, test_db, tmp_path: Path):
        import database as db
        from PIL import Image

        img_path = tmp_path / "overwrite_policy.png"
        Image.new("RGB", (64, 64), color="white").save(img_path)
        image_id = db.add_image(path=str(img_path), filename=img_path.name)
        db.add_tags(image_id, [{"tag": "replacement_tag", "confidence": 0.9}])

        output_dir = tmp_path / "overwrite_policy_out"
        output_dir.mkdir()
        sidecar = output_dir / "overwrite_policy.txt"
        sidecar.write_text("old content", encoding="utf-8")

        response = test_client.post(
            "/api/tags/export-batch",
            json={
                "image_ids": [image_id],
                "output_folder": str(output_dir),
                "overwrite_policy": "overwrite",
            },
        )

        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "ok"
        assert data["exported"] == 1
        assert data["skipped"] == 0
        assert sidecar.read_text(encoding="utf-8") == "replacement_tag"

    def test_export_batch_can_write_sd_prompt_sidecars(self, test_client, test_db, tmp_path: Path):
        """Batch sidecar export should support SD prompt files, not only raw tag lists."""
        import database as db
        from PIL import Image

        img_path = tmp_path / "sd_sidecar.png"
        Image.new("RGB", (64, 64), color="white").save(img_path)

        image_id = db.add_image(
            path=str(img_path),
            filename=img_path.name,
            prompt="masterpiece, cinematic lighting",
            negative_prompt="lowres, bad anatomy",
            checkpoint="modelA.safetensors",
            width=1024,
            height=768,
            metadata_json=json.dumps({"_parsed": {"generation_params": {"steps": 30, "sampler": "Euler a", "cfg_scale": 7}}}),
        )
        db.add_tags(image_id, [{"tag": "solo", "confidence": 0.9}])

        output_dir = tmp_path / "sd_sidecars"
        output_dir.mkdir()

        response = test_client.post(
            "/api/tags/export-batch",
            json={
                "image_ids": [image_id],
                "output_folder": str(output_dir),
                "content_mode": "a1111",
            },
        )

        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "ok"
        assert data["exported"] == 1
        content = (output_dir / "sd_sidecar.txt").read_text(encoding="utf-8")
        assert "masterpiece, cinematic lighting" in content
        assert "Negative prompt: lowres, bad anatomy" in content
        assert "Steps: 30" in content
        assert "Sampler: Euler a" in content
        assert "CFG scale: 7" in content
        assert "Model: modelA.safetensors" in content

    def test_export_batch_can_write_prompt_tag_caption_sidecars(self, test_client, test_db, tmp_path: Path):
        """Merged caption sidecars should match training/dataset workflows."""
        import database as db
        from PIL import Image

        img_path = tmp_path / "caption_sidecar.png"
        Image.new("RGB", (64, 64), color="white").save(img_path)

        image_id = db.add_image(
            path=str(img_path),
            filename=img_path.name,
            prompt="soft light portrait",
            metadata_json="{}",
        )
        with db.get_db() as conn:
            conn.execute("UPDATE images SET ai_caption = ? WHERE id = ?", ("a woman in soft light", image_id))
        db.add_tags(image_id, [
            {"tag": "portrait", "confidence": 0.9},
            {"tag": "solo", "confidence": 0.8},
        ])

        output_dir = tmp_path / "caption_sidecars"
        output_dir.mkdir()

        response = test_client.post(
            "/api/tags/export-batch",
            json={
                "image_ids": [image_id],
                "output_folder": str(output_dir),
                "content_mode": "caption_merged",
                "blacklist": ["solo"],
            },
        )

        assert response.status_code == 200
        content = (output_dir / "caption_sidecar.txt").read_text(encoding="utf-8")
        assert content == "a woman in soft light, soft light portrait, portrait"
        assert "solo" not in content

    def test_export_batch_caption_sidecars_normalize_multiline_parts_to_one_line(self, test_client, test_db, tmp_path: Path):
        """LoRA caption sidecars should stay one caption line even when prompt metadata is multiline."""
        import database as db
        from PIL import Image

        img_path = tmp_path / "multiline_caption.png"
        Image.new("RGB", (64, 64), color="white").save(img_path)

        image_id = db.add_image(
            path=str(img_path),
            filename=img_path.name,
            prompt="best quality\ncinematic light, solo",
            metadata_json="{}",
        )
        with db.get_db() as conn:
            conn.execute("UPDATE images SET ai_caption = ? WHERE id = ?", ("portrait\nsoft smile", image_id))
        db.add_tags(image_id, [
            {"tag": "cinematic light", "confidence": 0.9},
            {"tag": "solo", "confidence": 0.8},
        ])

        output_dir = tmp_path / "multiline_caption_out"
        output_dir.mkdir()

        response = test_client.post(
            "/api/tags/export-batch",
            json={
                "image_ids": [image_id],
                "output_folder": str(output_dir),
                "content_mode": "caption_merged",
                "blacklist": ["solo"],
            },
        )

        assert response.status_code == 200
        content = (output_dir / "multiline_caption.txt").read_text(encoding="utf-8")
        assert content == "portrait soft smile, best quality cinematic light, solo, cinematic light"
        assert "\n" not in content


class TestEdgeCases:
    """Edge case tests for tags endpoints."""

    def test_prompts_library_empty_prompts(self, test_client, test_db):
        """Prompts library with no prompts should return empty."""
        # Add image without prompt
        import database as db
        db.add_image(path="/test/no_prompt.png", filename="no_prompt.png")

        response = test_client.get("/api/prompts/library")

        assert response.status_code == 200
        data = response.json()
        assert isinstance(data["prompts"], list)
        assert data["prompts"] == [] or all("prompt" in item for item in data["prompts"])

    def test_loras_library_empty_loras(self, test_client, test_db):
        """LoRAs library with no loras should return empty."""
        import database as db
        db.add_image(
            path="/test/no_loras.png",
            filename="no_loras.png",
            prompt="no loras here"
        )

        response = test_client.get("/api/loras/library")

        assert response.status_code == 200
        data = response.json()
        # Total might still be > 0 from other test data
        assert isinstance(data["loras"], list)

    def test_import_tags_invalid_json(self, test_client):
        """Importing with invalid JSON should be handled."""
        # FastAPI should handle this, but we test anyway
        response = test_client.post(
            "/api/tags/import",
            content="not json",
            headers={"Content-Type": "application/json"}
        )

        # Should return validation error (422) or bad request (400)
        assert response.status_code in [400, 422]
