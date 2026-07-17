"""Pure parser + language/tag heuristics for the Dataset Maker translation service.

Split out of ``services/dataset_translate_service.py`` (2026-07) VERBATIM —
stateless helpers only: the VLM output parser, the cache-key language
normalisers, and the tag-list heuristics. The pinned DORMANT quirks move
AS-IS (tests/test_dataset_translate_pins.py): the line-fallback parser
lstrips ``-*0123456789.、) `` off translations that legitimately start with
them, ``_looks_like_tag_list`` treats ANY <=5-word string as a tag list, and
``_translate_mode_for_texts`` silently reroutes caption requests to the tag
path when every input looks tag-like. Do not "fix" them here.
"""
from __future__ import annotations

import json
from typing import List


# ------------------------------ helpers ------------------------------

def _parse_translation_output(raw_text: str, expected_count: int) -> List[str]:
    text = str(raw_text or "").strip()
    if not text:
        return [""] * expected_count
    if text.startswith("```"):
        text = text.strip("`")
        if "\n" in text:
            text = text.split("\n", 1)[1].strip()
    try:
        parsed = json.loads(text)
        if isinstance(parsed, dict):
            parsed = parsed.get("translations") or parsed.get("items") or []
        if isinstance(parsed, list):
            out = [str(item or "").strip() for item in parsed]
            return (out + [""] * expected_count)[:expected_count]
    except Exception:
        pass
    lines = [
        line.strip().lstrip("-*0123456789.、) ")
        for line in text.splitlines()
        if line.strip()
    ]
    if len(lines) == expected_count:
        return lines
    return [text] + [""] * max(0, expected_count - 1)


def _translation_lang_code(lang: str, *, provider: str) -> str:
    value = str(lang or "zh-CN").strip()
    if provider == "bing" and value.lower() in {"zh-cn", "zh-hans", "cn"}:
        return "zh-Hans"
    if provider == "google" and value.lower() in {"zh-hans", "zh_cn", "cn"}:
        return "zh-CN"
    if provider == "baidu" and value.lower() in {"zh-cn", "zh-hans", "zh_cn", "cn"}:
        return "zh"
    return value


def _translation_source_lang(lang: str) -> str:
    value = str(lang or "en").strip()
    return value if value and value.lower() != "auto" else "en"


def _split_caption_tags(text: str) -> List[str]:
    return [token.strip() for token in str(text or "").split(",") if token.strip()]


def _looks_like_tag_list(text: str) -> bool:
    value = str(text or "")
    return "," in value or "_" in value or len(value.split()) <= 5


def _translate_mode_for_texts(mode: str, texts: List[str]) -> str:
    requested = str(mode or "").lower()
    if requested == "tags":
        return "tags"
    # Dataset captions are often comma-separated tag captions even when the
    # UI calls the button from a generic caption row. Treat those as tags so
    # we can dedupe/cache each token instead of spending quota on whole lines.
    if texts and all(_looks_like_tag_list(text) for text in texts):
        return "tags"
    return "caption"
