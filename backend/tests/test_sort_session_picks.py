"""V4 Sort tab: a manual sort session started from picked images.

- POST /api/sort/start accepts ``image_ids`` (the picks, in pick order) instead
  of a filter; ids that are not readable images of the current library drop out.
- Every session payload carries ``slot_counts`` (images sent to each slot), so a
  reloaded page can show the per-slot tallies again.
- A finished session still reports its totals, folders and counts, so the
  summary survives a reload.
"""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))


def _add_image(db, folder: Path, name: str) -> int:
    from PIL import Image

    path = folder / name
    Image.new("RGB", (32, 32), color="white").save(path)
    return db.add_image(
        path=str(path),
        filename=name,
        generator="unknown",
        width=32,
        height=32,
        file_size=path.stat().st_size,
        metadata_json="{}",
    )


@pytest.fixture
def sort_client(test_client, tmp_path, monkeypatch):
    import services.sorting_service as sorting_module
    from routers.sorting import set_sorting_service
    from services.sorting_service import SortingService

    monkeypatch.setattr(
        sorting_module, "SESSION_FILE", str(tmp_path / "state" / "sort-session.json")
    )
    monkeypatch.setattr(
        sorting_module,
        "LEGACY_SESSION_FILE",
        str(tmp_path / "legacy-sort-session.json"),
    )
    set_sorting_service(SortingService())
    yield test_client
    set_sorting_service(SortingService())


def test_start_from_picks_keeps_pick_order_and_drops_unknown_ids(sort_client, tmp_path):
    db = sort_client.test_db
    src = tmp_path / "src"
    src.mkdir()
    first = _add_image(db, src, "a.png")
    second = _add_image(db, src, "b.png")
    third = _add_image(db, src, "c.png")
    unreadable = _add_image(db, src, "d.png")
    db.mark_image_unreadable(unreadable, "broken")

    response = sort_client.post(
        "/api/sort/start",
        json={
            "image_ids": [third, first, third, 999999, unreadable, second],
            "folders": {"w": str(tmp_path / "keep")},
            "operation_mode": "move",
        },
    )

    assert response.status_code == 200
    data = response.json()
    assert data["total_images"] == 3
    assert data["current"]["id"] == third
    current = sort_client.get("/api/sort/current").json()
    assert current["image_ids"] == [third, first, second]


def test_picks_from_another_library_are_not_sorted(sort_client, tmp_path):
    db = sort_client.test_db
    src = tmp_path / "src"
    src.mkdir()
    mine = _add_image(db, src, "mine.png")
    theirs = _add_image(db, src, "theirs.png")
    with db.get_db() as conn:
        conn.execute("UPDATE images SET library_id = 'other' WHERE id = ?", (theirs,))

    response = sort_client.post("/api/sort/start", json={"image_ids": [theirs, mine]})

    assert response.status_code == 200
    assert response.json()["total_images"] == 1
    assert sort_client.get("/api/sort/current").json()["image_ids"] == [mine]


def test_slot_counts_follow_moves_and_undo(sort_client, tmp_path):
    db = sort_client.test_db
    src = tmp_path / "src"
    src.mkdir()
    ids = [_add_image(db, src, f"{n}.png") for n in range(4)]
    keep = tmp_path / "keep"
    later = tmp_path / "later"

    started = sort_client.post(
        "/api/sort/start",
        json={"image_ids": ids, "folders": {"w": str(keep), "a": str(later)}},
    )
    assert started.status_code == 200

    sort_client.post("/api/sort/action?action=move&folder_key=w")
    sort_client.post("/api/sort/action?action=skip")
    after_move = sort_client.post("/api/sort/action?action=move&folder_key=a").json()
    assert after_move["slot_counts"] == {"w": 1, "a": 1}
    assert after_move["skipped_count"] == 1
    assert (later / "2.png").exists()

    undone = sort_client.post("/api/sort/action?action=undo").json()
    assert undone["slot_counts"] == {"w": 1}
    assert (src / "2.png").exists()
    assert not (later / "2.png").exists()

    current = sort_client.get("/api/sort/current").json()
    assert current["slot_counts"] == {"w": 1}
    assert current["index"] == 2


def test_finished_session_still_reports_its_summary(sort_client, tmp_path):
    db = sort_client.test_db
    src = tmp_path / "src"
    src.mkdir()
    ids = [_add_image(db, src, f"{n}.png") for n in range(2)]
    keep = tmp_path / "keep"

    sort_client.post(
        "/api/sort/start",
        json={"image_ids": ids, "folders": {"d": str(keep)}, "operation_mode": "copy"},
    )
    sort_client.post("/api/sort/action?action=move&folder_key=d")
    done = sort_client.post("/api/sort/action?action=skip").json()
    assert done["done"] is True
    assert done["slot_counts"] == {"d": 1}

    summary = sort_client.get("/api/sort/current").json()
    assert summary["done"] is True
    assert summary["total"] == 2
    assert summary["index"] == 2
    assert summary["image_ids"] == ids
    assert summary["folders"] == {"d": str(keep)}
    assert summary["operation_mode"] == "copy"
    assert summary["slot_counts"] == {"d": 1}
    assert summary["skipped_count"] == 1
    assert summary["undo_available"] is True
    assert (src / "0.png").exists()
    assert (keep / "0.png").exists()


def test_every_answer_names_the_library_the_sorted_images_belong_to(sort_client, tmp_path):
    db = sort_client.test_db
    src = tmp_path / "src"
    src.mkdir()
    ids = [_add_image(db, src, f"{n}.png") for n in range(2)]
    with db.get_db() as conn:
        conn.execute("UPDATE images SET library_id = 'other' WHERE id IN (?, ?)", tuple(ids))

    assert sort_client.get("/api/sort/current").json()["library_id"] is None

    other = {"X-SD-Library-Id": "other"}
    started = sort_client.post("/api/sort/start", json={"image_ids": ids, "mode": "cull"}, headers=other)
    assert started.status_code == 200
    # Asked from another library, the session still says where its images live.
    assert sort_client.get("/api/sort/current").json()["library_id"] == "other"
    kept = sort_client.post("/api/sort/action?action=keep").json()
    assert kept["library_id"] == "other"
    assert kept["decision"] == "keep"
