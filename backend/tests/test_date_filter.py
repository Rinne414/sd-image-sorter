"""File-time date range filter (timeline-eval memo 2026-07-12, roadmap #12).

Filters on COALESCE(library_order_time, created_at) — the newest/oldest sort
key, i.e. the file's FIRST-SEEN mtime. Both bounds are inclusive whole days;
the SQL upper bound is half-open on the next day via date(?, '+1 day') so
'2026-05-02 23:59:59' still matches date_to=2026-05-02.

The gallery listing hides rows whose file is missing on disk, so seeding
must create real image files (selection-ids does not check the disk).
"""

import sys
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).parent.parent))

import database as db

STAMPS = [
    "2026-05-01 08:00:00",
    "2026-05-02 23:59:59",
    "2026-05-03 00:00:00",
    "2026-06-15 12:00:00",
]


def _seed(tmp_path, stamps=STAMPS):
    """One real PNG per 'YYYY-MM-DD HH:MM:SS' library_order_time value."""
    src = tmp_path / "datefilter-src"
    src.mkdir(exist_ok=True)
    ids = []
    for index, stamp in enumerate(stamps):
        path = src / f"df_{index}.png"
        Image.new("RGB", (16, 16), color=(index * 40, 80, 120)).save(path)
        image_id = db.add_image(path=str(path), filename=path.name, metadata_json="{}")
        with db.get_connection() as conn:
            conn.execute(
                "UPDATE images SET library_order_time = ?, created_at = ? WHERE id = ?",
                (stamp, stamp, image_id),
            )
        ids.append(image_id)
    return ids


def _listed_ids(test_client, **params):
    response = test_client.get("/api/images", params={"limit": 100, **params})
    assert response.status_code == 200, response.text
    return {img["id"] for img in response.json()["images"]}


def test_date_range_is_inclusive_whole_days(test_client, test_db, tmp_path):
    ids = _seed(tmp_path)
    got = _listed_ids(test_client, date_from="2026-05-01", date_to="2026-05-02")
    assert got == {ids[0], ids[1]}, "end day must include 23:59:59"


def test_date_from_only_and_date_to_only(test_client, test_db, tmp_path):
    ids = _seed(tmp_path)
    assert _listed_ids(test_client, date_from="2026-05-03") == {ids[2], ids[3]}
    assert _listed_ids(test_client, date_to="2026-05-02") == {ids[0], ids[1]}


def test_single_day(test_client, test_db, tmp_path):
    ids = _seed(tmp_path)
    assert _listed_ids(test_client, date_from="2026-05-02", date_to="2026-05-02") == {
        ids[1]
    }


def test_count_endpoint_honors_date_range(test_client, test_db, tmp_path):
    _seed(tmp_path)
    response = test_client.get(
        "/api/images/count",
        params={"date_from": "2026-05-01", "date_to": "2026-05-31"},
    )
    assert response.status_code == 200, response.text
    assert response.json()["total"] == 3


def test_selection_ids_honors_camel_case_date_range(test_client, test_db, tmp_path):
    ids = _seed(tmp_path)
    response = test_client.post(
        "/api/images/selection-ids",
        json={"dateFrom": "2026-06-01", "dateTo": "2026-06-30"},
    )
    assert response.status_code == 200, response.text
    assert response.json()["image_ids"] == [ids[3]]


def test_invalid_date_format_is_400(test_client, test_db, tmp_path):
    _seed(tmp_path, STAMPS[:1])
    response = test_client.get(
        "/api/images", params={"limit": 10, "date_from": "05/01/2026"}
    )
    assert response.status_code == 400
    assert "error" in response.json()
    response = test_client.post(
        "/api/images/selection-ids", json={"dateFrom": "not-a-date"}
    )
    assert response.status_code == 400
