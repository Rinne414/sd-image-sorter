"""Tests for library-root persistence (v3.3.2 Library Navigation — multi-root foundation).

Covers the case-insensitive idempotent registry that backs multi-root management
and idle auto-refresh: add/list/get/remove/enable/touch, exercised through the
``database`` facade re-exports.
"""
import database as db


class TestLibraryRoots:
    def test_add_normalizes_and_lists(self, test_db):
        row = db.add_library_root("L:\\Pics\\Anime", label="Anime")
        assert row is not None
        assert row["path"] == "L:/Pics/Anime"  # backslashes normalized to forward
        assert row["label"] == "Anime"
        assert row["enabled"] == 1
        assert row["added_at"]  # ISO-8601 stamp present

        roots = db.list_library_roots()
        assert [r["path"] for r in roots] == ["L:/Pics/Anime"]

    def test_add_is_idempotent_case_insensitive(self, test_db):
        db.add_library_root("L:/Pics/Anime")
        # Different case + trailing slash must resolve to the same root.
        again = db.add_library_root("l:/pics/anime/")
        assert again is not None
        roots = db.list_library_roots()
        assert len(roots) == 1

    def test_blank_path_is_ignored(self, test_db):
        assert db.add_library_root("   ") is None
        assert db.list_library_roots() == []

    def test_remove_returns_status_and_keeps_idempotent(self, test_db):
        row = db.add_library_root("L:/Pics/Anime")
        assert db.remove_library_root(row["id"]) is True
        assert db.list_library_roots() == []
        # Removing a non-existent root reports False rather than raising.
        assert db.remove_library_root(row["id"]) is False

    def test_enable_disable_toggles_flag(self, test_db):
        row = db.add_library_root("L:/Pics/Anime")
        assert db.set_library_root_enabled(row["id"], False) is True
        assert db.get_library_root(row["id"])["enabled"] == 0
        assert db.set_library_root_enabled(row["id"], True) is True
        assert db.get_library_root(row["id"])["enabled"] == 1

    def test_touch_scanned_matches_case_insensitively(self, test_db):
        db.add_library_root("L:/Pics/Anime")
        assert db.list_library_roots()[0]["last_scanned_at"] is None
        db.touch_library_root_scanned("l:/pics/anime")  # different case still matches
        assert db.list_library_roots()[0]["last_scanned_at"] is not None
