"""CCIP anime-character embedding + comparator (deepghs/ccip_onnx).

CCIP ("Contrastive Anime Character Image Pre-training", deepghs) verifies
whether two anime images depict the SAME character. Two ONNX graphs:

* ``model_feat.onnx``    — preprocessed image batch -> feature embeddings.
* ``model_metrics.onnx`` — stacked embeddings ``(N, dim)`` -> ``(N, N)``
  difference matrix. This is a small LEARNED comparator, NOT raw cosine
  distance, so pairwise comparison must go through this graph.

Variant pinned here: ``ccip-caformer-24-randaug-pruned`` (the repo's default
configuration). Its published operating threshold is ``0.178`` — pairs with a
difference BELOW the threshold are "same character" (lower = more similar).

Preprocessing is transcribed from dghs-imgutils ``imgutils/metrics/ccip.py``
so embeddings match the reference implementation exactly:
RGB -> resize 384x384 BILINEAR -> float32 / 255 -> normalize with the CLIP
mean/std -> CHW -> batch. We intentionally do NOT depend on dghs-imgutils
itself (it drags opencv/pandas/scipy/shapely and ~10 more packages);
onnxruntime is already a core dependency, so this stays zero-new-deps.

Singleton pattern mirrors ``tagger.py`` / ``censor.py``: module-level
instance behind ``get_ccip()``, heavy imports deferred to first use. v1 runs
CPU-only ONNX sessions — the analysis is an offline advisory background job
(~0.5-2 s/image on CPU), so GPU wiring is deliberately out of scope.
"""

from __future__ import annotations

import logging
import os
import threading
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

import numpy as np

from model_download_sources import get_hf_endpoint_order

logger = logging.getLogger(__name__)

CCIP_REPO_ID = "deepghs/ccip_onnx"
CCIP_MODEL_SUBDIR = "ccip-caformer-24-randaug-pruned"
CCIP_MODEL_FILES = ("model_feat.onnx", "model_metrics.onnx")
# Published same/diff threshold for the pruned-24 variant (deepghs eval).
DEFAULT_THRESHOLD = 0.178

CCIP_IMAGE_SIZE = 384
# CLIP normalization constants — the CCIP training pipeline reuses them.
_CLIP_MEAN = (0.48145466, 0.4578275, 0.40821073)
_CLIP_STD = (0.26862954, 0.26130258, 0.27577711)

# SHA-agnostic sanity floors: a truncated/HTML-error download must never be
# accepted as a model file. model_feat is ~143 MB; model_metrics is a tiny
# comparator graph (a few KB).
_MIN_FILE_BYTES = {
    "model_feat.onnx": 20 * 1024 * 1024,
    "model_metrics.onnx": 512,
}

_EXTRACT_BATCH_SIZE = 4
_DOWNLOAD_TIMEOUT_SECONDS = 900

_download_progress_lock = threading.Lock()
_download_progress: Dict[str, Any] = {
    "active": False,
    "filename": "",
    "downloaded": 0,
    "total": 0,
}


class CCIPCancelled(Exception):
    """Raised when a cooperative cancel event interrupts feature extraction."""


def get_download_progress() -> Dict[str, Any]:
    with _download_progress_lock:
        return dict(_download_progress)


def _set_download_progress(**updates: Any) -> None:
    with _download_progress_lock:
        _download_progress.update(updates)


def get_ccip_model_dir() -> str:
    """Model directory, package-local like the other model dirs in config.

    ``config.py`` keeps one ``get_*_model_dir()`` per model family; CCIP reads
    the same layout (``data/models/ccip``) locally to keep this feature
    self-contained. Env override follows the established naming scheme.
    """
    override = os.environ.get("SD_IMAGE_SORTER_CCIP_MODEL_DIR", "").strip()
    if override:
        model_dir = Path(override)
    else:
        from config import get_data_dir

        model_dir = Path(get_data_dir()) / "models" / "ccip"
    model_dir.mkdir(parents=True, exist_ok=True)
    return str(model_dir)


def _download_file(url: str, dest: Path, *, min_bytes: int) -> None:
    """Stream one file to ``dest`` atomically with size sanity checks."""
    import urllib.request

    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".tmp")
    request = urllib.request.Request(url, headers={"User-Agent": "sd-image-sorter"})
    _set_download_progress(active=True, filename=dest.name, downloaded=0, total=0)
    try:
        with (
            urllib.request.urlopen(request, timeout=_DOWNLOAD_TIMEOUT_SECONDS) as src,
            open(tmp, "wb") as out,
        ):
            expected = int(src.headers.get("Content-Length") or 0)
            _set_download_progress(total=expected)
            downloaded = 0
            while True:
                chunk = src.read(1 << 20)
                if not chunk:
                    break
                out.write(chunk)
                downloaded += len(chunk)
                _set_download_progress(downloaded=downloaded)
        size = tmp.stat().st_size
        if expected > 0 and size != expected:
            raise RuntimeError(
                f"Downloaded size {size} does not match Content-Length {expected} for {dest.name}"
            )
        if size < min_bytes:
            raise RuntimeError(
                f"Downloaded file {dest.name} is only {size} bytes (expected at least {min_bytes})"
            )
        os.replace(str(tmp), str(dest))
    except Exception:
        tmp.unlink(missing_ok=True)
        raise
    finally:
        _set_download_progress(active=False, filename="", downloaded=0, total=0)


def medoid_from_diffs(
    diffs: np.ndarray, threshold: float = DEFAULT_THRESHOLD
) -> Dict[str, Any]:
    """Medoid + distance-to-medoid analysis over an ``(N, N)`` difference matrix.

    The medoid is the image with the minimum total difference to all others —
    plain numpy, no sklearn. Images whose difference to the medoid exceeds
    ``threshold`` are flagged as suspected outliers. Advisory math only; the
    caller decides what (if anything) to do with the flags.
    """
    matrix = np.asarray(diffs, dtype=np.float64)
    if matrix.ndim != 2 or matrix.shape[0] != matrix.shape[1] or matrix.shape[0] == 0:
        raise ValueError(
            f"Expected a non-empty square difference matrix, got shape {matrix.shape}"
        )
    medoid_index = int(np.argmin(matrix.sum(axis=1)))
    distances = [float(value) for value in matrix[medoid_index]]
    return {
        "medoid_index": medoid_index,
        "distances": distances,
        "threshold": float(threshold),
        "outlier_flags": [distance > float(threshold) for distance in distances],
    }


class CCIPModel:
    """Lazy loader around the two CCIP ONNX sessions."""

    def __init__(self, model_dir: Optional[str] = None):
        self._explicit_model_dir = model_dir
        self._sessions: Dict[str, Any] = {}
        self._session_lock = threading.Lock()

    @property
    def model_dir(self) -> Path:
        base = (
            Path(self._explicit_model_dir)
            if self._explicit_model_dir
            else Path(get_ccip_model_dir())
        )
        return base / CCIP_MODEL_SUBDIR

    def missing_files(self) -> List[str]:
        missing: List[str] = []
        for filename in CCIP_MODEL_FILES:
            path = self.model_dir / filename
            try:
                if not path.exists() or path.stat().st_size < _MIN_FILE_BYTES[filename]:
                    missing.append(filename)
            except OSError:
                missing.append(filename)
        return missing

    def is_available(self) -> bool:
        return not self.missing_files()

    def download_models(self) -> Dict[str, Any]:
        """Download any missing model files, trying mirrors in endpoint order.

        Reuses the shared Download Source setting (`auto` / `hf-mirror` /
        `modelscope`) via ``get_hf_endpoint_order`` — the CCIP repo is
        HuggingFace-hosted, so ModelScope mode falls back to hf-mirror the
        same way the other HF-only models do.
        """
        downloaded: List[str] = []
        for filename in CCIP_MODEL_FILES:
            dest = self.model_dir / filename
            if dest.exists() and dest.stat().st_size >= _MIN_FILE_BYTES[filename]:
                continue
            last_error: Optional[Exception] = None
            for endpoint in get_hf_endpoint_order(model_name="CCIP"):
                url = f"{endpoint}/{CCIP_REPO_ID}/resolve/main/{CCIP_MODEL_SUBDIR}/{filename}"
                try:
                    logger.info("Downloading CCIP file %s from %s", filename, url)
                    _download_file(url, dest, min_bytes=_MIN_FILE_BYTES[filename])
                    downloaded.append(filename)
                    last_error = None
                    break
                except Exception as exc:  # noqa: BLE001 - try the next mirror
                    logger.warning("CCIP download failed from %s: %s", url, exc)
                    last_error = exc
            if last_error is not None:
                raise RuntimeError(f"Could not download {filename}: {last_error}")
        return {"downloaded": downloaded, "model_dir": str(self.model_dir)}

    # ------------------------------ sessions ------------------------------

    def _get_session(self, filename: str):
        with self._session_lock:
            session = self._sessions.get(filename)
            if session is not None:
                return session
            model_path = self.model_dir / filename
            if not model_path.exists():
                raise FileNotFoundError(
                    f"CCIP model file missing: {model_path}. Prepare the model first."
                )
            from runtime_env import prepare_onnxruntime_environment

            prepare_onnxruntime_environment()
            import onnxruntime as ort  # type: ignore

            # CPU-only in v1: the purity job is an offline advisory task and
            # onnxruntime-gpu wiring (provider fallback, OOM guard) is what
            # tagger.py exists for — not duplicated here.
            session = ort.InferenceSession(
                str(model_path), providers=["CPUExecutionProvider"]
            )
            self._sessions[filename] = session
            return session

    # ---------------------------- preprocessing ----------------------------

    @staticmethod
    def preprocess(image) -> np.ndarray:
        """PIL image -> CHW float32, matching imgutils' CCIP preprocessing."""
        from PIL import Image as PILImage

        rgb = image if image.mode == "RGB" else image.convert("RGB")
        resample = getattr(PILImage, "Resampling", PILImage).BILINEAR
        resized = rgb.resize((CCIP_IMAGE_SIZE, CCIP_IMAGE_SIZE), resample)
        array = np.asarray(resized, dtype=np.float32) / 255.0
        array = (array - np.asarray(_CLIP_MEAN, dtype=np.float32)) / np.asarray(
            _CLIP_STD, dtype=np.float32
        )
        return array.transpose(2, 0, 1).astype(np.float32)

    # ------------------------------ inference ------------------------------

    def extract_features(
        self,
        paths: List[str],
        progress_callback: Optional[Callable[[int, int], None]] = None,
        cancel_event: Optional[threading.Event] = None,
    ) -> Tuple[np.ndarray, List[int]]:
        """Extract CCIP embeddings for ``paths``.

        Returns ``(features, failed_indices)`` where ``features`` has one row
        per successfully-read image (input order preserved) and
        ``failed_indices`` lists positions in ``paths`` that could not be
        decoded. Unreadable images never abort the whole batch.
        """
        from PIL import Image as PILImage

        session = self._get_session("model_feat.onnx")
        input_name = session.get_inputs()[0].name

        features: List[np.ndarray] = []
        failed_indices: List[int] = []
        pending: List[np.ndarray] = []
        done = 0

        def _flush() -> None:
            if not pending:
                return
            batch = np.stack(pending, axis=0).astype(np.float32)
            output = session.run(None, {input_name: batch})[0]
            features.extend(np.asarray(row, dtype=np.float32) for row in output)
            pending.clear()

        for index, path in enumerate(paths):
            if cancel_event is not None and cancel_event.is_set():
                raise CCIPCancelled()
            try:
                with PILImage.open(path) as img:
                    pending.append(self.preprocess(img))
            except Exception as exc:  # noqa: BLE001 - per-image failure is data, not a crash
                logger.warning("CCIP could not read image %s: %s", path, exc)
                failed_indices.append(index)
            if len(pending) >= _EXTRACT_BATCH_SIZE:
                _flush()
            done += 1
            if progress_callback:
                progress_callback(done, len(paths))
        _flush()

        if not features:
            return np.zeros((0, 0), dtype=np.float32), failed_indices
        return np.stack(features, axis=0), failed_indices

    def pairwise_diff(self, features: np.ndarray) -> np.ndarray:
        """Run the learned comparator over stacked features -> ``(N, N)``.

        The published metrics graph takes ``{'input': (N, dim) float32}`` and
        returns the full difference matrix. Input name/rank are read from the
        session at runtime instead of being hard-coded, because the repo
        publishes several pruned variants.
        """
        session = self._get_session("model_metrics.onnx")
        model_input = session.get_inputs()[0]
        array = np.asarray(features, dtype=np.float32)
        declared_rank = len(model_input.shape or [])
        if declared_rank == 3 and array.ndim == 2:
            array = array[None, ...]
        output = np.asarray(
            session.run(None, {model_input.name: array})[0], dtype=np.float32
        )
        if output.ndim == 3:
            output = output[0]
        if output.ndim != 2 or output.shape[0] != output.shape[1]:
            raise RuntimeError(f"Unexpected CCIP metrics output shape: {output.shape}")
        return output

    def medoid_analysis(
        self, features: np.ndarray, threshold: float = DEFAULT_THRESHOLD
    ) -> Dict[str, Any]:
        return medoid_from_diffs(self.pairwise_diff(features), threshold=threshold)


_ccip_instance: Optional[CCIPModel] = None
_ccip_lock = threading.Lock()


def get_ccip() -> CCIPModel:
    """Get or create the CCIP singleton (mirrors ``get_tagger`` shape)."""
    global _ccip_instance
    if _ccip_instance is None:
        with _ccip_lock:
            if _ccip_instance is None:
                _ccip_instance = CCIPModel()
    return _ccip_instance
