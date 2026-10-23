"""The Gallery "media type" filter (All / Pictures / Videos).

``images.media_type`` is a virtual column computed from the file extension
(migration 065). The filter must narrow the listing, the exact count, the
"select all matches" id set, and ignore any value that is not image / video.
"""

import pytest


@pytest.fixture
def mixed_library(test_client, tmp_path):
    # The listing drops rows whose file is missing, so both files really exist.
    still = tmp_path / "still.png"
    clip = tmp_path / "clip.mp4"
    still.write_bytes(b"png")
    clip.write_bytes(b"mp4")
    db = test_client.test_db
    picture_id = db.add_image(path=str(still), filename="still.png", metadata_json="{}")
    video_id = db.add_image(path=str(clip), filename="clip.mp4", metadata_json="{}")
    return {"db": db, "picture_id": picture_id, "video_id": video_id}


def _listed_ids(test_client, query):
    response = test_client.get(f"/api/images?{query}")
    assert response.status_code == 200
    return [image["id"] for image in response.json()["images"]]


class TestMediaTypeFilter:
    def test_listing_with_video_returns_only_the_mp4(self, test_client, mixed_library):
        assert _listed_ids(test_client, "media_type=video") == [
            mixed_library["video_id"]
        ]

    def test_listing_with_image_returns_only_the_png(self, test_client, mixed_library):
        assert _listed_ids(test_client, "media_type=image") == [
            mixed_library["picture_id"]
        ]

    def test_listing_without_the_filter_returns_both(self, test_client, mixed_library):
        assert set(_listed_ids(test_client, "")) == {
            mixed_library["picture_id"],
            mixed_library["video_id"],
        }

    def test_count_endpoint_agrees_with_listing(self, test_client, mixed_library):
        assert (
            test_client.get("/api/images/count?media_type=video").json()["total"] == 1
        )
        assert (
            test_client.get("/api/images/count?media_type=image").json()["total"] == 1
        )
        assert test_client.get("/api/images/count").json()["total"] == 2

    def test_selection_ids_follow_the_filter(self, test_client, mixed_library):
        response = test_client.post(
            "/api/images/selection-ids", json={"mediaType": "video"}
        )
        assert response.status_code == 200
        assert response.json()["image_ids"] == [mixed_library["video_id"]]

    def test_unknown_value_is_no_filter(self, test_client, mixed_library):
        assert len(_listed_ids(test_client, "media_type=sound")) == 2
        db = mixed_library["db"]
        assert db.get_filtered_image_count(media_type="") == 2
        assert db.get_filtered_image_count(media_type=None) == 2

    def test_database_layer_filters_count_and_pages(self, mixed_library):
        db = mixed_library["db"]
        assert db.get_filtered_image_count(media_type="video") == 1
        page = db.get_images_paginated(media_type="image", limit=50)
        assert [image["filename"] for image in page["images"]] == ["still.png"]
        assert page["total"] == 1
