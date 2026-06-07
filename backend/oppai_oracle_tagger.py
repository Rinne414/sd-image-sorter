"""OppaiOracle V1.1 ONNX tagger backend.

Grio43/OppaiOracle is a from-scratch ViT (~247M params) anime tagger with a
19,294-tag general-only vocabulary. Unlike the WD14 ONNX models it ships with
TWO ONNX inputs (``pixel_values`` + ``padding_mask``) and is exported with the
sigmoid activation already inside the graph, so we cannot reuse the WD14
single-input inference path. This module is a self-contained implementation
that mirrors the public shape of :mod:`tagger.WD14Tagger` (``load`` /
``tag`` / ``tag_batch`` / ``set_session_refresh_interval``) so the existing
``TaggingService`` worker loop can drive it without special-casing every
call site.

Preprocessing reproduces ``preprocessing.json`` exactly:
    * letterbox to 448x448 keeping aspect ratio
    * pad with RGB ``[114, 114, 114]``
    * normalize ``(x/255 - 0.5) / 0.5`` per channel
    * channel order RGB, layout BCHW, dtype float32

The padding mask is True where pixels are padded and False on the actual
image rectangle so the model can mask attention away from the gray bars.
"""
from __future__ import annotations

import csv
import gc
import logging
import os
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple, TYPE_CHECKING

import numpy as np
from PIL import Image

if TYPE_CHECKING:  # pragma: no cover - type-only
    import onnxruntime as ort  # type: ignore

from config import (
    TAGGER_MODELS,
    get_oppai_oracle_model_dir,
)
from ai_runtime_guard import exclusive_ai_runtime, looks_like_cuda_oom
from model_download_sources import endpoint_label, get_hf_endpoint_order
from utils.path_validation import normalize_user_path

logger = logging.getLogger(__name__)

DEFAULT_MODEL = "oppai-oracle-v1.1"

# Shared bounded pool to overlap CPU-bound image decode/letterbox so the GPU is
# not starved between batches (PIL + numpy release the GIL). GPU inference stays
# serialized by exclusive_ai_runtime; this only parallelizes preprocessing.
_PREPROCESS_MAX_WORKERS = min(8, (os.cpu_count() or 4))
_preprocess_executor: Optional[ThreadPoolExecutor] = None
_preprocess_executor_lock = threading.Lock()


def _get_preprocess_executor() -> ThreadPoolExecutor:
    global _preprocess_executor
    if _preprocess_executor is None:
        with _preprocess_executor_lock:
            if _preprocess_executor is None:
                _preprocess_executor = ThreadPoolExecutor(
                    max_workers=_PREPROCESS_MAX_WORKERS,
                    thread_name_prefix="oppai-preprocess",
                )
    return _preprocess_executor


def _normalize_oppai_model_alias(model_name: Optional[str]) -> str:
    """Map a caller-supplied OppaiOracle model name to a registered key.

    The Model Manager card and the Smart Tag wizard both refer to this
    tagger family by the unversioned id ``oppai-oracle`` (see
    ``services/model_service.py`` and ``services/smart_tag_service.py``).
    The tagger registry in ``config.py::TAGGER_MODELS`` keys the actual
    weights under the version-specific ``oppai-oracle-v1.1`` so future
    variants can sit side-by-side.

    Without this resolver, real-click verification (v3.2.2 T2) failed
    with::

        Failed to initialise pipeline: Unknown OppaiOracle model:
        oppai-oracle. Available: ['oppai-oracle-v1.1']

    The resolver translates the family id to the latest registered
    version. Unknown ids fall through unchanged so ``_model_config``
    can still raise the explicit "Unknown OppaiOracle model" error.
    """
    if not model_name:
        return DEFAULT_MODEL
    name = str(model_name).strip().lower()
    if not name:
        return DEFAULT_MODEL
    if name in TAGGER_MODELS:
        return name
    # Family-level alias used by the Model Manager UI and Smart Tag wizard.
    if name == "oppai-oracle":
        return DEFAULT_MODEL
    return name
DEFAULT_THRESHOLD = 0.7927  # P=R global from pr_thresholds.json (V1.1).
PAD_TAG_INDEX = 0
UNK_TAG_INDEX = 1
RATING_TAG_PREFIX = "rating:"

# Lazy-imported heavy modules (kept aligned with backend/tagger.py).
ort = None
hf_hub = None


def _ensure_imports() -> None:
    global ort, hf_hub
    if ort is None:
        from runtime_env import prepare_onnxruntime_environment
        prepare_onnxruntime_environment()
        import onnxruntime as ort_module  # type: ignore
        ort = ort_module
        preload = getattr(ort, "preload_dlls", None)
        if callable(preload):
            try:
                preload()
            except Exception as exc:  # pragma: no cover - depends on system
                logger.debug("onnxruntime.preload_dlls() was not usable: %s", exc)
    if hf_hub is None:
        import huggingface_hub as hf_module
        hf_hub = hf_module


def letterbox_to_square(
    image: Image.Image,
    *,
    target: int,
    pad_color: Tuple[int, int, int],
) -> Tuple[Image.Image, Tuple[int, int, int, int]]:
    """Letterbox ``image`` into a target-sized RGB square.

    Returns the canvas plus the (paste_x, paste_y, new_w, new_h) rectangle
    of the original image inside it so the caller can build a padding mask.
    """
    image = image.convert("RGB")
    src_w, src_h = image.size
    if src_w <= 0 or src_h <= 0:
        raise ValueError(f"degenerate image size: {src_w}x{src_h}")
    ratio = min(target / src_w, target / src_h)
    new_w = max(1, int(round(src_w * ratio)))
    new_h = max(1, int(round(src_h * ratio)))
    resized = image.resize((new_w, new_h), Image.Resampling.LANCZOS)
    canvas = Image.new("RGB", (target, target), pad_color)
    paste_x = (target - new_w) // 2
    paste_y = (target - new_h) // 2
    canvas.paste(resized, (paste_x, paste_y))
    return canvas, (paste_x, paste_y, new_w, new_h)


def preprocess_image(
    image: Image.Image,
    *,
    target: int = 448,
    pad_color: Tuple[int, int, int] = (114, 114, 114),
) -> Tuple[np.ndarray, np.ndarray]:
    """Return ``(pixel_values [3,H,W] float32, padding_mask [H,W] bool)``.

    Reproduces the math documented in V1.1_onnx/preprocessing.json:
        normalize: (x/255 - 0.5) / 0.5 per channel
        layout:    BCHW, RGB
        mask:      True = padded pixel, False = valid pixel
    """
    canvas, (paste_x, paste_y, new_w, new_h) = letterbox_to_square(
        image, target=target, pad_color=pad_color
    )
    arr = np.array(canvas, dtype=np.float32) / 255.0
    arr = (arr - 0.5) / 0.5
    pixel_values = np.transpose(arr, (2, 0, 1)).astype(np.float32, copy=False)

    padding_mask = np.ones((target, target), dtype=bool)
    padding_mask[paste_y : paste_y + new_h, paste_x : paste_x + new_w] = False
    return pixel_values, padding_mask



class OppaiOracleTagger:
    """OppaiOracle V1.1 ONNX tagger with WD14Tagger-compatible public API."""

    def __init__(
        self,
        model_name: str = DEFAULT_MODEL,
        model_path: Optional[str] = None,
        tags_path: Optional[str] = None,
        model_dir: Optional[str] = None,
        threshold: float = DEFAULT_THRESHOLD,
        character_threshold: float = 1.0,
        use_gpu: bool = True,
    ) -> None:
        _ensure_imports()
        self.model_name = _normalize_oppai_model_alias(model_name)
        self.model_path: Optional[str] = normalize_user_path(model_path) if model_path else None
        self.tags_path: Optional[str] = normalize_user_path(tags_path) if tags_path else None
        self.model_dir: str = model_dir or get_oppai_oracle_model_dir()
        self.threshold = float(threshold)
        # OppaiOracle has no character category, but we keep the parameter to
        # match the WD14Tagger constructor used by the tagging service.
        self.character_threshold = float(character_threshold)
        self.use_gpu = bool(use_gpu)

        self.session: Optional["ort.InferenceSession"] = None
        self.tags: List[str] = []
        # general_tags / character_tags / rating_tags mirror WD14Tagger so the
        # tagging-service result post-processing keeps working unchanged.
        self.general_tags: List[Tuple[int, str]] = []
        self.character_tags: List[Tuple[int, str]] = []
        self.rating_tags: List[Tuple[int, str]] = []
        self.rating_indices: Dict[str, int] = {}

        self._loaded = False
        self._resolved_model_path: Optional[str] = None
        self._resolved_tags_path: Optional[str] = None
        self._target = 448
        self._pad_color: Tuple[int, int, int] = (114, 114, 114)
        self._supports_true_batch = True
        self._session_refresh_interval = 0
        self._images_since_session_create = 0

    # ----- file resolution ------------------------------------------------

    def _model_config(self) -> Dict[str, Any]:
        return TAGGER_MODELS.get(self.model_name, {})

    def _expected_local_paths(self) -> Tuple[str, str]:
        """Return ``(model_path, tags_path)`` under the canonical layout.

        Layout: ``<model_dir>/<model_name>/<repo_subfolder>/<file>``. Keeping
        the HF repo subfolder (e.g. ``V1.1_onnx``) means future variants like
        ``V1.1_safetensors`` can sit beside the ONNX one without collisions.
        """
        config = self._model_config()
        subfolder = str(config.get("repo_subfolder") or "").strip("/\\")
        model_file = config.get("model_file") or "model.onnx"
        tags_file = config.get("tags_file") or "selected_tags.csv"
        base = Path(self.model_dir) / self.model_name
        if subfolder:
            base = base / subfolder
        return str(base / model_file), str(base / tags_file)

    def _validate_model_file(self, path: str) -> bool:
        if not os.path.exists(path):
            return False
        try:
            return os.path.getsize(path) > 1024 * 1024
        except OSError:
            return False

    def _download_with_fallback(
        self, *, repo_id: str, filename: str, local_dir: str
    ) -> str:
        assert hf_hub is not None
        endpoints = get_hf_endpoint_order(model_name=f"OppaiOracle {self.model_name}")
        seen: set = set()
        last_error: Optional[Exception] = None
        for endpoint in endpoints:
            key = endpoint.lower()
            if key in seen:
                continue
            seen.add(key)
            try:
                logger.info(
                    "Downloading %s from %s via %s",
                    filename, repo_id, endpoint_label(endpoint),
                )
                return hf_hub.hf_hub_download(
                    repo_id=repo_id,
                    filename=filename,
                    local_dir=local_dir,
                    endpoint=endpoint,
                )
            except Exception as exc:
                last_error = exc
                logger.warning(
                    "Download failed for %s via %s: %s",
                    filename, endpoint_label(endpoint), exc,
                )
        if last_error is None:  # pragma: no cover - defensive
            raise RuntimeError(f"Failed to download {filename} from {repo_id}")
        raise last_error

    def _download_model(self) -> Tuple[str, str]:
        config = self._model_config()
        if not config:
            raise ValueError(
                f"Unknown OppaiOracle model: {self.model_name}. "
                f"Available: {[n for n,c in TAGGER_MODELS.items() if c.get('runtime_backend') == 'oppai-oracle']}"
            )
        repo_id = config["repo_id"]
        subfolder = str(config.get("repo_subfolder") or "").strip("/\\")
        model_file = config["model_file"]
        tags_file = config["tags_file"]
        local_dir = str(Path(self.model_dir) / self.model_name)
        Path(local_dir).mkdir(parents=True, exist_ok=True)

        def _hf_filename(name: str) -> str:
            return f"{subfolder}/{name}" if subfolder else name

        model_path, tags_path = self._expected_local_paths()
        if not self._validate_model_file(model_path):
            if os.path.exists(model_path):
                try:
                    os.remove(model_path)
                except OSError as exc:
                    logger.warning("Could not remove invalid model file: %s", exc)
            logger.info("Downloading OppaiOracle model %s ...", self.model_name)
            model_path = self._download_with_fallback(
                repo_id=repo_id, filename=_hf_filename(model_file), local_dir=local_dir,
            )
            if not self._validate_model_file(model_path):
                raise RuntimeError("Downloaded OppaiOracle model file is invalid.")

        if not os.path.exists(tags_path):
            tags_path = self._download_with_fallback(
                repo_id=repo_id, filename=_hf_filename(tags_file), local_dir=local_dir,
            )

        # Pull the small companion files too so health / debug pages can show
        # the real preprocessing config and threshold table without needing
        # network access on every check.
        for extra in config.get("extra_files") or []:
            extra_path = str(Path(local_dir) / (subfolder or "") / extra)
            if os.path.exists(extra_path):
                continue
            try:
                self._download_with_fallback(
                    repo_id=repo_id, filename=_hf_filename(extra), local_dir=local_dir,
                )
            except Exception as exc:
                logger.warning("Optional file %s not available: %s", extra, exc)
        return model_path, tags_path

    def _get_model_paths(self) -> Tuple[str, str]:
        if self.model_path:
            if not os.path.exists(self.model_path):
                raise FileNotFoundError(f"Custom OppaiOracle model file not found: {self.model_path}")
            if self.tags_path:
                if not os.path.exists(self.tags_path):
                    raise FileNotFoundError(f"Custom tags file not found: {self.tags_path}")
                return self.model_path, self.tags_path
            sibling = Path(self.model_path).parent / "selected_tags.csv"
            if sibling.exists():
                return self.model_path, str(sibling)
            raise ValueError(
                "OppaiOracle requires selected_tags.csv next to the model or via tags_path."
            )
        return self._download_model()



    # ----- session management --------------------------------------------

    def _build_session_options(self, gpu_enabled: bool) -> "ort.SessionOptions":
        import multiprocessing
        opts = ort.SessionOptions()
        cpu_count = max(1, multiprocessing.cpu_count())
        opts.intra_op_num_threads = 2 if gpu_enabled else min(cpu_count, max(2, cpu_count // 2))
        opts.inter_op_num_threads = max(1, opts.intra_op_num_threads // 2)
        opts.add_session_config_entry("session.intra_op.allow_spinning", "0")
        opts.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        opts.enable_cpu_mem_arena = not gpu_enabled
        opts.enable_mem_pattern = not gpu_enabled
        return opts

    def _create_session(
        self, model_path: str, sess_options: "ort.SessionOptions", providers: List[str]
    ) -> "ort.InferenceSession":
        try:
            return ort.InferenceSession(model_path, sess_options=sess_options, providers=providers)
        except Exception as exc:
            error_msg = str(exc)
            if not self.model_path and (
                "INVALID_PROTOBUF" in error_msg or "Protobuf parsing failed" in error_msg
            ):
                logger.error("OppaiOracle model file is corrupted: %s", model_path)
                try:
                    os.remove(model_path)
                except Exception as del_exc:  # pragma: no cover
                    logger.warning("Could not delete corrupted file: %s", del_exc)
                model_path, _ = self._download_model()
                return ort.InferenceSession(model_path, sess_options=sess_options, providers=providers)
            raise RuntimeError(f"Failed to load OppaiOracle ONNX model: {error_msg}") from exc

    def _session_uses_gpu(self) -> bool:
        if self.session is None:
            return False
        providers = self.session.get_providers()
        return "CUDAExecutionProvider" in providers or "DmlExecutionProvider" in providers

    def set_session_refresh_interval(self, interval: int) -> None:
        self._session_refresh_interval = max(0, int(interval))

    # ----- tag table loading ---------------------------------------------

    def _load_tags(self, tags_path: str) -> None:
        """Parse OppaiOracle's selected_tags.csv (header tag_id,name,category).

        All 19,294 entries are nominally category 0. Indices 0-1 are
        ``<PAD>`` / ``<UNK>`` and must be skipped during inference. The
        last 4 entries are ``rating:general/sensitive/questionable/explicit``;
        we route those into the rating split so the existing UI / DB schema
        continue to work.
        """
        self.tags = []
        self.general_tags = []
        self.character_tags = []
        self.rating_tags = []
        self.rating_indices = {}

        with open(tags_path, "r", encoding="utf-8") as f:
            rows = list(csv.reader(f))
        if not rows:
            raise ValueError(f"Empty tag file: {tags_path}")

        header = [str(part or "").strip().lower() for part in rows[0]]
        try:
            id_index = header.index("tag_id")
            name_index = header.index("name")
        except ValueError as exc:
            raise ValueError(
                f"Unexpected OppaiOracle tag header {header}; expected 'tag_id,name,category'."
            ) from exc
        data_rows = rows[1:]

        for parts in data_rows:
            if len(parts) <= max(id_index, name_index):
                continue
            try:
                tag_id = int(parts[id_index])
            except ValueError:
                continue
            tag_name = parts[name_index]
            self.tags.append(tag_name)
            if tag_id in (PAD_TAG_INDEX, UNK_TAG_INDEX):
                continue
            if tag_name.startswith(RATING_TAG_PREFIX):
                rating_name = tag_name[len(RATING_TAG_PREFIX):]
                self.rating_tags.append((tag_id, rating_name))
                self.rating_indices[rating_name] = tag_id
            else:
                self.general_tags.append((tag_id, tag_name))

    # ----- public API ----------------------------------------------------

    def load(self) -> None:
        if self._loaded:
            return
        model_path, tags_path = self._get_model_paths()
        self._resolved_model_path = model_path
        self._resolved_tags_path = tags_path

        config = self._model_config()
        self._target = int(config.get("image_size", 448))
        pad = config.get("pad_color") or [114, 114, 114]
        self._pad_color = (int(pad[0]), int(pad[1]), int(pad[2]))

        if self.use_gpu:
            providers = ["CUDAExecutionProvider", "DmlExecutionProvider", "CPUExecutionProvider"]
        else:
            providers = ["CPUExecutionProvider"]
        available = ort.get_available_providers()
        providers = [p for p in providers if p in available]
        gpu_attempted = self.use_gpu and any(
            p in providers for p in ("CUDAExecutionProvider", "DmlExecutionProvider")
        )

        sess_options = self._build_session_options(gpu_enabled=gpu_attempted)
        try:
            self.session = self._create_session(model_path, sess_options, providers)
        except RuntimeError as exc:
            if gpu_attempted:
                logger.warning("OppaiOracle GPU load failed (%s); falling back to CPU.", exc)
                self.session = self._create_session(
                    model_path,
                    self._build_session_options(gpu_enabled=False),
                    ["CPUExecutionProvider"],
                )
                self.use_gpu = False
            else:
                raise

        if not self._session_uses_gpu():
            self.use_gpu = False

        self._load_tags(tags_path)

        # Sanity-check that the ONNX graph actually has the inputs we expect.
        input_names = {i.name for i in self.session.get_inputs()}
        missing = {"pixel_values", "padding_mask"} - input_names
        if missing:
            raise RuntimeError(
                f"OppaiOracle ONNX is missing required input(s) {sorted(missing)}; "
                f"got {sorted(input_names)}. Re-download or check the model file."
            )

        self._loaded = True
        logger.info(
            "OppaiOracle model loaded (providers=%s, tags=%d, ratings=%s).",
            self.session.get_providers(), len(self.tags), list(self.rating_indices.keys()),
        )



    # ----- inference -----------------------------------------------------

    def _process_probs(
        self,
        probs: np.ndarray,
        *,
        threshold: Optional[float] = None,
        character_threshold: Optional[float] = None,
    ) -> Dict[str, Any]:
        thresh = float(threshold) if threshold is not None else self.threshold
        # character_threshold accepted for API compat; OppaiOracle has no
        # character tags so the parameter is unused beyond bookkeeping.
        del character_threshold

        values = np.asarray(probs, dtype=np.float32).reshape(-1)
        invalid = ~np.isfinite(values)
        if np.any(invalid):
            values = np.where(invalid, 0.0, values)
        out_of_range = (values < -1e-6) | (values > 1.0 + 1e-6)
        if np.any(out_of_range):
            values = np.where(out_of_range, 0.0, values)
        values = np.clip(values, 0.0, 1.0)

        result: Dict[str, Any] = {
            "general_tags": [],
            "character_tags": [],
            "rating": "unknown",
            "rating_confidences": {},
            "all_tags": [],
        }

        for tag_id, tag_name in self.general_tags:
            if tag_id < values.shape[0]:
                conf = float(values[tag_id])
                if conf >= thresh:
                    entry = {"tag": tag_name, "confidence": conf}
                    result["general_tags"].append(entry)
                    result["all_tags"].append(entry)

        rating_probs: List[Tuple[str, float]] = []
        for tag_id, rating_name in self.rating_tags:
            if tag_id < values.shape[0]:
                conf = float(values[tag_id])
                rating_probs.append((rating_name, conf))
                result["rating_confidences"][rating_name] = conf

        if rating_probs:
            best = max(rating_probs, key=lambda x: x[1])
            result["rating"] = best[0]
            result["all_tags"].append({"tag": best[0], "confidence": best[1]})

        result["general_tags"].sort(key=lambda x: x["confidence"], reverse=True)
        result["all_tags"].sort(key=lambda x: x["confidence"], reverse=True)
        return result

    def _build_empty_result(self, error: Optional[str] = None) -> Dict[str, Any]:
        result: Dict[str, Any] = {
            "general_tags": [],
            "character_tags": [],
            "rating": "unknown",
            "rating_confidences": {},
            "all_tags": [],
        }
        if error:
            result["error"] = error
        return result

    def _run_inference(
        self,
        pixel_values: np.ndarray,
        padding_mask: np.ndarray,
        *,
        allow_cpu_fallback: bool = True,
    ) -> np.ndarray:
        assert self.session is not None
        try:
            outputs = self.session.run(
                ["probabilities"],
                {"pixel_values": pixel_values, "padding_mask": padding_mask},
            )
        except Exception as exc:
            # When the caller is doing GPU batch-size backoff it passes
            # ``allow_cpu_fallback=False`` so the OOM propagates and it can retry
            # a SMALLER batch on the GPU first, instead of this method silently
            # dropping the whole run to CPU (permanently) on the first failure.
            if self._session_uses_gpu() and allow_cpu_fallback:
                logger.warning("OppaiOracle GPU inference failed (%s); rebuilding on CPU.", exc)
                self.session = self._create_session(
                    self._resolved_model_path or "",
                    self._build_session_options(gpu_enabled=False),
                    ["CPUExecutionProvider"],
                )
                self.use_gpu = False
                outputs = self.session.run(
                    ["probabilities"],
                    {"pixel_values": pixel_values, "padding_mask": padding_mask},
                )
            else:
                raise
        return outputs[0]

    def _recreate_gpu_session(self) -> None:
        """Rebuild the ONNX session on the GPU to clear CUDA state between
        batch-size backoff steps (mirrors the WD14 tagger). Best-effort: if the
        rebuild fails or no GPU provider is available, the existing session is
        kept and the next attempt simply runs on it."""
        if not self._resolved_model_path or not self._session_uses_gpu():
            return
        try:
            available = ort.get_available_providers()
            providers = [
                p
                for p in ("CUDAExecutionProvider", "DmlExecutionProvider", "CPUExecutionProvider")
                if p in available
            ]
            if not any(p in providers for p in ("CUDAExecutionProvider", "DmlExecutionProvider")):
                return
            self.session = self._create_session(
                self._resolved_model_path,
                self._build_session_options(gpu_enabled=True),
                providers,
            )
        except Exception as exc:  # pragma: no cover - defensive
            logger.warning("OppaiOracle GPU session rebuild failed (%s); keeping current session.", exc)

    def _run_batch_inference_adaptive(
        self,
        pixel_values: np.ndarray,
        padding_mask: np.ndarray,
        *,
        min_chunk_size: int = 1,
        backoff_steps: Optional[List[Dict[str, Any]]] = None,
    ) -> Tuple[np.ndarray, int]:
        """Run inference on a preprocessed batch, halving the GPU sub-chunk on
        failure (e.g. CUDA OOM) and rebuilding the GPU session before giving up
        the GPU. Falls back to CPU only once the sub-chunk is at the floor.

        Mirrors the WD14 tagger's adaptive backoff so a too-large batch degrades
        to a smaller GPU batch instead of crashing or permanently dropping to
        CPU. Returns ``(stacked_probabilities, final_chunk_size)`` where the
        second value lets the caller remember the largest size that worked.
        """
        total = int(pixel_values.shape[0])
        if total == 0:
            return pixel_values[:0], max(1, int(min_chunk_size))

        floor = max(1, int(min_chunk_size))
        collected: List[np.ndarray] = []
        chunk = total
        cursor = 0
        while cursor < total:
            current = min(chunk, total - cursor)
            sub_pv = pixel_values[cursor:cursor + current]
            sub_pm = padding_mask[cursor:cursor + current]
            try:
                probs = self._run_inference(sub_pv, sub_pm, allow_cpu_fallback=False)
            except Exception as exc:
                if self._session_uses_gpu() and current > floor and looks_like_cuda_oom(exc):
                    next_chunk = max(floor, current // 2)
                    logger.warning(
                        "OppaiOracle GPU OOM at batch %d (%s); retrying at %d.",
                        current, exc, next_chunk,
                    )
                    if backoff_steps is not None:
                        backoff_steps.append(
                            {"from": current, "to": next_chunk, "mode": "gpu_backoff", "error": str(exc)}
                        )
                    gc.collect()
                    self._recreate_gpu_session()
                    chunk = next_chunk
                    continue
                # Non-OOM error, or already at the floor: last-resort CPU fallback
                # for this sub-batch. If even CPU fails, let it propagate so the
                # caller can mark just this chunk's images empty (graceful degrade).
                probs = self._run_inference(sub_pv, sub_pm, allow_cpu_fallback=True)
            for row in probs:
                collected.append(row)
            cursor += current
        return np.stack(collected, axis=0), chunk

    def _maybe_refresh_session(self, image_count: int) -> None:
        if image_count <= 0:
            return
        self._images_since_session_create += image_count
        if (
            self._session_refresh_interval > 0
            and self._images_since_session_create >= self._session_refresh_interval
        ):
            self._images_since_session_create = 0
            try:
                self._loaded = False
                self.load()
            except Exception as exc:  # pragma: no cover - defensive
                logger.error("OppaiOracle session recreate failed: %s", exc)

    def tag(
        self,
        image_path: str,
        *,
        threshold: Optional[float] = None,
        character_threshold: Optional[float] = None,
    ) -> Dict[str, Any]:
        with exclusive_ai_runtime("oppai-oracle-tagger"):
            if not self._loaded:
                self.load()
            try:
                with Image.open(image_path) as image:
                    pixel_values, padding_mask = preprocess_image(
                        image, target=self._target, pad_color=self._pad_color
                    )
            except Exception as exc:
                return self._build_empty_result(str(exc))

            pv_batch = np.expand_dims(pixel_values, axis=0)
            pm_batch = np.expand_dims(padding_mask, axis=0)
            probs = self._run_inference(pv_batch, pm_batch)
            self._maybe_refresh_session(1)
            return self._process_probs(
                probs[0],
                threshold=threshold,
                character_threshold=character_threshold,
            )

    def _preprocess_paths(self, paths: List[str]) -> List[Any]:
        """Decode + letterbox-preprocess a chunk in parallel; returns a list
        aligned with ``paths`` where each entry is a ``(pixel_values,
        padding_mask)`` tuple or the Exception that failed it (per-image
        isolation, order preserved). Threads overlap CPU decode so the GPU is
        not starved; serial for a single image."""
        def _one(path: str):
            with Image.open(path) as image:
                return preprocess_image(image, target=self._target, pad_color=self._pad_color)

        if len(paths) <= 1:
            serial: List[Any] = []
            for path in paths:
                try:
                    serial.append(_one(path))
                except Exception as exc:
                    serial.append(exc)
            return serial

        futures = [_get_preprocess_executor().submit(_one, path) for path in paths]
        prepared: List[Any] = []
        for future in futures:
            try:
                prepared.append(future.result())
            except Exception as exc:
                prepared.append(exc)
        return prepared

    def tag_batch(
        self,
        image_paths: List[str],
        *,
        preferred_batch_size: Optional[int] = None,
        min_batch_size: int = 1,
        threshold: Optional[float] = None,
        character_threshold: Optional[float] = None,
        return_runtime_info: bool = False,
    ) -> Any:
        if not image_paths:
            empty: List[Dict[str, Any]] = []
            if return_runtime_info:
                return empty, {
                    "initial_chunk_size": 0,
                    "final_chunk_size": 0,
                    "backoff_steps": [],
                    "used_cpu_fallback": False,
                    "attempted_gpu_backoff": False,
                }
            return empty

        with exclusive_ai_runtime("oppai-oracle-tagger"):
            if not self._loaded:
                self.load()

            initial_chunk = max(1, int(preferred_batch_size or 1))
            chunk = initial_chunk
            min_chunk = max(1, int(min_batch_size or 1))
            results: List[Dict[str, Any]] = [self._build_empty_result() for _ in image_paths]
            backoff_steps: List[Dict[str, Any]] = []

            cursor = 0
            while cursor < len(image_paths):
                end = min(len(image_paths), cursor + chunk)
                batch_paths = image_paths[cursor:end]
                pv_list: List[np.ndarray] = []
                pm_list: List[np.ndarray] = []
                indices: List[int] = []
                prepared_chunk = self._preprocess_paths(batch_paths)
                for offset, prepared in enumerate(prepared_chunk):
                    src_idx = cursor + offset
                    if isinstance(prepared, Exception):
                        logger.error("OppaiOracle preprocess failed for %s: %s", batch_paths[offset], prepared)
                        results[src_idx] = self._build_empty_result(str(prepared))
                    else:
                        pv, pm = prepared
                        pv_list.append(pv)
                        pm_list.append(pm)
                        indices.append(src_idx)

                if pv_list:
                    pv_batch = np.stack(pv_list, axis=0).astype(np.float32, copy=False)
                    pm_batch = np.stack(pm_list, axis=0).astype(bool, copy=False)
                    try:
                        probs_batch, used_chunk = self._run_batch_inference_adaptive(
                            pv_batch,
                            pm_batch,
                            min_chunk_size=min_chunk,
                            backoff_steps=backoff_steps,
                        )
                    except Exception as exc:
                        # Unrecoverable (even the CPU fallback failed): degrade
                        # gracefully by marking this chunk's images empty instead
                        # of sinking the whole call.
                        logger.error(
                            "OppaiOracle inference failed for a %d-image batch (%s); marking empty.",
                            len(indices), exc,
                        )
                        for src_idx in indices:
                            results[src_idx] = self._build_empty_result(str(exc))
                    else:
                        for i, src_idx in enumerate(indices):
                            results[src_idx] = self._process_probs(
                                probs_batch[i],
                                threshold=threshold,
                                character_threshold=character_threshold,
                            )
                        # Remember the largest sub-chunk that actually fit so later
                        # windows don't re-attempt (and re-OOM) the original size.
                        if used_chunk < chunk:
                            chunk = max(min_chunk, used_chunk)
                    self._maybe_refresh_session(len(indices))
                cursor = end

            if return_runtime_info:
                return results, {
                    "initial_chunk_size": initial_chunk,
                    "final_chunk_size": chunk,
                    "backoff_steps": backoff_steps,
                    "used_cpu_fallback": not self.use_gpu,
                    "attempted_gpu_backoff": bool(backoff_steps),
                }
            return results


# ----- module-level singleton --------------------------------------------

_tagger_lock = threading.Lock()
_tagger_singleton: Optional[OppaiOracleTagger] = None
_singleton_settings: Dict[str, Any] = {}


def get_oppai_oracle_tagger(
    model_name: str = DEFAULT_MODEL,
    model_path: Optional[str] = None,
    tags_path: Optional[str] = None,
    threshold: float = DEFAULT_THRESHOLD,
    character_threshold: float = 1.0,
    use_gpu: bool = True,
    force_reload: bool = False,
) -> OppaiOracleTagger:
    """Process-wide singleton, mirroring :func:`tagger.get_tagger`."""
    global _tagger_singleton, _singleton_settings
    with _tagger_lock:
        canonical_name = _normalize_oppai_model_alias(model_name)
        new_settings = {
            "model_name": canonical_name,
            "model_path": model_path,
            "tags_path": tags_path,
            "use_gpu": bool(use_gpu),
        }
        if force_reload or _tagger_singleton is None or new_settings != _singleton_settings:
            _tagger_singleton = OppaiOracleTagger(
                model_name=canonical_name,
                model_path=model_path,
                tags_path=tags_path,
                threshold=threshold,
                character_threshold=character_threshold,
                use_gpu=use_gpu,
            )
            _singleton_settings = new_settings
        else:
            _tagger_singleton.threshold = float(threshold)
            _tagger_singleton.character_threshold = float(character_threshold)
        return _tagger_singleton


__all__ = [
    "DEFAULT_MODEL",
    "DEFAULT_THRESHOLD",
    "OppaiOracleTagger",
    "get_oppai_oracle_tagger",
    "letterbox_to_square",
    "preprocess_image",
]
