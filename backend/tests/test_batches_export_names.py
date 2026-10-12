"""Name preview of a batch export (``POST /api/batches/{id}/export/names``).

The preview must give exactly the names the export writes: it shares the
export's source choice and naming code, and the main cases also run the
export and compare.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from tests.batch_fixtures import (
    create_batch,
    isolate_batch_data_dir,
    save_censored,
    seed_image,
)


@pytest.fixture(autouse=True)
def batch_data_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    return isolate_batch_data_dir(tmp_path, monkeypatch)


def _names(client, batch_id: int, **options):
    response = client.post(f"/api/batches/{batch_id}/export/names", json=options)
    assert response.status_code == 200, response.text
    return response.json()


def _export(client, batch_id: int, out_dir: Path, **options):
    return client.post(
        f"/api/batches/{batch_id}/export",
        json={"output_folder": str(out_dir), **options},
    )


def _preview_pairs(body) -> list[tuple[int, str | None]]:
    return [
        (item["image_id"], item["output_name"])
        for item in body["items"]
        if item["included"]
    ]


def test_preview_matches_the_export_for_tokens_overrides_formats_and_odd_names(
    test_client, test_db, tmp_path
):
    a = seed_image(test_db, tmp_path / "lib", "alpha", seed=1)
    b = seed_image(test_db, tmp_path / "lib", "beta", kind="jpeg", seed=2)
    c = seed_image(test_db, tmp_path / "lib", "gamma", seed=3)
    batch = create_batch(test_client, [a, b, c], name="2026/09: set?")
    for image_id in (a, b, c):
        save_censored(test_client, batch["id"], image_id)
    test_client.patch(
        f"/api/batches/{batch['id']}/items/{c}", json={"output_name": "cover.png"}
    )
    options = {"name_template": "{batch}-{n:03}-{original}", "start_number": 7}

    preview = _names(test_client, batch["id"], **options)
    response = _export(test_client, batch["id"], tmp_path / "out", **options)

    assert response.status_code == 200, response.text
    exported = [(i["image_id"], i["output_name"]) for i in response.json()["exported"]]
    assert _preview_pairs(preview) == exported
    assert exported[0][1] == "2026_09_ set_-007-alpha.png"
    # A censored copy exported in the original's format keeps that extension.
    assert exported[1][1].endswith(".jpg")
    assert preview["duplicates"] == []
    assert preview["template_error"] is None
    assert [item["overridden"] for item in preview["items"]] == [False, False, True]


def test_preview_follows_the_output_format(test_client, test_db, tmp_path):
    a = seed_image(test_db, tmp_path / "lib", "a", kind="jpeg")
    batch = create_batch(test_client, [a], name="Fmt")

    body = _names(test_client, batch["id"], output_format="webp")

    assert _preview_pairs(body) == [(a, "Fmt_01.webp")]


def test_preview_reports_case_insensitive_duplicates_instead_of_refusing(
    test_client, test_db, tmp_path
):
    a = seed_image(test_db, tmp_path / "lib", "a", seed=1)
    b = seed_image(test_db, tmp_path / "lib", "b", seed=2)
    c = seed_image(test_db, tmp_path / "lib", "c", seed=3)
    batch = create_batch(test_client, [a, b, c], name="Dup")
    test_client.patch(
        f"/api/batches/{batch['id']}/items/{c}", json={"output_name": "DUP_01"}
    )

    body = _names(test_client, batch["id"])

    assert body["duplicates"] == [{"output_name": "Dup_01.png", "image_ids": [a, c]}]
    assert _preview_pairs(body) == [
        (a, "Dup_01.png"),
        (b, "Dup_02.png"),
        (c, "DUP_01.png"),
    ]


def test_preview_with_block_names_every_item_and_marks_missing_copies(
    test_client, test_db, tmp_path
):
    a = seed_image(test_db, tmp_path / "lib", "a", seed=1)
    b = seed_image(test_db, tmp_path / "lib", "b", seed=2)
    batch = create_batch(test_client, [a, b], name="Blk")
    save_censored(test_client, batch["id"], a)

    body = _names(test_client, batch["id"])

    assert _preview_pairs(body) == [(a, "Blk_01.png"), (b, "Blk_02.png")]
    assert [item["has_censored"] for item in body["items"]] == [True, False]
    assert [item["number"] for item in body["items"]] == [1, 2]


def test_preview_with_skip_leaves_out_missing_copies_and_numbers_the_rest(
    test_client, test_db, tmp_path
):
    a = seed_image(test_db, tmp_path / "lib", "a", seed=1)
    b = seed_image(test_db, tmp_path / "lib", "b", seed=2)
    c = seed_image(test_db, tmp_path / "lib", "c", seed=3)
    batch = create_batch(test_client, [a, b, c], name="Skp")
    save_censored(test_client, batch["id"], a)
    save_censored(test_client, batch["id"], c)

    body = _names(test_client, batch["id"], missing_censored="skip")
    response = _export(
        test_client, batch["id"], tmp_path / "out", missing_censored="skip"
    )

    assert _preview_pairs(body) == [(a, "Skp_01.png"), (c, "Skp_02.png")]
    skipped = [item for item in body["items"] if not item["included"]]
    assert [(item["image_id"], item["output_name"]) for item in skipped] == [(b, None)]
    exported = [(i["image_id"], i["output_name"]) for i in response.json()["exported"]]
    assert exported == _preview_pairs(body)


def test_preview_reports_a_broken_template_as_data(test_client, test_db, tmp_path):
    a = seed_image(test_db, tmp_path / "lib", "a")
    batch = create_batch(test_client, [a], name="T")
    test_client.patch(
        f"/api/batches/{batch['id']}/items/{a}", json={"output_name": "kept"}
    )

    body = _names(test_client, batch["id"], name_template="{batch}_{index}")

    assert body["template_error"]["token"] == "{index}"
    assert body["items"][0]["output_name"] is None
    assert body["duplicates"] == []


def test_preview_of_an_unknown_batch_is_404(test_client):
    response = test_client.post("/api/batches/999999/export/names", json={})

    assert response.status_code == 404
    assert response.json()["code"] == "batch_not_found"


def test_preview_rejects_unknown_fields(test_client, test_db, tmp_path):
    a = seed_image(test_db, tmp_path / "lib", "a")
    batch = create_batch(test_client, [a], name="T")

    response = test_client.post(
        f"/api/batches/{batch['id']}/export/names", json={"output_folder": "x"}
    )

    # Request validation errors answer 400 in this app (global handler).
    assert response.status_code == 400
