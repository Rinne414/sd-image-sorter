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
from datetime import datetime
from unittest.mock import patch, MagicMock

import pytest
from fastapi import BackgroundTasks
from fastapi.testclient import TestClient

# Add parent directories to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent.parent))


def _create_sort_image(tmp_path: Path, filename: str) -> Path:
    from PIL import Image

    image_path = tmp_path / filename
    Image.new("RGB", (64, 64), color="white").save(image_path)
    return image_path


@pytest.fixture
def isolated_sorting_service():
    """Use a fresh sorting service instance so progress state does not leak across tests."""
    from routers.sorting import set_sorting_service
    from services.sorting_service import SortingService

    service = SortingService()
    set_sorting_service(service)
    yield service
    set_sorting_service(SortingService())


class TestRouterCompatibilityState:
    """Tests for legacy router compatibility shims delegating to service-owned state."""

    def test_scan_progress_compat_helpers_delegate_to_service(self, isolated_sorting_service):
        from routers import sorting as sorting_router

        sorting_router.set_scan_progress_state({
            "status": "running",
            "current": 3,
            "total": 9,
            "message": "Scanning...",
        })

        assert isolated_sorting_service.get_scan_progress()["status"] == "running"
        assert sorting_router.scan_progress.copy()["current"] == 3

        sorting_router.scan_progress["message"] = "Compat update"

        assert isolated_sorting_service.get_scan_progress()["message"] == "Compat update"
        assert sorting_router.get_scan_progress_state()["message"] == "Compat update"

    def test_sort_session_compat_helpers_delegate_to_service(self, isolated_sorting_service):
        from routers import sorting as sorting_router

        sorting_router.set_sort_session({
            "active": True,
            "image_ids": [11, 22],
            "current_index": 0,
            "folders": {"a": "/tmp/sorted"},
            "operation_mode": "move",
            "history": [],
            "redo_stack": [],
        })

        assert isolated_sorting_service.get_sort_session()["image_ids"] == [11, 22]
        assert sorting_router.sort_session.copy()["current_index"] == 0

        sorting_router.sort_session["current_index"] = 1

        assert isolated_sorting_service.get_sort_session()["current_index"] == 1
        assert sorting_router.get_sort_session()["current_index"] == 1


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


class TestSystemInfo:
    """Tests for GET /api/system-info endpoint."""

    def test_get_system_info_returns_recommendations_by_model(self, test_client):
        with patch("hardware_monitor.get_system_info", return_value={
            "total_ram_gb": 32,
            "available_ram_gb": 24,
            "gpu_name": "Test GPU",
            "gpu_vram_total_mb": 16384,
            "gpu_vram_available_mb": 12000,
            "torch_cuda_available": True,
            "onnx_providers": ["CUDAExecutionProvider", "CPUExecutionProvider"],
        }), patch("hardware_monitor.recommend_tagger_config", side_effect=lambda system_info, model_name, use_gpu: {
            "model_name": model_name,
            "use_gpu": use_gpu,
            "recommended_batch_size": 4 if use_gpu else 2,
            "recommended_use_gpu": use_gpu,
            "recommended_session_refresh_interval": 180 if use_gpu else 0,
            "risk_level": "low" if use_gpu else "medium",
        }):
            response = test_client.get("/api/system-info")

        assert response.status_code == 200
        data = response.json()
        assert data["system_info"]["gpu_name"] == "Test GPU"
        assert "recommendation" in data
        assert "recommendations_by_model" in data
        assert "wd-swinv2-tagger-v3" in data["recommendations_by_model"]
        assert "custom" in data["recommendations_by_model"]
        assert data["recommendations_by_model"]["custom"]["gpu"]["use_gpu"] is True
        assert data["recommendations_by_model"]["custom"]["cpu"]["use_gpu"] is False


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

    def test_scan_skips_unreadable_images(self, test_client, tmp_path: Path):
        """Unreadable image files should count as errors and not be inserted."""
        import database as db
        from PIL import Image

        valid_path = tmp_path / "valid.png"
        Image.new("RGB", (64, 64), color="green").save(valid_path)
        (tmp_path / "broken.png").write_bytes(b"not-a-real-png")

        response = test_client.post(
            "/api/scan",
            json={"folder_path": str(tmp_path), "recursive": False}
        )

        assert response.status_code == 200

        progress = test_client.get("/api/scan/progress").json()
        assert progress["status"] == "done"
        assert progress["errors"] == 1
        assert progress["new"] == 1
        assert db.get_image_count() == 1

    def test_scan_mixed_root_keeps_good_files_and_reports_corrupt_and_truncated_names(self, test_client, tmp_path: Path):
        """Mixed scan roots should finish, index good files, and name bad files in progress."""
        import database as db
        from PIL import Image
        from PIL.PngImagePlugin import PngInfo

        metadata = PngInfo()
        metadata.add_text(
            "parameters",
            "masterpiece\nNegative prompt: lowres\nSteps: 20, Sampler: Euler a, CFG scale: 7, Seed: 1, Size: 64x64, Model: demo.safetensors",
        )

        good_path = tmp_path / "good.png"
        Image.new("RGB", (64, 64), color="green").save(good_path, pnginfo=metadata)

        truncated_path = tmp_path / "truncated.png"
        Image.new("RGB", (64, 64), color="blue").save(truncated_path, pnginfo=metadata)
        truncated_bytes = truncated_path.read_bytes()
        truncated_path.write_bytes(truncated_bytes[: len(truncated_bytes) // 2])

        corrupt_path = tmp_path / "corrupt.png"
        corrupt_path.write_bytes(b"not-a-real-png")

        response = test_client.post(
            "/api/scan",
            json={"folder_path": str(tmp_path), "recursive": False}
        )

        assert response.status_code == 200

        progress = test_client.get("/api/scan/progress").json()
        assert progress["status"] == "done"
        assert progress["new"] == 1
        assert progress["errors"] == 2
        assert "Bad files:" in progress["message"]
        assert "truncated.png" in progress["message"]
        assert "corrupt.png" in progress["message"]
        assert [entry["filename"] for entry in progress["recent_errors"]] == ["corrupt.png", "truncated.png"]

        images = db.get_images(limit=10)
        assert [image["filename"] for image in images] == ["good.png"]

        sort_response = test_client.post("/api/sort/start")
        assert sort_response.status_code == 200
        assert sort_response.json()["total_images"] == 1

    def test_scan_mixed_root_skips_truncated_and_reports_filenames(self, test_client, tmp_path: Path):
        """Mixed scan roots should keep good files and report corrupt/truncated filenames."""
        import database as db
        from PIL import Image
        from PIL.PngImagePlugin import PngInfo

        good_path = tmp_path / "good.png"
        metadata = PngInfo()
        metadata.add_text(
            "parameters",
            "masterpiece\nNegative prompt: lowres\nSteps: 20, Sampler: Euler, Model: demo-checkpoint",
        )
        Image.new("RGB", (64, 64), color="green").save(good_path, pnginfo=metadata)

        truncated_path = tmp_path / "truncated.png"
        truncated_path.write_bytes(good_path.read_bytes()[:-24])
        (tmp_path / "corrupt.png").write_bytes(b"not-a-real-png")

        response = test_client.post(
            "/api/scan",
            json={"folder_path": str(tmp_path), "recursive": False}
        )

        assert response.status_code == 200

        progress = test_client.get("/api/scan/progress").json()
        assert progress["status"] == "done"
        assert progress["errors"] == 2
        assert progress["new"] == 1
        assert "corrupt.png" in progress["message"]
        assert "truncated.png" in progress["message"]
        assert [img["filename"] for img in db.get_images(limit=20)] == ["good.png"]

    def test_scan_reset(self, test_client):
        """Resetting scan progress should work."""
        response = test_client.post("/api/scan/reset")

        assert response.status_code == 200
        data = response.json()
        assert "status" in data

    def test_scan_cleanup_missing_removes_stale_entries_in_scope(self, test_client, tmp_path: Path):
        """Folder sync should remove indexed rows whose files no longer exist under the scanned scope."""
        import database as db
        from PIL import Image

        valid_path = tmp_path / "valid.png"
        Image.new("RGB", (64, 64), color="green").save(valid_path)
        missing_path = tmp_path / "missing.png"

        db.add_image(
            path=str(valid_path),
            filename=valid_path.name,
            metadata_json="{}",
            width=64,
            height=64,
            file_size=valid_path.stat().st_size,
            created_at=datetime.fromtimestamp(valid_path.stat().st_mtime),
        )
        db.add_image(
            path=str(missing_path),
            filename=missing_path.name,
            metadata_json="{}",
            width=64,
            height=64,
            file_size=123,
            created_at=datetime.now(),
        )

        response = test_client.post(
            "/api/scan",
            json={
                "folder_path": str(tmp_path),
                "recursive": False,
                "cleanup_missing": True,
            }
        )

        assert response.status_code == 200

        progress = test_client.get("/api/scan/progress").json()
        assert progress["status"] == "done"
        assert progress["removed"] == 1
        assert "removed" in progress["message"].lower()
        assert [img["filename"] for img in db.get_images(limit=20, include_unreadable=True)] == ["valid.png"]

    def test_cancel_scan_marks_idle_worker_as_cancelled(self, isolated_sorting_service):
        """Cancel should flip the shared scan state to cancelled when no live worker remains."""
        import threading
        from services.sorting_service import ScanRequest

        bg = BackgroundTasks()
        isolated_sorting_service.start_scan(
            ScanRequest(folder_path=os.getcwd(), recursive=False),
            bg,
        )

        isolated_sorting_service._scan_progress = {
            "status": "running",
            "step": "scanning",
            "current": 3,
            "processed": 3,
            "total": 10,
            "errors": 1,
            "new": 2,
            "updated": 0,
            "message": "Processing files...",
            "current_item": "demo.png",
            "started_at": 1.0,
            "updated_at": 2.0,
        }
        isolated_sorting_service._scan_cancel_event = threading.Event()
        isolated_sorting_service._scan_worker_thread = None

        result = isolated_sorting_service.cancel_scan()
        progress = isolated_sorting_service.get_scan_progress()

        assert result["status"] == "cancelled"
        assert progress["status"] == "cancelled"
        assert progress["current"] == 3
        assert "cancelled" in progress["message"].lower()

    def test_cancel_scan_sets_cancelling_when_worker_is_alive(self, isolated_sorting_service):
        """Cancel should request cooperative stop and leave the run in cancelling until the worker exits."""
        import threading

        class AliveThread:
            def is_alive(self):
                return True

        isolated_sorting_service._scan_progress = {
            "status": "running",
            "step": "scanning",
            "current": 4,
            "processed": 4,
            "total": 12,
            "errors": 0,
            "new": 4,
            "updated": 0,
            "message": "Processing files...",
            "current_item": "demo.png",
            "started_at": 1.0,
            "updated_at": 2.0,
        }
        isolated_sorting_service._scan_cancel_event = threading.Event()
        isolated_sorting_service._scan_worker_thread = AliveThread()

        result = isolated_sorting_service.cancel_scan()
        progress = isolated_sorting_service.get_scan_progress()

        assert result["status"] == "cancelling"
        assert isolated_sorting_service._scan_cancel_event.is_set() is True
        assert progress["status"] == "cancelling"


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

    def test_copy_image_file_keeps_source_and_creates_indexed_copy(self, test_client, test_db, tmp_path: Path):
        """Copy mode should preserve the source file and create a second indexed row."""
        import database as db
        from PIL import Image

        source_dir = tmp_path / "copy_source"
        source_dir.mkdir()
        dest_dir = tmp_path / "copy_dest"
        dest_dir.mkdir()

        img_path = source_dir / "copy_me.png"
        Image.new("RGB", (96, 96), color="purple").save(img_path)

        image_id = db.add_image(
            path=str(img_path),
            filename=img_path.name,
            generator="unknown",
            prompt="copy flow",
            metadata_json="{}",
            created_at=datetime(2024, 1, 2, 3, 4, 5),
        )
        db.add_tags(image_id, [{"tag": "copied_tag", "confidence": 0.91}])
        with db.get_db() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                UPDATE images
                SET tagged_at = ?, ai_caption = ?, aesthetic_score = ?, embedding = ?
                WHERE id = ?
                """,
                ("2024-02-03 04:05:06", "copy caption", 7.25, b"\x01\x02\x03\x04", image_id),
            )
            cursor.execute(
                """
                INSERT INTO artist_predictions (image_id, artist, confidence, top_predictions)
                VALUES (?, ?, ?, ?)
                """,
                (
                    image_id,
                    "artist_copy",
                    0.93,
                    json.dumps([{"artist": "artist_copy", "confidence": 0.93}]),
                ),
            )

        response = test_client.post(
            "/api/move",
            json={
                "image_ids": [image_id],
                "destination_folder": str(dest_dir),
                "operation": "copy",
            }
        )

        assert response.status_code == 200
        payload = response.json()["results"][0]
        assert payload["success"] is True
        assert payload["operation"] == "copy"
        assert img_path.exists()
        copied_path = dest_dir / "copy_me.png"
        assert copied_path.exists()

        original_row = db.get_image_by_id(image_id)
        copied_row = db.get_image_by_id(payload["new_image_id"])
        assert original_row["path"] == str(img_path)
        assert copied_row["path"] == str(copied_path)
        assert copied_row["prompt"] == "copy flow"
        assert copied_row["created_at"] == original_row["created_at"]
        assert copied_row["ai_caption"] == original_row["ai_caption"]
        assert copied_row["aesthetic_score"] == original_row["aesthetic_score"]
        assert {tag["tag"] for tag in db.get_image_tags(copied_row["id"])} == {"copied_tag"}
        with db.get_db() as conn:
            cursor = conn.cursor()
            original_derived = cursor.execute(
                "SELECT tagged_at, embedding FROM images WHERE id = ?",
                (image_id,),
            ).fetchone()
            copied_derived = cursor.execute(
                "SELECT tagged_at, embedding FROM images WHERE id = ?",
                (copied_row["id"],),
            ).fetchone()
            original_artist = cursor.execute(
                "SELECT artist, confidence, top_predictions FROM artist_predictions WHERE image_id = ?",
                (image_id,),
            ).fetchone()
            copied_artist = cursor.execute(
                "SELECT artist, confidence, top_predictions FROM artist_predictions WHERE image_id = ?",
                (copied_row["id"],),
            ).fetchone()
        assert copied_derived["tagged_at"] == original_derived["tagged_at"]
        assert copied_derived["embedding"] == original_derived["embedding"]
        assert copied_artist["artist"] == original_artist["artist"]
        assert copied_artist["confidence"] == pytest.approx(original_artist["confidence"])
        assert copied_artist["top_predictions"] == original_artist["top_predictions"]

    def test_move_rejects_unreadable_image_even_if_file_exists(self, test_client, test_db, tmp_path: Path):
        """A truncated image should not be moved just because the file still exists on disk."""
        import database as db
        from PIL import Image

        source_dir = tmp_path / "source"
        source_dir.mkdir()
        dest_dir = tmp_path / "dest"
        dest_dir.mkdir()

        seed_path = source_dir / "seed.png"
        Image.new("RGB", (64, 64), color="blue").save(seed_path)

        truncated_path = source_dir / "truncated.png"
        truncated_path.write_bytes(seed_path.read_bytes()[:-24])

        image_id = db.add_image(
            path=str(truncated_path),
            filename=truncated_path.name,
            metadata_json="{}",
        )

        response = test_client.post(
            "/api/move",
            json={
                "image_ids": [image_id],
                "destination_folder": str(dest_dir),
            }
        )

        assert response.status_code == 200
        data = response.json()
        assert data["results"][0]["success"] is False
        assert "Truncated" in data["results"][0]["error"]
        assert truncated_path.exists()
        assert not (dest_dir / truncated_path.name).exists()

        row = db.get_image_by_id(image_id)
        assert row["is_readable"] == 0
        assert "Truncated" in (row["read_error"] or "")


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

    def test_batch_move_forwards_search_query(self, test_client, tmp_path: Path):
        """Batch move should forward free-text search to the filtering layer."""
        with patch("services.sorting_service.db.get_filtered_image_count", return_value=0) as mock_count:
            response = test_client.post(
                "/api/batch-move",
                json={
                    "search": "manual_test_autosep_token_20260405",
                    "destination_folder": str(tmp_path)
                }
            )

        assert response.status_code == 200
        kwargs = mock_count.call_args.kwargs
        assert kwargs["search_query"] == "manual_test_autosep_token_20260405"

    def test_batch_move_forwards_artist_filter(self, test_client, tmp_path: Path):
        """Batch move should pass the normalized artist filter into the counting query."""
        with patch("services.sorting_service.db.get_filtered_image_count", return_value=0) as mock_count:
            response = test_client.post(
                "/api/batch-move",
                json={
                    "artist": "  artist_batch_move_20260428  ",
                    "destination_folder": str(tmp_path)
                }
            )

        assert response.status_code == 200
        kwargs = mock_count.call_args.kwargs
        assert kwargs["artist"] == "artist_batch_move_20260428"

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

    def test_batch_move_allows_large_match_counts_when_background_chunking_is_available(self, test_client, tmp_path: Path):
        """Large batch moves should now start and stream through image ID chunks instead of hard-failing at 5000."""
        with patch("services.sorting_service.db.get_filtered_image_count", return_value=5001), \
             patch("services.sorting_service.db.get_filtered_image_ids", return_value=[1, 2, 3]):
            response = test_client.post(
                "/api/batch-move",
                json={
                    "generators": ["unknown"],
                    "destination_folder": str(tmp_path),
                }
            )

        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "started"
        assert data["total"] == 5001

    def test_batch_move_rejects_second_start_while_running(self, test_client, tmp_path: Path, isolated_sorting_service):
        """Starting another batch move while one is already running should fail with 409."""
        isolated_sorting_service._batch_move_progress = {
            "status": "running",
            "current": 1,
            "total": 5,
            "message": "Moving images...",
            "errors": 0,
            "moved": 1,
        }

        response = test_client.post(
            "/api/batch-move",
            json={
                "generators": ["unknown"],
                "destination_folder": str(tmp_path)
            }
        )

        assert response.status_code == 409
        data = response.json()
        assert (data.get("detail") or data.get("error")) == "Batch move already in progress"

    def test_batch_move_reset_does_not_clear_running_job(self, test_client, isolated_sorting_service):
        """Reset should not stomp over a live batch move task."""
        isolated_sorting_service._batch_move_progress = {
            "status": "running",
            "current": 2,
            "total": 7,
            "message": "Moving images...",
            "errors": 1,
            "moved": 1,
        }

        response = test_client.post("/api/batch-move/reset")

        assert response.status_code == 409
        data = response.json()
        assert (data.get("detail") or data.get("error")) == "Cannot reset batch move while it is still running"
        assert isolated_sorting_service.get_batch_move_progress()["status"] == "running"
        assert isolated_sorting_service.get_batch_move_progress()["current"] == 2


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

    def test_start_sort_session_forwards_search_query(self, test_client):
        """Manual sort should pass the free-text search filter into the ID query."""
        with patch("services.sorting_service.db.get_filtered_image_ids", return_value=[]) as mock_ids:
            response = test_client.post(
                "/api/sort/start?search=manual_test_autosep_token_20260405"
            )

        assert response.status_code == 200
        kwargs = mock_ids.call_args.kwargs
        assert kwargs["search_query"] == "manual_test_autosep_token_20260405"

    def test_start_sort_session_forwards_artist_filter(self, test_client):
        """Manual sort should pass the normalized artist filter into the ID query."""
        with patch("services.sorting_service.db.get_filtered_image_ids", return_value=[]) as mock_ids:
            response = test_client.post(
                "/api/sort/start?artist=%20artist_sort_session_20260428%20"
            )

        assert response.status_code == 200
        kwargs = mock_ids.call_args.kwargs
        assert kwargs["artist"] == "artist_sort_session_20260428"

    def test_start_sort_session_rejects_invalid_folders_payload(self, test_client):
        """Bad folders JSON should fail instead of silently becoming an empty config."""
        response = test_client.post(
            "/api/sort/start?folders=%7Bnot-json"
        )

        assert response.status_code == 400
        data = response.json()
        assert (data.get("detail") or data.get("error")) == "Invalid folders payload"

    def test_start_sort_session_rejects_non_object_folders_payload(self, test_client):
        """Folders payload must be a JSON object, not a list or scalar."""
        response = test_client.post(
            "/api/sort/start?folders=%5B%22a%22%5D"
        )

        assert response.status_code == 400
        data = response.json()
        assert (data.get("detail") or data.get("error")) == "Invalid folders payload"

    def test_get_current_without_session(self, test_client):
        """Getting current sort image without active session should return an empty-state payload."""
        # Clear any existing session first
        test_client.delete("/api/sort/session")

        response = test_client.get("/api/sort/current")

        assert response.status_code == 200
        data = response.json()
        assert data["active"] is False
        assert data["done"] is True
        assert data["image"] is None
        assert data["total"] == 0

    def test_get_current_sort_image(self, test_client, test_db_with_images):
        """Getting current sort image should work during session."""
        # Start session
        test_client.post("/api/sort/start?generators=unknown")

        response = test_client.get("/api/sort/current")

        assert response.status_code == 200
        data = response.json()
        assert "image" in data or "done" in data

    def test_get_current_sort_image_reports_history_counts(self, test_client, tmp_path: Path):
        """Current sort payload should expose restored move/skip counts for resumed sessions."""
        db = test_client.test_db
        first_path = _create_sort_image(tmp_path, "resume_skip.png")
        db.add_image(
            path=str(first_path),
            filename="resume_skip.png",
            generator="unknown",
            prompt=None,
            negative_prompt=None,
            checkpoint=None,
            loras=[],
            width=64,
            height=64,
            file_size=first_path.stat().st_size,
            metadata_json="{}",
        )
        second_path = _create_sort_image(tmp_path, "resume_skip_2.png")
        db.add_image(
            path=str(second_path),
            filename="resume_skip_2.png",
            generator="unknown",
            prompt=None,
            negative_prompt=None,
            checkpoint=None,
            loras=[],
            width=64,
            height=64,
            file_size=second_path.stat().st_size,
            metadata_json="{}",
        )

        test_client.delete("/api/sort/session")
        test_client.post("/api/sort/start?generators=unknown")
        test_client.post("/api/sort/action?action=skip")

        response = test_client.get("/api/sort/current")

        assert response.status_code == 200
        data = response.json()
        assert data["sorted_count"] == 0
        assert data["skipped_count"] == 1

    def test_start_sort_session_defers_unreadable_detection_to_lazy_verify(self, test_client, tmp_path: Path):
        """Manual sort should start quickly without bulk-verifying every image.

        The sync start endpoint used to run a full PIL decode on every candidate
        image, which blocked the event loop for minutes on large libraries. We
        now rely on (a) the scan-time ``is_readable`` flag already filtering the
        DB query, and (b) the lazy per-image verification inside
        ``get_current_sort_image`` to skip any stragglers at playback time.
        """
        db = test_client.test_db
        good_path = _create_sort_image(tmp_path, "manual_good.png")
        truncated_source = _create_sort_image(tmp_path, "manual_source.png")
        truncated_path = tmp_path / "manual_bad.png"
        truncated_path.write_bytes(truncated_source.read_bytes()[:-24])

        good_id = db.add_image(
            path=str(good_path),
            filename="manual_good.png",
            generator="unknown",
            width=64,
            height=64,
            file_size=good_path.stat().st_size,
            metadata_json="{}",
        )
        bad_id = db.add_image(
            path=str(truncated_path),
            filename="manual_bad.png",
            generator="unknown",
            width=64,
            height=64,
            file_size=truncated_path.stat().st_size,
            metadata_json="{}",
        )

        response = test_client.post("/api/sort/start?generators=unknown")

        assert response.status_code == 200
        data = response.json()
        assert data["total_images"] == 2
        assert data["skipped_unreadable"] == []
        assert data["current"]["id"] in {good_id, bad_id}

    def test_get_current_sort_image_exposes_resume_metadata(self, test_client, isolated_sorting_service, tmp_path: Path):
        """Resume payload should include stable image id order plus undo/redo availability for the frontend."""
        db = test_client.test_db
        first_path = _create_sort_image(tmp_path, "resume_meta_1.png")
        first_id = db.add_image(
            path=str(first_path),
            filename="resume_meta_1.png",
            generator="unknown",
            prompt=None,
            negative_prompt=None,
            checkpoint=None,
            loras=[],
            width=64,
            height=64,
            file_size=first_path.stat().st_size,
            metadata_json="{}",
        )
        second_path = _create_sort_image(tmp_path, "resume_meta_2.png")
        second_id = db.add_image(
            path=str(second_path),
            filename="resume_meta_2.png",
            generator="unknown",
            prompt=None,
            negative_prompt=None,
            checkpoint=None,
            loras=[],
            width=64,
            height=64,
            file_size=second_path.stat().st_size,
            metadata_json="{}",
        )

        isolated_sorting_service.set_sort_session({
            "active": True,
            "image_ids": [first_id, second_id],
            "current_index": 1,
            "folders": {"a": "/tmp/sorted"},
            "history": [{"action": "skip", "image_id": first_id}],
            "redo_stack": [{"action": "move", "image_id": second_id, "folder_key": "a"}],
        })

        response = test_client.get("/api/sort/current")

        assert response.status_code == 200
        data = response.json()
        assert data["image_ids"] == [first_id, second_id]
        assert data["folders"] == {"a": "/tmp/sorted"}
        assert data["undo_available"] is True
        assert data["redo_available"] is True

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

    def test_sort_undo_returns_folder_key_for_redo(self, test_client, tmp_path: Path):
        """Undo should return the undone folder key so the frontend can rebuild redo state after resume."""
        from PIL import Image

        image_path = tmp_path / "undo_move.png"
        Image.new("RGB", (64, 64), color="white").save(image_path)
        destination = tmp_path / "sorted"
        destination.mkdir()

        db = test_client.test_db
        image_id = db.add_image(
            path=str(image_path),
            filename="undo_move.png",
            generator="unknown",
            prompt=None,
            negative_prompt=None,
            checkpoint=None,
            loras=[],
            width=64,
            height=64,
            file_size=image_path.stat().st_size,
            metadata_json="{}",
        )

        test_client.delete("/api/sort/session")
        test_client.post("/api/sort/start?generators=unknown")
        test_client.post("/api/sort/set-folders", json={"folders": {"a": str(destination)}})

        move_response = test_client.post("/api/sort/action?action=move&folder_key=a")
        assert move_response.status_code == 200

        undo_response = test_client.post("/api/sort/action?action=undo")

        assert undo_response.status_code == 200
        data = undo_response.json()
        assert data["status"] == "undone"
        assert data["undone_action"] == "move"
        assert data["folder_key"] == "a"
        assert data["sorted_count"] == 0
        assert data["skipped_count"] == 0
        assert data["redo_available"] is True

    def test_sort_copy_undo_and_redo_keep_original_file_intact(self, test_client, tmp_path: Path):
        """Manual sort copy mode should undo by removing the copied file while keeping the source."""
        from PIL import Image

        source_dir = tmp_path / "copy_sort_source"
        source_dir.mkdir()
        destination = tmp_path / "copy_sort_dest"
        destination.mkdir()

        image_path = source_dir / "copy_sort.png"
        Image.new("RGB", (80, 80), color="orange").save(image_path)

        db = test_client.test_db
        db.add_image(
            path=str(image_path),
            filename=image_path.name,
            generator="unknown",
            prompt="copy me",
            metadata_json="{}",
        )

        test_client.delete("/api/sort/session")
        start_response = test_client.post("/api/sort/start?generators=unknown&operation_mode=copy")
        assert start_response.status_code == 200
        assert start_response.json()["operation_mode"] == "copy"

        test_client.post("/api/sort/set-folders", json={"folders": {"a": str(destination)}})

        copy_response = test_client.post("/api/sort/action?action=move&folder_key=a")
        assert copy_response.status_code == 200
        copy_payload = copy_response.json()
        assert copy_payload["done"] is True
        assert copy_payload["operation_mode"] == "copy"
        assert image_path.exists()
        copied_path = destination / image_path.name
        assert copied_path.exists()
        assert db.get_image_count() == 2

        undo_response = test_client.post("/api/sort/action?action=undo")
        assert undo_response.status_code == 200
        undo_payload = undo_response.json()
        assert undo_payload["status"] == "undone"
        assert undo_payload["operation_mode"] == "copy"
        assert image_path.exists()
        assert not copied_path.exists()
        assert db.get_image_count() == 1

        redo_response = test_client.post("/api/sort/action?action=redo")
        assert redo_response.status_code == 200
        redo_payload = redo_response.json()
        assert redo_payload["status"] == "redone"
        assert redo_payload["operation_mode"] == "copy"
        assert image_path.exists()
        assert copied_path.exists()
        assert db.get_image_count() == 2

    def test_sort_redo_replays_persisted_skip(self, test_client, isolated_sorting_service, tmp_path: Path):
        """Redo should be driven by backend session state so it survives resume/reload."""
        db = test_client.test_db
        first_path = _create_sort_image(tmp_path, "redo_skip_1.png")
        first_id = db.add_image(
            path=str(first_path),
            filename="redo_skip_1.png",
            generator="unknown",
            prompt=None,
            negative_prompt=None,
            checkpoint=None,
            loras=[],
            width=64,
            height=64,
            file_size=first_path.stat().st_size,
            metadata_json="{}",
        )
        second_path = _create_sort_image(tmp_path, "redo_skip_2.png")
        second_id = db.add_image(
            path=str(second_path),
            filename="redo_skip_2.png",
            generator="unknown",
            prompt=None,
            negative_prompt=None,
            checkpoint=None,
            loras=[],
            width=64,
            height=64,
            file_size=second_path.stat().st_size,
            metadata_json="{}",
        )

        isolated_sorting_service.set_sort_session({
            "active": True,
            "image_ids": [first_id, second_id],
            "current_index": 0,
            "folders": {},
            "history": [],
            "redo_stack": [{"action": "skip", "image_id": first_id}],
        })

        response = test_client.post("/api/sort/action?action=redo")

        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "redone"
        assert data["redone_action"] == "skip"
        assert data["image"]["id"] == second_id
        assert data["skipped_count"] == 1
        assert data["undo_available"] is True
        assert data["redo_available"] is False

    def test_load_session_from_disk_rebases_current_index_and_keeps_valid_redo(self, test_client, tmp_path: Path, monkeypatch):
        """Restore should drop missing image ids but keep current_index/history/redo aligned with the surviving order."""
        from services import sorting_service as sorting_module
        from services.sorting_service import SORT_SESSION_SCHEMA_VERSION, SortingService

        db = test_client.test_db
        first_id = db.add_image(
            path="/tmp/restore_rebase_1.png",
            filename="restore_rebase_1.png",
            generator="unknown",
            prompt=None,
            negative_prompt=None,
            checkpoint=None,
            loras=[],
            width=64,
            height=64,
            file_size=1,
            metadata_json="{}",
        )
        second_id = db.add_image(
            path="/tmp/restore_rebase_2.png",
            filename="restore_rebase_2.png",
            generator="unknown",
            prompt=None,
            negative_prompt=None,
            checkpoint=None,
            loras=[],
            width=64,
            height=64,
            file_size=1,
            metadata_json="{}",
        )
        third_id = db.add_image(
            path="/tmp/restore_rebase_3.png",
            filename="restore_rebase_3.png",
            generator="unknown",
            prompt=None,
            negative_prompt=None,
            checkpoint=None,
            loras=[],
            width=64,
            height=64,
            file_size=1,
            metadata_json="{}",
        )

        with db.get_db() as conn:
            cursor = conn.cursor()
            cursor.execute("DELETE FROM images WHERE id = ?", (first_id,))

        session_path = tmp_path / "sort_session.json"
        session_path.write_text(json.dumps({
            "session_schema_version": SORT_SESSION_SCHEMA_VERSION,
            "active": True,
            "image_ids": [first_id, second_id, third_id],
            "current_index": 2,
            "folders": {"a": "/tmp/sorted"},
            "history": [
                {"action": "skip", "image_id": first_id},
                {"action": "move", "image_id": second_id, "folder_key": "a", "original_path": "/tmp/original.png", "new_path": "/tmp/new.png"},
            ],
            "redo_stack": [
                {"action": "skip", "image_id": third_id},
            ],
        }), encoding="utf-8")

        monkeypatch.setattr(sorting_module, "SESSION_FILE", str(session_path))
        service = SortingService()

        service.load_session_from_disk()
        restored = service.get_sort_session()

        assert restored["image_ids"] == [second_id, third_id]
        assert restored["current_index"] == 1
        assert [entry["image_id"] for entry in restored["history"]] == [second_id]
        assert [entry["image_id"] for entry in restored["redo_stack"]] == [third_id]

        persisted = json.loads(session_path.read_text(encoding="utf-8"))
        assert persisted["session_schema_version"] == SORT_SESSION_SCHEMA_VERSION
        assert persisted["current_index"] == 1
        assert persisted["image_ids"] == [second_id, third_id]

    def test_load_session_from_disk_discards_history_past_restored_cursor(self, test_client, tmp_path: Path, monkeypatch):
        """Corrupt persisted history should not be allowed to push the restored cursor past the saved current index."""
        from services import sorting_service as sorting_module
        from services.sorting_service import SORT_SESSION_SCHEMA_VERSION, SortingService

        db = test_client.test_db
        first_id = db.add_image(
            path="/tmp/restore_cursor_1.png",
            filename="restore_cursor_1.png",
            generator="unknown",
            prompt=None,
            negative_prompt=None,
            checkpoint=None,
            loras=[],
            width=64,
            height=64,
            file_size=1,
            metadata_json="{}",
        )
        second_id = db.add_image(
            path="/tmp/restore_cursor_2.png",
            filename="restore_cursor_2.png",
            generator="unknown",
            prompt=None,
            negative_prompt=None,
            checkpoint=None,
            loras=[],
            width=64,
            height=64,
            file_size=1,
            metadata_json="{}",
        )

        session_path = tmp_path / "sort_session_cursor.json"
        session_path.write_text(json.dumps({
            "active": True,
            "image_ids": [first_id, second_id],
            "current_index": 1,
            "folders": {},
            "history": [
                {"action": "skip", "image_id": first_id},
                {"action": "skip", "image_id": second_id},
            ],
            "redo_stack": [],
        }), encoding="utf-8")

        monkeypatch.setattr(sorting_module, "SESSION_FILE", str(session_path))
        service = SortingService()

        service.load_session_from_disk()
        restored = service.get_sort_session()
        persisted = json.loads(session_path.read_text(encoding="utf-8"))

        assert restored["current_index"] == 1
        assert [entry["image_id"] for entry in restored["history"]] == [first_id]
        assert persisted["session_schema_version"] == SORT_SESSION_SCHEMA_VERSION

    def test_load_session_from_disk_discards_unknown_newer_schema_version(self, test_client, tmp_path: Path, monkeypatch):
        """A persisted session from a newer schema version should be discarded instead of half-restored."""
        from services import sorting_service as sorting_module
        from services.sorting_service import SORT_SESSION_SCHEMA_VERSION, SortingService

        image_id = test_client.test_db.add_image(
            path="/tmp/restore_future_version.png",
            filename="restore_future_version.png",
            generator="unknown",
            prompt=None,
            negative_prompt=None,
            checkpoint=None,
            loras=[],
            width=64,
            height=64,
            file_size=1,
            metadata_json="{}",
        )

        session_path = tmp_path / "sort_session_future.json"
        session_path.write_text(json.dumps({
            "session_schema_version": SORT_SESSION_SCHEMA_VERSION + 1,
            "active": True,
            "image_ids": [image_id],
            "current_index": 0,
            "folders": {"a": "/tmp/sorted"},
            "operation_mode": "move",
            "history": [],
            "redo_stack": [],
        }), encoding="utf-8")

        monkeypatch.setattr(sorting_module, "SESSION_FILE", str(session_path))
        service = SortingService()

        service.load_session_from_disk()
        restored = service.get_sort_session()

        assert restored["active"] is False
        assert restored["image_ids"] == []
        assert session_path.exists() is False

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

    def test_get_analytics_groups_checkpoint_variants_by_normalized_name(self, test_client):
        test_client.test_db.add_image(
            path="/tmp/analytics_cp_a.png",
            filename="analytics_cp_a.png",
            checkpoint="ponyXLV6.safetensors [abcd1234]",
            metadata_json="{}",
        )
        test_client.test_db.add_image(
            path="/tmp/analytics_cp_b.png",
            filename="analytics_cp_b.png",
            checkpoint="ponyXLV6.safetensors",
            metadata_json="{}",
        )

        response = test_client.get("/api/analytics")

        assert response.status_code == 200
        data = response.json()
        assert data["checkpoints"][0]["checkpoint"] == "ponyXLV6"
        assert data["checkpoints"][0]["checkpoint_normalized"] == "ponyXLV6"
        assert data["checkpoints"][0]["count"] == 2

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
