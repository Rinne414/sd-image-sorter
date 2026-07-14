"""Tests for the VLM tag vocabulary gate (audit P2-8).

The gate drops VLM-hallucinated non-vocabulary tags and rating words before
they are persisted, while keeping in-vocabulary tags, user-defined library
tags, and kaomoji tags that live verbatim in the bundled danbooru CSV.
"""
from __future__ import annotations

import pytest

from services import vlm_tag_gate


def test_hallucinated_tag_dropped_but_vocab_and_library_tags_kept(monkeypatch):
    # Arrange: a tiny controlled accept-set plus one user-defined library tag.
    monkeypatch.setattr(
        vlm_tag_gate,
        "_danbooru_accept_set",
        lambda: frozenset({"1girl", "long_hair"}),
    )
    monkeypatch.setattr(vlm_tag_gate, "_library_tag_set", lambda: {"my_oc_name"})
    candidates = ["1girl", "sparkly_awesome_hair_9000", "my_oc_name"]

    # Act
    accepted, dropped = vlm_tag_gate.filter_vlm_tags(candidates)

    # Assert: in-vocab tag and custom library tag survive; hallucination drops.
    assert accepted == ["1girl", "my_oc_name"]
    assert "sparkly_awesome_hair_9000" not in accepted
    assert dropped == 1


def test_rating_words_dropped_in_all_forms(monkeypatch):
    # Arrange: rating words are dropped even when present in the vocabulary.
    monkeypatch.setattr(
        vlm_tag_gate,
        "_danbooru_accept_set",
        lambda: frozenset({"1girl", "safe", "explicit", "general"}),
    )
    monkeypatch.setattr(vlm_tag_gate, "_library_tag_set", lambda: set())
    candidates = ["safe", "rating:explicit", "rating_general", "1girl"]

    # Act
    accepted, dropped = vlm_tag_gate.filter_vlm_tags(candidates)

    # Assert
    assert accepted == ["1girl"]
    assert dropped == 3


def test_kaomoji_survives_gate_against_real_vocabulary(monkeypatch):
    # Arrange: exercise the real bundled danbooru CSV (reset forces a rebuild
    # from get_vocab_tag_index); keep the library empty so only the vocabulary
    # decides. No database access — _library_tag_set is stubbed.
    vlm_tag_gate.reset_cache()
    monkeypatch.setattr(vlm_tag_gate, "_library_tag_set", lambda: set())

    # Act
    accepted, dropped = vlm_tag_gate.filter_vlm_tags(["^_^"])

    # Assert: ^_^ is a real danbooru tag (assets/danbooru_tags.csv) and the
    # normalizer must not strip its punctuation.
    assert accepted == ["^_^"]
    assert dropped == 0
    vlm_tag_gate.reset_cache()


def test_persist_tags_gates_and_reports_dropped_count(monkeypatch, test_db):
    # Arrange: a fresh image and a controlled accept-set (library stubbed empty
    # so the count is deterministic regardless of the shared tag cache).
    import database as db
    import routers.vlm as vlm_router

    image_id = db.add_image(path="/t/gate.png", filename="gate.png")
    monkeypatch.setattr(
        vlm_tag_gate, "_danbooru_accept_set", lambda: frozenset({"1girl", "solo"})
    )
    monkeypatch.setattr(vlm_tag_gate, "_library_tag_set", lambda: set())

    # Act: one rating word + one hallucination should be dropped.
    dropped = vlm_router._persist_tags(
        db, image_id, ["1girl", "solo", "explicit", "fake_hallucinated_tag_zzz"]
    )

    # Assert: only the two legal tags persist; the drop count is surfaced.
    assert dropped == 2
    stored = {row["tag"] for row in db.get_image_tags(image_id)}
    assert stored == {"1girl", "solo"}


def test_persist_tags_propagates_real_sqlite_write_failure(monkeypatch, test_db):
    import database as db
    import routers.vlm as vlm_router

    image_id = db.add_image(path="/t/gate-failure.png", filename="gate-failure.png")
    db.add_tags(
        image_id,
        [{"tag": "prior_manual", "confidence": 1.0, "source": "manual"}],
    )
    monkeypatch.setattr(
        vlm_tag_gate,
        "_danbooru_accept_set",
        lambda: frozenset({"1girl"}),
    )
    monkeypatch.setattr(vlm_tag_gate, "_library_tag_set", lambda: set())
    with db.get_db() as conn:
        conn.execute(
            f"""
            CREATE TRIGGER fail_persist_tags_insert
            BEFORE INSERT ON tags
            WHEN NEW.image_id = {int(image_id)} AND NEW.tag = '1girl'
            BEGIN
                SELECT RAISE(ABORT, 'injected _persist_tags failure');
            END
            """
        )

    with pytest.raises(
        vlm_router.VLMResultPersistenceError,
        match="injected _persist_tags failure",
    ):
        vlm_router._persist_tags(db, image_id, ["1girl"])

    assert [row["tag"] for row in db.get_image_tags(image_id)] == ["prior_manual"]


def test_persist_vlm_result_caption_only_preserves_existing_tags(test_db):
    db = test_db
    import routers.vlm as vlm_router

    image_id = db.add_image(
        path="/t/vlm-caption-only.png",
        filename="vlm-caption-only.png",
    )
    db.add_tags(
        image_id,
        [{"tag": "prior_manual", "confidence": 0.0, "source": "manual"}],
    )
    db.update_image_caption(
        image_id,
        "prior caption",
        nl_caption="prior natural language",
    )

    dropped = vlm_router._persist_vlm_result(
        db,
        image_id,
        "new natural-language caption",
        [],
    )

    row = db.get_image_by_id(image_id)
    assert dropped == 0
    assert row["ai_caption"] == "new natural-language caption"
    assert row["nl_caption"] == "new natural-language caption"
    stored_tags = db.get_image_tags(image_id)
    assert [tag["tag"] for tag in stored_tags] == ["prior_manual"]
    assert stored_tags[0]["confidence"] == 0.0


def test_persist_vlm_result_tags_only_preserves_existing_captions(
    monkeypatch,
    test_db,
):
    db = test_db
    import routers.vlm as vlm_router

    image_id = db.add_image(
        path="/t/vlm-tags-only.png",
        filename="vlm-tags-only.png",
    )
    db.add_tags(
        image_id,
        [{"tag": "prior_manual", "confidence": 1.0, "source": "manual"}],
    )
    db.update_image_caption(
        image_id,
        "prior caption",
        nl_caption="prior natural language",
    )
    monkeypatch.setattr(
        vlm_tag_gate,
        "_danbooru_accept_set",
        lambda: frozenset({"1girl"}),
    )
    monkeypatch.setattr(vlm_tag_gate, "_library_tag_set", lambda: set())

    dropped = vlm_router._persist_vlm_result(db, image_id, "", ["1girl"])

    row = db.get_image_by_id(image_id)
    assert dropped == 0
    assert row["ai_caption"] == "prior caption"
    assert row["nl_caption"] == "prior natural language"
    assert {tag["tag"] for tag in db.get_image_tags(image_id)} == {
        "prior_manual",
        "1girl",
    }


def test_persist_vlm_result_updates_caption_when_all_tags_already_exist(
    monkeypatch,
    test_db,
):
    db = test_db
    import routers.vlm as vlm_router

    image_id = db.add_image(
        path="/t/vlm-existing-tags.png",
        filename="vlm-existing-tags.png",
    )
    db.add_tags(
        image_id,
        [{"tag": "1girl", "confidence": 0.85, "source": "vlm"}],
    )
    db.update_image_caption(
        image_id,
        "prior caption",
        nl_caption="prior natural language",
    )
    monkeypatch.setattr(
        vlm_tag_gate,
        "_danbooru_accept_set",
        lambda: frozenset({"1girl"}),
    )
    monkeypatch.setattr(vlm_tag_gate, "_library_tag_set", lambda: set())

    vlm_router._persist_vlm_result(
        db,
        image_id,
        "replacement caption",
        ["1girl"],
    )

    row = db.get_image_by_id(image_id)
    assert row["ai_caption"] == "replacement caption"
    assert row["nl_caption"] == "replacement caption"
    assert [tag["tag"] for tag in db.get_image_tags(image_id)] == ["1girl"]


def test_persist_vlm_result_wraps_tag_gate_failure_with_image_id(
    monkeypatch,
    test_db,
):
    db = test_db
    import routers.vlm as vlm_router

    image_id = db.add_image(
        path="/t/vlm-gate-failure.png",
        filename="vlm-gate-failure.png",
    )

    def raise_gate_error(_tags):
        raise OSError("vocabulary cache unavailable")

    monkeypatch.setattr(vlm_tag_gate, "filter_vlm_tags", raise_gate_error)

    with pytest.raises(
        vlm_router.VLMResultPersistenceError,
        match=rf"image_id={image_id}: vocabulary cache unavailable",
    ):
        vlm_router._persist_vlm_result(db, image_id, "caption", ["1girl"])
