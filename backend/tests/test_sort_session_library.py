"""Every Manual Sort answer names the library the saved session's images belong to.

There is one saved sort session for every library. A tab that opens Manual
Sort in library B must be able to tell that the unfinished session is library
A's before it resumes it (and moves or copies A's files).
"""

from __future__ import annotations

import pytest

import services.sorting_service as ss


@pytest.fixture
def svc(tmp_path, monkeypatch):
    monkeypatch.setattr(
        ss, "SESSION_FILE", str(tmp_path / "session.json"), raising=False
    )
    monkeypatch.setattr(
        ss, "LEGACY_SESSION_FILE", str(tmp_path / "legacy.json"), raising=False
    )
    return ss.SortingService()


def _add_images(test_db, count: int) -> list[int]:
    return [
        test_db.add_image(
            path=f"/nowhere/sort-lib-{n}.png", filename=f"sort-lib-{n}.png"
        )
        for n in range(count)
    ]


def _set_library(test_db, library_id: str, image_ids: list[int] | None = None) -> None:
    with test_db.get_db() as conn:
        if image_ids is None:
            conn.execute("UPDATE images SET library_id = ?", (library_id,))
            return
        for image_id in image_ids:
            conn.execute(
                "UPDATE images SET library_id = ? WHERE id = ?", (library_id, image_id)
            )


def test_no_session_names_no_library(test_db, svc):
    flags = svc._get_sort_session_flags()
    assert flags["library_id"] is None
    assert flags["library_mixed"] is False


def test_session_names_the_library_of_its_images(test_db, svc):
    ids = _add_images(test_db, 3)
    svc._sort_session["image_ids"] = ids
    assert svc._get_sort_session_flags()["library_id"] == "main"

    _set_library(test_db, "other")
    flags = svc._get_sort_session_flags()
    assert (flags["library_id"], flags["library_mixed"]) == ("other", False)


def test_images_in_two_libraries_are_reported_as_mixed_for_any_session_size(
    test_db, svc
):
    ids = _add_images(test_db, 1200)
    svc._sort_session["image_ids"] = ids
    _set_library(test_db, "other", [ids[1100]])

    flags = svc._get_sort_session_flags()
    assert (flags["library_id"], flags["library_mixed"]) == (None, True)
