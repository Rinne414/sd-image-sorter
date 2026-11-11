"""Migration 070: the parameter searches and the name order use their indexes."""

from __future__ import annotations

import json

import db_generation_search


def _picture(test_db, tmp_path, name, metadata):
    from PIL import Image

    path = tmp_path / name
    Image.new("RGB", (8, 8)).save(path)
    return test_db.add_image(
        path=str(path), filename=name, prompt="1girl", metadata_json=metadata
    )


def _plan(test_db, sql, params):
    conn = test_db.get_connection()
    try:
        return " | ".join(
            str(row[3]) for row in conn.execute("EXPLAIN QUERY PLAN " + sql, params)
        )
    finally:
        conn.close()


def test_each_parameter_search_is_answered_from_its_index(test_db):
    # The indexes are built from the search's own expressions; if one of them
    # changes without the other, the search silently reads every picture again.
    for term, index in (
        ("steps:28", "idx_images_gen_steps"),
        ("cfg:5..7", "idx_images_gen_cfg"),
        ("sampler:euler", "idx_images_gen_sampler"),
    ):
        _rest, conditions, params = db_generation_search.extract(term)
        sql = (
            "SELECT COUNT(*) FROM images i WHERE i.library_id = ? AND "
            + " AND ".join(conditions)
        )
        assert index in _plan(test_db, sql, ["main", *params]), term


def test_a_page_in_name_order_walks_the_name_index(test_db):
    plan = _plan(
        test_db,
        "SELECT i.id FROM images i WHERE i.library_id = ? ORDER BY i.filename ASC, i.id ASC LIMIT 200 OFFSET 50000",
        ["main"],
    )
    assert "idx_images_lib_filename" in plan
    assert "TEMP B-TREE" not in plan  # no sort of the whole library per page


def test_damaged_metadata_neither_breaks_the_search_nor_matches(
    test_client, test_db, tmp_path
):
    good = _picture(
        test_db,
        tmp_path,
        "good.png",
        json.dumps(
            {
                "_parsed": {
                    "generation_params": {
                        "steps": 28,
                        "sampler": "Euler a",
                        "cfg_scale": 6,
                    }
                }
            }
        ),
    )
    _picture(
        test_db,
        tmp_path,
        "damaged.png",
        '{"_parsed": {"generation_params": {"steps": 28',
    )
    _picture(test_db, tmp_path, "empty.png", "")

    for term in ("steps:28", "sampler:euler", "cfg:5..7"):
        answer = test_client.get("/api/images", params={"search": term, "limit": 10})
        assert answer.status_code == 200, (term, answer.text)
        assert [image["id"] for image in answer.json()["images"]] == [good], term
