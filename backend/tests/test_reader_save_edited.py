"""Regression tests for Reader save-as-new metadata edits.

Bug 15 (MEDIUM): POST /api/image-metadata/save-edited returned 500
  with "UnhandledException" when the output path landed in a system-
  protected directory (e.g. C:\\Windows\\System32\\). Now returns 403
  with the OS reason.

Bug 16 (LOW): The endpoint accepted format="" and silently fell
  through to whatever default the writer picked, instead of rejecting
  the validation early. Now Pydantic enforces min_length=1 on format.
"""
from __future__ import annotations

import shutil
from pathlib import Path

import pytest
from PIL import Image
from PIL.PngImagePlugin import PngInfo


def _make_test_png(path: Path, *, prompt: str = "1girl, masterpiece") -> None:
    img = Image.new("RGB", (128, 128), color=(50, 100, 150))
    info = PngInfo()
    info.add_text("parameters", f"{prompt}\nSteps: 20, CFG scale: 7")
    img.save(path, pnginfo=info)


def test_save_edited_rejects_empty_format(test_client, tmp_path: Path):
    """format='' must fail Pydantic validation, not silently coerce."""
    src = tmp_path / "in.png"
    out = tmp_path / "out.png"
    _make_test_png(src)

    response = test_client.post("/api/image-metadata/save-edited", json={
        "source_path": str(src),
        "output_path": str(out),
        "format": "",
        "metadata": {"prompt": "test"},
        "allow_overwrite": True,
    })
    assert response.status_code in (400, 422), response.text
    body = response.json()
    # FastAPI validation errors expose the problem field somewhere
    text = response.text.lower()
    assert "format" in text or "string" in text


def test_save_edited_rejects_empty_source_path(test_client, tmp_path: Path):
    """source_path='' must fail validation."""
    response = test_client.post("/api/image-metadata/save-edited", json={
        "source_path": "",
        "output_path": str(tmp_path / "out.png"),
        "format": "png",
        "metadata": {},
        "allow_overwrite": True,
    })
    assert response.status_code in (400, 422), response.text


def test_save_edited_permission_denied_returns_403_not_500(test_client, tmp_path: Path):
    """Writing to a system directory must return 403, not a 500
    'UnhandledException' that looks like a server crash."""
    src = tmp_path / "src.png"
    _make_test_png(src)

    # Pick a path the test process cannot write to. On Windows,
    # C:\Windows\System32 is locked. On Linux/CI we use /proc which
    # is non-writable to user processes.
    import platform
    if platform.system() == "Windows":
        bad_output = "C:\\Windows\\System32\\bughunt-evil.png"
    else:
        bad_output = "/proc/bughunt-evil.png"

    response = test_client.post("/api/image-metadata/save-edited", json={
        "source_path": str(src),
        "output_path": bad_output,
        "format": "png",
        "metadata": {"prompt": "evil"},
        "allow_overwrite": True,
    })
    # Should NOT be 500. Acceptable: 400 (path validation rejected the
    # write up-front) or 403 (OS denied write at write time).
    assert response.status_code != 500, (
        f"Save-as-new should not 500 when destination is unwritable. "
        f"Got: {response.status_code} {response.text}"
    )
    assert response.status_code in (400, 403), response.text
    # Should not leak Python internals like "UnhandledException"
    assert "UnhandledException" not in response.text


def test_save_edited_unicode_metadata_preserved(test_client, tmp_path: Path):
    """CJK characters and emojis in prompt/model fields must round-trip."""
    src = tmp_path / "src.png"
    out = tmp_path / "out.png"
    _make_test_png(src)

    cjk_prompt = "一个女孩, 学校制服, 樱花飘落 🌸"
    response = test_client.post("/api/image-metadata/save-edited", json={
        "source_path": str(src),
        "output_path": str(out),
        "format": "png",
        "metadata": {
            "prompt": cjk_prompt,
            "negative_prompt": "bad hands",
            "steps": 25,
            "seed": 99999,
            "model": "anima_v3",
        },
        "allow_overwrite": True,
    })
    assert response.status_code == 200, response.text

    saved = Image.open(out)
    parameters = saved.info.get("parameters", "")
    assert cjk_prompt in parameters or "一个女孩" in parameters, (
        f"CJK lost in save-as-new: {parameters[:200]!r}"
    )
    assert "🌸" in parameters, "emoji lost in save-as-new"
    assert "Seed: 99999" in parameters, "seed lost"


def test_save_edited_blocks_source_eq_output_without_flag(test_client, tmp_path: Path):
    """Saving over the source file requires allow_overwrite=True."""
    src = tmp_path / "src.png"
    _make_test_png(src)

    response = test_client.post("/api/image-metadata/save-edited", json={
        "source_path": str(src),
        "output_path": str(src),
        "format": "png",
        "metadata": {"prompt": "edited"},
        "allow_overwrite": False,
    })
    assert response.status_code == 409, response.text
