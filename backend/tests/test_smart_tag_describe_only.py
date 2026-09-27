"""A Smart Tag run with the booru tagger off only describes (D53).

It used to write its empty tag list through the tagging write path, which
replaced every tagger/VLM/trigger tag row of a Library image with nothing,
cleared the WD14 writer provenance, stamped ``tagged_at`` and overwrote the
composed ``ai_caption`` with the prose. A describe-only run now writes the
description alone; everything the last tagging run left stays as it was.

The description must reach the places that show it: the V4 generation card
and V3.5's preview read ``nl_caption`` from the image detail, and a dataset
batch's words box renders content mode ``nl_caption``.

All tests use the ``test_db`` fixture from conftest, never the real data DB.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from services.smart_tag.caption_phase import _handle_caption_result  # noqa: E402
from services.smart_tag.jobs import SmartTagJobState  # noqa: E402
from services.smart_tag.request import SmartTagRequest  # noqa: E402
from services.smart_tag.results import _booru_partial_from_tag_result  # noqa: E402
from services.tag_export.captions import build_sidecar_content  # noqa: E402

MODEL = "wd-swinv2-tagger-v3"
SENTENCE = "A girl with silver hair smiles at the viewer."


def _add_image(db, name: str) -> int:
    return db.add_image(
        path=f"/pins/describe-only/{name}",
        filename=name,
        generator="comfyui",
        metadata_json="{}",
    )


def _tag(db, image_id: int) -> None:
    """What a tagging run leaves: tagger rows, their scores and a tag caption."""
    db.add_tags_batch(
        [
            {
                "image_id": image_id,
                "tags": [
                    {"tag": "1girl", "confidence": 0.97, "category": "general"},
                    {"tag": "smile", "confidence": 0.71, "category": "general"},
                ],
                "ai_caption": "1girl, smile",
                "tag_scores": {
                    "model": MODEL,
                    "scores": [
                        {"tag": "1girl", "score": 0.97, "category": "general"},
                        {"tag": "smile", "score": 0.71, "category": "general"},
                    ],
                },
            }
        ],
        default_source="tagger",
        replace_scope="pipeline",
    )


def _describe(
    image_id: int, text: str, merge: str = "replace", *, tagger: bool = False
) -> SmartTagJobState:
    """One image through the caption phase, as the pipeline hands it over."""
    req = SmartTagRequest(
        image_ids=[image_id],
        enable_wd14=tagger,
        enable_vlm=True,
        natural_language_mode="florence2",
        merge_strategy=merge,
        skip_existing=False,
    )
    job = SmartTagJobState(job_id=f"describe-only-{image_id}", total=1)
    partial = _booru_partial_from_tag_result({}, req)
    _handle_caption_result(
        job, req, str(image_id), image_id, "", partial, text, nl_active=True
    )
    return job


def _tags(db, image_id: int):
    return sorted((row["tag"], row["source"]) for row in db.get_image_tags(image_id))


def _row(db, image_id: int):
    return db.get_images_by_ids([image_id])[image_id]


def test_describe_only_keeps_the_ai_tags_scores_and_tag_caption(test_db):
    db = test_db
    image_id = _add_image(db, "tagged.png")
    _tag(db, image_id)
    before = _row(db, image_id)

    job = _describe(image_id, SENTENCE)

    assert job.succeeded == 1 and job.failed == 0
    assert _tags(db, image_id) == [("1girl", "tagger"), ("smile", "tagger")]
    assert [
        s["tag"] for s in db.get_scores_for_images([image_id], MODEL)[image_id]
    ] == ["1girl", "smile"]
    after = _row(db, image_id)
    assert after["nl_caption"] == SENTENCE
    assert after["ai_caption"] == "1girl, smile"
    assert after["tagged_at"] == before["tagged_at"]


def test_describe_only_keeps_the_wd14_writer_provenance(test_db):
    from tag_writer_provenance import TagWriterProvenance

    db = test_db
    image_id = _add_image(db, "provenance.png")
    provenance = TagWriterProvenance(
        writer_family="wd14",
        provider="huggingface",
        model=f"SmilingWolf/{MODEL}",
        revision=f"sha256:{'a' * 64}",
        runtime_provider="CPUExecutionProvider",
    )
    db.add_tags_batch(
        [
            {
                "image_id": image_id,
                "tags": [{"tag": "1girl", "confidence": 0.9}],
                "content_fingerprint": "c" * 64,
                "writer_provenance": provenance.model_dump(mode="python"),
            }
        ],
        default_source="tagger",
        replace_scope="pipeline",
    )

    _describe(image_id, SENTENCE)

    assert set(db.get_tag_writer_provenance_map([image_id])) == {image_id}


def test_describe_only_append_adds_to_the_old_description(test_db):
    db = test_db
    image_id = _add_image(db, "append.png")
    _tag(db, image_id)
    _describe(image_id, "Old words.")

    _describe(image_id, "New words.", "append")
    _describe(image_id, "New words.", "append")

    assert _row(db, image_id)["nl_caption"] == "Old words. New words. New words."
    _describe(image_id, "Only these.", "replace")
    assert _row(db, image_id)["nl_caption"] == "Only these."
    assert _tags(db, image_id) == [("1girl", "tagger"), ("smile", "tagger")]


def test_describe_only_on_an_untagged_image_leaves_it_untagged(test_db):
    db = test_db
    image_id = _add_image(db, "untagged.png")
    assert image_id in db.get_untagged_image_ids()

    _describe(image_id, SENTENCE)

    row = _row(db, image_id)
    assert row["nl_caption"] == SENTENCE
    assert row["tagged_at"] is None
    assert row["ai_caption"] is None
    assert image_id in db.get_untagged_image_ids()
    assert db.get_image_ids_already_tagged([image_id]) == set()
    assert _tags(db, image_id) == []


def test_describe_only_with_no_words_changes_nothing(test_db):
    db = test_db
    image_id = _add_image(db, "empty.png")
    _tag(db, image_id)
    _describe(image_id, "Kept words.")

    _describe(image_id, "   ")

    assert _row(db, image_id)["nl_caption"] == "Kept words."
    assert _tags(db, image_id) == [("1girl", "tagger"), ("smile", "tagger")]


def test_describe_only_on_a_missing_image_counts_as_failed(test_db):
    job = _describe(987654, SENTENCE)

    assert job.failed == 1 and job.succeeded == 0


def test_the_description_reaches_the_card_the_preview_and_the_batch_words(test_db):
    """V4's card shows nl_caption (else ai_caption); V3.5's preview shows
    nl_caption beside ai_caption when they differ; a dataset batch's words box
    renders content mode nl_caption from the same row."""
    db = test_db
    image_id = _add_image(db, "readers.png")
    _tag(db, image_id)

    _describe(image_id, SENTENCE)

    detail = db.get_image_by_id(image_id)
    assert detail["nl_caption"] == SENTENCE
    assert detail["ai_caption"] == "1girl, smile"
    words = build_sidecar_content(
        detail, db.get_image_tags(image_id), content_mode="nl_caption"
    )
    assert words == SENTENCE
    tags = build_sidecar_content(
        detail, db.get_image_tags(image_id), content_mode="tags"
    )
    assert tags == "1girl, smile"


def test_a_run_with_the_tagger_on_still_replaces_the_tags(test_db):
    """Unchanged: tagging again replaces the pipeline rows with the new ones."""
    db = test_db
    image_id = _add_image(db, "retag.png")
    _tag(db, image_id)
    req = SmartTagRequest(
        image_ids=[image_id],
        enable_wd14=True,
        enable_vlm=True,
        natural_language_mode="florence2",
    )
    partial = _booru_partial_from_tag_result(
        {"general_tags": [{"tag": "outdoors", "confidence": 0.8}]},
        req,
        score_model=MODEL,
    )
    job = SmartTagJobState(job_id="retag", total=1)

    _handle_caption_result(
        job, req, str(image_id), image_id, "", partial, SENTENCE, nl_active=True
    )

    assert _tags(db, image_id) == [("outdoors", "tagger")]
    assert _row(db, image_id)["nl_caption"] == SENTENCE


@pytest.mark.parametrize("merge", ["replace", "append"])
def test_describe_only_never_touches_the_tag_rows_of_a_hand_tagged_image(
    test_db, merge
):
    db = test_db
    image_id = _add_image(db, f"manual-{merge}.png")
    db.add_tags_batch(
        [{"image_id": image_id, "tags": [{"tag": "my_tag", "confidence": 1.0}]}],
        default_source="manual",
        replace_scope="all",
    )

    _describe(image_id, SENTENCE, merge)

    assert _tags(db, image_id) == [("my_tag", "manual")]
