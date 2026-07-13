"""Characterization pins for ``services/dataset_export_service.py`` (TIER-2 step 0).

These lock the load-bearing behavior the existing reader suites
(test_dataset_export / _contract / _manifest / _path_mode / test_kohya_handoff /
test_mask_service / test_underscore_normalize_filename_pairing) leave uncovered,
so a later decomposition of this 1.7k-line god-file can be proven behavior-neutral.

Focus areas (baseline coverage was 82%):
  * The module-level JOB-REGISTRY state machine (``_EXPORT_JOB_PROGRESS`` &co) —
    five module globals with real ``global`` reassignments. This is the #1
    decomposition hazard: if a split moves any writer to a sibling module and
    re-exports the globals with ``from x import _EXPORT_JOB_PROGRESS``, the
    reassignment stops propagating and progress/cancel silently desync. The pins
    here assert cross-function propagation through the single module namespace.
  * Response-shape constants + the three response Pydantic model field sets
    (mirrors the HTTP contract in test_dataset_contract at the unit level).
  * Pure planning / naming / path-safety helpers and their error branches.
  * Caption composition + template-option assembly quirks.
  * Manifest + kohya-TOML writer edges beyond test_kohya_handoff.
  * Streaming ``export_dataset`` invariants exercised via a DB-free path-source
    request: item-truncation cap, error-message cap, cancel short-circuit,
    duplicate skip, unreadable-path error, and the copy-never-touches-original /
    move-removes-source safety invariants.

No existing file is modified. All pins run against the live module with no
network, no model load, and no images.db writes (path-source only; the single
``db`` seam is monkeypatched).
"""

from __future__ import annotations

import sys
import threading
from pathlib import Path

import pytest
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import services.dataset_export_service as des
from services.dataset_export_service import (
    DatasetExportItemResult,
    DatasetExportRequest,
    DatasetExportResponse,
    DatasetExportStartResponse,
)


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #


def _make_image(path: Path, color=(40, 80, 120)) -> Path:
    Image.new("RGB", (32, 32), color=color).save(path)
    return path


def _req(**kw) -> DatasetExportRequest:
    """Build an export request with export-friendly defaults."""
    base = dict(naming_pattern="{filename}", image_op="copy", overwrite_policy="unique")
    base.update(kw)
    return DatasetExportRequest(**base)


# =========================================================================== #
# 1. Response-shape constants + model field sets  (unit twin of the HTTP
#    contract in test_dataset_contract). A refactor that renames a constant or
#    reshapes a response model trips here before it leaks to the frontend.
# =========================================================================== #


class TestShapeConstants:
    def test_item_and_error_and_chunk_limits_are_pinned(self):
        assert des.DATASET_EXPORT_RESPONSE_ITEM_LIMIT == 2_000
        assert des.DATASET_EXPORT_RECENT_ERROR_LIMIT == 20
        assert des.DATASET_EXPORT_DB_CHUNK_SIZE == 500

    def test_manifest_constants_are_pinned(self):
        assert des.EXPORT_MANIFEST_FILENAME == "export_manifest.json"
        assert des.EXPORT_MANIFEST_VERSION == 1

    def test_legacy_template_literal_is_pinned(self):
        assert des.DATASET_LEGACY_TEMPLATE == "{trigger}, {tags:filtered}, {append}"

    def test_valid_enum_sets_are_pinned(self):
        assert des.VALID_IMAGE_OPS == {"copy", "move"}
        assert des.VALID_OVERWRITE_POLICIES == {"unique", "overwrite", "skip"}
        assert des.VALID_MASK_EXPORT_MODES == ("none", "onetrainer", "kohya")
        assert des.VALID_TRAINER_CONFIGS == ("none", "kohya_toml")
        assert des.TRAINING_TAG_CONTENT_MODES == {
            "tags",
            "caption_tags",
            "caption_merged",
            "tags_nl",
        }

    def test_active_statuses_set_is_pinned(self):
        # The cancel / start guards read this exact set to decide "already
        # running" (409) vs "nothing to cancel".
        assert des._EXPORT_ACTIVE_STATUSES == {"starting", "running", "cancelling"}

    def test_nl_compose_modes_alias_matches_shared_engine(self):
        # dataset export and tag export must gate NL-composition identically.
        from services.tag_export_service import NL_COMPOSE_MODES

        assert des._NL_COMPOSE_MODES is NL_COMPOSE_MODES
        assert des._NL_COMPOSE_MODES == {"template", "tags"}

    def test_export_response_model_fields_are_pinned(self):
        assert set(DatasetExportResponse.model_fields) == {
            "status",
            "exported",
            "skipped",
            "error_count",
            "masks_written",
            "masks_missing",
            "trainer_config_path",
            "output_folder",
            "output_mode",
            "items",
            "total_items",
            "items_truncated",
            "error_messages",
        }

    def test_export_item_model_fields_are_pinned(self):
        assert set(DatasetExportItemResult.model_fields) == {
            "image_id",
            "src_image_path",
            "dst_image_path",
            "dst_caption_path",
            "skipped_reason",
            "error",
        }

    def test_start_response_model_fields_are_pinned(self):
        assert set(DatasetExportStartResponse.model_fields) == {
            "status",
            "job_id",
            "total",
            "output_folder",
            "message",
        }


# =========================================================================== #
# 2. Job-registry state machine — THE dominant decomposition hazard.
#    Five module globals + `global` reassignments. Every pin restores them.
# =========================================================================== #


@pytest.fixture
def job_registry_reset():
    """Snapshot + restore the five job-registry module globals around a test.

    Machine-state isolation: these globals are shared with the real background
    export worker (test_dataset_export.py). Leaking a fake state would poison it.
    """
    saved = (
        des._EXPORT_JOB_RUN_ID,
        des._EXPORT_JOB_THREAD,
        des._EXPORT_JOB_CANCEL_EVENT,
        dict(des._EXPORT_JOB_PROGRESS),
    )
    try:
        yield
    finally:
        des._EXPORT_JOB_RUN_ID = saved[0]
        des._EXPORT_JOB_THREAD = saved[1]
        des._EXPORT_JOB_CANCEL_EVENT = saved[2]
        des._EXPORT_JOB_PROGRESS = saved[3]

    # sanity: the lock is never reassigned, only ever acquired
    assert isinstance(des._EXPORT_JOB_LOCK, type(threading.Lock()))


class TestJobRegistry:
    def test_all_five_globals_exist(self, job_registry_reset):
        assert isinstance(des._EXPORT_JOB_PROGRESS, dict)
        assert isinstance(des._EXPORT_JOB_RUN_ID, int)
        # thread / cancel-event are Optional and may be None at rest
        assert des._EXPORT_JOB_THREAD is None or isinstance(
            des._EXPORT_JOB_THREAD, threading.Thread
        )
        assert des._EXPORT_JOB_CANCEL_EVENT is None or isinstance(
            des._EXPORT_JOB_CANCEL_EVENT, threading.Event
        )

    def test_get_progress_idle_returns_snapshot_without_404(self, job_registry_reset):
        des._EXPORT_JOB_PROGRESS = {
            "status": "idle",
            "job_id": None,
            "recent_errors": [],
        }
        snap = des.get_dataset_export_progress()
        assert snap["status"] == "idle"
        # snapshot is a COPY (mutating it must not affect the live dict)
        snap["status"] = "mutated"
        assert des._EXPORT_JOB_PROGRESS["status"] == "idle"

    def test_get_progress_job_id_mismatch_raises_404(self, job_registry_reset):
        from fastapi import HTTPException

        des._EXPORT_JOB_PROGRESS = {
            "status": "running",
            "job_id": "abc",
            "recent_errors": [],
        }
        with pytest.raises(HTTPException) as exc:
            des.get_dataset_export_progress(job_id="different")
        assert exc.value.status_code == 404

    def test_get_progress_allows_query_when_no_active_job_id(self, job_registry_reset):
        # job_id None on the live progress means "any query is fine".
        des._EXPORT_JOB_PROGRESS = {
            "status": "idle",
            "job_id": None,
            "recent_errors": [],
        }
        snap = des.get_dataset_export_progress(job_id="whatever")
        assert snap["status"] == "idle"

    def test_cancel_when_idle_is_a_noop_not_an_error(self, job_registry_reset):
        des._EXPORT_JOB_PROGRESS = {
            "status": "idle",
            "job_id": None,
            "recent_errors": [],
        }
        des._EXPORT_JOB_CANCEL_EVENT = None
        out = des.cancel_dataset_export()
        assert out["status"] == "idle"
        assert out["message"] == "No dataset export job is running."

    def test_cancel_job_id_mismatch_raises_404(self, job_registry_reset):
        from fastapi import HTTPException

        des._EXPORT_JOB_PROGRESS = {
            "status": "running",
            "job_id": "abc",
            "recent_errors": [],
        }
        with pytest.raises(HTTPException) as exc:
            des.cancel_dataset_export(job_id="nope")
        assert exc.value.status_code == 404

    def test_cancel_active_sets_event_and_flips_status_to_cancelling(
        self, job_registry_reset
    ):
        event = threading.Event()
        des._EXPORT_JOB_CANCEL_EVENT = event
        des._EXPORT_JOB_PROGRESS = {
            "status": "running",
            "job_id": "abc",
            "current": 2,
            "total": 5,
            "recent_errors": [],
        }
        out = des.cancel_dataset_export(job_id="abc")
        assert out["status"] == "cancelling"
        assert event.is_set()
        # propagation through the single module namespace (decomposition tripwire)
        assert des.get_dataset_export_progress(job_id="abc")["status"] == "cancelling"

    def test_set_progress_if_current_true_and_stale(self, job_registry_reset):
        des._EXPORT_JOB_RUN_ID = 7
        des._EXPORT_JOB_PROGRESS = {"status": "running", "recent_errors": []}
        # matching run_id merges + stamps updated_at, returns True
        assert des._set_export_progress_if_current(7, {"message": "hi"}) is True
        assert des._EXPORT_JOB_PROGRESS["message"] == "hi"
        assert "updated_at" in des._EXPORT_JOB_PROGRESS
        # a stale worker's run_id is ignored (returns False, no mutation)
        before = dict(des._EXPORT_JOB_PROGRESS)
        assert des._set_export_progress_if_current(6, {"message": "stale"}) is False
        assert des._EXPORT_JOB_PROGRESS == before

    def test_set_progress_truncates_recent_errors_to_limit(self, job_registry_reset):
        des._EXPORT_JOB_RUN_ID = 3
        des._EXPORT_JOB_PROGRESS = {"status": "running", "recent_errors": []}
        many = [f"err-{i}" for i in range(50)]
        des._set_export_progress_if_current(3, {"recent_errors": many})
        kept = des._EXPORT_JOB_PROGRESS["recent_errors"]
        assert len(kept) == des.DATASET_EXPORT_RECENT_ERROR_LIMIT
        assert kept[-1] == "err-49"  # keeps the LAST N

    def test_clear_worker_only_when_run_id_and_event_match(self, job_registry_reset):
        event = threading.Event()
        des._EXPORT_JOB_RUN_ID = 9
        des._EXPORT_JOB_CANCEL_EVENT = event
        # wrong run_id -> untouched
        des._clear_export_worker_if_current(8, event)
        assert des._EXPORT_JOB_CANCEL_EVENT is event
        # wrong event object -> untouched
        des._clear_export_worker_if_current(9, threading.Event())
        assert des._EXPORT_JOB_CANCEL_EVENT is event
        # both match -> cleared to None
        des._clear_export_worker_if_current(9, event)
        assert des._EXPORT_JOB_CANCEL_EVENT is None

    def test_copy_progress_deep_copies_recent_errors(self, job_registry_reset):
        src = {"status": "running", "recent_errors": ["a", "b"], "result": None}
        out = des._copy_progress(src)
        assert out["recent_errors"] == ["a", "b"]
        assert out["recent_errors"] is not src["recent_errors"]
        assert out["result"] is None

    def test_copy_progress_serializes_response_result_to_dict(self, job_registry_reset):
        resp = DatasetExportResponse(
            status="ok",
            exported=1,
            skipped=0,
            error_count=0,
            output_folder="/x",
            items=[],
            error_messages=[],
        )
        out = des._copy_progress({"recent_errors": [], "result": resp})
        assert isinstance(out["result"], dict)
        assert out["result"]["status"] == "ok"

    def test_copy_progress_passes_dict_result_through(self, job_registry_reset):
        payload = {"status": "failed", "exported": 0}
        out = des._copy_progress({"recent_errors": [], "result": payload})
        assert out["result"] == payload


# =========================================================================== #
# 3. Pure planning / naming / path-safety helpers.
# =========================================================================== #


class TestPureHelpers:
    def test_iter_unique_image_ids_dedupes_and_drops_nonpositive_and_nonint(self):
        got = list(des._iter_unique_image_ids([3, 3, "5", 0, -2, "x", None, 5]))
        assert got == [3, 5]  # order preserved, dupes/<=0/garbage dropped

    def test_iter_chunks_batches_with_remainder(self):
        assert list(des._iter_chunks([1, 2, 3, 4, 5], 2)) == [[1, 2], [3, 4], [5]]
        assert list(des._iter_chunks([], 2)) == []

    def test_resolve_dataset_image_path_accepts_real_image(self, tmp_path):
        p = _make_image(tmp_path / "ok.png")
        assert des._resolve_dataset_image_path(str(p)) == str(p.resolve())

    def test_resolve_dataset_image_path_rejects_missing_dir_and_nonimage(
        self, tmp_path
    ):
        assert des._resolve_dataset_image_path("") is None
        assert des._resolve_dataset_image_path(str(tmp_path / "ghost.png")) is None
        assert des._resolve_dataset_image_path(str(tmp_path)) is None  # a directory
        txt = tmp_path / "note.txt"
        txt.write_text("x", encoding="utf-8")
        assert des._resolve_dataset_image_path(str(txt)) is None  # wrong extension

    def test_sidecar_extension_json_vs_txt(self):
        assert des._dataset_sidecar_extension("json") == ".json"
        assert des._dataset_sidecar_extension("JSON") == ".json"
        assert des._dataset_sidecar_extension("tags") == ".txt"
        assert des._dataset_sidecar_extension("") == ".txt"
        assert des._dataset_sidecar_extension(None) == ".txt"

    def test_allocate_sidecar_overwrite_always_returns_base(self, tmp_path):
        used: set[str] = set()
        (tmp_path / "s.txt").write_text("existing", encoding="utf-8")
        path, reason = des._allocate_sidecar_path(
            tmp_path, "s", ".txt", overwrite_policy="overwrite", used_paths=used
        )
        assert reason is None
        assert path == tmp_path / "s.txt"
        assert str(path.resolve()) in used

    def test_allocate_sidecar_skip_reports_existing(self, tmp_path):
        (tmp_path / "s.txt").write_text("existing", encoding="utf-8")
        path, reason = des._allocate_sidecar_path(
            tmp_path, "s", ".txt", overwrite_policy="skip", used_paths=set()
        )
        assert path is None and reason == "existing"

    def test_allocate_sidecar_unique_increments_suffix(self, tmp_path):
        (tmp_path / "s.txt").write_text("a", encoding="utf-8")
        (tmp_path / "s_1.txt").write_text("b", encoding="utf-8")
        path, reason = des._allocate_sidecar_path(
            tmp_path, "s", ".txt", overwrite_policy="unique", used_paths=set()
        )
        assert reason is None and path == tmp_path / "s_2.txt"

    def test_plan_single_rename_wraps_naming_error(self, tmp_path, monkeypatch):
        def boom(*a, **k):
            raise des.NamingError("bad token")

        monkeypatch.setattr(des, "render_stem", boom)
        img, cap, reason = des._plan_single_rename(
            {"filename": "a.png", "path": "a.png"},
            output_folder=tmp_path,
            pattern="{bogus}",
            trigger="",
            overwrite_policy="unique",
            caption_extension=".txt",
            index=1,
            used_image_paths=set(),
        )
        assert img is None and cap is None
        assert reason == "naming_error: bad token"

    def test_plan_single_rename_happy_pairs_caption_stem(self, tmp_path):
        img, cap, reason = des._plan_single_rename(
            {"filename": "pic.png", "path": "pic.png"},
            output_folder=tmp_path,
            pattern="{filename}",
            trigger="",
            overwrite_policy="unique",
            caption_extension=".txt",
            index=1,
            used_image_paths=set(),
        )
        assert reason is None
        assert img.name == "pic.png" and cap.name == "pic.txt"

    def test_plan_beside_image_missing_and_source_states(self, tmp_path):
        assert des._plan_beside_image_sidecar(
            {"path": ""},
            caption_extension=".txt",
            overwrite_policy="overwrite",
            used_caption_paths=set(),
        ) == (None, "missing_source_path")
        assert des._plan_beside_image_sidecar(
            {"path": str(tmp_path / "gone.png")},
            caption_extension=".txt",
            overwrite_policy="overwrite",
            used_caption_paths=set(),
        ) == (None, "source_missing")

    def test_plan_beside_image_happy_returns_sibling_sidecar(self, tmp_path):
        p = _make_image(tmp_path / "img.png")
        path, reason = des._plan_beside_image_sidecar(
            {"path": str(p)},
            caption_extension=".txt",
            overwrite_policy="overwrite",
            used_caption_paths=set(),
        )
        assert reason is None and path == tmp_path / "img.txt"

    def test_reconcile_moved_image_path_returns_error_string_on_db_failure(
        self, monkeypatch
    ):
        def boom(*a, **k):
            raise RuntimeError("db down")

        monkeypatch.setattr(des.db, "update_image_path", boom)
        err = des._reconcile_moved_image_path(5, "/old.png", "/new.png")
        assert err == "db down"

    def test_reconcile_moved_image_path_success_unlinks_old_sidecar(
        self, tmp_path, monkeypatch
    ):
        monkeypatch.setattr(des.db, "update_image_path", lambda *a, **k: None)
        old_img = tmp_path / "old.png"
        old_sidecar = old_img.with_suffix(".txt")
        old_sidecar.write_text("stale", encoding="utf-8")
        err = des._reconcile_moved_image_path(
            5, str(old_img), str(tmp_path / "new.png")
        )
        assert err is None
        assert not old_sidecar.exists()  # stale sidecar cleaned

    def test_toml_path_literal_forward_slashes(self):
        assert des._toml_path_literal(Path("C:\\a\\b")) == "C:/a/b"

    def test_split_keyed_str_map_int_vs_path_keys_and_empty_values(self, tmp_path):
        p = tmp_path / "x.png"
        int_map, path_map = des._split_keyed_str_map(
            {
                "5": "cap",
                "7": "",
                "9": None,
                str(p): "pathcap",
            }
        )
        assert int_map == {5: "cap", 7: "", 9: ""}
        assert list(path_map.values()) == ["pathcap"]


# =========================================================================== #
# 4. Caption composition + template-option assembly.
# =========================================================================== #


class TestCaptionComposition:
    def _record(self, **kw):
        base = {"id": 5, "path": "/x/y.png", "nl_caption": "", "ai_caption": ""}
        base.update(kw)
        return base

    def test_compose_nl_noop_without_type_entry(self):
        out = des._compose_nl_caption(
            "1girl, solo",
            self._record(),
            5,
            "/x/y.png",
            content_mode="tags",
            types_int={},
            types_path={},
            nl_overrides_int={},
            nl_overrides_path={},
        )
        assert out == "1girl, solo"

    def test_compose_nl_both_appends_sentence_tags_first(self):
        out = des._compose_nl_caption(
            "1girl, solo",
            self._record(nl_caption="a girl standing"),
            5,
            "/x/y.png",
            content_mode="tags",
            types_int={5: "both"},
            types_path={},
            nl_overrides_int={},
            nl_overrides_path={},
        )
        assert out == "1girl, solo, a girl standing"

    def test_compose_nl_only_replaces_tags(self):
        out = des._compose_nl_caption(
            "1girl, solo",
            self._record(nl_caption="a girl standing"),
            5,
            "/x/y.png",
            content_mode="tags",
            types_int={5: "nl"},
            types_path={},
            nl_overrides_int={},
            nl_overrides_path={},
        )
        assert out == "a girl standing"

    def test_compose_nl_override_wins_over_stored(self):
        out = des._compose_nl_caption(
            "1girl",
            self._record(nl_caption="stored sentence"),
            5,
            "/x/y.png",
            content_mode="tags",
            types_int={5: "both"},
            types_path={},
            nl_overrides_int={5: "edited sentence"},
            nl_overrides_path={},
        )
        assert out.endswith("edited sentence")
        assert "stored sentence" not in out

    def test_compose_nl_skipped_for_nl_aware_mode(self):
        # tags_nl already emits the sentence globally -> compose must not double it.
        out = des._compose_nl_caption(
            "1girl",
            self._record(nl_caption="sentence"),
            5,
            "/x/y.png",
            content_mode="tags_nl",
            types_int={5: "both"},
            types_path={},
            nl_overrides_int={},
            nl_overrides_path={},
        )
        assert out == "1girl"

    def test_compose_nl_matches_by_path_key(self):
        out = des._compose_nl_caption(
            "tag",
            self._record(id=0, path="/local/a.png", nl_caption="p"),
            0,
            "/local/a.png",
            content_mode="tags",
            types_int={},
            types_path={"/local/a.png": "both"},
            nl_overrides_int={},
            nl_overrides_path={},
        )
        assert out == "tag, p"

    def test_normalise_common_tag_space_vs_verbatim(self):
        assert (
            des._normalise_common_tag("long_hair", normalize_tag_underscores=True)
            == "long hair"
        )
        assert (
            des._normalise_common_tag("long_hair", normalize_tag_underscores=False)
            == "long_hair"
        )

    def test_append_common_tags_only_for_training_modes(self):
        req = _req(common_tags=["masterpiece"], normalize_tag_underscores=True)
        # "template" is NOT a training-tag mode -> unchanged here (append is
        # instead folded into template_options elsewhere).
        assert des._append_common_tags_for_mode("a, b", req, "template") == "a, b"
        out = des._append_common_tags_for_mode("a, b", req, "tags")
        assert out == "a, b, masterpiece"

    def test_append_common_tags_dedupes_case_insensitively(self):
        req = _req(common_tags=["Masterpiece"], normalize_tag_underscores=True)
        out = des._append_common_tags_for_mode("masterpiece, b", req, "tags")
        assert out == "masterpiece, b"  # duplicate not re-appended

    def test_build_template_options_default_uses_legacy_template(self):
        req = _req(trigger="trg", common_tags=["extra"])
        opts = des._build_dataset_template_options(req, {"bad"})
        assert opts["template_override"] == des.DATASET_LEGACY_TEMPLATE
        assert opts["trigger"] == "trg"
        assert "extra" in opts["append"]
        assert "bad" in opts["blacklist"]
        assert opts["underscore_to_space_override"] is True

    def test_build_template_options_merges_common_tags_into_existing_append(self):
        req = _req(common_tags=["c2"])
        opts = des._build_dataset_template_options(req, set())
        # append seeded from common_tags even when template_options is absent
        assert "c2" in opts["append"]

    def test_render_sidecar_int_override_wins(self):
        req = _req()
        out = des._render_dataset_sidecar(
            {"id": 5, "path": "/x.png"},
            [],
            req,
            blacklist_set=set(),
            image_overrides_int={5: "MANUAL"},
            image_overrides_path={},
        )
        assert out == "MANUAL"

    def test_render_sidecar_path_override_wins(self):
        req = _req()
        out = des._render_dataset_sidecar(
            {"id": 0, "path": "/local/a.png"},
            [],
            req,
            blacklist_set=set(),
            image_overrides_int={},
            image_overrides_path={"/local/a.png": "LOCAL"},
        )
        assert out == "LOCAL"


# =========================================================================== #
# 5. Manifest + kohya-TOML writer edges.
# =========================================================================== #


class TestManifestAndKohya:
    def test_manifest_item_maps_result_fields(self):
        item = DatasetExportItemResult(
            image_id=5,
            src_image_path="/s.png",
            dst_image_path="/d.png",
            dst_caption_path="/d.txt",
            skipped_reason=None,
            error=None,
        )
        assert des._manifest_item(item) == {
            "image_id": 5,
            "source_path": "/s.png",
            "output_path": "/d.png",
            "caption_path": "/d.txt",
            "skipped_reason": None,
            "error": None,
        }

    def test_build_export_manifest_shape_and_counts(self, tmp_path):
        req = _req(trigger="t", common_tags=["m"], content_mode="tags")
        items = [DatasetExportItemResult(image_id=1, dst_image_path="/o/a.png")]
        manifest = des._build_export_manifest(
            req,
            status="ok",
            output_folder=tmp_path,
            output_mode="folder",
            caption_extension=".txt",
            exported=1,
            skipped=0,
            error_count=0,
            total_items=1,
            items=items,
            items_truncated=False,
            generated_at=1_700_000_000.0,
        )
        assert manifest["manifest_version"] == 1
        assert manifest["status"] == "ok"
        assert manifest["generated_at_iso"]  # non-empty ISO
        assert manifest["counts"] == {
            "total": 1,
            "exported": 1,
            "skipped": 0,
            "failed": 0,
        }
        assert manifest["settings"]["content_mode"] == "tags"
        assert manifest["settings"]["trigger"] == "t"
        assert manifest["items"][0]["output_path"] == "/o/a.png"

    def test_write_export_manifest_best_effort_swallows_errors(self, tmp_path):
        # Pointing the "folder" at a FILE makes the write fail; must NOT raise.
        f = tmp_path / "not_a_dir"
        f.write_text("x", encoding="utf-8")
        des._write_export_manifest(f, {"manifest_version": 1})  # no exception

    def test_write_export_manifest_writes_json(self, tmp_path):
        import json

        des._write_export_manifest(tmp_path, {"manifest_version": 1, "status": "ok"})
        written = json.loads(
            (tmp_path / des.EXPORT_MANIFEST_FILENAME).read_text(encoding="utf-8")
        )
        assert written["status"] == "ok"

    def test_kohya_toml_basic_fields(self, tmp_path):
        req = _req(
            trigger="mychar", trainer_repeats=7, trainer_batch=4, trainer_resolution=768
        )
        out = des._write_kohya_dataset_config(tmp_path, req, masks_written=0)
        content = (tmp_path / "dataset_config.toml").read_text(encoding="utf-8")
        assert out == str(tmp_path / "dataset_config.toml")
        assert "num_repeats = 7" in content
        assert "batch_size = 4" in content
        assert "resolution = 768" in content
        assert 'class_tokens = "mychar"' in content
        assert "\\" not in content  # forward-slashed paths only

    def test_kohya_toml_keep_tokens_emits_shuffle(self, tmp_path):
        req = _req(trainer_keep_tokens=2)
        des._write_kohya_dataset_config(tmp_path, req, masks_written=0)
        content = (tmp_path / "dataset_config.toml").read_text(encoding="utf-8")
        assert "shuffle_caption = true" in content
        assert "keep_tokens = 2" in content

    def test_kohya_toml_keep_tokens_zero_omits_shuffle(self, tmp_path):
        req = _req(trainer_keep_tokens=0)
        des._write_kohya_dataset_config(tmp_path, req, masks_written=0)
        content = (tmp_path / "dataset_config.toml").read_text(encoding="utf-8")
        assert "shuffle_caption" not in content
        assert "keep_tokens = " not in content

    def test_kohya_toml_conditioning_dir_only_when_kohya_masks_written(self, tmp_path):
        with_masks = _req(mask_export="kohya")
        des._write_kohya_dataset_config(tmp_path, with_masks, masks_written=3)
        assert "conditioning_data_dir" in (tmp_path / "dataset_config.toml").read_text(
            "utf-8"
        )

        no_masks = _req(mask_export="kohya")
        des._write_kohya_dataset_config(tmp_path, no_masks, masks_written=0)
        assert "conditioning_data_dir" not in (
            tmp_path / "dataset_config.toml"
        ).read_text("utf-8")

    def test_kohya_toml_json_content_mode_uses_json_extension(self, tmp_path):
        req = _req(content_mode="json")
        des._write_kohya_dataset_config(tmp_path, req, masks_written=0)
        assert 'caption_extension = ".json"' in (
            tmp_path / "dataset_config.toml"
        ).read_text("utf-8")

    def test_kohya_toml_returns_none_on_write_failure(self, tmp_path):
        f = tmp_path / "is_a_file"
        f.write_text("x", encoding="utf-8")
        req = _req()
        assert des._write_kohya_dataset_config(f, req, masks_written=0) is None


# =========================================================================== #
# 6. _validate_export_request branch matrix.
# =========================================================================== #


class TestValidation:
    def _expect_400(self, **kw):
        from fastapi import HTTPException

        with pytest.raises(HTTPException) as exc:
            des._validate_export_request(_req(**kw))
        assert exc.value.status_code == 400
        return exc.value

    def test_invalid_output_mode(self):
        self._expect_400(image_paths=["/x"], output_mode="cloud")

    def test_invalid_mask_export(self):
        self._expect_400(
            image_paths=["/x"], output_folder="/tmp/x", mask_export="diffusers"
        )

    def test_invalid_trainer_config(self):
        self._expect_400(
            image_paths=["/x"], output_folder="/tmp/x", trainer_config="onetrainer_toml"
        )

    def test_invalid_image_op(self):
        self._expect_400(image_paths=["/x"], output_folder="/tmp/x", image_op="delete")

    def test_invalid_overwrite_policy(self):
        self._expect_400(
            image_paths=["/x"], output_folder="/tmp/x", overwrite_policy="clobber"
        )

    def test_invalid_content_mode(self):
        self._expect_400(
            image_paths=["/x"], output_folder="/tmp/x", content_mode="bogus"
        )

    def test_no_sources_is_400(self):
        self._expect_400(output_folder="/tmp/x")

    def test_folder_mode_requires_output_folder(self):
        self._expect_400(image_paths=["/x"], output_folder="")

    def test_beside_image_mode_needs_no_folder(self):
        # beside_image returns None (no output path) and does not require a folder.
        assert (
            des._validate_export_request(
                _req(image_paths=["/x"], output_mode="beside_image", output_folder="")
            )
            is None
        )

    def test_folder_mode_creates_and_returns_path(self, tmp_path):
        target = tmp_path / "made"
        out = des._validate_export_request(
            _req(image_paths=["/x"], output_folder=str(target))
        )
        assert out == target and target.is_dir()


# =========================================================================== #
# 7. export_dataset streaming invariants (DB-free path-source).
# =========================================================================== #


class TestExportDatasetBehaviors:
    def _three_images(self, tmp_path):
        src = tmp_path / "src"
        src.mkdir()
        return [str(_make_image(src / f"p{i}.png")) for i in range(3)]

    def test_item_limit_truncates_items_but_keeps_total(self, tmp_path, monkeypatch):
        # The closure reads DATASET_EXPORT_RESPONSE_ITEM_LIMIT as a facade global
        # at call time — a split must keep this read on the same module object.
        monkeypatch.setattr(des, "DATASET_EXPORT_RESPONSE_ITEM_LIMIT", 2)
        out = tmp_path / "out"
        out.mkdir()
        resp = des.export_dataset(
            _req(image_paths=self._three_images(tmp_path), output_folder=str(out))
        )
        assert resp.exported == 3
        assert resp.total_items == 3
        assert len(resp.items) == 2
        assert resp.items_truncated is True

    def test_error_messages_capped_at_50_with_sentinel(self, tmp_path):
        out = tmp_path / "out"
        out.mkdir()
        ghosts = [str(tmp_path / f"ghost{i}.png") for i in range(55)]
        resp = des.export_dataset(_req(image_paths=ghosts, output_folder=str(out)))
        assert resp.status == "failed"
        assert resp.error_count == 55
        assert len(resp.error_messages) == 51
        assert resp.error_messages[-1] == "... and more errors (showing first 50)"

    def test_preset_cancel_event_short_circuits(self, tmp_path):
        out = tmp_path / "out"
        out.mkdir()
        event = threading.Event()
        event.set()
        resp = des.export_dataset(
            _req(image_paths=self._three_images(tmp_path), output_folder=str(out)),
            cancel_event=event,
        )
        assert resp.status == "cancelled"
        assert resp.exported == 0

    def test_duplicate_path_is_skipped(self, tmp_path):
        out = tmp_path / "out"
        out.mkdir()
        p = str(_make_image(tmp_path / "dup.png"))
        resp = des.export_dataset(_req(image_paths=[p, p], output_folder=str(out)))
        assert resp.exported == 1
        assert resp.skipped == 1
        assert any(i.skipped_reason == "duplicate" for i in resp.items)

    def test_unreadable_path_becomes_row_error(self, tmp_path):
        out = tmp_path / "out"
        out.mkdir()
        resp = des.export_dataset(
            _req(image_paths=[str(tmp_path / "nope.png")], output_folder=str(out))
        )
        assert resp.status == "failed"
        assert resp.error_count == 1
        assert "not a readable image" in " ".join(resp.error_messages)

    def test_copy_leaves_source_in_place(self, tmp_path):
        out = tmp_path / "out"
        out.mkdir()
        p = _make_image(tmp_path / "keep.png")
        resp = des.export_dataset(
            _req(image_paths=[str(p)], output_folder=str(out), image_op="copy")
        )
        assert resp.exported == 1
        assert p.exists()  # SAFETY: copy never touches the original

    def test_move_removes_source(self, tmp_path):
        out = tmp_path / "out"
        out.mkdir()
        p = _make_image(tmp_path / "gomove.png")
        resp = des.export_dataset(
            _req(image_paths=[str(p)], output_folder=str(out), image_op="move")
        )
        assert resp.exported == 1
        assert not p.exists()  # move relocates the source
        assert (out / "gomove.png").exists()

    def test_beside_image_writes_sidecar_without_relocating(self, tmp_path):
        p = _make_image(tmp_path / "img.png")
        key = str(Path(p).resolve())
        resp = des.export_dataset(
            _req(
                image_paths=[str(p)],
                output_mode="beside_image",
                output_folder="",
                naming_pattern="ignored",
                overwrite_policy="overwrite",
                image_overrides={key: "beside cap"},
            )
        )
        assert resp.status == "ok"
        assert resp.output_mode == "beside_image"
        assert p.exists()  # SAFETY: beside_image never copies/relocates
        assert p.with_suffix(".txt").read_text(encoding="utf-8") == "beside cap"
        # beside_image has no single destination folder -> no manifest anywhere
        assert not (tmp_path / des.EXPORT_MANIFEST_FILENAME).exists()

    def test_folder_export_drops_manifest(self, tmp_path):
        out = tmp_path / "out"
        out.mkdir()
        p = _make_image(tmp_path / "m.png")
        des.export_dataset(_req(image_paths=[str(p)], output_folder=str(out)))
        assert (out / des.EXPORT_MANIFEST_FILENAME).exists()


# =========================================================================== #
# 8. preview_dataset_export branch coverage.
# =========================================================================== #


class TestPreviewBehaviors:
    def test_empty_sources_returns_zeroed_shape_without_error(self):
        from services.dataset_export_service import DatasetExportPreviewRequest

        out = des.preview_dataset_export(DatasetExportPreviewRequest())
        assert out["total"] == 0
        assert out["returned"] == 0
        assert out["items"] == []
        assert out["items_truncated"] is False

    def test_invalid_output_mode_400(self):
        from fastapi import HTTPException
        from services.dataset_export_service import DatasetExportPreviewRequest

        with pytest.raises(HTTPException) as exc:
            des.preview_dataset_export(
                DatasetExportPreviewRequest(image_paths=["/x"], output_mode="cloud")
            )
        assert exc.value.status_code == 400

    def test_invalid_content_mode_400(self):
        from fastapi import HTTPException
        from services.dataset_export_service import DatasetExportPreviewRequest

        with pytest.raises(HTTPException) as exc:
            des.preview_dataset_export(
                DatasetExportPreviewRequest(image_paths=["/x"], content_mode="bogus")
            )
        assert exc.value.status_code == 400

    def test_path_source_preview_renders_rows(self, tmp_path):
        from services.dataset_export_service import DatasetExportPreviewRequest

        src = tmp_path / "src"
        src.mkdir()
        paths = [str(_make_image(src / f"q{i}.png")) for i in range(2)]
        out = des.preview_dataset_export(
            DatasetExportPreviewRequest(
                image_paths=paths,
                output_folder=str(tmp_path / "o"),
                naming_pattern="pv_{index:03d}",
                content_mode="tags",
                limit=10,
            )
        )
        assert out["total"] == 2
        assert out["returned"] == 2
        assert out["items"][0]["output_image_name"] == "pv_001.png"
        assert out["items"][0]["output_caption_name"] == "pv_001.txt"

    def test_preview_limit_truncates(self, tmp_path):
        from services.dataset_export_service import DatasetExportPreviewRequest

        src = tmp_path / "src"
        src.mkdir()
        paths = [str(_make_image(src / f"r{i}.png")) for i in range(3)]
        out = des.preview_dataset_export(
            DatasetExportPreviewRequest(
                image_paths=paths,
                output_folder=str(tmp_path / "o"),
                limit=1,
            )
        )
        assert out["total"] == 3
        assert out["returned"] == 1
        assert out["items_truncated"] is True

    def test_preview_unreadable_path_reports_error_row(self, tmp_path):
        from services.dataset_export_service import DatasetExportPreviewRequest

        out = des.preview_dataset_export(
            DatasetExportPreviewRequest(
                image_paths=[str(tmp_path / "ghost.png")],
                output_folder=str(tmp_path / "o"),
            )
        )
        assert out["returned"] == 1
        assert out["items"][0]["error"]
