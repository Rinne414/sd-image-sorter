"""The default "LoRA dataset" journey writes each tag once, trigger as typed.

Journey (found by a real-browser walkthrough): Smart Tag with defaults and no
natural-language captioner, send the pictures to the Dataset Maker, export
with defaults. Two defects showed up in every ``.txt``:

* The whole tag list twice. Smart Tag stores its composed tag caption in
  ``ai_caption`` and leaves ``nl_caption`` empty; the "fused ai_caption"
  fallback meant for rows tagged before the nl_caption split then handed that
  tag list to the natural-language slot, the editor auto-picked "both", and
  the export wrote tags + the same tags again.
* The trigger split in two. ``mylora_walk`` came back as ``mylora walk``
  because the trigger tag row went through ordinary underscore normalization.

All tests run on the ``test_db`` fixture, never the real library.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from PIL import Image

from services.smart_tag.request import SmartTagRequest
from services.smart_tag.results import (
    _assemble_result_dict,
    _booru_partial_from_tag_result,
    _persist_result,
)

pytestmark = pytest.mark.usefixtures("authorize_legacy_dataset_exports")

TRIGGER = "mylora_walk"
GENERAL = [
    {"tag": "1girl", "confidence": 0.98},
    {"tag": "solo", "confidence": 0.95},
    {"tag": "long_hair", "confidence": 0.9},
    {"tag": "twin_braids", "confidence": 0.8},
]

# What the Dataset Maker sends by default (template mode, underscore
# normalization on, the editor's template, no trigger typed there yet).
DM_TEMPLATE = "{trigger}, {tags:filtered}, {append}"


def _smart_tag_booru_only(image_id: int) -> None:
    """Persist one image exactly as a booru-only Smart Tag run does."""
    req = SmartTagRequest(
        image_ids=[image_id],
        trigger_word=TRIGGER,
        enable_wd14=True,
        enable_vlm=False,
    )
    raw = {
        "general_tags": GENERAL,
        "character_tags": [],
        "copyright_tags": [],
        "rating": {"label": "sensitive", "score": 0.7},
    }
    partial = _booru_partial_from_tag_result(raw, req)
    result = _assemble_result_dict(partial, "", image_id, req)
    _persist_result(image_id, result, "replace")


@pytest.fixture
def smart_tagged_image(test_db, tmp_path: Path):
    import database as db

    src = tmp_path / "src"
    src.mkdir()
    path = src / "walk.png"
    Image.new("RGB", (32, 32), color=(80, 90, 100)).save(path)
    image_id = db.add_image(path=str(path), filename="walk.png")
    _smart_tag_booru_only(image_id)
    return image_id, path


def _tokens(caption: str) -> list[str]:
    return [part.strip() for part in caption.split(",") if part.strip()]


def test_smart_tag_without_captioner_leaves_a_tag_list_in_ai_caption(
    smart_tagged_image,
):
    """Pins the stored shape the rest of this file reasons about."""
    import database as db

    image_id, _path = smart_tagged_image
    row = db.get_images_by_ids([image_id])[image_id]
    assert not row.get("nl_caption")
    assert TRIGGER in str(row.get("ai_caption") or "")
    assert "twin braids" in str(row.get("ai_caption") or "")


def test_editor_preview_offers_no_natural_language_seed_for_a_tag_list(
    test_client, smart_tagged_image
):
    image_id, _path = smart_tagged_image
    response = test_client.post(
        "/api/tags/export-preview",
        json={
            "image_ids": [image_id],
            "preset_id": "custom",
            "template_override": DM_TEMPLATE,
            "trigger": "",
            "append": [],
            "underscore_to_space_override": True,
            "preserve_underscore_prefixes_override": ["score_"],
        },
    )
    assert response.status_code == 200, response.text
    item = response.json()["results"][0]

    # The editor seeds its natural-language box from this field; a Booru tag
    # list is not a sentence, so there is nothing to seed.
    assert item["nl_source"] == ""


def test_editor_preview_keeps_a_real_sentence_as_the_seed(test_client, test_db):
    import database as db

    image_id = db.add_image(path="/pins/nl/seed.png", filename="seed.png")
    db.update_image_caption(image_id, "", nl_caption="A girl walks along a quiet road.")
    legacy_id = db.add_image(path="/pins/nl/legacy.png", filename="legacy.png")
    # A pre-split row: the fused tags + sentence caption, no nl_caption.
    db.update_image_caption(legacy_id, "1girl, solo, A girl walks along a quiet road.")

    response = test_client.post(
        "/api/tags/export-preview",
        json={
            "image_ids": [image_id, legacy_id],
            "preset_id": "custom",
        },
    )
    assert response.status_code == 200, response.text
    by_id = {item["image_id"]: item for item in response.json()["results"]}
    assert by_id[image_id]["nl_source"] == "A girl walks along a quiet road."
    assert (
        by_id[legacy_id]["nl_source"] == "1girl, solo, A girl walks along a quiet road."
    )


def test_editor_caption_keeps_the_trigger_exactly_as_typed(
    test_client, smart_tagged_image
):
    image_id, _path = smart_tagged_image
    response = test_client.post(
        "/api/tags/export-preview",
        json={
            "image_ids": [image_id],
            "preset_id": "custom",
            "template_override": DM_TEMPLATE,
            "trigger": "",
            "append": [],
            "underscore_to_space_override": True,
            "preserve_underscore_prefixes_override": ["score_"],
        },
    )
    assert response.status_code == 200, response.text
    tokens = _tokens(response.json()["results"][0]["rendered"])

    assert tokens.count(TRIGGER) == 1, tokens
    assert "mylora walk" not in tokens
    # Ordinary tags still follow the underscore setting.
    assert "twin braids" in tokens


def _default_export(test_client, image_id: int, out: Path, **extra) -> str:
    trigger = extra.pop("trigger", "")
    body = {
        "image_ids": [image_id],
        "trigger": trigger,
        "output_folder": str(out),
        "naming_pattern": "{index:03d}",
        "image_op": "copy",
        "overwrite_policy": "unique",
        "content_mode": "template",
        "normalize_tag_underscores": True,
        "template_options": {
            "preset_id": "custom",
            "template_override": DM_TEMPLATE,
            "trigger": trigger,
            "blacklist": [],
            "replace_rules": {},
            "max_tags": 0,
            "append": [],
            "underscore_to_space_override": True,
            "preserve_underscore_prefixes_override": ["score_"],
        },
        **extra,
    }
    response = test_client.post("/api/dataset/export", json=body)
    assert response.status_code == 200, response.text
    assert response.json()["status"] == "ok", response.json()
    return (out / "001.txt").read_text(encoding="utf-8")


@pytest.mark.parametrize("caption_type", [None, "both"])
def test_default_export_writes_each_tag_once(
    test_client, smart_tagged_image, tmp_path: Path, caption_type
):
    """``both`` is what an editor that mistook the tag list for prose sent."""
    image_id, _path = smart_tagged_image
    extra = {"image_types": {str(image_id): caption_type}} if caption_type else {}
    caption = _default_export(
        test_client, image_id, tmp_path / f"out-{caption_type}", **extra
    )
    tokens = _tokens(caption)
    folded = [" ".join(token.replace("_", " ").lower().split()) for token in tokens]

    assert len(folded) == len(set(folded)), caption
    assert tokens.count(TRIGGER) == 1, caption
    assert "mylora walk" not in tokens, caption


def test_default_export_with_the_trigger_typed_in_the_dataset_maker_too(
    test_client, smart_tagged_image, tmp_path: Path
):
    image_id, _path = smart_tagged_image
    caption = _default_export(
        test_client, image_id, tmp_path / "out-trigger", trigger=TRIGGER
    )
    tokens = _tokens(caption)

    assert tokens[0] == TRIGGER, caption
    assert tokens.count(TRIGGER) == 1, caption
    assert "mylora walk" not in tokens, caption


def test_user_written_sentence_still_exports_after_the_tags(
    test_client, smart_tagged_image, tmp_path: Path
):
    """The fix must never drop natural language the user wrote."""
    image_id, _path = smart_tagged_image
    sentence = "She walks along a quiet country road at dusk."
    caption = _default_export(
        test_client,
        image_id,
        tmp_path / "out-nl",
        image_types={str(image_id): "both"},
        image_nl_overrides={str(image_id): sentence},
    )
    assert caption.strip().endswith(sentence), caption
    assert _tokens(caption).count(TRIGGER) == 1, caption


# ------------------------------------------------------------------ #
# Every other place that fell back from nl_caption to ai_caption
# ------------------------------------------------------------------ #


def _folded(caption: str) -> list[str]:
    parts = [p.strip() for p in caption.replace(". ", ", ").split(",") if p.strip()]
    return [" ".join(p.replace("_", " ").lower().split()) for p in parts]


def _tag_export_preview(test_client, image_id: int, **body) -> str:
    response = test_client.post(
        "/api/tags/export-preview", json={"image_ids": [image_id], **body}
    )
    assert response.status_code == 200, response.text
    return response.json()["results"][0]["rendered"]


@pytest.mark.parametrize("content_mode", ["tags_nl", "nl_caption", "prompt_nl"])
def test_natural_language_content_modes_do_not_reuse_the_tag_list(
    test_client, smart_tagged_image, content_mode
):
    image_id, _path = smart_tagged_image
    rendered = _tag_export_preview(test_client, image_id, content_mode=content_mode)
    folded = _folded(rendered)

    assert len(folded) == len(set(folded)), rendered
    if content_mode != "tags_nl":
        # No sentence exists, so a prose-only mode has nothing to write.
        assert "1girl" not in folded, rendered


def test_the_default_anima_preset_writes_each_tag_once(test_client, smart_tagged_image):
    image_id, _path = smart_tagged_image
    rendered = _tag_export_preview(test_client, image_id, preset_id="anima")
    folded = _folded(rendered)

    assert "1girl" in folded, rendered
    assert len(folded) == len(set(folded)), rendered


def test_flux_preset_does_not_put_the_tag_list_in_the_sentence(
    test_client, smart_tagged_image
):
    image_id, _path = smart_tagged_image
    rendered = _tag_export_preview(test_client, image_id, preset_id="flux")

    assert "1girl" not in _folded(rendered), rendered


def test_dataset_preview_reports_a_refused_tag_list(
    test_client, smart_tagged_image, tmp_path: Path
):
    image_id, _path = smart_tagged_image
    response = test_client.post(
        "/api/dataset/export-preview",
        json={
            "image_ids": [image_id],
            "output_folder": str(tmp_path / "advisory-out"),
            "naming_pattern": "{index:03d}",
            "content_mode": "template",
            "image_types": {str(image_id): "both"},
        },
    )
    assert response.status_code == 200, response.text
    item = response.json()["items"][0]

    assert "nl_fallback_is_tag_list" in [a["code"] for a in item["caption_advisories"]]
    folded = _folded(item["caption"])
    assert len(folded) == len(set(folded)), item["caption"]


def test_legacy_prose_ai_caption_is_still_offered_as_the_sentence(test_client, test_db):
    """Comma-heavy legacy prose must not be mistaken for the tag list."""
    import database as db

    image_id = db.add_image(
        path="/pins/nl/legacy-prose.png", filename="legacy-prose.png"
    )
    db.add_tags(
        image_id,
        [
            {"tag": "1girl", "confidence": 0.9},
            {"tag": "blonde_hair", "confidence": 0.9},
            {"tag": "blue_eyes", "confidence": 0.9},
            {"tag": "smile", "confidence": 0.9},
        ],
    )
    legacy = "A woman, blonde hair, blue eyes, smiling"
    db.update_image_caption(image_id, legacy)

    response = test_client.post(
        "/api/tags/export-preview",
        json={"image_ids": [image_id], "preset_id": "custom"},
    )
    assert response.status_code == 200, response.text
    assert response.json()["results"][0]["nl_source"] == legacy
    tags_nl = _tag_export_preview(test_client, image_id, content_mode="tags_nl")
    assert tags_nl.endswith(legacy), tags_nl
