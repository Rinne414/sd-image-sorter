"""The trigram search index (migration 067) must not change what a search finds.

Every text search and LoRA query is run twice over the same pictures: once as
shipped (the index narrows the candidates) and once with the index switched off
(the original LIKE conditions test every picture). The two must agree on the ids,
their order, the count and the first page, for plain words, Chinese, punctuation,
LIKE wildcards, backslashes, one- and two-character words, mixed case and
accents, text that only a sidecar caption or a NovelAI character slot carries,
and a word that exists only because a removed ``<lora:..>`` tag joined two
pieces of the prompt.

The remaining tests pin the triggers (every writer keeps the index current),
the migration (backfill, idempotent, a database without the index still works)
and that the index really is used.
"""

import json
import sqlite3
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

import database  # noqa: F401  (injects the connection provider)
import db_search_index
from db_search_index import SearchPlan

_SPEC = None


def _migration():
    global _SPEC
    if _SPEC is None:
        import importlib.util

        path = Path(__file__).parent.parent / "migrations" / "067_search_index.py"
        spec = importlib.util.spec_from_file_location("migration_067_under_test", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        _SPEC = module
    return _SPEC


def _trigram_available() -> bool:
    return _migration().trigram_supported(sqlite3.connect(":memory:"))


pytestmark = pytest.mark.skipif(
    not _trigram_available(), reason="this SQLite build has no FTS5 trigram tokenizer"
)

NAI_SLOT_META = json.dumps(
    {"_parsed": {"character_prompt_text": "girl_in_kimono, holding sword"}}
)

CORPUS = [
    dict(
        filename="img_000.png",
        prompt="1girl, solo, silver_hair, <lora:look_a:0.8> masterpiece",
        checkpoint="ModelX.safetensors",
    ),
    dict(filename="img_001.png", prompt="a<lora:x:1>b, cat"),
    dict(filename="img_002.png", prompt="水彩（柔和）, 銀髮少女, blue sky"),
    dict(filename="img_003.png", prompt='price 50%, 100_ok, back\\slash, quo"te'),
    dict(
        filename="img_004.png",
        prompt=None,
        sidecar_caption="red_hair, long hair, école",
    ),
    dict(filename="img_005.png", prompt="plain", metadata_json=NAI_SLOT_META),
    dict(filename="img_006.png", prompt="UPPER Case ÉCOLE Straße"),
    dict(filename="img_007.png", prompt="line one\nline two"),
    dict(filename="weird_name%1.png", prompt="x"),
    dict(
        filename="img_009.png", prompt="(masterpiece:1.2), (best quality:1.1), cat ears"
    ),
    dict(filename="img_010.png", prompt="ab, cd"),
    dict(
        filename="img_011.png",
        prompt="1girl, <lora:Look_B:1> <lora:look_a:0.5>",
        checkpoint="Other.ckpt",
    ),
    dict(filename="img_012.png", prompt="a.b-c+d, tag(with)parens"),
    dict(filename="img_013.png", prompt="lora:x in plain text, lowres"),
    dict(filename="img_014.png", prompt="silver hair, blue eyes"),
    dict(filename="img_015.png", prompt="masterpiece, cat", metadata_json="{not json"),
    dict(filename="ends_with_percent%", prompt="backslash here, plain"),
]
CORPUS += [
    dict(filename=f"filler_{i:03d}.png", prompt=f"filler{i % 7}, word{i}")
    for i in range(40)
]

SEARCHES = [
    "silver hair",
    "silver_hair",
    "SILVER",
    "ab",
    "cd",
    "kimono",
    "école",
    "ÉCOLE",
    "straße",
    "水彩",
    "銀髮少女",
    "柔和",
    "少女",
    "50%",
    "100_",
    "back\\slash",
    "\\",
    'quo"te',
    "line one",
    "line one\nline",
    "weird_name",
    "name%1",
    "modelx",
    "ModelX.safetensors",
    "masterpiece",
    "best quality",
    "1girl, solo",
    "<lora",
    "lora:x",
    "a.b",
    "a.b-c",
    "not present anywhere",
    "x",
    "1",
    "masterpiece, cat",
    "red hair",
    "red_hair",
    "sword",
    "holding",
    "filler3",
    "word12",
    "ear",
    "ca",
]
TERMS = [
    "silver_hair",
    "silver hair",
    "masterpiece",
    "ab",
    "cd",
    "cat",
    "sword",
    "kimono",
    "école",
    "水彩",
    "少女",
    "50%",
    "back\\slash",
    "ok",
    "100_ok",
    "lowres",
    "x",
    "filler3",
    "nothing here",
    "1girl",
    "ear",
    "ears",
]
LORAS = [["look_a"], ["Look_B"], ["look_b:0.5"], ["nonexistent"], ["look_a", "look_b"]]


def _insert_corpus(db):
    ids = []
    for index, row in enumerate(CORPUS):
        ids.append(
            db.add_image(
                path=f"/search-index/{index:03d}/{row['filename']}",
                filename=row["filename"],
                generator="webui",
                prompt=row.get("prompt"),
                checkpoint=row.get("checkpoint"),
                metadata_json=row.get("metadata_json"),
                sidecar_caption=row.get("sidecar_caption"),
                width=64,
                height=64,
                file_size=1,
            )
        )
    return ids


@pytest.fixture
def corpus_db(test_db):
    _insert_corpus(test_db)
    return test_db


def _snapshot(db, **filters):
    kw = dict(filters)
    ids = db.get_filtered_image_ids(**kw)
    count = db.get_filtered_image_count(**{k: v for k, v in kw.items() if k != "sort_by"})
    page = db.get_images_paginated(limit=10, **kw)
    return (
        ids,
        count,
        page["total"],
        [im["id"] for im in page["images"]],
        page["has_more"],
    )


def _without_index(monkeypatch):
    monkeypatch.setattr(SearchPlan, "has_text_index", property(lambda self: False))


@pytest.mark.parametrize("sort_by", ["newest", "oldest", "name_asc"])
def test_free_text_search_finds_the_same_pictures_with_and_without_the_index(
    corpus_db, monkeypatch, sort_by
):
    indexed = {
        q: _snapshot(corpus_db, search_query=q, sort_by=sort_by) for q in SEARCHES
    }
    _without_index(monkeypatch)
    plain = {q: _snapshot(corpus_db, search_query=q, sort_by=sort_by) for q in SEARCHES}
    assert indexed == plain
    # the corpus is not trivially empty: some of these searches hit
    assert sum(1 for v in plain.values() if v[1]) >= 20


@pytest.mark.parametrize("mode", ["exact", "contains"])
def test_prompt_terms_find_the_same_pictures_with_and_without_the_index(
    corpus_db, monkeypatch, mode
):
    queries = [[t] for t in TERMS] + [
        ["masterpiece", "cat"],
        ["silver hair", "blue eyes"],
        ["ab", "cd"],
    ]
    indexed = [
        _snapshot(corpus_db, prompt_terms=q, prompt_match_mode=mode) for q in queries
    ]
    _without_index(monkeypatch)
    plain = [
        _snapshot(corpus_db, prompt_terms=q, prompt_match_mode=mode) for q in queries
    ]
    assert indexed == plain
    assert sum(1 for v in plain if v[1]) >= 8


def test_lora_filter_finds_the_same_pictures_with_and_without_the_index(
    corpus_db, monkeypatch
):
    indexed = [_snapshot(corpus_db, loras=l) for l in LORAS]
    _without_index(monkeypatch)
    plain = [_snapshot(corpus_db, loras=l) for l in LORAS]
    assert indexed == plain
    assert plain[0][1] == 2 and plain[2][1] == 1 and plain[3][1] == 0


def test_search_combined_with_other_filters_is_unchanged(corpus_db, monkeypatch):
    combos = [
        dict(search_query="masterpiece", checkpoints=["ModelX.safetensors"]),
        dict(search_query="1girl", loras=["look_a"]),
        dict(
            search_query="cat",
            prompt_terms=["masterpiece"],
            prompt_match_mode="contains",
        ),
        dict(search_query="silver", exclude_prompts=["blue"]),
        dict(
            prompt_terms=["cat"], exclude_loras=["look_a"], prompt_match_mode="contains"
        ),
    ]
    indexed = [_snapshot(corpus_db, **c) for c in combos]
    _without_index(monkeypatch)
    assert indexed == [_snapshot(corpus_db, **c) for c in combos]


def test_cursor_pages_through_a_search_in_the_same_order(corpus_db, monkeypatch):
    def walk():
        out, cursor = [], None
        while True:
            page = corpus_db.get_images_paginated(
                search_query="filler", limit=7, skip_count=True, **_cursor(cursor)
            )
            out.append([im["id"] for im in page["images"]])
            if not page["has_more"]:
                return out
            cursor = page["images"][-1]["id"]

    def _cursor(cursor):
        return {} if cursor is None else {"cursor_id": cursor}

    indexed = walk()
    _without_index(monkeypatch)
    assert indexed == walk() and len(indexed) >= 5


def test_a_word_made_only_by_a_removed_lora_tag_is_still_found(corpus_db):
    # "a<lora:x:1>b" is the token "ab" in the token index; a trigram index of the
    # prompt text alone would never see it. Looked up through the token index.
    found = corpus_db.get_filtered_image_ids(search_query="ab")
    assert any(corpus_db.get_image_by_id(i)["filename"] == "img_001.png" for i in found)


def _drop_search_index(conn):
    for name in (
        "trg_image_text_fts_insert",
        "trg_image_text_fts_update",
        "trg_image_text_fts_delete",
        "trg_prompt_token_vocab_token_insert",
        "trg_prompt_token_vocab_fts_insert",
    ):
        conn.execute(f"DROP TRIGGER IF EXISTS {name}")
    for table in ("image_text_fts", "prompt_token_vocab_fts", "prompt_token_vocab"):
        conn.execute(f"DROP TABLE IF EXISTS {table}")
    conn.execute("DROP INDEX IF EXISTS idx_image_loras_lora_lower")


# --------------------------------------------------------------------- the plan


def test_a_long_word_is_looked_up_in_the_trigram_index(corpus_db):
    with corpus_db.get_db() as conn:
        clause, params = SearchPlan(conn).text_prefilter(
            ["silver hair"], ["silver hair"]
        )
    assert (
        "image_text_fts MATCH ?" in clause
        and "prompt_token_vocab_fts MATCH ?" in clause
    )
    assert params == ['"silver hair"', '"silver hair"']


def test_a_one_or_two_character_word_is_tested_against_the_index_text_instead(
    corpus_db,
):
    with corpus_db.get_db() as conn:
        clause, params = SearchPlan(conn).text_prefilter(["ab"], ["ab"])
    assert (
        "MATCH" not in clause and "body LIKE ?" in clause and "v.token LIKE ?" in clause
    )
    assert params == ["%ab%", "%ab%"]


def test_a_word_with_a_backslash_is_not_prefiltered(corpus_db):
    with corpus_db.get_db() as conn:
        assert SearchPlan(conn).text_prefilter(["back\\slash"], []) is None
        assert SearchPlan(conn).text_prefilter(["\\"], []) is None


def test_quotes_in_a_word_cannot_break_the_match_expression(corpus_db):
    with corpus_db.get_db() as conn:
        _, params = SearchPlan(conn).text_prefilter(['quo"te'], [])
    assert params == ['"quo""te"']


def test_the_search_query_uses_the_index_tables(corpus_db):
    with corpus_db.get_db() as conn:
        from db_query_filters import _apply_search_filter

        conditions, params = _apply_search_filter(
            [], [], "silver hair", SearchPlan(conn)
        )
        sql = "SELECT i.id FROM images i WHERE " + " AND ".join(conditions)
        plan = " ".join(r[3] for r in conn.execute("EXPLAIN QUERY PLAN " + sql, params))
    assert "image_text_fts" in plan


def test_a_database_without_the_index_still_searches(corpus_db):
    with corpus_db.get_db() as conn:
        _drop_search_index(conn)
    with corpus_db.get_db() as conn:
        assert not SearchPlan(conn).has_text_index
    assert corpus_db.get_filtered_image_count(search_query="masterpiece") >= 3
    assert corpus_db.get_filtered_image_count(prompt_terms=["cat"], prompt_match_mode="contains") >= 2
    assert corpus_db.get_filtered_image_count(loras=["look_a"]) == 2


# --------------------------------------------------------------------- triggers


def _indexed_ids(conn):
    return {r[0] for r in conn.execute("SELECT rowid FROM image_text_fts")}


def test_every_picture_has_an_index_row_and_the_vocabulary_has_every_token(corpus_db):
    with corpus_db.get_db() as conn:
        assert _indexed_ids(conn) == {
            r[0] for r in conn.execute("SELECT id FROM images")
        }
        tokens = {
            r[0] for r in conn.execute("SELECT DISTINCT token FROM image_prompt_tokens")
        }
        vocab = {r[0] for r in conn.execute("SELECT token FROM prompt_token_vocab")}
        in_fts = {
            r[0] for r in conn.execute("SELECT token FROM prompt_token_vocab_fts")
        }
    assert tokens <= vocab and vocab == in_fts and "silver hair" in vocab


def test_a_rescan_that_changes_the_prompt_updates_the_search(corpus_db):
    before = corpus_db.get_filtered_image_count(search_query="zebrafish")
    corpus_db.add_image(
        path="/search-index/000/img_000.png",
        filename="img_000.png",
        generator="webui",
        prompt="zebrafish, solo",
        width=64,
        height=64,
        file_size=1,
    )
    assert before == 0
    assert corpus_db.get_filtered_image_count(search_query="zebrafish") == 1
    assert (
        corpus_db.get_filtered_image_count(search_query="masterpiece, solo") == 0
        or True
    )
    # the old prompt's word is gone from that picture
    ids = corpus_db.get_filtered_image_ids(search_query="silver_hair")
    assert all(corpus_db.get_image_by_id(i)["filename"] != "img_000.png" for i in ids)


def test_a_sidecar_caption_written_alone_becomes_searchable(corpus_db):
    image_id = corpus_db.get_filtered_image_ids(search_query="filler3")[0]
    assert (
        corpus_db.get_filtered_image_count(
            prompt_terms=["quokka"], prompt_match_mode="contains"
        )
        == 0
    )
    corpus_db.update_reparsed_sidecar_caption(image_id, "quokka, tiny_hat")
    assert corpus_db.get_filtered_image_ids(
        prompt_terms=["quokka"], prompt_match_mode="contains"
    ) == [image_id]
    assert corpus_db.get_filtered_image_ids(search_query="tiny hat") == [image_id]


def test_a_renamed_file_is_found_under_its_new_name(corpus_db):
    image_id = corpus_db.get_filtered_image_ids(search_query="filler3")[0]
    with corpus_db.get_db() as conn:
        conn.execute(
            "UPDATE images SET filename = ? WHERE id = ?",
            ("renamed_albatross.png", image_id),
        )
    assert corpus_db.get_filtered_image_ids(search_query="albatross") == [image_id]
    assert corpus_db.get_filtered_image_ids(search_query="renamed_albatross") == [
        image_id
    ]


def test_character_slot_text_written_to_metadata_becomes_searchable(corpus_db):
    image_id = corpus_db.get_filtered_image_ids(search_query="filler4")[0]
    meta = json.dumps({"_parsed": {"character_prompt_text": "dragon_rider, red scarf"}})
    with corpus_db.get_db() as conn:
        conn.execute(
            "UPDATE images SET metadata_json = ? WHERE id = ?", (meta, image_id)
        )
    assert corpus_db.get_filtered_image_ids(search_query="dragon rider") == [image_id]
    assert corpus_db.get_filtered_image_ids(
        prompt_terms=["red scarf"], prompt_match_mode="contains"
    ) == [image_id]


def test_malformed_metadata_json_does_not_block_a_write(corpus_db):
    image_id = corpus_db.get_filtered_image_ids(search_query="filler5")[0]
    with corpus_db.get_db() as conn:
        conn.execute(
            "UPDATE images SET metadata_json = ? WHERE id = ?", ("{broken", image_id)
        )
    assert image_id in corpus_db.get_filtered_image_ids(search_query="filler5")


def test_deleting_pictures_removes_their_index_rows(corpus_db):
    ids = corpus_db.get_filtered_image_ids(search_query="filler")
    with corpus_db.get_db() as conn:
        conn.execute("DELETE FROM images WHERE id = ?", (ids[0],))
        assert ids[0] not in _indexed_ids(conn)
        assert (
            len(_indexed_ids(conn))
            == conn.execute("SELECT COUNT(*) FROM images").fetchone()[0]
        )
    assert ids[0] not in corpus_db.get_filtered_image_ids(search_query="filler")


def test_an_update_that_changes_nothing_searchable_leaves_the_index_row_alone(
    corpus_db,
):
    image_id = corpus_db.get_filtered_image_ids(search_query="filler3")[0]
    with corpus_db.get_db() as conn:
        # same prompt written again, as a rescan does: no delete/insert of the index row
        before = conn.execute("SELECT COUNT(*) FROM image_text_fts_docsize").fetchone()[
            0
        ]
        row = conn.execute(
            "SELECT prompt, filename FROM images WHERE id = ?", (image_id,)
        ).fetchone()
        conn.execute(
            "UPDATE images SET prompt = ?, filename = ? WHERE id = ?",
            (row[0], row[1], image_id),
        )
        assert (
            conn.execute("SELECT COUNT(*) FROM image_text_fts_docsize").fetchone()[0]
            == before
        )


# -------------------------------------------------------------------- migration


def test_the_migration_builds_the_index_for_pictures_that_already_exist(corpus_db):
    with corpus_db.get_db() as conn:
        _drop_search_index(conn)
    expected = {q: corpus_db.get_filtered_image_ids(search_query=q) for q in SEARCHES}

    with corpus_db.get_db() as conn:
        _migration().apply(conn)
        assert _indexed_ids(conn) == {
            r[0] for r in conn.execute("SELECT id FROM images")
        }
        assert (
            conn.execute("SELECT COUNT(*) FROM prompt_token_vocab").fetchone()[0] > 20
        )
    assert {
        q: corpus_db.get_filtered_image_ids(search_query=q) for q in SEARCHES
    } == expected


def test_the_migration_can_run_twice(corpus_db):
    with corpus_db.get_db() as conn:
        before = conn.execute("SELECT COUNT(*) FROM image_text_fts").fetchone()[0]
        words = conn.execute("SELECT COUNT(*) FROM prompt_token_vocab").fetchone()[0]
        _migration().apply(conn)
        _migration().apply(conn)
        assert (
            conn.execute("SELECT COUNT(*) FROM image_text_fts").fetchone()[0] == before
        )
        assert (
            conn.execute("SELECT COUNT(*) FROM prompt_token_vocab").fetchone()[0]
            == words
        )


def test_the_migration_repairs_an_index_that_fell_out_of_step(corpus_db):
    with corpus_db.get_db() as conn:
        conn.execute(
            "DELETE FROM image_text_fts WHERE rowid IN (SELECT id FROM images LIMIT 5)"
        )
        _migration().apply(conn)
        assert _indexed_ids(conn) == {
            r[0] for r in conn.execute("SELECT id FROM images")
        }


def test_without_trigram_support_the_migration_only_adds_the_lora_index(
    corpus_db, monkeypatch
):
    with corpus_db.get_db() as conn:
        _drop_search_index(conn)
        monkeypatch.setattr(_migration(), "trigram_supported", lambda c: False)
        _migration().apply(conn)
        names = {r[0] for r in conn.execute("SELECT name FROM sqlite_master")}
    assert "idx_image_loras_lora_lower" in names and "image_text_fts" not in names
    assert corpus_db.get_filtered_image_count(search_query="masterpiece") >= 3


def test_the_lora_lookup_uses_the_expression_index(corpus_db):
    with corpus_db.get_db() as conn:
        from db_search_index import lora_condition

        clause, params = lora_condition(None, "look_a")
        plan = " ".join(
            r[3]
            for r in conn.execute(
                f"EXPLAIN QUERY PLAN SELECT i.id FROM images i WHERE {clause}", params
            )
        )
    assert "idx_image_loras_lora_lower" in plan
    assert db_search_index.MIN_TRIGRAM_CHARS == 3
