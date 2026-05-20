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
