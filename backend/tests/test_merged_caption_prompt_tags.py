"""The default LoRA caption file (caption_merged) and the picture's prompt.

GitHub issue #5: with "Convert tag underscores to spaces" ticked, the default
LoRA caption still wrote ``long_hair`` from the prompt next to ``long hair``
from the tags, and every tag the prompt shared with the tag rows came out
twice. A tag-style prompt is now split into its tags, cleaned of SD syntax,
given the same underscore rule and deduplicated against the tag rows. A
prose prompt (Flux, Krea, natural language) is still written as it is.
"""

from __future__ import annotations

from services.tag_export.captions import build_sidecar_content


def _rows(*names: str) -> list:
    return [{"tag": name, "confidence": 0.9, "category": "general"} for name in names]


def _merged(prompt: str, tags: list, **kwargs) -> str:
    image = {"id": 1, "filename": "1 (2)_1.png", "prompt": prompt}
    return build_sidecar_content(image, tags, content_mode="caption_merged", **kwargs)


def _parts(text: str) -> list:
    return [part.strip() for part in text.split(",")]


def test_tags_shared_by_prompt_and_rows_are_written_once():
    caption = _merged(
        "1girl, solo, long_hair, smile, sample_30",
        _rows("1girl", "long_hair", "blue_eyes", "smile", "solo"),
    )

    parts = _parts(caption)
    assert parts == ["1girl", "solo", "long hair", "smile", "sample 30", "blue eyes"]
    assert len(parts) == len({p.lower() for p in parts})


def test_the_underscore_option_off_keeps_underscores_everywhere():
    caption = _merged(
        "1girl, long_hair",
        _rows("1girl", "long_hair", "blue_eyes"),
        normalize_tag_underscores=False,
    )

    assert _parts(caption) == ["1girl", "long_hair", "blue_eyes"]


def test_sd_prompt_syntax_is_removed_from_the_prompt_tags():
    caption = _merged(
        "masterpiece, (best quality:1.2), [[smile]], {{1girl}}, 1.3::blue_eyes::, "
        "<lora:my_style:0.8>, BREAK, hatsune_miku \\(vocaloid\\), score_9, score_8_up",
        _rows("1girl"),
    )

    assert _parts(caption) == [
        "masterpiece",
        "best quality",
        "smile",
        "1girl",
        "blue eyes",
        "hatsune miku (vocaloid)",
        "score_9",
        "score_8_up",
    ]


def test_tags_that_look_like_syntax_survive():
    caption = _merged(
        ":3, ^_^, >_<, nier:automata, honkai:_star_rail, re:zero, (:3:1.1)",
        [],
        normalize_tag_underscores=False,
    )

    assert _parts(caption) == [":3", "^_^", ">_<", "nier:automata", "honkai:_star_rail", "re:zero"]


def test_unescaped_brackets_that_belong_to_a_tag_are_kept():
    """NovelAI and many ComfyUI prompts write a tag's own brackets unescaped."""
    caption = _merged(
        "2b_(nier:automata), hatsune miku (vocaloid), (o)_(o), :), ;), >:), |_|, tag:12",
        [],
        normalize_tag_underscores=False,
    )

    assert _parts(caption) == [
        "2b_(nier:automata)",
        "hatsune miku (vocaloid)",
        "(o)_(o)",
        ":)",
        ";)",
        ">:)",
        "|_|",
        "tag:12",
    ]


def test_weights_are_removed_only_inside_emphasis():
    caption = _merged(
        "((masterpiece)), (blue eyes, red hair:1.2), (2b_(nier:automata):1.1), [[[smile]]], <lyco:x:0.5>",
        [],
        normalize_tag_underscores=False,
    )

    assert _parts(caption) == ["masterpiece", "blue eyes", "red hair", "2b_(nier:automata)", "smile"]


def test_the_blacklist_also_removes_prompt_tags():
    caption = _merged(
        "masterpiece, 1girl, long_hair",
        _rows("1girl"),
        blacklist={"masterpiece", "long hair"},
    )

    assert _parts(caption) == ["1girl"]


def test_a_prose_prompt_is_kept_as_written():
    prompt = "A young woman with long_hair stands in a field at sunset, smiling at the viewer."

    caption = _merged(prompt, _rows("1girl", "long_hair"))

    assert caption == f"{prompt}, 1girl, long hair"


def test_the_prompt_only_mode_still_writes_the_raw_prompt():
    image = {"id": 1, "prompt": "1girl, (long_hair:1.2), <lora:x:1>"}

    assert (
        build_sidecar_content(image, _rows("1girl"), content_mode="prompt")
        == image["prompt"]
    )
