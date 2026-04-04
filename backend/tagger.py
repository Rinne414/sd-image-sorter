"""
WD14 Tagger using ONNX Runtime for image tagging.
Supports automatic model download from HuggingFace and local model loading.
"""
import os
import json
import logging
import threading
import numpy as np
from typing import List, Dict, Any, Optional, Tuple, TYPE_CHECKING

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


def _ensure_imports():
    """Lazily import heavy dependencies."""
    global ort, hf_hub
    if ort is None:
        import onnxruntime as ort_module  # type: ignore
        ort = ort_module
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

    def _build_session_options(self, gpu_enabled: bool) -> "ort.SessionOptions":
        """Build safer ONNX Runtime session options for the current hardware mode."""
        sess_options = ort.SessionOptions()

        import multiprocessing

        cpu_count = max(1, multiprocessing.cpu_count())
        if gpu_enabled:
            num_threads = 1
        else:
            num_threads = min(4, max(1, cpu_count // 2))

        sess_options.intra_op_num_threads = num_threads
        sess_options.inter_op_num_threads = 1
        sess_options.add_session_config_entry("session.intra_op.allow_spinning", "0")
        sess_options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        sess_options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        sess_options.enable_cpu_mem_arena = False
        sess_options.enable_mem_pattern = False

        logger.debug(
            "ONNX session configured with %s thread(s), gpu_enabled=%s",
            num_threads,
            gpu_enabled,
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
                model_path = hf_hub.hf_hub_download(
                    repo_id=repo_id,
                    filename=config["model_file"],
                    local_dir=os.path.join(self.model_dir, self.model_name)
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
            tags_path = hf_hub.hf_hub_download(
                repo_id=repo_id,
                filename=config["tags_file"],
                local_dir=os.path.join(self.model_dir, self.model_name)
            )
        
        return model_path, tags_path
    
    def _load_tags(self, tags_path: str):
        """Load tag labels from CSV.
        
        IMPORTANT: The model output index is the ROW NUMBER in the CSV (0-indexed after header),
        NOT the tag_id column value. The tag_id column is just metadata.
        """
        self.tags = []
        self.general_tags = []
        self.character_tags = []
        self.rating_tags = []
        self.rating_indices = {}
        
        with open(tags_path, "r", encoding="utf-8") as f:
            lines = f.readlines()
        
        # Skip header, use enumeration index as the model output position
        for row_idx, line in enumerate(lines[1:]):
            parts = line.strip().split(",")
            if len(parts) >= 3:
                # row_idx is the actual index into model output (0-indexed)
                tag_name = parts[1]
                category = int(parts[2])
                
                self.tags.append(tag_name)
                
                if category == 0:
                    self.general_tags.append((row_idx, tag_name))
                elif category == 4:
                    self.character_tags.append((row_idx, tag_name))
                elif category == 9:
                    self.rating_tags.append((row_idx, tag_name))
                    # Map rating name to index
                    self.rating_indices[tag_name] = row_idx
    
    def load(self):
        """Load the model and tags."""
        if self._loaded:
            return

        model_path, tags_path = self._get_model_paths()
        self._resolved_model_path = model_path
        self._resolved_tags_path = tags_path

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

        # Load tags
        self._load_tags(tags_path)

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
    
    def _preprocess(self, image: Image.Image) -> np.ndarray:
        """Preprocess image for inference."""
        # Get input size from model
        assert self.session is not None
        input_shape = self.session.get_inputs()[0].shape
        size = input_shape[2] if len(input_shape) == 4 else 448
        
        # Resize and pad to square
        image = image.convert("RGB")
        
        # Resize keeping aspect ratio
        old_size = image.size
        ratio = float(size) / max(old_size)
        new_size = (int(old_size[0] * ratio), int(old_size[1] * ratio))
        image = image.resize(new_size, Image.Resampling.LANCZOS)
        
        # Pad to square
        new_image = Image.new("RGB", (size, size), (255, 255, 255))
        paste_pos = ((size - new_size[0]) // 2, (size - new_size[1]) // 2)
        new_image.paste(image, paste_pos)
        
        # Convert to numpy
        img_array = np.array(new_image, dtype=np.float32)
        
        # BGR to RGB (if needed) and normalize
        img_array = img_array[:, :, ::-1]  # RGB to BGR for model
        
        # Add batch dimension
        img_array = np.expand_dims(img_array, axis=0)
        
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
            input_data = self._preprocess(image)

        # Run inference
        assert self.session is not None
        input_name = self.session.get_inputs()[0].name
        try:
            output = self.session.run(None, {input_name: input_data})[0]
        except Exception as error:
            if not self._session_uses_gpu():
                raise
            self._fallback_to_cpu_session(error)
            assert self.session is not None
            input_name = self.session.get_inputs()[0].name
            output = self.session.run(None, {input_name: input_data})[0]
        
        # Process output
        probs = output[0]
        
        result: Dict[str, Any] = {
            "general_tags": [],
            "character_tags": [],
            "rating": "unknown",
            "rating_confidences": {},
            "all_tags": []
        }
        
        # Extract general tags
        for tag_id, tag_name in self.general_tags:
            if tag_id < len(probs):
                conf = float(probs[tag_id])
                if conf >= self.threshold:
                    result["general_tags"].append({"tag": tag_name, "confidence": conf})
                    result["all_tags"].append({"tag": tag_name, "confidence": conf})
        
        # Extract character tags
        for tag_id, tag_name in self.character_tags:
            if tag_id < len(probs):
                conf = float(probs[tag_id])
                if conf >= self.character_threshold:
                    result["character_tags"].append({"tag": tag_name, "confidence": conf})
                    result["all_tags"].append({"tag": tag_name, "confidence": conf})
        
        # Get ratings with all confidences
        rating_probs = []
        for tag_id, tag_name in self.rating_tags:
            if tag_id < len(probs):
                conf = float(probs[tag_id])
                rating_probs.append((tag_name, conf))
                result["rating_confidences"][tag_name] = conf
        
        if rating_probs:
            # Only add the HIGHEST confidence rating tag to all_tags
            best_rating = max(rating_probs, key=lambda x: x[1])
            result["rating"] = best_rating[0]
            result["all_tags"].append({"tag": best_rating[0], "confidence": best_rating[1]})
        
        # Sort by confidence
        result["general_tags"].sort(key=lambda x: x["confidence"], reverse=True)
        result["character_tags"].sort(key=lambda x: x["confidence"], reverse=True)
        result["all_tags"].sort(key=lambda x: x["confidence"], reverse=True)

        del input_data
        del output
        del probs

        return result
    
    def tag_batch(self, image_paths: List[str]) -> List[Dict[str, Any]]:
        """Tag multiple images with memory management."""
        import gc
        results = []
        for i, path in enumerate(image_paths):
            try:
                results.append(self.tag(path))
            except Exception as e:
                logger.error(f"Error tagging {path}: {e}")
                results.append({
                    "general_tags": [],
                    "character_tags": [],
                    "rating": "unknown",
                    "rating_confidences": {},
                    "all_tags": [],
                    "error": str(e)
                })
            # Garbage collect every 10 images to prevent memory buildup
            if (i + 1) % 10 == 0:
                gc.collect()
        return results


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
