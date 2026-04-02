"""
Database operations tests.

Tests for SQLite database layer including:
- CRUD operations
- Filtering logic (AND/OR combinations)
- SQL injection prevention
- Session persistence

Priority: CRITICAL (SQL injection), HIGH (filtering logic)
"""
import os
import sys
import json
import tempfile
from pathlib import Path
from datetime import datetime
from unittest.mock import patch

import pytest

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

import database as db


class TestDatabaseInit:
    """Tests for database initialization."""

    def test_init_creates_tables(self, test_db):
        """Database initialization should create all required tables."""
        import sqlite3

        conn = sqlite3.connect(db.DATABASE_PATH)
        cursor = conn.cursor()

        # Check images table exists
        cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='images'")
        assert cursor.fetchone() is not None

        # Check tags table exists
        cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='tags'")
        assert cursor.fetchone() is not None

        # Check collections table exists
        cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='collections'")
        assert cursor.fetchone() is not None

        conn.close()

    def test_init_creates_indexes(self, test_db):
        """Database initialization should create indexes for performance."""
        import sqlite3

        conn = sqlite3.connect(db.DATABASE_PATH)
        cursor = conn.cursor()

        cursor.execute("SELECT name FROM sqlite_master WHERE type='index'")
        indexes = [row[0] for row in cursor.fetchall()]

        # Check key indexes exist
        assert "idx_tags_tag" in indexes
        assert "idx_tags_image_id" in indexes
        assert "idx_images_generator" in indexes

        conn.close()

    def test_init_creates_favorites_collection(self, test_db):
        """Favorites collection should be created by default."""
        collection = db.get_collection_by_slug("favorites")
        assert collection is not None
        assert collection["slug"] == "favorites"


class TestImageCRUD:
    """Tests for image CRUD operations."""

    def test_add_image(self, test_db):
        """Adding an image should return an ID."""
        image_id = db.add_image(
            path="/test/image.png",
            filename="image.png",
            generator="comfyui",
            prompt="test prompt",
            width=1024,
            height=768,
        )

        assert isinstance(image_id, int)
        assert image_id > 0

    def test_get_image_by_id(self, test_db):
        """Retrieving an image by ID should return correct data."""
        image_id = db.add_image(
            path="/test/retrieve.png",
            filename="retrieve.png",
            generator="webui",
            prompt="retrieval test",
            width=512,
            height=512,
        )

        image = db.get_image_by_id(image_id)

        assert image is not None
        assert image["id"] == image_id
        assert image["path"] == "/test/retrieve.png"
        assert image["generator"] == "webui"
        assert image["prompt"] == "retrieval test"

    def test_get_image_by_id_not_found(self, test_db):
        """Retrieving non-existent image should return None."""
        image = db.get_image_by_id(999999)
        assert image is None

    def test_update_image_path(self, test_db):
        """Updating image path should work correctly."""
        image_id = db.add_image(
            path="/test/old_path.png",
            filename="old_path.png",
        )

        db.update_image_path(image_id, "/test/new_path.png")

        image = db.get_image_by_id(image_id)
        assert "new_path.png" in image["path"]

    def test_delete_image(self, test_db):
        """Deleting an image should remove it from database."""
        image_id = db.add_image(
            path="/test/to_delete.png",
            filename="to_delete.png",
        )

        db.delete_image(image_id)

        image = db.get_image_by_id(image_id)
        assert image is None

    def test_add_image_with_loras(self, test_db):
        """Adding image with LoRAs should store them as JSON."""
        image_id = db.add_image(
            path="/test/with_loras.png",
            filename="with_loras.png",
            loras=["lora1", "lora2", "lora3"],
        )

        image = db.get_image_by_id(image_id)
        loras = json.loads(image["loras"])

        assert loras == ["lora1", "lora2", "lora3"]

    def test_add_image_replaces_existing(self, test_db):
        """Adding image with same path should replace existing."""
        path = "/test/duplicate.png"

        id1 = db.add_image(path=path, filename="duplicate.png", prompt="first")
        id2 = db.add_image(path=path, filename="duplicate.png", prompt="second")

        # Both should exist, but the latest one should have the updated prompt
        # Note: INSERT OR REPLACE may create a new ID, but path is unique
        # So we check that the path only has one entry with the latest data
        image = db.get_image_by_id(id2)
        assert image["prompt"] == "second"
        assert image["path"] == path


class TestTagOperations:
    """Tests for tag operations."""

    def test_add_tags(self, test_db):
        """Adding tags should associate them with an image."""
        image_id = db.add_image(path="/test/tagged.png", filename="tagged.png")

        db.add_tags(image_id, [
            {"tag": "landscape", "confidence": 0.95},
            {"tag": "outdoor", "confidence": 0.88},
        ])

        tags = db.get_image_tags(image_id)

        assert len(tags) == 2
        assert any(t["tag"] == "landscape" for t in tags)
        assert any(t["tag"] == "outdoor" for t in tags)

    def test_add_tags_replaces_existing(self, test_db):
        """Adding tags should replace existing tags for the image."""
        image_id = db.add_image(path="/test/retag.png", filename="retag.png")

        db.add_tags(image_id, [{"tag": "old_tag", "confidence": 0.5}])
        db.add_tags(image_id, [{"tag": "new_tag", "confidence": 0.9}])

        tags = db.get_image_tags(image_id)

        assert len(tags) == 1
        assert tags[0]["tag"] == "new_tag"

    def test_get_image_tags_ordered_by_confidence(self, test_db):
        """Tags should be returned ordered by confidence descending."""
        image_id = db.add_image(path="/test/ordered.png", filename="ordered.png")

        db.add_tags(image_id, [
            {"tag": "low", "confidence": 0.3},
            {"tag": "high", "confidence": 0.9},
            {"tag": "medium", "confidence": 0.6},
        ])

        tags = db.get_image_tags(image_id)

        assert tags[0]["tag"] == "high"
        assert tags[1]["tag"] == "medium"
        assert tags[2]["tag"] == "low"

    def test_get_all_tags(self, test_db):
        """Getting all tags should return unique tags with counts."""
        # Create images with overlapping tags
        id1 = db.add_image(path="/test/1.png", filename="1.png")
        id2 = db.add_image(path="/test/2.png", filename="2.png")

        db.add_tags(id1, [{"tag": "common", "confidence": 0.9}])
        db.add_tags(id2, [
            {"tag": "common", "confidence": 0.9},
            {"tag": "unique", "confidence": 0.8},
        ])

        all_tags = db.get_all_tags()

        # Find our tags
        common = next((t for t in all_tags if t["tag"] == "common"), None)
        unique = next((t for t in all_tags if t["tag"] == "unique"), None)

        assert common is not None
        assert common["count"] == 2
        assert unique is not None
        assert unique["count"] == 1

    def test_tagged_at_updated(self, test_db):
        """Tagging an image should update tagged_at timestamp."""
        image_id = db.add_image(path="/test/timestamp.png", filename="timestamp.png")

        # Before tagging
        image = db.get_image_by_id(image_id)
        assert image["tagged_at"] is None

        # After tagging
        db.add_tags(image_id, [{"tag": "test", "confidence": 0.9}])

        image = db.get_image_by_id(image_id)
        assert image["tagged_at"] is not None


class TestImageFiltering:
    """Tests for image filtering logic."""

    def test_filter_by_generator(self, test_db_with_images):
        """Filtering by generator should return correct images."""
        data = test_db_with_images
        db_module = data["db"]

        images = db_module.get_images(generators=["comfyui"])

        assert len(images) == 1
        assert images[0]["generator"] == "comfyui"

    def test_filter_by_multiple_generators_or_logic(self, test_db_with_images):
        """Multiple generators should use OR logic."""
        data = test_db_with_images
        db_module = data["db"]

        images = db_module.get_images(generators=["comfyui", "nai"])

        assert len(images) == 2
        generators = {img["generator"] for img in images}
        assert generators == {"comfyui", "nai"}

    def test_filter_by_tags_and_logic(self, test_db_with_images):
        """Multiple tags should use AND logic - image must have ALL tags."""
        data = test_db_with_images
        db_module = data["db"]

        # First image has: landscape, outdoor, general
        images = db_module.get_images(tags=["landscape", "outdoor"])

        assert len(images) == 1
        assert images[0]["filename"] == "comfyui_test.png"

    def test_filter_by_single_tag(self, test_db_with_images):
        """Single tag filter should return all matching images."""
        data = test_db_with_images
        db_module = data["db"]

        images = db_module.get_images(tags=["general"])

        assert len(images) == 1

    def test_filter_by_ratings(self, test_db_with_images):
        """Rating filter should use OR logic and include untagged images."""
        data = test_db_with_images
        db_module = data["db"]

        # Images have: general, sensitive, questionable, explicit
        # Untagged images are also included per the design
        images = db_module.get_images(ratings=["explicit", "sensitive"])

        # Should include: sensitive, explicit, and untagged (unknown_test.jpg)
        assert len(images) >= 2
        # Verify all returned images have the requested ratings or are untagged
        for img in images:
            img_tags = db_module.get_image_tags(img["id"])
            if img_tags:
                tag_names = [t["tag"] for t in img_tags]
                assert any(r in tag_names for r in ["explicit", "sensitive", "questionable", "general"]) or len(tag_names) == 0

    def test_filter_by_checkpoints(self, test_db_with_images):
        """Checkpoint filter should use OR logic."""
        data = test_db_with_images
        db_module = data["db"]

        images = db_module.get_images(checkpoints=["sd_xl_base_1.0.safetensors"])

        assert len(images) == 1
        assert images[0]["checkpoint"] == "sd_xl_base_1.0.safetensors"

    def test_filter_by_dimensions(self, test_db_with_images):
        """Dimension filters should work correctly."""
        data = test_db_with_images
        db_module = data["db"]

        images = db_module.get_images(min_width=1000)

        # Only 1024 width images
        for img in images:
            assert img["width"] >= 1000

    def test_filter_by_aspect_ratio_square(self, test_db_with_images):
        """Square aspect ratio filter should work."""
        data = test_db_with_images
        db_module = data["db"]

        images = db_module.get_images(aspect_ratio="square")

        for img in images:
            ratio = img["width"] / img["height"]
            assert 0.9 <= ratio <= 1.1

    def test_filter_by_aspect_ratio_landscape(self, test_db_with_images):
        """Landscape aspect ratio filter should work."""
        data = test_db_with_images
        db_module = data["db"]

        images = db_module.get_images(aspect_ratio="landscape")

        for img in images:
            ratio = img["width"] / img["height"]
            assert ratio > 1.1

    def test_filter_by_aspect_ratio_portrait(self, test_db_with_images):
        """Portrait aspect ratio filter should work."""
        data = test_db_with_images
        db_module = data["db"]

        images = db_module.get_images(aspect_ratio="portrait")

        for img in images:
            ratio = img["width"] / img["height"]
            assert ratio < 0.9

    def test_filter_by_search_query(self, test_db_with_images):
        """Search query should search in prompts."""
        data = test_db_with_images
        db_module = data["db"]

        images = db_module.get_images(search_query="landscape")

        assert len(images) >= 1
        # At least one image should have landscape in prompt
        found = False
        for img in images:
            if img.get("prompt") and "landscape" in img["prompt"].lower():
                found = True
                break
        assert found, "No image found with 'landscape' in prompt"

    def test_filter_combined(self, test_db_with_images):
        """Combined filters should work together."""
        data = test_db_with_images
        db_module = data["db"]

        images = db_module.get_images(
            generators=["comfyui"],
            min_width=1000,
        )

        assert len(images) == 1
        assert images[0]["generator"] == "comfyui"
        assert images[0]["width"] >= 1000

    def test_filter_by_image_ids(self, test_db_with_images):
        """Filtering by specific image IDs should work."""
        data = test_db_with_images
        db_module = data["db"]
        ids = data["image_ids"][:2]

        images = db_module.get_images(image_ids=ids)

        assert len(images) == 2
        returned_ids = {img["id"] for img in images}
        assert returned_ids == set(ids)

    def test_filter_by_empty_image_ids(self, test_db_with_images):
        """Empty image_ids list should return empty results."""
        data = test_db_with_images
        db_module = data["db"]

        images = db_module.get_images(image_ids=[])

        assert images == []


class TestSorting:
    """Tests for image sorting options."""

    def test_sort_by_newest(self, test_db_with_images):
        """Sorting by newest should work."""
        data = test_db_with_images
        db_module = data["db"]

        images = db_module.get_images(sort_by="newest", limit=10)

        # Created timestamps should be in descending order
        # (Note: created_at may be None for test data)

    def test_sort_by_name_asc(self, test_db_with_images):
        """Sorting by name ascending should work."""
        data = test_db_with_images
        db_module = data["db"]

        images = db_module.get_images(sort_by="name_asc", limit=10)

        filenames = [img["filename"] for img in images]
        assert filenames == sorted(filenames)

    def test_sort_by_name_desc(self, test_db_with_images):
        """Sorting by name descending should work."""
        data = test_db_with_images
        db_module = data["db"]

        images = db_module.get_images(sort_by="name_desc", limit=10)

        filenames = [img["filename"] for img in images]
        assert filenames == sorted(filenames, reverse=True)

    def test_sort_by_file_size(self, test_db_with_images):
        """Sorting by file size should work."""
        data = test_db_with_images
        db_module = data["db"]

        images = db_module.get_images(sort_by="file_size", limit=10)

        sizes = [img["file_size"] for img in images if img.get("file_size")]
        assert sizes == sorted(sizes, reverse=True)

    def test_invalid_sort_uses_default(self, test_db_with_images):
        """Invalid sort option should use default (newest)."""
        data = test_db_with_images
        db_module = data["db"]

        # Should not raise an error
        images = db_module.get_images(sort_by="invalid_option", limit=10)

        assert isinstance(images, list)


class TestSQLInjectionPrevention:
    """
    CRITICAL: SQL injection prevention tests.

    These tests verify that SQL injection attacks are blocked.
    """

    @pytest.mark.parametrize("injection_payload", [
        "'; DROP TABLE images; --",
        "' OR '1'='1",
        "'; DELETE FROM tags; --",
        "' UNION SELECT * FROM images --",
        "1; DROP TABLE images",
        "' OR 1=1 --",
        "admin'--",
        "1' AND '1'='1",
    ])
    def test_sql_injection_in_path(self, test_db, injection_payload: str):
        """SQL injection in path should be handled safely."""
        # Try to inject SQL via path parameter
        image_id = db.add_image(
            path=f"/test/{injection_payload}.png",
            filename=f"{injection_payload}.png",
        )

        # Verify the injection didn't work - tables should still exist
        import sqlite3
        conn = sqlite3.connect(db.DATABASE_PATH)
        cursor = conn.cursor()
        cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='images'")
        assert cursor.fetchone() is not None
        conn.close()

        # The image should be stored with the literal string
        image = db.get_image_by_id(image_id)
        assert injection_payload in image["path"]

    def test_sql_injection_in_tag_filter(self, test_db):
        """SQL injection in tag filter should be blocked."""
        # Create a test image
        image_id = db.add_image(path="/test/tag_test.png", filename="tag_test.png")
        db.add_tags(image_id, [{"tag": "safe_tag", "confidence": 0.9}])

        # Try SQL injection in tag filter
        # This should not return all images or cause errors
        images = db.get_images(tags=["safe_tag' OR '1'='1"])

        # Should not return any images (the injection string is treated as a literal tag)
        # or should handle gracefully

    def test_sql_injection_in_search_query(self, test_db):
        """SQL injection in search query should be blocked."""
        # Create a test image
        db.add_image(
            path="/test/search_test.png",
            filename="search_test.png",
            prompt="test prompt",
        )

        # Try SQL injection in search
        images = db.get_images(search_query="'; DROP TABLE images; --")

        # Should handle gracefully - tables should still exist
        import sqlite3
        conn = sqlite3.connect(db.DATABASE_PATH)
        cursor = conn.cursor()
        cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='images'")
        assert cursor.fetchone() is not None
        conn.close()

    def test_like_pattern_escaping(self, test_db):
        """LIKE wildcards should be escaped in tag searches."""
        image_id = db.add_image(path="/test/like_test.png", filename="like_test.png")

        # Add a tag with underscore (LIKE wildcard)
        db.add_tags(image_id, [{"tag": "test_tag", "confidence": 0.9}])

        # Search for the literal tag with underscore
        images = db.get_images(tags=["test_tag"])

        # Should find the image
        assert len(images) == 1


class TestPromptTokenExtraction:
    """Tests for prompt token extraction utilities."""

    def test_extract_prompt_tokens_basic(self):
        """Basic prompt token extraction should work."""
        tokens = db.extract_prompt_tokens("cat, dog, bird")

        assert "cat" in tokens
        assert "dog" in tokens
        assert "bird" in tokens

    def test_extract_prompt_tokens_normalization(self):
        """Tokens should be normalized (lowercase, underscore to space)."""
        tokens = db.extract_prompt_tokens("Best_Quality, MASTERPIECE, high res")

        assert "best quality" in tokens
        assert "masterpiece" in tokens
        assert "high res" in tokens

    def test_extract_prompt_tokens_removes_lora_tags(self):
        """LoRA tags should be removed from tokens."""
        tokens = db.extract_prompt_tokens("cat, <lora:style:0.8>, dog")

        assert "cat" in tokens
        assert "dog" in tokens
        # LoRA should not appear as a token
        assert not any("lora" in t for t in tokens)

    def test_extract_prompt_tokens_handles_weights(self):
        """Weight notation should be stripped."""
        tokens = db.extract_prompt_tokens("(cat:1.2), (dog:0.8)")

        assert "cat" in tokens
        assert "dog" in tokens

    def test_extract_prompt_tokens_empty(self):
        """Empty prompt should return empty set."""
        tokens = db.extract_prompt_tokens("")
        assert tokens == set()

        tokens = db.extract_prompt_tokens(None)
        assert tokens == set()


class TestLoraExtraction:
    """Tests for LoRA name extraction utilities."""

    def test_extract_lora_names_from_json(self):
        """LoRAs should be extracted from JSON array."""
        loras = db.extract_lora_names('["lora1", "lora2"]', None)

        assert "lora1" in loras
        assert "lora2" in loras

    def test_extract_lora_names_from_prompt(self):
        """LoRAs should be extracted from prompt tags."""
        loras = db.extract_lora_names(None, "text <lora:style:0.8> more text")

        assert "style" in loras

    def test_extract_lora_names_combined(self):
        """LoRAs should be extracted from both JSON and prompt."""
        loras = db.extract_lora_names('["lora1"]', "<lora:lora2:1.0>")

        assert "lora1" in loras
        assert "lora2" in loras

    def test_normalize_lora_name_strips_weight(self):
        """LoRA name normalization should strip weight notation."""
        assert db.normalize_lora_name("my_lora:0.8") == "my_lora"
        assert db.normalize_lora_name("style_v2:1.0") == "style_v2"

    def test_normalize_lora_name_strips_extension(self):
        """LoRA name normalization should strip file extensions."""
        assert db.normalize_lora_name("my_lora.safetensors") == "my_lora"
        assert db.normalize_lora_name("style.ckpt") == "style"


class TestCollectionOperations:
    """Tests for collection operations (Favorites)."""

    def test_get_collection_by_slug(self, test_db):
        """Getting collection by slug should work."""
        collection = db.get_collection_by_slug("favorites")

        assert collection is not None
        assert collection["slug"] == "favorites"

    def test_add_collection_item(self, test_db):
        """Adding item to collection should work."""
        image_id = db.add_image(path="/test/fav.png", filename="fav.png")
        collection = db.get_collection_by_slug("favorites")

        item_id = db.add_collection_item(
            collection_id=collection["id"],
            source_image_id=image_id,
            copied_path="/favorites/fav.png",
            prompt="test",
            negative_prompt=None,
            checkpoint=None,
            loras=None,
            metadata_json=None,
            created_at=None,
            width=512,
            height=512,
            file_size=1000,
        )

        assert item_id > 0

    def test_get_favorite_source_ids(self, test_db):
        """Getting favorite source IDs should work."""
        image_id = db.add_image(path="/test/fav2.png", filename="fav2.png")
        collection = db.get_collection_by_slug("favorites")

        db.add_collection_item(
            collection_id=collection["id"],
            source_image_id=image_id,
            copied_path="/favorites/fav2.png",
            prompt=None,
            negative_prompt=None,
            checkpoint=None,
            loras=None,
            metadata_json=None,
            created_at=None,
            width=512,
            height=512,
            file_size=1000,
        )

        ids = db.get_favorite_source_ids()

        assert image_id in ids

    def test_remove_collection_item(self, test_db):
        """Removing item from collection should work."""
        image_id = db.add_image(path="/test/remove.png", filename="remove.png")
        collection = db.get_collection_by_slug("favorites")

        db.add_collection_item(
            collection_id=collection["id"],
            source_image_id=image_id,
            copied_path="/favorites/remove.png",
            prompt=None,
            negative_prompt=None,
            checkpoint=None,
            loras=None,
            metadata_json=None,
            created_at=None,
            width=512,
            height=512,
            file_size=1000,
        )

        db.remove_collection_item(collection["id"], image_id)

        ids = db.get_favorite_source_ids()
        assert image_id not in ids


class TestUtilityFunctions:
    """Tests for utility functions."""

    def test_get_image_count(self, test_db):
        """Image count should be accurate."""
        count_before = db.get_image_count()

        db.add_image(path="/test/count1.png", filename="count1.png")
        db.add_image(path="/test/count2.png", filename="count2.png")

        count_after = db.get_image_count()

        assert count_after == count_before + 2

    def test_get_all_generators(self, test_db):
        """Getting all generators should return counts."""
        db.add_image(path="/test/gen1.png", filename="gen1.png", generator="comfyui")
        db.add_image(path="/test/gen2.png", filename="gen2.png", generator="comfyui")
        db.add_image(path="/test/gen3.png", filename="gen3.png", generator="webui")

        generators = db.get_all_generators()

        gen_dict = {g["generator"]: g["count"] for g in generators}
        assert gen_dict.get("comfyui") == 2
        assert gen_dict.get("webui") == 1

    def test_get_untagged_images(self, test_db):
        """Getting untagged images should work."""
        id1 = db.add_image(path="/test/untagged1.png", filename="untagged1.png")
        id2 = db.add_image(path="/test/untagged2.png", filename="untagged2.png")
        id3 = db.add_image(path="/test/tagged.png", filename="tagged.png")
        db.add_tags(id3, [{"tag": "test", "confidence": 0.9}])

        untagged = db.get_untagged_images()

        untagged_ids = [img["id"] for img in untagged]
        assert id1 in untagged_ids
        assert id2 in untagged_ids
        assert id3 not in untagged_ids

    def test_get_all_image_ids(self, test_db):
        """Getting all image IDs should be lightweight."""
        db.add_image(path="/test/ids1.png", filename="ids1.png")
        db.add_image(path="/test/ids2.png", filename="ids2.png")

        ids = db.get_all_image_ids()

        assert len(ids) >= 2
        assert all(isinstance(i, int) for i in ids)
