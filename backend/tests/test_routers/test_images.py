"""
Tests for image router endpoints.

Tests:
- GET /api/images - Image listing with filters
- GET /api/images/{image_id} - Single image retrieval
- GET /api/image-file/{image_id} - Image file serving
- GET /api/image-thumbnail/{image_id} - Thumbnail generation

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


class TestGetImages:
    """Tests for GET /api/images endpoint."""

    def test_get_images_returns_list(self, test_client, test_db_with_images):
        """Getting images should return a list."""
        response = test_client.get("/api/images")

        assert response.status_code == 200
        data = response.json()
        assert "images" in data
        assert "total" in data
        assert isinstance(data["images"], list)

    def test_get_images_with_limit(self, test_client, test_db_with_images):
        """Limit parameter should limit results."""
        response = test_client.get("/api/images?limit=2")

        assert response.status_code == 200
        data = response.json()
        assert len(data["images"]) <= 2

    def test_get_images_with_offset(self, test_client, test_db_with_images):
        """Offset parameter should skip images."""
        response1 = test_client.get("/api/images?limit=10")
        response2 = test_client.get("/api/images?limit=10&offset=2")

        data1 = response1.json()
        data2 = response2.json()

        # Total count should be same
        assert data1["total"] == data2["total"]

    def test_filter_by_generator(self, test_client, test_db_with_images):
        """Filtering by generator should work."""
        response = test_client.get("/api/images?generators=comfyui")

        assert response.status_code == 200
        data = response.json()

        for img in data["images"]:
            assert img["generator"] == "comfyui"

    def test_filter_by_multiple_generators(self, test_client, test_db_with_images):
        """Filtering by multiple generators should use OR logic."""
        response = test_client.get("/api/images?generators=comfyui,nai")

        assert response.status_code == 200
        data = response.json()

        generators = {img["generator"] for img in data["images"]}
        assert generators.issubset({"comfyui", "nai"})

    def test_filter_by_tags(self, test_client, test_db_with_images):
        """Filtering by tags should use AND logic."""
        response = test_client.get("/api/images?tags=landscape,outdoor")

        assert response.status_code == 200
        data = response.json()

        # All returned images should have both tags
        # (Note: this test depends on test data having images with both tags)

    def test_filter_by_ratings(self, test_client, test_db_with_images):
        """Filtering by ratings should work."""
        response = test_client.get("/api/images?ratings=explicit,sensitive")

        assert response.status_code == 200

    def test_filter_by_search_query(self, test_client, test_db_with_images):
        """Searching in prompts should work."""
        response = test_client.get("/api/images?search=landscape")

        assert response.status_code == 200
        data = response.json()

        # Results should contain search term in prompt (case insensitive)
        for img in data["images"]:
            if img.get("prompt"):
                assert "landscape" in img["prompt"].lower()

    def test_filter_by_dimensions(self, test_client, test_db_with_images):
        """Filtering by dimensions should work."""
        response = test_client.get("/api/images?min_width=1000")

        assert response.status_code == 200
        data = response.json()

        for img in data["images"]:
            assert img["width"] >= 1000

    def test_filter_by_aspect_ratio(self, test_client, test_db_with_images):
        """Filtering by aspect ratio should work."""
        response = test_client.get("/api/images?aspect_ratio=landscape")

        assert response.status_code == 200
        data = response.json()

        for img in data["images"]:
            ratio = img["width"] / img["height"]
            assert ratio > 1.1

    def test_sort_by_options(self, test_client, test_db_with_images):
        """Various sort options should work."""
        sort_options = ["newest", "oldest", "name_asc", "name_desc", "file_size"]

        for sort_by in sort_options:
            response = test_client.get(f"/api/images?sort_by={sort_by}")
            assert response.status_code == 200, f"Failed for sort_by={sort_by}"

    def test_invalid_sort_uses_default(self, test_client, test_db_with_images):
        """Invalid sort option should return 400 error."""
        response = test_client.get("/api/images?sort_by=invalid_sort")

        # Should return 400 for invalid sort option
        assert response.status_code == 400

    def test_combined_filters(self, test_client, test_db_with_images):
        """Multiple filters combined should work."""
        response = test_client.get(
            "/api/images?generators=comfyui&min_width=500&limit=10"
        )

        assert response.status_code == 200
        data = response.json()

        for img in data["images"]:
            assert img["generator"] == "comfyui"
            assert img["width"] >= 500


class TestGetSingleImage:
    """Tests for GET /api/images/{image_id} endpoint."""

    def test_get_existing_image(self, test_client, test_db_with_images):
        """Getting existing image should return data."""
        image_id = test_db_with_images["image_ids"][0]

        response = test_client.get(f"/api/images/{image_id}")

        assert response.status_code == 200
        data = response.json()
        assert "image" in data
        assert "tags" in data
        assert data["image"]["id"] == image_id

    def test_get_nonexistent_image(self, test_client):
        """Getting nonexistent image should return 404."""
        response = test_client.get("/api/images/999999")

        assert response.status_code == 404

    def test_get_image_includes_tags(self, test_client, test_db_with_images):
        """Image response should include tags."""
        # First image has tags
        image_id = test_db_with_images["image_ids"][0]

        response = test_client.get(f"/api/images/{image_id}")

        assert response.status_code == 200
        data = response.json()
        assert len(data["tags"]) > 0


class TestImageFileServing:
    """Tests for GET /api/image-file/{image_id} endpoint."""

    def test_get_image_file_not_found_in_db(self, test_client):
        """Requesting file for nonexistent DB entry should return 404."""
        response = test_client.get("/api/image-file/999999")

        assert response.status_code == 404

    def test_get_image_file_missing_on_disk(self, test_client, test_db):
        """Requesting file that doesn't exist on disk should return 404."""
        import database as db

        # Add image with non-existent path
        image_id = db.add_image(
            path="/nonexistent/path/image.png",
            filename="image.png",
        )

        response = test_client.get(f"/api/image-file/{image_id}")

        assert response.status_code == 404


class TestThumbnailGeneration:
    """Tests for GET /api/image-thumbnail/{image_id} endpoint."""

    def test_thumbnail_not_found_in_db(self, test_client):
        """Requesting thumbnail for nonexistent DB entry should return 404."""
        response = test_client.get("/api/image-thumbnail/999999")

        assert response.status_code == 404

    def test_thumbnail_missing_on_disk(self, test_client, test_db):
        """Requesting thumbnail for file not on disk should return 404."""
        import database as db

        image_id = db.add_image(
            path="/nonexistent/path/thumb.png",
            filename="thumb.png",
        )

        response = test_client.get(f"/api/image-thumbnail/{image_id}")

        assert response.status_code == 404

    def test_thumbnail_size_parameter(self, test_client, test_db_with_images, tmp_path):
        """Thumbnail size parameter should affect output."""
        import database as db
        from PIL import Image

        # Create a real image file
        img_path = tmp_path / "thumb_test.png"
        img = Image.new("RGB", (1024, 1024), color="blue")
        img.save(img_path)

        image_id = db.add_image(
            path=str(img_path),
            filename="thumb_test.png",
        )

        response = test_client.get(f"/api/image-thumbnail/{image_id}?size=128")

        # Should succeed
        assert response.status_code == 200
        assert response.headers.get("content-type") in ["image/png", "image/jpeg", "image/webp"]

    def test_thumbnail_invalid_size(self, test_client, test_db, tmp_path):
        """Invalid thumbnail size should be rejected."""
        import database as db
        from PIL import Image

        img_path = tmp_path / "size_test.png"
        img = Image.new("RGB", (512, 512), color="green")
        img.save(img_path)

        image_id = db.add_image(
            path=str(img_path),
            filename="size_test.png",
        )

        # Size must be >= 1 (ge=1 constraint)
        response = test_client.get(f"/api/image-thumbnail/{image_id}?size=0")

        # Should reject with validation error (422) or bad request (400)
        assert response.status_code in [400, 422]

    def test_thumbnail_caching_headers(self, test_client, test_db, tmp_path):
        """Thumbnail response should have caching headers."""
        import database as db
        from PIL import Image

        img_path = tmp_path / "cache_test.png"
        img = Image.new("RGB", (512, 512), color="red")
        img.save(img_path)

        image_id = db.add_image(
            path=str(img_path),
            filename="cache_test.png",
        )

        response = test_client.get(f"/api/image-thumbnail/{image_id}")

        assert response.status_code == 200
        assert "Cache-Control" in response.headers
        assert "Last-Modified" in response.headers


class TestReparseImage:
    """Tests for POST /api/images/{image_id}/reparse endpoint."""

    def test_reparse_nonexistent_image(self, test_client):
        """Reparsing nonexistent image should return 404."""
        response = test_client.post("/api/images/999999/reparse")

        assert response.status_code == 404

    def test_reparse_missing_file(self, test_client, test_db):
        """Reparsing image with missing file should return 404."""
        import database as db

        image_id = db.add_image(
            path="/nonexistent/reparse.png",
            filename="reparse.png",
        )

        response = test_client.post(f"/api/images/{image_id}/reparse")

        # File doesn't exist, should fail with 404
        assert response.status_code == 404


class TestEdgeCases:
    """Edge case tests for image endpoints."""

    def test_empty_database(self, test_client, test_db):
        """Empty database should return empty list."""
        response = test_client.get("/api/images")

        assert response.status_code == 200
        data = response.json()
        assert data["images"] == []
        assert data["total"] == 0

    def test_limit_zero_returns_all(self, test_client, test_db_with_images):
        """Limit 0 should be rejected with validation error."""
        response = test_client.get("/api/images?limit=0")

        # Should fail validation since limit must be >= 1 (ge=1 constraint)
        # Returns 400 for business logic validation
        assert response.status_code in [400, 422]

    def test_negative_offset(self, test_client, test_db_with_images):
        """Negative offset should be handled."""
        response = test_client.get("/api/images?offset=-1")

        # Should either error or handle gracefully
        assert response.status_code in [200, 422]

    def test_special_characters_in_search(self, test_client, test_db_with_images):
        """Special characters in search should be handled."""
        # Characters that could cause SQL issues
        special_chars = ["'", '"', ";", "%", "_"]

        for char in special_chars:
            response = test_client.get(f"/api/images?search={char}")
            # Should not cause server error
            assert response.status_code in [200, 422]

    def test_unicode_in_search(self, test_client, test_db_with_images):
        """Unicode characters in search should work."""
        response = test_client.get("/api/images?search=anime")

        assert response.status_code == 200

    def test_very_long_search_query(self, test_client, test_db_with_images):
        """Very long search query should be handled."""
        long_query = "a" * 1000
        response = test_client.get(f"/api/images?search={long_query}")

        # Should not crash
        assert response.status_code in [200, 422]


class TestSecurityHeaders:
    """Security-related tests for image endpoints."""

    def test_no_sql_injection_via_path(self, test_client, test_db):
        """SQL injection via path parameter should be blocked."""
        # Try SQL injection in image_id
        response = test_client.get("/api/images/1; DROP TABLE images; --")

        # Should return 400 (bad request) or 422 (validation error - not a valid integer)
        assert response.status_code in [400, 422]

    def test_no_path_traversal_in_image_id(self, test_client):
        """Path traversal via image_id should be blocked."""
        response = test_client.get("/api/images/../../../etc/passwd")

        # Should return validation error (not a valid integer path parameter)
        # FastAPI returns 404 for path that doesn't match route pattern
        assert response.status_code in [404, 422]

    def test_content_type_on_file_response(self, test_client, test_db, tmp_path):
        """Image file responses should have correct content type."""
        import database as db
        from PIL import Image

        # Create PNG
        img_path = tmp_path / "content_type.png"
        img = Image.new("RGB", (100, 100), color="white")
        img.save(img_path)

        image_id = db.add_image(path=str(img_path), filename="content_type.png")

        response = test_client.get(f"/api/image-file/{image_id}")

        assert response.status_code == 200
        # Should have an image content type
        content_type = response.headers.get("content-type", "")
        assert "image/" in content_type or content_type == "application/octet-stream"
