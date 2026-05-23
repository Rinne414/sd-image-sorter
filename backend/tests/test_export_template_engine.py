from services.export_template_engine import build_export_caption


def test_template_blacklist_filters_preset_quality_safety_count_and_tags():
    image = {
        "ai_caption": "A close-up portrait.",
        "prompt": "soft light",
        "rating": "safe",
    }
    tags = [
        {"tag": "1girl", "confidence": 0.95},
        {"tag": "blue_eyes", "confidence": 0.9},
        {"tag": "score_5", "confidence": 0.8},
    ]

    rendered = build_export_caption(
        image,
        tags,
        preset_id="anima",
        blacklist=["newest", "highres", "normal quality", "score_5", "safe", "1girl"],
    )

    assert "A close-up portrait." in rendered
    assert "blue eyes" in rendered
    for blocked in ["newest", "highres", "normal quality", "score_5", "safe", "1girl"]:
        assert blocked not in rendered


def test_template_blacklist_filters_comma_separated_chunks_from_overrides():
    rendered = build_export_caption(
        {"ai_caption": "caption"},
        [{"tag": "keep_tag", "confidence": 1.0}],
        preset_id="custom",
        template_override="{quality}, {safety}, {tags:filtered}, {append}",
        quality_override="newest, highres, normal quality",
        safety_override="safe",
        append=["score_5", "extra_tag"],
        blacklist=["newest", "highres", "normal quality", "score_5", "safe"],
    )

    assert rendered == "keep_tag, extra_tag"


def test_template_blacklist_filters_prompt_and_caption_variables():
    rendered = build_export_caption(
        {
            "ai_caption": "safe, close-up portrait",
            "prompt": "newest, highres, normal quality, soft light, 1girl",
            "negative_prompt": "bad anatomy, score_5",
        },
        [{"tag": "blue_eyes", "confidence": 1.0}],
        preset_id="custom",
        template_override="{nl_caption}, {prompt}, {negative}, {tags:filtered}",
        blacklist=["newest", "highres", "normal quality", "score_5", "safe", "1girl"],
    )

    assert rendered == "close-up portrait, soft light, bad anatomy, blue_eyes"




def test_template_dedups_trigger_and_append_underscore_variants():
    """LoRA-trainer regression: when the trigger word is also added to
    common_tags via the "🏷️ Add my trigger word here" quick-fill, the
    rendered caption used to contain it twice — once at position #1 with
    underscore (from {trigger}) and once after underscore normalisation
    (e.g. ``my_oc, ..., my oc, ...``). A real trainer would then treat
    those as two different BPE tokens. Dedup must catch this even when
    the two variants differ only by ``_`` vs space + case.
    """
    image = {"id": 1, "rating": "general", "ai_caption": "", "prompt": ""}
    tags = [
        {"tag": "1girl", "confidence": 0.9},
        {"tag": "looking_at_viewer", "confidence": 0.85},
        {"tag": "school_uniform", "confidence": 0.85},
    ]
    rendered = build_export_caption(
        image, tags,
        preset_id="custom",
        template_override="{trigger}, {tags:filtered}, {append}",
        trigger="my_oc",
        append=["my_oc", "masterpiece", "best_quality"],
        underscore_to_space_override=True,
        preserve_underscore_prefixes_override=["score_"],
    )
    tokens = [t.strip() for t in rendered.split(",")]
    # Trigger present, exactly once, at position #1
    assert tokens[0] == "my_oc", f"trigger should be at position #1, got {tokens!r}"
    # No second copy of the trigger anywhere else (underscore or space form)
    norm = lambda s: s.replace("_", " ").lower()
    duplicates = [t for t in tokens[1:] if norm(t) == "my oc"]
    assert duplicates == [], f"trigger appeared twice: {tokens!r}"
    # Sanity: the other tags still landed
    assert "1girl" in tokens
    assert "looking at viewer" in tokens or "looking_at_viewer" in tokens


def test_template_dedups_case_insensitive():
    """``Masterpiece`` and ``masterpiece`` should collapse to one token."""
    image = {"id": 1}
    tags = [{"tag": "Masterpiece", "confidence": 0.9}]
    rendered = build_export_caption(
        image, tags,
        preset_id="custom",
        template_override="{tags:filtered}, {append}",
        trigger="",
        append=["masterpiece", "best_quality"],
        underscore_to_space_override=False,
    )
    tokens = [t.strip().lower() for t in rendered.split(",")]
    assert tokens.count("masterpiece") == 1, f"masterpiece appeared {tokens.count('masterpiece')} times in {rendered!r}"


def test_template_preserves_distinct_tags():
    """Dedup must not eat distinct tags that just share a substring."""
    image = {"id": 1}
    tags = [
        {"tag": "long_hair", "confidence": 0.9},
        {"tag": "short_hair", "confidence": 0.9},  # different tag
        {"tag": "blue_hair", "confidence": 0.85},
    ]
    rendered = build_export_caption(
        image, tags,
        preset_id="custom",
        template_override="{tags:filtered}",
        trigger="",
        underscore_to_space_override=True,
    )
    tokens = [t.strip() for t in rendered.split(",")]
    assert "long hair" in tokens
    assert "short hair" in tokens
    assert "blue hair" in tokens
