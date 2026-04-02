"""
Mock fixtures for ML models.

Provides mock implementations of AI models for testing without loading heavy models.

Usage:
    from tests.fixtures.ml_fixtures import (
        mock_tagger,
        mock_censor_detector,
        mock_clip_model,
        mock_artist_identifier,
    )
"""
import os
import sys
import json
import numpy as np
from pathlib import Path
from typing import List, Dict, Any, Optional, Tuple
from unittest.mock import MagicMock, patch

import pytest

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent.parent))


# ============================================================================
# WD14 Tagger Mocks
# ============================================================================

class MockWD14Tagger:
    """Mock WD14 tagger for testing without loading the actual model."""

    # Sample tags that WD14 might return
    SAMPLE_TAGS = [
        ("1girl", 0.95),
        ("solo", 0.92),
        ("long_hair", 0.88),
        ("looking_at_viewer", 0.85),
        ("smile", 0.80),
        ("white_hair", 0.75),
        ("red_eyes", 0.72),
        ("general", 0.90),  # Rating tag
    ]

    def __init__(self, model_name: str = "mock-tagger", **kwargs):
        self.model_name = model_name
        self.loaded = True

    def tag(self, image_path: str, **kwargs) -> List[Dict[str, Any]]:
        """
        Return mock tags for an image.

        Args:
            image_path: Path to the image (used for deterministic mock results)
            **kwargs: Additional tagging parameters

        Returns:
            List of tag dictionaries with 'tag' and 'confidence' keys
        """
        # Use image path hash for deterministic results
        hash_val = hash(image_path) % len(self.SAMPLE_TAGS)

        # Return subset of tags based on hash
        tags = []
        for i, (tag, conf) in enumerate(self.SAMPLE_TAGS):
            if (hash_val + i) % 3 != 0:  # Skip some tags based on hash
                tags.append({"tag": tag, "confidence": conf})

        return tags


@pytest.fixture
def mock_tagger():
    """Fixture providing a mock WD14 tagger."""
    return MockWD14Tagger()


@pytest.fixture
def mock_tagger_module():
    """Fixture that patches the tagger module to use mock tagger."""
    mock = MagicMock()
    mock.get_tagger.return_value = MockWD14Tagger()
    return mock


# ============================================================================
# Censor Detector Mocks
# ============================================================================

class MockCensorDetector:
    """Mock NSFW detector for testing without loading actual models."""

    # Sample detections
    SAMPLE_DETECTIONS = [
        {
            "box": [100, 200, 300, 400],
            "label": "exposed_breasts",
            "confidence": 0.89,
            "source": "nudenet",
        },
        {
            "box": [150, 350, 250, 500],
            "label": "exposed_buttocks",
            "confidence": 0.75,
            "source": "nudenet",
        },
    ]

    def __init__(self, model_type: str = "nudenet", **kwargs):
        self.model_type = model_type
        self.loaded = True

    def detect(self, image_path: str, **kwargs) -> List[Dict[str, Any]]:
        """
        Return mock detections for an image.

        Args:
            image_path: Path to the image
            **kwargs: Additional detection parameters

        Returns:
            List of detection dictionaries
        """
        # Return mock detections (empty for some images)
        hash_val = hash(image_path) % 3

        if hash_val == 0:
            return []  # No detections
        elif hash_val == 1:
            return [self.SAMPLE_DETECTIONS[0]]  # One detection
        else:
            return self.SAMPLE_DETECTIONS  # Multiple detections


class MockSAM3Refiner:
    """Mock SAM3 mask refiner."""

    def __init__(self, **kwargs):
        self.loaded = True

    def refine_mask(self, image_path: str, box: List[int], **kwargs) -> np.ndarray:
        """
        Return a mock refined mask.

        Args:
            image_path: Path to the image
            box: Bounding box [x1, y1, x2, y2]
            **kwargs: Additional parameters

        Returns:
            Binary mask as numpy array
        """
        # Create a simple binary mask based on the box
        x1, y1, x2, y2 = box
        mask = np.zeros((512, 512), dtype=np.uint8)

        # Fill the box region
        x1, x2 = max(0, x1), min(512, x2)
        y1, y2 = max(0, y1), min(512, y2)
        mask[y1:y2, x1:x2] = 255

        return mask

    def segment_text(self, image_path: str, text_prompt: str, **kwargs) -> np.ndarray:
        """Return a mock mask based on text prompt."""
        mask = np.zeros((512, 512), dtype=np.uint8)
        # Return a random mask region
        mask[100:200, 100:200] = 255
        return mask


@pytest.fixture
def mock_censor_detector():
    """Fixture providing a mock censor detector."""
    return MockCensorDetector()


@pytest.fixture
def mock_sam3_refiner():
    """Fixture providing a mock SAM3 refiner."""
    return MockSAM3Refiner()


# ============================================================================
# CLIP Similarity Mocks
# ============================================================================

class MockCLIPEmbedder:
    """Mock CLIP embedder for similarity testing."""

    def __init__(self, **kwargs):
        self.loaded = True
        self.embedding_size = 512

    def embed_image(self, image_path: str) -> np.ndarray:
        """
        Return a mock embedding for an image.

        Args:
            image_path: Path to the image

        Returns:
            Normalized embedding vector
        """
        # Use image path hash for deterministic embeddings
        np.random.seed(hash(image_path) % (2**32))
        embedding = np.random.randn(self.embedding_size).astype(np.float32)
        # Normalize
        embedding = embedding / np.linalg.norm(embedding)
        return embedding

    def embed_images(self, image_paths: List[str]) -> np.ndarray:
        """Return embeddings for multiple images."""
        return np.array([self.embed_image(p) for p in image_paths])


@pytest.fixture
def mock_clip_embedder():
    """Fixture providing a mock CLIP embedder."""
    return MockCLIPEmbedder()


# ============================================================================
# Artist Identifier Mocks
# ============================================================================

class MockArtistIdentifier:
    """Mock artist identifier for testing."""

    SAMPLE_ARTISTS = [
        "greg_rutkowski",
        "alphonse_mucha",
        "artgerm",
        "wlop",
        "ilya_kuvshinov",
    ]

    def __init__(self, threshold: float = 0.35, **kwargs):
        self.threshold = threshold
        self.loaded = True

    def identify(self, image_path: str, top_k: int = 5) -> Dict[str, Any]:
        """
        Return mock artist identification.

        Args:
            image_path: Path to the image
            top_k: Number of top predictions

        Returns:
            Dictionary with artist predictions
        """
        # Use hash for deterministic results
        np.random.seed(hash(image_path) % (2**32))

        # Generate random predictions
        predictions = []
        for artist in self.SAMPLE_ARTISTS[:top_k]:
            conf = np.random.uniform(0.2, 0.9)
            predictions.append({"artist": artist, "confidence": conf})

        # Sort by confidence
        predictions.sort(key=lambda x: x["confidence"], reverse=True)

        # Top artist
        top_artist = predictions[0]["artist"] if predictions else "undefined"
        top_conf = predictions[0]["confidence"] if predictions else 0.0

        if top_conf < self.threshold:
            top_artist = "undefined"

        return {
            "artist": top_artist,
            "confidence": top_conf,
            "top_predictions": predictions,
            "model_loaded": True,
        }

    def get_artists_list(self) -> List[str]:
        """Return list of known artists."""
        return self.SAMPLE_ARTISTS.copy()

    @staticmethod
    def is_available() -> bool:
        """Check if artist identifier is available."""
        return True


@pytest.fixture
def mock_artist_identifier():
    """Fixture providing a mock artist identifier."""
    return MockArtistIdentifier()


# ============================================================================
# Combined Mock Fixtures
# ============================================================================

@pytest.fixture
def mock_all_ml_models():
    """
    Fixture that patches all ML model imports to use mocks.

    Use this when you want to test the entire pipeline without
    loading any actual models.
    """
    patches = []

    # Patch tagger
    tagger_mock = MagicMock()
    tagger_mock.get_tagger.return_value = MockWD14Tagger()
    patches.append(patch("tagger.get_tagger", tagger_mock.get_tagger))

    # Patch censor detector
    censor_mock = MagicMock()
    censor_mock.get_detector.return_value = MockCensorDetector()
    patches.append(patch("censor.get_detector", censor_mock.get_detector))

    # Patch CLIP embedder
    clip_mock = MagicMock()
    clip_mock.get_embedder.return_value = MockCLIPEmbedder()
    patches.append(patch("similarity.get_embedder", clip_mock.get_embedder))

    # Patch artist identifier
    artist_mock = MagicMock()
    artist_mock.get_artist_identifier.return_value = MockArtistIdentifier()
    patches.append(patch("artist_identifier.get_artist_identifier", artist_mock.get_artist_identifier))

    # Start all patches
    for p in patches:
        p.start()

    yield {
        "tagger": tagger_mock,
        "censor": censor_mock,
        "clip": clip_mock,
        "artist": artist_mock,
    }

    # Stop all patches
    for p in patches:
        p.stop()


# ============================================================================
# Test Data Generators
# ============================================================================

def generate_test_image_with_embedding(
    tmp_path: Path,
    image_id: int,
    width: int = 512,
    height: int = 512,
) -> Tuple[Path, np.ndarray]:
    """
    Generate a test image and its mock embedding.

    Args:
        tmp_path: Temporary directory path
        image_id: Unique image ID
        width: Image width
        height: Image height

    Returns:
        Tuple of (image_path, embedding)
    """
    from PIL import Image

    # Create image with unique color based on ID
    r = (image_id * 37) % 256
    g = (image_id * 73) % 256
    b = (image_id * 113) % 256

    img_path = tmp_path / f"test_image_{image_id}.png"
    img = Image.new("RGB", (width, height), color=(r, g, b))
    img.save(img_path)

    # Generate embedding
    embedder = MockCLIPEmbedder()
    embedding = embedder.embed_image(str(img_path))

    return img_path, embedding


def generate_test_image_with_tags(
    tmp_path: Path,
    image_id: int,
    tags: Optional[List[str]] = None,
) -> Path:
    """
    Generate a test image and return expected mock tags.

    Args:
        tmp_path: Temporary directory path
        image_id: Unique image ID
        tags: Optional specific tags to expect

    Returns:
        Path to the generated image
    """
    from PIL import Image

    img_path = tmp_path / f"tagged_image_{image_id}.png"
    img = Image.new("RGB", (512, 512), color="blue")
    img.save(img_path)

    return img_path
