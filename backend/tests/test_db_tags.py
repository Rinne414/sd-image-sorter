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


def test_add_tags_deduplicates(test_db, tmp_path):
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


def test_add_tags_batch_deduplicates(test_db, tmp_path):
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


# ---------------------------------------------------------------------------
# Tag provenance (audit P1-5): pipeline re-tags must not clobber manual tags
# ---------------------------------------------------------------------------


def test_manual_tags_survive_pipeline_retag(test_db, tmp_path):
    """replace_scope='pipeline' replaces tagger/vlm/trigger rows only."""
    image_id = db.add_image(path=str(tmp_path / "keep.png"), filename="keep.png")

    db.add_tags(image_id, [{"tag": "my_oc_name", "confidence": 1.0}], default_source="manual")
    db.add_tags(
        image_id,
        [{"tag": "1girl", "confidence": 0.9}],
        default_source="tagger",
        replace_scope="pipeline",
    )
    # Re-tag: old tagger rows go away, the manual row survives.
    db.add_tags(
        image_id,
        [{"tag": "solo", "confidence": 0.8}],
        default_source="tagger",
        replace_scope="pipeline",
    )

    by_tag = {t["tag"]: t for t in db.get_image_tags(image_id)}
    assert "my_oc_name" in by_tag
    assert by_tag["my_oc_name"]["source"] == "manual"
    assert "solo" in by_tag
    assert by_tag["solo"]["source"] == "tagger"
    assert "1girl" not in by_tag


def test_manual_tag_wins_dedupe_against_pipeline_duplicate(test_db, tmp_path):
    """When a re-tag emits a tag the user already added manually, the manual
    row keeps its provenance instead of being demoted to source='tagger'."""
    image_id = db.add_image(path=str(tmp_path / "dup.png"), filename="dup.png")

    db.add_tags(image_id, [{"tag": "blue_eyes", "confidence": 1.0}], default_source="manual")
    db.add_tags(
        image_id,
        [{"tag": "blue_eyes", "confidence": 0.42}, {"tag": "1girl", "confidence": 0.9}],
        default_source="tagger",
        replace_scope="pipeline",
    )

    stored = db.get_image_tags(image_id)
    rows = [t for t in stored if t["tag"] == "blue_eyes"]
    assert len(rows) == 1
    assert rows[0]["source"] == "manual"


def test_replace_scope_all_still_clobbers_everything(test_db, tmp_path):
    image_id = db.add_image(path=str(tmp_path / "all.png"), filename="all.png")

    db.add_tags(image_id, [{"tag": "manual_one", "confidence": 1.0}], default_source="manual")
    db.add_tags(
        image_id,
        [{"tag": "fresh", "confidence": 0.9}],
        default_source="tagger",
        replace_scope="all",
    )

    assert [t["tag"] for t in db.get_image_tags(image_id)] == ["fresh"]


def test_legacy_null_source_rows_replaced_by_pipeline_scope(test_db, tmp_path):
    """Rows written before migration 024 have source=NULL; a pipeline re-tag
    treats them as pipeline output (matches historical replace semantics)."""
    image_id = db.add_image(path=str(tmp_path / "legacy.png"), filename="legacy.png")

    db.add_tags(image_id, [{"tag": "old_row", "confidence": 0.5}])  # source=NULL
    db.add_tags(
        image_id,
        [{"tag": "new_row", "confidence": 0.9}],
        default_source="tagger",
        replace_scope="pipeline",
    )

    assert [t["tag"] for t in db.get_image_tags(image_id)] == ["new_row"]
