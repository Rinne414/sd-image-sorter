"""Auto-censor for moving pictures: GIF frames, detect-every / hold, and the job runner."""

from __future__ import annotations

import time
from pathlib import Path

import pytest
from PIL import Image, ImageSequence, ImageStat

from services import media_censor_service as media
from services.media_censor_service import FrameSettings, MediaCensorJobs, RegionTracker


def _checker(size=(96, 96)) -> Image.Image:
    image = Image.new("RGB", size)
    pixels = image.load()
    for x in range(size[0]):
        for y in range(size[1]):
            pixels[x, y] = (255, 255, 255) if (x // 2 + y // 2) % 2 else (0, 0, 0)
    return image


def _write_gif(path: Path, frames: int = 4, duration: int = 120, loop: int = 3) -> Path:
    pictures = []
    for index in range(frames):
        picture = _checker()
        # Pillow merges identical consecutive frames, so each one gets its own mark.
        picture.paste((255, 0, 0), (index * 4, 90, index * 4 + 4, 94))
        pictures.append(picture)
    pictures[0].save(
        path, save_all=True, append_images=pictures[1:], duration=duration, loop=loop
    )
    return path


def test_the_tracker_detects_every_nth_frame_and_reuses_in_between() -> None:
    calls = []

    def detect(frame):
        calls.append(frame)
        return [{"box": [0, 0, 5, 5]}]

    tracker = RegionTracker(detect, detect_every=3, hold=0)

    results = [tracker.regions(Image.new("RGB", (8, 8))) for _ in range(7)]

    assert len(calls) == 3  # frames 0, 3, 6
    assert all(result == [{"box": [0, 0, 5, 5]}] for result in results)


def test_the_tracker_holds_regions_briefly_after_they_vanish() -> None:
    answers = iter([[{"box": [1, 1, 4, 4]}], [], [], [], []])
    tracker = RegionTracker(lambda frame: next(answers), detect_every=1, hold=2)

    results = [bool(tracker.regions(Image.new("RGB", (8, 8)))) for _ in range(5)]

    assert results == [True, True, True, False, False]


def test_a_gif_keeps_its_frames_timing_and_loop_and_gets_the_mosaic(
    tmp_path: Path, monkeypatch
) -> None:
    source = _write_gif(tmp_path / "anim.gif")
    target = tmp_path / "out" / "anim_censored.gif"
    monkeypatch.setattr(
        media.FrameDetector,
        "detect",
        lambda self, frame: [{"class": "pussy", "box": [24, 24, 72, 72]}],
    )
    seen = []

    censored = media.censor_gif(
        source,
        target,
        FrameSettings(detect_every=1),
        lambda d, t: seen.append((d, t)),
        lambda: False,
    )

    assert censored == 4
    assert seen[-1] == (4, 4)
    with Image.open(target) as result:
        assert result.n_frames == 4
        assert result.info.get("loop") == 3
        frames = [
            frame.convert("RGB").copy() for frame in ImageSequence.Iterator(result)
        ]
        assert all(
            frame.info.get("duration", 120) == 120
            for frame in ImageSequence.Iterator(result)
        )
    inside = ImageStat.Stat(frames[2].crop((28, 28, 68, 68)).convert("L")).stddev[0]
    outside = ImageStat.Stat(frames[2].crop((0, 0, 20, 20)).convert("L")).stddev[0]
    assert inside < outside / 3


def test_a_frame_with_nothing_found_is_left_as_it_was(
    tmp_path: Path, monkeypatch
) -> None:
    source = _write_gif(tmp_path / "clean.gif", frames=2)
    monkeypatch.setattr(media.FrameDetector, "detect", lambda self, frame: [])

    censored = media.censor_gif(
        source,
        tmp_path / "clean_censored.gif",
        FrameSettings(),
        lambda d, t: None,
        lambda: False,
    )

    assert censored == 0
    with Image.open(tmp_path / "clean_censored.gif") as result, Image.open(source) as original:
        assert result.convert("RGB").tobytes() == original.convert("RGB").tobytes()


def test_media_is_listed_by_kind_and_outputs_never_overwrite(tmp_path: Path) -> None:
    for name in ("b.gif", "a.MP4", "note.txt", "c.webm"):
        (tmp_path / name).write_bytes(b"x")
    (tmp_path / "sub").mkdir()
    (tmp_path / "sub" / "d.gif").write_bytes(b"x")
    (tmp_path / "b_censored.gif").write_bytes(b"old")

    listed = media.list_media(tmp_path)

    assert [Path(p).name for p in listed["gifs"]] == ["b.gif", "b_censored.gif"]
    assert [Path(p).name for p in listed["videos"]] == ["a.MP4", "c.webm"]
    assert (
        media.free_output_path(tmp_path, tmp_path / "b.gif", ".gif").name
        == "b_censored_2.gif"
    )


def _wait(job, statuses=("done", "done_with_errors", "cancelled"), seconds=20):
    deadline = time.time() + seconds
    while time.time() < deadline:
        snapshot = job.snapshot()
        if snapshot["status"] in statuses:
            return snapshot
        time.sleep(0.02)
    raise AssertionError(f"job stuck at {job.snapshot()}")


def test_a_job_runs_its_files_and_reports_each_one(tmp_path: Path, monkeypatch) -> None:
    gif = _write_gif(tmp_path / "one.gif", frames=2)
    video = tmp_path / "clip.mp4"
    video.write_bytes(b"not really a video")
    monkeypatch.setattr(
        media.FrameDetector, "detect", lambda self, frame: [{"box": [10, 10, 40, 40]}]
    )
    jobs = MediaCensorJobs(video_censor=None)

    snapshot = _wait(
        jobs.start([str(gif), str(video)], str(tmp_path / "out"), FrameSettings())
    )

    by_name = {item["name"]: item for item in snapshot["files"]}
    assert snapshot["status"] == "done_with_errors"
    assert by_name["one.gif"]["status"] == "done"
    assert Path(by_name["one.gif"]["output"]).name == "one_censored.gif"
    assert by_name["one.gif"]["censored_frames"] == 2
    assert by_name["clip.mp4"]["status"] == "error"
    assert snapshot["done"] == snapshot["total"] == 2


def test_a_cancelled_job_stops_and_skips_the_rest(tmp_path: Path, monkeypatch) -> None:
    gifs = [str(_write_gif(tmp_path / f"g{index}.gif", frames=3)) for index in range(3)]
    jobs = MediaCensorJobs()

    def slow_detect(self, frame):
        time.sleep(0.05)
        return []

    monkeypatch.setattr(media.FrameDetector, "detect", slow_detect)
    job = jobs.start(gifs, str(tmp_path / "out"), FrameSettings(detect_every=1))
    jobs.cancel(job.id)

    snapshot = _wait(job)

    assert snapshot["status"] == "cancelled"
    assert all(item["status"] in ("skipped", "done") for item in snapshot["files"])
    assert any(item["status"] == "skipped" for item in snapshot["files"])


def test_an_unknown_style_is_refused_before_anything_runs(tmp_path: Path) -> None:
    with pytest.raises(ValueError):
        MediaCensorJobs().start([], str(tmp_path), FrameSettings(style="sparkles"))
