"""Video censoring through the ffmpeg that imageio-ffmpeg ships (optional "video" group).

Frames are decoded and encoded by ffmpeg as raw RGB, so nothing is held in
memory beyond one frame. Each frame goes through the same detect / track /
mosaic chain as a GIF. The output is H.264 MP4; the source's first audio
track, when it has one, is copied across in a second quick ffmpeg pass.
"""

from __future__ import annotations

import importlib.util
import logging
import subprocess
import sys
from pathlib import Path
from typing import Callable

from PIL import Image

from services.media_censor_service import (
    FrameDetector,
    FrameSettings,
    JobCancelled,
    RegionTracker,
    censor_frame,
)

logger = logging.getLogger(__name__)

ENCODE_QUALITY = 7  # imageio-ffmpeg's 0-10 scale; 7 keeps mosaic edges clean
_NO_WINDOW = 0x08000000 if sys.platform == "win32" else 0  # CREATE_NO_WINDOW


def is_available() -> bool:
    try:
        return importlib.util.find_spec("imageio_ffmpeg") is not None
    except (ImportError, ValueError):
        return False


def censor_video(
    source: Path,
    target: Path,
    settings: FrameSettings,
    progress: Callable[[int, int], None],
    cancelled: Callable[[], bool],
) -> int:
    """Censor every frame of ``source`` into ``target`` (.mp4); returns censored frame count."""
    import imageio_ffmpeg

    reader = imageio_ffmpeg.read_frames(str(source))
    meta = next(reader)
    width, height = meta["size"]
    fps = float(meta.get("fps") or 25.0)
    duration = float(meta.get("duration") or 0.0)
    expected = int(round(duration * fps)) if duration else 0
    target.parent.mkdir(parents=True, exist_ok=True)
    silent = target.with_name(f".{target.stem}.video-only.mp4")
    writer = imageio_ffmpeg.write_frames(
        str(silent),
        (width, height),
        fps=fps,
        codec="libx264",
        pix_fmt_in="rgb24",
        pix_fmt_out="yuv420p",
        quality=ENCODE_QUALITY,
        macro_block_size=2,
        ffmpeg_log_level="error",
    )
    writer.send(None)
    tracker = RegionTracker(
        FrameDetector(settings).detect, settings.detect_every, settings.hold
    )
    censored = 0
    try:
        for index, raw in enumerate(reader):
            if cancelled():
                raise JobCancelled()
            frame = Image.frombytes("RGB", (width, height), raw)
            regions = tracker.regions(frame)
            if regions:
                censored += 1
            writer.send(
                censor_frame(frame, regions, settings.style, settings.block_size)
                .convert("RGB")
                .tobytes()
            )
            progress(index + 1, max(expected, index + 1))
    except BaseException:
        writer.close()
        reader.close()
        silent.unlink(missing_ok=True)
        raise
    writer.close()
    reader.close()
    try:
        _copy_audio(imageio_ffmpeg.get_ffmpeg_exe(), silent, source, target)
    finally:
        silent.unlink(missing_ok=True)
    return censored


def _copy_audio(ffmpeg: str, video: Path, source: Path, target: Path) -> None:
    """Video from ``video``, first audio track (if any) from ``source``, into ``target``."""
    command = [
        ffmpeg,
        "-y",
        "-loglevel",
        "error",
        "-i",
        str(video),
        "-i",
        str(source),
        "-map",
        "0:v:0",
        "-map",
        "1:a:0?",
        "-c:v",
        "copy",
        "-c:a",
        "aac",
        "-shortest",
        str(target),
    ]
    result = subprocess.run(
        command,
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        creationflags=_NO_WINDOW,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"ffmpeg could not write {target.name}: {result.stderr.strip()[-400:]}"
        )
