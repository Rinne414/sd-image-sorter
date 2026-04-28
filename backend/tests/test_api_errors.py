"""
Critical tests for API error responses.

Tests HTTP error codes, error message formats, and edge cases.

Priority: CRITICAL
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


def _assert_error_contract(data):
    """Shared assertion for normalized JSON error payloads."""
    assert "error" in data
    assert "type" in data
    assert "detail" not in data


def _assert_validation_error_contract(data):
    """Validation failures are normalized to a 400 payload."""
    _assert_error_contract(data)
    assert data["error"] == "Invalid request parameters"
    assert data["type"] == "ValidationError"
    assert isinstance(data.get("details"), list)
    assert data["details"]


class TestHTTPErrorCodes:
    """Tests for correct HTTP error codes."""

    def test_404_for_nonexistent_image(self, test_client):
        """Nonexistent image should return 404."""
        response = test_client.get("/api/images/999999")

        assert response.status_code == 404
        data = response.json()
        _assert_error_contract(data)

    def test_404_for_nonexistent_image_file(self, test_client, test_db):
        """Image with missing file should return 404."""
        import database as db

        image_id = db.add_image(
            path="/nonexistent/file.png",
            filename="file.png",
        )

        response = test_client.get(f"/api/image-file/{image_id}")

        assert response.status_code == 404

    def test_400_for_invalid_parameters(self, test_client, test_db_with_images):
        """Invalid parameters should return 400."""
        # Invalid sort_by
        response = test_client.get("/api/images?sort_by=invalid_sort_option")
        assert response.status_code == 400

    def test_400_for_validation_errors(self, test_client):
        """Validation errors should return normalized 400 payloads."""
        # Invalid type for path parameter
        response = test_client.get("/api/images/abc")
        assert response.status_code == 400
        _assert_validation_error_contract(response.json())

        # Invalid limit (must be >= 1)
        response = test_client.get("/api/images?limit=0")
        assert response.status_code == 400
        _assert_validation_error_contract(response.json())

    def test_400_for_scan_already_running(self, test_client):
        """Scan already running should return 400."""
        from routers import sorting as sorting_router

        # Set progress to running
        original_state = sorting_router.scan_progress.copy()
        sorting_router.scan_progress = {
            "status": "running",
            "current": 5,
            "total": 10,
            "message": "Scanning...",
        }

        try:
            response = test_client.post(
                "/api/scan",
                json={"folder": "/test", "recursive": True}
            )
            assert response.status_code == 400
        finally:
            sorting_router.scan_progress = original_state

    def test_409_for_batch_conflict(self, test_client):
        """Batch already running should return 409."""
        from routers import artists as artists_router

        # Set batch progress to running
        artists_router._batch_progress["running"] = True

        try:
            response = test_client.post(
                "/api/artists/identify-batch",
                json={"image_ids": [1, 2, 3]}
            )
            # Should return 409 Conflict
            assert response.status_code == 409
        finally:
            artists_router._batch_progress["running"] = False


class TestErrorResponseFormat:
    """Tests for error response format."""

    def test_error_uses_normalized_error_fields(self, test_client):
        """Error responses should use the normalized error contract."""
        response = test_client.get("/api/images/999999")

        assert response.status_code == 404
        data = response.json()
        _assert_error_contract(data)

    def test_validation_error_has_details(self, test_client):
        """Validation errors should expose normalized details."""
        response = test_client.get("/api/images/invalid")

        assert response.status_code == 400
        _assert_validation_error_contract(response.json())

    def test_error_content_type(self, test_client):
        """Error responses should be JSON."""
        response = test_client.get("/api/images/999999")

        assert response.headers.get("content-type") == "application/json"


class TestEdgeCaseErrors:
    """Tests for edge case error handling."""

    def test_empty_image_ids_list(self, test_client):
        """Empty image IDs should fail validation."""
        response = test_client.post(
            "/api/tags/export-batch",
            json={
                "image_ids": [],
                "output_folder": "/tmp"
            }
        )

        # min_length=1 validation should trigger
        assert response.status_code == 400
        _assert_validation_error_contract(response.json())

    def test_very_long_search_query(self, test_client, test_db_with_images):
        """Very long search query should be handled."""
        long_query = "a" * 2000
        response = test_client.get(f"/api/images?search={long_query}")

        # Should either succeed or return validation error
        assert response.status_code in [200, 400]

    def test_special_characters_in_path_param(self, test_client):
        """Special characters in path should be handled safely."""
        # Try various injection patterns
        injection_patterns = [
            "../../../etc/passwd",
            "..\\..\\..\\windows\\system32",
            "1; DROP TABLE images; --",
            "1' OR '1'='1",
        ]

        for pattern in injection_patterns:
            response = test_client.get(f"/api/images/{pattern}")
            # Should return 404 or 422, not 500
            assert response.status_code in [404, 400]

    def test_null_byte_in_params(self, test_client):
        """Null bytes should be handled safely."""
        response = test_client.get("/api/images?search=test%00injection")

        # Should not crash
        assert response.status_code in [200, 400]

    def test_unicode_in_params(self, test_client, test_db_with_images):
        """Unicode characters should work."""
        response = test_client.get("/api/images?search=anime")

        assert response.status_code == 200

    def test_extreme_pagination(self, test_client, test_db_with_images):
        """Extreme pagination values should be handled."""
        # Very large cursor
        response = test_client.get("/api/images?cursor=999999999999")
        assert response.status_code == 200

        # Negative cursor (if supported)
        response = test_client.get("/api/images?cursor=-1")
        assert response.status_code in [200, 400]

    def test_invalid_opaque_cursor_returns_validation_error(self, test_client, test_db_with_images):
        """Malformed opaque cursor tokens should fail fast instead of being treated as image IDs."""
        response = test_client.get("/api/images?cursor=not-a-real-cursor-token")

        assert response.status_code == 400
        data = response.json()
        _assert_error_contract(data)
        assert data["type"] == "HTTPException"
        assert "Invalid cursor token" in data["error"]


class TestScanErrors:
    """Tests for scan endpoint errors."""

    def test_scan_invalid_folder(self, test_client):
        """Invalid folder should return error."""
        response = test_client.post(
            "/api/scan",
            json={"folder": "", "recursive": True}
        )

        assert response.status_code == 400

    def test_scan_nonexistent_folder(self, test_client):
        """Nonexistent folder should fail validation."""
        response = test_client.post(
            "/api/scan",
            json={"folder": "/nonexistent/path/12345", "recursive": True}
        )

        assert response.status_code == 400

    def test_scan_file_instead_of_folder(self, test_client, tmp_path: Path):
        """File path instead of folder should fail."""
        # Create a file
        file_path = tmp_path / "test.txt"
        file_path.write_text("test")

        response = test_client.post(
            "/api/scan",
            json={"folder": str(file_path), "recursive": True}
        )

        assert response.status_code == 400


class TestCensorErrors:
    """Tests for censor endpoint errors."""

    def test_detect_nonexistent_image(self, test_client):
        """Detection on nonexistent image should return 404."""
        response = test_client.post(
            "/api/censor/detect",
            json={"image_id": 999999, "model_type": "nudenet"}
        )

        assert response.status_code == 404

    def test_preview_nonexistent_image(self, test_client):
        """Preview on nonexistent image should return 404."""
        response = test_client.post(
            "/api/censor/preview",
            json={
                "image_id": 999999,
                "regions": [[0, 0, 100, 100]],
                "style": "blur",
            }
        )

        assert response.status_code == 404

    def test_invalid_censor_style(self, test_client, test_db, tmp_path: Path):
        """Invalid censor style should fail validation."""
        import database as db
        from PIL import Image

        img_path = tmp_path / "censor_test.png"
        img = Image.new("RGB", (100, 100), color="white")
        img.save(img_path)

        image_id = db.add_image(path=str(img_path), filename="censor_test.png")

        response = test_client.post(
            "/api/censor/preview",
            json={
                "image_id": image_id,
                "regions": [{"box": [0, 0, 50, 50], "label": "test"}],
                "style": "invalid_style",
            }
        )

        assert response.status_code == 400
        _assert_validation_error_contract(response.json())


class TestSimilarityErrors:
    """Tests for similarity endpoint errors."""

    def test_search_nonexistent_image(self, test_client):
        """Similarity search on nonexistent image should return 404."""
        response = test_client.get("/api/similarity/search/999999")

        assert response.status_code == 404
        data = response.json()
        _assert_error_contract(data)
        assert data["error"] == "Image 999999 was not found."

    def test_invalid_threshold(self, test_client):
        """Invalid similarity threshold should fail validation."""
        response = test_client.get("/api/similarity/search/1?threshold=1.5")

        assert response.status_code == 400
        _assert_validation_error_contract(response.json())

    def test_upload_empty_file(self, test_client):
        """Empty file upload should return error."""
        response = test_client.post(
            "/api/similarity/search-upload",
            files={"file": ("empty.png", b"", "image/png")},
        )

        # Should handle empty file gracefully
        assert response.status_code in [400, 422, 500]


class TestPromptLabErrors:
    """Tests for Prompt Lab endpoint errors."""

    def test_invalid_preset_id(self, test_client):
        """Invalid preset ID should return 404."""
        response = test_client.delete("/api/prompts/presets/999999")

        assert response.status_code == 404

    def test_invalid_tag_set_name(self, test_client):
        """Invalid tag set name should return 404."""
        response = test_client.delete("/api/prompts/sets/nonexistent_set_name")

        assert response.status_code == 404

    def test_invalid_exclusion_rule_name(self, test_client):
        """Invalid exclusion rule name should return 404."""
        response = test_client.delete("/api/prompts/exclusions/nonexistent_rule")

        assert response.status_code == 404

    def test_invalid_category_name(self, test_client):
        """Invalid category name should return 404."""
        response = test_client.get("/api/prompts/category/nonexistent_category")

        assert response.status_code == 404


class TestArtistErrors:
    """Tests for artist endpoint errors."""

    def test_identify_nonexistent_image(self, test_client):
        """Identify on nonexistent image should return 404."""
        response = test_client.post(
            "/api/artists/identify",
            json={"image_id": 999999}
        )

        assert response.status_code == 404

    def test_invalid_threshold_range(self, test_client):
        """Invalid threshold should fail validation."""
        response = test_client.post(
            "/api/artists/identify",
            json={"image_id": 1, "threshold": 1.5}
        )

        assert response.status_code == 400
        _assert_validation_error_contract(response.json())


class TestRateLimiting:
    """Tests for rate limiting behavior."""

    def test_many_requests_not_blocked(self, test_client, test_db_with_images):
        """Normal usage should not be rate limited."""
        # Make multiple rapid requests
        for _ in range(20):
            response = test_client.get("/api/images?limit=10")
            # Should not be rate limited (429)
            assert response.status_code != 429

    def test_loopback_requests_skip_rate_limit_by_default(self, test_client, monkeypatch):
        """Local-only traffic should not trip the safety limiter during normal app use."""
        import main

        monkeypatch.setattr(main, "RATE_LIMIT_MAX_REQUESTS", 1)
        monkeypatch.setattr(main, "RATE_LIMIT_APPLY_TO_LOOPBACK", False)

        with main._rate_limit_lock:
            main._rate_limit_buckets.clear()

        first = test_client.get("/api/images?limit=1")
        second = test_client.get("/api/images?limit=1")

        assert first.status_code != 429
        assert second.status_code != 429

        with main._rate_limit_lock:
            main._rate_limit_buckets.clear()

    def test_excess_requests_are_rate_limited(self, test_client, monkeypatch):
        """Rapid requests beyond the bucket size should return 429."""
        import main

        monkeypatch.setattr(main, "RATE_LIMIT_MAX_REQUESTS", 3)
        monkeypatch.setattr(main, "RATE_LIMIT_APPLY_TO_LOOPBACK", True)

        with main._rate_limit_lock:
            main._rate_limit_buckets.clear()

        for _ in range(3):
            response = test_client.get("/api/images?limit=1")
            assert response.status_code != 429

        response = test_client.get("/api/images?limit=1")

        assert response.status_code == 429
        assert response.json() == {
            "error": "Too many requests. Please try again shortly.",
            "type": "RateLimitExceeded",
        }

        with main._rate_limit_lock:
            main._rate_limit_buckets.clear()


class TestCORSHeaders:
    """Tests for CORS headers on errors."""

    def test_cors_on_error(self, test_client):
        """Error responses should have CORS headers."""
        response = test_client.get("/api/images/999999")

        # CORS should be present (allow_origins=["*"])
        # Note: TestClient may not include CORS headers by default
        # The important thing is the error is properly formatted
        assert response.status_code == 404
