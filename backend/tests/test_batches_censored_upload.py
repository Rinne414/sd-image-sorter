"""The censored copy as a binary upload (multipart), for pictures of any size.

``PUT /api/batches/{id}/items/{image_id}/censored/file`` takes the PNG (or
lossless WebP) bytes as the ``file`` part and the editor state as the
``item_state`` JSON text part. It writes exactly like the JSON PUT (copy and
state together or neither, metadata stripped) but has no 40 MB / 40 MP cap:
only Pillow's decompression-bomb limit stops a picture, with a clear 413.
"""

from __future__ import annotations

import io
import json
import sqlite3
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image, PngImagePlugin

import db_batches
from tests.batch_fixtures import (
    assert_no_generation_data,
    censored_image,
    create_batch,
    gradient_image,
    isolate_batch_data_dir,
    pixels,
    seed_image,
)


@pytest.fixture(autouse=True)
def batch_data_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    return isolate_batch_data_dir(tmp_path, monkeypatch)


STATE_A = {
    "censor": {
        "v": 1,
        "width": 40,
        "height": 30,
        "ops": [{"type": "stroke", "id": "a"}],
    },
    "note": "kept",
}
STATE_B = {
    "censor": {"v": 1, "width": 40, "height": 30, "ops": [], "reviewed": True},
    "note": "kept",
}


class Item:
    def __init__(self, client, db, tmp_path: Path, data_dir: Path):
        self.client = client
        self.image_id = seed_image(db, tmp_path / "lib", "a")
        self.batch_id = create_batch(client, [self.image_id])["id"]
        self.url = f"/api/batches/{self.batch_id}/items/{self.image_id}/censored/file"
        self.folder = data_dir / "batches" / str(self.batch_id) / "censored"
        self.working = self.folder / f"{self.image_id}.png"

    def row(self) -> dict:
        return self.client.get(f"/api/batches/{self.batch_id}").json()["items"][0]

    def leftovers(self) -> list[str]:
        if not self.folder.is_dir():
            return []
        return sorted(e.name for e in self.folder.iterdir() if e.name.startswith("."))


@pytest.fixture
def item(test_client, test_db, tmp_path, batch_data_dir) -> Item:
    return Item(test_client, test_db, tmp_path, batch_data_dir)


def png_bytes(image: Image.Image, with_text: bool = False, fmt: str = "PNG") -> bytes:
    buffer = io.BytesIO()
    kwargs = {"lossless": True} if fmt == "WEBP" else {}
    if with_text:
        info = PngImagePlugin.PngInfo()
        info.add_text("parameters", "masterpiece, secret prompt, Steps: 28")
        kwargs["pnginfo"] = info
    image.save(buffer, format=fmt, **kwargs)
    return buffer.getvalue()


def upload(client, item: Item, data: bytes, state=..., mime: str = "image/png"):
    form = {} if state is ... else {"item_state": json.dumps(state)}
    return client.put(item.url, files={"file": ("copy", data, mime)}, data=form)


def test_the_copy_and_state_are_one_write_and_metadata_is_stripped(test_client, item):
    response = upload(
        test_client, item, png_bytes(censored_image(), with_text=True), STATE_A
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["has_censored"] is True
    assert body["item_state"] == STATE_A
    assert pixels(item.working) == pixels(censored_image())
    assert_no_generation_data(item.working)
    assert item.row()["item_state"] == STATE_A
    assert item.leftovers() == []


def test_lossless_webp_is_stored_as_the_same_pixels(test_client, item):
    response = upload(
        test_client,
        item,
        png_bytes(gradient_image(3), fmt="WEBP"),
        STATE_A,
        "image/webp",
    )

    assert response.status_code == 200, response.text
    assert pixels(item.working) == pixels(gradient_image(3))


def test_item_state_rules_match_the_json_put(test_client, item):
    assert (
        upload(test_client, item, png_bytes(censored_image()), STATE_A).status_code
        == 200
    )
    # no item_state part: the state stays as it was
    assert upload(test_client, item, png_bytes(gradient_image(1))).status_code == 200
    assert item.row()["item_state"] == STATE_A
    # JSON null clears it
    assert (
        upload(test_client, item, png_bytes(censored_image()), None).status_code == 200
    )
    assert item.row()["item_state"] is None
    # anything but an object is refused and changes nothing
    refused = upload(test_client, item, png_bytes(gradient_image(2)), [1, 2])
    assert refused.status_code == 400
    bad_json = test_client.put(
        item.url,
        files={"file": ("copy", png_bytes(gradient_image(2)), "image/png")},
        data={"item_state": "{not json"},
    )
    assert bad_json.status_code == 400
    assert pixels(item.working) == pixels(censored_image())


def test_not_an_image_is_refused(test_client, item):
    response = upload(test_client, item, b"this is not a picture", STATE_A)
    assert response.status_code == 400
    assert not item.working.exists()


def broken_touch(conn, batch_id):
    raise sqlite3.OperationalError("disk I/O error (test)")


def test_a_failing_database_write_keeps_the_previous_copy_and_state(test_client, item):
    assert (
        upload(test_client, item, png_bytes(gradient_image(5)), STATE_A).status_code
        == 200
    )
    previous = item.working.read_bytes()

    with pytest.MonkeyPatch.context() as broken:
        broken.setattr(db_batches, "_touch", broken_touch)
        client = TestClient(test_client.app, raise_server_exceptions=False)
        response = upload(client, item, png_bytes(censored_image()), STATE_B)

    assert response.status_code == 500
    assert item.working.read_bytes() == previous
    assert item.row()["item_state"] == STATE_A
    assert item.leftovers() == []


def test_a_picture_over_40_megapixels_is_accepted(test_client, item):
    big = Image.new("RGB", (8200, 5000), (90, 120, 150))

    response = upload(test_client, item, png_bytes(big), STATE_B)

    assert response.status_code == 200, response.text
    with Image.open(item.working) as saved:
        assert saved.size == (8200, 5000)


def test_a_decompression_bomb_is_refused_with_its_pixel_count(
    test_client, item, monkeypatch
):
    monkeypatch.setattr(Image, "MAX_IMAGE_PIXELS", 1000)

    response = upload(test_client, item, png_bytes(Image.new("RGB", (50, 40))), STATE_A)

    assert response.status_code == 413
    assert "2,000" in response.json()["error"]
    assert not item.working.exists()
    assert item.row()["has_censored"] is False
