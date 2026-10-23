"""Poster frames and browser-playable previews for videos.

- ``grab_frame``: one frame as a PIL image, for the thumbnail cache. At most
  ``FRAME_WORKERS`` ffmpeg processes run at once, at below-normal priority.
- converted previews: a video the browser cannot play (ProRes, some MKV/HEVC)
  is converted on request to VP9 + Opus in WebM. libvpx/libopus are BSD
  licensed and part of the LGPL ffmpeg build, so no GPL encoder (x264) is
  needed. One conversion runs at a time; the result is cached under
  ``<thumbnail cache>/video-previews`` and keyed by path, size and mtime, so an
  edited source gets a new preview. The original file is never changed.
"""

from __future__ import annotations

import hashlib
import io
import logging
import os
import queue
import subprocess
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional

from PIL import Image

from config import get_thumbnail_cache_dir
from services import video_tools

logger = logging.getLogger(__name__)

FRAME_WORKERS = 2
FRAME_TIMEOUT_SECONDS = 60.0
POSTER_SECONDS = 1.0
CONVERT_TIMEOUT_SECONDS = (
    6 * 60 * 60
)  # a guard against a hung encoder, not a size limit
PREVIEW_DIR_NAME = "video-previews"
# Codecs every Chromium-based browser and WebView2 plays without extra installs.
BROWSER_CODECS = frozenset({"h264", "vp8", "vp9", "av1"})
BROWSER_CONTAINERS = ("mp4", "mov", "webm", "matroska")

_frame_slots = threading.BoundedSemaphore(FRAME_WORKERS)


def plays_in_browser(codec: Optional[str], format_name: Optional[str] = None) -> bool:
    """Best guess before trying: the viewer still falls back if playback fails."""
    if not codec:
        return True
    if codec.lower() not in BROWSER_CODECS:
        return False
    if not format_name:
        return True
    return any(name in format_name for name in BROWSER_CONTAINERS)


def _frame_args(
    tools: video_tools.VideoTools, path: str, at: float, size: int
) -> List[str]:
    scale = f"scale={size}:{size}:force_original_aspect_ratio=decrease"
    return [
        tools.ffmpeg,
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-ss",
        f"{at:.3f}",
        "-i",
        path,
        "-frames:v",
        "1",
        "-an",
        "-vf",
        scale,
        "-f",
        "image2pipe",
        "-vcodec",
        "png",
        "-",
    ]


def grab_frame(path: str, size: int) -> Image.Image:
    """A frame about one second in (the first frame for shorter clips)."""
    tools = video_tools.require_tools()
    with _frame_slots:
        for at in (POSTER_SECONDS, 0.0):
            try:
                result = video_tools.run_tool(
                    _frame_args(tools, path, at, size), timeout=FRAME_TIMEOUT_SECONDS
                )
            except subprocess.TimeoutExpired as exc:
                raise OSError("ffmpeg timed out reading a frame") from exc
            if result.returncode == 0 and result.stdout:
                image = Image.open(io.BytesIO(result.stdout))
                image.load()
                return image
    raise OSError("ffmpeg could not read a frame from this video")


def video_placeholder_thumbnail(size: int) -> bytes:
    """A dark tile with a play mark: a video whose frame cannot be read (yet)."""
    from PIL import ImageDraw

    side = max(64, int(size))
    image = Image.new("RGB", (side, side), (24, 24, 26))
    draw = ImageDraw.Draw(image)
    radius = side // 6
    center = side // 2
    draw.ellipse(
        (center - radius, center - radius, center + radius, center + radius),
        outline=(200, 135, 60), width=max(2, side // 64),
    )
    tip = radius // 2
    draw.polygon(
        [(center - tip // 2, center - tip), (center - tip // 2, center + tip), (center + tip, center)],
        fill=(200, 135, 60),
    )
    buffer = io.BytesIO()
    image.save(buffer, format="WEBP", quality=85)
    return buffer.getvalue()


def preview_dir() -> Path:
    folder = Path(get_thumbnail_cache_dir()) / PREVIEW_DIR_NAME
    folder.mkdir(parents=True, exist_ok=True)
    return folder


def preview_path_for(source: str) -> Path:
    stat = os.stat(source)
    key = f"{os.path.abspath(source)}:{stat.st_size}:{stat.st_mtime_ns}"
    digest = hashlib.md5(key.encode("utf-8"), usedforsecurity=False).hexdigest()
    return preview_dir() / f"{digest}.webm"


def clear_previews() -> int:
    folder = Path(get_thumbnail_cache_dir()) / PREVIEW_DIR_NAME
    if not folder.is_dir():
        return 0
    removed = 0
    for item in folder.iterdir():
        try:
            item.unlink()
            removed += 1
        except OSError as exc:
            logger.debug("Could not delete preview %s: %s", item, exc)
    return removed


@dataclass
class ConversionJob:
    source: str
    target: Path
    duration: Optional[float]
    status: str = "queued"  # queued | running | done | failed
    progress: float = 0.0
    error: Optional[str] = None
    started_at: float = field(default_factory=time.time)

    def as_dict(self) -> Dict:
        return {
            "status": self.status,
            "progress": round(self.progress, 3),
            "error": self.error,
        }


def _encoder_args(encoders: List[str]) -> List[str]:
    if "libvpx-vp9" not in encoders:
        raise RuntimeError(
            "This ffmpeg has no VP9 encoder (libvpx), so no playable preview can be made"
        )
    threads = str(max(1, (os.cpu_count() or 2) // 2))
    video = [
        "-c:v",
        "libvpx-vp9",
        "-deadline",
        "realtime",
        "-cpu-used",
        "8",
        "-row-mt",
        "1",
        "-b:v",
        "0",
        "-crf",
        "33",
        "-pix_fmt",
        "yuv420p",
        "-threads",
        threads,
    ]
    if "libopus" in encoders:
        return video + ["-c:a", "libopus", "-b:a", "128k"]
    if "libvorbis" in encoders:
        return video + ["-c:a", "libvorbis"]
    return video + ["-an"]


def _parse_progress(line: str, duration: Optional[float]) -> Optional[float]:
    if not duration or not line.startswith("out_time_us="):
        return None
    try:
        seconds = int(line.split("=", 1)[1]) / 1_000_000
    except ValueError:
        return None
    return max(0.0, min(0.99, seconds / duration))


def _run_conversion(job: ConversionJob) -> None:
    tools = video_tools.require_tools()
    partial = job.target.with_name(job.target.stem + ".partial.webm")
    args = [
        tools.ffmpeg,
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-y",
        "-i",
        job.source,
        "-map",
        "0:v:0",
        "-map",
        "0:a:0?",
        *_encoder_args(video_tools.list_encoders(tools)),
        "-progress",
        "pipe:1",
        "-nostats",
        "-f",
        "webm",
        str(partial),
    ]
    process = subprocess.Popen(
        args,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        **video_tools.popen_kwargs(),
    )
    deadline = time.monotonic() + CONVERT_TIMEOUT_SECONDS
    for line in process.stdout:  # type: ignore[union-attr]
        value = _parse_progress(line.strip(), job.duration)
        if value is not None:
            job.progress = value
        if time.monotonic() > deadline:
            process.kill()
            break
    stderr = process.stderr.read() if process.stderr else ""
    if process.wait() != 0:
        partial.unlink(missing_ok=True)
        tail = stderr.strip().splitlines()
        raise RuntimeError(
            tail[-1][:300] if tail else "ffmpeg could not convert this video"
        )
    os.replace(partial, job.target)


class PreviewConverter:
    def __init__(self) -> None:
        self._jobs: Dict[str, ConversionJob] = {}
        self._queue: "queue.Queue[ConversionJob]" = queue.Queue()
        self._lock = threading.Lock()
        self._worker: Optional[threading.Thread] = None

    def status(self, source: str) -> Dict:
        target = preview_path_for(source)
        if target.is_file():
            return {"status": "done", "progress": 1.0, "error": None}
        job = self._jobs.get(str(target))
        return (
            job.as_dict() if job else {"status": "none", "progress": 0.0, "error": None}
        )

    def request(self, source: str, duration: Optional[float]) -> Dict:
        """Start (or report) the conversion of ``source``."""
        target = preview_path_for(source)
        if target.is_file():
            return {"status": "done", "progress": 1.0, "error": None}
        with self._lock:
            job = self._jobs.get(str(target))
            if job is None or job.status == "failed":
                job = ConversionJob(source=source, target=target, duration=duration)
                self._jobs[str(target)] = job
                self._queue.put(job)
            if self._worker is None or not self._worker.is_alive():
                self._worker = threading.Thread(
                    target=self._drain, name="video-preview", daemon=True
                )
                self._worker.start()
        return job.as_dict()

    def _drain(self) -> None:
        while True:
            try:
                job = self._queue.get(timeout=1.0)
            except queue.Empty:
                with self._lock:
                    if self._queue.empty():
                        self._worker = None
                        return
                continue
            job.status = "running"
            try:
                _run_conversion(job)
                job.status, job.progress = "done", 1.0
            except Exception as exc:  # reported to the viewer, never raised
                job.status, job.error = "failed", str(exc)
                logger.warning("Preview conversion failed for %s: %s", job.source, exc)


_converter = PreviewConverter()


def get_converter() -> PreviewConverter:
    return _converter
