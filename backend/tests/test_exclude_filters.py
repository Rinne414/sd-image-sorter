"""Tests for v3.2.2 per-item exclude filters (Debt-27)."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))


def test_exclude_tags_filters_out_matching_images(test_db_with_images):
    """Images with excluded tags should not appear in results."""
    import database as db

    # Without exclude: image with '1girl' tag should appear
    all_results = db.get_images_paginated(limit=100)
    all_ids = [img["id"] for img in all_results["images"]]
    assert len(all_ids) >= 2

    # With exclude_tags=['1girl']: image 2 (nai_test) should be excluded
    filtered = db.get_images_paginated(exclude_tags=["1girl"], limit=100)
    filtered_ids = [img["id"] for img in filtered["images"]]

    # The image with '1girl' tag should not be in filtered results
    # Image 2 has '1girl' tag (from conftest)
    for img in filtered["images"]:
        assert img["filename"] != "nai_test.png", "Image with excluded tag should not appear"

    assert len(filtered_ids) < len(all_ids)


def test_exclude_generators_filters_out_matching_images(test_db_with_images):
    """Images with excluded generators should not appear in results."""
    import database as db

    all_results = db.get_images_paginated(limit=100)
    all_count = len(all_results["images"])

    filtered = db.get_images_paginated(exclude_generators=["comfyui"], limit=100)
    for img in filtered["images"]:
        assert img["generator"] != "comfyui"
    assert len(filtered["images"]) < all_count


def test_exclude_checkpoints_filters_out_matching_images(test_db_with_images):
    """Images with excluded checkpoints should not appear in results."""
    import database as db

    filtered = db.get_images_paginated(
        exclude_checkpoints=["sd_xl_base_1.0.safetensors"],
        limit=100,
    )
    for img in filtered["images"]:
        assert img["checkpoint"] != "sd_xl_base_1.0.safetensors"


def test_exclude_combined_with_include(test_db_with_images):
    """Exclude filters work alongside include filters."""
    import database as db

    # Include only comfyui+nai generators, but exclude images with '1girl' tag
    filtered = db.get_images_paginated(
        generators=["comfyui", "nai"],
        exclude_tags=["1girl"],
        limit=100,
    )
    for img in filtered["images"]:
        assert img["generator"] in ("comfyui", "nai")
        assert img["filename"] != "nai_test.png"


def test_exclude_empty_arrays_no_effect(test_db_with_images):
    """Empty exclude arrays should not change results."""
    import database as db

    baseline = db.get_images_paginated(limit=100)
    with_empty = db.get_images_paginated(
        exclude_tags=[],
        exclude_generators=[],
        exclude_ratings=[],
        exclude_checkpoints=[],
        exclude_loras=[],
        limit=100,
    )
    assert len(baseline["images"]) == len(with_empty["images"])


def test_exclude_tags_in_get_filtered_image_count(test_db_with_images):
    """get_filtered_image_count respects exclude_tags."""
    import database as db

    total = db.get_filtered_image_count()
    excluded = db.get_filtered_image_count(exclude_tags=["1girl"])
    assert excluded < total


def test_exclude_tags_in_get_filtered_image_ids(test_db_with_images):
    """get_filtered_image_ids respects exclude_tags."""
    import database as db

    all_ids = db.get_filtered_image_ids()
    excluded_ids = db.get_filtered_image_ids(exclude_tags=["1girl"])
    assert len(excluded_ids) < len(all_ids)
