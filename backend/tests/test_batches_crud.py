"""Batches: saved, ordered, per-library groups of images (V4 slice 2a)."""

from __future__ import annotations

from pathlib import Path

import pytest
from PIL import Image

from tests.batch_fixtures import (
    LIBRARY_HEADER,
    MARKER,
    censored_image,
    create_batch,
    isolate_batch_data_dir,
    pixels,
    png_data_url,
    save_censored,
    seed_image,
)


@pytest.fixture(autouse=True)
def batch_data_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    return isolate_batch_data_dir(tmp_path, monkeypatch)


OTHER_LIBRARY = {LIBRARY_HEADER: "studio"}


def _item_ids(batch: dict) -> list[int]:
    return [item["image_id"] for item in batch["items"]]


def _seed_three(test_db, tmp_path: Path) -> list[int]:
    return [
        seed_image(test_db, tmp_path / "lib", name, seed=index)
        for index, name in enumerate(("a", "b", "c"))
    ]


def test_create_keeps_order_and_defaults_to_pixiv_steps(
    test_client, test_db, tmp_path, batch_data_dir
):
    a, b, c = _seed_three(test_db, tmp_path)

    batch = create_batch(test_client, [c, a, b], name="Autumn set")

    assert batch["kind"] == "pixiv"
    assert batch["name"] == "Autumn set"
    assert batch["revision"] == 1
    assert _item_ids(batch) == [c, a, b]
    assert [item["position"] for item in batch["items"]] == [0, 1, 2]
    assert [step["id"] for step in batch["steps"]] == [
        "pick",
        "censor",
        "order",
        "name",
        "export",
    ]
    assert all(step["enabled"] for step in batch["steps"])
    assert batch["current_step"] == "pick"
    assert batch["items"][0]["filename"] == "c.png"
    assert batch["items"][0]["has_censored"] is False

    fetched = test_client.get(f"/api/batches/{batch['id']}")
    assert fetched.status_code == 200
    assert _item_ids(fetched.json()) == [c, a, b]


def test_create_skips_repeated_ids_and_rejects_unknown_images(
    test_client, test_db, tmp_path, batch_data_dir
):
    a, b, _c = _seed_three(test_db, tmp_path)

    created = test_client.post(
        "/api/batches",
        json={"kind": "custom", "name": "Dupes", "image_ids": [a, b, a]},
    )
    assert created.status_code == 201, created.text
    assert _item_ids(created.json()["batch"]) == [a, b]
    assert created.json()["skipped_image_ids"] == [a]

    unknown = test_client.post(
        "/api/batches",
        json={"kind": "pixiv", "name": "Ghost", "image_ids": [a, 999999]},
    )
    assert unknown.status_code == 404
    assert unknown.json()["image_ids"] == [999999]
    names = [row["name"] for row in test_client.get("/api/batches").json()["batches"]]
    assert "Ghost" not in names


def test_list_reports_counts_covers_and_hides_archived(
    test_client, test_db, tmp_path, batch_data_dir
):
    ids = _seed_three(test_db, tmp_path)
    batch = create_batch(test_client, ids)
    save_censored(test_client, batch["id"], ids[1])

    listed = test_client.get("/api/batches").json()["batches"]
    summary = next(row for row in listed if row["id"] == batch["id"])
    assert summary["item_count"] == 3
    assert summary["censored_count"] == 1
    assert summary["cover_image_ids"] == ids[:3]
    assert summary["current_step"] == "pick"
    assert summary["updated_at"]

    archived = test_client.patch(
        f"/api/batches/{batch['id']}",
        json={"revision": batch["revision"], "archived": True},
    )
    assert archived.status_code == 200, archived.text
    assert archived.json()["archived_at"]
    active_ids = [
        row["id"] for row in test_client.get("/api/batches").json()["batches"]
    ]
    assert batch["id"] not in active_ids
    all_ids = [
        row["id"]
        for row in test_client.get(
            "/api/batches", params={"include_archived": True}
        ).json()["batches"]
    ]
    assert batch["id"] in all_ids


def test_list_carries_each_batch_own_steps(
    test_client, test_db, tmp_path, batch_data_dir
):
    batch = create_batch(test_client, _seed_three(test_db, tmp_path))
    steps = [
        {"id": "pick", "enabled": True},
        {"id": "censor", "enabled": False},
        {"id": "my-check", "enabled": True},
        {"id": "export", "enabled": True},
    ]
    patched = test_client.patch(
        f"/api/batches/{batch['id']}",
        json={"revision": batch["revision"], "steps": steps},
    )
    assert patched.status_code == 200, patched.text

    listed = test_client.get("/api/batches").json()["batches"]
    summary = next(row for row in listed if row["id"] == batch["id"])
    assert summary["steps"] == steps


def test_batches_are_scoped_to_the_request_library(
    test_client, test_db, tmp_path, batch_data_dir
):
    main_image = seed_image(test_db, tmp_path / "lib", "main-a")
    studio_image = seed_image(test_db, tmp_path / "studio", "s-a", library_id="studio")
    studio_batch = create_batch(test_client, [studio_image], headers=OTHER_LIBRARY)

    main_ids = [row["id"] for row in test_client.get("/api/batches").json()["batches"]]
    assert studio_batch["id"] not in main_ids
    assert test_client.get(f"/api/batches/{studio_batch['id']}").status_code == 404
    assert (
        test_client.patch(
            f"/api/batches/{studio_batch['id']}", json={"revision": 1, "name": "x"}
        ).status_code
        == 404
    )
    assert test_client.delete(f"/api/batches/{studio_batch['id']}").status_code == 404

    studio_ids = [
        row["id"]
        for row in test_client.get("/api/batches", headers=OTHER_LIBRARY).json()[
            "batches"
        ]
    ]
    assert studio_batch["id"] in studio_ids

    foreign = test_client.post(
        f"/api/batches/{studio_batch['id']}/items",
        json={"image_ids": [main_image]},
        headers=OTHER_LIBRARY,
    )
    assert foreign.status_code == 404
    assert foreign.json()["image_ids"] == [main_image]


def test_patch_uses_revision_compare_and_set(
    test_client, test_db, tmp_path, batch_data_dir
):
    batch = create_batch(test_client, _seed_three(test_db, tmp_path))

    first = test_client.patch(
        f"/api/batches/{batch['id']}",
        json={
            "revision": 1,
            "name": "Renamed",
            "settings": {"name_template": "{batch}_{n:02}"},
            "current_step": "censor",
        },
    )
    assert first.status_code == 200, first.text
    body = first.json()
    assert body["revision"] == 2
    assert body["name"] == "Renamed"
    assert body["settings"] == {"name_template": "{batch}_{n:02}"}
    assert body["current_step"] == "censor"

    stale = test_client.patch(
        f"/api/batches/{batch['id']}", json={"revision": 1, "name": "Lost update"}
    )
    assert stale.status_code == 409
    assert stale.json()["code"] == "batch_revision_conflict"
    assert stale.json()["current_revision"] == 2
    assert test_client.get(f"/api/batches/{batch['id']}").json()["name"] == "Renamed"


def test_patch_rejects_unknown_current_step_and_duplicate_step_ids(
    test_client, test_db, tmp_path, batch_data_dir
):
    batch = create_batch(test_client, _seed_three(test_db, tmp_path))

    unknown_step = test_client.patch(
        f"/api/batches/{batch['id']}", json={"revision": 1, "current_step": "nope"}
    )
    assert unknown_step.status_code == 422

    duplicate = test_client.patch(
        f"/api/batches/{batch['id']}",
        json={
            "revision": 1,
            "steps": [
                {"id": "pick", "enabled": True},
                {"id": "pick", "enabled": False},
            ],
        },
    )
    assert duplicate.status_code == 400

    reordered = test_client.patch(
        f"/api/batches/{batch['id']}",
        json={
            "revision": 1,
            "steps": [
                {"id": "order", "enabled": True},
                {"id": "export", "enabled": True},
                {"id": "my-check", "enabled": False},
            ],
        },
    )
    assert reordered.status_code == 200, reordered.text
    # "pick" is gone, so the current step falls back to the first step.
    assert reordered.json()["current_step"] == "order"
    assert [s["id"] for s in reordered.json()["steps"]] == [
        "order",
        "export",
        "my-check",
    ]


def test_add_items_appends_in_order_and_reports_skipped(
    test_client, test_db, tmp_path, batch_data_dir
):
    a, b, c = _seed_three(test_db, tmp_path)
    d = seed_image(test_db, tmp_path / "lib", "d", seed=9)
    batch = create_batch(test_client, [a, b])

    added = test_client.post(
        f"/api/batches/{batch['id']}/items", json={"image_ids": [d, a, c, d]}
    )

    assert added.status_code == 200, added.text
    assert added.json()["added_image_ids"] == [d, c]
    assert added.json()["skipped_image_ids"] == [a, d]
    assert _item_ids(added.json()["batch"]) == [a, b, d, c]
    assert [i["position"] for i in added.json()["batch"]["items"]] == [0, 1, 2, 3]


def test_remove_items_compacts_positions_and_drops_the_censored_copy(
    test_client, test_db, tmp_path, batch_data_dir
):
    a, b, c = _seed_three(test_db, tmp_path)
    batch = create_batch(test_client, [a, b, c])
    save_censored(test_client, batch["id"], b)
    censored_file = (
        batch_data_dir / "batches" / str(batch["id"]) / "censored" / f"{b}.png"
    )
    assert censored_file.is_file()

    removed = test_client.request(
        "DELETE", f"/api/batches/{batch['id']}/items", json={"image_ids": [b, 424242]}
    )

    assert removed.status_code == 200, removed.text
    assert removed.json()["removed_image_ids"] == [b]
    assert removed.json()["not_found_image_ids"] == [424242]
    assert _item_ids(removed.json()["batch"]) == [a, c]
    assert [i["position"] for i in removed.json()["batch"]["items"]] == [0, 1]
    assert not censored_file.exists()


def test_reorder_requires_exactly_the_current_set(
    test_client, test_db, tmp_path, batch_data_dir
):
    a, b, c = _seed_three(test_db, tmp_path)
    batch = create_batch(test_client, [a, b, c])
    url = f"/api/batches/{batch['id']}/items/order"

    missing = test_client.put(url, json={"image_ids": [c, a]})
    assert missing.status_code == 409
    assert missing.json()["missing_image_ids"] == [b]

    extra = test_client.put(url, json={"image_ids": [c, a, b, 777]})
    assert extra.status_code == 409
    assert extra.json()["unexpected_image_ids"] == [777]

    repeated = test_client.put(url, json={"image_ids": [c, a, a]})
    assert repeated.status_code == 400

    ok = test_client.put(url, json={"image_ids": [c, a, b]})
    assert ok.status_code == 200, ok.text
    assert _item_ids(ok.json()) == [c, a, b]
    assert _item_ids(test_client.get(f"/api/batches/{batch['id']}").json()) == [c, a, b]


def test_patch_item_sets_and_clears_output_name_and_state(
    test_client, test_db, tmp_path, batch_data_dir
):
    a, b, _c = _seed_three(test_db, tmp_path)
    batch = create_batch(test_client, [a, b])
    url = f"/api/batches/{batch['id']}/items/{b}"

    named = test_client.patch(
        url, json={"output_name": "cover", "item_state": {"reviewed": True}}
    )
    assert named.status_code == 200, named.text
    assert named.json()["output_name"] == "cover"
    assert named.json()["item_state"] == {"reviewed": True}

    cleared = test_client.patch(url, json={"output_name": None})
    assert cleared.status_code == 200
    assert cleared.json()["output_name"] is None
    assert cleared.json()["item_state"] == {"reviewed": True}

    assert (
        test_client.patch(
            f"/api/batches/{batch['id']}/items/999999", json={"output_name": "x"}
        ).status_code
        == 404
    )


def test_censored_copy_is_saved_without_metadata_served_and_discarded(
    test_client, test_db, tmp_path, batch_data_dir
):
    a, _b, _c = _seed_three(test_db, tmp_path)
    batch = create_batch(test_client, [a])
    url = f"/api/batches/{batch['id']}/items/{a}/censored"

    saved = test_client.put(
        url,
        json={"image_data": png_data_url(censored_image(), with_generation_text=True)},
    )
    assert saved.status_code == 200, saved.text
    assert saved.json()["has_censored"] is True
    assert saved.json()["censored_at"]

    working = batch_data_dir / "batches" / str(batch["id"]) / "censored" / f"{a}.png"
    assert MARKER.encode() not in working.read_bytes()
    with Image.open(working) as copy:
        copy.load()
        assert "parameters" not in copy.info
    assert pixels(working) == pixels(censored_image())

    served = test_client.get(url)
    assert served.status_code == 200
    assert served.content == working.read_bytes()

    discarded = test_client.delete(url)
    assert discarded.status_code == 200
    assert discarded.json()["has_censored"] is False
    assert not working.exists()
    assert test_client.get(url).status_code == 404


def test_censored_copy_rejects_invalid_image_data(
    test_client, test_db, tmp_path, batch_data_dir
):
    a, _b, _c = _seed_three(test_db, tmp_path)
    batch = create_batch(test_client, [a])

    response = test_client.put(
        f"/api/batches/{batch['id']}/items/{a}/censored",
        json={"image_data": "data:image/png;base64,not-base64!!"},
    )

    assert response.status_code == 400
    item = test_client.get(f"/api/batches/{batch['id']}").json()["items"][0]
    assert item["has_censored"] is False


def test_delete_removes_rows_and_working_folder_but_never_originals(
    test_client, test_db, tmp_path, batch_data_dir
):
    ids = _seed_three(test_db, tmp_path)
    originals = sorted((tmp_path / "lib").iterdir())
    before = {path: path.read_bytes() for path in originals}
    batch = create_batch(test_client, ids)
    save_censored(test_client, batch["id"], ids[0])
    folder = batch_data_dir / "batches" / str(batch["id"])
    assert folder.is_dir()

    deleted = test_client.delete(f"/api/batches/{batch['id']}")

    assert deleted.status_code == 200, deleted.text
    assert deleted.json() == {"deleted": True, "batch_id": batch["id"]}
    assert not folder.exists()
    assert test_client.get(f"/api/batches/{batch['id']}").status_code == 404
    assert {path: path.read_bytes() for path in originals} == before
    with test_db.get_db() as conn:
        assert (
            conn.execute(
                "SELECT COUNT(*) FROM batch_items WHERE batch_id = ?", (batch["id"],)
            ).fetchone()[0]
            == 0
        )
        assert (
            conn.execute(
                "SELECT COUNT(*) FROM images WHERE id IN (?, ?, ?)", tuple(ids)
            ).fetchone()[0]
            == 3
        )


def test_deleting_a_library_image_removes_it_from_batches(
    test_client, test_db, tmp_path, batch_data_dir
):
    a, b, c = _seed_three(test_db, tmp_path)
    batch = create_batch(test_client, [a, b, c])

    with test_db.get_db() as conn:
        conn.execute("DELETE FROM images WHERE id = ?", (b,))

    fetched = test_client.get(f"/api/batches/{batch['id']}").json()
    assert _item_ids(fetched) == [a, c]
    assert fetched["item_count"] == 2


def test_templates_are_saved_per_library_and_seed_new_batches(
    test_client, test_db, tmp_path, batch_data_dir
):
    a, _b, _c = _seed_three(test_db, tmp_path)
    steps = [
        {"id": "pick", "enabled": True},
        {"id": "censor", "enabled": False},
        {"id": "export", "enabled": True},
    ]
    created = test_client.post(
        "/api/batches/templates",
        json={
            "kind": "pixiv",
            "name": "No censor",
            "steps": steps,
            "settings": {"metadata_option": "strip"},
        },
    )
    assert created.status_code == 201, created.text
    template = created.json()

    listed = test_client.get("/api/batches/templates").json()
    assert [t["id"] for t in listed["templates"]] == [template["id"]]
    assert [s["id"] for s in listed["builtin_steps"]["pixiv"]][0] == "pick"
    studio = test_client.get("/api/batches/templates", headers=OTHER_LIBRARY).json()
    assert studio["templates"] == []

    batch = test_client.post(
        "/api/batches",
        json={
            "kind": "pixiv",
            "name": "From template",
            "template_id": template["id"],
            "image_ids": [a],
        },
    )
    assert batch.status_code == 201, batch.text
    assert batch.json()["batch"]["steps"] == steps
    assert batch.json()["batch"]["settings"] == {"metadata_option": "strip"}

    mismatch = test_client.post(
        "/api/batches",
        json={"kind": "dataset", "name": "Wrong kind", "template_id": template["id"]},
    )
    assert mismatch.status_code == 422

    assert (
        test_client.delete(f"/api/batches/templates/{template['id']}").status_code
        == 200
    )
    assert (
        test_client.delete(f"/api/batches/templates/{template['id']}").status_code
        == 404
    )
