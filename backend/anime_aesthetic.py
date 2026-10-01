"""deepghs anime_aesthetic: an optional seven-grade anime aesthetic score (ONNX).

``swinv2pv3_v0_448_ls0.2_x`` from ``deepghs/anime_aesthetic`` (the model card
lists 40.9% seven-way accuracy, AUC 0.821) classifies a picture as
masterpiece, best, great, good, normal, low or worst. As in deepghs' own
tooling, the probabilities become a continuous score (worst = 0 ...
masterpiece = 6), the score is placed among the model's published reference
samples (a percentile), and the grade is read from the percentile.

Both files are pinned to one repository commit and verified by SHA-256. The
model runs in ONNX Runtime; the aesthetic scoring run calls it on the same
opened picture as the CLIP scores.
"""

from __future__ import annotations

import logging
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Dict, Optional, Tuple

import numpy as np

import model_external
import pinned_download
from ai_runtime_guard import claim_gpu_residency, forget_gpu_residency

logger = logging.getLogger(__name__)

_REPO = "deepghs/anime_aesthetic"
_REVISION = "a83ab545e1d2a869f1180b99b2a7dee22ec3b97e"
MODEL_FILE = pinned_download.PinnedFile(
    repo=_REPO,
    revision=_REVISION,
    remote_path="swinv2pv3_v0_448_ls0.2_x/model.onnx",
    sha256="174a988ff458e84bd28c2a71cd22a5e7e160ec2518e501efbdfc3de1d09d82a2",
    size_bytes=418_260_629,
)
SAMPLES_FILE = pinned_download.PinnedFile(
    repo=_REPO,
    revision=_REVISION,
    remote_path="swinv2pv3_v0_448_ls0.2_x/samples.npz",
    sha256="f37d22a7fbfb2748c007cefddf7b4c95602cb5037f847a81ab47fc5d4c1df013",
    size_bytes=20_515_784,
)
MODEL_FILENAME = "anime_aesthetic_swinv2pv3_x.onnx"
SAMPLES_FILENAME = "anime_aesthetic_swinv2pv3_x_samples.npz"

INPUT_SIZE = 448
# Output order of the model; the score counts worst as 0 and masterpiece as 6.
LABELS = ("masterpiece", "best", "great", "good", "normal", "low", "worst")
_LABEL_SCORES = np.arange(len(LABELS) - 1, -1, -1, dtype=np.float64)
# Grade by percentile among the reference samples, highest first.
GRADE_CUTS: Tuple[Tuple[str, float], ...] = (
    ("masterpiece", 0.95),
    ("best", 0.85),
    ("great", 0.75),
    ("good", 0.50),
    ("normal", 0.25),
    ("low", 0.10),
    ("worst", 0.0),
)


@dataclass(frozen=True)
class AnimeAesthetic:
    score: float
    percentile: float
    grade: str


_lock = threading.Lock()
_session: Any = None
_session_uses_gpu: Optional[bool] = None
_samples: Optional[Tuple[np.ndarray, np.ndarray]] = None
# Set when the installed files cannot be opened, so runs stop asking for grades
# (every graded picture would otherwise stay "to score"); cleared by unload().
_load_failed = False


class _GpuResident:
    """Lets other GPU models evict this session (and this one evict them)."""

    def release(self) -> None:
        # Eviction frees memory only; it must not clear the "unusable" mark.
        _drop_session()


_RESIDENT = _GpuResident()


def models_dir() -> Path:
    return Path(__file__).parent.parent / "models" / "aesthetic"


def model_path() -> Path:
    return models_dir() / MODEL_FILENAME


def samples_path() -> Path:
    return models_dir() / SAMPLES_FILENAME


def _external_pair() -> Tuple[Optional[Path], Optional[Path]]:
    """The model and its samples from a trusted folder, when the recorded pair is intact."""
    model = model_external.usable_path("aesthetic-anime")
    samples = model_external.usable_companion("aesthetic-anime", None, 0)
    if model and samples:
        return Path(model), Path(samples)
    return None, None


def files_in_use() -> Tuple[Path, Path]:
    """(model, samples) to read: the program's own pair, else a trusted pair, else the own paths."""
    if not (
        pinned_download.is_present(model_path())
        or pinned_download.is_present(samples_path())
    ):
        model, samples = _external_pair()
        if model is not None and samples is not None:
            return model, samples
    return model_path(), samples_path()


def is_installed() -> bool:
    model, samples = files_in_use()
    return pinned_download.is_present(model) and pinned_download.is_present(samples)


def is_scoring() -> bool:
    """Installed and not known to be unloadable: only then do runs ask for grades."""
    return is_installed() and not _load_failed


def health() -> Dict[str, Any]:
    model, samples = files_in_use()
    model_ok = pinned_download.is_present(model)
    samples_ok = pinned_download.is_present(samples)
    if model_ok and samples_ok and _load_failed:
        key, message = (
            "models.aestheticAnime.broken",
            "The anime aesthetic files could not be loaded. Click Prepare / Download to replace them.",
        )
    elif model_ok and samples_ok:
        key, message = (
            "models.aestheticAnime.ready",
            "Anime aesthetic grades are installed. The next aesthetic scoring run adds them.",
        )
    elif model_ok or samples_ok:
        key, message = (
            "models.aestheticAnime.partial",
            "Only part of the anime aesthetic model is downloaded. Click Prepare / Download to finish.",
        )
    else:
        key, message = (
            "models.aestheticAnime.missing",
            "Not downloaded yet. Click Prepare / Download (~420 MB, plus the Aesthetic Predictor).",
        )
    return {
        "available": model_ok and samples_ok and not _load_failed,
        "model_path": str(model) if model_ok else None,
        "source": (
            model_external.source_for_path("aesthetic-anime", None, str(model))
            if model_ok
            else None
        ),
        "expected_path": str(model_path()),
        "message_key": key,
        "message": message,
    }


def prepare(download_file: Callable[..., Path]) -> Dict[str, str]:
    """Download and verify both files; verified copies on disk are kept as they are
    (a trusted pair in use is left alone)."""
    in_use = files_in_use()
    if in_use != (model_path(), samples_path()):
        return {"model_path": str(in_use[0]), "samples_path": str(in_use[1])}
    paths = {
        "model_path": pinned_download.fetch(
            MODEL_FILE, model_path(), download_file, model_name="Anime aesthetic"
        ),
        "samples_path": pinned_download.fetch(
            SAMPLES_FILE, samples_path(), download_file, model_name="Anime aesthetic"
        ),
    }
    unload()
    return {key: str(path) for key, path in paths.items()}


def score_from_probabilities(probabilities: np.ndarray) -> float:
    return float(np.dot(np.asarray(probabilities, dtype=np.float64), _LABEL_SCORES))


def percentile_for(score: float, xs: np.ndarray, ys: np.ndarray) -> float:
    return float(np.interp(np.clip(score, xs[0], xs[-1]), xs, ys))


def grade_for(percentile: float) -> str:
    return next(name for name, cut in GRADE_CUTS if percentile >= cut)


def preprocess(picture) -> np.ndarray:
    """PIL picture -> (1, 3, 448, 448) float32 in [-1, 1], transparency on white."""
    from PIL import Image

    rgba = picture.convert("RGBA")
    white = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
    resample = getattr(Image, "Resampling", Image).BILINEAR
    rgb = (
        Image.alpha_composite(white, rgba)
        .convert("RGB")
        .resize((INPUT_SIZE, INPUT_SIZE), resample)
    )
    data = np.asarray(rgb, dtype=np.float32).transpose(2, 0, 1) / 255.0
    return ((data - 0.5) / 0.5)[None, ...].astype(np.float32)


def _cuda_provider_available() -> bool:
    from runtime_env import prepare_onnxruntime_environment

    prepare_onnxruntime_environment()
    import onnxruntime as ort

    return "CUDAExecutionProvider" in ort.get_available_providers()


def _open_session(path: Path, *, use_gpu: bool):
    """``use_gpu`` here means the CUDA provider is available and wanted."""
    import onnxruntime as ort

    providers = ["CUDAExecutionProvider", "CPUExecutionProvider"] if use_gpu else ["CPUExecutionProvider"]
    options = ort.SessionOptions()
    # The CPU path must not saturate the machine next to the CLIP pass.
    options.intra_op_num_threads = 2 if use_gpu else 4
    options.add_session_config_entry("session.intra_op.allow_spinning", "0")
    return ort.InferenceSession(str(path), sess_options=options, providers=providers)


def _load_samples(path: Path) -> Tuple[np.ndarray, np.ndarray]:
    with np.load(path) as data:
        xs, ys = data["arr_0"][0], data["arr_0"][1]
    order = np.argsort(xs)
    return xs[order], ys[order]


def _load_locked(*, use_gpu: bool) -> None:
    global _session, _session_uses_gpu, _samples

    if _session is None or _session_uses_gpu != use_gpu:
        _session = None
        # A CPU-only ONNX Runtime runs on the CPU even when the GPU is wanted,
        # and then must not evict other models from the GPU.
        on_gpu = use_gpu and _cuda_provider_available()
        if on_gpu:
            claim_gpu_residency(_RESIDENT, _RESIDENT.release, label="anime-aesthetic")
        else:
            forget_gpu_residency(_RESIDENT)
        try:
            _session = _open_session(files_in_use()[0], use_gpu=on_gpu)
        except Exception:
            forget_gpu_residency(_RESIDENT)
            raise
        _session_uses_gpu = use_gpu
    if _samples is None:
        _samples = _load_samples(files_in_use()[1])


def load(*, use_gpu: bool) -> None:
    """Open the model and read the samples; raises (and stops grading) when unusable."""
    global _load_failed

    with _lock:
        try:
            _load_locked(use_gpu=use_gpu)
        except Exception:
            _load_failed = True
            raise


def predict(picture, *, use_gpu: bool) -> AnimeAesthetic:
    """Grade one opened picture. Raises when the files are missing or unreadable."""
    with _lock:
        _load_locked(use_gpu=use_gpu)
        session, (xs, ys) = _session, _samples
        feeds = {session.get_inputs()[0].name: preprocess(picture)}
        probabilities = session.run([session.get_outputs()[0].name], feeds)[0][0]

    score = score_from_probabilities(probabilities)
    percentile = percentile_for(score, xs, ys)
    return AnimeAesthetic(
        score=round(score, 4),
        percentile=round(percentile, 4),
        grade=grade_for(percentile),
    )


def _drop_session() -> None:
    global _session, _session_uses_gpu, _samples

    with _lock:
        _session = None
        _session_uses_gpu = None
        _samples = None
    forget_gpu_residency(_RESIDENT)


def unload() -> None:
    """Drop the session and forget an earlier load failure (a fresh start)."""
    global _load_failed

    _drop_session()
    with _lock:
        _load_failed = False
