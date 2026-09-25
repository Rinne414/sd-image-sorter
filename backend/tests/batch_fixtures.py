"""Shared seeds for the batch tests: an isolated working folder and images that
really carry generation data in every place Pillow can write it."""

from __future__ import annotations

import base64
import io
import json
from pathlib import Path
from types import ModuleType

import pytest
from PIL import Image, PngImagePlugin

from library_context import reset_current_library_id, set_current_library_id

MARKER = "secret_prompt_marker_7f3a"
LIBRARY_HEADER = "X-SD-Library-Id"
GENERATION_PNG_KEYS = (
    "parameters",
    "Comment",
    "Description",
    "prompt",
    "workflow",
    "Software",
    "Source",
    "XML:com.adobe.xmp",
)
IMAGE_SIZE = (40, 30)


def isolate_batch_data_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Point the batch working folders at this test's temp directory.

    Test modules wrap this in an autouse fixture named ``batch_data_dir``.
    """
    from services import batch_workdir

    data_dir = tmp_path / "app-data"
    monkeypatch.setattr(batch_workdir, "get_data_dir", lambda: str(data_dir))
    return data_dir


def gradient_image(seed: int = 0) -> Image.Image:
    """Distinct per-pixel content so pixel comparisons are meaningful."""
    width, height = IMAGE_SIZE
    image = Image.new("RGB", IMAGE_SIZE)
    image.putdata(
        [
            ((x * 6 + seed) % 256, (y * 8 + seed * 3) % 256, (x * y + seed * 7) % 256)
            for y in range(height)
            for x in range(width)
        ]
    )
    return image


def censored_image() -> Image.Image:
    image = gradient_image(1)
    image.paste((0, 0, 0), (5, 5, 30, 25))
    return image


def _xmp_packet() -> bytes:
    return (
        '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF '
        'xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
        f'<rdf:Description prompt="{MARKER}"/></rdf:RDF></x:xmpmeta>'
    ).encode("utf-8")


def _exif_with_user_comment() -> bytes:
    from services.censor_service import CensorService

    carrier = Image.new("RGB", (1, 1))
    carrier.info["parameters"] = f"{MARKER}, Steps: 28, Sampler: Euler a"
    exif = CensorService._png_text_to_exif(carrier)
    assert exif is not None
    return exif


def write_png_with_generation_data(path: Path, seed: int = 0) -> Path:
    info = PngImagePlugin.PngInfo()
    info.add_text("parameters", f"{MARKER}\nNegative prompt: bad\nSteps: 28")
    info.add_text("Comment", json.dumps({"prompt": MARKER, "uc": "bad"}))
    info.add_text("Description", MARKER)
    info.add_text("prompt", json.dumps({"3": {"inputs": {"text": MARKER}}}))
    info.add_text("workflow", json.dumps({"nodes": [{"widgets_values": [MARKER]}]}))
    info.add_text("Software", "NovelAI")
    info.add_text("Source", f"NovelAI Diffusion {MARKER}")
    info.add_itxt("XML:com.adobe.xmp", _xmp_packet().decode("utf-8"))
    gradient_image(seed).save(
        path, format="PNG", pnginfo=info, exif=_exif_with_user_comment()
    )
    return path


def write_jpeg_with_generation_data(path: Path, seed: int = 0) -> Path:
    gradient_image(seed).save(
        path,
        format="JPEG",
        quality=95,
        exif=_exif_with_user_comment(),
        xmp=_xmp_packet(),
    )
    return path


def write_webp_with_generation_data(path: Path, seed: int = 0) -> Path:
    gradient_image(seed).save(
        path,
        format="WEBP",
        lossless=True,
        exif=_exif_with_user_comment(),
        xmp=_xmp_packet(),
    )
    return path


WRITERS = {
    "png": write_png_with_generation_data,
    "jpeg": write_jpeg_with_generation_data,
    "webp": write_webp_with_generation_data,
}
SUFFIXES = {"png": ".png", "jpeg": ".jpg", "webp": ".webp"}


def add_library_image(
    db: ModuleType,
    path: Path,
    library_id: str = "main",
) -> int:
    token = set_current_library_id(library_id)
    try:
        return int(db.add_image(path=str(path), filename=path.name, metadata_json="{}"))
    finally:
        reset_current_library_id(token)


def seed_image(
    db: ModuleType,
    folder: Path,
    name: str,
    kind: str = "png",
    seed: int = 0,
    library_id: str = "main",
) -> int:
    folder.mkdir(parents=True, exist_ok=True)
    path = WRITERS[kind](folder / f"{name}{SUFFIXES[kind]}", seed)
    return add_library_image(db, path, library_id)


def png_data_url(image: Image.Image, with_generation_text: bool = False) -> str:
    buffer = io.BytesIO()
    if with_generation_text:
        info = PngImagePlugin.PngInfo()
        info.add_text("parameters", MARKER)
        image.save(buffer, format="PNG", pnginfo=info)
    else:
        image.save(buffer, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode(
        "ascii"
    )


def create_batch(
    client,
    image_ids: list[int],
    name: str = "Set A",
    headers: dict[str, str] | None = None,
):
    response = client.post(
        "/api/batches",
        json={"kind": "pixiv", "name": name, "image_ids": image_ids},
        headers=headers or {},
    )
    assert response.status_code == 201, response.text
    return response.json()["batch"]


def save_censored(
    client,
    batch_id: int,
    image_id: int,
    image: Image.Image | None = None,
    headers: dict[str, str] | None = None,
):
    response = client.put(
        f"/api/batches/{batch_id}/items/{image_id}/censored",
        json={"image_data": png_data_url(image or censored_image())},
        headers=headers or {},
    )
    assert response.status_code == 200, response.text
    return response.json()


def assert_no_generation_data(path: Path) -> None:
    """Fail when any generation data survived in the file, in any container."""
    raw = path.read_bytes()
    assert MARKER.encode("utf-8") not in raw, f"{path.name} still carries the prompt"
    assert b"NovelAI" not in raw
    assert b"http://ns.adobe.com/xap/1.0/" not in raw
    with Image.open(path) as saved:
        saved.load()
        for key in GENERATION_PNG_KEYS:
            assert key not in saved.info, f"{path.name} keeps {key}"
        assert "exif" not in saved.info
        assert "xmp" not in saved.info
        assert len(saved.getexif()) == 0


def pixels(path_or_image) -> tuple[tuple[int, int], bytes]:
    """Size plus raw RGB bytes: equal only when every pixel is equal."""
    if isinstance(path_or_image, Image.Image):
        rgb = path_or_image.convert("RGB")
        return rgb.size, rgb.tobytes()
    with Image.open(path_or_image) as opened:
        rgb = opened.convert("RGB")
        return rgb.size, rgb.tobytes()
