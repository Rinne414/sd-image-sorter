"""Tests for reconnecting moved/missing image files."""
from pathlib import Path

from PIL import Image


class ImmediateBackgroundTasks:
    def add_task(self, func, *args, **kwargs):
        func(*args, **kwargs)


def _make_image(path: Path, color: str = "white") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (8, 8), color=color).save(path)
    return path


def test_reconnect_missing_file_updates_path_without_touching_file(test_db, tmp_path):
    from services.image_service import ImageService

    old_path = tmp_path / "old" / "kept.png"
    new_path = _make_image(tmp_path / "new" / "kept.png")
    stat = new_path.stat()
    image_id = test_db.add_image(
        path=str(old_path),
        filename="kept.png",
        metadata_json="{}",
        file_size=stat.st_size,
        source_size=stat.st_size,
        source_mtime_ns=stat.st_mtime_ns,
        is_readable=False,
        read_error="File not found",
        metadata_status="error",
    )

    service = ImageService()
    result = service.reconnect_missing_files_once(
        str(new_path.parent),
        recursive=True,
        verify_uncertain=True,
    )

    assert result["matched"] == 1
    assert result["ambiguous"] == 0
    assert result["still_missing"] == 0
    assert new_path.exists()
    row = test_db.get_image_by_id(image_id)
    assert row["path"] == str(new_path)
    assert row["filename"] == "kept.png"
    assert row["is_readable"] == 1
    assert row["read_error"] is None


def test_reconnect_result_counts_only_files_seen_in_selected_search_folder(test_db, tmp_path):
    from services.image_service import ImageService

    unrelated_old = tmp_path / "somewhere-else" / "not-in-this-search.png"
    test_db.add_image(
        path=str(unrelated_old),
        filename="not-in-this-search.png",
        metadata_json="{}",
        file_size=123,
        source_size=123,
    )

    old_path = tmp_path / "old" / "found-here.png"
    found = _make_image(tmp_path / "new" / "found-here.png")
    stat = found.stat()
    test_db.add_image(
        path=str(old_path),
        filename="found-here.png",
        metadata_json="{}",
        file_size=stat.st_size,
        source_size=stat.st_size,
        source_mtime_ns=stat.st_mtime_ns,
    )

    service = ImageService()
    result = service.reconnect_missing_files_once(str(found.parent), recursive=True)

    assert result["library_missing_total"] == 2
    assert result["missing_total"] == 1
    assert result["matched"] == 1
    assert result["still_missing"] == 0
    assert result["still_missing_samples"] == []


def test_reconnect_missing_file_skips_ambiguous_same_name_size(test_db, tmp_path):
    from services.image_service import ImageService

    old_a = tmp_path / "old" / "same.png"
    old_b = tmp_path / "other-old" / "same.png"
    found = _make_image(tmp_path / "new" / "same.png")
    stat = found.stat()
    first_id = test_db.add_image(
        path=str(old_a),
        filename="same.png",
        metadata_json="{}",
        file_size=stat.st_size,
        source_size=stat.st_size,
        source_mtime_ns=stat.st_mtime_ns,
    )
    second_id = test_db.add_image(
        path=str(old_b),
        filename="same.png",
        metadata_json="{}",
        file_size=stat.st_size,
        source_size=stat.st_size,
        source_mtime_ns=stat.st_mtime_ns,
    )

    service = ImageService()
    result = service.reconnect_missing_files_once(str(found.parent), recursive=True)

    assert result["matched"] == 0
    assert result["ambiguous"] == 1
    assert test_db.get_image_by_id(first_id)["path"] == str(old_a)
    assert test_db.get_image_by_id(second_id)["path"] == str(old_b)



def test_reconnect_missing_file_does_not_duplicate_already_indexed_found_path(test_db, tmp_path):
    from services.image_service import ImageService

    old_path = tmp_path / "old" / "already.png"
    found = _make_image(tmp_path / "new" / "already.png")
    stat = found.stat()
    old_id = test_db.add_image(
        path=str(old_path),
        filename="already.png",
        metadata_json="{}",
        file_size=stat.st_size,
        source_size=stat.st_size,
        source_mtime_ns=stat.st_mtime_ns,
    )
    existing_id = test_db.add_image(
        path=str(found),
        filename="already.png",
        metadata_json="{}",
        file_size=stat.st_size,
        source_size=stat.st_size,
        source_mtime_ns=stat.st_mtime_ns,
    )

    service = ImageService()
    result = service.reconnect_missing_files_once(str(found.parent), recursive=True)

    assert result["matched"] == 0
    assert result["conflicts"] == 1
    assert test_db.get_image_by_id(old_id)["path"] == str(old_path)
    assert test_db.get_image_by_id(existing_id)["path"] == str(found)


def test_reconnect_background_progress_finishes_and_can_be_polled(test_db, tmp_path):
    from services.image_service import ImageService
    from routers.images import ReconnectMissingFilesRequest

    old_path = tmp_path / "old" / "bg.png"
    found = _make_image(tmp_path / "new" / "bg.png")
    stat = found.stat()
    test_db.add_image(
        path=str(old_path),
        filename="bg.png",
        metadata_json="{}",
        file_size=stat.st_size,
        source_size=stat.st_size,
        source_mtime_ns=stat.st_mtime_ns,
    )

    service = ImageService()
    start = service.start_reconnect_missing_files(
        ReconnectMissingFilesRequest(search_folder=str(found.parent), recursive=True),
        ImmediateBackgroundTasks(),
    )
    progress = service.get_reconnect_progress()

    assert start["status"] == "started"
    assert progress["status"] == "done"
    assert progress["matched"] == 1
    assert progress["result"]["matched"] == 1


def test_reconnect_api_routes_are_not_captured_by_image_id_route(test_client, tmp_path):
    db = test_client.test_db
    old_path = tmp_path / "old" / "api.png"
    found = _make_image(tmp_path / "new" / "api.png")
    stat = found.stat()
    db.add_image(
        path=str(old_path),
        filename="api.png",
        metadata_json="{}",
        file_size=stat.st_size,
        source_size=stat.st_size,
        source_mtime_ns=stat.st_mtime_ns,
    )

    response = test_client.post(
        "/api/images/reconnect-missing/start",
        json={"search_folder": str(found.parent), "recursive": True, "verify_uncertain": True},
    )
    assert response.status_code == 200

    progress = test_client.get("/api/images/reconnect-missing/progress")
    assert progress.status_code == 200
    payload = progress.json()
    assert payload["status"] == "done"
    assert payload["matched"] == 1
