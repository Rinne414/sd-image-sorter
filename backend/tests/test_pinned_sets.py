"""Pinned picture sets: "show only these pictures" in the Gallery (S4b).

A box selection on the Style Map can be opened in the Gallery. The ids are
stored as a hidden collection (``~pin-...`` slug), so the Gallery's existing
collection filter -- already carried by listing, counting, selection tokens,
bulk actions, Auto-Separate and Manual Sort -- shows exactly those pictures
without a second filter to keep in step. The set is hidden from the collection
lists, scoped to its library and pruned to the newest few.
"""

from __future__ import annotations

import database as db
import db_libraries as libdb
import db_pinned_sets as pins
from library_context import (
    MAIN_LIBRARY_ID,
    reset_current_library_id,
    set_current_library_id,
)


def _images(
    count: int, prefix: str = "pin", library_id: str = MAIN_LIBRARY_ID
) -> list[int]:
    token = set_current_library_id(library_id)
    try:
        return [
            int(
                db.add_image(
                    path=f"/tmp/{prefix}-{index}.png",
                    filename=f"{prefix}-{index}.png",
                    generator="unknown",
                    width=64,
                    height=64,
                    file_size=100,
                    is_readable=True,
                )
            )
            for index in range(count)
        ]
    finally:
        reset_current_library_id(token)


class TestPinnedSets:
    def test_the_collection_filter_shows_exactly_the_pinned_pictures(self, test_db):
        ids = _images(8)
        made = pins.create_pinned_set([ids[1], ids[3], ids[5]])

        assert made["count"] == 3
        assert sorted(db.get_filtered_image_ids(collection_id=made["id"])) == sorted(
            [ids[1], ids[3], ids[5]]
        )
        assert db.get_filtered_image_count(collection_id=made["id"]) == 3

    def test_it_is_not_a_collection_the_user_sees(self, test_db):
        ids = _images(3)
        pins.create_pinned_set(ids)
        db.create_collection("Mine")
        names = [row["name"] for row in db.list_collections()]
        assert "Mine" in names
        assert not any(name.startswith("Style Map") for name in names)

    def test_duplicates_and_unknown_ids_are_dropped(self, test_db):
        ids = _images(3)
        made = pins.create_pinned_set([ids[0], ids[0], 987654, ids[2]])
        assert made["count"] == 2

    def test_another_librarys_pictures_are_left_out_and_the_set_stays_in_its_library(
        self, test_db
    ):
        libdb.ensure_default_library()
        other = libdb.create_library("Elsewhere")["id"]
        mine = _images(2, "mine")
        theirs = _images(2, "theirs", other)
        made = pins.create_pinned_set(mine + theirs)
        assert made["count"] == 2
        token = set_current_library_id(other)
        try:
            assert pins.get_pinned_set(made["id"]) is None
        finally:
            reset_current_library_id(token)
        assert pins.get_pinned_set(made["id"])["count"] == 2

    def test_lookup_reports_a_deleted_set_as_gone(self, test_db):
        ids = _images(2)
        made = pins.create_pinned_set(ids)
        assert pins.get_pinned_set(made["id"]) == {"id": made["id"], "count": 2}
        db.delete_collection(made["id"])
        assert pins.get_pinned_set(made["id"]) is None

    def test_an_ordinary_collection_is_not_a_pinned_set(self, test_db):
        real = db.create_collection("Mine")
        assert pins.get_pinned_set(real["id"]) is None

    def test_only_the_newest_sets_are_kept(self, test_db):
        ids = _images(2)
        made = [pins.create_pinned_set(ids) for _ in range(pins.PINNED_KEEP + 3)]
        alive = [pins.get_pinned_set(item["id"]) is not None for item in made]
        assert alive == [False] * 3 + [True] * pins.PINNED_KEEP

    def test_a_large_set_is_stored_in_chunks(self, test_db):
        ids = _images(1500)
        made = pins.create_pinned_set(ids)
        assert made["count"] == 1500
        assert db.get_filtered_image_count(collection_id=made["id"]) == 1500


class TestRoute:
    def test_create_and_look_up(self, test_client):
        ids = _images(5)
        created = test_client.post(
            "/api/collections/pinned", json={"image_ids": ids[:4]}
        )
        assert created.status_code == 200
        body = created.json()
        assert body["count"] == 4
        found = test_client.get(
            f"/api/collections/pinned/{body['collection_id']}"
        ).json()
        assert found == {
            "exists": True,
            "collection_id": body["collection_id"],
            "count": 4,
        }
        token = test_client.post(
            "/api/images/selection-token", json={"collectionId": body["collection_id"]}
        ).json()
        assert token["total_estimate"] == 4

    def test_a_gone_set_says_so(self, test_client):
        ids = _images(2)
        body = test_client.post(
            "/api/collections/pinned", json={"image_ids": ids}
        ).json()
        test_client.delete(f"/api/collections/{body['collection_id']}")
        found = test_client.get(f"/api/collections/pinned/{body['collection_id']}")
        assert found.status_code == 200
        assert found.json() == {
            "exists": False,
            "collection_id": body["collection_id"],
            "count": 0,
        }

    def test_an_empty_or_malformed_body_is_refused(self, test_client):
        assert test_client.post(
            "/api/collections/pinned", json={"image_ids": []}
        ).status_code in (400, 422)
        assert test_client.post(
            "/api/collections/pinned", json={"image_ids": ["x"]}
        ).status_code in (400, 422)

    def test_another_library_cannot_look_the_set_up(self, test_client):
        ids = _images(2)
        body = test_client.post(
            "/api/collections/pinned", json={"image_ids": ids}
        ).json()
        other = test_client.get(
            f"/api/collections/pinned/{body['collection_id']}",
            headers={"X-SD-Library-Id": "libB"},
        ).json()
        assert other["exists"] is False
