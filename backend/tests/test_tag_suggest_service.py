"""Tests for the unified tag suggestion service (GET /api/tags/suggest)."""

from pathlib import Path

import pytest

from services import tag_suggest_service


DANBOORU_FIXTURE = """1girl,0,6008644,"1girls,sole_female"
solo,0,5000954,"female_solo"
long_hair,0,4350743,"/lh,longhair"
breasts,0,3439214,"/b,boobs,breast,oppai,tits"
hatsune_miku,4,120000,"miku"
kantai_collection,3,90000,""
wlop,1,50000,""
highres,5,5256195,"high_res"
"""

ZH_FIXTURE = """name,cn_name,wiki,post_count,category,nsfw
long_hair,"长发,长头发,发型",desc,4350743,0,0
breasts,"乳房,胸部",desc,3439214,0,1
"""


@pytest.fixture
def suggest_env(test_db, tmp_path: Path, monkeypatch):
    """Isolated vocab paths + a seeded library; yields helpers to write files."""
    danbooru_path = tmp_path / "danbooru_tags.csv"
    zh_path = tmp_path / "danbooru_zh.csv"
    monkeypatch.setattr(tag_suggest_service, "_danbooru_csv_path", lambda: danbooru_path)
    monkeypatch.setattr(tag_suggest_service, "_zh_csv_paths", lambda: [zh_path])
    tag_suggest_service.reset_cache()

    conn = test_db.get_connection()
    try:
        conn.executemany(
            "INSERT INTO images (id, path, filename) VALUES (?, ?, ?)",
            [(i, f"C:/t/img{i}.png", f"img{i}.png") for i in (1, 2, 3)],
        )
        rows = [
            (1, "long_hair"), (2, "long_hair"), (3, "long_hair"),
            (1, "smile"), (2, "smile"),
            (1, "my_custom_tag"),
        ]
        conn.executemany(
            "INSERT INTO tags (image_id, tag) VALUES (?, ?)", rows
        )
        conn.commit()
    finally:
        conn.close()

    yield {"danbooru": danbooru_path, "zh": zh_path}
    tag_suggest_service.reset_cache()


def _tags(result):
    return [s["tag"] for s in result["suggestions"]]


def test_library_only_when_vocab_missing(suggest_env):
    result = tag_suggest_service.suggest(q="long")
    assert result["danbooru_loaded"] is False
    assert result["zh_loaded"] is False
    assert _tags(result) == ["long_hair"]
    hit = result["suggestions"][0]
    assert hit["source"] == "library"
    assert hit["count"] == 3
    assert hit["category"] == "body"


def test_empty_query_returns_library_top(suggest_env):
    result = tag_suggest_service.suggest(q="")
    tags = _tags(result)
    assert tags[0] == "long_hair"  # count 3 beats count 2
    assert "smile" in tags and "my_custom_tag" in tags


def test_danbooru_merge_and_ranking(suggest_env):
    suggest_env["danbooru"].write_text(DANBOORU_FIXTURE, encoding="utf-8")
    tag_suggest_service.reset_cache()

    result = tag_suggest_service.suggest(q="long")
    assert result["danbooru_loaded"] is True
    tags = _tags(result)
    # Library prefix hit outranks danbooru; no duplicate long_hair entry.
    assert tags[0] == "long_hair"
    assert tags.count("long_hair") == 1
    lib_hit = result["suggestions"][0]
    assert lib_hit["source"] == "library"
    assert lib_hit["count"] == 3


def test_alias_matching_suggests_canonical_tag(suggest_env):
    suggest_env["danbooru"].write_text(DANBOORU_FIXTURE, encoding="utf-8")
    tag_suggest_service.reset_cache()

    result = tag_suggest_service.suggest(q="boobs")
    assert "breasts" in _tags(result)


def test_exact_match_ranks_first(suggest_env):
    suggest_env["danbooru"].write_text(DANBOORU_FIXTURE, encoding="utf-8")
    tag_suggest_service.reset_cache()

    result = tag_suggest_service.suggest(q="1girl")
    assert _tags(result)[0] == "1girl"
    assert result["suggestions"][0]["source"] == "danbooru"


def test_danbooru_category_codes_map_to_app_categories(suggest_env):
    suggest_env["danbooru"].write_text(DANBOORU_FIXTURE, encoding="utf-8")
    tag_suggest_service.reset_cache()

    by_tag = {
        s["tag"]: s for s in tag_suggest_service.suggest(q="hatsune")["suggestions"]
    }
    assert by_tag["hatsune_miku"]["category"] == "character"
    by_tag = {
        s["tag"]: s for s in tag_suggest_service.suggest(q="wlop")["suggestions"]
    }
    assert by_tag["wlop"]["category"] == "artist"
    by_tag = {
        s["tag"]: s for s in tag_suggest_service.suggest(q="highres")["suggestions"]
    }
    assert by_tag["highres"]["category"] == "meta"


def test_cjk_query_matches_zh_aliases(suggest_env):
    suggest_env["danbooru"].write_text(DANBOORU_FIXTURE, encoding="utf-8")
    suggest_env["zh"].write_text(ZH_FIXTURE, encoding="utf-8")
    tag_suggest_service.reset_cache()

    result = tag_suggest_service.suggest(q="长发")
    assert result["zh_loaded"] is True
    assert "long_hair" in _tags(result)
    hit = next(s for s in result["suggestions"] if s["tag"] == "long_hair")
    assert hit["zh"] == "长发"

    result = tag_suggest_service.suggest(q="胸部")
    assert "breasts" in _tags(result)


def test_zh_display_attached_to_ascii_queries_too(suggest_env):
    suggest_env["danbooru"].write_text(DANBOORU_FIXTURE, encoding="utf-8")
    suggest_env["zh"].write_text(ZH_FIXTURE, encoding="utf-8")
    tag_suggest_service.reset_cache()

    result = tag_suggest_service.suggest(q="breasts")
    hit = next(s for s in result["suggestions"] if s["tag"] == "breasts")
    assert hit["zh"] == "乳房"


def test_like_wildcards_are_escaped(suggest_env):
    result = tag_suggest_service.suggest(q="100%_")
    assert result["suggestions"] == []


def test_limit_is_clamped(suggest_env):
    suggest_env["danbooru"].write_text(DANBOORU_FIXTURE, encoding="utf-8")
    tag_suggest_service.reset_cache()

    result = tag_suggest_service.suggest(q="s", limit=999)
    assert len(result["suggestions"]) <= tag_suggest_service.MAX_LIMIT


def test_spaces_normalize_to_underscores(suggest_env):
    result = tag_suggest_service.suggest(q="long hair")
    assert "long_hair" in _tags(result)
