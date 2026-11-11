"""Search by sampler, steps and CFG, as terms inside the search text."""

from __future__ import annotations

import json

import db_generation_search


def _library(test_db, tmp_path):
    from PIL import Image

    rows = [
        ("1girl, rain", {"sampler": "Euler a", "steps": 28, "cfg_scale": 7}),
        ("1girl, rain", {"sampler": "DPM++ 2M Karras", "steps": 30, "cfg_scale": 5.5}),
        ("1boy, sun", {"sampler_name": "euler_ancestral", "steps": "20", "cfg": 4}),
        ("landscape", {}),  # no generation data
    ]
    ids = []
    for n, (prompt, params) in enumerate(rows):
        path = tmp_path / f"{n}.png"
        Image.new("RGB", (8, 8)).save(path)
        meta = json.dumps({"_parsed": {"generation_params": params}})
        ids.append(
            test_db.add_image(
                path=str(path), filename=path.name, prompt=prompt, metadata_json=meta
            )
        )
    broken = tmp_path / "broken.png"
    Image.new("RGB", (8, 8)).save(broken)
    ids.append(
        test_db.add_image(
            path=str(broken),
            filename=broken.name,
            prompt="1girl",
            metadata_json="not json at all",
        )
    )
    return ids


def _found(test_db, text):
    page = test_db.get_images(search_query=text, limit=50)
    rows = (
        page
        if isinstance(page, list)
        else (page[0] if isinstance(page, tuple) else page["images"])
    )
    return sorted(row["id"] for row in rows)


def test_the_terms_are_taken_out_of_the_text_and_the_rest_is_left():
    rest, conditions, params = db_generation_search.extract(
        'rain sampler:"Euler a" steps>=28 cfg:5..7 city'
    )
    assert rest == "rain city"
    assert len(conditions) == 3
    assert params == ["%euler a%", 28.0, 5.0, 7.0]

    # No such term: the text comes back untouched.
    assert db_generation_search.extract("a sampler of tea, steps to the sea") == (
        "a sampler of tea, steps to the sea",
        [],
        [],
    )
    # A value that is not a number stays as ordinary words.
    assert db_generation_search.extract("steps:many rain")[0] == "steps:many rain"
    assert db_generation_search.extract(None) == ("", [], [])


def test_sampler_matches_a_part_of_the_name_whatever_the_spelling(test_db, tmp_path):
    a, b, c, _none, _broken = _library(test_db, tmp_path)

    assert _found(test_db, "sampler:euler") == [a, c]
    assert _found(test_db, 'sampler:"euler a"') == [
        a,
        c,
    ]  # "euler_ancestral" reads "euler ancestral"
    assert _found(test_db, "sampler:karras") == [b]
    assert _found(test_db, "sampler:heun") == []


def test_steps_and_cfg_take_a_value_a_range_or_a_bound(test_db, tmp_path):
    a, b, c, _none, _broken = _library(test_db, tmp_path)

    assert _found(test_db, "steps:28") == [a]
    assert _found(test_db, "steps:20..28") == [a, c]
    assert _found(test_db, "steps>=28") == [a, b]
    assert _found(test_db, "steps<28") == [
        a,
        c,
    ]  # the bound is included, as elsewhere in the search
    assert _found(test_db, "cfg:5.5") == [b]
    assert _found(test_db, "cfg<=5.5") == [b, c]
    assert _found(test_db, "cfg:6..9") == [a]


def test_terms_combine_with_each_other_and_with_ordinary_words(test_db, tmp_path):
    a, b, c, _none, _broken = _library(test_db, tmp_path)

    assert _found(test_db, "rain steps>=28") == [a, b]
    assert _found(test_db, "rain sampler:euler") == [a]
    assert _found(test_db, "sampler:euler steps:20") == [c]
    # Pictures without generation data, or with text that is not JSON, never match and never break the query.
    assert _found(test_db, "steps>=0") == [a, b, c]


def test_the_count_and_the_page_agree_through_the_api(test_client, test_db, tmp_path):
    a, b, _c, _none, _broken = _library(test_db, tmp_path)

    counted = test_client.get("/api/images/count", params={"search": "steps>=28"}).json()
    listed = test_client.get("/api/images", params={"search": "steps>=28", "limit": 50}).json()

    assert counted["total"] == 2
    assert sorted(row["id"] for row in listed["images"]) == [a, b]
