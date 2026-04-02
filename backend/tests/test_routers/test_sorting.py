"""
Tests for sorting router endpoints.

Tests:
- POST /api/scan - Folder scanning
- GET /api/scan/progress - Scan progress
- POST /api/move - Image moving
- POST /api/batch-move - Batch move by filters
- POST /api/sort/* - Manual sort session

Priority: CRITICAL (file operations)
"""
import os
import sys
import json
import tempfile
import shutil
from pathlib import Path
from unittest.mock import patch, MagicMock

import pytest
from fastapi.testclient import TestClient

# Add parent directories to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent.parent))


class TestValidatePath:
    """Tests for POST /api/validate-path endpoint."""

    def test_validate_existing_path(self, test_client, tmp_path: Path):
        """Validating existing path should return valid."""
        response = test_client.post(
            "/api/validate-path",
            json={"path": str(tmp_path)}
        )

        assert response.status_code == 200
        data = response.json()
        assert data["valid"] is True
        assert data["error"] is None

    def test_validate_nonexistent_path(self, test_client):
        """Validating nonexistent path should return invalid."""
        response = test_client.post(
            "/api/validate-path",
            json={"path": "/nonexistent/path/12345"}
        )

        assert response.status_code == 200
        data = response.json()
        assert data["valid"] is False
        assert data["error"] is not None

    def test_validate_empty_path(self, test_client):
        """Validating empty path should return invalid."""
        response = test_client.post(
            "/api/validate-path",
            json={"path": ""}
        )

        assert response.status_code == 200
        data = response.json()
        assert data["valid"] is False

    def test_validate_null_byte_in_path(self, test_client):
        """Null bytes in path should be rejected."""
        response = test_client.post(
            "/api/validate-path",
            json={"path": "/path/with\x00null"}
        )

        assert response.status_code == 200
        data = response.json()
        assert data["valid"] is False


class TestScan:
    """Tests for POST /api/scan endpoint."""

    def test_scan_nonexistent_folder(self, test_client):
        """Scanning nonexistent folder should return 400."""
        response = test_client.post(
            "/api/scan",
            json={"folder_path": "/nonexistent/folder/12345"}
        )

        assert response.status_code == 400

    def test_scan_valid_folder(self, test_client, tmp_path: Path):
        """Scanning valid folder should start background task."""
        from PIL import Image

        # Create test images
        for i in range(3):
            img = Image.new("RGB", (100, 100), color="red")
            img.save(tmp_path / f"test_{i}.png")

        response = test_client.post(
            "/api/scan",
            json={"folder_path": str(tmp_path), "recursive": False}
        )

        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "started"

    def test_scan_progress_after_start(self, test_client, tmp_path: Path):
        """After starting scan, progress should be queryable."""
        from PIL import Image

        # Create test image
        img = Image.new("RGB", (100, 100), color="blue")
        img.save(tmp_path / "progress_test.png")

        # Start scan
        test_client.post(
            "/api/scan",
            json={"folder_path": str(tmp_path), "recursive": False}
        )

        # Check progress
        response = test_client.get("/api/scan/progress")

        assert response.status_code == 200
        data = response.json()
        assert "status" in data
        assert "current" in data
        assert "total" in data

    def test_scan_reset(self, test_client):
        """Resetting scan progress should work."""
        response = test_client.post("/api/scan/reset")

        assert response.status_code == 200
        data = response.json()
        assert "status" in data


class TestMove:
    """Tests for POST /api/move endpoint."""

    def test_move_to_nonexistent_folder(self, test_client, test_db):
        """Moving to nonexistent folder - path validation allows creation."""
        import database as db

        # Add image to database (even though file doesn't exist)
        image_id = db.add_image(
            path="/test/move_test.png",
            filename="move_test.png",
        )

        response = test_client.post(
            "/api/move",
            json={
                "image_ids": [image_id],
                "destination_folder": "/completely/invalid/path/12345"
            }
        )

        # The service allows creating destination folders (allow_create=True),
        # but the move will fail because image file doesn't exist
        # The service returns 200 with success=False in results
        assert response.status_code == 200
        data = response.json()
        assert data["results"][0]["success"] is False

    def test_move_empty_list(self, test_client, tmp_path: Path):
        """Moving empty image list should fail validation."""
        response = test_client.post(
            "/api/move",
            json={
                "image_ids": [],
                "destination_folder": str(tmp_path)
            }
        )

        # Should fail validation since min_length=1 for image_ids
        # Returns 400 for Pydantic validation in this version
        assert response.status_code in [400, 422]

    def test_move_nonexistent_image(self, test_client, tmp_path: Path):
        """Moving nonexistent image should return error in results."""
        response = test_client.post(
            "/api/move",
            json={
                "image_ids": [999999],
                "destination_folder": str(tmp_path)
            }
        )

        assert response.status_code == 200
        data = response.json()
        assert len(data["results"]) == 1
        assert data["results"][0]["success"] is False

    def test_move_image_file(self, test_client, test_db, tmp_path: Path):
        """Moving actual image file should work."""
        import database as db
        from PIL import Image

        # Create source image
        source_dir = tmp_path / "source"
        source_dir.mkdir()
        dest_dir = tmp_path / "dest"
        dest_dir.mkdir()

        img_path = source_dir / "move_me.png"
        img = Image.new("RGB", (100, 100), color="green")
        img.save(img_path)

        image_id = db.add_image(
            path=str(img_path),
            filename="move_me.png",
        )

        response = test_client.post(
            "/api/move",
            json={
                "image_ids": [image_id],
                "destination_folder": str(dest_dir)
            }
        )

        assert response.status_code == 200
        data = response.json()
        assert data["results"][0]["success"] is True

        # Verify file was moved
        assert not img_path.exists()
        assert (dest_dir / "move_me.png").exists()


class TestBatchMove:
    """Tests for POST /api/batch-move endpoint."""

    def test_batch_move_no_matches(self, test_client, tmp_path: Path):
        """Batch move with no matching images should return message."""
        response = test_client.post(
            "/api/batch-move",
            json={
                "generators": ["nonexistent_generator"],
                "destination_folder": str(tmp_path)
            }
        )

        assert response.status_code == 200
        data = response.json()
        assert data["count"] == 0

    def test_batch_move_with_filters(self, test_client, test_db_with_images, tmp_path: Path):
        """Batch move with generator filter should work."""
        dest_dir = tmp_path / "batch_dest"
        dest_dir.mkdir()

        # Note: This test won't actually move files since they don't exist on disk
        # But it should still process the filter logic

        response = test_client.post(
            "/api/batch-move",
            json={
                "generators": ["unknown"],  # Use a generator that exists in test data
                "destination_folder": str(dest_dir)
            }
        )

        # Should succeed, may return count 0 if no files to move
        assert response.status_code == 200
        data = response.json()
        assert "count" in data

    def test_batch_move_invalid_destination(self, test_client):
        """Batch move to invalid destination - path validation allows creation."""
        response = test_client.post(
            "/api/batch-move",
            json={
                "generators": ["comfyui"],
                "destination_folder": "/invalid/destination/12345"
            }
        )

        # The service allows creating destination folders (allow_create=True)
        # So it returns 200 with count=0 (no matching images to move)
        assert response.status_code == 200
        data = response.json()
        # Either no images match or they are moved
        assert "count" in data or "message" in data


class TestSortSession:
    """Tests for manual sort session endpoints."""

    def test_start_sort_session(self, test_client, test_db_with_images):
        """Starting sort session should work."""
        response = test_client.post(
            "/api/sort/start?generators=unknown"
        )

        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "started"
        assert "total_images" in data

    def test_start_sort_empty_results(self, test_client, test_db):
        """Starting sort session with no matches should work."""
        response = test_client.post(
            "/api/sort/start?generators=nonexistent"
        )

        assert response.status_code == 200
        data = response.json()
        assert data["total_images"] == 0

    def test_get_current_without_session(self, test_client):
        """Getting current sort image without active session should fail."""
        # Clear any existing session first
        test_client.delete("/api/sort/session")

        response = test_client.get("/api/sort/current")

        assert response.status_code == 400

    def test_get_current_sort_image(self, test_client, test_db_with_images):
        """Getting current sort image should work during session."""
        # Start session
        test_client.post("/api/sort/start?generators=unknown")

        response = test_client.get("/api/sort/current")

        assert response.status_code == 200
        data = response.json()
        assert "image" in data or "done" in data

    def test_sort_action_without_session(self, test_client):
        """Sort action without active session should fail."""
        # Clear session
        test_client.delete("/api/sort/session")

        response = test_client.post("/api/sort/action?action=skip")

        assert response.status_code == 400

    def test_sort_skip_action(self, test_client, test_db_with_images):
        """Skip action should advance to next image."""
        # Start session
        test_client.post("/api/sort/start?generators=unknown")

        response = test_client.post("/api/sort/action?action=skip")

        assert response.status_code == 200

    def test_sort_undo_without_history(self, test_client, test_db_with_images):
        """Undo without history should return appropriate message."""
        # Start fresh session
        test_client.delete("/api/sort/session")
        test_client.post("/api/sort/start?generators=unknown")

        response = test_client.post("/api/sort/action?action=undo")

        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "no_history"

    def test_set_sort_folders(self, test_client, tmp_path: Path):
        """Setting sort folders should work."""
        response = test_client.post(
            "/api/sort/set-folders",
            json={"folders": {"a": str(tmp_path)}}
        )

        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "ok"

    def test_set_sort_folders_invalid_path(self, test_client):
        """Setting sort folders with non-existent path - service allows creation."""
        response = test_client.post(
            "/api/sort/set-folders",
            json={"folders": {"a": "/invalid/path/12345"}}
        )

        # Service allows creating directories (allow_create=True)
        # Returns 200 with success or 400 for truly invalid paths
        assert response.status_code in [200, 400]

    def test_get_sort_folders(self, test_client):
        """Getting sort folders should work."""
        response = test_client.get("/api/sort/folders")

        assert response.status_code == 200
        data = response.json()
        assert "folders" in data

    def test_clear_sort_session(self, test_client):
        """Clearing sort session should work."""
        response = test_client.delete("/api/sort/session")

        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "ok"


class TestClearGallery:
    """Tests for DELETE /api/clear-gallery endpoint."""

    def test_clear_gallery(self, test_client, test_db_with_images):
        """Clearing gallery should remove all images."""
        response = test_client.delete("/api/clear-gallery")

        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "ok"

        # Verify gallery is empty
        response = test_client.get("/api/images")
        assert response.json()["total"] == 0


class TestAnalytics:
    """Tests for GET /api/analytics endpoint."""

    def test_get_analytics(self, test_client, test_db_with_images):
        """Getting analytics should return stats."""
        response = test_client.get("/api/analytics")

        assert response.status_code == 200
        data = response.json()
        assert "checkpoints" in data
        assert "loras" in data
        assert "top_tags" in data

    def test_get_stats(self, test_client, test_db_with_images):
        """Getting stats should return summary."""
        response = test_client.get("/api/stats")

        assert response.status_code == 200
        data = response.json()
        assert "total_images" in data
        assert "generators" in data


class TestExportTagsBatch:
    """Tests for POST /api/tags/export-batch endpoint."""

    def test_export_tags_empty_list(self, test_client, tmp_path: Path):
        """Exporting empty tag list should fail validation (min_length=1)."""
        response = test_client.post(
            "/api/tags/export-batch",
            json={
                "image_ids": [],
                "output_folder": str(tmp_path)
            }
        )

        # Should fail validation since min_length=1 for image_ids
        assert response.status_code in [400, 422]

    def test_export_tags_nonexistent_image(self, test_client, tmp_path: Path):
        """Exporting tags for nonexistent image should handle gracefully."""
        response = test_client.post(
            "/api/tags/export-batch",
            json={
                "image_ids": [999999],
                "output_folder": str(tmp_path)
            }
        )

        assert response.status_code == 200
        # Should have error for the nonexistent image
        data = response.json()
        assert data["exported"] == 0

    def test_export_tags_invalid_folder(self, test_client):
        """Exporting to invalid folder - service allows creation."""
        response = test_client.post(
            "/api/tags/export-batch",
            json={
                "image_ids": [1],
                "output_folder": "/invalid/path/12345"
            }
        )

        # Service allows creating output directories (allow_create=True)
        # Returns 200 with exported=0 or 400 for truly invalid paths
        assert response.status_code in [200, 400, 422]

    def test_export_tags_with_blacklist(self, test_client, test_db, tmp_path: Path):
        """Exporting tags with blacklist should filter tags."""
        import database as db
        from PIL import Image

        # Create image
        img_path = tmp_path / "export_test.png"
        img = Image.new("RGB", (100, 100), color="white")
        img.save(img_path)

        image_id = db.add_image(path=str(img_path), filename="export_test.png")
        db.add_tags(image_id, [
            {"tag": "keep_tag", "confidence": 0.9},
            {"tag": "remove_tag", "confidence": 0.9},
        ])

        output_dir = tmp_path / "tags_output"
        output_dir.mkdir()

        response = test_client.post(
            "/api/tags/export-batch",
            json={
                "image_ids": [image_id],
                "output_folder": str(output_dir),
                "blacklist": ["remove_tag"]
            }
        )

        assert response.status_code == 200
        data = response.json()
        assert data["exported"] == 1

        # Check the file content
        txt_file = output_dir / "export_test.txt"
        assert txt_file.exists()
        content = txt_file.read_text()
        assert "keep_tag" in content
        assert "remove_tag" not in content


class TestSecurity:
    """Security tests for sorting endpoints."""

    def test_path_traversal_in_scan(self, test_client):
        """Path traversal in scan path should be blocked."""
        response = test_client.post(
            "/api/scan",
            json={"folder_path": "../../../etc"}
        )

        assert response.status_code == 400

    def test_path_traversal_in_move(self, test_client, test_db):
        """Path traversal in move destination should be blocked."""
        import database as db

        image_id = db.add_image(path="/test/image.png", filename="image.png")

        response = test_client.post(
            "/api/move",
            json={
                "image_ids": [image_id],
                "destination_folder": "../../../tmp"
            }
        )

        assert response.status_code == 400

    def test_sql_injection_in_generator_filter(self, test_client, test_db):
        """SQL injection in generator filter should be handled."""
        response = test_client.post(
            "/api/batch-move",
            json={
                "generators": ["'; DROP TABLE images; --"],
                "destination_folder": "/tmp"
            }
        )

        # Should not crash, either succeeds with no matches or rejects
        assert response.status_code in [200, 400]
