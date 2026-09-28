"""Auto-censor moving pictures: every frame of a GIF (and, with ffmpeg, a video).

Frames go through the same chain as the Censor page's detect: the chosen
detector, the target classes, the face guard, the region shape and grown
edge, then a mosaic / blur / black bar under the combined mask.

Moving pictures need two extra knobs. ``detect_every`` runs the detector on
every Nth frame and reuses its regions in between (N times faster). ``hold``
keeps the last regions for that many frames after the detector stops seeing
them, so a part that is briefly missed does not flash uncensored.
"""

from __future__ import annotations

import logging
import threading
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Optional

from PIL import Image, ImageSequence

from ai_runtime_guard import PRIORITY_BATCH
from censor_transforms import MASK_STYLES, censor_under_mask

logger = logging.getLogger(__name__)

GIF_EXTENSIONS = frozenset({".gif"})
VIDEO_EXTENSIONS = frozenset(
    {".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v", ".wmv", ".flv", ".ts"}
)
DEFAULT_DETECT_EVERY = 2
DEFAULT_HOLD = 8
OUTPUT_SUFFIX = "_censored"


@dataclass(frozen=True)
class FrameSettings:
    model_type: str = "nudenet"
    model_path: str = ""
    confidence: float = 0.5
    target_classes: Optional[List[str]] = None
    face_guard: bool = True
    shape: str = "precise"
    expand_percent: float = 0.0
    style: str = "mosaic"
    block_size: int = 0  # 0 = Auto (1/100 of the long side)
    detect_every: int = DEFAULT_DETECT_EVERY
    hold: int = DEFAULT_HOLD


class FrameDetector:
    """Regions to censor in one frame, using the Censor page's detection chain."""

    def __init__(self, settings: FrameSettings):
        self.settings = settings

    def _raw(self, frame: Image.Image) -> List[Dict[str, Any]]:
        settings = self.settings
        found: List[Dict[str, Any]] = []
        if settings.model_type in ("nudenet", "both"):
            import nudenet_detector

            found += nudenet_detector.get_nudenet_detector().detect_from_pil(
                frame,
                conf_threshold=settings.confidence,
                exposed_only=True,
                priority=PRIORITY_BATCH,
            )
        if settings.model_type in ("legacy", "both"):
            from censor import get_detector
            from model_health_paths import get_default_legacy_model_path

            path = settings.model_path or get_default_legacy_model_path()
            if path:
                found += get_detector(path).detect_from_image(
                    frame, conf_threshold=settings.confidence, priority=PRIORITY_BATCH
                )
        return found

    def detect(self, frame: Image.Image) -> List[Dict[str, Any]]:
        import face_guard
        from services.censor.detection import _DetectionMixin
        from services.censor.region_shapes import reshape

        detections = _DetectionMixin._filter_detections_by_targets(
            self._raw(frame), self.settings.target_classes
        )
        if self.settings.face_guard and detections:
            detections, _ = face_guard.apply(
                detections, frame, _DetectionMixin._normalize_target_family
            )
        if detections and (
            self.settings.shape != "precise" or self.settings.expand_percent > 0
        ):
            detections, _ = reshape(
                detections, frame, self.settings.shape, self.settings.expand_percent
            )
        return detections


class RegionTracker:
    """Detect every Nth frame; keep the last regions for ``hold`` frames after they vanish."""

    def __init__(
        self,
        detect: Callable[[Image.Image], List[Dict[str, Any]]],
        detect_every: int,
        hold: int,
    ):
        self._detect = detect
        self._every = max(1, int(detect_every))
        self._hold = max(0, int(hold))
        self._index = 0
        self._current: List[Dict[str, Any]] = []
        self._last_seen: List[Dict[str, Any]] = []
        self._since_seen = 0

    def regions(self, frame: Image.Image) -> List[Dict[str, Any]]:
        if self._index % self._every == 0:
            found = self._detect(frame)
            if found:
                self._last_seen = found
                self._since_seen = 0
                self._current = found
            else:
                self._since_seen += self._every
                self._current = (
                    self._last_seen if self._since_seen <= self._hold else []
                )
        self._index += 1
        return self._current


def censor_frame(
    frame: Image.Image, regions: List[Dict[str, Any]], style: str, block_size: int
) -> Image.Image:
    if not regions:
        return frame.convert("RGBA")
    from services.censor.mask_cache import _MaskCacheMixin

    mask = _MaskCacheMixin._build_combined_mask_image(
        frame.size, regions, include_boxes=True
    )
    if mask is None:
        return frame.convert("RGBA")
    return censor_under_mask(frame, mask, style, block_size)


def censor_gif(
    source: Path,
    target: Path,
    settings: FrameSettings,
    progress: Callable[[int, int], None],
    cancelled: Callable[[], bool],
) -> int:
    """Censor every frame of a GIF, keeping each frame's timing and the loop count.

    Returns the number of frames that received a mosaic.
    """
    tracker = RegionTracker(
        FrameDetector(settings).detect, settings.detect_every, settings.hold
    )
    frames: List[Image.Image] = []
    durations: List[int] = []
    censored = 0
    with Image.open(source) as image:
        total = getattr(image, "n_frames", 1)
        loop = image.info.get("loop", 0)
        for index, frame in enumerate(ImageSequence.Iterator(image)):
            if cancelled():
                raise JobCancelled()
            rgba = frame.convert("RGBA")
            regions = tracker.regions(rgba.convert("RGB"))
            if regions:
                censored += 1
            frames.append(
                censor_frame(rgba, regions, settings.style, settings.block_size)
            )
            durations.append(
                int(frame.info.get("duration") or image.info.get("duration") or 100)
            )
            progress(index + 1, total)
    target.parent.mkdir(parents=True, exist_ok=True)
    frames[0].save(
        target,
        format="GIF",
        save_all=True,
        append_images=frames[1:],
        duration=durations,
        loop=loop,
        disposal=2,
        optimize=False,
    )
    return censored


class JobCancelled(Exception):
    """The user stopped the job."""


def list_media(folder: Path) -> Dict[str, List[str]]:
    """GIFs and videos directly in ``folder`` (not its subfolders), by name."""
    gifs, videos = [], []
    for entry in sorted(folder.iterdir(), key=lambda path: path.name.lower()):
        if not entry.is_file():
            continue
        suffix = entry.suffix.lower()
        if suffix in GIF_EXTENSIONS:
            gifs.append(str(entry))
        elif suffix in VIDEO_EXTENSIONS:
            videos.append(str(entry))
    return {"gifs": gifs, "videos": videos}


def free_output_path(folder: Path, source: Path, suffix: str) -> Path:
    candidate = folder / f"{source.stem}{OUTPUT_SUFFIX}{suffix}"
    counter = 2
    while candidate.exists():
        candidate = folder / f"{source.stem}{OUTPUT_SUFFIX} ({counter}){suffix}"
        counter += 1
    return candidate


@dataclass
class MediaJob:
    id: str
    files: List[Dict[str, Any]]
    settings: FrameSettings
    output_folder: Path
    status: str = "queued"
    error: str = ""
    cancel_requested: bool = False
    lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def snapshot(self) -> Dict[str, Any]:
        with self.lock:
            return {
                "id": self.id,
                "status": self.status,
                "error": self.error,
                "files": [dict(item) for item in self.files],
                "done": sum(
                    1
                    for item in self.files
                    if item["status"] in ("done", "error", "skipped")
                ),
                "total": len(self.files),
            }


class MediaCensorJobs:
    """One worker thread; jobs run one after another so the GPU is never shared."""

    def __init__(self, video_censor: Optional[Callable[..., int]] = None):
        self._jobs: Dict[str, MediaJob] = {}
        self._queue: List[MediaJob] = []
        self._lock = threading.Lock()
        self._worker: Optional[threading.Thread] = None
        self._video_censor = video_censor

    def start(
        self, sources: Iterable[str], output_folder: str, settings: FrameSettings
    ) -> MediaJob:
        if settings.style not in MASK_STYLES:
            raise ValueError(f"style must be one of {', '.join(MASK_STYLES)}")
        files = [
            {
                "source": str(path),
                "name": Path(path).name,
                "status": "queued",
                "frames_done": 0,
                "frames_total": 0,
                "censored_frames": 0,
                "output": "",
                "error": "",
            }
            for path in sources
        ]
        job = MediaJob(id=uuid.uuid4().hex[:12], files=files, settings=settings, output_folder=Path(output_folder))
        with self._lock:
            self._jobs[job.id] = job
            self._queue.append(job)
            if self._worker is None or not self._worker.is_alive():
                self._worker = threading.Thread(
                    target=self._run, name="media-censor", daemon=True
                )
                self._worker.start()
        return job

    def get(self, job_id: str) -> Optional[MediaJob]:
        with self._lock:
            return self._jobs.get(job_id)

    def cancel(self, job_id: str) -> bool:
        job = self.get(job_id)
        if job is None:
            return False
        with job.lock:
            job.cancel_requested = True
        return True

    def _run(self) -> None:
        while True:
            with self._lock:
                if not self._queue:
                    self._worker = None
                    return
                job = self._queue.pop(0)
            self._run_job(job)

    def _run_job(self, job: MediaJob) -> None:
        with job.lock:
            job.status = "running"
        for item in job.files:
            if job.cancel_requested:
                break
            self._run_file(job, item)
        with job.lock:
            if job.cancel_requested:
                job.status = "cancelled"
                for item in job.files:
                    if item["status"] in ("queued", "running"):
                        item["status"] = "skipped"
            elif any(item["status"] == "error" for item in job.files):
                job.status = "done_with_errors"
            else:
                job.status = "done"

    def _run_file(self, job: MediaJob, item: Dict[str, Any]) -> None:
        source = Path(item["source"])
        is_video = source.suffix.lower() in VIDEO_EXTENSIONS
        output_suffix = ".mp4" if is_video else source.suffix.lower()
        with job.lock:
            item["status"] = "running"

        def progress(done: int, total: int) -> None:
            with job.lock:
                item["frames_done"] = done
                item["frames_total"] = total

        def cancelled() -> bool:
            return job.cancel_requested

        try:
            target = free_output_path(job.output_folder, source, output_suffix)
            if is_video:
                if self._video_censor is None:
                    raise RuntimeError("Video censoring is not available")
                censored = self._video_censor(
                    source, target, job.settings, progress, cancelled
                )
            else:
                censored = censor_gif(source, target, job.settings, progress, cancelled)
        except JobCancelled:
            with job.lock:
                item["status"] = "skipped"
            return
        except Exception as exc:
            logger.exception("Media censor failed for %s", source.name)
            with job.lock:
                item["status"] = "error"
                item["error"] = str(exc) or type(exc).__name__
            return
        with job.lock:
            item["status"] = "done"
            item["output"] = str(target)
            item["censored_frames"] = censored
