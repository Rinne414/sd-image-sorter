"""POST /api/videos/which: which of some image ids are videos (picture-only actions leave them out)."""

from __future__ import annotations

from PIL import Image

import db_videos
from image_manager import scan_folder
from services import video_index


def test_which_are_videos_names_the_videos_among_the_ids(
    test_db, test_client, tmp_path, monkeypatch
):
    monkeypatch.setattr(video_index.VideoIndexer, "kick", lambda self: None)
    Image.new("RGB", (8, 8), (10, 20, 30)).save(tmp_path / "pic.png")
    (tmp_path / "clip.mp4").write_bytes(b"not a real video")
    scan_folder(str(tmp_path), quick_import=True, precise_total=False)
    video_id = db_videos.pending_videos(10)[0]["id"]
    rows = test_client.get("/api/images", params={"limit": 10}).json()["images"]
    picture_id = next(r["id"] for r in rows if r["id"] != video_id)

    answer = test_client.post(
        "/api/videos/which",
        json={"image_ids": [picture_id, video_id, video_id, 987654]},
    )

    assert answer.status_code == 200
    assert answer.json() == {"video_ids": [video_id]}


def test_which_are_videos_with_nothing_asked_answers_nothing(test_db, test_client):
    assert test_client.post("/api/videos/which", json={"image_ids": []}).json() == {
        "video_ids": []
    }
