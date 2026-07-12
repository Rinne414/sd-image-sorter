"""
Configuration management for SD Image Sorter.

All configurable values are centralized here with environment variable support.
Copy .env.example to .env and customize as needed.
"""
import json
import logging
import os
import tempfile
from pathlib import Path
from typing import Optional, Tuple

from app_info import GITHUB_LATEST_RELEASE_API_URL, GITHUB_REPOSITORY_URL


logger = logging.getLogger(__name__)


# =============================================================================
# Project Paths
# =============================================================================

def _get_project_root() -> Path:
    """Get the project root directory (parent of backend/)."""
    return Path(__file__).parent.parent.resolve()


def _get_backend_dir() -> Path:
    """Get the backend directory."""
    return Path(__file__).parent.resolve()


_INITIAL_ENV_KEYS = set(os.environ.keys())


def _parse_env_line(line: str) -> Optional[Tuple[str, str]]:
    """Parse a single KEY=VALUE .env line."""
    text = line.strip()
    if not text or text.startswith("#"):
        return None
    if text.startswith("export "):
        text = text[7:].lstrip()
    if "=" not in text:
        return None

    key, value = text.split("=", 1)
    key = key.strip()
    if not key:
        return None

    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
        value = value[1:-1]
    return key, value


def _load_env_file(path: Path, *, override_loaded_values: bool = False) -> None:
    """Load package-local .env files without overriding real process env."""
    if not path.exists() or not path.is_file():
        return

    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return

    for line in lines:
        parsed = _parse_env_line(line)
        if not parsed:
            continue
        key, value = parsed
        if key in _INITIAL_ENV_KEYS:
            continue
        if not override_loaded_values and key in os.environ:
            continue
        os.environ[key] = value


def _bootstrap_package_env() -> None:
    """Support both legacy backend/.env and package-root .env files."""
    backend_env = _get_backend_dir() / ".env"
    package_env = _get_project_root() / ".env"

    _load_env_file(backend_env, override_loaded_values=False)
    _load_env_file(package_env, override_loaded_values=True)


_bootstrap_package_env()


def read_int_env(name: str, default: int) -> int:
    """Read an integer env var with a clear startup error for invalid values."""
    raw_value = os.environ.get(name)
    if raw_value is None:
        return default
    try:
        return int(raw_value)
    except ValueError as exc:
        raise ValueError(f"Invalid {name}: expected integer, got {raw_value!r}") from exc


def read_float_env(name: str, default: float) -> float:
    """Read a float env var with a clear startup error for invalid values."""
    raw_value = os.environ.get(name)
    if raw_value is None:
        return default
    try:
        return float(raw_value)
    except ValueError as exc:
        raise ValueError(f"Invalid {name}: expected number, got {raw_value!r}") from exc


def read_bool_env(name: str, default: bool) -> bool:
    """Read a boolean env var with a clear startup error for invalid values."""
    raw_value = os.environ.get(name)
    if raw_value is None:
        return default
    normalized = raw_value.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    raise ValueError(f"Invalid {name}: expected boolean, got {raw_value!r}")


PROJECT_ROOT: Path = _get_project_root()
BACKEND_DIR: Path = _get_backend_dir()
PACKAGE_ROOT: Path = PROJECT_ROOT
DATA_DIR: Path = Path(
    os.environ.get(
        "SD_IMAGE_SORTER_DATA_DIR",
        str(PACKAGE_ROOT / "data"),
    )
).expanduser()
CONFIG_DIR: Path = Path(
    os.environ.get(
        "SD_IMAGE_SORTER_CONFIG_DIR",
        str(DATA_DIR / "config"),
    )
).expanduser()
TEMP_DIR: Path = Path(
    os.environ.get(
        "SD_IMAGE_SORTER_TMP_DIR",
        str(DATA_DIR / "tmp"),
    )
).expanduser()
STATE_DIR: Path = Path(
    os.environ.get(
        "SD_IMAGE_SORTER_STATE_DIR",
        str(DATA_DIR / "state"),
    )
).expanduser()
UPDATE_DIR: Path = Path(
    os.environ.get(
        "SD_IMAGE_SORTER_UPDATE_DIR",
        str(PACKAGE_ROOT / "update"),
    )
).expanduser()
THUMBNAIL_DIR: Path = Path(
    os.environ.get(
        "SD_IMAGE_SORTER_THUMBNAIL_DIR",
        str(DATA_DIR / "thumbnails"),
    )
).expanduser()
UPDATE_CHANNEL_CONFIG_PATH: Path = CONFIG_DIR / "update-channel.json"
DOWNLOAD_MIRROR_CONFIG_PATH: Path = CONFIG_DIR / "download-mirror.json"
APP_SETTINGS_CONFIG_PATH: Path = CONFIG_DIR / "app-settings.json"
DEFAULT_THUMBNAIL_CACHE_MAX_MB: int = 500
MAX_THUMBNAIL_CACHE_MAX_MB: int = 102400


VALID_MIRRORS = ("auto", "hf-mirror", "modelscope")


def get_download_mirror() -> str:
    """Return the persisted download mirror, defaulting to "auto".

    Reads CONFIG_DIR/download-mirror.json. Logs (rather than swallows) any
    read error so config corruption is surfaced and not silently masked.
    """
    if not DOWNLOAD_MIRROR_CONFIG_PATH.exists():
        return "auto"
    import json as _json
    try:
        raw = DOWNLOAD_MIRROR_CONFIG_PATH.read_text(encoding="utf-8")
    except OSError as exc:
        logger.warning(
            "Could not read download mirror config %s: %s; defaulting to 'auto'",
            DOWNLOAD_MIRROR_CONFIG_PATH,
            exc,
        )
        return "auto"
    try:
        data = _json.loads(raw)
    except _json.JSONDecodeError as exc:
        logger.warning(
            "Download mirror config %s is corrupt (%s); defaulting to 'auto'",
            DOWNLOAD_MIRROR_CONFIG_PATH,
            exc,
        )
        return "auto"
    mirror = str(data.get("mirror", "auto")).strip().lower()
    if mirror not in VALID_MIRRORS:
        logger.warning(
            "Download mirror config has unknown value %r; defaulting to 'auto'",
            mirror,
        )
        return "auto"
    return mirror


def save_download_mirror(mirror: str) -> None:
    mirror = str(mirror).strip().lower()
    if mirror not in VALID_MIRRORS:
        mirror = "auto"
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    DOWNLOAD_MIRROR_CONFIG_PATH.write_text(
        json.dumps({"mirror": mirror}, indent=2),
        encoding="utf-8",
    )


def _read_app_settings() -> dict:
    if not APP_SETTINGS_CONFIG_PATH.exists():
        return {}
    try:
        raw = APP_SETTINGS_CONFIG_PATH.read_text(encoding="utf-8")
    except OSError as exc:
        logger.warning("Could not read app settings %s: %s", APP_SETTINGS_CONFIG_PATH, exc)
        return {}
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        logger.warning("App settings file %s is corrupt (%s); using defaults", APP_SETTINGS_CONFIG_PATH, exc)
        return {}
    return data if isinstance(data, dict) else {}


def _write_app_settings(settings: dict) -> None:
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    APP_SETTINGS_CONFIG_PATH.write_text(
        json.dumps(settings, indent=2, sort_keys=True),
        encoding="utf-8",
    )


def _normalize_thumbnail_cache_max_mb(value: object, *, default: int = DEFAULT_THUMBNAIL_CACHE_MAX_MB) -> int:
    try:
        max_mb = int(value)
    except (TypeError, ValueError):
        return default
    if max_mb < 0:
        return default
    return min(max_mb, MAX_THUMBNAIL_CACHE_MAX_MB)


def get_thumbnail_cache_max_mb() -> int:
    raw_env = os.environ.get("SD_IMAGE_SORTER_THUMBNAIL_CACHE_MAX_MB")
    if raw_env is not None:
        try:
            env_value = int(raw_env)
        except ValueError as exc:
            raise ValueError(
                f"Invalid SD_IMAGE_SORTER_THUMBNAIL_CACHE_MAX_MB: expected integer, got {raw_env!r}"
            ) from exc
        if env_value < 0:
            raise ValueError("Invalid SD_IMAGE_SORTER_THUMBNAIL_CACHE_MAX_MB: expected integer >= 0")
        return min(env_value, MAX_THUMBNAIL_CACHE_MAX_MB)

    settings = _read_app_settings()
    return _normalize_thumbnail_cache_max_mb(settings.get("thumbnail_cache_max_mb"))


def save_thumbnail_cache_max_mb(max_mb: int) -> int:
    normalized = _normalize_thumbnail_cache_max_mb(max_mb)
    settings = _read_app_settings()
    settings["thumbnail_cache_max_mb"] = normalized
    _write_app_settings(settings)
    return normalized
MANUAL_SORT_SESSION_FILE: str = os.environ.get(
    "SD_IMAGE_SORTER_SORT_SESSION_FILE",
    str(STATE_DIR / "sort-session.json"),
)


# =============================================================================
# Database Configuration
# =============================================================================

# Database file path
DATABASE_PATH: str = os.environ.get(
    "SD_IMAGE_SORTER_DB_PATH",
    str(DATA_DIR / "images.db")
)

# Favorites collection defaults
FAVORITES_COLLECTION_SLUG: str = "favorites"
FAVORITES_COLLECTION_NAME: str = "Favorites"
FAVORITES_FOLDER_PATH: str = os.environ.get(
    "SD_IMAGE_SORTER_FAVORITES_PATH",
    str(DATA_DIR / "favorites")
)


# =============================================================================
# Server Configuration
# =============================================================================

# Server host and port
SERVER_HOST: str = os.environ.get("SD_IMAGE_SORTER_HOST", "127.0.0.1")
SERVER_PORT: int = read_int_env("SD_IMAGE_SORTER_PORT", 8487)

# CORS allowed origins (regex pattern for localhost)
CORS_ORIGIN_REGEX: str = r"^https?://(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$"

# Lightweight API rate limiting
RATE_LIMIT_ENABLED: bool = read_bool_env("SD_IMAGE_SORTER_ENABLE_RATE_LIMIT", True)
RATE_LIMIT_WINDOW_SECONDS: int = max(
    1,
    read_int_env("SD_IMAGE_SORTER_RATE_LIMIT_WINDOW_SECONDS", 60),
)
RATE_LIMIT_MAX_REQUESTS: int = max(
    1,
    read_int_env("SD_IMAGE_SORTER_RATE_LIMIT_MAX_REQUESTS", 1000),
)
RATE_LIMIT_APPLY_TO_LOOPBACK: bool = read_bool_env("SD_IMAGE_SORTER_RATE_LIMIT_LOOPBACK", False)


# =============================================================================
# Update Channel Configuration
# =============================================================================

UPDATE_API_URL: str = (
    str(
        os.environ.get(
            "SD_IMAGE_SORTER_UPDATE_API_URL",
            GITHUB_LATEST_RELEASE_API_URL,
        )
        or ""
    ).strip()
    or GITHUB_LATEST_RELEASE_API_URL
)
UPDATE_WEB_URL: str = (
    str(
        os.environ.get(
            "SD_IMAGE_SORTER_UPDATE_WEB_URL",
            f"{GITHUB_REPOSITORY_URL}/releases/latest",
        )
        or ""
    ).strip()
    or f"{GITHUB_REPOSITORY_URL}/releases/latest"
)
UPDATE_DOWNLOAD_URL_PREFIX: str = str(
    os.environ.get("SD_IMAGE_SORTER_UPDATE_DOWNLOAD_URL_PREFIX", "") or ""
).strip()


# =============================================================================
# Model Download Mirror
# =============================================================================

# HuggingFace endpoint override for users who cannot access huggingface.co.
# Set to "https://hf-mirror.com" to use the hf-mirror proxy.
# When set, the huggingface_hub library will download from this endpoint
# instead of the default https://huggingface.co.
# This is equivalent to setting the HF_ENDPOINT environment variable.
HF_ENDPOINT: str = os.environ.get("HF_ENDPOINT", "")

if HF_ENDPOINT:
    # Propagate into the process env so huggingface_hub picks it up
    # even if imported before config.
    os.environ["HF_ENDPOINT"] = HF_ENDPOINT


# =============================================================================
# Model Directories
# =============================================================================

# WD14 Tagger model directory
WD14_MODEL_DIR: str = os.environ.get(
    "SD_IMAGE_SORTER_WD14_MODEL_DIR",
    str(DATA_DIR / "models" / "wd14-tagger")
)

# YOLO/Censor model directory
YOLO_MODEL_DIR: str = os.environ.get(
    "SD_IMAGE_SORTER_YOLO_MODEL_DIR",
    str(DATA_DIR / "models" / "yolo")
)

# Default model cache directory (fallback)
DEFAULT_CACHE_DIR: str = os.environ.get(
    "SD_IMAGE_SORTER_CACHE_DIR",
    str(DATA_DIR / "cache")
)

# Shared local model directories
CLIP_MODEL_DIR: str = os.environ.get(
    "SD_IMAGE_SORTER_CLIP_MODEL_DIR",
    str(DATA_DIR / "models" / "clip")
)
ARTIST_MODEL_DIR: str = os.environ.get(
    "SD_IMAGE_SORTER_ARTIST_MODEL_DIR",
    str(DATA_DIR / "models" / "artist")
)
SAM3_MODEL_DIR: str = os.environ.get(
    "SD_IMAGE_SORTER_SAM3_MODEL_DIR",
    str(DATA_DIR / "models" / "sam3")
)
NUDENET_MODEL_DIR: str = os.environ.get(
    "SD_IMAGE_SORTER_NUDENET_MODEL_DIR",
    str(DATA_DIR / "models" / "nudenet")
)
TORIIGATE_MODEL_DIR: str = os.environ.get(
    "SD_IMAGE_SORTER_TORIIGATE_MODEL_DIR",
    str(DATA_DIR / "models" / "toriigate")
)
OPPAI_ORACLE_MODEL_DIR: str = os.environ.get(
    "SD_IMAGE_SORTER_OPPAI_ORACLE_MODEL_DIR",
    str(DATA_DIR / "models" / "oppai-oracle")
)


# =============================================================================
# WD14 Tagger Configuration
# =============================================================================

# Default tagger model
DEFAULT_TAGGER_MODEL: str = os.environ.get(
    "SD_IMAGE_SORTER_DEFAULT_TAGGER_MODEL",
    "wd-swinv2-tagger-v3"
)

# Default thresholds
TAGGER_GENERAL_THRESHOLD: float = read_float_env("SD_IMAGE_SORTER_TAGGER_GENERAL_THRESHOLD", 0.35)
TAGGER_CHARACTER_THRESHOLD: float = read_float_env("SD_IMAGE_SORTER_TAGGER_CHARACTER_THRESHOLD", 0.85)

# GPU usage
TAGGER_USE_GPU: bool = os.environ.get(
    "SD_IMAGE_SORTER_TAGGER_USE_GPU",
    "true"
).lower() in ("true", "1", "yes")

# Artist (Kaloscope) GPU usage. Same opt-out shape as TAGGER_USE_GPU so users on
# GPU stacks that freeze under CUDA load (e.g. NVIDIA proprietary driver on
# Wayland, where a GPU hang can lock the whole desktop) can run artist ID on CPU.
# CPU is ~2x slower than GPU for Kaloscope (benchmarked) but stable.
ARTIST_USE_GPU: bool = os.environ.get(
    "SD_IMAGE_SORTER_ARTIST_USE_GPU",
    "true"
).lower() in ("true", "1", "yes")

# Available tagger models
TAGGER_MODELS: dict = {
    "wd-eva02-large-tagger-v3": {
        "repo_id": "SmilingWolf/wd-eva02-large-tagger-v3",
        "model_file": "model.onnx",
        "tags_file": "selected_tags.csv",
        "runtime_safety_tier": "heavy",
        "default_threshold": 0.35,
        "default_character_threshold": 0.85,
        "default_copyright_threshold": 0.35,
        "default_max_tags_per_image": 60,
    },
    "wd-swinv2-tagger-v3": {
        "repo_id": "SmilingWolf/wd-swinv2-tagger-v3",
        "model_file": "model.onnx",
        "tags_file": "selected_tags.csv",
        "runtime_safety_tier": "balanced",
        "default_threshold": 0.35,
        "default_character_threshold": 0.85,
        "default_copyright_threshold": 0.35,
        "default_max_tags_per_image": 50,
    },
    "wd-convnext-tagger-v3": {
        "repo_id": "SmilingWolf/wd-convnext-tagger-v3",
        "model_file": "model.onnx",
        "tags_file": "selected_tags.csv",
        "runtime_safety_tier": "balanced",
        "default_threshold": 0.35,
        "default_character_threshold": 0.85,
        "default_copyright_threshold": 0.35,
        "default_max_tags_per_image": 50,
    },
    "wd-vit-tagger-v3": {
        "repo_id": "SmilingWolf/wd-vit-tagger-v3",
        "model_file": "model.onnx",
        "tags_file": "selected_tags.csv",
        "runtime_safety_tier": "light",
        "default_threshold": 0.35,
        "default_character_threshold": 0.85,
        "default_copyright_threshold": 0.35,
        "default_max_tags_per_image": 40,
    },
    "wd-vit-large-tagger-v3": {
        "repo_id": "SmilingWolf/wd-vit-large-tagger-v3",
        "model_file": "model.onnx",
        "tags_file": "selected_tags.csv",
        "runtime_safety_tier": "balanced",
        "default_threshold": 0.35,
        "default_character_threshold": 0.85,
        "default_copyright_threshold": 0.35,
        "default_max_tags_per_image": 55,
    },
    "camie-tagger-v2": {
        "repo_id": "Camais03/camie-tagger-v2",
        "model_file": "camie-tagger-v2.onnx",
        "tags_file": "camie-tagger-v2-metadata.json",
        "runtime_safety_tier": "heavy",
        "metadata_format": "camie_v2",
        "input_layout": "nchw",
        "input_normalization": "imagenet",
        "output_activation": "sigmoid",
        # Camie v2 ONNX has 3 outputs: initial_predictions(70527),
        # refined_predictions(70527), selected_candidates(256). The refined
        # head is the model's real output; index 0 (initial) is a coarse
        # intermediate that misses characters/halo/guitar-level content and
        # emits contradictions (open_mouth + closed_mouth). A/B on a real
        # image: initial had no character and guitar at 0.79; refined gave
        # kayoko_(blue_archive) 0.99, 1girl 1.00, halo 0.88.
        "output_index": 1,
        "pad_color": [124, 116, 104],
        "default_threshold": 0.62,
        "default_character_threshold": 0.78,
        "default_copyright_threshold": 0.62,
        "default_max_tags_per_image": 65,
        "supports_rating": True
    },
    "pixai-tagger-v0.9": {
        "repo_id": "deepghs/pixai-tagger-v0.9-onnx",
        "model_file": "model.onnx",
        "tags_file": "selected_tags.csv",
        "runtime_safety_tier": "heavy",
        "input_layout": "nchw",
        "input_normalization": "minus_one_to_one",
        "resize_mode": "stretch",
        # PixAI v0.9 ONNX has 3 outputs: embedding(1024), logits(13461),
        # prediction(13461). prediction = sigmoid(logits) and is the correct
        # probability vector for thresholding. We must use output index 2
        # (prediction), NOT index 0 (embedding). output_activation stays
        # identity because prediction is already in [0, 1].
        "output_index": 2,
        "output_activation": "identity",
        "default_threshold": 0.45,
        "default_character_threshold": 0.85,
        "default_copyright_threshold": 0.45,
        "default_max_tags_per_image": 65,
        "supports_rating": False,
        "rating_fallback_mode": "derive_from_tags"
    },
    "toriigate-0.5": {
        "repo_id": "Minthy/ToriiGate-0.5",
        "model_file": "config.json",
        "tags_file": "",
        "runtime_backend": "toriigate",
        "runtime_safety_tier": "vlm",
        # Owner decision (2026-07-06): ToriiGate is a captioner, not a
        # tagger. As a gallery tagger it produced 5-7 tags/image with
        # non-danbooru words ("buttocks") and invented anatomy — measured
        # unusable. It stays registered here for model download/prepare and
        # for Smart Tag's natural-language stage, but /api/tag rejects it
        # and the gallery tagger dropdown hides it.
        "captioner_only": True,
        # Hardware floors are calibrated to the actual ToriiGate-0.5
        # checkpoint (Qwen3.5-VL, ~9.6 GB BF16 weights, image capped to
        # 1 MP via TORIIGATE_MAX_IMAGE_PIXELS).
        #
        # Empirical measurement on RTX 3090 (24 GB): peak GPU memory
        # consumption hit 22.7 GB during a real inference (model weights
        # 9.6 GB + PyTorch caching allocator + KV cache + activations).
        # That puts the realistic floor at ~16 GB total VRAM and ~14 GB
        # free VRAM - 12 GB cards (3060, 4070) WILL OOM and must be
        # rejected, but 16 GB cards (4060 Ti 16 GB, A4000) and above
        # work after closing other GPU apps.
        #
        # Host RAM peak during load: ~3-5 GB (transformers uses
        # low_cpu_mem_usage=True which streams safetensors directly to
        # the GPU). The previous 48 GB / 12 GB-free numbers blocked any
        # 32 GB workstation - including the user's 32 GB / RTX 3090
        # setup that successfully tagged a real image at this revision.
        # Those numbers were never re-tuned for ToriiGate's BF16 + GPU
        # streaming loader.
        #
        # CPU mode peak: ~19.3 GB FP32 weights + ~3-5 GB working set =
        # ~24 GB. Keep a safety margin to 32 GB total / 20 GB free so
        # the OS and other apps don't get evicted to swap.
        "minimum_total_ram_gb": 16,
        "minimum_available_ram_gb": 4,
        "minimum_gpu_vram_mb": 16384,
        "minimum_gpu_available_vram_mb": 14000,
        "minimum_cpu_total_ram_gb": 32,
        "minimum_cpu_available_ram_gb": 20,
        "default_threshold": 1.0,
        "default_character_threshold": 1.0,
        "default_copyright_threshold": 1.0,
        "default_max_tags_per_image": 120,
        "supports_rating": True,
    },
    "oppai-oracle-v1.1": {
        # OppaiOracle is a from-scratch ViT (~247M params) anime tagger by
        # Grio43 with a 19,294-tag general-only vocabulary. The V1.1 ONNX
        # bundle lives in the V1.1_onnx/ subfolder of the HF repo and ships
        # two ONNX inputs (pixel_values + padding_mask) instead of the
        # WD14-style single input, so we route it through a dedicated
        # OppaiOracleTagger class via runtime_backend = "oppai-oracle".
        "repo_id": "Grio43/OppaiOracle",
        "repo_subfolder": "V1.1_onnx",
        "model_file": "model.onnx",
        "tags_file": "selected_tags.csv",
        "extra_files": ["preprocessing.json", "pr_thresholds.json", "config.json"],
        "runtime_backend": "oppai-oracle",
        "runtime_safety_tier": "heavy",
        "input_layout": "nchw",
        "input_normalization": "minus_one_to_one",
        "resize_mode": "letterbox",
        "pad_color": [114, 114, 114],
        "image_size": 448,
        # Output is already sigmoid'd inside the graph, so we read it as a
        # probability vector. Indices 0/1 are <PAD>/<UNK> and the last 4
        # entries are the rating:* tags. The tagger handles both quirks.
        "output_activation": "identity",
        "supports_rating": True,
        # 0.7927 is the model's published P=R global threshold (precision ==
        # recall == 0.699 on the held-out 296k val split). At this operating
        # point the model emits ~35-50 tags per image which matches our
        # smoke-test density on real anime images.
        "default_threshold": 0.7927,
        "default_copyright_threshold": 0.7927,
        "default_max_tags_per_image": 60,
        # OppaiOracle's vocabulary is general-only — there is no dedicated
        # character category. Setting the character threshold to 1.0 keeps
        # the existing tagging service shape working without forcing
        # character-tag splits that the model cannot supply.
        "default_character_threshold": 1.0,
    },
}

# Rating categories
RATING_CATEGORIES: list = ["general", "sensitive", "questionable", "explicit"]

# Tag scores (BE-1 virtual re-threshold): persist every tagger score >= floor
# into the tag_scores table at tagging time. Default-on per owner decision #1;
# the floor bounds storage. Owner decision 2026-07-12: floor raised 0.10 ->
# 0.15 (roughly halves storage; the coverage-gaps default band 0.25-0.35 is
# unaffected, only deep-low queries narrow). Disable or tune via env.
# Maintenance: GET /api/tags/scores/stats + POST /api/tags/scores/purge.
TAG_SCORES_ENABLED: bool = read_bool_env("SD_IMAGE_SORTER_TAG_SCORES", True)
TAG_SCORES_FLOOR: float = read_float_env("SD_IMAGE_SORTER_TAG_SCORES_FLOOR", 0.15)


# =============================================================================
# Censor Configuration
# =============================================================================

# Default censor detection confidence threshold
CENSOR_CONFIDENCE_THRESHOLD: float = read_float_env("SD_IMAGE_SORTER_CENSOR_CONFIDENCE", 0.60)

# Default censor IOU threshold for NMS
CENSOR_IOU_THRESHOLD: float = read_float_env("SD_IMAGE_SORTER_CENSOR_IOU_THRESHOLD", 0.45)

# YOLO input size
YOLO_INPUT_SIZE: tuple = (640, 640)

# Default censor class names (wenaka model)
CENSOR_DEFAULT_CLASSES: list = [
    "anus",     # 0
    "cum",      # 1
    "dick",     # 2
    "breasts",  # 3
    "pussy",    # 4
]

# Default censor style settings
CENSOR_DEFAULT_BLOCK_SIZE: int = read_int_env("SD_IMAGE_SORTER_CENSOR_BLOCK_SIZE", 16)
CENSOR_DEFAULT_BLUR_RADIUS: int = read_int_env("SD_IMAGE_SORTER_CENSOR_BLUR_RADIUS", 20)


# =============================================================================
# Similarity/CLIP Configuration
# =============================================================================

# CLIP embedding model
CLIP_MODEL_NAME: str = os.environ.get(
    "SD_IMAGE_SORTER_CLIP_MODEL",
    "Qdrant/clip-ViT-B-32-vision"
)

# Embedding dimensions (for CLIP ViT-B-32)
EMBEDDING_DIMENSIONS: int = 512

# Similarity search defaults
SIMILARITY_DEFAULT_LIMIT: int = read_int_env("SD_IMAGE_SORTER_SIMILARITY_LIMIT", 20)
SIMILARITY_DEFAULT_THRESHOLD: float = read_float_env("SD_IMAGE_SORTER_SIMILARITY_THRESHOLD", 0.5)
DUPLICATE_THRESHOLD: float = read_float_env("SD_IMAGE_SORTER_DUPLICATE_THRESHOLD", 0.95)


# =============================================================================
# Artist Identification Configuration
# =============================================================================

# Default artist identification backend/source
ARTIST_MODEL_SOURCE_DEFAULT: str = os.environ.get(
    "SD_IMAGE_SORTER_ARTIST_MODEL_SOURCE",
    "huggingface"
)

# Default artist model targets Kaloscope2.0.
ARTIST_HF_MODEL_ID: str = os.environ.get(
    "SD_IMAGE_SORTER_ARTIST_HF_MODEL",
    "heathcliff01/Kaloscope2.0"
)

# ModelScope mirror id for the artist model. Defaults to the community Kaloscope
# 2.0 mirror so that selecting "ModelScope" as the download source actually routes
# to modelscope.cn instead of silently falling back to HuggingFace. Set to "" (or
# override) via SD_IMAGE_SORTER_ARTIST_MODELSCOPE_MODEL. Files are fetched via
# direct modelscope.cn resolve URLs (no modelscope SDK dependency) and verified
# against pinned SHA-256 digests; the checkpoint is tried at the repo root first
# (ModelScope's flat layout) then the HuggingFace-style versioned subpath.
ARTIST_MODELSCOPE_MODEL_ID: str = os.environ.get(
    "SD_IMAGE_SORTER_ARTIST_MODELSCOPE_MODEL",
    "Heathcliff02/Kaloscope-2.0",
)

# Optional external LSNet runtime checkout path. This can point to either the
# `lsnet-test` repository root or the `comfyui-lsnet` repository root.
ARTIST_LSNET_CODE_PATH: str = os.environ.get(
    "SD_IMAGE_SORTER_LSNET_CODE_PATH",
    ""
)

# Kaloscope checkpoint/class mapping files inside the HuggingFace repo.
ARTIST_KALOSCOPE_CHECKPOINT: str = os.environ.get(
    "SD_IMAGE_SORTER_ARTIST_KALOSCOPE_CHECKPOINT",
    "448-90.13/best_checkpoint.pth"
)
ARTIST_KALOSCOPE_CLASS_MAPPING: str = os.environ.get(
    "SD_IMAGE_SORTER_ARTIST_KALOSCOPE_CLASS_MAPPING",
    "class_mapping.csv"
)


# =============================================================================
# Image Processing Configuration
# =============================================================================

# Allowed image extensions
ALLOWED_IMAGE_EXTENSIONS: set = {'.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tif', '.tiff'}

# Allowed model extensions
ALLOWED_MODEL_EXTENSIONS: set = {'.onnx', '.pt', '.pth', '.safetensors'}

# Batch processing sizes
TAGGER_BATCH_SIZE: int = read_int_env("SD_IMAGE_SORTER_TAGGER_BATCH_SIZE", 10)
EMBEDDING_BATCH_SIZE: int = read_int_env("SD_IMAGE_SORTER_EMBEDDING_BATCH_SIZE", 10)
DUPLICATE_CHUNK_SIZE: int = read_int_env("SD_IMAGE_SORTER_DUPLICATE_CHUNK_SIZE", 500)
DUPLICATE_SYNC_MAX_EMBEDDINGS: int = read_int_env("SD_IMAGE_SORTER_DUPLICATE_SYNC_MAX_EMBEDDINGS", 5000)


# =============================================================================
# Path Validation Configuration
# =============================================================================

# Maximum path depth to prevent deep nesting attacks
MAX_PATH_DEPTH: int = read_int_env("SD_IMAGE_SORTER_MAX_PATH_DEPTH", 64)

# Maximum path length
# Use a modern default across platforms. Older Windows setups may still fail on
# the underlying filesystem, but the app should not pre-emptively block valid
# longer paths just because the legacy 260-character limit exists.
_default_max_path = 4096

MAX_PATH_LENGTH: int = read_int_env("SD_IMAGE_SORTER_MAX_PATH_LENGTH", _default_max_path)

# Maximum filename length for sanitization
MAX_FILENAME_LENGTH: int = read_int_env("SD_IMAGE_SORTER_MAX_FILENAME_LENGTH", 200)


# =============================================================================
# Gallery/UI Defaults
# =============================================================================

# Default gallery limit
GALLERY_DEFAULT_LIMIT: int = read_int_env("SD_IMAGE_SORTER_GALLERY_LIMIT", 100)

# =============================================================================
# Logging Configuration
# =============================================================================

# Log level
LOG_LEVEL: str = os.environ.get(
    "SD_IMAGE_SORTER_LOG_LEVEL",
    "INFO"
)

# Keep the console focused on app-level status by default. Set to true when
# diagnosing HTTP routing/client polling noise.
LOG_ACCESS_ENABLED: bool = read_bool_env("SD_IMAGE_SORTER_ACCESS_LOG", False)

# Console scrollback can be truncated by terminals/launchers, so keep a small
# rotating backend log for support/debugging by default.
LOG_FILE_ENABLED: bool = read_bool_env("SD_IMAGE_SORTER_LOG_FILE", True)
LOG_FILE_PATH: str = os.environ.get(
    "SD_IMAGE_SORTER_LOG_FILE_PATH",
    str(DATA_DIR / "logs" / "backend.log"),
)
LOG_FILE_MAX_BYTES: int = max(64 * 1024, read_int_env("SD_IMAGE_SORTER_LOG_FILE_MAX_BYTES", 5 * 1024 * 1024))
LOG_FILE_BACKUP_COUNT: int = max(1, read_int_env("SD_IMAGE_SORTER_LOG_FILE_BACKUP_COUNT", 3))


# =============================================================================
# Helper Functions
# =============================================================================

def configure_runtime_temp_env() -> str:
    """Force Python temp files into the package-local temp directory."""
    TEMP_DIR.mkdir(parents=True, exist_ok=True)
    temp_dir = str(TEMP_DIR)
    os.environ["TMPDIR"] = temp_dir
    os.environ["TEMP"] = temp_dir
    os.environ["TMP"] = temp_dir
    tempfile.tempdir = temp_dir
    return temp_dir


def get_data_dir() -> str:
    """Get the package-local data directory, creating it if necessary."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    return str(DATA_DIR)


def get_config_dir() -> str:
    """Get the package-local config directory, creating it if necessary."""
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    return str(CONFIG_DIR)


def get_temp_dir() -> str:
    """Get the package-local temp directory, creating it if necessary."""
    configure_runtime_temp_env()
    return str(TEMP_DIR)


def get_state_dir() -> str:
    """Get the package-local runtime state directory, creating it if necessary."""
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    return str(STATE_DIR)


def get_update_dir() -> str:
    """Get the package-local update directory, creating it if necessary."""
    UPDATE_DIR.mkdir(parents=True, exist_ok=True)
    return str(UPDATE_DIR)


def get_thumbnail_cache_dir() -> str:
    """Get the thumbnail cache directory, creating it if necessary."""
    THUMBNAIL_DIR.mkdir(parents=True, exist_ok=True)
    return str(THUMBNAIL_DIR)


def get_update_channel_config_path() -> str:
    """Get the package-local update channel config path."""
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    return str(UPDATE_CHANNEL_CONFIG_PATH)


def get_wd14_model_dir() -> str:
    """
    Get the WD14 model directory, creating it if necessary.

    Priority:
    1. SD_IMAGE_SORTER_WD14_MODEL_DIR env var
    2. Package-local data/models/wd14-tagger folder
    3. Package-local cache directory (fallback)
    """
    model_dir = Path(WD14_MODEL_DIR)

    if model_dir.exists():
        return str(model_dir)

    # Try to create package-local folder
    try:
        model_dir.mkdir(parents=True, exist_ok=True)
        logger.info("Created model directory: %s", model_dir)
        return str(model_dir)
    except Exception as exc:
        logger.warning("Could not create package-local model dir: %s", exc)

    # Fallback to user cache
    cache_dir = Path(DEFAULT_CACHE_DIR) / "wd14-tagger"
    cache_dir.mkdir(parents=True, exist_ok=True)
    return str(cache_dir)


def get_yolo_model_dir() -> str:
    """
    Get the YOLO model directory, creating it if necessary.
    """
    model_dir = Path(YOLO_MODEL_DIR)
    model_dir.mkdir(parents=True, exist_ok=True)
    return str(model_dir)


def get_clip_model_dir() -> str:
    """Get the CLIP model directory, creating it if necessary."""
    model_dir = Path(CLIP_MODEL_DIR)
    model_dir.mkdir(parents=True, exist_ok=True)
    return str(model_dir)


def get_artist_model_dir() -> str:
    """Get the artist model directory, creating it if necessary."""
    model_dir = Path(ARTIST_MODEL_DIR)
    model_dir.mkdir(parents=True, exist_ok=True)
    return str(model_dir)


def get_sam3_model_dir() -> str:
    """Get the SAM3 model directory, creating it if necessary."""
    model_dir = Path(SAM3_MODEL_DIR)
    model_dir.mkdir(parents=True, exist_ok=True)
    return str(model_dir)


def get_nudenet_model_dir() -> str:
    """Get the NudeNet model directory, creating it if necessary."""
    model_dir = Path(NUDENET_MODEL_DIR)
    model_dir.mkdir(parents=True, exist_ok=True)
    return str(model_dir)


def get_toriigate_model_dir() -> str:
    """Get the ToriiGate model directory, creating it if necessary."""
    model_dir = Path(TORIIGATE_MODEL_DIR)
    model_dir.mkdir(parents=True, exist_ok=True)
    return str(model_dir)


def get_oppai_oracle_model_dir() -> str:
    """Get the OppaiOracle model directory, creating it if necessary."""
    model_dir = Path(OPPAI_ORACLE_MODEL_DIR)
    model_dir.mkdir(parents=True, exist_ok=True)
    return str(model_dir)


def ensure_directories():
    """
    Ensure all required directories exist.
    Call this at startup to avoid issues later.
    """
    # Database directory
    db_path = Path(DATABASE_PATH)
    db_path.parent.mkdir(parents=True, exist_ok=True)

    # Core package-local runtime directories
    get_data_dir()
    get_config_dir()
    get_temp_dir()
    get_update_dir()
    get_thumbnail_cache_dir()

    # Favorites folder
    Path(FAVORITES_FOLDER_PATH).mkdir(parents=True, exist_ok=True)

    # Model directories
    get_wd14_model_dir()
    get_yolo_model_dir()
    get_clip_model_dir()
    get_artist_model_dir()
    get_sam3_model_dir()
    get_nudenet_model_dir()
    get_toriigate_model_dir()

    # Cache directory
    Path(DEFAULT_CACHE_DIR).mkdir(parents=True, exist_ok=True)


# =============================================================================
# Configuration Validation
# =============================================================================

def validate_config() -> list:
    """
    Validate configuration settings.
    Returns a list of warning messages (empty if all valid).
    """
    warnings = []

    # Check if database path is writable
    db_path = Path(DATABASE_PATH)
    if db_path.exists() and not os.access(db_path, os.W_OK):
        warnings.append(f"Database path is not writable: {DATABASE_PATH}")

    # Check if favorites path is writable
    favorites_path = Path(FAVORITES_FOLDER_PATH)
    if favorites_path.exists() and not os.access(favorites_path, os.W_OK):
        warnings.append(f"Favorites path is not writable: {FAVORITES_FOLDER_PATH}")

    # Validate thresholds are in valid range
    if not 0 <= TAGGER_GENERAL_THRESHOLD <= 1:
        warnings.append(f"TAGGER_GENERAL_THRESHOLD should be between 0 and 1, got {TAGGER_GENERAL_THRESHOLD}")

    if not 0 <= TAGGER_CHARACTER_THRESHOLD <= 1:
        warnings.append(f"TAGGER_CHARACTER_THRESHOLD should be between 0 and 1, got {TAGGER_CHARACTER_THRESHOLD}")

    if not 0 <= CENSOR_CONFIDENCE_THRESHOLD <= 1:
        warnings.append(f"CENSOR_CONFIDENCE_THRESHOLD should be between 0 and 1, got {CENSOR_CONFIDENCE_THRESHOLD}")

    # Validate port is in valid range
    if not 1 <= SERVER_PORT <= 65535:
        warnings.append(f"SERVER_PORT should be between 1 and 65535, got {SERVER_PORT}")

    return warnings


# Print configuration on import (for debugging)
if __name__ == "__main__":
    print("SD Image Sorter Configuration")
    print("=" * 50)
    print(f"Project Root: {PROJECT_ROOT}")
    print(f"Backend Dir: {BACKEND_DIR}")
    print(f"Database: {DATABASE_PATH}")
    print(f"Server: {SERVER_HOST}:{SERVER_PORT}")
    print(f"WD14 Model Dir: {WD14_MODEL_DIR}")
    print(f"YOLO Model Dir: {YOLO_MODEL_DIR}")
    print(f"Default Tagger: {DEFAULT_TAGGER_MODEL}")
    print(f"Tagger Threshold: {TAGGER_GENERAL_THRESHOLD}")
    print(f"Character Threshold: {TAGGER_CHARACTER_THRESHOLD}")
    print(f"Use GPU: {TAGGER_USE_GPU}")
    print(f"Max Path Length: {MAX_PATH_LENGTH}")
    print(f"Max Path Depth: {MAX_PATH_DEPTH}")

    warnings = validate_config()
    if warnings:
        print("\nWarnings:")
        for w in warnings:
            print(f"  - {w}")
