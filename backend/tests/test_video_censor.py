"""Video censoring through imageio-ffmpeg (optional "video" dependency group)."""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from services import media_censor_service as media
from services import video_censor
from services.media_censor_service import FrameSettings

imageio_ffmpeg = pytest.importorskip("imageio_ffmpeg")


def _make_clip(path: Path, with_audio: bool) -> Path:
    """2 s, 10 fps, 64x48 test pattern (plus a sine tone) made by ffmpeg itself."""
    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    command = [
        ffmpeg,
        "-y",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc=size=64x48:rate=10:duration=2",
    ]
    if with_audio:
        command += [
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:duration=2",
            "-c:a",
            "aac",
            "-shortest",
        ]
    command += ["-pix_fmt", "yuv420p", str(path)]
    subprocess.run(command, check=True, capture_output=True)
    return path


def _streams(path: Path) -> str:
    result = subprocess.run(
        [imageio_ffmpeg.get_ffmpeg_exe(), "-hide_banner", "-i", str(path)],
        capture_output=True,
        text=True,
    )
    return result.stderr


def test_every_frame_is_processed_and_the_sound_is_kept(
    tmp_path: Path, monkeypatch
) -> None:
    source = _make_clip(tmp_path / "clip.mp4", with_audio=True)
    target = tmp_path / "out" / "clip_censored.mp4"
    monkeypatch.setattr(
        media.FrameDetector, "detect", lambda self, frame: [{"box": [8, 8, 40, 40]}]
    )
    seen = []

    censored = video_censor.censor_video(
        source,
        target,
        FrameSettings(detect_every=1),
        lambda d, t: seen.append(d),
        lambda: False,
    )

    frames, _seconds = imageio_ffmpeg.count_frames_and_secs(str(target))
    assert censored == 20
    assert frames == 20
    assert seen[-1] == 20
    info = _streams(target)
    assert "Video: h264" in info and "Audio:" in info
    assert not list(target.parent.glob(".*video-only*"))


def test_a_silent_clip_stays_silent(tmp_path: Path, monkeypatch) -> None:
    source = _make_clip(tmp_path / "silent.mp4", with_audio=False)
    target = tmp_path / "silent_censored.mp4"
    monkeypatch.setattr(media.FrameDetector, "detect", lambda self, frame: [])

    censored = video_censor.censor_video(
        source, target, FrameSettings(), lambda d, t: None, lambda: False
    )

    assert censored == 0
    assert "Audio:" not in _streams(target)


def test_cancelling_leaves_no_half_written_file(tmp_path: Path, monkeypatch) -> None:
    source = _make_clip(tmp_path / "clip.mp4", with_audio=False)
    target = tmp_path / "clip_censored.mp4"
    monkeypatch.setattr(media.FrameDetector, "detect", lambda self, frame: [])
    calls = {"n": 0}

    def cancel_after_five() -> bool:
        calls["n"] += 1
        return calls["n"] > 5

    with pytest.raises(media.JobCancelled):
        video_censor.censor_video(
            source, target, FrameSettings(), lambda d, t: None, cancel_after_five
        )

    assert not target.exists()
    assert not list(tmp_path.glob(".*video-only*"))
