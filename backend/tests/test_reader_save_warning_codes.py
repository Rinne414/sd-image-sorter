"""Reader save-edited: every warning also comes back as a code with its values.

The ``warnings`` strings are English only. V4 translates the save warnings, so
``POST /api/image-metadata/save-edited`` returns ``warning_codes`` next to them:
one ``{"code", "params"}`` entry per warning, in the same order, with the
values a sentence needs (the chunk names, the format, the frame count). The
English list is unchanged for V3.5.
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image
from PIL.PngImagePlugin import PngInfo

from services.image_metadata_writer import (
    ANIMATION_FLATTENED_WARNING,
    DROPPED_PARAMETER_SETTINGS_WARNING,
    JPEG_ALPHA_WARNING,
    JPEG_LIMITATION_WARNING,
    PRESERVED_GENERATION_RECORD_WARNING,
    UNCARRIED_CHUNKS_WARNING,
    WEBP_LIMITATION_WARNING,
    warning_codes_for,
)
from services.indexed_file_mutation_service import RECONCILE_WARNING


def _png_with_chunks(
    path: Path, *, mode: str = "RGB", parameters: str | None = None, comfy: bool = False
) -> None:
    color = (50, 100, 150, 128) if mode == "RGBA" else (50, 100, 150)
    img = Image.new(mode, (64, 64), color=color)
    info = PngInfo()
    if parameters is not None:
        info.add_text("parameters", parameters)
    if comfy:
        info.add_text(
            "prompt", '{"3": {"class_type": "KSampler", "inputs": {"seed": 1}}}'
        )
        info.add_text("workflow", '{"nodes": []}')
    img.save(path, pnginfo=info)


def _save(test_client, src: Path, out: Path, fmt: str, metadata: dict | None = None):
    response = test_client.post(
        "/api/image-metadata/save-edited",
        json={
            "source_path": str(src),
            "output_path": str(out),
            "format": fmt,
            "metadata": metadata or {"prompt": "1girl, edited"},
            "allow_overwrite": False,
        },
    )
    assert response.status_code == 200, response.text
    return response.json()


def test_jpeg_save_names_every_warning_by_code(test_client, tmp_path: Path):
    src = tmp_path / "src.png"
    _png_with_chunks(
        src, mode="RGBA", parameters="1girl\nSteps: 20, CFG scale: 7", comfy=True
    )

    body = _save(test_client, src, tmp_path / "out.jpg", "jpg")

    codes = body["warning_codes"]
    assert len(codes) == len(body["warnings"])
    by_code = {entry["code"]: entry["params"] for entry in codes}
    assert by_code["jpeg_limited"] == {}
    assert by_code["jpeg_alpha_flattened"] == {}
    assert by_code["chunks_not_carried"] == {
        "format": "JPEG",
        "keys": ["prompt", "workflow"],
    }
    # The English list V3.5 shows is untouched.
    assert JPEG_LIMITATION_WARNING in body["warnings"]
    assert JPEG_ALPHA_WARNING in body["warnings"]


def test_png_save_reports_kept_record_and_dropped_settings(test_client, tmp_path: Path):
    src = tmp_path / "src.png"
    _png_with_chunks(
        src, parameters="1girl\nSteps: 20, Clip skip: 2, Model hash: abcd", comfy=True
    )

    body = _save(
        test_client,
        src,
        tmp_path / "out.png",
        "png",
        {"prompt": "1girl, edited", "steps": 20},
    )

    by_code = {entry["code"]: entry["params"] for entry in body["warning_codes"]}
    assert by_code["record_preserved"] == {"keys": ["prompt", "workflow"]}
    assert by_code["settings_dropped"] == {"keys": ["Clip skip", "Model hash"]}
    assert [entry["code"] for entry in body["warning_codes"]] == [
        "settings_dropped",
        "record_preserved",
    ]


def test_webp_save_and_a_clean_png_save(test_client, tmp_path: Path):
    src = tmp_path / "src.png"
    _png_with_chunks(src, parameters="1girl\nSteps: 20")

    webp = _save(
        test_client,
        src,
        tmp_path / "out.webp",
        "webp",
        {"prompt": "1girl", "steps": 20},
    )
    assert [entry["code"] for entry in webp["warning_codes"]] == ["webp_limited"]

    clean = _save(
        test_client, src, tmp_path / "out.png", "png", {"prompt": "1girl", "steps": 20}
    )
    assert clean["warnings"] == []
    assert clean["warning_codes"] == []


def test_each_known_warning_maps_to_its_code():
    warnings = [
        JPEG_LIMITATION_WARNING,
        WEBP_LIMITATION_WARNING,
        JPEG_ALPHA_WARNING,
        PRESERVED_GENERATION_RECORD_WARNING.format(keys="Comment, prompt"),
        UNCARRIED_CHUNKS_WARNING.format(label="WebP", keys="workflow"),
        ANIMATION_FLATTENED_WARNING.format(label="JPEG", frames=12),
        DROPPED_PARAMETER_SETTINGS_WARNING.format(keys="Clip skip"),
        RECONCILE_WARNING,
        "Something new the writer says.",
    ]

    assert warning_codes_for(warnings) == [
        {"code": "jpeg_limited", "params": {}},
        {"code": "webp_limited", "params": {}},
        {"code": "jpeg_alpha_flattened", "params": {}},
        {"code": "record_preserved", "params": {"keys": ["Comment", "prompt"]}},
        {
            "code": "chunks_not_carried",
            "params": {"format": "WebP", "keys": ["workflow"]},
        },
        {"code": "animation_flattened", "params": {"format": "JPEG", "frames": 12}},
        {"code": "settings_dropped", "params": {"keys": ["Clip skip"]}},
        {"code": "library_refresh_failed", "params": {}},
        {"code": "other", "params": {"text": "Something new the writer says."}},
    ]
