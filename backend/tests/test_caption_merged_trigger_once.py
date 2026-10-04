"""The default Gallery "Training captions" mode writes the trigger once.

``caption_merged`` joins the prefix (the trigger as typed), the AI caption and
the tags. Smart Tag writes the trigger into ai_caption with a space
("mylora walk"), so the typed "mylora_walk" and that copy both reached the
file: the trigger-split bug the 2026-10-04 walkthrough found in Dataset Maker,
on another path. Underscore and space spellings of one tag are one tag.
"""

from __future__ import annotations

from services.tag_export.captions import build_sidecar_content


def _tags(*names: str) -> list[dict]:
    return [{"tag": name, "category": "general", "confidence": 0.9} for name in names]


def test_caption_merged_keeps_the_typed_trigger_once() -> None:
    image = {"ai_caption": "mylora walk, 1girl, long hair, smiling", "prompt": "", "nl_caption": ""}

    text = build_sidecar_content(
        image,
        _tags("1girl", "long_hair", "smiling"),
        content_mode="caption_merged",
        prefix="mylora_walk",
    )

    parts = [part.strip() for part in text.split(",")]
    assert parts[0] == "mylora_walk"
    assert "mylora walk" not in parts
    assert sum(part.replace("_", " ") == "long hair" for part in parts) == 1


def test_caption_tags_does_not_repeat_space_and_underscore_spellings() -> None:
    image = {"ai_caption": "long hair, twin braids", "prompt": "", "nl_caption": ""}

    text = build_sidecar_content(
        image,
        _tags("long_hair", "twin_braids"),
        content_mode="caption_tags",
        normalize_tag_underscores=False,
    )

    parts = [part.strip() for part in text.split(",")]
    assert len(parts) == 2
