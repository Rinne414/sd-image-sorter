"""Characterization pins for services/sorting_service.py (decomposition step 0).

These lock the CROSS-MODULE CONTRACT and the uncovered load-bearing behavior of
``SortingService`` before the 3,615-line module is split into a package. They are
NOT feature tests: quirks are pinned AS-IS (with comments) so a later refactor
that changes behavior fails loudly instead of drifting silently.

The existing suites (tests/test_routers/test_sorting.py + the four regression
files) are a strong net for the ROUTER-level happy paths, but they:
  * monkeypatch ``_filter_readable_image_ids`` and ``_apply_file_operation`` away,
    leaving the real safety bodies uncovered;
  * never exercise the move/batch cancel+reset idle branches, ``browse_folder``,
    or the copy-vs-move file-operation contract directly.

Isolation rule (hard-won): no dependency on machine state. Every DB / filesystem
/ image-decode touch is monkeypatched at the module-global seam, and the session
file + library-health cache are redirected/reset per test.
"""

from __future__ import annotations

import threading

import pytest
from fastapi import HTTPException

import services.sorting_service as ss


@pytest.fixture(autouse=True)
def _isolate_module_state(tmp_path, monkeypatch):
    """Redirect the persisted-session files and reset the health cache per test.

    None of the pins below intentionally write a session file, but redirecting
    ``SESSION_FILE`` / ``LEGACY_SESSION_FILE`` at the module global keeps any
    accidental persistence off the real data dir.
    """
    monkeypatch.setattr(ss, "SESSION_FILE", str(tmp_path / "sess.json"), raising=False)
    monkeypatch.setattr(
        ss, "LEGACY_SESSION_FILE", str(tmp_path / "legacy.json"), raising=False
    )
    ss.invalidate_library_health_cache()
    yield
    ss.invalidate_library_health_cache()


@pytest.fixture
def svc():
    """A fresh SortingService. __init__ touches no DB and no disk (pinned below)."""
    return ss.SortingService()


# ---------------------------------------------------------------------------
# 1. Public surface — must survive the split verbatim.
# ---------------------------------------------------------------------------
class TestPublicSurface:
    def test_public_symbols_are_importable_from_the_module(self):
        # SortingService + the library-health cache invalidator are the two
        # non-model public names; the rest are re-exports from sorting_models /
        # sorting_session_store that the facade forwards.
        assert isinstance(ss.SortingService, type)
        assert callable(ss.invalidate_library_health_cache)
        for name in (
            "BatchMoveRequest",
            "BrowseFolderRequest",
            "FolderConfig",
            "ManualSortStartRequest",
            "MoveRequest",
            "ScanRequest",
            "ValidatePathRequest",
        ):
            assert isinstance(getattr(ss, name), type), name
        # Sort-mode constants + persisted schema version are part of __all__.
        assert ss.SORT_MODE_SLOT == "slot"
        assert ss.SORT_MODE_BRACKET == "bracket"
        assert ss.SORT_MODE_CULL == "cull"
        assert ss.SORT_MODE_DEFAULT == ss.SORT_MODE_SLOT
        assert isinstance(ss.SORT_SESSION_SCHEMA_VERSION, int)

    def test_all_exports_match_the_pinned_set(self):
        # If the split changes what the facade re-exports, this fails so the
        # change is deliberate.
        assert set(ss.__all__) == {
            "BatchMoveRequest",
            "BrowseFolderRequest",
            "FolderConfig",
            "ManualSortStartRequest",
            "MoveRequest",
            "ScanRequest",
            "SORT_MODE_BRACKET",
            "SORT_MODE_CULL",
            "SORT_MODE_DEFAULT",
            "SORT_MODE_SLOT",
            "SORT_SESSION_SCHEMA_VERSION",
            "SortingService",
            "ValidatePathRequest",
            "invalidate_library_health_cache",
        }


# ---------------------------------------------------------------------------
# 2. Monkeypatch seams — the split must keep these resolvable on the top module.
# ---------------------------------------------------------------------------
class TestPatchSeams:
    def test_reimported_name_seams_are_module_attributes(self):
        # These are bound at import time via ``from X import name`` and are
        # patched by the existing suite as ``services.sorting_service.<name>``.
        # A split that relocates their definitions must keep the NAME here or
        # every monkeypatch that targets it silently stops working (the
        # verify_image_readable trap from the metadata_parser split).
        for name in (
            "verify_image_readable",
            "scan_folder",
            "move_image",
            "copy_image",
            "parse_metadata_job",
            "add_images_batch",
        ):
            assert hasattr(ss, name), name

    def test_module_global_tuning_and_state_seams_present(self):
        assert hasattr(ss, "db")
        assert hasattr(ss, "time")
        assert hasattr(ss, "os")
        assert hasattr(ss, "entry_stats_service")
        assert isinstance(ss.BATCH_MOVE_FETCH_CHUNK, int)
        assert isinstance(ss.SCAN_LOG_HEARTBEAT_SECONDS, float)
        assert isinstance(ss.SCAN_UI_STALLED_SECONDS, float)
        # Library-health cache lives at module scope (existing suite imports
        # both names directly) — the split must not move it onto the instance.
        assert isinstance(ss._LIBRARY_HEALTH_CACHE, dict)
        assert ss._LIBRARY_HEALTH_CACHE_LOCK is not None

    def test_verify_image_readable_patch_is_observed_by_consumer(
        self, svc, monkeypatch
    ):
        # Prove the re-imported-name seam: patching it on THIS module is what
        # the interactive move/sort paths observe.
        marks: list = []
        monkeypatch.setattr(
            ss, "verify_image_readable", lambda _p: (False, "patched-unreadable")
        )
        monkeypatch.setattr(svc, "_resolve_image_path", lambda p: p or None)
        monkeypatch.setattr(
            ss.db, "mark_image_unreadable", lambda i, e: marks.append((i, e))
        )

        result = svc._move_one_image(
            7, {"path": "/x/a.png", "filename": "a.png"}, "move", "/dest"
        )

        assert result == {
            "id": 7,
            "error": "patched-unreadable",
            "operation": "move",
            "success": False,
        }
        assert marks == [(7, "patched-unreadable")]


# ---------------------------------------------------------------------------
# 3. Copy-vs-move file-operation contract (SAFETY invariant).
# ---------------------------------------------------------------------------
class TestFileOperationSafety:
    @pytest.mark.parametrize(
        "value,expected",
        [
            (None, "move"),
            ("", "move"),
            ("move", "move"),
            ("MOVE", "move"),
            ("copy", "copy"),
            ("Copy", "copy"),
            ("  copy  ", "copy"),
        ],
    )
    def test_validate_file_operation_defaults_to_move(self, svc, value, expected):
        assert svc._validate_file_operation(value) == expected

    def test_validate_file_operation_rejects_unknown_with_400(self, svc):
        with pytest.raises(HTTPException) as exc:
            svc._validate_file_operation("delete")
        assert exc.value.status_code == 400

    def test_apply_move_returns_no_new_image_id(self, svc, monkeypatch):
        calls = {}

        def fake_move(image_id, destination_folder, source_path):
            calls["args"] = (image_id, destination_folder, source_path)
            return "/dest/m.png"

        monkeypatch.setattr(ss, "move_image", fake_move)
        result = svc._apply_file_operation(
            operation="move",
            image_id=3,
            destination_folder="/dest",
            source_path="/src/m.png",
        )
        assert result == {
            "operation": "move",
            "new_path": "/dest/m.png",
            "new_image_id": None,
        }
        assert calls["args"] == (3, "/dest", "/src/m.png")

    def test_apply_copy_is_file_only_but_reports_copy_row_id(self, svc, monkeypatch):
        # v3.5.0 owner decision: a copy is NOT indexed, but ``_apply_file_operation``
        # still surfaces whatever id copy_image returns (kept as the copied-row
        # bookkeeping id for undo). Move sets new_image_id None; copy forwards it.
        def fake_copy(image_id, destination_folder, image_path):
            return {"new_path": destination_folder + "/c.png", "new_image_id": 99}

        monkeypatch.setattr(ss, "copy_image", fake_copy)
        result = svc._apply_file_operation(
            operation="copy",
            image_id=5,
            destination_folder="/dest",
            source_path="/src/c.png",
        )
        assert result == {
            "operation": "copy",
            "new_path": "/dest/c.png",
            "new_image_id": 99,
        }


# ---------------------------------------------------------------------------
# 4. _filter_readable_image_ids — fully uncovered safety helper (902-930).
# ---------------------------------------------------------------------------
class TestFilterReadableImageIds:
    def test_empty_input_returns_two_empty_lists(self, svc):
        assert svc._filter_readable_image_ids([]) == ([], [])

    def test_keeps_readable_marks_unreadable_and_missing_path(self, svc, monkeypatch):
        images_map = {
            1: {"path": "/a/1.png", "filename": "1.png"},
            2: {"path": "/a/2.png", "filename": "2.png"},
            3: {"path": "", "filename": "3.png"},  # empty path -> not found
        }
        marks: list = []
        monkeypatch.setattr(ss.db, "get_images_by_ids", lambda ids: images_map)
        monkeypatch.setattr(
            ss.db, "mark_image_unreadable", lambda i, e: marks.append((i, e))
        )
        monkeypatch.setattr(svc, "_resolve_image_path", lambda p: p or None)
        monkeypatch.setattr(
            ss,
            "verify_image_readable",
            lambda p: (True, None) if p == "/a/1.png" else (False, "corrupt"),
        )

        # id 4 has no row in images_map at all.
        filtered, skipped = svc._filter_readable_image_ids([1, 2, 3, 4])

        assert filtered == [1]
        assert skipped == [
            {"image_id": 2, "filename": "2.png", "error": "corrupt"},
            {"image_id": 3, "filename": "3.png", "error": "File not found"},
        ]
        # id 1 kept -> not marked; id 4 DB-missing -> silently dropped, NOT marked.
        assert marks == [(2, "corrupt"), (3, "File not found")]


# ---------------------------------------------------------------------------
# 5. Move / batch-move cancel + reset idle branches (uncovered 716-810).
# ---------------------------------------------------------------------------
class TestCancelResetIdleBranches:
    def test_cancel_move_idle_is_noop(self, svc):
        assert svc.cancel_move() == {
            "status": "idle",
            "message": "No move task is running",
        }

    def test_cancel_batch_move_idle_is_noop(self, svc):
        assert svc.cancel_batch_move() == {
            "status": "idle",
            "message": "No batch move task is running",
        }

    def test_reset_move_idle_message(self, svc):
        assert svc.reset_move_progress() == {
            "status": "idle",
            "message": "Nothing to reset",
        }

    def test_reset_batch_move_idle_message(self, svc):
        assert svc.reset_batch_move_progress() == {
            "status": "idle",
            "message": "Nothing to reset",
        }

    def test_reset_move_while_running_conflicts_409(self, svc):
        svc._move_progress["status"] = "running"
        with pytest.raises(HTTPException) as exc:
            svc.reset_move_progress()
        assert exc.value.status_code == 409

    def test_reset_batch_move_while_running_conflicts_409(self, svc):
        svc._batch_move_progress["status"] = "running"
        with pytest.raises(HTTPException) as exc:
            svc.reset_batch_move_progress()
        assert exc.value.status_code == 409

    def test_cancel_move_running_sets_event_and_cancelling(self, svc):
        event = threading.Event()
        svc._move_progress["status"] = "running"
        svc._move_cancel_event = event

        result = svc.cancel_move()

        assert result == {
            "status": "cancelling",
            "message": "Move cancellation requested",
        }
        assert event.is_set() is True
        assert svc._move_progress["status"] == "cancelling"

    def test_cancel_batch_move_running_sets_event_and_cancelling(self, svc):
        event = threading.Event()
        svc._batch_move_progress["status"] = "running"
        svc._batch_move_cancel_event = event

        result = svc.cancel_batch_move()

        assert result == {
            "status": "cancelling",
            "message": "Batch move cancellation requested",
        }
        assert event.is_set() is True
        assert svc._batch_move_progress["status"] == "cancelling"


# ---------------------------------------------------------------------------
# 6. Coercion quirks (per-slot collections + session state clamping).
# ---------------------------------------------------------------------------
class TestCoercionQuirks:
    @pytest.mark.parametrize("bad", [None, "x", [1, 2], 5])
    def test_collection_slots_non_dict_becomes_empty(self, svc, bad):
        assert svc._coerce_collection_slots(bad) == {}

    def test_collection_slot_value_normalization(self, svc):
        out = svc._coerce_collection_slots(
            {"a": None, "b": "", "c": 5, "d": "7", "e": 0, "f": -3, "g": "xyz"}
        )
        # None / "" -> None (explicit folder slot); 0 / negative / non-numeric -> None;
        # positive int or numeric string -> the int.
        assert out == {
            "a": None,
            "b": None,
            "c": 5,
            "d": 7,
            "e": None,
            "f": None,
            "g": None,
        }

    def test_collection_slot_overlong_key_dropped(self, svc):
        out = svc._coerce_collection_slots({"k" * 101: 5, "ok": 9})
        assert out == {"ok": 9}

    def test_sort_session_mode_and_index_clamping(self, svc):
        out = svc._coerce_sort_session_state(
            {
                "active": 1,
                "mode": "unknown-mode",
                "image_ids": [10, 20, 30],
                "current_index": 99,  # clamp to len == 3
                "champion_index": 99,  # clamp to len - 1 == 2
            }
        )
        assert out["active"] is True
        assert out["mode"] == ss.SORT_MODE_DEFAULT  # unknown -> slot
        assert out["current_index"] == 3
        assert out["champion_index"] == 2
        assert out["operation_mode"] == "move"

    @pytest.mark.parametrize("value,expected", [(-5, 0), ("abc", 0), (None, 0)])
    def test_sort_session_current_index_defaults(self, svc, value, expected):
        out = svc._coerce_sort_session_state(
            {"image_ids": [1, 2], "current_index": value}
        )
        assert out["current_index"] == expected

    def test_sort_session_bad_operation_mode_raises_400(self, svc):
        # Coercion is not total: an unsupported operation_mode raises rather than
        # defaulting, because it routes through _validate_file_operation.
        with pytest.raises(HTTPException) as exc:
            svc._coerce_sort_session_state({"operation_mode": "garbage"})
        assert exc.value.status_code == 400


# ---------------------------------------------------------------------------
# 7. browse_folder — uncovered public entry (3527-3611).
# ---------------------------------------------------------------------------
class TestBrowseFolder:
    def test_lists_visible_subdirs_sorted_and_hides_dotfiles(self, svc, tmp_path):
        (tmp_path / "sub_b").mkdir()
        (tmp_path / "sub_a").mkdir()
        (tmp_path / ".hidden").mkdir()
        (tmp_path / "sub_a" / "child").mkdir()  # gives sub_a has_children True

        result = svc.browse_folder(str(tmp_path))

        names = [d["name"] for d in result["subdirs"]]
        assert names == ["sub_a", "sub_b"]  # sorted case-insensitive, .hidden excluded
        by_name = {d["name"]: d for d in result["subdirs"]}
        assert by_name["sub_a"]["has_children"] is True
        assert by_name["sub_b"]["has_children"] is False
        assert result["parent"] is not None

    def test_missing_path_raises_400(self, svc, tmp_path):
        with pytest.raises(HTTPException) as exc:
            svc.browse_folder(str(tmp_path / "does-not-exist"))
        assert exc.value.status_code == 400


# ---------------------------------------------------------------------------
# 8. Path-safety helpers (drop-resolution hardening).
# ---------------------------------------------------------------------------
class TestPathSafetyHelpers:
    @pytest.mark.parametrize(
        "name,ok",
        [
            ("photos", True),
            ("2026_05_29", True),
            ("", False),
            (".", False),
            ("..", False),
            ("a/b", False),
            ("a\\b", False),
            ("C:", False),
            ("a\x01b", False),
        ],
    )
    def test_is_safe_folder_segment(self, svc, name, ok):
        assert svc._is_safe_folder_segment(name) is ok

    def test_escape_like_escapes_wildcards(self, svc):
        assert svc._escape_like("a%b_c") == "a\\%b\\_c"
        assert svc._escape_like("a\\b") == "a\\\\b"


# ---------------------------------------------------------------------------
# 9. Library-health cache — module-global TTL cache (clamp + invalidation).
# ---------------------------------------------------------------------------
class TestLibraryHealthCache:
    def test_sample_limit_clamped_and_result_cached(self, monkeypatch):
        calls: list = []

        def fake_report(sample_limit):
            calls.append(sample_limit)
            return {"sample_limit": sample_limit}

        monkeypatch.setattr(ss.db, "get_library_health_report", fake_report)
        ss.invalidate_library_health_cache()

        # 100 clamps to 25; second identical call is served from cache.
        first = ss._get_library_health_cached(100)
        second = ss._get_library_health_cached(100)
        assert first == {"sample_limit": 25}
        assert second == {"sample_limit": 25}
        assert calls == [25]  # only one underlying compute
        # 0 clamps up to 1.
        assert ss._get_library_health_cached(0) == {"sample_limit": 1}

    def test_invalidate_clears_the_module_cache(self, monkeypatch):
        monkeypatch.setattr(
            ss.db, "get_library_health_report", lambda sample_limit: {"n": sample_limit}
        )
        ss._get_library_health_cached(4)
        assert 4 in ss._LIBRARY_HEALTH_CACHE
        ss.invalidate_library_health_cache()
        assert ss._LIBRARY_HEALTH_CACHE == {}


# ---------------------------------------------------------------------------
# 10. Statefulness verdict — instances own independent mutable state.
# ---------------------------------------------------------------------------
class TestStatefulness:
    def test_instances_do_not_share_progress_or_session_state(self):
        a = ss.SortingService()
        b = ss.SortingService()
        assert a._scan_progress is not b._scan_progress
        assert a._sort_session is not b._sort_session

        a.set_scan_progress({"status": "running", "message": "a-only"})
        assert a.get_scan_progress()["status"] == "running"
        assert b.get_scan_progress()["status"] == "idle"
