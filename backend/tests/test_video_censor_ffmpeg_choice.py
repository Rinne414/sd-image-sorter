"""Which ffmpeg video censoring uses, and what it writes with it.

Video support's ffmpeg comes first, imageio-ffmpeg's is the fallback, and with
neither the job says so (and the page offers the video support install).
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from services import media_censor_service as media
from services import video_censor, video_tools
from services.media_censor_service import FrameSettings, MediaCensorJobs

imageio_ffmpeg = pytest.importorskip("imageio_ffmpeg")
REAL_FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()


def _video_support(monkeypatch, exe: str | None) -> None:
    tools = (
        video_tools.VideoTools(exe, "ffprobe-not-needed", "installed") if exe else None
    )
    monkeypatch.setattr(video_tools, "find_tools", lambda refresh=False: tools)


def _no_imageio(monkeypatch) -> None:
    monkeypatch.setattr(video_censor, "_imageio_exe", lambda: None)


def _nothing_on_path(monkeypatch) -> None:
    monkeypatch.setattr(video_censor.shutil, "which", lambda name: None)


def _clip(path: Path, size: str = "64x48") -> Path:
    command = [
        REAL_FFMPEG, "-y", "-loglevel", "error", "-f", "lavfi",
        "-i", f"testsrc=size={size}:rate=10:duration=1",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
        "-c:a", "aac", "-shortest", "-pix_fmt", "yuv420p", str(path),
    ]  # fmt: skip
    subprocess.run(command, check=True, capture_output=True)
    return path


def _streams(path: Path) -> str:
    return subprocess.run(
        [REAL_FFMPEG, "-hide_banner", "-i", str(path)], capture_output=True, text=True
    ).stderr


@pytest.fixture(autouse=True)
def _cover_a_box(monkeypatch):
    monkeypatch.setattr(
        media.FrameDetector, "detect", lambda self, frame: [{"box": [4, 4, 30, 30]}]
    )
    video_censor._encoder_cache.clear()
    yield
    video_censor._encoder_cache.clear()


def _censor(source: Path, target: Path) -> int:
    return video_censor.censor_video(
        source, target, FrameSettings(detect_every=1), lambda d, t: None, lambda: False
    )


# ---- which ffmpeg ----


def test_video_supports_ffmpeg_is_used_when_it_is_installed(monkeypatch) -> None:
    _video_support(monkeypatch, REAL_FFMPEG)

    found = video_censor.find_ffmpeg()

    assert found == video_censor.Ffmpeg(REAL_FFMPEG, video_censor.SOURCE_VIDEO_SUPPORT)
    assert video_censor.source_name() == "video_support"


def test_video_support_wins_even_when_imageio_is_there_too(
    monkeypatch, tmp_path: Path
) -> None:
    _video_support(monkeypatch, str(tmp_path / "ffmpeg-from-video-support"))
    monkeypatch.setattr(video_censor, "_imageio_exe", lambda: REAL_FFMPEG)

    assert video_censor.find_ffmpeg().exe == str(tmp_path / "ffmpeg-from-video-support")


def test_imageio_ffmpeg_is_the_fallback_when_only_that_is_there(monkeypatch) -> None:
    _video_support(monkeypatch, None)

    found = video_censor.find_ffmpeg()

    assert found == video_censor.Ffmpeg(REAL_FFMPEG, video_censor.SOURCE_IMAGEIO)
    assert video_censor.is_available()


def test_a_lone_ffmpeg_on_the_path_is_the_last_resort(monkeypatch) -> None:
    _video_support(monkeypatch, None)
    _no_imageio(monkeypatch)
    monkeypatch.setattr(video_censor.shutil, "which", lambda name: "/usr/bin/ffmpeg")

    assert video_censor.find_ffmpeg() == video_censor.Ffmpeg(
        "/usr/bin/ffmpeg", video_censor.SOURCE_PATH
    )


def test_with_neither_it_says_so_and_asks_for_video_support(
    monkeypatch, tmp_path: Path
) -> None:
    _video_support(monkeypatch, None)
    _no_imageio(monkeypatch)
    _nothing_on_path(monkeypatch)

    assert not video_censor.is_available()
    assert video_censor.source_name() is None
    with pytest.raises(video_censor.NoFfmpeg, match="video support"):
        _censor(tmp_path / "x.mp4", tmp_path / "x_censored.mp4")


def test_the_page_reads_the_same_answer_from_the_list_and_the_status_route(
    test_client, monkeypatch, tmp_path: Path
) -> None:
    (tmp_path / "a.gif").write_bytes(b"GIF89a")

    _video_support(monkeypatch, None)
    _no_imageio(monkeypatch)
    _nothing_on_path(monkeypatch)
    none_status = test_client.get("/api/censor/media/status").json()
    none_list = test_client.post(
        "/api/censor/media/list", json={"folder": str(tmp_path)}
    ).json()
    _video_support(monkeypatch, REAL_FFMPEG)
    support_status = test_client.get("/api/censor/media/status").json()
    support_list = test_client.post(
        "/api/censor/media/list", json={"folder": str(tmp_path)}
    ).json()

    assert none_status == {"video_ready": False, "video_source": None}
    assert none_list["video_ready"] is False and none_list["video_source"] is None
    assert support_status == {"video_ready": True, "video_source": "video_support"}
    assert support_list["video_ready"] is True


def test_the_model_center_card_is_ready_with_either_ffmpeg_and_never_downloads(
    monkeypatch,
) -> None:
    import model_health

    _video_support(monkeypatch, None)
    assert model_health._video_ffmpeg_health()["source"] == "imageio"
    _no_imageio(monkeypatch)
    _nothing_on_path(monkeypatch)
    health = model_health._video_ffmpeg_health()
    assert health["available"] is False
    assert "video support" in health["message"]


# ---- what is written ----


def test_the_censored_video_is_made_with_video_supports_ffmpeg(
    monkeypatch, tmp_path: Path
) -> None:
    _video_support(monkeypatch, REAL_FFMPEG)
    source = _clip(tmp_path / "clip.mp4")
    target = tmp_path / "clip_censored.mp4"

    censored = _censor(source, target)

    assert censored == 10
    info = _streams(target)
    assert "Video: h264" in info and "Audio:" in info


def test_the_imageio_fallback_writes_the_same_kind_of_file(
    monkeypatch, tmp_path: Path
) -> None:
    _video_support(monkeypatch, None)
    source = _clip(tmp_path / "clip.mp4")
    target = tmp_path / "clip_censored.mp4"

    assert _censor(source, target) == 10
    assert "Video: h264" in _streams(target)


def test_an_odd_sized_video_is_trimmed_to_an_even_size(
    monkeypatch, tmp_path: Path
) -> None:
    _video_support(monkeypatch, None)
    source = tmp_path / "odd.mp4"
    subprocess.run(
        [
            REAL_FFMPEG, "-y", "-loglevel", "error", "-f", "lavfi",
            "-i", "testsrc=size=63x47:rate=10:duration=1",
            "-c:v", "libx264", "-pix_fmt", "yuv444p", str(source),
        ],
        check=True,
        capture_output=True,
    )  # fmt: skip
    target = tmp_path / "odd_censored.mp4"

    assert _censor(source, target) == 10

    # yuv420p needs even sizes: the writer drops the odd last column and row
    assert " 62x46" in _streams(target)


def test_without_x264_the_output_is_vp9_in_webm(monkeypatch, tmp_path: Path) -> None:
    _video_support(monkeypatch, None)
    real = video_censor._encoders(REAL_FFMPEG)
    if "libvpx-vp9" not in real:
        pytest.skip("this ffmpeg has no VP9 encoder")
    video_censor._encoder_cache[REAL_FFMPEG] = [
        name for name in real if name != "libx264"
    ]
    source = _clip(tmp_path / "clip.mp4")

    assert video_censor.output_suffix() == ".webm"
    target = tmp_path / "clip_censored.webm"
    assert _censor(source, target) == 10
    info = _streams(target)
    assert "Video: vp9" in info
    assert ("Audio: opus" in info) or ("Audio: vorbis" in info) or "libopus" not in real


def test_a_job_names_the_output_by_the_encoder_in_use(
    monkeypatch, tmp_path: Path
) -> None:
    _video_support(monkeypatch, None)
    real = video_censor._encoders(REAL_FFMPEG)
    if "libvpx-vp9" not in real:
        pytest.skip("this ffmpeg has no VP9 encoder")
    video_censor._encoder_cache[REAL_FFMPEG] = [
        name for name in real if name != "libx264"
    ]
    _clip(tmp_path / "clip.mp4")
    out = tmp_path / "out"
    jobs = MediaCensorJobs(
        video_censor=video_censor.censor_video, video_suffix=video_censor.output_suffix
    )

    job = jobs.start(
        [str(tmp_path / "clip.mp4")], str(out), FrameSettings(detect_every=1)
    )
    deadline_polls = 600
    import time

    while job.snapshot()["status"] in ("queued", "running") and deadline_polls:
        time.sleep(0.05)
        deadline_polls -= 1

    (item,) = job.snapshot()["files"]
    assert item["status"] == "done", item
    assert Path(item["output"]).name == "clip_censored.webm"


# ---- pure rules ----


def test_the_format_follows_the_encoders() -> None:
    assert video_censor.pick_format(["libx264", "libvpx-vp9"]).suffix == ".mp4"
    assert video_censor.pick_format(["libvpx-vp9", "libopus"]).suffix == ".webm"
    with pytest.raises(RuntimeError, match="cannot write a video"):
        video_censor.pick_format(["mpeg4"])


def test_the_header_gives_the_frame_rate_and_length() -> None:
    text = (
        "  Duration: 00:01:02.50, start: 0.000000, bitrate: 900 kb/s\n"
        "  Stream #0:0: Video: h264, yuv420p, 640x480, 29.97 fps, 30 tbr\n"
    )
    assert video_censor.parse_header(text) == (29.97, 62.5)
    assert video_censor.parse_header("nothing useful") == (
        video_censor.DEFAULT_FPS,
        0.0,
    )


def test_cancelling_removes_the_half_written_file_with_the_pipes_closed(
    monkeypatch, tmp_path: Path
) -> None:
    _video_support(monkeypatch, None)
    source = _clip(tmp_path / "clip.mp4")
    target = tmp_path / "clip_censored.mp4"
    calls = {"n": 0}

    def cancel_after_three() -> bool:
        calls["n"] += 1
        return calls["n"] > 3

    with pytest.raises(media.JobCancelled):
        video_censor.censor_video(
            source, target, FrameSettings(), lambda d, t: None, cancel_after_three
        )

    assert not target.exists()
    assert not list(tmp_path.glob(".*video-only*"))


def test_a_file_ffmpeg_cannot_read_fails_with_ffmpegs_own_words(
    monkeypatch, tmp_path: Path
) -> None:
    _video_support(monkeypatch, None)
    broken = tmp_path / "broken.mp4"
    broken.write_bytes(b"this is not a video")

    with pytest.raises(RuntimeError, match="could not read broken.mp4"):
        _censor(broken, tmp_path / "broken_censored.mp4")
