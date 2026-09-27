"""Tag autocomplete search (/api/tags/library?q=) is fast and answers as before (V3.5 3-5).

The search scanned every tag row twice (count, then list) with a per-row
LOWER/REPLACE: 0.6-1.2 s per keystroke on a 12,853-image library with
~650,000 tag rows. It now matches the library's own tag counts (cached per
library, dropped on every tag write): 7-27 ms. The old SQL is kept here as
the reference, so matching, ranking, order and totals stay the same.
"""

from __future__ import annotations

from typing import Any, Dict, List

import pytest

import database as db
import db_tags
import db_libraries as libdb
from db_helpers import escape_like_pattern, normalize_prompt_token
from library_context import (
    MAIN_LIBRARY_ID,
    reset_current_library_id,
    set_current_library_id,
)

_TAG_ROWS = {
    "a.png": [
        "long_hair",
        "Long_Hair",
        "hair_ornament",
        "smile",
        "evil_smile",
        "1girl",
    ],
    "b.png": [
        "long_hair",
        "blue_hair",
        "(artist)",
        "[bracket]_hair",
        "ÉLAN",
        "élan",
        "smile",
    ],
    "c.png": [
        "hairband",
        "short_hair",
        "light_smile",
        "100%_orange",
        "snake_case_tag",
        "smile",
    ],
}
_OTHER_LIBRARY_ROWS = {"d.png": ["long_hair", "other_only_hair"]}
_QUERIES = [
    "hair",
    "long hair",
    "long_hair",
    "smi",
    "SMILE",
    "(",
    "[",
    "%",
    "_",
    "é",
    "É",
    "e",
    "1g",
    "zzz",
    " sm",
]


def _add(path: str, tags: List[str], library_id: str) -> None:
    token = set_current_library_id(library_id)
    try:
        image_id = db.add_image(
            path=path, filename=path.rsplit("/", 1)[-1], metadata_json="{}"
        )
        db.add_tags(image_id, [{"tag": tag, "confidence": 0.9} for tag in tags])
    finally:
        reset_current_library_id(token)


def _reference_search(query: str, sort_by: str) -> Dict[str, Any]:
    """The SQL search this replaced, verbatim in behaviour."""
    normalized = normalize_prompt_token(query)
    value_expr = "REPLACE(LOWER(t.tag), '_', ' ')"
    rank_sql = db_tags._facet_search_rank_sql(value_expr)
    pattern = f"%{escape_like_pattern(normalized)}%"
    order_tail = (
        "t.tag COLLATE NOCASE ASC"
        if sort_by == "alphabetical"
        else "count DESC, t.tag COLLATE NOCASE ASC"
    )
    with db.get_db() as conn:
        rows = conn.execute(
            f"""
            SELECT t.tag, COUNT(*) AS count, {rank_sql} AS relevance
            FROM tags t INNER JOIN images i ON i.id = t.image_id
            WHERE {value_expr} LIKE ? ESCAPE '\\' AND i.library_id = ?
            GROUP BY t.tag
            ORDER BY relevance ASC, {order_tail}
            """,
            [*db_tags._facet_search_rank_params(normalized), pattern, MAIN_LIBRARY_ID],
        ).fetchall()
    tags = [{"tag": row["tag"], "count": row["count"]} for row in rows]
    return {"tags": tags, "total": len(tags), "query": normalized, "sort": sort_by}


@pytest.fixture
def seeded(test_db):
    libdb.ensure_default_library()
    other = libdb.create_library("Search other")["id"]
    for name, tags in _TAG_ROWS.items():
        _add(f"/tmp/tag-search/{name}", tags, MAIN_LIBRARY_ID)
    for name, tags in _OTHER_LIBRARY_ROWS.items():
        _add(f"/tmp/tag-search/{name}", tags, other)
    return test_db


@pytest.mark.parametrize("sort_by", ["frequency", "alphabetical"])
def test_results_match_the_sql_search_it_replaced(seeded, sort_by):
    token = set_current_library_id(MAIN_LIBRARY_ID)
    try:
        for query in _QUERIES:
            assert db.search_tags(query, sort_by=sort_by) == _reference_search(
                query, sort_by
            ), query
            limited = db.search_tags(query, sort_by=sort_by, limit=2)
            assert limited["tags"] == _reference_search(query, sort_by)["tags"][:2]
            assert limited["total"] == _reference_search(query, sort_by)["total"]
    finally:
        reset_current_library_id(token)


def test_search_reads_the_cached_library_counts_not_the_tag_rows(seeded, monkeypatch):
    monkeypatch.setattr(
        db_tags,
        "get_all_tags",
        lambda: [
            {"tag": "cached_hair", "count": 7},
            {"tag": "cached_smile", "count": 3},
        ],
    )

    result = db.search_tags("hair")

    assert result["tags"] == [{"tag": "cached_hair", "count": 7}]
    assert result["total"] == 1
