"""Characterization pins for smart_tag_service._persist_result against a REAL
(test-fixture) database — companion to test_smart_tag_pins.py.

Existing coverage (test_smart_tag_service.py, test_export_training_guarantees.py)
pins _persist_result via a MOCKED add_tags_batch: row payload shape, trigger
row position/confidence, and the provenance kwargs. What was never pinned is
the end-to-end observable through db.add_tags_batch:

  * append vs replace merge_strategy caption semantics (the append path reads
    the prior ai_caption / nl_caption back from the DB row),
  * the trigger row's source='trigger' / category='trigger' provenance as
    stored, and its space/underscore-folded dedupe against existing rows,
  * the rating row (dict / str / None) as stored (category='rating'),
  * manual-source rows surviving a pipeline persist (replace_scope="pipeline").

All tests use the `test_db` fixture from conftest — never the real data DB.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from services.smart_tag_service import _persist_result  # noqa: E402


def _add_image(db, path: str) -> int:
    return db.add_image(
        path=path,
        filename=Path(path).name,
        generator="comfyui",
        metadata_json="{}",
    )


def _result(
    caption: str = "",
    nl_text: str = "",
    general_rows=None,
    trigger_word: str = "",
    rating=None,
):
    rows = (
        general_rows
        if general_rows is not None
        else [{"tag": "1girl", "confidence": 0.9, "category": "general"}]
    )
    return {
        "caption": caption,
        "general_tags": [row["tag"] for row in rows],
        "copyright_tags": [],
        "character_tags": [],
        "general_tag_rows": rows,
        "copyright_tag_rows": [],
        "character_tag_rows": [],
        "rating": rating,
        "nl_text": nl_text,
        "trigger_word": trigger_word,
    }


# ===========================================================================
# merge_strategy caption semantics
# ===========================================================================


def test_replace_overwrites_prior_captions(test_db):
    db = test_db
    image_id = _add_image(db, "/pins/persist/replace.png")

    _persist_result(
        image_id, _result(caption="first cap", nl_text="first nl"), "replace"
    )
    _persist_result(
        image_id, _result(caption="second cap", nl_text="second nl"), "replace"
    )

    row = db.get_images_by_ids([image_id])[image_id]
    assert row["ai_caption"] == "second cap"
    assert row["nl_caption"] == "second nl"


def test_append_glues_prior_caption_and_nl(test_db):
    """Append semantics: ai_caption joins with ', '; nl_caption joins with a
    single space."""
    db = test_db
    image_id = _add_image(db, "/pins/persist/append.png")

    _persist_result(
        image_id, _result(caption="first cap", nl_text="first nl"), "replace"
    )
    _persist_result(
        image_id, _result(caption="second cap", nl_text="second nl"), "append"
    )

    row = db.get_images_by_ids([image_id])[image_id]
    assert row["ai_caption"] == "first cap, second cap"
    assert row["nl_caption"] == "first nl second nl"


def test_append_identical_caption_not_duplicated(test_db):
    """Re-running append with the exact same caption/nl must not glue a
    duplicate onto itself (prior != caption guard)."""
    db = test_db
    image_id = _add_image(db, "/pins/persist/append-same.png")

    _persist_result(image_id, _result(caption="same cap", nl_text="same nl"), "replace")
    _persist_result(image_id, _result(caption="same cap", nl_text="same nl"), "append")

    row = db.get_images_by_ids([image_id])[image_id]
    assert row["ai_caption"] == "same cap"
    assert row["nl_caption"] == "same nl"


def test_append_without_prior_writes_caption_as_is(test_db):
    db = test_db
    image_id = _add_image(db, "/pins/persist/append-fresh.png")

    _persist_result(image_id, _result(caption="only cap", nl_text="only nl"), "append")

    row = db.get_images_by_ids([image_id])[image_id]
    assert row["ai_caption"] == "only cap"
    assert row["nl_caption"] == "only nl"


# ===========================================================================
# trigger row provenance + dedupe (P1-16) as stored
# ===========================================================================


def test_trigger_row_stored_with_trigger_provenance(test_db):
    db = test_db
    image_id = _add_image(db, "/pins/persist/trigger.png")

    _persist_result(
        image_id,
        _result(caption="trig_x, 1girl", trigger_word="trig_x"),
        "replace",
    )

    rows = {row["tag"]: row for row in db.get_image_tags(image_id)}
    assert rows["trig_x"]["source"] == "trigger"
    assert rows["trig_x"]["category"] == "trigger"
    assert rows["trig_x"]["confidence"] == 1.0
    # Ordinary tag rows carry the pipeline default_source.
    assert rows["1girl"]["source"] == "tagger"
    assert rows["1girl"]["category"] == "general"


def test_trigger_dedupe_folds_space_and_underscore_spellings(test_db):
    """An existing tag row spelled 'furina v1' suppresses the trigger row for
    trigger_word='furina_v1' — the dedupe key folds spaces to underscores."""
    db = test_db
    image_id = _add_image(db, "/pins/persist/trigger-fold.png")

    _persist_result(
        image_id,
        _result(
            caption="furina v1, 1girl",
            general_rows=[
                {"tag": "furina v1", "confidence": 0.8, "category": "general"},
                {"tag": "1girl", "confidence": 0.9, "category": "general"},
            ],
            trigger_word="furina_v1",
        ),
        "replace",
    )

    rows = db.get_image_tags(image_id)
    spellings = [r["tag"] for r in rows if r["tag"].replace(" ", "_") == "furina_v1"]
    assert spellings == ["furina v1"]  # no separate trigger-source row added
    matched = next(r for r in rows if r["tag"] == "furina v1")
    assert matched["source"] == "tagger"  # it is the tagger row, not a trigger row


# ===========================================================================
# rating row (dict / str / None) as stored
# ===========================================================================


def test_rating_dict_persists_row_with_score(test_db):
    db = test_db
    image_id = _add_image(db, "/pins/persist/rating-dict.png")

    _persist_result(
        image_id,
        _result(caption="1girl", rating={"label": "e", "score": 0.5}),
        "replace",
    )

    rows = {row["tag"]: row for row in db.get_image_tags(image_id)}
    assert rows["explicit"]["confidence"] == pytest.approx(0.5)
    assert rows["explicit"]["category"] == "rating"


def test_rating_string_persists_row_at_full_confidence(test_db):
    db = test_db
    image_id = _add_image(db, "/pins/persist/rating-str.png")

    _persist_result(
        image_id,
        _result(caption="1girl", rating="rating:questionable"),
        "replace",
    )

    rows = {row["tag"]: row for row in db.get_image_tags(image_id)}
    assert rows["questionable"]["confidence"] == 1.0
    assert rows["questionable"]["category"] == "rating"


def test_rating_none_writes_no_rating_row(test_db):
    db = test_db
    image_id = _add_image(db, "/pins/persist/rating-none.png")

    _persist_result(image_id, _result(caption="1girl", rating=None), "replace")

    categories = {row["category"] for row in db.get_image_tags(image_id)}
    assert "rating" not in categories


# ===========================================================================
# provenance: pipeline-scoped replace preserves manual rows
# ===========================================================================


def test_manual_rows_survive_pipeline_persist(test_db):
    """_persist_result writes with default_source='tagger' and
    replace_scope='pipeline': a user's manual tag survives a Smart Tag
    re-run, and an incoming duplicate of it is dropped (the manual row
    wins — its source stays 'manual')."""
    db = test_db
    image_id = _add_image(db, "/pins/persist/manual.png")
    db.add_tags(
        image_id,
        [
            {"tag": "my_manual", "confidence": 1.0, "source": "manual"},
        ],
    )

    _persist_result(
        image_id,
        _result(
            caption="1girl, my_manual",
            general_rows=[
                {"tag": "1girl", "confidence": 0.9, "category": "general"},
                {"tag": "my_manual", "confidence": 0.4, "category": "general"},
            ],
        ),
        "replace",
    )

    rows = db.get_image_tags(image_id)
    manual_rows = [r for r in rows if r["tag"] == "my_manual"]
    assert len(manual_rows) == 1
    assert manual_rows[0]["source"] == "manual"
    assert manual_rows[0]["confidence"] == 1.0  # the user's row, not the 0.4 duplicate
    tagger_row = next(r for r in rows if r["tag"] == "1girl")
    assert tagger_row["source"] == "tagger"
