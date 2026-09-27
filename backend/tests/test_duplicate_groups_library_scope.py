"""Duplicate scan results belong to the library that was scanned.

Each library keeps its own last result. Opening the duplicate cleaner in
another library must not show (or offer to clear) the groups of the library
that was scanned before.
"""

from __future__ import annotations

import json

import numpy as np
import pytest

import db_libraries as libdb
from library_context import (
    MAIN_LIBRARY_ID,
    reset_current_library_id,
    set_current_library_id,
)
from services import duplicate_group_service as dgs
from similarity import embedding_to_bytes


class _Handle:
    cancelled = False

    def set_progress(self, **_kwargs):
        pass

    def commit_result(self, *, publish_callback, result, processed, total, message):
        publish_callback()
        return True


@pytest.fixture
def scoped_env(test_db, tmp_path, monkeypatch):
    import config

    monkeypatch.setattr(config, "get_state_dir", lambda: str(tmp_path))
    monkeypatch.setattr("similarity_ann.hnswlib_available", lambda: False)
    libdb.ensure_default_library()
    return test_db


def _seed_pair(db, first_id: int, library_id: str) -> None:
    base = np.zeros(8, dtype=np.float32)
    base[0] = 1.0
    near = base + np.array([0, 0.01, 0, 0, 0, 0, 0, 0], dtype=np.float32)
    conn = db.get_connection()
    try:
        for offset, vec in enumerate((base, near)):
            image_id = first_id + offset
            conn.execute(
                "INSERT INTO images (id, path, filename, width, height, file_size, "
                "embedding, library_id) VALUES (?, ?, ?, 64, 64, 100, ?, ?)",
                (
                    image_id,
                    f"C:/dup-scope/{library_id}/{image_id}.png",
                    f"{image_id}.png",
                    embedding_to_bytes(vec),
                    library_id,
                ),
            )
        conn.commit()
    finally:
        conn.close()


def _scan_in(library_id: str) -> None:
    token = set_current_library_id(library_id)
    try:
        dgs.run_duplicate_scan(_Handle(), threshold=0.95)
    finally:
        reset_current_library_id(token)


def _page_in(library_id: str) -> dict:
    token = set_current_library_id(library_id)
    try:
        return dgs.get_groups_page()
    finally:
        reset_current_library_id(token)


def _member_ids(page: dict) -> set[int]:
    return {m["id"] for group in page["groups"] for m in group["members"]}


def test_other_library_does_not_see_the_scanned_librarys_groups(scoped_env):
    other_id = libdb.create_library("Dup other")["id"]
    _seed_pair(scoped_env, 1, MAIN_LIBRARY_ID)

    _scan_in(MAIN_LIBRARY_ID)

    assert _member_ids(_page_in(MAIN_LIBRARY_ID)) == {1, 2}
    other_page = _page_in(other_id)
    assert other_page["available"] is False
    assert other_page["groups"] == []


def test_each_library_keeps_its_own_last_scan(scoped_env):
    other_id = libdb.create_library("Dup keep")["id"]
    _seed_pair(scoped_env, 1, MAIN_LIBRARY_ID)
    _seed_pair(scoped_env, 11, other_id)

    _scan_in(MAIN_LIBRARY_ID)
    _scan_in(other_id)

    assert _member_ids(_page_in(MAIN_LIBRARY_ID)) == {1, 2}
    assert _member_ids(_page_in(other_id)) == {11, 12}


def test_result_without_a_library_is_not_trusted(scoped_env, tmp_path):
    (tmp_path / "duplicate-groups.json").write_text(
        json.dumps({"version": dgs._RESULT_VERSION, "groups": [{"members": []}]}),
        encoding="utf-8",
    )

    assert _page_in(MAIN_LIBRARY_ID)["available"] is False
