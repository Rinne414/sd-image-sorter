"""Video censoring through one ffmpeg, driven over raw-frame pipes.

Which ffmpeg: the one video support installed (``video_tools.find_tools()``:
the program's tools folder, beside the program, or the PATH pair) comes first,
so a user who has video support downloads nothing more. Without it, the ffmpeg
that the optional ``imageio-ffmpeg`` package ships is used when that package is
there, then a lone ``ffmpeg`` on the PATH. With none of them the page offers the
video support install (one download serves playback and censoring).

Frames are decoded by ffmpeg as raw RGB and encoded the same way, so nothing is
held in memory beyond one frame. Each frame goes through the same detect /
track / mosaic chain as a GIF. The output is H.264 in MP4 when the ffmpeg has
libx264, otherwise VP9 in WebM (the LGPL video support build has no x264); the
source's first audio track, when it has one, is copied across in a second
quick pass.
"""

from __future__ import annotations

import importlib.util
import io
import logging
import re
import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO, Callable, List, Optional

from PIL import Image

from services import video_tools
from services.media_censor_service import (
    FrameDetector,
    FrameSettings,
    JobCancelled,
    RegionTracker,
    censor_frame,
)

logger = logging.getLogger(__name__)

DEFAULT_FPS = 25.0
# Seconds an ffmpeg that only reports facts (a header read, one frame, the
# encoder list) may take: a guard against a hung process, not a size limit.
PROBE_TIMEOUT_SECONDS = 120
SOURCE_VIDEO_SUPPORT = "video_support"
SOURCE_IMAGEIO = "imageio"
SOURCE_PATH = "path"


@dataclass(frozen=True)
class Ffmpeg:
    exe: str
    source: str  # SOURCE_VIDEO_SUPPORT | SOURCE_IMAGEIO | SOURCE_PATH


def _imageio_exe() -> Optional[str]:
    try:
        if importlib.util.find_spec("imageio_ffmpeg") is None:
            return None
    except (ImportError, ValueError):
        return None
    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:  # the package is there but ships no usable binary
        return None


def find_ffmpeg() -> Optional[Ffmpeg]:
    """The ffmpeg to censor videos with, or None (then video support is offered)."""
    tools = video_tools.find_tools()
    if tools is not None:
        return Ffmpeg(tools.ffmpeg, SOURCE_VIDEO_SUPPORT)
    bundled = _imageio_exe()
    if bundled:
        return Ffmpeg(bundled, SOURCE_IMAGEIO)
    lone = shutil.which("ffmpeg")
    if lone:
        return Ffmpeg(lone, SOURCE_PATH)
    return None


def is_available() -> bool:
    return find_ffmpeg() is not None


def source_name() -> Optional[str]:
    found = find_ffmpeg()
    return found.source if found else None


class NoFfmpeg(RuntimeError):
    """Neither video support nor imageio-ffmpeg is installed."""


def _require() -> Ffmpeg:
    found = find_ffmpeg()
    if found is None:
        raise NoFfmpeg(
            "Video censoring needs ffmpeg: install video support (one download that "
            "also plays videos in the library)"
        )
    return found


_encoder_cache: dict[str, List[str]] = {}


def _encoders(exe: str) -> List[str]:
    if exe not in _encoder_cache:
        _encoder_cache[exe] = video_tools.list_encoders(
            video_tools.VideoTools(exe, "", "")
        )
    return _encoder_cache[exe]


@dataclass(frozen=True)
class OutputFormat:
    suffix: str  # ".mp4" | ".webm"
    video_args: List[str]
    audio_codecs: List[str]  # in the order tried for the copied sound


def pick_format(encoders: List[str]) -> OutputFormat:
    """H.264 in MP4 when ffmpeg can write it, else VP9 in WebM; never a file nobody can play."""
    if "libx264" in encoders:
        return OutputFormat(
            ".mp4",
            [
                "-c:v",
                "libx264",
                "-preset",
                "medium",
                "-crf",
                "20",
                "-pix_fmt",
                "yuv420p",
            ],
            ["aac"],
        )
    if "libvpx-vp9" in encoders:
        return OutputFormat(
            ".webm",
            [
                "-c:v",
                "libvpx-vp9",
                "-deadline",
                "realtime",
                "-cpu-used",
                "5",
                "-row-mt",
                "1",
                "-b:v",
                "0",
                "-crf",
                "30",
                "-pix_fmt",
                "yuv420p",
            ],
            ["libopus", "libvorbis"],
        )
    raise RuntimeError(
        "This ffmpeg has no H.264 (x264) or VP9 (libvpx) encoder, so it cannot write a video"
    )


def output_suffix() -> str:
    """The extension the censored video will have with the ffmpeg in use."""
    found = find_ffmpeg()
    if found is None:
        return ".mp4"
    try:
        return pick_format(_encoders(found.exe)).suffix
    except RuntimeError:
        return ".mp4"


# ---- reading facts from ffmpeg ----

_FPS = re.compile(r"(\d+(?:\.\d+)?) fps")
_DURATION = re.compile(r"Duration: (\d+):(\d+):(\d+(?:\.\d+)?)")


def parse_header(text: str) -> tuple[float, float]:
    """(fps, duration seconds) from the text ``ffmpeg -i file`` prints; 0 duration when unknown."""
    fps_match = _FPS.search(text)
    fps = float(fps_match.group(1)) if fps_match else DEFAULT_FPS
    if fps <= 0:
        fps = DEFAULT_FPS
    duration_match = _DURATION.search(text)
    duration = 0.0
    if duration_match:
        hours, minutes, seconds = duration_match.groups()
        duration = int(hours) * 3600 + int(minutes) * 60 + float(seconds)
    return fps, duration


def _first_frame_size(ffmpeg: str, source: Path) -> tuple[int, int]:
    """The size ffmpeg really delivers (after rotation), found by decoding one frame."""
    result = subprocess.run(
        [
            ffmpeg,
            "-v",
            "error",
            "-i",
            str(source),
            "-frames:v",
            "1",
            "-f",
            "image2pipe",
            "-c:v",
            "png",
            "-",
        ],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=PROBE_TIMEOUT_SECONDS,
        check=False,
        **video_tools.popen_kwargs(),
    )
    if result.returncode != 0 or not result.stdout:
        raise RuntimeError(
            f"ffmpeg could not read {source.name}: {_tail(result.stderr.decode('utf-8', 'replace'))}"
        )
    with Image.open(io.BytesIO(result.stdout)) as frame:
        return frame.size


def _tail(text: str) -> str:
    return text.strip()[-400:]


def _stderr_text(handle: BinaryIO) -> str:
    handle.flush()
    handle.seek(0)
    return handle.read().decode("utf-8", "replace")


def _read_exactly(stream: BinaryIO, size: int) -> bytes:
    chunks: List[bytes] = []
    remaining = size
    while remaining:
        chunk = stream.read(remaining)
        if not chunk:
            break
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def _stop(process: Optional[subprocess.Popen]) -> None:
    if process is None:
        return
    for stream in (process.stdin, process.stdout):
        try:
            if stream:
                stream.close()
        except OSError:
            pass
    if process.poll() is None:
        process.terminate()
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()


def censor_video(
    source: Path,
    target: Path,
    settings: FrameSettings,
    progress: Callable[[int, int], None],
    cancelled: Callable[[], bool],
) -> int:
    """Censor every frame of ``source`` into ``target``; returns the censored frame count.

    ``target``'s extension must be the one ``output_suffix()`` gave.
    """
    ffmpeg = _require().exe
    fmt = pick_format(_encoders(ffmpeg))
    header = subprocess.run(
        [ffmpeg, "-hide_banner", "-i", str(source)],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=PROBE_TIMEOUT_SECONDS,
        check=False,
        **video_tools.popen_kwargs(),
    )
    fps, duration = parse_header(header.stderr.decode("utf-8", "replace"))
    width, height = _first_frame_size(ffmpeg, source)
    expected = int(round(duration * fps)) if duration else 0
    frame_bytes = width * height * 3
    target.parent.mkdir(parents=True, exist_ok=True)
    silent = target.with_name(f".{target.stem}.video-only{fmt.suffix}")

    decoder = encoder = None
    decoder_log = tempfile.TemporaryFile()
    encoder_log = tempfile.TemporaryFile()
    tracker = RegionTracker(
        FrameDetector(settings).detect, settings.detect_every, settings.hold
    )
    censored = 0
    try:
        decoder = subprocess.Popen(
            [
                ffmpeg,
                "-v",
                "error",
                "-i",
                str(source),
                "-an",
                "-f",
                "rawvideo",
                "-pix_fmt",
                "rgb24",
                "-",
            ],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=decoder_log,
            **video_tools.popen_kwargs(),
        )
        encoder = subprocess.Popen(
            [
                ffmpeg,
                "-y",
                "-v",
                "error",
                "-f",
                "rawvideo",
                "-pix_fmt",
                "rgb24",
                "-s",
                f"{width}x{height}",
                "-r",
                repr(fps),
                "-i",
                "-",
                # yuv420p needs even sizes: drop the odd last row or column
                "-vf",
                "crop=trunc(iw/2)*2:trunc(ih/2)*2",
                *fmt.video_args,
                "-an",
                str(silent),
            ],
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=encoder_log,
            **video_tools.popen_kwargs(),
        )
        assert decoder.stdout is not None and encoder.stdin is not None
        index = 0
        while True:
            if cancelled():
                raise JobCancelled()
            raw = _read_exactly(decoder.stdout, frame_bytes)
            if len(raw) < frame_bytes:
                break  # the end (a short last read is a cut-off frame: dropped)
            frame = Image.frombytes("RGB", (width, height), raw)
            regions = tracker.regions(frame)
            if regions:
                censored += 1
            encoder.stdin.write(
                censor_frame(frame, regions, settings.style, settings.block_size)
                .convert("RGB")
                .tobytes()
            )
            index += 1
            progress(index, max(expected, index))
        encoder.stdin.close()
        if encoder.wait() != 0:
            raise RuntimeError(
                f"ffmpeg could not write {target.name}: {_tail(_stderr_text(encoder_log))}"
            )
        decoder.wait()
        if index == 0:
            raise RuntimeError(
                f"ffmpeg decoded no frames from {source.name}: {_tail(_stderr_text(decoder_log))}"
            )
        _copy_audio(ffmpeg, fmt, silent, source, target)
    except BaseException:
        _stop(decoder)
        _stop(encoder)
        target.unlink(missing_ok=True)
        raise
    finally:
        silent.unlink(missing_ok=True)
        decoder_log.close()
        encoder_log.close()
    return censored


def _copy_audio(
    ffmpeg: str, fmt: OutputFormat, video: Path, source: Path, target: Path
) -> None:
    """Video from ``video``, first audio track (if any) from ``source``, into ``target``."""
    encoders = _encoders(ffmpeg)
    codec = next((name for name in fmt.audio_codecs if name in encoders), None)
    if codec is None:
        # No encoder for the sound in this container: the video alone is still a good file.
        logger.warning(
            "No %s audio encoder in this ffmpeg; %s is saved without sound",
            fmt.suffix,
            target.name,
        )
        shutil.move(str(video), str(target))
        return
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
        codec,
        "-shortest",
        str(target),
    ]
    result = subprocess.run(
        command,
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        check=False,
        **video_tools.popen_kwargs(),
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"ffmpeg could not write {target.name}: {_tail(result.stderr)}"
        )
