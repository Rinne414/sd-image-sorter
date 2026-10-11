"""Edited captions go through the same export transforms as unedited ones.

An ``image_overrides`` entry is the caption the user edited by hand. It used to
be written verbatim, so with "underscore to space" ON the edited captions kept
``long_hair`` spellings and never received the trigger, while unedited captions
were transformed. Removing a tag with find/replace could also leave an empty
token (``a, , b``) that the export wrote out.
"""

from __future__ import annotations

import pytest

import services.dataset_export_service as des
from services.dataset_export_service import DatasetExportRequest


def _req(**kw) -> DatasetExportRequest:
    base = dict(naming_pattern="{filename}", image_op="copy", overwrite_policy="unique")
    base.update(kw)
    return DatasetExportRequest(**base)


def _render(caption: str, **request_kw) -> str:
    return des._render_dataset_sidecar(
        {"id": 5, "path": "/x.png"},
        [],
        _req(**request_kw),
        blacklist_set=set(),
        image_overrides_int={5: caption},
        image_overrides_path={},
    )


def test_edited_tag_list_gets_underscores_replaced() -> None:
    assert _render("long_hair, blue_eyes, 1girl") == "long hair, blue eyes, 1girl"


def test_edited_caption_keeps_score_prefixes() -> None:
    assert _render("score_9_up, long_hair") == "score_9_up, long hair"


def test_edited_caption_keeps_underscores_when_option_is_off() -> None:
    caption = "long_hair, blue_eyes"
    assert _render(caption, normalize_tag_underscores=False) == caption


def test_edited_sentence_is_not_rewritten() -> None:
    sentence = "A girl with long_hair walks down a quiet street, smiling at the camera."
    assert _render(sentence) == sentence


def test_edited_caption_receives_trigger_when_missing() -> None:
    assert (
        _render("long_hair, 1girl", trigger="mylora_walk")
        == "mylora_walk, long hair, 1girl"
    )


@pytest.mark.parametrize("spelling", ["mylora_walk", "mylora walk"])
def test_trigger_is_not_duplicated_in_either_spelling(spelling: str) -> None:
    out = _render(f"1girl, {spelling}, long_hair", trigger="mylora_walk")
    parts = [part.strip() for part in out.split(",")]
    assert parts.count("mylora_walk") == 1
    assert "mylora walk" not in parts
    assert len(parts) == 3


def test_edited_caption_order_blacklist_and_common_tags_stay_as_typed() -> None:
    out = _render(
        "zebra, apple, bad_tag",
        blacklist=["bad_tag"],
        common_tags=["extra_tag"],
    )
    assert out == "zebra, apple, bad tag"


def test_blank_override_stays_blank_even_with_trigger() -> None:
    assert _render("", trigger="mylora_walk") == ""


@pytest.mark.parametrize(
    ("caption", "expected"),
    [
        ("a, , b", "a, b"),
        ("a, ,, b,", "a, b"),
        ("outdoors, , 1girl, ,", "outdoors, 1girl"),
        (", ,", ""),
    ],
)
def test_empty_tokens_are_dropped_from_tag_lists(caption: str, expected: str) -> None:
    assert _render(caption, normalize_tag_underscores=False) == expected


def test_newline_separated_tag_list_keeps_its_line_breaks() -> None:
    assert _render("long_hair\n\nblue_eyes\n") == "long hair\nblue eyes"


def _export_batch_edited(test_client, test_db, tmp_path, caption: str, **options) -> str:
    from PIL import Image

    source = tmp_path / "source.png"
    Image.new("RGB", (24, 24), color=(10, 20, 30)).save(source)
    image_id = test_db.add_image(str(source), source.name)
    output_dir = tmp_path / "out"
    output_dir.mkdir()
    response = test_client.post(
        "/api/tags/export-batch",
        json={
            "image_ids": [image_id],
            "output_folder": str(output_dir),
            "output_mode": "folder",
            "content_mode": "tags",
            "overwrite_policy": "overwrite",
            "image_overrides": {str(image_id): caption},
            **options,
        },
    )
    assert response.status_code == 200, response.text
    return (output_dir / "source.txt").read_text(encoding="utf-8")


def test_legacy_export_batch_normalizes_edited_caption_when_option_on(
    test_client, test_db, tmp_path
) -> None:
    text = _export_batch_edited(
        test_client, test_db, tmp_path, "score_9, long_hair, , blue_eyes",
        normalize_tag_underscores=True,
    )
    assert text.strip() == "score_9, long hair, blue eyes"


def test_legacy_export_batch_drops_empty_tokens_but_keeps_underscores_by_default(
    test_client, test_db, tmp_path
) -> None:
    text = _export_batch_edited(test_client, test_db, tmp_path, "long_hair, , blue_eyes")
    assert text.strip() == "long_hair, blue_eyes"


@pytest.mark.parametrize("kaomoji", ["^_^", ">_<", "o_o"])
def test_edited_caption_keeps_kaomoji_underscores(kaomoji: str) -> None:
    assert _render(f"{kaomoji}, long_hair") == f"{kaomoji}, long hair"


def test_edited_caption_keeps_weights_and_escaped_parens() -> None:
    assert (
        _render(r"(long_hair:1.2), \(cosplay\)_x")
        == r"(long hair:1.2), \(cosplay\) x"
    )


def test_edited_caption_keeps_crlf_and_mixed_separators() -> None:
    assert _render("long_hair,\r\nblue_eyes, solo") == "long hair\r\nblue eyes, solo"
    assert _render("long_hair\nblue_eyes,\nsolo, smile") == "long hair\nblue eyes\nsolo, smile"


def test_edited_caption_drops_empty_token_between_comma_and_newline() -> None:
    assert _render("long_hair,\n,blue_eyes") == "long hair\nblue eyes"


@pytest.mark.parametrize(
    "caption",
    [
        "1girl, solo, MyLora_Walk, smile",
        "1girl, solo, mylora walk, smile",
        "1girl, solo, mylora_walk, smile",
    ],
)
def test_edited_caption_does_not_duplicate_trigger_mid_caption(caption: str) -> None:
    out = _render(caption, trigger="mylora_walk")
    assert out == "1girl, solo, mylora_walk, smile"


def test_edited_mixed_caption_is_left_unchanged_like_unedited_sidecars() -> None:
    """KNOWN LIMITATION, kept on purpose.

    A caption the format classifier reads as natural/mixed is returned as is:
    no underscore clean-up (the trigger is still prepended, as for prose
    everywhere else; the text itself is untouched). Unedited imported sidecars are
    treated the same way (``dataset_sidecar_caption_rows``), so edited and
    unedited captions stay consistent.
    """
    mixed = "1girl, solo, looking_at_viewer, smile, a woman is standing in a garden"
    assert _render(mixed) == mixed
    assert _render(mixed, trigger="mylora_walk") == f"mylora_walk, {mixed}"
