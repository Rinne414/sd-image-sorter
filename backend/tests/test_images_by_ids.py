"""POST /api/images/by-ids: gallery rows for ranked id lists (similarity, duplicate review)."""


def _add(test_client, tmp_path, name, **extra):
    db = test_client.test_db
    path = tmp_path / name
    path.write_bytes(b"x")
    return db.add_image(
        path=str(path), filename=name, metadata_json="{}", width=64, height=96, **extra
    )


def test_rows_come_back_in_the_order_asked(test_client, tmp_path):
    a = _add(test_client, tmp_path, "a.png")
    b = _add(test_client, tmp_path, "b.png")
    c = _add(test_client, tmp_path, "c.png")

    response = test_client.post("/api/images/by-ids", json={"image_ids": [c, a, b]})

    assert response.status_code == 200
    body = response.json()
    assert [row["id"] for row in body["images"]] == [c, a, b]
    assert body["count"] == 3
    row = body["images"][0]
    assert row["filename"] == "c.png"
    assert (row["width"], row["height"]) == (64, 96)
    # the gallery row, not the heavy columns
    assert "embedding" not in row and "metadata_json" not in row


def test_gone_ids_and_repeats_are_left_out(test_client, tmp_path):
    a = _add(test_client, tmp_path, "a.png")

    response = test_client.post(
        "/api/images/by-ids", json={"image_ids": [a, 999999, a, -3]}
    )

    assert response.status_code == 200
    assert [row["id"] for row in response.json()["images"]] == [a]


def test_images_of_another_library_are_left_out(test_client, tmp_path):
    a = _add(test_client, tmp_path, "a.png")
    created = test_client.post("/api/libraries", json={"name": "Other"}).json()
    other_id = created.get("id") or created.get("library", {}).get("id")
    assert other_id

    response = test_client.post(
        "/api/images/by-ids",
        json={"image_ids": [a]},
        headers={"X-SD-Library-Id": other_id},
    )

    assert response.status_code == 200
    assert response.json()["images"] == []


def test_an_empty_list_is_fine(test_client):
    response = test_client.post("/api/images/by-ids", json={"image_ids": []})

    assert response.status_code == 200
    assert response.json() == {"images": [], "count": 0}
