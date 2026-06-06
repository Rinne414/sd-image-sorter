"""Favorites are anchored by file path (migration 017 + db_collections) so they
survive a library Clear / rescan that re-IDs images. Covers set_favorite and the
path-resolved reads (get_favorite_source_ids / is_favorited / count / browse).
"""
import database as db


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


def test_favorites_browse_and_count_are_path_resolved(test_db):
    image_id = db.add_image(path="/lib/b.png", filename="b.png")
    db.set_favorite(image_id, True)

    favorites = db.get_collection_by_slug("favorites")
    assert db.get_collection_image_ids(favorites["id"]) == [image_id]

    by_slug = {c["slug"]: c for c in db.list_collections()}
    assert by_slug["favorites"]["item_count"] == 1
