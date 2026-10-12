"""A batch item's censored copy and the editor state that produced it are one write.

The V4 censor editor sends the rendered copy together with its ops
(``item_state``). Either both become the new ones or both stay as they were:
a new copy must never sit next to old ops (the next edit would re-render the
old ops and silently drop censoring), and new ops must never sit next to an
old copy (the export would post a stale copy).
"""

from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import db_batches
import db_core
from tests.batch_fixtures import (
    censored_image,
    create_batch,
    gradient_image,
    isolate_batch_data_dir,
    pixels,
    png_data_url,
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
    "note": "kept by other steps",
}
STATE_B = {
    "censor": {
        "v": 1,
        "width": 40,
        "height": 30,
        "ops": [{"type": "stroke", "id": "a"}, {"type": "stroke", "id": "b"}],
    },
    "note": "kept by other steps",
}


class Item:
    def __init__(self, client, db, tmp_path: Path, data_dir: Path):
        self.client = client
        self.image_id = seed_image(db, tmp_path / "lib", "a")
        self.batch_id = create_batch(client, [self.image_id])["id"]
        self.url = f"/api/batches/{self.batch_id}/items/{self.image_id}/censored"
        self.folder = data_dir / "batches" / str(self.batch_id) / "censored"
        self.working = self.folder / f"{self.image_id}.png"

    def row(self) -> dict:
        return self.client.get(f"/api/batches/{self.batch_id}").json()["items"][0]

    def leftovers(self) -> list[str]:
        """Staging or set-aside files still in the working folder."""
        if not self.folder.is_dir():
            return []
        return sorted(
            entry.name for entry in self.folder.iterdir() if entry.name.startswith(".")
        )


@pytest.fixture
def item(test_client, test_db, tmp_path, batch_data_dir) -> Item:
    return Item(test_client, test_db, tmp_path, batch_data_dir)


def _save(client, item: Item, image, **extra):
    return client.put(item.url, json={"image_data": png_data_url(image), **extra})


def test_copy_and_state_are_saved_by_one_request(test_client, item):
    response = _save(test_client, item, censored_image(), item_state=STATE_A)

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["has_censored"] is True
    assert body["censored_at"]
    assert body["item_state"] == STATE_A
    assert pixels(item.working) == pixels(censored_image())
    row = item.row()
    assert row["has_censored"] is True
    assert row["item_state"] == STATE_A
    assert item.leftovers() == []


def test_without_item_state_the_state_is_left_as_it_was(test_client, item):
    patched = test_client.patch(
        f"/api/batches/{item.batch_id}/items/{item.image_id}",
        json={"item_state": STATE_A},
    )
    assert patched.status_code == 200

    response = _save(test_client, item, censored_image())

    assert response.status_code == 200, response.text
    assert item.row()["item_state"] == STATE_A
    assert item.row()["has_censored"] is True

    # an explicit null clears it, exactly like the item PATCH
    cleared = _save(test_client, item, censored_image(), item_state=None)
    assert cleared.status_code == 200
    assert item.row()["item_state"] is None


def test_item_state_must_be_an_object(test_client, item):
    response = _save(test_client, item, censored_image(), item_state=[1, 2])

    # the app answers request validation errors with 400
    assert response.status_code == 400
    assert item.row()["has_censored"] is False
    assert not item.working.exists()


def broken_touch(conn, batch_id):
    """Stands in for the batch row update: the database refuses the write."""
    raise sqlite3.OperationalError("disk I/O error (test)")


def _client_that_reports_errors(client) -> TestClient:
    return TestClient(client.app, raise_server_exceptions=False)


def test_a_failing_database_write_keeps_the_previous_copy_and_state(test_client, item):
    assert (
        _save(test_client, item, gradient_image(5), item_state=STATE_A).status_code
        == 200
    )
    previous = item.working.read_bytes()
    before = item.row()

    with pytest.MonkeyPatch.context() as broken:
        broken.setattr(db_batches, "_touch", broken_touch)
        response = _save(
            _client_that_reports_errors(test_client),
            item,
            censored_image(),
            item_state=STATE_B,
        )

    assert response.status_code == 500
    assert item.working.read_bytes() == previous
    after = item.row()
    assert after["item_state"] == STATE_A
    assert after["censored_at"] == before["censored_at"]
    assert item.leftovers() == []


def test_a_failed_commit_after_the_swap_puts_the_previous_copy_back(test_client, item):
    assert (
        _save(test_client, item, gradient_image(5), item_state=STATE_A).status_code
        == 200
    )
    previous = item.working.read_bytes()

    @contextmanager
    def commit_fails():
        # Reads pass; a connection that wrote something fails where it would commit.
        conn = db_core.get_connection()
        try:
            yield conn
            if conn.in_transaction:
                raise sqlite3.OperationalError("commit failed (test)")
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    with pytest.MonkeyPatch.context() as broken:
        broken.setattr(db_batches, "get_db", commit_fails)
        response = _save(
            _client_that_reports_errors(test_client),
            item,
            censored_image(),
            item_state=STATE_B,
        )

    assert response.status_code == 500
    assert item.working.read_bytes() == previous
    assert item.row()["item_state"] == STATE_A
    assert item.leftovers() == []


def test_a_first_save_that_fails_leaves_no_copy(test_client, item):
    with pytest.MonkeyPatch.context() as broken:
        broken.setattr(db_batches, "_touch", broken_touch)
        response = _save(
            _client_that_reports_errors(test_client),
            item,
            censored_image(),
            item_state=STATE_A,
        )

    assert response.status_code == 500
    assert not item.working.exists()
    row = item.row()
    assert row["has_censored"] is False
    assert row["item_state"] is None
    assert item.leftovers() == []


def test_discarding_can_set_the_state_in_the_same_request(test_client, item):
    assert (
        _save(test_client, item, censored_image(), item_state=STATE_A).status_code
        == 200
    )
    without_censor = {"note": "kept by other steps"}

    response = test_client.request(
        "DELETE", item.url, json={"item_state": without_censor}
    )

    assert response.status_code == 200, response.text
    assert response.json()["has_censored"] is False
    assert response.json()["item_state"] == without_censor
    assert not item.working.exists()
    assert item.row()["item_state"] == without_censor


def test_discarding_without_a_body_leaves_the_state_as_it_was(test_client, item):
    assert (
        _save(test_client, item, censored_image(), item_state=STATE_A).status_code
        == 200
    )

    response = test_client.delete(item.url)

    assert response.status_code == 200, response.text
    assert response.json()["has_censored"] is False
    assert item.row()["item_state"] == STATE_A
    assert not item.working.exists()


def test_a_failing_discard_keeps_the_copy_and_state(test_client, item):
    assert (
        _save(test_client, item, censored_image(), item_state=STATE_A).status_code
        == 200
    )
    previous = item.working.read_bytes()

    with pytest.MonkeyPatch.context() as broken:
        broken.setattr(db_batches, "_touch", broken_touch)
        response = _client_that_reports_errors(test_client).request(
            "DELETE", item.url, json={"item_state": {"note": "x"}}
        )

    assert response.status_code == 500
    assert item.working.read_bytes() == previous
    row = item.row()
    assert row["has_censored"] is True
    assert row["item_state"] == STATE_A
