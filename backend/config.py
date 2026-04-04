"""
Configuration management for SD Image Sorter.

All configurable values are centralized here with environment variable support.
Copy .env.example to .env and customize as needed.
"""
import os
import platform
from pathlib import Path
from typing import Optional


# =============================================================================
# Project Paths
# =============================================================================

def _get_project_root() -> Path:
    """Get the project root directory (parent of backend/)."""
    return Path(__file__).parent.parent.resolve()


def _get_backend_dir() -> Path:
    """Get the backend directory."""
    return Path(__file__).parent.resolve()


PROJECT_ROOT: Path = _get_project_root()
BACKEND_DIR: Path = _get_backend_dir()


# =============================================================================
# Database Configuration
# =============================================================================

# Database file path
DATABASE_PATH: str = os.environ.get(
    "SD_IMAGE_SORTER_DB_PATH",
    str(BACKEND_DIR / "images.db")
)

# Favorites collection defaults
FAVORITES_COLLECTION_SLUG: str = "favorites"
FAVORITES_COLLECTION_NAME: str = "Favorites"
FAVORITES_FOLDER_PATH: str = os.environ.get(
    "SD_IMAGE_SORTER_FAVORITES_PATH",
    str(BACKEND_DIR / "favorites")
)


# =============================================================================
# Server Configuration
# =============================================================================

# Server host and port
SERVER_HOST: str = os.environ.get("SD_IMAGE_SORTER_HOST", "127.0.0.1")
SERVER_PORT: int = int(os.environ.get("SD_IMAGE_SORTER_PORT", "8000"))

# CORS allowed origins (regex pattern for localhost)
CORS_ORIGIN_REGEX: str = r"^https?://(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$"


# =============================================================================
# Model Directories
# =============================================================================

# WD14 Tagger model directory
WD14_MODEL_DIR: str = os.environ.get(
    "SD_IMAGE_SORTER_WD14_MODEL_DIR",
    str(PROJECT_ROOT / "models" / "wd14-tagger")
)

# YOLO/Censor model directory
YOLO_MODEL_DIR: str = os.environ.get(
    "SD_IMAGE_SORTER_YOLO_MODEL_DIR",
    str(PROJECT_ROOT / "models" / "yolo")
)

# Default model cache directory (fallback)
DEFAULT_CACHE_DIR: str = os.environ.get(
    "SD_IMAGE_SORTER_CACHE_DIR",
    str(Path.home() / ".cache" / "sd-image-sorter")
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
TAGGER_GENERAL_THRESHOLD: float = float(os.environ.get(
    "SD_IMAGE_SORTER_TAGGER_GENERAL_THRESHOLD",
    "0.35"
))
TAGGER_CHARACTER_THRESHOLD: float = float(os.environ.get(
    "SD_IMAGE_SORTER_TAGGER_CHARACTER_THRESHOLD",
    "0.85"
))

# GPU usage
TAGGER_USE_GPU: bool = os.environ.get(
    "SD_IMAGE_SORTER_TAGGER_USE_GPU",
    "true"
).lower() in ("true", "1", "yes")

# Available tagger models
TAGGER_MODELS: dict = {
    "wd-eva02-large-tagger-v3": {
        "repo_id": "SmilingWolf/wd-eva02-large-tagger-v3",
        "model_file": "model.onnx",
        "tags_file": "selected_tags.csv"
    },
    "wd-swinv2-tagger-v3": {
        "repo_id": "SmilingWolf/wd-swinv2-tagger-v3",
        "model_file": "model.onnx",
        "tags_file": "selected_tags.csv"
    },
    "wd-convnext-tagger-v3": {
        "repo_id": "SmilingWolf/wd-convnext-tagger-v3",
        "model_file": "model.onnx",
        "tags_file": "selected_tags.csv"
    },
    "wd-vit-tagger-v3": {
        "repo_id": "SmilingWolf/wd-vit-tagger-v3",
        "model_file": "model.onnx",
        "tags_file": "selected_tags.csv"
    },
    "wd-vit-large-tagger-v3": {
        "repo_id": "SmilingWolf/wd-vit-large-tagger-v3",
        "model_file": "model.onnx",
        "tags_file": "selected_tags.csv"
    }
}

# Rating categories
RATING_CATEGORIES: list = ["general", "sensitive", "questionable", "explicit"]


# =============================================================================
# Censor Configuration
# =============================================================================

# Default censor detection confidence threshold
CENSOR_CONFIDENCE_THRESHOLD: float = float(os.environ.get(
    "SD_IMAGE_SORTER_CENSOR_CONFIDENCE",
    "0.60"
))

# Default censor IOU threshold for NMS
CENSOR_IOU_THRESHOLD: float = float(os.environ.get(
    "SD_IMAGE_SORTER_CENSOR_IOU_THRESHOLD",
    "0.45"
))

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
CENSOR_DEFAULT_BLOCK_SIZE: int = int(os.environ.get(
    "SD_IMAGE_SORTER_CENSOR_BLOCK_SIZE",
    "16"
))
CENSOR_DEFAULT_BLUR_RADIUS: int = int(os.environ.get(
    "SD_IMAGE_SORTER_CENSOR_BLUR_RADIUS",
    "20"
))


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
SIMILARITY_DEFAULT_LIMIT: int = int(os.environ.get(
    "SD_IMAGE_SORTER_SIMILARITY_LIMIT",
    "20"
))
SIMILARITY_DEFAULT_THRESHOLD: float = float(os.environ.get(
    "SD_IMAGE_SORTER_SIMILARITY_THRESHOLD",
    "0.5"
))
DUPLICATE_THRESHOLD: float = float(os.environ.get(
    "SD_IMAGE_SORTER_DUPLICATE_THRESHOLD",
    "0.95"
))


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

# Optional ModelScope mirror id. Leave empty if you do not have a compatible mirror.
ARTIST_MODELSCOPE_MODEL_ID: str = os.environ.get(
    "SD_IMAGE_SORTER_ARTIST_MODELSCOPE_MODEL",
    ""
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
ALLOWED_IMAGE_EXTENSIONS: set = {'.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'}

# Allowed model extensions
ALLOWED_MODEL_EXTENSIONS: set = {'.onnx', '.pt', '.pth', '.safetensors'}

# Batch processing sizes
TAGGER_BATCH_SIZE: int = int(os.environ.get(
    "SD_IMAGE_SORTER_TAGGER_BATCH_SIZE",
    "10"
))
EMBEDDING_BATCH_SIZE: int = int(os.environ.get(
    "SD_IMAGE_SORTER_EMBEDDING_BATCH_SIZE",
    "10"
))
DUPLICATE_CHUNK_SIZE: int = int(os.environ.get(
    "SD_IMAGE_SORTER_DUPLICATE_CHUNK_SIZE",
    "500"
))


# =============================================================================
# Path Validation Configuration
# =============================================================================

# Maximum path depth to prevent deep nesting attacks
MAX_PATH_DEPTH: int = int(os.environ.get(
    "SD_IMAGE_SORTER_MAX_PATH_DEPTH",
    "20"
))

# Maximum path length (platform-aware)
# Windows has a default limit of 260 characters, but can be extended
# Linux/macOS typically have 4096 character limits
if platform.system() == 'Windows':
    _default_max_path = 260
else:
    _default_max_path = 4096

MAX_PATH_LENGTH: int = int(os.environ.get(
    "SD_IMAGE_SORTER_MAX_PATH_LENGTH",
    str(_default_max_path)
))

# Maximum filename length for sanitization
MAX_FILENAME_LENGTH: int = int(os.environ.get(
    "SD_IMAGE_SORTER_MAX_FILENAME_LENGTH",
    "200"
))


# =============================================================================
# Gallery/UI Defaults
# =============================================================================

# Default gallery limit
GALLERY_DEFAULT_LIMIT: int = int(os.environ.get(
    "SD_IMAGE_SORTER_GALLERY_LIMIT",
    "100"
))

# Maximum gallery limit
GALLERY_MAX_LIMIT: int = int(os.environ.get(
    "SD_IMAGE_SORTER_GALLERY_MAX_LIMIT",
    "999999"
))


# =============================================================================
# Logging Configuration
# =============================================================================

# Log level
LOG_LEVEL: str = os.environ.get(
    "SD_IMAGE_SORTER_LOG_LEVEL",
    "INFO"
)


# =============================================================================
# Helper Functions
# =============================================================================

def get_wd14_model_dir() -> str:
    """
    Get the WD14 model directory, creating it if necessary.

    Priority:
    1. SD_IMAGE_SORTER_WD14_MODEL_DIR env var
    2. Project models/wd14-tagger folder
    3. User cache directory (fallback)
    """
    model_dir = Path(WD14_MODEL_DIR)

    if model_dir.exists():
        return str(model_dir)

    # Try to create project folder
    try:
        model_dir.mkdir(parents=True, exist_ok=True)
        print(f"Created model directory: {model_dir}")
        return str(model_dir)
    except Exception as e:
        print(f"Could not create project model dir: {e}")

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


def ensure_directories():
    """
    Ensure all required directories exist.
    Call this at startup to avoid issues later.
    """
    # Database directory
    db_path = Path(DATABASE_PATH)
    db_path.parent.mkdir(parents=True, exist_ok=True)

    # Favorites folder
    Path(FAVORITES_FOLDER_PATH).mkdir(parents=True, exist_ok=True)

    # Model directories
    get_wd14_model_dir()
    get_yolo_model_dir()

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
