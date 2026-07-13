"""Characterization pins for ``db_images_read`` (god-file split, step 0).

These pins lock the *observable* contracts of the image read/query layer so a
later verbatim tiling split of ``db_images_read.py`` cannot silently change
behavior. They deliberately complement (do not duplicate) ``test_database.py``,
which already behavior-tests generator/tag/dimension/aspect/search/prompt-mode
filters, cursor-missing-row fallbacks, and ``get_images_by_ids`` chunking. Here
we cover the gaps:

* the re-export identity contract (``database.X is db_images_read.X``),
* the v3.5.0 owner-visible date-range filter (``date_from`` / ``date_to``),
* pagination total/sentinel + cursor semantics,
* sort-key ordering (incl. the GROUP BY aggregate sorts and stable random),
* the per-item exclude filters and the Aurora/v3.x "extra" filters,
* the light single-lookup / id-only / chunk-iterator readers.

Everything runs against the temp-file SQLite built by the shared ``test_db`` /
``test_db_with_images`` fixtures (conftest.py). No real ``data/images.db`` is
touched. Consumers in production reach these functions through the ``database``
facade, so pins drive ``import database as db`` and assert the re-export chain.
"""

import json
import sys
from datetime import datetime
from pathlib import Path

import pytest

# Match the sibling test module's import bootstrap.
sys.path.insert(0, str(Path(__file__).parent.parent))

import database as db
import db_images_read
import db_core
from db_query import _apply_date_filter


# The exact name set the ``database`` facade re-exports from ``db_images_read``
# (database.py lines 249-271). This list IS the public re-export contract that a
# split must preserve; most of the codebase does ``from database import X`` /
# ``database.X``.
_REEXPORTED_READ_NAMES = [
    "get_images_in_folder_scope",
    "get_library_folders",
    "get_missing_image_reconnect_candidates",
    "get_images",
    "get_filtered_image_count",
    "get_filtered_image_ids",
    "get_images_paginated",
    "_get_filtered_count",
    "get_image_by_id",
    "get_images_missing_color_data",
    "count_images_missing_color_data",
    "get_image_by_path",
    "get_images_by_ids",
    "get_untagged_images",
    "get_all_image_ids",
    "get_untagged_image_ids",
    "count_all_image_ids",
    "count_untagged_image_ids",
    "iter_all_image_id_chunks",
    "iter_untagged_image_id_chunks",
    "get_image_count",
]


def _add(path, **kwargs):
    """Add a minimal image row and return its id (keeps pins terse)."""
    kwargs.setdefault("filename", path.rsplit("/", 1)[-1])
    return db.add_image(path=path, **kwargs)


# ===========================================================================
# Re-export identity (hazard #1: database.py is a re-export facade)
# ===========================================================================


class TestReExportContract:
    def test_every_public_read_name_is_the_same_object_on_both_namespaces(self):
        """database.X must be the identical object exported by db_images_read.X.

        If a split leaves a name behind (or shadows it with a wrapper), this
        catches it before any reader that imports through the facade breaks.
        """
        for name in _REEXPORTED_READ_NAMES:
            assert hasattr(db_images_read, name), f"db_images_read missing {name}"
            assert hasattr(db, name), f"database facade missing {name}"
            assert getattr(db, name) is getattr(db_images_read, name), (
                f"{name} diverged between database and db_images_read"
            )

    def test_read_module_shares_the_injected_connection_provider(self):
        """db_images_read.get_db is the single db_core-injected factory.

        All db_* modules must share one connection provider (set once in
        database.py via db_core.set_connection_provider); a split must not
        re-bind a private get_db.
        """
        assert db_images_read.get_db is db_core.get_db


# ===========================================================================
# Date-range filter (hazard #2: v3.5.0 owner-visible feature)
# ===========================================================================


class TestDateRangeFilter:
    def test_apply_date_filter_builds_half_open_upper_bound_sql(self):
        """Both bounds: >= lower, and < date(?, '+1 day') so the end day is whole."""
        conditions, params = _apply_date_filter([], [], "2026-01-10", "2026-01-20")
        assert conditions == [
            "COALESCE(i.library_order_time, i.created_at) >= ?",
            "COALESCE(i.library_order_time, i.created_at) < date(?, '+1 day')",
        ]
        assert params == ["2026-01-10", "2026-01-20"]

    def test_apply_date_filter_single_bounds_and_noop(self):
        """Each bound is independent; no bound is a pure no-op (no params bound)."""
        from_only_c, from_only_p = _apply_date_filter([], [], "2026-02-01", None)
        assert from_only_c == ["COALESCE(i.library_order_time, i.created_at) >= ?"]
        assert from_only_p == ["2026-02-01"]

        to_only_c, to_only_p = _apply_date_filter([], [], None, "2026-02-01")
        assert to_only_c == [
            "COALESCE(i.library_order_time, i.created_at) < date(?, '+1 day')"
        ]
        assert to_only_p == ["2026-02-01"]

        noop_c, noop_p = _apply_date_filter([], [], None, None)
        assert noop_c == []
        assert noop_p == []

    def test_get_images_date_from_is_inclusive_lower_bound(self, test_db):
        early = _add("/date/early.png", created_at=datetime(2026, 1, 10, 12, 0, 0))
        mid = _add("/date/mid.png", created_at=datetime(2026, 1, 15, 12, 0, 0))
        late = _add("/date/late.png", created_at=datetime(2026, 1, 20, 12, 0, 0))

        got = {img["id"] for img in db.get_images(date_from="2026-01-15")}

        assert got == {mid, late}
        assert early not in got

    def test_get_images_date_to_includes_the_whole_end_day(self, test_db):
        early = _add("/date/early.png", created_at=datetime(2026, 1, 10, 12, 0, 0))
        mid = _add("/date/mid.png", created_at=datetime(2026, 1, 15, 23, 59, 59))
        late = _add("/date/late.png", created_at=datetime(2026, 1, 20, 0, 0, 1))

        got = {img["id"] for img in db.get_images(date_to="2026-01-15")}

        # 2026-01-15 23:59:59 must still be inside the end day.
        assert got == {early, mid}
        assert late not in got

    def test_get_images_date_range_single_day_bounds_both_ends(self, test_db):
        _add("/date/before.png", created_at=datetime(2026, 1, 14, 23, 0, 0))
        target = _add("/date/target.png", created_at=datetime(2026, 1, 15, 8, 0, 0))
        _add("/date/after.png", created_at=datetime(2026, 1, 16, 1, 0, 0))

        got = [
            img["id"]
            for img in db.get_images(date_from="2026-01-15", date_to="2026-01-15")
        ]

        assert got == [target]

    def test_get_filtered_image_count_honors_date_range(self, test_db):
        _add("/date/c1.png", created_at=datetime(2026, 3, 1, 12, 0, 0))
        _add("/date/c2.png", created_at=datetime(2026, 3, 5, 12, 0, 0))
        _add("/date/c3.png", created_at=datetime(2026, 3, 9, 12, 0, 0))

        assert db.get_filtered_image_count(date_from="2026-03-05") == 2
        assert db.get_filtered_image_count(date_to="2026-03-05") == 2
        assert (
            db.get_filtered_image_count(date_from="2026-03-05", date_to="2026-03-05")
            == 1
        )

    def test_get_filtered_image_ids_honors_date_range(self, test_db):
        _add("/date/i1.png", created_at=datetime(2026, 4, 1, 12, 0, 0))
        keep = _add("/date/i2.png", created_at=datetime(2026, 4, 5, 12, 0, 0))
        late = _add("/date/i3.png", created_at=datetime(2026, 4, 9, 12, 0, 0))

        ids = db.get_filtered_image_ids(date_from="2026-04-05")

        assert set(ids) == {keep, late}

    def test_get_images_paginated_total_honors_date_range(self, test_db):
        _add("/date/p1.png", created_at=datetime(2026, 5, 1, 12, 0, 0))
        _add("/date/p2.png", created_at=datetime(2026, 5, 5, 12, 0, 0))
        _add("/date/p3.png", created_at=datetime(2026, 5, 9, 12, 0, 0))

        result = db.get_images_paginated(
            date_from="2026-05-05", sort_by="newest", limit=10
        )

        assert result["total"] == 2
        assert len(result["images"]) == 2


# ===========================================================================
# Pagination total / sentinel / cursor contracts
# ===========================================================================


class TestPaginationContracts:
    def test_skip_count_returns_minus_one_total_sentinel(self, test_db):
        _add("/pag/a.png")
        _add("/pag/b.png")

        result = db.get_images_paginated(skip_count=True, limit=10)

        assert result["total"] == -1

    def test_real_total_and_cursor_navigation_flips_sentinel_and_has_more(
        self, test_db
    ):
        ids = [_add(f"/pag/n{i}.png") for i in range(3)]
        expected_newest = list(reversed(ids))

        page1 = db.get_images_paginated(sort_by="newest", limit=2)
        assert page1["total"] == 3  # real count when no skip_count and no cursor
        assert [img["id"] for img in page1["images"]] == expected_newest[:2]
        assert page1["has_more"] is True
        assert page1["next_cursor"] is not None

        cursor_id = page1["images"][-1]["id"]
        page2 = db.get_images_paginated(sort_by="newest", limit=2, cursor_id=cursor_id)
        # A cursor request skips the COUNT even without skip_count=True.
        assert page2["total"] == -1
        assert [img["id"] for img in page2["images"]] == expected_newest[2:]
        assert page2["has_more"] is False
        assert page2["next_cursor"] is None

    def test_cursor_pagination_rejects_unsupported_sort(self, test_db):
        _add("/pag/x.png")
        with pytest.raises(ValueError, match="Cursor pagination does not support"):
            db.get_images_paginated(sort_by="name_asc", cursor_id=1)

    def test_random_sort_ignores_cursor_and_never_emits_next_cursor(self, test_db):
        for i in range(3):
            _add(f"/pag/r{i}.png")

        result = db.get_images_paginated(sort_by="random", limit=2, cursor_id=1)

        # random + cursor_id set: no ValueError, no next_cursor, count skipped.
        assert result["next_cursor"] is None
        assert result["total"] == -1
        assert isinstance(result["images"], list)

    def test_paginated_total_respects_color_hues_filter(self, test_db):
        """The cursor-pagination first-page COUNT (_get_filtered_count) applies
        the v3.5.0 dominant-hue filters, so ``total`` matches the hue-filtered
        page. Regression pin for the dormant bug found by the step-0 sweep:
        the count body omitted _apply_color_hues_filter while every other query
        function applied it, inflating ``total`` to the unfiltered count under
        newest/oldest sort.
        """
        red = _add("/hue/total_red.png")
        _add("/hue/total_g.png")
        _add("/hue/total_b.png")
        with db.get_db() as conn:
            conn.execute(
                "UPDATE images SET dominant_color_tags = ? WHERE id = ?", (",red,", red)
            )

        result = db.get_images_paginated(color_hues=["red"], sort_by="newest", limit=10)

        # Page is correctly filtered to the one red image ...
        assert [img["id"] for img in result["images"]] == [red]
        # ... and total now agrees with the hue-filtered page.
        assert result["total"] == 1
        # The standalone count helper agrees (no divergence).
        assert db.get_filtered_image_count(color_hues=["red"]) == 1


# ===========================================================================
# get_images offset/limit window
# ===========================================================================


class TestOffsetLimitWindow:
    def test_get_images_offset_and_limit_slice_the_ordered_window(self, test_db):
        ids = [_add(f"/win/w{i}.png") for i in range(5)]  # oldest == id ascending

        window = db.get_images(sort_by="oldest", limit=2, offset=1)

        assert [img["id"] for img in window] == ids[1:3]


# ===========================================================================
# Sort-key ordering
# ===========================================================================


class TestSortOrders:
    def test_oldest_sorts_ascending_by_library_order_time(self, test_db):
        a = _add("/sort/o_a.png", created_at=datetime(2026, 1, 1, 0, 0, 0))
        b = _add("/sort/o_b.png", created_at=datetime(2026, 1, 2, 0, 0, 0))
        c = _add("/sort/o_c.png", created_at=datetime(2026, 1, 3, 0, 0, 0))

        got = [img["id"] for img in db.get_images(sort_by="oldest")]

        assert got == [a, b, c]

    def test_generator_sort_is_alphabetical_ascending(self, test_db):
        _add("/sort/g_z.png", generator="zeta")
        _add("/sort/g_a.png", generator="alpha")
        _add("/sort/g_m.png", generator="mike")

        gens = [img["generator"] for img in db.get_images(sort_by="generator")]

        assert gens == ["alpha", "mike", "zeta"]

    def test_prompt_length_sort_orders_by_raw_prompt_length_desc(self, test_db):
        short = _add("/sort/p_s.png", prompt="a")
        mid = _add("/sort/p_m.png", prompt="aaa")
        long = _add("/sort/p_l.png", prompt="aaaaaaaa")

        got = [img["id"] for img in db.get_images(sort_by="prompt_length")]

        assert got == [long, mid, short]

    def test_tag_count_sort_uses_group_by_without_dropping_zero_tag_rows(self, test_db):
        three = _add("/sort/t3.png")
        one = _add("/sort/t1.png")
        zero = _add("/sort/t0.png")
        db.add_tags(
            three,
            [
                {"tag": "x", "confidence": 0.9},
                {"tag": "y", "confidence": 0.9},
                {"tag": "z", "confidence": 0.9},
            ],
        )
        db.add_tags(one, [{"tag": "x", "confidence": 0.9}])

        got = [img["id"] for img in db.get_images(sort_by="tag_count")]

        # GROUP BY i.id must keep each image exactly once and keep the 0-tag row.
        assert got == [three, one, zero]

    def test_rating_sort_orders_explicit_before_general_before_unrated(self, test_db):
        explicit = _add("/sort/r_e.png")
        general = _add("/sort/r_g.png")
        unrated = _add("/sort/r_u.png")
        db.add_tags(explicit, [{"tag": "explicit", "confidence": 0.9}])
        db.add_tags(general, [{"tag": "general", "confidence": 0.9}])

        got = [img["id"] for img in db.get_images(sort_by="rating")]

        assert got == [explicit, general, unrated]

    def test_random_sort_is_stable_across_calls(self, test_db):
        for i in range(6):
            _add(f"/sort/rand_{i}.png")

        first = [img["id"] for img in db.get_images(sort_by="random")]
        second = [img["id"] for img in db.get_images(sort_by="random")]

        assert first == second

    def test_aesthetic_sort_treats_null_score_as_zero_floor(self, test_db):
        high = _add("/sort/a_h.png")
        low = _add("/sort/a_l.png")
        none = _add("/sort/a_n.png")
        with db.get_db() as conn:
            conn.execute(
                "UPDATE images SET aesthetic_score = ? WHERE id = ?", (8.0, high)
            )
            conn.execute(
                "UPDATE images SET aesthetic_score = ? WHERE id = ?", (5.0, low)
            )

        got = [img["id"] for img in db.get_images(sort_by="aesthetic")]

        assert got == [high, low, none]


# ===========================================================================
# Per-item exclude filters + Aurora/v3.x "extra" filters
# ===========================================================================


class TestExcludeAndExtraFilters:
    def test_exclude_tags_drops_images_carrying_any_listed_tag(self, test_db):
        cat = _add("/ex/cat.png")
        dog = _add("/ex/dog.png")
        db.add_tags(cat, [{"tag": "cat", "confidence": 0.9}])
        db.add_tags(dog, [{"tag": "dog", "confidence": 0.9}])

        got = {img["id"] for img in db.get_images(exclude_tags=["cat"])}

        assert dog in got
        assert cat not in got

    def test_exclude_generators_is_case_insensitive(self, test_db):
        webui = _add("/ex/g_webui.png", generator="webui")
        comfy = _add("/ex/g_comfy.png", generator="comfyui")

        got = {img["id"] for img in db.get_images(exclude_generators=["WEBUI"])}

        assert comfy in got
        assert webui not in got

    def test_exclude_ratings_keeps_unrated_images_visible(self, test_db):
        explicit = _add("/ex/r_explicit.png")
        untagged = _add("/ex/r_untagged.png")
        db.add_tags(explicit, [{"tag": "explicit", "confidence": 0.9}])

        got = {img["id"] for img in db.get_images(exclude_ratings=["explicit"])}

        # NULL ai_rating must survive the exclude (NOT IN alone would drop it).
        assert untagged in got
        assert explicit not in got

    def test_exclude_prompts_exact_mode_does_not_over_exclude_substrings(self, test_db):
        cat = _add("/ex/p_cat.png", prompt="cat")
        catgirl = _add("/ex/p_catgirl.png", prompt="catgirl")

        got = {img["id"] for img in db.get_images(exclude_prompts=["cat"])}

        # v3.4.0 fix: token-level exclude removes "cat" but keeps "catgirl".
        assert catgirl in got
        assert cat not in got

    def test_color_hues_include_and_exclude_match_wrapped_dominant_tags(self, test_db):
        red = _add("/ex/hue_red.png")
        blue = _add("/ex/hue_blue.png")
        with db.get_db() as conn:
            conn.execute(
                "UPDATE images SET dominant_color_tags = ? WHERE id = ?",
                (",red,green,", red),
            )
            conn.execute(
                "UPDATE images SET dominant_color_tags = ? WHERE id = ?",
                (",blue,", blue),
            )

        included = {img["id"] for img in db.get_images(color_hues=["red"])}
        excluded = {img["id"] for img in db.get_images(exclude_color_hues=["red"])}

        assert included == {red}
        assert blue in excluded and red not in excluded

    def test_collection_filter_scopes_to_favorited_members(self, test_db):
        fav = _add("/ex/coll_fav.png")
        other = _add("/ex/coll_other.png")
        db.set_favorite(fav, True)
        favorites_id = db.get_favorites_collection_id()

        got = {img["id"] for img in db.get_images(collection_id=favorites_id)}

        assert got == {fav}
        assert other not in got

    def test_folder_filter_scopes_recursively_to_the_subtree(self, test_db):
        direct = _add("/lib/x/a.png")
        nested = _add("/lib/x/sub/b.png")
        outside = _add("/lib/y/c.png")

        got = {img["id"] for img in db.get_images(folder="/lib/x")}

        assert got == {direct, nested}
        assert outside not in got

    def test_has_metadata_partitions_generation_rows_from_plain_scans(self, test_db):
        gen = _add("/ex/meta_gen.png", generator="webui", prompt="a portrait")
        plain = _add("/ex/meta_plain.png", generator="unknown", prompt=None)

        has = {img["id"] for img in db.get_images(has_metadata=True)}
        without = {img["id"] for img in db.get_images(has_metadata=False)}

        assert gen in has and plain not in has
        assert plain in without and gen not in without

    def test_no_caption_filter_excludes_images_with_any_caption(self, test_db):
        blank = _add("/ex/cap_blank.png")
        captioned = _add("/ex/cap_set.png")
        with db.get_db() as conn:
            conn.execute(
                "UPDATE images SET ai_caption = ? WHERE id = ?", ("a cat", captioned)
            )

        got = {img["id"] for img in db.get_images(no_caption=True)}

        assert blank in got
        assert captioned not in got

    def test_seed_filter_matches_parsed_generation_seed(self, test_db):
        seeded = _add(
            "/ex/seed_hit.png",
            metadata_json=json.dumps(
                {"_parsed": {"generation_params": {"seed": 4242}}}
            ),
        )
        _add("/ex/seed_plain.png")

        hit = [img["id"] for img in db.get_images(seed=4242)]
        miss = db.get_images(seed=999999)

        assert hit == [seeded]
        assert miss == []

    def test_min_user_rating_filters_by_star_threshold(self, test_db):
        high = _add("/ex/star_high.png")
        unrated = _add("/ex/star_unrated.png")
        db.set_user_rating(high, 4)

        narrowed = {img["id"] for img in db.get_images(min_user_rating=3)}
        noop = {img["id"] for img in db.get_images(min_user_rating=0)}

        assert narrowed == {high}
        assert unrated in noop and high in noop

    def test_saturation_range_filter_excludes_unanalyzed_rows(self, test_db):
        vivid = _add("/ex/sat_vivid.png")
        muted = _add("/ex/sat_muted.png")
        unscored = _add("/ex/sat_none.png")
        with db.get_db() as conn:
            conn.execute(
                "UPDATE images SET color_saturation = ? WHERE id = ?", (0.8, vivid)
            )
            conn.execute(
                "UPDATE images SET color_saturation = ? WHERE id = ?", (0.2, muted)
            )

        high = {img["id"] for img in db.get_images(min_saturation=0.5)}
        low = {img["id"] for img in db.get_images(max_saturation=0.5)}

        assert high == {vivid}
        assert low == {muted}  # unscored (NULL) never matches a range
        assert unscored not in high and unscored not in low


# ===========================================================================
# Light single-lookup / id-only / chunk-iterator readers
# ===========================================================================


class TestLightReaders:
    def test_get_image_by_id_returns_none_for_missing(self, test_db):
        assert db.get_image_by_id(9_999_999) is None

    def test_get_image_by_path_exact_hit_and_misses(self, test_db):
        image_id = _add("/lib/p/img.png")

        assert db.get_image_by_path("/lib/p/img.png")["id"] == image_id
        assert db.get_image_by_path("/lib/p/nope.png") is None
        assert db.get_image_by_path("") is None

    def test_missing_color_data_reader_and_count_track_backfill(self, test_db):
        a = _add("/color/a.png")
        b = _add("/color/b.png")

        assert db.count_images_missing_color_data() == 2
        assert {row["id"] for row in db.get_images_missing_color_data()} == {a, b}

        with db.get_db() as conn:
            conn.execute("UPDATE images SET avg_brightness = ? WHERE id = ?", (0.5, a))

        assert db.count_images_missing_color_data() == 1
        assert {row["id"] for row in db.get_images_missing_color_data()} == {b}

    def test_untagged_and_total_id_counts(self, test_db):
        tagged = _add("/count/tagged.png")
        untagged = _add("/count/untagged.png")
        db.add_tags(tagged, [{"tag": "x", "confidence": 0.9}])

        assert db.count_all_image_ids() == 2
        assert db.count_untagged_image_ids() == 1
        assert db.get_untagged_image_ids() == [untagged]

    def test_id_chunk_iterators_exclude_unreadable_and_chunk_in_order(self, test_db):
        readable = [_add(f"/iter/r{i}.png") for i in range(5)]
        unreadable = _add(
            "/iter/bad.png", is_readable=False, read_error="Truncated File Read"
        )
        tagged = readable[0]
        db.add_tags(tagged, [{"tag": "x", "confidence": 0.9}])

        all_chunks = list(db.iter_all_image_id_chunks(chunk_size=2))
        untagged_chunks = list(db.iter_untagged_image_id_chunks(chunk_size=2))

        flat_all = [i for chunk in all_chunks for i in chunk]
        assert flat_all == sorted(readable)  # id order, unreadable excluded
        assert unreadable not in flat_all
        assert all(len(chunk) <= 2 for chunk in all_chunks)

        flat_untagged = [i for chunk in untagged_chunks for i in chunk]
        assert flat_untagged == sorted(readable[1:])  # tagged row dropped
        assert tagged not in flat_untagged

    def test_get_library_folders_returns_sorted_distinct_readable_parents(
        self, test_db
    ):
        _add("/lib/a/x.png")
        _add("/lib/a/y.png")
        _add("/lib/b/z.png")
        _add("/lib/c/hidden.png", is_readable=False, read_error="Truncated File Read")

        folders = db.get_library_folders()

        assert folders == ["/lib/a", "/lib/b"]

    def test_missing_reconnect_candidates_flag_unresolvable_paths_and_respect_limit(
        self, test_db
    ):
        ids = [_add(f"/gone/missing_{i}.png") for i in range(3)]

        candidate_ids = {
            row["id"] for row in db.get_missing_image_reconnect_candidates()
        }
        limited = db.get_missing_image_reconnect_candidates(limit=1)

        # Every seeded path is fake/off-disk, so all become reconnect candidates.
        assert set(ids).issubset(candidate_ids)
        # limit caps how many rows are scanned, so it caps candidates too.
        assert len(limited) <= 1
