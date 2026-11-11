"""sort_by=set_order: a set's pictures come in the order the set was made."""

from __future__ import annotations

from datetime import datetime, timedelta


def _pictures(test_db, tmp_path, count=5):
    from PIL import Image

    ids = []
    start = datetime(2026, 11, 1, 9, 0, 0)
    for n in range(count):
        path = tmp_path / f"pic-{n}.png"
        Image.new("RGB", (8, 8), (n * 30, 0, 0)).save(path)
        ids.append(
            test_db.add_image(
                path=str(path),
                filename=path.name,
                prompt="1girl",
                metadata_json="{}",
                created_at=start + timedelta(hours=n),
            )
        )
    return ids


def _listed(test_client, **params):
    answer = test_client.get("/api/images", params={"limit": 50, **params})
    assert answer.status_code == 200, answer.text
    return [image["id"] for image in answer.json()["images"]]


def test_a_set_is_listed_in_the_order_it_was_made_not_by_date(
    test_client, test_db, tmp_path
):
    ids = _pictures(test_db, tmp_path)
    ranked = [
        ids[2],
        ids[4],
        ids[0],
    ]  # closest first, as a meaning search would hand it over
    made = test_client.post(
        "/api/collections/pinned", json={"image_ids": ranked}
    ).json()

    by_set = _listed(
        test_client, collection_id=made["collection_id"], sort_by="set_order"
    )
    by_date = _listed(
        test_client, collection_id=made["collection_id"], sort_by="newest"
    )

    assert by_set == ranked
    assert by_date == [ids[4], ids[2], ids[0]]


def test_pages_of_a_set_follow_on_without_repeats(test_client, test_db, tmp_path):
    ids = _pictures(test_db, tmp_path)
    ranked = [ids[3], ids[1], ids[4], ids[0], ids[2]]
    made = test_client.post(
        "/api/collections/pinned", json={"image_ids": ranked}
    ).json()

    first = test_client.get(
        "/api/images",
        params={
            "collection_id": made["collection_id"],
            "sort_by": "set_order",
            "limit": 2,
        },
    ).json()
    second = test_client.get(
        "/api/images",
        params={
            "collection_id": made["collection_id"],
            "sort_by": "set_order",
            "limit": 2,
            "offset": 2,
        },
    ).json()

    assert [image["id"] for image in first["images"]] == ranked[:2]
    assert [image["id"] for image in second["images"]] == ranked[2:4]
    assert first["has_more"] is True


def test_without_a_set_the_sort_is_newest_first(test_client, test_db, tmp_path):
    ids = _pictures(test_db, tmp_path, count=3)

    assert _listed(test_client, sort_by="set_order") == list(reversed(ids))
