"""Chinese words typed into the Gallery search are read as tags, as whole names only."""

from __future__ import annotations

import pytest

from services import tag_suggest_service, tag_word_lookup


@pytest.fixture
def names(monkeypatch):
    """A small name table: (names, tag, danbooru count, category code), most common first."""
    rows = [
        ("头箍,发箍,猫耳头箍", "hairband", 473325, 0),
        ("猫耳,ねこみみ", "cat_ears", 280730, 0),
        ("猫耳", "animal_ears", 1000, 0),
        ("猫娘,猫女", "cat_girl", 89638, 0),
    ]
    monkeypatch.setattr(tag_suggest_service, "_ensure_loaded", lambda: None)
    monkeypatch.setattr(tag_suggest_service, "_ZH_BLOBS", rows)


def test_a_word_is_matched_as_a_whole_name_never_as_a_part(names, monkeypatch):
    monkeypatch.setattr(tag_word_lookup, "_library_counts", lambda tags: {})

    found = tag_word_lookup.lookup(["猫耳", "猫", "ねこみみ", "狗"])

    # 猫耳头箍 contains 猫耳 but is another name; 猫 is only a part of names.
    assert found == {
        "猫耳": {"tag": "cat_ears", "pictures": 0},
        "ねこみみ": {"tag": "cat_ears", "pictures": 0},
    }


def test_the_tag_the_library_has_wins_over_the_more_common_one(names, monkeypatch):
    monkeypatch.setattr(
        tag_word_lookup, "_library_counts", lambda tags: {"animal_ears": 12}
    )

    assert tag_word_lookup.lookup(["猫耳"]) == {
        "猫耳": {"tag": "animal_ears", "pictures": 12}
    }


def test_library_counts_see_both_spellings_of_a_tag(test_db, tmp_path):
    from PIL import Image

    ids = []
    for n in range(3):
        path = tmp_path / f"{n}.png"
        Image.new("RGB", (8, 8)).save(path)
        ids.append(
            test_db.add_image(path=str(path), filename=path.name, metadata_json="{}")
        )
    test_db.add_tags(ids[0], [{"tag": "cat_ears", "confidence": 1.0}])
    test_db.add_tags(ids[1], [{"tag": "cat ears", "confidence": 1.0}])
    test_db.add_tags(ids[2], [{"tag": "long_hair", "confidence": 1.0}])

    counts = tag_word_lookup._library_counts(["cat_ears", "red_eyes"])

    assert counts == {"cat_ears": 2}


def test_the_endpoint_answers_for_the_real_table(test_client):
    body = test_client.get(
        "/api/tags/words", params=[("q", "猫耳"), ("q", "这不是标签名")]
    ).json()

    assert body["words"]["猫耳"]["tag"] == "cat_ears"
    assert "这不是标签名" not in body["words"]
