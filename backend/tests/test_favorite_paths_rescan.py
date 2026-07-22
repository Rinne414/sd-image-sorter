"""Favorites are anchored by file path (migration 017 + db_collections) so they
survive a library Clear / rescan that re-IDs images. Covers set_favorite and the
path-resolved reads (get_favorite_source_ids / is_favorited / count / browse).
"""
import database as db
from db_collections import (
    _favorite_image_ids_query,
    _promote_legacy_favorite_identities,
)
from db_helpers import _folder_scope_query_match_clause, _path_query_match_clause
from db_images_write import _sync_image_path_identity


def test_set_and_clear_favorite_by_path(test_db):
    image_id = db.add_image(path="/lib/a.png", filename="a.png")

    assert db.set_favorite(image_id, True) is True
    assert db.is_favorited(image_id)
    assert image_id in db.get_favorite_source_ids()
    assert db.get_favorites_count() == 1

    assert db.set_favorite(image_id, False) is False
    assert not db.is_favorited(image_id)
    assert image_id not in db.get_favorite_source_ids()
    assert db.get_favorites_count() == 0


def test_favorite_survives_clear_and_rescan(test_db):
    """Core guarantee: a hard Clear (DELETE FROM images -> new ids on rescan)
    must not lose the favorite."""
    path = "/lib/keep.png"
    old_id = db.add_image(path=path, filename="keep.png")
    # A second image keeps the max id above old_id, so the rescan gets a NEW id
    # even if SQLite would otherwise reuse a freed rowid.
    db.add_image(path="/lib/other.png", filename="other.png")
    db.set_favorite(old_id, True)
    assert old_id in db.get_favorite_source_ids()

    # Simulate "Clear Gallery": DELETE FROM images cascades collection_items away.
    with db.get_db() as conn:
        conn.cursor().execute("DELETE FROM images WHERE id = ?", (old_id,))

    # No image at that path now -> nothing resolves, but the path anchor persists.
    assert db.get_favorite_source_ids() == []
    assert db.get_favorites_count() == 0

    # Rescan re-inserts the SAME file -> a brand-new row id.
    new_id = db.add_image(path=path, filename="keep.png")
    assert new_id != old_id

    # Rescan-proof: the favorite re-binds to the new id automatically.
    assert new_id in db.get_favorite_source_ids()
    assert db.is_favorited(new_id)
    assert db.get_favorites_count() == 1


def test_windows_favorite_survives_rescan_with_different_path_case(test_db):
    old_id = db.add_image(path=r"C:\Library\Keep.png", filename="Keep.png")
    db.set_favorite(old_id, True)

    with db.get_db() as conn:
        conn.execute("DELETE FROM images WHERE id = ?", (old_id,))

    new_id = db.add_image(path=r"c:\library\keep.png", filename="keep.png")

    assert db.get_favorite_source_ids() == [new_id]
    assert db.is_favorited(new_id)


def test_unicode_windows_favorite_survives_rescan_and_can_be_removed(test_db):
    old_id = db.add_image(path=r"C:\Library\Ä.png", filename="Ä.png")
    db.set_favorite(old_id, True)

    assert db.get_favorite_source_ids() == [old_id]
    assert db.get_favorites_count() == 1
    assert db.is_favorited(old_id)

    with db.get_db() as conn:
        conn.execute("DELETE FROM images WHERE id = ?", (old_id,))

    new_id = db.add_image(path=r"c:\library\ä.png", filename="ä.png")

    assert db.get_favorite_source_ids() == [new_id]
    assert db.is_favorited(new_id)

    db.set_favorite(new_id, False)

    assert db.get_favorite_source_ids() == []
    assert db.get_favorites_count() == 0
    assert not db.is_favorited(new_id)


def test_forward_slash_unc_favorite_matches_backslash_unc_rescan(test_db):
    old_id = db.add_image(path="//Server/Share/A.png", filename="A.png")
    db.set_favorite(old_id, True)

    with db.get_db() as conn:
        conn.execute("DELETE FROM images WHERE id = ?", (old_id,))

    new_id = db.add_image(
        path=r"\\server\share\a.png",
        filename="a.png",
    )

    assert db.get_favorite_source_ids() == [new_id]
    assert db.is_favorited(new_id)


def test_windows_favorite_matches_wsl_drive_rescan(test_db):
    old_id = db.add_image(path=r"C:\Library\Ä.png", filename="Ä.png")
    db.set_favorite(old_id, True)

    with db.get_db() as conn:
        conn.execute("DELETE FROM images WHERE id = ?", (old_id,))

    new_id = db.add_image(path="/mnt/c/Library/ä.png", filename="ä.png")

    assert db.get_favorite_source_ids() == [new_id]
    assert db.is_favorited(new_id)


def test_windows_favorite_hydrates_simultaneous_wsl_alias(test_db):
    windows_id = db.add_image(path=r"C:\Library\A.png", filename="A.png")
    with db.get_db() as conn:
        cursor = conn.execute(
            "INSERT INTO images (path, filename) VALUES (?, ?)",
            ("/mnt/c/Library/A.png", "A.png"),
        )
        wsl_id = int(cursor.lastrowid)
        _sync_image_path_identity(
            conn.cursor(),
            wsl_id,
            "/mnt/c/Library/A.png",
        )

    db.set_favorite(windows_id, True)

    assert set(db.get_favorite_source_ids()) == {windows_id, wsl_id}
    assert db.get_favorites_count() == 2
    assert db.is_favorited(windows_id)
    assert db.is_favorited(wsl_id)

    favorites_id = db.get_favorites_collection_id()
    filtered_ids = {
        image["id"]
        for image in db.get_images(collection_id=favorites_id, limit=100)
    }
    assert filtered_ids == {windows_id, wsl_id}

    db.set_favorite(wsl_id, False)

    assert db.get_favorite_source_ids() == []
    assert not db.is_favorited(windows_id)
    assert not db.is_favorited(wsl_id)


def test_sharp_s_windows_favorite_persists_casefold_identity(test_db):
    old_id = db.add_image(path=r"C:\Library\ẞ.png", filename="ẞ.png")

    db.set_favorite(old_id, True)

    with db.get_db() as conn:
        identity = conn.execute(
            "SELECT path_key, match_case FROM favorite_paths"
        ).fetchone()
        conn.execute("DELETE FROM images WHERE id = ?", (old_id,))

    assert tuple(identity) == (r"c:\library\ss.png", 0)

    new_id = db.add_image(path=r"c:\library\ß.png", filename="ß.png")

    assert db.get_favorite_source_ids() == [new_id]
    assert db.is_favorited(new_id)


def test_app_path_writes_keep_materialized_identity_in_sync(test_db):
    image_id = db.add_image(path=r"C:\Library\Ä.png", filename="Ä.png")

    with db.get_db() as conn:
        initial = conn.execute(
            "SELECT path_key FROM image_path_identities WHERE image_id = ?",
            (image_id,),
        ).fetchone()
    assert initial[0] == r"c:\library\ä.png"

    db.update_image_path(image_id, "/mnt/c/Moved/ẞ.png")

    with db.get_db() as conn:
        moved = conn.execute(
            "SELECT path_key FROM image_path_identities WHERE image_id = ?",
            (image_id,),
        ).fetchone()
    assert moved[0] == r"c:\moved\ss.png"

    db.reconnect_image_source_path(image_id, r"D:\Restored\Ä.png")

    with db.get_db() as conn:
        restored = conn.execute(
            "SELECT path_key FROM image_path_identities WHERE image_id = ?",
            (image_id,),
        ).fetchone()
    assert restored[0] == r"d:\restored\ä.png"


def test_favorites_browse_and_count_are_path_resolved(test_db):
    image_id = db.add_image(path="/lib/b.png", filename="b.png")
    db.set_favorite(image_id, True)

    favorites = db.get_collection_by_slug("favorites")
    assert db.get_collection_image_ids(favorites["id"]) == [image_id]

    by_slug = {c["slug"]: c for c in db.list_collections()}
    assert by_slug["favorites"]["item_count"] == 1


def test_case_sensitive_paths_have_independent_favorite_state(test_db):
    upper_id = db.add_image(path="/lib/A.png", filename="A.png")
    lower_id = db.add_image(path="/lib/a.png", filename="a.png")

    db.set_favorite(upper_id, True)

    assert db.get_favorite_source_ids() == [upper_id]
    assert db.get_favorites_count() == 1
    assert db.is_favorited(upper_id)
    assert not db.is_favorited(lower_id)

    db.set_favorite(lower_id, True)
    db.set_favorite(upper_id, False)

    assert db.get_favorite_source_ids() == [lower_id]
    assert db.get_favorites_count() == 1
    assert not db.is_favorited(upper_id)
    assert db.is_favorited(lower_id)


def test_legacy_casefold_anchor_promotes_before_case_sensitive_toggle(test_db):
    upper_id = db.add_image(path="/legacy/A.png", filename="A.png")
    lower_id = db.add_image(path="/legacy/a.png", filename="a.png")
    with db.get_db() as conn:
        conn.execute(
            "INSERT INTO favorite_paths (path_key, match_case) VALUES (?, 0)",
            ("/legacy/a.png",),
        )

    assert set(db.get_favorite_source_ids()) == {upper_id, lower_id}

    db.set_favorite(upper_id, True)
    assert set(db.get_favorite_source_ids()) == {upper_id, lower_id}

    db.set_favorite(upper_id, False)
    assert db.get_favorite_source_ids() == [lower_id]


def test_unicode_legacy_anchor_is_retained_without_materialization_target(test_db):
    legacy_key = "/legacy/ä.png"
    with db.get_db() as conn:
        conn.execute(
            "INSERT INTO favorite_paths (path_key, match_case) VALUES (?, 0)",
            (legacy_key,),
        )
        _promote_legacy_favorite_identities(conn.cursor(), [legacy_key])

    with db.get_db() as conn:
        row = conn.execute(
            "SELECT path_key, match_case FROM favorite_paths"
        ).fetchone()

    assert tuple(row) == (legacy_key, 0)


def test_unicode_legacy_anchor_materializes_case_variant_image(test_db):
    image_id = db.add_image(path="/legacy/Ä.png", filename="Ä.png")
    with db.get_db() as conn:
        conn.execute(
            "INSERT INTO favorite_paths (path_key, match_case) VALUES (?, 0)",
            ("/legacy/ä.png",),
        )

    db.set_favorite(image_id, True)

    with db.get_db() as conn:
        rows = conn.execute(
            "SELECT path_key, match_case FROM favorite_paths"
        ).fetchall()

    assert [tuple(row) for row in rows] == [("/legacy/Ä.png", 1)]


def test_sqlite_unicode_legacy_anchor_promotes_to_exact_identity(test_db):
    image_id = db.add_image(path="/legacy/Ä.png", filename="Ä.png")
    with db.get_db() as conn:
        conn.execute(
            "INSERT INTO favorite_paths (path_key, match_case) VALUES (?, 0)",
            ("/legacy/Ä.png",),
        )

    db.set_favorite(image_id, True)

    with db.get_db() as conn:
        rows = conn.execute(
            "SELECT path_key, match_case FROM favorite_paths"
        ).fetchall()

    assert [tuple(row) for row in rows] == [("/legacy/Ä.png", 1)]


def test_favorite_identity_query_uses_exact_and_casefold_path_indexes(test_db):
    with db.get_db() as conn:
        plan_lines = [
            str(row[3])
            for row in conn.execute(
                f"EXPLAIN QUERY PLAN {_favorite_image_ids_query()}"
            )
        ]

    plan = "\n".join(plan_lines)
    assert "sqlite_autoindex_images_1 (path=?)" in plan
    assert "idx_image_path_identities_path_key (path_key=?)" in plan
    assert "SCAN i" not in plan
    assert "idx_images_path_casefold" not in plan


def test_unicode_favorite_query_does_not_walk_unrelated_images(test_db):
    image_id = db.add_image(path=r"C:\Library\ẞ.png", filename="ẞ.png")
    db.set_favorite(image_id, True)

    with db.get_db() as conn:
        conn.executemany(
            "INSERT INTO images (path, filename) VALUES (?, ?)",
            (
                (f"/unrelated/image-{index:05d}.png", f"image-{index:05d}.png")
                for index in range(5000)
            ),
        )
        progress_calls = 0

        def count_progress_calls() -> int:
            nonlocal progress_calls
            progress_calls += 1
            return 0

        conn.set_progress_handler(count_progress_calls, 100)
        try:
            count = conn.execute(
                f"SELECT COUNT(DISTINCT id) FROM ({_favorite_image_ids_query()})"
            ).fetchone()[0]
        finally:
            conn.set_progress_handler(None, 0)

    assert count == 1
    assert progress_calls < 20


def test_ascii_windows_path_lookup_uses_only_native_indexes(test_db):
    clause, params = _path_query_match_clause([r"C:\Library\Keep.png"])

    assert "indexed_path_casefold" not in clause
    assert "LOWER(path)" in clause

    with db.get_db() as conn:
        plan_lines = [
            str(row[3])
            for row in conn.execute(
                f"EXPLAIN QUERY PLAN SELECT id FROM images WHERE {clause}",
                params,
            )
        ]

    plan = "\n".join(plan_lines)
    assert "sqlite_autoindex_images_1 (path=?)" in plan
    assert "USING INDEX idx_images_path_lower" in plan


def test_unicode_windows_path_lookup_keeps_casefold_fallback(test_db):
    clause, _ = _path_query_match_clause([r"C:\Library\ä.png"])

    assert "LOWER(path)" in clause
    assert "image_path_identities" in clause
    assert "indexed_path_casefold(path)" not in clause


def test_ascii_windows_folder_lookup_avoids_casefold_scan(test_db):
    clause, _ = _folder_scope_query_match_clause(
        r"C:\Library",
        column="i.path",
    )

    assert "LOWER(i.path)" in clause
    assert "indexed_path_casefold" not in clause
