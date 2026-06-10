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


# v3.3.0 FEAT-EXCLUDE-EXTRA: exclude by prompt term and by color temperature.
def test_exclude_prompts_filters_out_matching_images(test_db):
    """Images whose prompt contains an excluded term should be removed."""
    import database as db

    keep = db.add_image(path="/t/keep.png", filename="keep.png", prompt="masterpiece, landscape")
    drop = db.add_image(path="/t/drop.png", filename="drop.png", prompt="masterpiece, ugly, blurry")

    result = db.get_images_paginated(exclude_prompts=["ugly"], prompt_match_mode="contains", limit=100)
    ids = [img["id"] for img in result["images"]]
    assert keep in ids
    assert drop not in ids


# v3.4.0 FIX: exact-mode excludePrompts must use exact token equality, not the
# broad substring LIKE the include side pre-filters with. The include side is
# corrected by an exact post-filter; excludes have none, so the LIKE pattern
# permanently over-excluded (excluding "cat" also hid "catgirl"/"scattered").
def test_exclude_prompts_exact_mode_does_not_match_substrings(test_db):
    import database as db

    catgirl = db.add_image(path="/t/exg.png", filename="exg.png", prompt="1girl, catgirl, smile")
    scattered = db.add_image(path="/t/exs.png", filename="exs.png", prompt="scattered petals, 1girl")
    cat = db.add_image(path="/t/exc.png", filename="exc.png", prompt="1girl, cat, smile")

    result = db.get_images_paginated(exclude_prompts=["cat"], prompt_match_mode="exact", limit=100)
    ids = [img["id"] for img in result["images"]]
    assert catgirl in ids, "exact-mode exclude 'cat' must not exclude 'catgirl'"
    assert scattered in ids, "exact-mode exclude 'cat' must not exclude 'scattered'"
    assert cat not in ids, "exact-mode exclude 'cat' must exclude the 'cat' token"


def test_exclude_prompts_exact_mode_normalizes_term(test_db):
    """Exact-mode exclude terms normalize like stored tokens (case + underscores)."""
    import database as db

    eared = db.add_image(path="/t/exn.png", filename="exn.png", prompt="masterpiece, cat ears")
    plain = db.add_image(path="/t/exp.png", filename="exp.png", prompt="masterpiece, landscape")

    result = db.get_images_paginated(exclude_prompts=["Cat_Ears"], prompt_match_mode="exact", limit=100)
    ids = [img["id"] for img in result["images"]]
    assert eared not in ids
    assert plain in ids


def test_exclude_prompts_contains_mode_still_matches_substrings(test_db):
    import database as db

    catgirl = db.add_image(path="/t/cg.png", filename="cg.png", prompt="1girl, catgirl, smile")
    cat = db.add_image(path="/t/c.png", filename="c.png", prompt="1girl, cat, smile")
    dog = db.add_image(path="/t/d.png", filename="d.png", prompt="1girl, dog, smile")

    result = db.get_images_paginated(exclude_prompts=["cat"], prompt_match_mode="contains", limit=100)
    ids = [img["id"] for img in result["images"]]
    assert catgirl not in ids
    assert cat not in ids
    assert dog in ids


def test_exclude_colors_filters_out_matching_images(test_db):
    """Images whose color_temperature is excluded should be removed."""
    import database as db

    warm = db.add_image(path="/t/warm.png", filename="warm.png")
    cool = db.add_image(path="/t/cool.png", filename="cool.png")
    with db.get_db() as conn:
        conn.execute("UPDATE images SET color_temperature = 'warm' WHERE id = ?", (warm,))
        conn.execute("UPDATE images SET color_temperature = 'cool' WHERE id = ?", (cool,))

    result = db.get_images_paginated(exclude_colors=["warm"], limit=100)
    ids = [img["id"] for img in result["images"]]
    assert cool in ids
    assert warm not in ids


def test_exclude_extra_empty_no_effect(test_db_with_images):
    """Empty prompts/colors exclude arrays should not change results."""
    import database as db

    baseline = db.get_images_paginated(limit=100)
    with_empty = db.get_images_paginated(exclude_prompts=[], exclude_colors=[], limit=100)
    assert len(baseline["images"]) == len(with_empty["images"])


# v3.3.x regression guard (Ask-2 "过滤器筛选不全 + -1 张图"): the count used for
# get_images_paginated["total"] (_get_filtered_count) must apply the SAME color +
# exclude filters as the page query and as the offset-path get_filtered_image_count.
# It previously omitted them, so "total" was inflated under an active color/exclude
# filter and the gallery looked like the filter had not narrowed the set.
def test_paginated_total_matches_count_under_color_filter(test_db):
    import database as db

    warm_a = db.add_image(path="/t/wa.png", filename="wa.png")
    warm_b = db.add_image(path="/t/wb.png", filename="wb.png")
    cool_a = db.add_image(path="/t/ca.png", filename="ca.png")
    with db.get_db() as conn:
        conn.execute("UPDATE images SET color_temperature = 'warm' WHERE id IN (?, ?)", (warm_a, warm_b))
        conn.execute("UPDATE images SET color_temperature = 'cool' WHERE id = ?", (cool_a,))

    result = db.get_images_paginated(color_temperature="warm", sort_by="newest", skip_count=False, limit=100)
    # All matches fit on one page, so total must equal the rows actually returned.
    assert len(result["images"]) == 2
    assert result["total"] == 2
    assert result["total"] == db.get_filtered_image_count(color_temperature="warm")


def test_paginated_total_matches_count_under_exclude_color(test_db):
    import database as db

    warm_a = db.add_image(path="/t/wa.png", filename="wa.png")
    cool_a = db.add_image(path="/t/ca.png", filename="ca.png")
    with db.get_db() as conn:
        conn.execute("UPDATE images SET color_temperature = 'warm' WHERE id = ?", (warm_a,))
        conn.execute("UPDATE images SET color_temperature = 'cool' WHERE id = ?", (cool_a,))

    result = db.get_images_paginated(exclude_colors=["warm"], skip_count=False, limit=100)
    assert len(result["images"]) == 1
    assert result["total"] == 1
    assert result["total"] == db.get_filtered_image_count(exclude_colors=["warm"])


def test_paginated_total_matches_count_under_exclude_tags(test_db_with_images):
    import database as db

    result = db.get_images_paginated(exclude_tags=["1girl"], skip_count=False, limit=100)
    assert result["total"] == len(result["images"])
    assert result["total"] == db.get_filtered_image_count(exclude_tags=["1girl"])
