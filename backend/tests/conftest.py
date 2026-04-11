"""
Pytest configuration and fixtures for SD Image Sorter tests.

Provides:
- Test database fixture with temporary file
- Mock image fixtures
- Test client fixture
- Common test utilities
"""
import os
import sys
import json
import tempfile
import shutil
from pathlib import Path
from typing import Generator, Dict, Any, List
from datetime import datetime
from unittest.mock import patch, MagicMock

import pytest
from fastapi.testclient import TestClient

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))


# ============================================================================
# Test Database Fixture
# ============================================================================

@pytest.fixture
def test_db_path(tmp_path: Path) -> Generator[Path, None, None]:
    """
    Create a temporary test database.

    Yields the path to the temporary database file.
    Database is automatically cleaned up after test.
    """
    db_path = tmp_path / "test_images.db"
    yield db_path


@pytest.fixture
def test_db(test_db_path: Path):
    """
    Initialize a test database with schema.

    Patches the database module to use the test database path.
    """
    import database as db

    # Patch the DATABASE_PATH
    original_path = db.DATABASE_PATH
    db.DATABASE_PATH = str(test_db_path)

    # Reset pragma initialization so the new DB gets proper PRAGMAs
    db._pragmas_initialized = set()

    # Re-initialize the test database
    db.init_db()

    yield db

    # Restore original path and reset pragmas for next test
    db.DATABASE_PATH = original_path
    db._pragmas_initialized = set()


@pytest.fixture
def test_db_with_images(test_db):
    """
    Test database pre-populated with sample images.
    """
    import database as db

    # Add sample images with different generators
    images = [
        {
            "path": "/test/images/comfyui_test.png",
            "filename": "comfyui_test.png",
            "generator": "comfyui",
            "prompt": "a beautiful landscape, best quality, masterpiece",
            "negative_prompt": "ugly, low quality",
            "checkpoint": "sd_xl_base_1.0.safetensors",
            "loras": ["detail_tweaker", "add_detail"],
            "width": 1024,
            "height": 768,
            "file_size": 2048000,
        },
        {
            "path": "/test/images/nai_test.png",
            "filename": "nai_test.png",
            "generator": "nai",
            "prompt": "anime girl, white hair, red eyes",
            "negative_prompt": "bad anatomy",
            "checkpoint": "nai-diffusion-3",
            "loras": [],
            "width": 832,
            "height": 1216,
            "file_size": 1536000,
        },
        {
            "path": "/test/images/webui_test.png",
            "filename": "webui_test.png",
            "generator": "webui",
            "prompt": "portrait of a woman, professional lighting",
            "negative_prompt": "blurry",
            "checkpoint": "realisticVisionV51.safetensors",
            "loras": ["epi_noiseoffset"],
            "width": 512,
            "height": 768,
            "file_size": 1024000,
        },
        {
            "path": "/test/images/forge_test.png",
            "filename": "forge_test.png",
            "generator": "forge",
            "prompt": "cyberpunk city, neon lights",
            "negative_prompt": "daylight",
            "checkpoint": "juggernautXL.safetensors",
            "loras": [],
            "width": 1024,
            "height": 1024,
            "file_size": 3072000,
        },
        {
            "path": "/test/images/unknown_test.jpg",
            "filename": "unknown_test.jpg",
            "generator": "unknown",
            "prompt": None,
            "negative_prompt": None,
            "checkpoint": None,
            "loras": [],
            "width": 800,
            "height": 600,
            "file_size": 512000,
        },
    ]

    image_ids = []
    for img in images:
        image_id = db.add_image(
            path=img["path"],
            filename=img["filename"],
            generator=img["generator"],
            prompt=img["prompt"],
            negative_prompt=img["negative_prompt"],
            checkpoint=img["checkpoint"],
            loras=img["loras"],
            width=img["width"],
            height=img["height"],
            file_size=img["file_size"],
            metadata_json="{}",
        )
        image_ids.append(image_id)

    # Add tags to first image
    db.add_tags(image_ids[0], [
        {"tag": "landscape", "confidence": 0.95},
        {"tag": "outdoor", "confidence": 0.88},
        {"tag": "general", "confidence": 0.92},
    ])

    # Add tags to second image
    db.add_tags(image_ids[1], [
        {"tag": "1girl", "confidence": 0.98},
        {"tag": "white_hair", "confidence": 0.95},
        {"tag": "red_eyes", "confidence": 0.92},
        {"tag": "sensitive", "confidence": 0.85},
    ])

    # Add tags to third image
    db.add_tags(image_ids[2], [
        {"tag": "portrait", "confidence": 0.90},
        {"tag": "woman", "confidence": 0.95},
        {"tag": "questionable", "confidence": 0.75},
    ])

    # Add tags to fourth image
    db.add_tags(image_ids[3], [
        {"tag": "cyberpunk", "confidence": 0.97},
        {"tag": "city", "confidence": 0.90},
        {"tag": "neon", "confidence": 0.88},
        {"tag": "explicit", "confidence": 0.80},
    ])

    yield {"db": test_db, "image_ids": image_ids, "images": images}


# ============================================================================
# Test Client Fixture
# ============================================================================

@pytest.fixture
def test_client(test_db):
    """
    Create a test client for the FastAPI app.

    Patches the database to use the test database.
    """
    import database as db

    # Import main app - this will initialize the database
    # We need to patch before importing
    with patch.dict(os.environ, {"SD_SORTER_TESTING": "1", "TESTING": "1"}):
        # Patch database path before importing main
        original_path = db.DATABASE_PATH
        db.DATABASE_PATH = str(test_db.DATABASE_PATH).replace("images.db", "test_client_images.db")
        db._pragmas_initialized = set()
        db.init_db()

        from main import app
        # Initialize services for testing
        import main
        from services import ImageService, TaggingService, SortingService, CensorService, SimilarityService
        from routers import images, tags, sorting, censor, similarity

        # Create service instances
        image_svc = ImageService()
        tagging_svc = TaggingService()
        sorting_svc = SortingService()
        censor_svc = CensorService()
        similarity_svc = SimilarityService()

        # Inject services into routers
        images.set_image_service(image_svc)
        tags.set_tagging_service(tagging_svc)
        sorting.set_sorting_service(sorting_svc)
        censor.set_censor_service(censor_svc)
        similarity.set_similarity_service(similarity_svc)

        client = TestClient(app)
        client.test_db = db

        yield client

        # Cleanup
        db.DATABASE_PATH = original_path
        db._pragmas_initialized = set()


# ============================================================================
# Mock Fixtures
# ============================================================================

@pytest.fixture
def mock_image_file(tmp_path: Path) -> Path:
    """
    Create a mock image file for testing.
    """
    from PIL import Image

    img_path = tmp_path / "test_image.png"
    img = Image.new("RGB", (512, 512), color="red")
    img.save(img_path)

    return img_path


@pytest.fixture
def mock_comfyui_image(tmp_path: Path) -> Path:
    """
    Create a mock ComfyUI-generated image with metadata.
    """
    from PIL import Image
    from PIL.PngImagePlugin import PngInfo

    img_path = tmp_path / "comfyui_image.png"
    img = Image.new("RGB", (1024, 768), color="blue")

    # Create ComfyUI-style metadata
    workflow = {
        "1": {
            "class_type": "KSampler",
            "inputs": {
                "seed": 12345,
                "steps": 20,
                "cfg": 7.5,
                "sampler_name": "euler",
                "scheduler": "normal",
                "denoise": 1.0,
                "model": ["2", 0],
                "positive": ["3", 0],
                "negative": ["4", 0],
                "latent_image": ["5", 0]
            }
        },
        "2": {
            "class_type": "CheckpointLoaderSimple",
            "inputs": {"ckpt_name": "sd_xl_base_1.0.safetensors"}
        },
        "3": {
            "class_type": "CLIPTextEncode",
            "inputs": {
                "text": "a beautiful landscape, best quality",
                "clip": ["2", 1]
            }
        },
        "4": {
            "class_type": "CLIPTextEncode",
            "inputs": {
                "text": "ugly, low quality",
                "clip": ["2", 1]
            }
        },
        "5": {
            "class_type": "EmptyLatentImage",
            "inputs": {"width": 1024, "height": 768}
        }
    }

    metadata = PngInfo()
    metadata.add_text("prompt", json.dumps(workflow))

    img.save(img_path, pnginfo=metadata)
    return img_path


@pytest.fixture
def mock_webui_image(tmp_path: Path) -> Path:
    """
    Create a mock WebUI/A1111-generated image with metadata.
    """
    from PIL import Image
    from PIL.PngImagePlugin import PngInfo

    img_path = tmp_path / "webui_image.png"
    img = Image.new("RGB", (512, 768), color="green")

    parameters = """portrait of a woman, professional lighting
Negative prompt: blurry, low quality
Steps: 30, Sampler: DPM++ 2M Karras, CFG scale: 7.5, Seed: 987654321, Size: 512x768, Model hash: abc123, Model: realisticVisionV51, Clip skip: 2"""

    metadata = PngInfo()
    metadata.add_text("parameters", parameters)

    img.save(img_path, pnginfo=metadata)
    return img_path


@pytest.fixture
def mock_nai_image(tmp_path: Path) -> Path:
    """
    Create a mock NovelAI-generated image with metadata.
    """
    from PIL import Image
    from PIL.PngImagePlugin import PngInfo

    img_path = tmp_path / "nai_image.png"
    img = Image.new("RGB", (832, 1216), color="purple")

    comment = json.dumps({
        "prompt": "anime girl, white hair, red eyes",
        "uc": "bad anatomy, low quality",
        "steps": 28,
        "sampler": "k_euler_ancestral",
        "seed": 111222333,
        "scale": 5.0,
    })

    metadata = PngInfo()
    metadata.add_text("Comment", comment)
    metadata.add_text("Software", "NovelAI")

    img.save(img_path, pnginfo=metadata)
    return img_path


@pytest.fixture
def mock_forge_image(tmp_path: Path) -> Path:
    """
    Create a mock Forge-generated image with metadata.
    """
    from PIL import Image
    from PIL.PngImagePlugin import PngInfo

    img_path = tmp_path / "forge_image.png"
    img = Image.new("RGB", (1024, 1024), color="orange")

    parameters = """cyberpunk city, neon lights
Negative prompt: daylight
Steps: 25, Sampler: DPM++ 2M, CFG scale: 8.0, Seed: 444555666, Size: 1024x1024, Model: juggernautXL, Forge version: 0.1.0"""

    metadata = PngInfo()
    metadata.add_text("parameters", parameters)

    img.save(img_path, pnginfo=metadata)
    return img_path


# ============================================================================
# Test Utilities
# ============================================================================

def create_test_image(
    path: Path,
    width: int = 512,
    height: int = 512,
    color: str = "red",
    format: str = "PNG",
    metadata: Dict[str, str] = None
) -> Path:
    """
    Utility function to create test images with optional metadata.
    """
    from PIL import Image
    from PIL.PngImagePlugin import PngInfo

    img = Image.new("RGB", (width, height), color=color)

    if metadata and format.upper() == "PNG":
        png_info = PngInfo()
        for key, value in metadata.items():
            png_info.add_text(key, value)
        img.save(path, pnginfo=png_info)
    else:
        img.save(path, format=format)

    return path


def assert_response_success(response, expected_status: int = 200):
    """
    Assert that a response is successful.
    """
    assert response.status_code == expected_status, (
        f"Expected status {expected_status}, got {response.status_code}. "
        f"Response: {response.text}"
    )


def assert_response_error(response, expected_status: int = 400):
    """
    Assert that a response is an error.
    """
    assert response.status_code == expected_status, (
        f"Expected status {expected_status}, got {response.status_code}. "
        f"Response: {response.text}"
    )
