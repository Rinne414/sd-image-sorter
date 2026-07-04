"""Tests for the publish-set workbench service (v3.5.0 Tier 1 — Pixiv publishing)."""
from __future__ import annotations

import pytest

from services import publish_service as ps


def _insert_image(conn, image_id, path, filename, *, width=512, height=512, size=1000):
    conn.execute(
        """
        INSERT INTO images (id, path, filename, width, height, file_size, user_rating)
        VALUES (?, ?, ?, ?, ?, ?, 0)
        """,
        (image_id, str(path), filename, width, height, size),
    )


def _write_png_bytes(path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(payload)


@pytest.fixture
def pub_env(test_db, tmp_path):
    """Library with three originals; one censored sibling on disk only, one
    censored variant indexed in the library from a different folder."""
    originals = tmp_path / "originals"
    elsewhere = tmp_path / "censor-output"

    _write_png_bytes(originals / "alpha.png", b"alpha-original")
    _write_png_bytes(originals / "alpha_censored.png", b"alpha-censored")  # disk-only sibling
    _write_png_bytes(originals / "beta.png", b"beta-original")
    _write_png_bytes(elsewhere / "beta_censored.jpg", b"beta-censored")     # indexed, other dir
    _write_png_bytes(originals / "gamma.png", b"gamma-original")

    conn = test_db.get_connection()
    try:
        _insert_image(conn, 1, originals / "alpha.png", "alpha.png")
        _insert_image(conn, 2, originals / "beta.png", "beta.png")
        _insert_image(conn, 3, originals / "gamma.png", "gamma.png")
        _insert_image(conn, 4, elsewhere / "beta_censored.jpg", "beta_censored.jpg")
        conn.commit()
    finally:
        conn.close()
    return {"originals": originals, "elsewhere": elsewhere, "tmp": tmp_path}


def test_sanitize_censor_suffix_strips_unsafe_and_defaults():
    assert ps.sanitize_censor_suffix("_censored") == "_censored"
    assert ps.sanitize_censor_suffix(" _mosaic! ") == "_mosaic"
    assert ps.sanitize_censor_suffix("../evil") == "evil"
    assert ps.sanitize_censor_suffix("") == "_censored"
    assert ps.sanitize_censor_suffix(None) == "_censored"


def test_pairs_found_in_same_directory_win_over_library(pub_env):
    result = ps.find_censor_pairs([1])
    entry = result["pairs"][0]
    assert entry["found"] is True
    assert entry["censored_source"] == "disk"
    assert entry["censored_filename"] == "alpha_censored.png"
    assert result["found_count"] == 1


def test_pairs_fall_back_to_library_match_in_another_folder(pub_env):
    result = ps.find_censor_pairs([2])
    entry = result["pairs"][0]
    assert entry["found"] is True
    assert entry["censored_source"] == "library"
    assert entry["censored_filename"] == "beta_censored.jpg"
    assert entry["censored_path"] == str(pub_env["elsewhere"] / "beta_censored.jpg")


def test_pairs_report_not_found_and_missing_ids_and_dedupe_order(pub_env):
    result = ps.find_censor_pairs([3, 999, 3, 1])
    assert [p["image_id"] for p in result["pairs"]] == [3, 999, 1]
    gamma, unknown, alpha = result["pairs"]
    assert gamma["found"] is False and gamma["missing"] is False
    assert unknown["missing"] is True
    assert alpha["found"] is True
    assert result["total"] == 3
    assert result["found_count"] == 1


def test_export_sequential_naming_and_order(pub_env):
    out = pub_env["tmp"] / "publish-out"
    result = ps.export_set(
        items=[{"image_id": 3}, {"image_id": 1}, {"image_id": 2}],
        output_folder=str(out),
        name_prefix="set_",
        start_index=1,
        pad_width=2,
    )
    assert result["success"] is True
    names = [e["output_name"] for e in result["exported"]]
    assert names == ["set_01.png", "set_02.png", "set_03.png"]
    assert (out / "set_01.png").read_bytes() == b"gamma-original"
    assert (out / "set_02.png").read_bytes() == b"alpha-original"
    assert result["caption_file"] is None


def test_export_uses_censored_variant_and_keeps_its_extension(pub_env):
    out = pub_env["tmp"] / "publish-censored"
    result = ps.export_set(
        items=[{"image_id": 1, "use_censored": True}, {"image_id": 2, "use_censored": True}],
        output_folder=str(out),
    )
    assert result["success"] is True
    assert [e["output_name"] for e in result["exported"]] == ["01.png", "02.jpg"]
    assert (out / "01.png").read_bytes() == b"alpha-censored"
    assert (out / "02.jpg").read_bytes() == b"beta-censored"
    assert all(e["used_censored"] for e in result["exported"])


def test_export_censored_missing_errors_instead_of_silent_fallback(pub_env):
    out = pub_env["tmp"] / "publish-strict"
    result = ps.export_set(
        items=[{"image_id": 3, "use_censored": True}, {"image_id": 1}],
        output_folder=str(out),
    )
    assert result["success"] is False
    assert len(result["errors"]) == 1
    assert result["errors"][0]["image_id"] == 3
    assert "censored" in result["errors"][0]["error"].lower()
    # The uncensored gamma.png must NOT appear under any exported name...
    exported_bytes = [(out / e["output_name"]).read_bytes() for e in result["exported"]]
    assert b"gamma-original" not in exported_bytes
    # ...while the untouched second item still exports with its positional number.
    assert result["exported"] == [{
        "index": 2, "output_name": "02.png", "image_id": 1,
        "used_censored": False, "source_path": str(pub_env["originals"] / "alpha.png"),
    }]


def test_export_skips_existing_unless_overwrite(pub_env):
    out = pub_env["tmp"] / "publish-existing"
    out.mkdir(parents=True)
    (out / "01.png").write_bytes(b"pre-existing")

    kept = ps.export_set(items=[{"image_id": 1}], output_folder=str(out))
    assert kept["exported"] == []
    assert kept["skipped_existing"] == [{"image_id": 1, "output_name": "01.png"}]
    assert (out / "01.png").read_bytes() == b"pre-existing"

    replaced = ps.export_set(items=[{"image_id": 1}], output_folder=str(out), overwrite=True)
    assert replaced["skipped_existing"] == []
    assert (out / "01.png").read_bytes() == b"alpha-original"


def test_export_writes_caption_file(pub_env):
    out = pub_env["tmp"] / "publish-caption"
    result = ps.export_set(
        items=[{"image_id": 1}],
        output_folder=str(out),
        caption_text="  set title\n#tag1 #tag2  ",
    )
    assert result["caption_file"] == "caption.txt"
    assert (out / "caption.txt").read_text(encoding="utf-8") == "set title\n#tag1 #tag2\n"


def test_export_rejects_traversal_output_folder(pub_env):
    with pytest.raises(ValueError):
        ps.export_set(items=[{"image_id": 1}], output_folder="../../evil-folder")


def test_export_unknown_id_keeps_later_numbers_stable(pub_env):
    out = pub_env["tmp"] / "publish-stable"
    result = ps.export_set(
        items=[{"image_id": 999}, {"image_id": 1}],
        output_folder=str(out),
        start_index=1,
    )
    assert result["errors"][0]["image_id"] == 999
    assert result["exported"][0]["index"] == 2
    assert result["exported"][0]["output_name"] == "02.png"


def test_export_clamps_pad_and_start_and_sanitizes_prefix(pub_env):
    out = pub_env["tmp"] / "publish-clamp"
    result = ps.export_set(
        items=[{"image_id": 1}],
        output_folder=str(out),
        name_prefix='se<t>:"|?*',
        start_index=7,
        pad_width=9,
    )
    entry = result["exported"][0]
    assert entry["index"] == 7
    # pad clamps to 4; sanitize_filename replaces OS-illegal chars with "_"
    assert entry["output_name"] == "se_t______0007.png"
