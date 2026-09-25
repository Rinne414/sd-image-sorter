"""Publish-set exports must not carry generation data unless the user keeps it.

A publish set is headed for a public platform. Exporting used to copy the
source bytes, so every PNG text chunk, EXIF block and XMP packet (the full
prompt, model and seed) went out with it; only the unrelated watermark option
happened to re-encode. These tests read the exported files back.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from PIL import Image, PngImagePlugin

from services import publish_service as ps
from services.watermark_service import TextWatermarkConfig

SECRET = "masterpiece, secret prompt 7c1f"
XMP_PACKET = (
    '<x:xmpmeta xmlns:x="adobe:ns:meta/">'
    '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
    '<rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/">'
    f"<dc:description>{SECRET}</dc:description>"
    "</rdf:Description></rdf:RDF></x:xmpmeta>"
)
GENERATION_INFO_KEYS = {
    "parameters",
    "Comment",
    "Description",
    "prompt",
    "workflow",
    "Software",
    "Source",
    "XML:com.adobe.xmp",
    "xmp",
    "exif",
    "comment",
}


def _exif_bytes() -> bytes:
    exif = Image.Exif()
    exif[0x010E] = SECRET  # ImageDescription
    exif[0x0131] = "NovelAI"  # Software
    exif.get_ifd(0x8769)[0x9286] = b"ASCII\x00\x00\x00" + SECRET.encode(
        "ascii"
    )  # UserComment
    return exif.tobytes()


def _pixels() -> Image.Image:
    image = Image.new("RGB", (48, 32), (20, 40, 60))
    for x in range(48):
        image.putpixel((x, x % 32), (200, 10 + x, 90))
    return image


def _write_source(path: Path, fmt: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    image = _pixels()
    if fmt == "png":
        info = PngImagePlugin.PngInfo()
        info.add_text(
            "parameters", f"{SECRET}\nSteps: 28, Sampler: Euler a, Seed: 1234"
        )
        info.add_itxt("Comment", '{"prompt": "%s", "uc": "lowres"}' % SECRET)
        info.add_text("Description", SECRET)
        info.add_text("Software", "NovelAI")
        info.add_text("Source", "NovelAI Diffusion V4.5")
        info.add_text("prompt", '{"3": {"inputs": {"text": "%s"}}}' % SECRET)
        info.add_text("workflow", '{"nodes": [{"widgets_values": ["%s"]}]}' % SECRET)
        info.add_itxt("XML:com.adobe.xmp", XMP_PACKET)
        image.save(path, format="PNG", pnginfo=info, exif=_exif_bytes())
    elif fmt == "jpg":
        image.save(
            path,
            format="JPEG",
            quality=95,
            exif=_exif_bytes(),
            xmp=XMP_PACKET.encode("utf-8"),
            comment=SECRET.encode("ascii"),
        )
    elif fmt == "webp":
        image.save(
            path,
            format="WEBP",
            lossless=True,
            exif=_exif_bytes(),
            xmp=XMP_PACKET.encode("utf-8"),
        )
    else:  # pragma: no cover - test helper misuse
        raise ValueError(fmt)


def _insert_image(conn, image_id: int, path: Path) -> None:
    conn.execute(
        """
        INSERT INTO images (id, path, filename, width, height, file_size, user_rating)
        VALUES (?, ?, ?, 48, 32, ?, 0)
        """,
        (image_id, str(path), path.name, path.stat().st_size),
    )


def _assert_no_generation_info(path: Path) -> None:
    raw = path.read_bytes()
    assert SECRET.encode("ascii") not in raw, (
        f"{path.name} still carries the prompt text"
    )
    assert b"NovelAI" not in raw, f"{path.name} still names the generator"
    with Image.open(path) as exported:
        leaked = GENERATION_INFO_KEYS & set(exported.info)
        assert not leaked, f"{path.name} still has metadata keys {sorted(leaked)}"
        assert not dict(exported.getexif()), f"{path.name} still has EXIF tags"


def _seed_library(db_module, tmp_path):
    sources = tmp_path / "sources"
    paths = {
        1: sources / "nai-portrait.png",
        2: sources / "webui-portrait.jpg",
        3: sources / "comfy-portrait.webp",
    }
    _write_source(paths[1], "png")
    _write_source(paths[2], "jpg")
    _write_source(paths[3], "webp")
    conn = db_module.get_connection()
    try:
        for image_id, path in paths.items():
            _insert_image(conn, image_id, path)
        conn.commit()
    finally:
        conn.close()
    return {"paths": paths, "tmp": tmp_path}


@pytest.fixture
def meta_env(test_db, tmp_path):
    return _seed_library(test_db, tmp_path)


@pytest.fixture
def api_env(test_client, tmp_path):
    # test_client switches the app to its own database, so seed that one.
    return _seed_library(test_client.test_db, tmp_path)


@pytest.mark.parametrize(
    "image_id, extension", [(1, ".png"), (2, ".jpg"), (3, ".webp")]
)
def test_default_export_removes_generation_info(meta_env, image_id, extension):
    out = meta_env["tmp"] / f"out-default-{image_id}"
    result = ps.export_set(items=[{"image_id": image_id}], output_folder=str(out))

    assert result["success"] is True, result["errors"]
    exported = out / f"01{extension}"
    _assert_no_generation_info(exported)
    assert result["exported"][0]["metadata"] == "strip"
    with (
        Image.open(exported) as image,
        Image.open(meta_env["paths"][image_id]) as source,
    ):
        assert image.size == source.size
        if extension in {".png", ".webp"}:
            # Lossless formats: stripping must not touch a single pixel.
            assert image.convert("RGB").tobytes() == source.convert("RGB").tobytes()


@pytest.mark.parametrize("image_id", [1, 2, 3])
def test_keep_option_exports_the_source_file_unchanged(meta_env, image_id):
    out = meta_env["tmp"] / f"out-keep-{image_id}"
    result = ps.export_set(
        items=[{"image_id": image_id}],
        output_folder=str(out),
        metadata_option="keep",
    )

    assert result["success"] is True, result["errors"]
    exported = out / result["exported"][0]["output_name"]
    assert exported.read_bytes() == meta_env["paths"][image_id].read_bytes()
    assert result["exported"][0]["metadata"] == "keep"


@pytest.mark.parametrize("image_id", [1, 2, 3])
def test_minimal_option_drops_generation_info(meta_env, image_id):
    out = meta_env["tmp"] / f"out-minimal-{image_id}"
    result = ps.export_set(
        items=[{"image_id": image_id}],
        output_folder=str(out),
        metadata_option="minimal",
    )

    assert result["success"] is True, result["errors"]
    _assert_no_generation_info(out / result["exported"][0]["output_name"])


@pytest.mark.parametrize("image_id", [1, 2, 3])
def test_watermarked_export_also_removes_generation_info(meta_env, image_id):
    out = meta_env["tmp"] / f"out-watermark-{image_id}"
    result = ps.export_set(
        items=[{"image_id": image_id}],
        output_folder=str(out),
        watermark=TextWatermarkConfig(
            enabled=True,
            text="@artist",
            position="bottom_right",
            opacity=90,
            size_percent=8,
            margin_percent=2,
            color="#FFFFFF",
        ),
    )

    assert result["success"] is True, result["errors"]
    _assert_no_generation_info(out / result["exported"][0]["output_name"])


def test_unknown_metadata_option_is_rejected(meta_env):
    with pytest.raises(ValueError):
        ps.export_set(
            items=[{"image_id": 1}],
            output_folder=str(meta_env["tmp"] / "out-bad"),
            metadata_option="sometimes",
        )


def test_explicit_censored_path_is_exported_instead_of_guessing_by_name(meta_env):
    staged = meta_env["tmp"] / "staging" / "renamed-by-censor-page.png"
    staged.parent.mkdir(parents=True)
    censored = _pixels()
    censored.paste((0, 0, 0), (0, 0, 24, 16))
    info = PngImagePlugin.PngInfo()
    info.add_text("parameters", SECRET)
    censored.save(staged, format="PNG", pnginfo=info)

    out = meta_env["tmp"] / "out-staged"
    result = ps.export_set(
        items=[{"image_id": 1, "use_censored": True, "censored_path": str(staged)}],
        output_folder=str(out),
    )

    assert result["success"] is True, result["errors"]
    entry = result["exported"][0]
    assert entry["used_censored"] is True
    assert entry["source_path"] == str(staged)
    exported = out / entry["output_name"]
    _assert_no_generation_info(exported)
    with Image.open(exported) as image:
        assert image.convert("RGB").getpixel((1, 1)) == (0, 0, 0)


def test_missing_explicit_censored_file_fails_instead_of_exporting_the_original(
    meta_env,
):
    out = meta_env["tmp"] / "out-staged-missing"
    result = ps.export_set(
        items=[
            {
                "image_id": 1,
                "use_censored": True,
                "censored_path": str(meta_env["tmp"] / "gone.png"),
            }
        ],
        output_folder=str(out),
    )

    assert result["success"] is False
    assert result["exported"] == []
    assert result["errors"][0]["image_id"] == 1
    assert not out.exists() or not any(out.iterdir())


def test_output_name_from_the_censor_page_is_used_with_the_real_extension(meta_env):
    out = meta_env["tmp"] / "out-named"
    result = ps.export_set(
        items=[
            {"image_id": 2, "output_name": "set_001.png"},
            {"image_id": 1},
        ],
        output_folder=str(out),
    )

    assert result["success"] is True, result["errors"]
    assert [entry["output_name"] for entry in result["exported"]] == [
        "set_001.jpg",
        "02.png",
    ]


def test_duplicate_output_names_fail_instead_of_overwriting_each_other(meta_env):
    out = meta_env["tmp"] / "out-dupe"
    result = ps.export_set(
        items=[
            {"image_id": 1, "output_name": "cover"},
            {"image_id": 1, "output_name": "COVER.png"},
        ],
        output_folder=str(out),
        metadata_option="keep",
    )

    assert [entry["output_name"] for entry in result["exported"]] == ["cover.png"]
    assert result["errors"][0]["image_id"] == 1
    assert "Duplicate" in result["errors"][0]["error"]


def test_export_endpoint_defaults_to_removing_generation_info(api_env, test_client):
    out = api_env["tmp"] / "out-api"
    response = test_client.post(
        "/api/publish/export",
        json={
            "items": [{"image_id": 1, "use_censored": False}],
            "output_folder": str(out),
        },
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["success"] is True
    assert body["metadata_option"] == "strip"
    _assert_no_generation_info(out / "01.png")


def test_export_endpoint_keeps_generation_info_when_asked(api_env, test_client):
    out = api_env["tmp"] / "out-api-keep"
    response = test_client.post(
        "/api/publish/export",
        json={
            "items": [{"image_id": 1}],
            "output_folder": str(out),
            "metadata_option": "keep",
        },
    )

    assert response.status_code == 200, response.text
    assert (out / "01.png").read_bytes() == api_env["paths"][1].read_bytes()


def test_export_endpoint_rejects_unknown_metadata_option(api_env, test_client):
    response = test_client.post(
        "/api/publish/export",
        json={
            "items": [{"image_id": 1}],
            "output_folder": str(api_env["tmp"] / "out-api-bad"),
            "metadata_option": "sometimes",
        },
    )

    # The app answers request-validation errors with 400.
    assert response.status_code == 400


def test_staging_folder_is_fresh_and_replaces_earlier_hand_overs(tmp_path, monkeypatch):
    root = tmp_path / "publish-staging"
    monkeypatch.setattr(ps, "_staging_root", lambda: root)
    unrelated = root / "keep-me"
    unrelated.mkdir(parents=True)

    first = Path(ps.create_staging_folder()["folder"])
    (first / "01.png").write_bytes(b"censored")
    second = Path(ps.create_staging_folder()["folder"])

    assert second.is_dir() and not any(second.iterdir())
    assert second.parent == root
    assert not first.exists()
    assert unrelated.is_dir()
