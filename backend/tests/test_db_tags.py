"""Tests for db_tags deduplication logic (Bug 3 fix)."""
import database as db
from db_tags import _dedupe_tags


def test_dedupe_keeps_highest_confidence():
    """Dedupe should keep the tag with highest confidence when case-insensitive duplicates exist."""
    tags = [
        ("tag1", 0.8),
        ("TAG1", 0.9),  # Same tag, higher confidence
        ("tag2", 0.7),
    ]

    result = _dedupe_tags(tags)

    # Should keep TAG1 (0.9) not tag1 (0.8)
    assert len(result) == 2
    tag_dict = {tag.lower(): (tag, conf) for tag, conf in result}
    assert "tag1" in tag_dict
    assert tag_dict["tag1"][1] == 0.9  # Higher confidence kept
    assert "tag2" in tag_dict


def test_dedupe_case_insensitive():
    """Dedupe should treat tags as case-insensitive."""
    tags = [
        ("Masterpiece", 0.85),
        ("masterpiece", 0.90),
        ("MASTERPIECE", 0.80),
    ]

    result = _dedupe_tags(tags)

    assert len(result) == 1
    assert result[0][1] == 0.90  # Highest confidence


def test_dedupe_preserves_order():
    """Dedupe should preserve the order of first occurrence, updated position when higher confidence found."""
    tags = [
        ("first", 0.9),
        ("second", 0.8),
        ("third", 0.7),
        ("FIRST", 0.95),  # Higher confidence but appears later
    ]

    result = _dedupe_tags(tags)

    assert len(result) == 3
    # When a higher confidence duplicate is found, it replaces at the new position
    # So result should be: second (0.8), third (0.7), FIRST (0.95)
    assert result[0][0].lower() == "second"
    assert result[0][1] == 0.8
    assert result[1][0].lower() == "third"
    assert result[1][1] == 0.7
    assert result[2][0].lower() == "first"
    assert result[2][1] == 0.95  # Updated to higher confidence


def test_dedupe_empty_list():
    """Dedupe should handle empty list gracefully."""
    result = _dedupe_tags([])
    assert result == []


def test_dedupe_no_duplicates():
    """Dedupe should preserve all tags when no duplicates exist."""
    tags = [
        ("tag1", 0.9),
        ("tag2", 0.8),
        ("tag3", 0.7),
    ]

    result = _dedupe_tags(tags)

    assert len(result) == 3
    assert result == tags


def test_add_tags_deduplicates(tmp_path):
    """add_tags() should deduplicate case-insensitive tags, keeping highest confidence."""
    image_id = db.add_image(path=str(tmp_path / "test.png"), filename="test.png")

    # Add tags with case-insensitive duplicates
    tags = [
        {"tag": "Masterpiece", "confidence": 0.85},
        {"tag": "masterpiece", "confidence": 0.90},
        {"tag": "blue_eyes", "confidence": 0.80},
        {"tag": "BLUE_EYES", "confidence": 0.95},
    ]

    db.add_tags(image_id, tags)

    # Retrieve and verify
    stored = db.get_image_tags(image_id)
    assert len(stored) == 2

    # Check that highest confidence was kept
    tag_dict = {t["tag"].lower(): t for t in stored}
    assert "masterpiece" in tag_dict
    assert tag_dict["masterpiece"]["confidence"] == 0.90
    assert "blue_eyes" in tag_dict
    assert tag_dict["blue_eyes"]["confidence"] == 0.95


def test_add_tags_batch_deduplicates(tmp_path):
    """add_tags_batch() should deduplicate case-insensitive tags for each image."""
    image1_id = db.add_image(path=str(tmp_path / "test1.png"), filename="test1.png")
    image2_id = db.add_image(path=str(tmp_path / "test2.png"), filename="test2.png")

    batch = [
        {
            "image_id": image1_id,
            "tags": [
                {"tag": "Tag1", "confidence": 0.8},
                {"tag": "tag1", "confidence": 0.9},
                {"tag": "tag2", "confidence": 0.7},
            ],
        },
        {
            "image_id": image2_id,
            "tags": [
                {"tag": "TagA", "confidence": 0.85},
                {"tag": "TAGA", "confidence": 0.95},
            ],
        },
    ]

    db.add_tags_batch(batch)

    # Verify image1
    stored1 = db.get_image_tags(image1_id)
    assert len(stored1) == 2
    tag_dict1 = {t["tag"].lower(): t for t in stored1}
    assert tag_dict1["tag1"]["confidence"] == 0.9  # Higher kept
    assert tag_dict1["tag2"]["confidence"] == 0.7

    # Verify image2
    stored2 = db.get_image_tags(image2_id)
    assert len(stored2) == 1
    assert stored2[0]["tag"].lower() == "taga"
    assert stored2[0]["confidence"] == 0.95  # Higher kept
