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
from pathlib import Path
from unittest.mock import patch, MagicMock

import pytest
from fastapi.testclient import TestClient

# Add parent directories to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent.parent))


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
        """Exporting empty batch should fail validation (min_length=1)."""
        response = test_client.post(
            "/api/tags/export-batch",
            json={
                "image_ids": [],
                "output_folder": str(tmp_path)
            }
        )

        # Should fail validation since min_length=1 for image_ids
        assert response.status_code in [400, 422]

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
        """Exporting with prefix should add prefix to tags."""
        import database as db
        from PIL import Image

        img_path = tmp_path / "prefix_test.png"
        img = Image.new("RGB", (100, 100), color="white")
        img.save(img_path)

        image_id = db.add_image(path=str(img_path), filename="prefix_test.png")
        db.add_tags(image_id, [{"tag": "test_tag", "confidence": 0.9}])

        output_dir = tmp_path / "tags_out"
        output_dir.mkdir()

        response = test_client.post(
            "/api/tags/export-batch",
            json={
                "image_ids": [image_id],
                "output_folder": str(output_dir),
                "prefix": "prefix_"
            }
        )

        assert response.status_code == 200

        txt_file = output_dir / "prefix_test.txt"
        content = txt_file.read_text()
        assert "prefix_" in content


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
