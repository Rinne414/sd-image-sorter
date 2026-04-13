"""
WD14 Tagger using ONNX Runtime for image tagging.
Supports automatic model download from HuggingFace and local model loading.
"""
import csv
import gc
import io
import os
import json
import logging
import threading
import time
import numpy as np
from typing import List, Dict, Any, Optional, Tuple, TYPE_CHECKING, Literal, overload

if TYPE_CHECKING:
    import onnxruntime as ort  # type: ignore
from PIL import Image
from pathlib import Path

from config import (
    TAGGER_MODELS as MODELS,
    DEFAULT_TAGGER_MODEL as DEFAULT_MODEL,
    TAGGER_GENERAL_THRESHOLD,
    TAGGER_CHARACTER_THRESHOLD,
    TAGGER_USE_GPU,
    RATING_CATEGORIES as RATINGS,
    get_wd14_model_dir,
)

logger = logging.getLogger(__name__)

# Will be imported lazily
ort = None
hf_hub = None
HF_MIRROR_ENDPOINT = "https://hf-mirror.com"


def _ensure_imports():
    """Lazily import heavy dependencies."""
    global ort, hf_hub
    if ort is None:
        import onnxruntime as ort_module  # type: ignore
        ort = ort_module
        preload = getattr(ort, "preload_dlls", None)
        if callable(preload):
            try:
                preload()
            except Exception as exc:
                logger.debug("onnxruntime.preload_dlls() was not usable: %s", exc)
    if hf_hub is None:
        import huggingface_hub as hf_module
        hf_hub = hf_module


class WD14Tagger:
    """WD14 Tagger for anime-style image tagging using ONNX."""

    def __init__(
        self,
        model_name: str = DEFAULT_MODEL,
        model_path: Optional[str] = None,
        tags_path: Optional[str] = None,
        model_dir: Optional[str] = None,
        threshold: float = TAGGER_GENERAL_THRESHOLD,
        character_threshold: float = TAGGER_CHARACTER_THRESHOLD,
        use_gpu: bool = TAGGER_USE_GPU
    ):
        """
        Initialize the tagger.

        Args:
            model_name: One of the supported model names (for auto-download)
            model_path: Direct path to .onnx file (overrides model_name)
            tags_path: Direct path to selected_tags.csv (required if model_path is set)
            model_dir: Directory to store/load models. If None, uses config default.
            threshold: Confidence threshold for general tags
            character_threshold: Confidence threshold for character tags
            use_gpu: Whether to use GPU acceleration (CUDA) if available
        """
        _ensure_imports()

        self.model_name = model_name
        self.model_path = model_path
        self.tags_path = tags_path
        self.model_dir = model_dir or get_wd14_model_dir()
        self.threshold = threshold
        self.character_threshold = character_threshold
        self.use_gpu = use_gpu

        self.session: Optional["ort.InferenceSession"] = None
        self.tags: List[str] = []
        self.general_tags: List[Tuple[int, str]] = []
        self.character_tags: List[Tuple[int, str]] = []
        self.rating_tags: List[Tuple[int, str]] = []
        self.rating_indices: Dict[str, int] = {}  # Map rating name to index

        self._loaded = False
        self._resolved_model_path: Optional[str] = None
        self._resolved_tags_path: Optional[str] = None
        self._input_name: Optional[str] = None
        self._input_hw: Tuple[int, int] = (448, 448)
        self._supports_true_batch: bool = False
        self._input_layout: str = "nhwc"
        self._input_normalization: str = "wd14_bgr"
        self._pad_color: Tuple[int, int, int] = (255, 255, 255)
        self._metadata_format: str = "wd14_csv"
        self._resize_mode: str = "letterbox"
        self._rating_fallback_mode: str = "none"

        # Session recreation counters (BSOD prevention for GPU mode)
        self._images_since_session_create: int = 0
        self._session_refresh_interval: int = 0
        self._learned_stable_gpu_batch_size: Optional[int] = None
        self._successful_gpu_batch_runs: int = 0

    def _build_session_options(self, gpu_enabled: bool) -> "ort.SessionOptions":
        """Build ONNX Runtime session options optimized for the current hardware mode."""
        sess_options = ort.SessionOptions()

        import multiprocessing

        cpu_count = max(1, multiprocessing.cpu_count())
        if gpu_enabled:
            num_threads = 2
        else:
            num_threads = min(cpu_count, max(2, cpu_count // 2))

        sess_options.intra_op_num_threads = num_threads
        sess_options.inter_op_num_threads = max(1, num_threads // 2)
        sess_options.add_session_config_entry("session.intra_op.allow_spinning", "0")
        sess_options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        sess_options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        sess_options.enable_cpu_mem_arena = not gpu_enabled
        sess_options.enable_mem_pattern = not gpu_enabled

        logger.debug(
            "ONNX session configured with %s intra / %s inter thread(s), gpu_enabled=%s, mem_arena=%s",
            num_threads,
            max(1, num_threads // 2),
            gpu_enabled,
            not gpu_enabled,
        )
        return sess_options

    def _create_session(
        self,
        model_path: str,
        tags_path: str,
        sess_options: "ort.SessionOptions",
        providers: List[str],
    ) -> "ort.InferenceSession":
        """Create an ONNX session, retrying once after repairing a corrupted model."""
        try:
            return ort.InferenceSession(model_path, sess_options=sess_options, providers=providers)
        except Exception as e:
            error_msg = str(e)
            if "INVALID_PROTOBUF" in error_msg or "Protobuf parsing failed" in error_msg:
                logger.error(f"Model file is corrupted: {model_path}")
                logger.info("Attempting to delete and re-download...")

                try:
                    os.remove(model_path)
                    logger.info("Deleted corrupted model file.")
                except Exception as del_error:
                    logger.warning(f"Could not delete corrupted file: {del_error}")

                logger.info("Re-downloading model...")
                model_path, tags_path = self._download_model()
                try:
                    return ort.InferenceSession(model_path, sess_options=sess_options, providers=providers)
                except Exception as e2:
                    raise RuntimeError(f"Failed to load model even after re-download. Error: {e2}") from e2

            raise RuntimeError(f"Failed to load ONNX model: {error_msg}") from e
    
    def _validate_model_file(self, model_path: str) -> bool:
        """
        Validate that an ONNX model file is not corrupted.
        Returns True if valid, False if corrupted or invalid.
        """
        if not os.path.exists(model_path):
            return False
        
        # Check file size - ONNX models should be at least 1MB
        try:
            file_size = os.path.getsize(model_path)
            if file_size < 1024 * 1024:  # Less than 1MB is suspicious
                logger.warning(f"Model file {model_path} is suspiciously small ({file_size} bytes)")
                return False
        except OSError:
            return False

        # Try to read the file header to verify it's a valid ONNX file
        try:
            with open(model_path, 'rb') as f:
                header = f.read(4)
                # ONNX files start with specific protobuf bytes
                if len(header) < 4:
                    return False
        except Exception as e:
            logger.error(f"Error reading model file header: {e}")
            return False
        
        return True
    
    def _get_model_paths(self) -> Tuple[str, str]:
        """Get model and tags file paths."""
        # If direct paths are provided, use them
        if self.model_path and os.path.exists(self.model_path):
            if self.tags_path and os.path.exists(self.tags_path):
                return self.model_path, self.tags_path
            # Try to find tags file next to model
            model_dir = os.path.dirname(self.model_path)
            possible_tags = [
                os.path.join(model_dir, "selected_tags.csv"),
                os.path.join(model_dir, "..", "selected_tags.csv"),
            ]
            for tags_path in possible_tags:
                if os.path.exists(tags_path):
                    return self.model_path, tags_path
            raise ValueError(f"Tags file not found. Please provide tags_path for custom model.")
        
        # Otherwise, download from HuggingFace
        return self._download_model()
    
    def _download_model(self) -> Tuple[str, str]:
        """Download model from HuggingFace if not present."""
        if self.model_name not in MODELS:
            raise ValueError(f"Unknown model: {self.model_name}. Available: {list(MODELS.keys())}")
        
        config = MODELS[self.model_name]
        repo_id = config["repo_id"]
        
        model_path = os.path.join(self.model_dir, self.model_name, config["model_file"])
        tags_path = os.path.join(self.model_dir, self.model_name, config["tags_file"])
        
        # Check if model exists and is valid
        needs_download = False
        if not os.path.exists(model_path):
            needs_download = True
        elif not self._validate_model_file(model_path):
            logger.warning(f"Model file {model_path} appears corrupted. Re-downloading...")
            needs_download = True
            # Delete corrupted file
            try:
                os.remove(model_path)
            except Exception as e:
                logger.warning(f"Could not delete corrupted model file: {e}")

        # Download if needed
        if needs_download:
            logger.info(f"Downloading model {self.model_name}...")
            os.makedirs(os.path.dirname(model_path), exist_ok=True)

            try:
                assert hf_hub is not None
                model_path = self._download_with_fallback(
                    repo_id=repo_id,
                    filename=config["model_file"],
                    local_dir=os.path.join(self.model_dir, self.model_name),
                )

                # Validate after download
                if not self._validate_model_file(model_path):
                    raise ValueError(f"Downloaded model file is invalid. Please check your internet connection and try again.")
            except Exception as e:
                logger.error(f"Error downloading model: {e}")
                raise

        if not os.path.exists(tags_path):
            logger.info("Downloading tags file...")
            assert hf_hub is not None
            tags_path = self._download_with_fallback(
                repo_id=repo_id,
                filename=config["tags_file"],
                local_dir=os.path.join(self.model_dir, self.model_name),
            )

        return model_path, tags_path

    def _download_with_fallback(self, repo_id: str, filename: str, local_dir: str) -> str:
        assert hf_hub is not None
        configured = str(os.environ.get("HF_ENDPOINT", "") or "").strip().rstrip("/")
        endpoints = []
        if configured:
            endpoints.append(configured)
        endpoints.extend(["", HF_MIRROR_ENDPOINT])

        seen = set()
        last_error: Optional[Exception] = None
        for endpoint in endpoints:
            key = endpoint or "__default__"
            if key in seen:
                continue
            seen.add(key)
            try:
                kwargs = {
                    "repo_id": repo_id,
                    "filename": filename,
                    "local_dir": local_dir,
                }
                if endpoint:
                    kwargs["endpoint"] = endpoint
                    logger.info("Downloading %s from %s via %s", filename, repo_id, endpoint)
                return hf_hub.hf_hub_download(**kwargs)
            except Exception as exc:
                last_error = exc
                logger.warning("Download failed for %s via %s: %s", filename, endpoint or "huggingface", exc)

        if last_error is None:
            raise RuntimeError(f"Failed to download {filename} from {repo_id}")
        raise last_error
    
    def _load_tags(self, tags_path: str):
        """Load tag metadata for classic WD CSV files, PixAI CSV exports, or Camie JSON metadata."""
        self.tags = []
        self.general_tags = []
        self.character_tags = []
        self.rating_tags = []
        self.rating_indices = {}

        if self._metadata_format == "camie_v2" or tags_path.lower().endswith('.json'):
            with open(tags_path, "r", encoding="utf-8") as f:
                metadata = json.load(f)
            dataset_info = metadata.get("dataset_info", {})
            tag_mapping = dataset_info.get("tag_mapping", {})
            idx_to_tag = tag_mapping.get("idx_to_tag", {})
            tag_to_category = tag_mapping.get("tag_to_category", {})

            def normalize_rating_name(name: str) -> str:
                lowered = str(name or '').strip().lower()
                if lowered.startswith('rating_'):
                    lowered = lowered.split('rating_', 1)[1]
                return lowered

            for index_key, tag_name in idx_to_tag.items():
                try:
                    tag_idx = int(index_key)
                except (TypeError, ValueError):
                    continue
                category = str(tag_to_category.get(tag_name, 'general')).strip().lower()
                self.tags.append(tag_name)
                if category in {"general", "meta", "year", "artist", "copyright"}:
                    self.general_tags.append((tag_idx, tag_name))
                elif category == "character":
                    self.character_tags.append((tag_idx, tag_name))
                elif category == "rating":
                    normalized = normalize_rating_name(tag_name)
                    self.rating_tags.append((tag_idx, normalized))
                    self.rating_indices[normalized] = tag_idx
            return

        with open(tags_path, "r", encoding="utf-8") as f:
            reader = csv.reader(f)
            rows = list(reader)

        if not rows:
            return

        header = [str(part or "").strip().lower() for part in rows[0]]
        has_named_header = "name" in header and "category" in header
        name_index = header.index("name") if "name" in header else 1
        category_index = header.index("category") if "category" in header else 2
        data_rows = rows[1:] if has_named_header else rows

        for row_idx, parts in enumerate(data_rows):
            if not parts or len(parts) <= max(name_index, category_index):
                continue
            tag_name = parts[name_index]
            try:
                category = int(parts[category_index])
            except ValueError:
                continue
            self.tags.append(tag_name)
            if category == 0:
                self.general_tags.append((row_idx, tag_name))
            elif category == 4:
                self.character_tags.append((row_idx, tag_name))
            elif category == 9:
                self.rating_tags.append((row_idx, tag_name))
                self.rating_indices[tag_name] = row_idx

    def _refresh_session_metadata(self) -> None:
        """Cache input metadata used for preprocessing and true batched inference."""
        if self.session is None:
            self._input_name = None
            self._input_hw = (448, 448)
            self._supports_true_batch = False
            return

        if not hasattr(self.session, "get_inputs"):
            self._input_name = "input"
            self._input_hw = (448, 448)
            self._supports_true_batch = False
            return

        input_info = self.session.get_inputs()[0]
        self._input_name = input_info.name
        input_shape = list(input_info.shape or [])

        width = 448
        height = 448
        if len(input_shape) == 4:
            # WD14 exports used by this project are NHWC: [batch, height, width, 3]
            if isinstance(input_shape[-1], int) and input_shape[-1] == 3:
                height = int(input_shape[1]) if isinstance(input_shape[1], int) else height
                width = int(input_shape[2]) if isinstance(input_shape[2], int) else width
            # Fallback for potential NCHW layouts.
            elif isinstance(input_shape[1], int) and input_shape[1] == 3:
                height = int(input_shape[2]) if isinstance(input_shape[2], int) else height
                width = int(input_shape[3]) if isinstance(input_shape[3], int) else width

        batch_dim = input_shape[0] if input_shape else None
        self._input_hw = (width, height)
        self._supports_true_batch = not isinstance(batch_dim, int) or batch_dim > 1

    def _run_inference(self, input_data: np.ndarray, *, allow_gpu_fallback: bool = True) -> np.ndarray:
        """Run inference and optionally retry once in CPU Safe Mode if CUDA becomes unstable."""
        assert self.session is not None
        input_name = self._input_name or self.session.get_inputs()[0].name
        try:
            return self.session.run(None, {input_name: input_data})[0]
        except Exception as error:
            if not allow_gpu_fallback or not self._session_uses_gpu():
                raise
            self._fallback_to_cpu_session(error)
            assert self.session is not None
            self._refresh_session_metadata()
            retry_input_name = self._input_name or self.session.get_inputs()[0].name
            return self.session.run(None, {retry_input_name: input_data})[0]

    def _finalize_processed_images(self, image_count: int) -> None:
        """Advance refresh counters after successfully processing one or more images."""
        if image_count <= 0:
            return

        self._images_since_session_create += image_count
        if (
            self._session_refresh_interval > 0
            and self._images_since_session_create >= self._session_refresh_interval
        ):
            try:
                self._recreate_session()
            except Exception as exc:
                logger.error("Session recreation failed after inference: %s", exc)

    def _build_empty_result(self, error: Optional[str] = None) -> Dict[str, Any]:
        result: Dict[str, Any] = {
            "general_tags": [],
            "character_tags": [],
            "rating": "unknown",
            "rating_confidences": {},
            "all_tags": []
        }
        if error:
            result["error"] = error
        return result

    def _process_probs(self, probs: np.ndarray) -> Dict[str, Any]:
        """Convert raw WD14 probabilities into the public result payload."""
        result = self._build_empty_result()

        for tag_id, tag_name in self.general_tags:
            if tag_id < len(probs):
                conf = float(probs[tag_id])
                if conf >= self.threshold:
                    result["general_tags"].append({"tag": tag_name, "confidence": conf})
                    result["all_tags"].append({"tag": tag_name, "confidence": conf})

        for tag_id, tag_name in self.character_tags:
            if tag_id < len(probs):
                conf = float(probs[tag_id])
                if conf >= self.character_threshold:
                    result["character_tags"].append({"tag": tag_name, "confidence": conf})
                    result["all_tags"].append({"tag": tag_name, "confidence": conf})

        rating_probs = []
        for tag_id, tag_name in self.rating_tags:
            if tag_id < len(probs):
                conf = float(probs[tag_id])
                rating_probs.append((tag_name, conf))
                result["rating_confidences"][tag_name] = conf

        if rating_probs:
            best_rating = max(rating_probs, key=lambda x: x[1])
            result["rating"] = best_rating[0]
            result["all_tags"].append({"tag": best_rating[0], "confidence": best_rating[1]})
        elif self._rating_fallback_mode == "derive_from_tags":
            result["rating"] = self._derive_fallback_rating(result)
            if result["rating"] != "unknown":
                result["rating_confidences"][result["rating"]] = 1.0
                result["all_tags"].append({"tag": result["rating"], "confidence": 1.0})

        result["general_tags"].sort(key=lambda x: x["confidence"], reverse=True)
        result["character_tags"].sort(key=lambda x: x["confidence"], reverse=True)
        result["all_tags"].sort(key=lambda x: x["confidence"], reverse=True)
        return result

    def _derive_fallback_rating(self, result: Dict[str, Any]) -> str:
        """Infer a usable rating when the model package does not provide a rating head."""
        general_tag_names = {
            str(item.get("tag", "")).strip().lower()
            for item in result.get("general_tags", [])
            if item.get("tag")
        }

        explicit_markers = {
            "sex", "vaginal", "penis", "pussy", "anus", "nipples", "nude",
            "completely_nude", "uncensored", "cum", "fellatio", "masturbation",
            "breasts_out", "topless", "no_panties", "pantyshot", "pubic_hair",
        }
        questionable_markers = {
            "lingerie", "underwear", "panties", "bra", "cameltoe", "cleavage",
            "see-through", "wet", "swimsuit", "bikini", "navel", "thighhighs",
            "garter_straps", "bondage", "bdsm",
        }
        sensitive_markers = {
            "midriff", "bare_shoulders", "stomach", "armpits", "short_shorts",
            "miniskirt", "crop_top", "tube_top",
        }

        if general_tag_names & explicit_markers:
            return "explicit"
        if general_tag_names & questionable_markers:
            return "questionable"
        if general_tag_names & sensitive_markers:
            return "sensitive"
        if general_tag_names:
            return "general"
        return "unknown"
    
    def load(self):
        """Load the model and tags."""
        if self._loaded:
            return

        model_path, tags_path = self._get_model_paths()
        self._resolved_model_path = model_path
        self._resolved_tags_path = tags_path

        model_config = MODELS.get(self.model_name, {})
        self._input_layout = str(model_config.get("input_layout", "nhwc")).lower()
        self._input_normalization = str(model_config.get("input_normalization", "wd14_bgr")).lower()
        self._metadata_format = str(model_config.get("metadata_format", "wd14_csv")).lower()
        self._resize_mode = str(model_config.get("resize_mode", "letterbox")).lower()
        self._rating_fallback_mode = str(model_config.get("rating_fallback_mode", "none")).lower()
        pad_color = model_config.get("pad_color", [255, 255, 255])
        if isinstance(pad_color, (list, tuple)) and len(pad_color) >= 3:
            self._pad_color = (int(pad_color[0]), int(pad_color[1]), int(pad_color[2]))

        # Load ONNX model with error handling
        logger.info(f"Loading model from {model_path}...")

        # Choose providers based on use_gpu setting
        if self.use_gpu:
            providers = ['CUDAExecutionProvider', 'CPUExecutionProvider']
        else:
            providers = ['CPUExecutionProvider']

        available_providers = ort.get_available_providers()
        providers = [p for p in providers if p in available_providers]
        logger.info(f"Using providers: {providers} (GPU {'enabled' if self.use_gpu else 'disabled'})")

        session_uses_gpu = self.use_gpu and 'CUDAExecutionProvider' in providers
        sess_options = self._build_session_options(gpu_enabled=session_uses_gpu)

        try:
            self.session = self._create_session(model_path, tags_path, sess_options, providers)
        except RuntimeError as e:
            if session_uses_gpu:
                logger.warning(
                    "Failed to initialize %s on GPU, retrying with CPU Safe Mode: %s",
                    self.model_name,
                    e,
                )
                cpu_providers = ['CPUExecutionProvider']
                cpu_options = self._build_session_options(gpu_enabled=False)
                self.session = self._create_session(model_path, tags_path, cpu_options, cpu_providers)
                self.use_gpu = False
            else:
                raise

        if self.session is not None and not self._session_uses_gpu():
            self.use_gpu = False

        # Load tags
        self._load_tags(tags_path)
        self._refresh_session_metadata()

        self._loaded = True
        logger.info(f"Model loaded. Using providers: {self.session.get_providers()}")

    def _session_uses_gpu(self) -> bool:
        """Return True when the active ONNX session is using CUDA."""
        return bool(self.session and 'CUDAExecutionProvider' in self.session.get_providers())

    def _fallback_to_cpu_session(self, error: Exception) -> None:
        """Rebuild the active ONNX session in CPU Safe Mode."""
        if not self._resolved_model_path or not self._resolved_tags_path:
            raise RuntimeError("Cannot switch tagger to CPU Safe Mode before model paths are resolved.") from error

        logger.warning(
            "GPU inference failed for %s, switching to CPU Safe Mode: %s",
            self.model_name,
            error,
        )
        cpu_options = self._build_session_options(gpu_enabled=False)
        self.session = self._create_session(
            self._resolved_model_path,
            self._resolved_tags_path,
            cpu_options,
            ['CPUExecutionProvider'],
        )
        self.use_gpu = False
        self._learned_stable_gpu_batch_size = None
        self._successful_gpu_batch_runs = 0
        self._refresh_session_metadata()

    def _run_true_batch_with_backoff(
        self,
        prepared_inputs: List[np.ndarray],
        prepared_indices: List[int],
        image_paths: List[str],
        *,
        initial_chunk_size: Optional[int] = None,
        min_chunk_size: int = 1,
        retry_cooldown_seconds: float = 0.15,
    ) -> Tuple[List[Optional[Dict[str, Any]]], Dict[str, Any]]:
        """Run batched inference with adaptive backoff before giving up on GPU."""
        results: List[Optional[Dict[str, Any]]] = [None] * len(image_paths)
        prepared_count = len(prepared_indices)
        if prepared_count == 0:
            return results, {
                "initial_chunk_size": 0,
                "final_chunk_size": 0,
                "backoff_steps": [],
                "used_cpu_fallback": False,
                "attempted_gpu_backoff": False,
            }

        preferred_chunk_size = max(1, min(initial_chunk_size or prepared_count, prepared_count))
        learned_chunk_size = self._learned_stable_gpu_batch_size if self._session_uses_gpu() else None
        if learned_chunk_size:
            chunk_size = max(1, min(int(learned_chunk_size), preferred_chunk_size, prepared_count))
        else:
            chunk_size = preferred_chunk_size
        min_chunk_size = max(1, min(min_chunk_size, chunk_size))
        initial_chunk_size = chunk_size
        backoff_steps: List[Dict[str, Any]] = []
        attempted_gpu_backoff = False
        used_cpu_fallback = False
        cursor = 0
        raised_after_stable_runs = False

        while cursor < prepared_count:
            current_chunk_size = min(chunk_size, prepared_count - cursor)
            current_inputs = prepared_inputs[cursor:cursor + current_chunk_size]
            current_indices = prepared_indices[cursor:cursor + current_chunk_size]

            try:
                batch_input = np.stack(current_inputs, axis=0)
                output = self._run_inference(batch_input, allow_gpu_fallback=False)
                for output_index, source_index in enumerate(current_indices):
                    results[source_index] = self._process_probs(output[output_index])
                self._finalize_processed_images(len(current_indices))
                if self._session_uses_gpu():
                    self._learned_stable_gpu_batch_size = max(
                        int(self._learned_stable_gpu_batch_size or 1),
                        int(current_chunk_size),
                    )
                    self._successful_gpu_batch_runs += 1
                    if (
                        not raised_after_stable_runs
                        and current_chunk_size < preferred_chunk_size
                        and self._successful_gpu_batch_runs >= 2
                    ):
                        next_candidate = min(preferred_chunk_size, max(current_chunk_size + 1, current_chunk_size * 2))
                        if next_candidate > chunk_size:
                            chunk_size = next_candidate
                            raised_after_stable_runs = True
                del batch_input
                del output
                cursor += current_chunk_size
                continue
            except Exception as error:
                session_uses_gpu = self._session_uses_gpu()
                logger.warning(
                    "True batched WD14 inference failed for chunk size %d on %s: %s",
                    current_chunk_size,
                    "GPU" if session_uses_gpu else "CPU",
                    error,
                )

                if session_uses_gpu and current_chunk_size > min_chunk_size:
                    attempted_gpu_backoff = True
                    next_chunk_size = max(min_chunk_size, current_chunk_size // 2)
                    if next_chunk_size == current_chunk_size and current_chunk_size > min_chunk_size:
                        next_chunk_size = current_chunk_size - 1
                    backoff_steps.append({
                        "from": current_chunk_size,
                        "to": next_chunk_size,
                        "mode": "gpu_backoff",
                        "error": str(error),
                    })
                    self._learned_stable_gpu_batch_size = max(
                        1,
                        min(next_chunk_size, int(self._learned_stable_gpu_batch_size or next_chunk_size)),
                    )
                    self._successful_gpu_batch_runs = 0
                    raised_after_stable_runs = False
                    self._recreate_session()
                    if retry_cooldown_seconds > 0:
                        time.sleep(retry_cooldown_seconds)
                    chunk_size = next_chunk_size
                    continue

                if session_uses_gpu:
                    attempted_gpu_backoff = True
                    backoff_steps.append({
                        "from": current_chunk_size,
                        "to": 1,
                        "mode": "cpu_fallback",
                        "error": str(error),
                    })
                    self._fallback_to_cpu_session(error)
                    used_cpu_fallback = True
                    chunk_size = 1
                    self._successful_gpu_batch_runs = 0
                    raised_after_stable_runs = False
                    if retry_cooldown_seconds > 0:
                        time.sleep(retry_cooldown_seconds)
                    continue

                # CPU mode: also backoff chunk size if batch > 1
                if current_chunk_size > 1:
                    next_chunk_size = max(1, current_chunk_size // 2)
                    backoff_steps.append({
                        "from": current_chunk_size,
                        "to": next_chunk_size,
                        "mode": "cpu_backoff",
                        "error": str(error),
                    })
                    logger.warning(
                        "CPU batch inference failed at chunk %d, backing off to %d",
                        current_chunk_size, next_chunk_size,
                    )
                    chunk_size = next_chunk_size
                    gc.collect()
                    if retry_cooldown_seconds > 0:
                        time.sleep(retry_cooldown_seconds * 2)
                    continue

                for prepared_index, source_index in enumerate(current_indices):
                    try:
                        single_input = np.expand_dims(current_inputs[prepared_index], axis=0)
                        output = self._run_inference(single_input)
                        results[source_index] = self._process_probs(output[0])
                        self._finalize_processed_images(1)
                        del single_input
                        del output
                    except Exception as single_error:
                        logger.error("Error tagging %s: %s", image_paths[source_index], single_error)
                        results[source_index] = self._build_empty_result(str(single_error))
                cursor += current_chunk_size

        return results, {
            "initial_chunk_size": initial_chunk_size,
            "final_chunk_size": chunk_size,
            "backoff_steps": backoff_steps,
            "used_cpu_fallback": used_cpu_fallback,
            "attempted_gpu_backoff": attempted_gpu_backoff,
        }
    
    def _recreate_session(self) -> None:
        """
        Destroy and rebuild the ONNX inference session to release VRAM.

        ONNX Runtime does not expose a VRAM release API, so after extended GPU
        inference the only way to reclaim leaked device memory is to delete the
        session object entirely and create a fresh one.  This prevents the
        accumulative VRAM leak that leads to Windows BSOD after ~300 images.
        """
        if not self._resolved_model_path or not self._resolved_tags_path:
            logger.warning("Cannot recreate session: model paths not yet resolved.")
            return

        logger.info(
            "Recreating ONNX session after %d images to release VRAM.",
            self._images_since_session_create,
        )

        try:
            if self.session is not None:
                del self.session
                self.session = None
            gc.collect()

            if self.use_gpu:
                providers = ['CUDAExecutionProvider', 'CPUExecutionProvider']
            else:
                providers = ['CPUExecutionProvider']

            available_providers = ort.get_available_providers()
            providers = [p for p in providers if p in available_providers]

            session_uses_gpu = self.use_gpu and 'CUDAExecutionProvider' in providers
            sess_options = self._build_session_options(gpu_enabled=session_uses_gpu)

            self.session = self._create_session(
                self._resolved_model_path,
                self._resolved_tags_path,
                sess_options,
                providers,
            )
            if self.session is not None and not self._session_uses_gpu():
                self.use_gpu = False
            self._refresh_session_metadata()
            self._images_since_session_create = 0
            self._successful_gpu_batch_runs = 0
            logger.info("ONNX session recreated successfully. Providers: %s", self.session.get_providers())
        except Exception as exc:
            logger.error("Failed to recreate ONNX session: %s", exc)
            # Attempt CPU fallback if GPU recreation failed
            if self.use_gpu:
                try:
                    self._fallback_to_cpu_session(exc)
                    self._images_since_session_create = 0
                except Exception as fallback_exc:
                    logger.error("CPU fallback after session recreation failure also failed: %s", fallback_exc)
                    raise

    def set_session_refresh_interval(self, interval: int) -> None:
        """
        Set how many images to process before recreating the ONNX session.

        Args:
            interval: Number of images between session recreations.
                      0 disables automatic recreation.
        """
        self._session_refresh_interval = max(0, interval)
        logger.info("Session refresh interval set to %d", self._session_refresh_interval)

    def _preprocess(self, image: Image.Image) -> np.ndarray:
        """Preprocess image for inference."""
        width, height = self._input_hw

        image = image.convert("RGB")

        if self._resize_mode == "stretch":
            processed_image = image.resize((width, height), Image.Resampling.BILINEAR)
        else:
            old_size = image.size
            ratio = min(float(width) / max(1, old_size[0]), float(height) / max(1, old_size[1]))
            new_size = (int(old_size[0] * ratio), int(old_size[1] * ratio))
            resized_image = image.resize(new_size, Image.Resampling.LANCZOS)
            processed_image = Image.new("RGB", (width, height), self._pad_color)
            paste_pos = ((width - new_size[0]) // 2, (height - new_size[1]) // 2)
            processed_image.paste(resized_image, paste_pos)

        img_array = np.array(processed_image, dtype=np.float32)

        if self._input_normalization == "imagenet":
            img_array = img_array / 255.0
            mean = np.array([0.485, 0.456, 0.406], dtype=np.float32)
            std = np.array([0.229, 0.224, 0.225], dtype=np.float32)
            img_array = (img_array - mean) / std
            if self._input_layout == "nchw":
                img_array = np.transpose(img_array, (2, 0, 1))
            return img_array.astype(np.float32, copy=False)

        if self._input_normalization == "minus_one_to_one":
            img_array = img_array / 255.0
            img_array = (img_array - 0.5) / 0.5
            if self._input_layout == "nchw":
                img_array = np.transpose(img_array, (2, 0, 1))
            return img_array.astype(np.float32, copy=False)

        img_array = img_array[:, :, ::-1]  # RGB to BGR
        if self._input_layout == "nchw":
            img_array = np.transpose(img_array, (2, 0, 1))
        return img_array
    
    def tag(self, image_path: str) -> Dict[str, Any]:
        """
        Tag a single image.
        
        Returns:
            {
                "general_tags": [{"tag": str, "confidence": float}, ...],
                "character_tags": [{"tag": str, "confidence": float}, ...],
                "rating": str,
                "rating_confidences": {"general": float, "sensitive": float, ...},
                "all_tags": [{"tag": str, "confidence": float}, ...]
            }
        """
        if not self._loaded:
            self.load()

        # Load and preprocess image
        with Image.open(image_path) as image:
            input_data = np.expand_dims(self._preprocess(image), axis=0)

        output = self._run_inference(input_data)
        probs = output[0]
        result = self._process_probs(probs)

        del input_data
        del output
        del probs

        self._finalize_processed_images(1)

        return result
    
    @overload
    def tag_batch(
        self,
        image_paths: List[str],
        *,
        preferred_batch_size: Optional[int] = ...,
        min_batch_size: int = ...,
        return_runtime_info: Literal[False] = ...,
    ) -> List[Dict[str, Any]]: ...

    @overload
    def tag_batch(
        self,
        image_paths: List[str],
        *,
        preferred_batch_size: Optional[int] = ...,
        min_batch_size: int = ...,
        return_runtime_info: Literal[True],
    ) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]: ...

    def tag_batch(
        self,
        image_paths: List[str],
        *,
        preferred_batch_size: Optional[int] = None,
        min_batch_size: int = 1,
        return_runtime_info: bool = False,
    ) -> Any:
        """Tag multiple images using adaptive true multi-image inference when supported."""
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

        if not self._loaded:
            self.load()

        prepared_inputs: List[np.ndarray] = []
        prepared_indices: List[int] = []
        results: List[Optional[Dict[str, Any]]] = [None] * len(image_paths)

        for index, path in enumerate(image_paths):
            try:
                with Image.open(path) as image:
                    prepared_inputs.append(self._preprocess(image))
                prepared_indices.append(index)
            except Exception as error:
                logger.error("Error preprocessing %s: %s", path, error)
                results[index] = self._build_empty_result(str(error))

        if not prepared_inputs:
            finalized_empty = [result or self._build_empty_result() for result in results]
            if return_runtime_info:
                return finalized_empty, {
                    "initial_chunk_size": 0,
                    "final_chunk_size": 0,
                    "backoff_steps": [],
                    "used_cpu_fallback": False,
                    "attempted_gpu_backoff": False,
                }
            return finalized_empty

        runtime_info = {
            "initial_chunk_size": len(prepared_indices),
            "final_chunk_size": len(prepared_indices),
            "backoff_steps": [],
            "used_cpu_fallback": False,
            "attempted_gpu_backoff": False,
        }

        if self._supports_true_batch and len(prepared_inputs) > 1:
            adaptive_results, runtime_info = self._run_true_batch_with_backoff(
                prepared_inputs,
                prepared_indices,
                image_paths,
                initial_chunk_size=preferred_batch_size,
                min_chunk_size=min_batch_size,
            )
            for index, result in enumerate(adaptive_results):
                if result is not None:
                    results[index] = result
        else:
            for prepared_index, source_index in enumerate(prepared_indices):
                try:
                    single_input = np.expand_dims(prepared_inputs[prepared_index], axis=0)
                    output = self._run_inference(single_input)
                    results[source_index] = self._process_probs(output[0])
                    self._finalize_processed_images(1)
                    del single_input
                    del output
                except Exception as error:
                    logger.error("Error tagging %s: %s", image_paths[source_index], error)
                    results[source_index] = self._build_empty_result(str(error))

        del prepared_inputs
        gc.collect()
        finalized_results = [result or self._build_empty_result() for result in results]
        if return_runtime_info:
            return finalized_results, runtime_info
        return finalized_results


# Singleton instance
_tagger = None
_current_settings = {}
_tagger_lock = threading.Lock()

def get_tagger(
    model_name: str = DEFAULT_MODEL,
    model_path: Optional[str] = None,
    tags_path: Optional[str] = None,
    threshold: float = 0.35,
    character_threshold: float = 0.85,
    use_gpu: bool = True,
    force_reload: bool = False
) -> WD14Tagger:
    """Get or create the tagger instance."""
    global _tagger, _current_settings

    with _tagger_lock:
        new_settings = {
            "model_name": model_name,
            "model_path": model_path,
            "tags_path": tags_path,
            "use_gpu": use_gpu
        }

        # Reload if settings changed or forced
        if force_reload or _tagger is None or new_settings != _current_settings:
            _tagger = WD14Tagger(
                model_name=model_name,
                model_path=model_path,
                tags_path=tags_path,
                threshold=threshold,
                character_threshold=character_threshold,
                use_gpu=use_gpu
            )
            _current_settings = new_settings
        else:
            # Just update thresholds
            _tagger.threshold = threshold
            _tagger.character_threshold = character_threshold

        return _tagger


def get_available_models() -> List[str]:
    """Get list of available model names."""
    return list(MODELS.keys())


def tag_image(image_path: str, threshold: float = 0.35) -> Dict[str, Any]:
    """Convenience function to tag a single image."""
    return get_tagger(threshold=threshold).tag(image_path)
