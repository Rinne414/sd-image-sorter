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

    def test_add_preserves_case_sensitive_posix_roots(self, test_db):
        upper = db.add_library_root("/library/Case", label="Upper")
        lower = db.add_library_root("/library/case", label="Lower")

        assert upper is not None
        assert lower is not None
        assert upper["id"] != lower["id"]
        assert {root["path_key"] for root in db.list_library_roots()} == {
            "/library/Case",
            "/library/case",
        }

    def test_add_merges_windows_and_wsl_unicode_identity(self, test_db):
        windows = db.add_library_root("C:/Pictures/ẞ", label="Shared")
        wsl = db.add_library_root("/mnt/c/pictures/ss/")

        assert windows is not None
        assert wsl is not None
        assert wsl["id"] == windows["id"]
        assert wsl["path"] == "/mnt/c/pictures/ss"
        assert wsl["label"] == "Shared"
        assert len(db.list_library_roots()) == 1

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

    def test_touch_scanned_matches_posix_path_case_exactly(self, test_db):
        upper = db.add_library_root("/library/Case")
        lower = db.add_library_root("/library/case")
        assert upper is not None
        assert lower is not None

        db.touch_library_root_scanned("/library/case")

        assert db.get_library_root(upper["id"])["last_scanned_at"] is None
        assert db.get_library_root(lower["id"])["last_scanned_at"] is not None

    def test_record_scan_registers_root_and_timestamp_atomically(self, test_db):
        existing = db.add_library_root("L:/Pics/Anime", label="Anime")
        assert existing is not None
        assert db.set_library_root_enabled(existing["id"], False) is True

        scanned = db.record_library_root_scan("l:/pics/anime/")

        roots = db.list_library_roots()
        assert len(roots) == 1
        assert scanned == roots[0]
        assert scanned["path"] == "l:/pics/anime"
        assert scanned["label"] == "Anime"
        assert scanned["enabled"] == 0
        assert scanned["last_scanned_at"] is not None

    def test_record_scan_preserves_case_sensitive_posix_root(self, test_db):
        existing = db.add_library_root("/library/Case", label="Upper")
        assert existing is not None
        assert db.set_library_root_enabled(existing["id"], False) is True

        scanned = db.record_library_root_scan("/library/case")

        assert scanned["id"] != existing["id"]
        assert scanned["path"] == "/library/case"
        assert scanned["label"] is None
        assert scanned["enabled"] == 1
        assert len(db.list_library_roots()) == 2
