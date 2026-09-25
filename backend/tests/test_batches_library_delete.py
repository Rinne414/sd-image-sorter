"""Deleting a library also deletes its batches, templates and working folders."""

from __future__ import annotations

from pathlib import Path

import pytest

import db_libraries as libdb
from tests.batch_fixtures import (
    LIBRARY_HEADER,
    create_batch,
    isolate_batch_data_dir,
    save_censored,
    seed_image,
)

TEMPLATE_BODY = {
    "kind": "pixiv",
    "name": "Quick",
    "steps": [{"id": "pick", "enabled": True}, {"id": "export", "enabled": True}],
}


@pytest.fixture(autouse=True)
def batch_data_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    return isolate_batch_data_dir(tmp_path, monkeypatch)


def _count(db, sql: str, params: tuple) -> int:
    with db.get_db() as conn:
        return int(conn.execute(sql, params).fetchone()[0])


def test_deleting_a_library_removes_its_batches_templates_and_working_folders(
    test_client, test_db, tmp_path, batch_data_dir
):
    libdb.ensure_default_library()
    doomed = libdb.create_library("Doomed pack")["id"]
    doomed_headers = {LIBRARY_HEADER: doomed}
    main_image = seed_image(test_db, tmp_path / "main", "m")
    doomed_image = seed_image(test_db, tmp_path / "doomed", "d", library_id=doomed)

    kept = create_batch(test_client, [main_image], name="Kept")
    save_censored(test_client, kept["id"], main_image)
    kept_template = test_client.post("/api/batches/templates", json=TEMPLATE_BODY)
    assert kept_template.status_code == 201
    gone = create_batch(
        test_client, [doomed_image], name="Gone", headers=doomed_headers
    )
    save_censored(test_client, gone["id"], doomed_image, headers=doomed_headers)
    assert (
        test_client.post(
            "/api/batches/templates", json=TEMPLATE_BODY, headers=doomed_headers
        ).status_code
        == 201
    )
    kept_folder = batch_data_dir / "batches" / str(kept["id"])
    gone_folder = batch_data_dir / "batches" / str(gone["id"])
    assert kept_folder.is_dir() and gone_folder.is_dir()

    response = test_client.delete(f"/api/libraries/{doomed}")

    assert response.status_code == 200, response.text
    assert response.json()["removed_batches"] == 1
    assert response.json()["removed_batch_templates"] == 1
    assert not gone_folder.exists()
    assert kept_folder.is_dir()
    for table in ("batches", "batch_templates"):
        assert (
            _count(
                test_db, f"SELECT COUNT(*) FROM {table} WHERE library_id = ?", (doomed,)
            )
            == 0
        )
    assert (
        _count(
            test_db,
            "SELECT COUNT(*) FROM batch_items WHERE batch_id = ?",
            (gone["id"],),
        )
        == 0
    )
    assert (tmp_path / "doomed" / "d.png").is_file()

    kept_after = test_client.get(f"/api/batches/{kept['id']}").json()
    assert [item["image_id"] for item in kept_after["items"]] == [main_image]
    assert kept_after["items"][0]["has_censored"] is True
    templates = test_client.get("/api/batches/templates").json()["templates"]
    assert [template["id"] for template in templates] == [kept_template.json()["id"]]
