"""HTTP contract of the moving-picture censor jobs."""

from __future__ import annotations

import time
from pathlib import Path

from PIL import Image

from routers import censor_media
from services import media_censor_service as media
from services.media_censor_service import MediaCensorJobs


def _gif(path: Path) -> Path:
    frames = []
    for index in range(3):
        frame = Image.new("RGB", (48, 48), (40 * index, 90, 120))
        frames.append(frame)
    frames[0].save(path, save_all=True, append_images=frames[1:], duration=80, loop=0)
    return path


def _fresh_jobs(monkeypatch) -> None:
    monkeypatch.setattr(censor_media, "_jobs", MediaCensorJobs(video_censor=None))
    monkeypatch.setattr(
        media.FrameDetector,
        "detect",
        lambda self, frame: [{"class": "pussy", "box": [8, 8, 30, 30]}],
    )


def _wait(client, job_id: str) -> dict:
    deadline = time.time() + 20
    while time.time() < deadline:
        snapshot = client.get(f"/api/censor/media/jobs/{job_id}").json()
        if snapshot["status"] in ("done", "done_with_errors", "cancelled"):
            return snapshot
        time.sleep(0.05)
    raise AssertionError("job did not finish")


def test_listing_a_folder_sorts_gifs_and_videos(test_client, tmp_path: Path) -> None:
    _gif(tmp_path / "a.gif")
    (tmp_path / "b.mp4").write_bytes(b"x")
    (tmp_path / "c.png").write_bytes(b"x")

    body = test_client.post(
        "/api/censor/media/list", json={"folder": str(tmp_path)}
    ).json()

    assert [Path(p).name for p in body["gifs"]] == ["a.gif"]
    assert [Path(p).name for p in body["videos"]] == ["b.mp4"]
    assert isinstance(body["video_ready"], bool)


def test_a_job_censors_the_folder_into_the_censored_subfolder(
    test_client, tmp_path: Path, monkeypatch
) -> None:
    _fresh_jobs(monkeypatch)
    _gif(tmp_path / "anim.gif")

    started = test_client.post(
        "/api/censor/media/start",
        json={
            "folder": str(tmp_path),
            "include_videos": False,
            "detect_every": 1,
            "style": "black",
        },
    ).json()
    snapshot = _wait(test_client, started["job_id"])

    assert started["output_folder"] == str(tmp_path / "censored")
    assert snapshot["status"] == "done"
    (item,) = snapshot["files"]
    assert Path(item["output"]) == tmp_path / "censored" / "anim_censored.gif"
    assert item["censored_frames"] == 3
    with Image.open(item["output"]) as result:
        assert result.convert("RGB").getpixel((15, 15)) == (0, 0, 0)


def test_reveal_opens_the_output_and_unknown_jobs_are_404(
    test_client, tmp_path: Path, monkeypatch
) -> None:
    _fresh_jobs(monkeypatch)
    _gif(tmp_path / "anim.gif")
    opened = []
    import app_diagnostics

    monkeypatch.setattr(
        app_diagnostics,
        "_open_path_in_file_manager",
        lambda path: opened.append(path) or True,
    )
    job_id = test_client.post(
        "/api/censor/media/start", json={"folder": str(tmp_path)}
    ).json()["job_id"]
    snapshot = _wait(test_client, job_id)

    assert test_client.post(f"/api/censor/media/jobs/{job_id}/reveal/0").json() == {
        "status": "ok"
    }
    assert opened == [Path(snapshot["files"][0]["output"])]
    assert (
        test_client.post(f"/api/censor/media/jobs/{job_id}/reveal/5").status_code == 404
    )
    assert test_client.get("/api/censor/media/jobs/nope").status_code == 404
    assert test_client.post("/api/censor/media/jobs/nope/cancel").status_code == 404


def test_bad_requests_are_refused(test_client, tmp_path: Path) -> None:
    (tmp_path / "empty").mkdir()

    no_media = test_client.post(
        "/api/censor/media/start", json={"folder": str(tmp_path / "empty")}
    )
    bad_style = test_client.post(
        "/api/censor/media/start", json={"folder": str(tmp_path), "style": "sparkles"}
    )
    missing = test_client.post(
        "/api/censor/media/list", json={"folder": str(tmp_path / "nope")}
    )

    assert no_media.status_code == 400
    assert bad_style.status_code == 400
    assert missing.status_code == 400
