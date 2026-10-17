"""A trashed picture whose library row could not be dropped says so."""

from __future__ import annotations

import sqlite3

from services import image_service
from services.image.jobs_delete import TRASHED_ROW_LEFT_ERROR
from services.image_service import ImageService


def test_a_row_that_stays_after_the_trash_is_named_not_a_raw_error(monkeypatch, tmp_path):
    svc = ImageService()
    picture = tmp_path / "x.png"
    picture.write_bytes(b"x")
    monkeypatch.setattr(svc, "resolve_image_source_path", lambda _i, _p: str(picture))
    trashed = []
    monkeypatch.setattr(image_service, "move_file_to_trash", lambda p: trashed.append(p))

    def busy(_image_id):
        raise sqlite3.OperationalError("database is locked")

    monkeypatch.setattr(image_service.db, "delete_image", busy)

    result = svc._delete_one_image_to_trash(7, {"filename": "x.png", "path": str(picture)})

    assert trashed == [str(picture)]
    assert result == {"id": 7, "success": False, "filename": "x.png", "error": TRASHED_ROW_LEFT_ERROR}
