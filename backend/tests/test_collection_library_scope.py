"""A collection only lists and counts images that live in the current library.

Collections belong to one library, but their item rows point at image ids.
An image moved to another library (or added by id from another library)
must not show up in, or be counted by, a collection of this library.
"""

from __future__ import annotations

import database as db
import db_libraries as libdb
from library_context import (
    MAIN_LIBRARY_ID,
    reset_current_library_id,
    set_current_library_id,
)


def _insert_image(path: str, library_id: str = MAIN_LIBRARY_ID) -> int:
    token = set_current_library_id(library_id)
    try:
        filename = path.rsplit("/", 1)[-1]
        return int(
            db.add_image(
                path=path,
                filename=filename,
                generator="unknown",
                width=64,
                height=64,
                file_size=100,
                is_readable=True,
            )
        )
    finally:
        reset_current_library_id(token)


def _count_for(name: str) -> int:
    for row in db.list_collections():
        if row["name"] == name:
            return int(row["item_count"])
    raise AssertionError(f"collection {name!r} not listed")


def test_moved_image_leaves_the_collection_of_its_old_library(test_db):
    libdb.ensure_default_library()
    other_id = libdb.create_library("Elsewhere")["id"]
    stays = _insert_image("/tmp/coll-scope-stays.png")
    moves = _insert_image("/tmp/coll-scope-moves.png")

    token = set_current_library_id(MAIN_LIBRARY_ID)
    try:
        collection = db.create_collection("Scoped set")
        db.set_collection_membership_bulk(collection["id"], [stays, moves], True)
        libdb.move_images_to_library([moves], other_id)

        assert db.get_collection_image_ids(collection["id"]) == [stays]
        assert _count_for("Scoped set") == 1
    finally:
        reset_current_library_id(token)


def test_collection_does_not_take_images_from_another_library(test_db):
    libdb.ensure_default_library()
    other_id = libdb.create_library("Foreign")["id"]
    local = _insert_image("/tmp/coll-scope-local.png")
    foreign = _insert_image("/tmp/coll-scope-foreign.png", other_id)

    token = set_current_library_id(MAIN_LIBRARY_ID)
    try:
        collection = db.create_collection("Local only")
        added = db.set_collection_membership_bulk(
            collection["id"], [local, foreign], True
        )

        assert added == 1
        assert db.get_collection_image_ids(collection["id"]) == [local]
        assert _count_for("Local only") == 1
    finally:
        reset_current_library_id(token)


def test_single_add_of_another_librarys_image_is_not_found(test_db):
    libdb.ensure_default_library()
    other_id = libdb.create_library("Foreign single")["id"]
    foreign = _insert_image("/tmp/coll-scope-foreign-single.png", other_id)

    token = set_current_library_id(MAIN_LIBRARY_ID)
    try:
        collection = db.create_collection("Single add")
        try:
            db.set_collection_membership(collection["id"], foreign, True)
        except ValueError:
            pass
        else:
            raise AssertionError("an image from another library was added")
        assert db.get_collection_image_ids(collection["id"]) == []
    finally:
        reset_current_library_id(token)
