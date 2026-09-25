"""Pixiv export from a batch: censored copies first, generation data stripped by
default, never a silent fall back to the uncensored original (D18)."""

from __future__ import annotations

from pathlib import Path

import pytest
from PIL import Image

from services import batch_export_service
from services.batch_naming import BatchNameTemplateError, render_output_stem
from tests.batch_fixtures import (
    MARKER,
    assert_no_generation_data,
    censored_image,
    create_batch,
    isolate_batch_data_dir,
    gradient_image,
    pixels,
    save_censored,
    seed_image,
)


@pytest.fixture(autouse=True)
def batch_data_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    return isolate_batch_data_dir(tmp_path, monkeypatch)


def _export(client, batch_id: int, out_dir: Path, **options):
    return client.post(
        f"/api/batches/{batch_id}/export",
        json={"output_folder": str(out_dir), **options},
    )


def _files(folder: Path) -> list[str]:
    if not folder.exists():
        return []
    return sorted(path.name for path in folder.iterdir())


# --- name template ---------------------------------------------------------


def test_name_template_tokens_render():
    assert (
        render_output_stem("{batch}_{n:02}", batch="Set", number=3, original="x")
        == "Set_03"
    )
    assert (
        render_output_stem("{n}-{original}", batch="Set", number=12, original="img")
        == "12-img"
    )
    assert render_output_stem("p{n:04}", batch="Set", number=7, original="x") == "p0007"


@pytest.mark.parametrize(
    "template", ["{batch}_{index}", "{n:2}", "{batch", "a}b", "{}"]
)
def test_name_template_rejects_unknown_or_broken_tokens(template):
    with pytest.raises(BatchNameTemplateError):
        render_output_stem(template, batch="Set", number=1, original="x")


# --- censored copies and metadata -------------------------------------------


def test_strip_export_uses_censored_copies_and_removes_all_generation_data(
    test_client, test_db, tmp_path, batch_data_dir
):
    a = seed_image(test_db, tmp_path / "lib", "a", seed=1)
    b = seed_image(test_db, tmp_path / "lib", "b", seed=2)
    batch = create_batch(test_client, [a, b], name="Autumn")
    save_censored(test_client, batch["id"], a)
    save_censored(test_client, batch["id"], b)
    out_dir = tmp_path / "out"

    response = _export(test_client, batch["id"], out_dir)

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["success"] is True
    assert [item["output_name"] for item in body["exported"]] == [
        "Autumn_01.png",
        "Autumn_02.png",
    ]
    assert all(item["source"] == "censored" for item in body["exported"])
    assert all(item["generation_data_removed"] is True for item in body["exported"])
    for name in ("Autumn_01.png", "Autumn_02.png"):
        assert_no_generation_data(out_dir / name)
        assert pixels(out_dir / name) == pixels(censored_image())
        assert pixels(out_dir / name) != pixels(gradient_image(1))


@pytest.mark.parametrize("source_kind", ["png", "jpeg", "webp"])
@pytest.mark.parametrize("output_format", ["original", "png", "jpg", "webp"])
def test_strip_removes_generation_data_for_every_source_and_output_format(
    test_client, test_db, tmp_path, batch_data_dir, source_kind, output_format
):
    image_id = seed_image(test_db, tmp_path / "lib", "src", kind=source_kind)
    batch = create_batch(test_client, [image_id], name="Fmt")
    out_dir = tmp_path / "out"

    response = _export(
        test_client,
        batch["id"],
        out_dir,
        missing_censored="original",
        output_format=output_format,
    )

    assert response.status_code == 200, response.text
    exported = response.json()["exported"]
    assert len(exported) == 1
    assert exported[0]["source"] == "original"
    assert exported[0]["generation_data_removed"] is True
    expected_suffix = {
        "original": {"png": ".png", "jpeg": ".jpg", "webp": ".webp"}[source_kind],
        "png": ".png",
        "jpg": ".jpg",
        "webp": ".webp",
    }[output_format]
    assert exported[0]["output_name"] == f"Fmt_01{expected_suffix}"
    assert_no_generation_data(out_dir / exported[0]["output_name"])


def test_censored_copy_exported_as_jpeg_and_webp_carries_no_generation_data(
    test_client, test_db, tmp_path, batch_data_dir
):
    image_id = seed_image(test_db, tmp_path / "lib", "a", kind="jpeg")
    batch = create_batch(test_client, [image_id], name="C")
    save_censored(test_client, batch["id"], image_id)

    for output_format, suffix in (
        ("jpg", ".jpg"),
        ("webp", ".webp"),
        ("original", ".jpg"),
    ):
        out_dir = tmp_path / f"out-{output_format}"
        response = _export(
            test_client, batch["id"], out_dir, output_format=output_format
        )
        assert response.status_code == 200, response.text
        assert response.json()["exported"][0]["output_name"] == f"C_01{suffix}"
        assert_no_generation_data(out_dir / f"C_01{suffix}")


def test_keep_preserves_the_original_generation_data(
    test_client, test_db, tmp_path, batch_data_dir
):
    kept_original = seed_image(test_db, tmp_path / "lib", "orig", seed=3)
    kept_censored = seed_image(test_db, tmp_path / "lib", "cens", seed=4)
    batch = create_batch(test_client, [kept_original, kept_censored], name="K")
    save_censored(test_client, batch["id"], kept_censored)
    out_dir = tmp_path / "out"

    response = _export(
        test_client,
        batch["id"],
        out_dir,
        metadata_option="keep",
        missing_censored="original",
    )

    assert response.status_code == 200, response.text
    exported = {item["image_id"]: item for item in response.json()["exported"]}
    assert exported[kept_original]["generation_data_removed"] is False
    assert exported[kept_censored]["generation_data_removed"] is False
    original_path = tmp_path / "lib" / "orig.png"
    assert (out_dir / "K_01.png").read_bytes() == original_path.read_bytes()
    with Image.open(out_dir / "K_02.png") as censored_out:
        censored_out.load()
        assert MARKER in censored_out.info["parameters"]
    assert pixels(out_dir / "K_02.png") == pixels(censored_image())


def test_minimal_drops_generation_data(test_client, test_db, tmp_path, batch_data_dir):
    image_id = seed_image(test_db, tmp_path / "lib", "a")
    batch = create_batch(test_client, [image_id], name="M")
    save_censored(test_client, batch["id"], image_id)

    response = _export(
        test_client, batch["id"], tmp_path / "out", metadata_option="minimal"
    )

    assert response.status_code == 200, response.text
    assert response.json()["exported"][0]["generation_data_removed"] is True
    assert_no_generation_data(tmp_path / "out" / "M_01.png")


# --- missing censored copies --------------------------------------------------


def test_block_refuses_when_a_censored_copy_is_missing_and_writes_nothing(
    test_client, test_db, tmp_path, batch_data_dir
):
    a = seed_image(test_db, tmp_path / "lib", "a", seed=1)
    b = seed_image(test_db, tmp_path / "lib", "b", seed=2)
    batch = create_batch(test_client, [a, b], name="Blk")
    save_censored(test_client, batch["id"], a)
    out_dir = tmp_path / "out"

    response = _export(test_client, batch["id"], out_dir, caption_text="hello")

    assert response.status_code == 409
    detail = response.json()
    assert detail["code"] == "batch_export_missing_censored"
    assert detail["missing"] == [{"image_id": b, "filename": "b.png"}]
    assert _files(out_dir) == []


def test_skip_exports_only_censored_items_with_consecutive_numbers(
    test_client, test_db, tmp_path, batch_data_dir
):
    a = seed_image(test_db, tmp_path / "lib", "a", seed=1)
    b = seed_image(test_db, tmp_path / "lib", "b", seed=2)
    c = seed_image(test_db, tmp_path / "lib", "c", seed=3)
    batch = create_batch(test_client, [a, b, c], name="Skp")
    save_censored(test_client, batch["id"], a)
    save_censored(test_client, batch["id"], c)
    out_dir = tmp_path / "out"

    response = _export(test_client, batch["id"], out_dir, missing_censored="skip")

    assert response.status_code == 200, response.text
    body = response.json()
    assert [(i["image_id"], i["output_name"]) for i in body["exported"]] == [
        (a, "Skp_01.png"),
        (c, "Skp_02.png"),
    ]
    assert body["skipped"] == [
        {"image_id": b, "filename": "b.png", "reason": "no_censored_copy"}
    ]
    assert _files(out_dir) == ["Skp_01.png", "Skp_02.png"]


def test_original_policy_exports_the_original_but_still_strips(
    test_client, test_db, tmp_path, batch_data_dir
):
    a = seed_image(test_db, tmp_path / "lib", "a", seed=5)
    batch = create_batch(test_client, [a], name="Org")

    response = _export(
        test_client, batch["id"], tmp_path / "out", missing_censored="original"
    )

    assert response.status_code == 200, response.text
    item = response.json()["exported"][0]
    assert item["source"] == "original"
    assert item["used_censored"] is False
    assert_no_generation_data(tmp_path / "out" / "Org_01.png")
    assert pixels(tmp_path / "out" / "Org_01.png") == pixels(gradient_image(5))


def test_a_censored_copy_deleted_from_disk_counts_as_missing(
    test_client, test_db, tmp_path, batch_data_dir
):
    a = seed_image(test_db, tmp_path / "lib", "a")
    batch = create_batch(test_client, [a], name="Gone")
    save_censored(test_client, batch["id"], a)
    (batch_data_dir / "batches" / str(batch["id"]) / "censored" / f"{a}.png").unlink()

    response = _export(test_client, batch["id"], tmp_path / "out")

    assert response.status_code == 409
    assert response.json()["missing"][0]["image_id"] == a
    assert _files(tmp_path / "out") == []


# --- names, conflicts, extras --------------------------------------------------


def test_template_tokens_start_number_and_per_item_override(
    test_client, test_db, tmp_path, batch_data_dir
):
    a = seed_image(test_db, tmp_path / "lib", "alpha", seed=1)
    b = seed_image(test_db, tmp_path / "lib", "beta", seed=2)
    batch = create_batch(test_client, [a, b], name="Set")
    save_censored(test_client, batch["id"], a)
    save_censored(test_client, batch["id"], b)
    test_client.patch(
        f"/api/batches/{batch['id']}/items/{b}", json={"output_name": "cover.png"}
    )

    response = _export(
        test_client,
        batch["id"],
        tmp_path / "out",
        name_template="{batch}-{n:03}-{original}",
        start_number=7,
    )

    assert response.status_code == 200, response.text
    assert [i["output_name"] for i in response.json()["exported"]] == [
        "Set-007-alpha.png",
        "cover.png",
    ]


def test_invalid_name_template_is_rejected_before_writing(
    test_client, test_db, tmp_path, batch_data_dir
):
    a = seed_image(test_db, tmp_path / "lib", "a")
    batch = create_batch(test_client, [a], name="T")
    save_censored(test_client, batch["id"], a)

    response = _export(
        test_client, batch["id"], tmp_path / "out", name_template="{bogus}"
    )

    assert response.status_code == 422
    assert response.json()["code"] == "batch_export_name_template_invalid"
    assert _files(tmp_path / "out") == []


def test_duplicate_output_names_are_rejected_with_the_list(
    test_client, test_db, tmp_path, batch_data_dir
):
    a = seed_image(test_db, tmp_path / "lib", "a", seed=1)
    b = seed_image(test_db, tmp_path / "lib", "b", seed=2)
    c = seed_image(test_db, tmp_path / "lib", "c", seed=3)
    batch = create_batch(test_client, [a, b, c], name="Dup")
    for image_id in (a, b, c):
        save_censored(test_client, batch["id"], image_id)
    test_client.patch(
        f"/api/batches/{batch['id']}/items/{c}", json={"output_name": "DUP_01"}
    )

    response = _export(test_client, batch["id"], tmp_path / "out")

    assert response.status_code == 422
    detail = response.json()
    assert detail["code"] == "batch_export_duplicate_names"
    assert detail["duplicates"] == [{"output_name": "Dup_01.png", "image_ids": [a, c]}]
    assert _files(tmp_path / "out") == []


def test_existing_files_need_overwrite(test_client, test_db, tmp_path, batch_data_dir):
    a = seed_image(test_db, tmp_path / "lib", "a")
    batch = create_batch(test_client, [a], name="Ow")
    save_censored(test_client, batch["id"], a)
    out_dir = tmp_path / "out"
    out_dir.mkdir()
    (out_dir / "Ow_01.png").write_bytes(b"older export")

    refused = _export(test_client, batch["id"], out_dir)
    assert refused.status_code == 409
    assert refused.json()["code"] == "batch_export_files_exist"
    assert refused.json()["existing"] == ["Ow_01.png"]
    assert (out_dir / "Ow_01.png").read_bytes() == b"older export"

    replaced = _export(test_client, batch["id"], out_dir, overwrite=True)
    assert replaced.status_code == 200, replaced.text
    assert replaced.json()["exported"][0]["overwrote_existing"] is True
    assert pixels(out_dir / "Ow_01.png") == pixels(censored_image())


def test_caption_and_watermark(test_client, test_db, tmp_path, batch_data_dir):
    a = seed_image(test_db, tmp_path / "lib", "a")
    batch = create_batch(test_client, [a], name="W")
    save_censored(test_client, batch["id"], a)
    out_dir = tmp_path / "out"

    response = _export(
        test_client,
        batch["id"],
        out_dir,
        caption_text="  My set  ",
        watermark={
            "enabled": True,
            "text": "@me",
            "position": "center",
            "size_percent": 20,
        },
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["caption_file"] == "caption.txt"
    assert (out_dir / "caption.txt").read_bytes() == b"My set\n"
    assert body["exported"][0]["watermarked"] is True
    assert pixels(out_dir / "W_01.png") != pixels(censored_image())
    assert_no_generation_data(out_dir / "W_01.png")


def test_invalid_output_folder_is_rejected(
    test_client, test_db, tmp_path, batch_data_dir
):
    a = seed_image(test_db, tmp_path / "lib", "a")
    batch = create_batch(test_client, [a], name="Bad")
    save_censored(test_client, batch["id"], a)

    response = _export(test_client, batch["id"], Path("..") / ".." / "escape")

    assert response.status_code == 400


def test_export_of_unknown_batch_is_404(test_client, tmp_path, batch_data_dir):
    assert _export(test_client, 424242, tmp_path / "out").status_code == 404


# --- failures while writing ------------------------------------------------------


def test_original_policy_refuses_when_the_original_file_is_gone(
    test_client, test_db, tmp_path, batch_data_dir
):
    a = seed_image(test_db, tmp_path / "lib", "a", seed=1)
    b = seed_image(test_db, tmp_path / "lib", "b", seed=2)
    batch = create_batch(test_client, [a, b], name="Lost")
    save_censored(test_client, batch["id"], a)
    (tmp_path / "lib" / "b.png").unlink()
    out_dir = tmp_path / "out"

    response = _export(test_client, batch["id"], out_dir, missing_censored="original")

    assert response.status_code == 409
    assert response.json()["code"] == "batch_export_sources_missing"
    assert response.json()["missing"] == [{"image_id": b, "filename": "b.png"}]
    assert _files(out_dir) == []


def test_a_failing_item_is_reported_and_never_replaced_by_its_original(
    test_client, test_db, tmp_path, batch_data_dir, monkeypatch
):
    a = seed_image(test_db, tmp_path / "lib", "a", seed=1)
    b = seed_image(test_db, tmp_path / "lib", "b", seed=2)
    batch = create_batch(test_client, [a, b], name="P")
    save_censored(test_client, batch["id"], a)
    save_censored(test_client, batch["id"], b)
    real_load = batch_export_service._load_pixels

    def load_or_fail(item, keep_orientation_tag):
        if item.image_id == a:
            raise OSError("censored copy unreadable")
        return real_load(item, keep_orientation_tag=keep_orientation_tag)

    monkeypatch.setattr(batch_export_service, "_load_pixels", load_or_fail)
    out_dir = tmp_path / "out"

    response = _export(test_client, batch["id"], out_dir, missing_censored="original")

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["success"] is False
    assert body["errors"] == [
        {"image_id": a, "filename": "a.png", "error": "censored copy unreadable"}
    ]
    assert [
        (i["image_id"], i["output_name"], i["source"]) for i in body["exported"]
    ] == [(b, "P_02.png", "censored")]
    assert _files(out_dir) == ["P_02.png"]
    assert pixels(out_dir / "P_02.png") == pixels(censored_image())


def test_an_interrupted_byte_copy_leaves_the_previous_export_intact(
    test_client, test_db, tmp_path, batch_data_dir, monkeypatch
):
    a = seed_image(test_db, tmp_path / "lib", "a")
    batch = create_batch(test_client, [a], name="K")
    out_dir = tmp_path / "out"
    out_dir.mkdir()
    previous = out_dir / "K_01.png"
    previous.write_bytes(b"previous export")

    def interrupted_copy(reader, writer, length=0):
        writer.write(reader.read(64))
        raise OSError("disk full")

    monkeypatch.setattr(batch_export_service.shutil, "copyfileobj", interrupted_copy)

    response = _export(
        test_client,
        batch["id"],
        out_dir,
        metadata_option="keep",
        missing_censored="original",
        overwrite=True,
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["success"] is False
    assert body["exported"] == []
    assert body["errors"][0]["image_id"] == a
    assert "disk full" in body["errors"][0]["error"]
    assert previous.read_bytes() == b"previous export"
    assert _files(out_dir) == ["K_01.png"]
