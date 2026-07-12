"""Characterization pins for tagging_service pure seams (god-file redesign, step 0).

These tests PIN current behavior — including quirks — so the planned
decomposition of backend/services/tagging_service.py (2622 lines) cannot
silently change semantics. Same pin-spec-first protocol as
test_smart_tag_pins.py (c2c6cf7). This file covers the module-level /
request-model gap matrix; TaggingService state-machine seams live in
test_tagging_pins_service.py and DB-backed worker/export pins live in
test_tagging_pins_worker.py.

Deliberately NOT duplicated here (already pinned elsewhere):
  * _apply_pre_tag_filters               -> test_pre_tag_filters.py
  * _build_last_run_stats                -> test_tag_last_run_stats.py
  * _iter_rescaling_batches              -> test_tagging_service.py
  * GPU runtime-plan cells + custom-ONNX validation matrix
                                         -> test_tagging_service.py
  * ToriiGate GPU hardware floor         -> test_tagging_service.py

Behaviors marked "QUIRK" are pinned as-is on purpose: if a refactor changes
them, that must be a conscious decision, not an accident.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest
from pydantic import ValidationError

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import config  # noqa: E402
import services.tagging_service as tsvc  # noqa: E402
from config import DEFAULT_TAGGER_MODEL, TAGGER_MODELS  # noqa: E402
from services.tagging_service import (  # noqa: E402
    BatchTagExportRequest,
    CombinedTagExportRequest,
    ExportPreviewRequest,
    TAGGER_MODEL_HINTS,
    TagImportRequest,
    TagRequest,
    TaggingService,
    _build_tag_progress_state,
    _E2ETaggingStub,
    _e2e_tagger_getter,
    _format_runtime_adjustment_message,
    _iter_rescaling_chunk_source,
    resolve_request_thresholds,
)

# ===========================================================================
# TagRequest — validation / coercion surface consumed by routers AND by the
# worker's re-validation (`TagRequest.model_validate(payload["request"])`).
# ===========================================================================


def test_tag_request_default_field_matrix() -> None:
    req = TagRequest()
    assert req.image_ids is None
    assert req.threshold is None
    assert req.character_threshold is None
    assert req.retag_all is False
    assert req.model_name is None
    assert req.model_path is None
    assert req.tags_path is None
    assert req.custom_profile is None
    assert req.use_gpu is True
    assert req.allow_unsafe_acceleration is False
    assert req.batch_size is None
    assert req.pre_tag_blacklist == []
    assert req.max_tags_per_image == 0


def test_tag_request_threshold_bounds_are_inclusive() -> None:
    assert TagRequest(threshold=0.0).threshold == 0.0
    assert TagRequest(threshold=1.0).threshold == 1.0
    assert TagRequest(character_threshold=0.0).character_threshold == 0.0
    with pytest.raises(ValidationError):
        TagRequest(threshold=1.01)
    with pytest.raises(ValidationError):
        TagRequest(threshold=-0.01)
    with pytest.raises(ValidationError):
        TagRequest(character_threshold=1.01)


def test_tag_request_batch_size_bounds() -> None:
    assert TagRequest(batch_size=1).batch_size == 1
    assert TagRequest(batch_size=128).batch_size == 128
    with pytest.raises(ValidationError):
        TagRequest(batch_size=0)
    with pytest.raises(ValidationError):
        TagRequest(batch_size=129)


def test_tag_request_max_tags_per_image_bounds() -> None:
    assert TagRequest(max_tags_per_image=0).max_tags_per_image == 0
    assert TagRequest(max_tags_per_image=2000).max_tags_per_image == 2000
    with pytest.raises(ValidationError):
        TagRequest(max_tags_per_image=-1)
    with pytest.raises(ValidationError):
        TagRequest(max_tags_per_image=2001)


def test_tag_request_coerces_numeric_string_image_ids() -> None:
    """Lax pydantic coercion is part of the public surface: JSON callers can
    send string ids and the worker still receives ints."""
    assert TagRequest(image_ids=["5", 7]).image_ids == [5, 7]


def test_tag_request_pre_tag_blacklist_capped_at_500_entries() -> None:
    assert len(TagRequest(pre_tag_blacklist=["x"] * 500).pre_tag_blacklist) == 500
    with pytest.raises(ValidationError):
        TagRequest(pre_tag_blacklist=["x"] * 501)


def test_tag_request_survives_worker_dump_validate_round_trip() -> None:
    """_tagging_worker_main re-validates the runtime plan's embedded request
    dict in the child process; the dump/validate round trip must be lossless."""
    req = TagRequest(
        image_ids=[1, 2],
        threshold=0.4,
        model_name="camie-tagger-v2",
        use_gpu=False,
        pre_tag_blacklist=["watermark"],
        max_tags_per_image=50,
    )
    assert TagRequest.model_validate(req.model_dump(mode="python")) == req


# ===========================================================================
# BatchTagExportRequest / ExportPreviewRequest / CombinedTagExportRequest /
# TagImportRequest — export request surface.
# ===========================================================================


def test_export_request_requires_ids_or_selection_token() -> None:
    with pytest.raises(ValidationError, match="Either image_ids or selection_token"):
        BatchTagExportRequest(output_folder="x")


def test_export_request_rejects_both_ids_and_selection_token() -> None:
    with pytest.raises(ValidationError, match="not both"):
        BatchTagExportRequest(image_ids=[1], selection_token="tok")


def test_export_request_rejects_empty_ids_list_at_field_level() -> None:
    """image_ids has min_length=1, so [] fails BEFORE the ids-or-token
    model validator gets a chance to phrase the error."""
    with pytest.raises(ValidationError):
        BatchTagExportRequest(image_ids=[])


def test_export_request_rejects_empty_selection_token_at_field_level() -> None:
    with pytest.raises(ValidationError):
        BatchTagExportRequest(selection_token="")


def test_export_request_default_field_matrix() -> None:
    req = BatchTagExportRequest(image_ids=[1])
    assert req.output_folder == ""
    assert req.output_mode == "folder"
    assert req.blacklist == []
    assert req.prefix == ""
    assert req.content_mode == "tags"
    assert req.overwrite_policy == "unique"
    assert req.template_options is None
    assert req.image_overrides is None
    assert req.caption_transforms is None
    assert req.image_types is None
    assert req.image_nl_overrides is None
    assert req.normalize_tag_underscores is None
    assert req.nl_sidecar is False
    assert req.nl_sidecar_suffix == "_nl"
    assert req.training_purpose == ""
    assert req.dedupe_implications is False
    assert req.background is False


def test_export_request_nl_sidecar_suffix_pattern() -> None:
    assert (
        BatchTagExportRequest(
            image_ids=[1], nl_sidecar_suffix="ok-1._x"
        ).nl_sidecar_suffix
        == "ok-1._x"
    )
    with pytest.raises(ValidationError):
        BatchTagExportRequest(image_ids=[1], nl_sidecar_suffix="bad/suffix")
    with pytest.raises(ValidationError):
        BatchTagExportRequest(image_ids=[1], nl_sidecar_suffix="a b")


def test_export_request_coerces_string_keys_of_per_image_maps_to_int() -> None:
    """JSON object keys arrive as strings; Dict[int, str] fields must coerce
    them so per-image overrides keyed by image id actually match."""
    req = BatchTagExportRequest(
        image_ids=[1],
        image_overrides={"5": "caption"},
        image_types={"6": "nl"},
        image_nl_overrides={"7": "an nl sentence"},
    )
    assert req.image_overrides == {5: "caption"}
    assert req.image_types == {6: "nl"}
    assert req.image_nl_overrides == {7: "an nl sentence"}


def test_combined_export_request_inherits_batch_contract() -> None:
    assert issubclass(CombinedTagExportRequest, BatchTagExportRequest)
    with pytest.raises(ValidationError, match="Either image_ids or selection_token"):
        CombinedTagExportRequest()


def test_export_preview_request_default_field_matrix() -> None:
    req = ExportPreviewRequest()
    assert req.image_ids == []
    assert req.preset_id == "custom"
    assert req.template_override is None
    assert req.trigger == ""
    assert req.blacklist == []
    assert req.replace_rules == {}
    assert req.max_tags == 0
    assert req.append == []
    assert req.content_mode is None
    assert req.prefix == ""
    assert req.normalize_tag_underscores is None
    assert req.underscore_to_space_override is None
    assert req.training_purpose == ""
    assert req.dedupe_implications is False


def test_tag_import_request_requires_images_and_defaults_overwrite_false() -> None:
    assert TagImportRequest(images=[]).overwrite is False
    with pytest.raises(ValidationError):
        TagImportRequest()


# ===========================================================================
# resolve_request_thresholds — registry fallback cells beyond the camie /
# unknown-model cells already pinned in test_tagging_service.py.
# ===========================================================================


def test_thresholds_partial_override_fills_only_the_unset_side() -> None:
    assert resolve_request_thresholds("camie-tagger-v2", 0.5, None) == (0.5, 0.78)
    assert resolve_request_thresholds("camie-tagger-v2", None, 0.9) == (0.62, 0.9)


def test_thresholds_concrete_registry_cells_for_non_wd_models() -> None:
    assert resolve_request_thresholds("pixai-tagger-v0.9", None, None) == (0.45, 0.85)
    assert resolve_request_thresholds("oppai-oracle-v1.1", None, None) == (0.7927, 1.0)
    assert resolve_request_thresholds("toriigate-0.5", None, None) == (1.0, 1.0)


# ===========================================================================
# _resolve_custom_profile / _resolve_model_name — alias table semantics.
# ===========================================================================


def test_custom_profile_alias_matrix() -> None:
    svc = TaggingService()

    def resolve(**kwargs: object) -> str:
        return svc._resolve_custom_profile(TagRequest(**kwargs))

    # WD-family aliases all collapse onto the wd14 profile.
    for alias in (
        "custom",
        "wd14",
        "wd14-compatible",
        "wd14_csv",
        "wd14-csv",
        "wd-eva02-large-tagger-v3",
        "wd-swinv2-tagger-v3",
        "wd-convnext-tagger-v3",
        "wd-vit-tagger-v3",
        "wd-vit-large-tagger-v3",
    ):
        assert resolve(custom_profile=alias) == "wd14", alias
    # Case + whitespace insensitive.
    assert resolve(custom_profile="  Camie-Tagger-V2 ") == "camie-tagger-v2"
    # Unknown profiles pass through lowercased/stripped (rejected later by
    # _validate_tag_request, not here).
    assert resolve(custom_profile="  Weird-Prof ") == "weird-prof"
    # Nothing set at all -> the literal "wd14" default.
    assert resolve() == "wd14"


def test_quirk_empty_custom_profile_falls_through_to_model_name() -> None:
    """QUIRK: the alias table maps "" -> wd14, but the `custom_profile or
    model_name or "wd14"` chain makes that entry unreachable whenever
    model_name is set — an empty profile string resolves to the MODEL name,
    not to wd14."""
    svc = TaggingService()
    req = TagRequest(custom_profile="", model_name="camie-tagger-v2")
    assert svc._resolve_custom_profile(req) == "camie-tagger-v2"


def test_resolve_model_name_maps_profiles_only_when_model_path_present() -> None:
    svc = TaggingService()
    # With model_path: profile -> canonical built-in model name.
    assert (
        svc._resolve_model_name(TagRequest(model_path="x.onnx", model_name="custom"))
        == "wd-swinv2-tagger-v3"
    )
    assert (
        svc._resolve_model_name(
            TagRequest(model_path="x.onnx", custom_profile="camie-tagger-v2")
        )
        == "camie-tagger-v2"
    )
    # Unknown profile passes through verbatim (rejected downstream).
    assert (
        svc._resolve_model_name(TagRequest(model_path="x.onnx", custom_profile="weird"))
        == "weird"
    )
    # Without model_path the custom_profile is IGNORED entirely.
    assert (
        svc._resolve_model_name(
            TagRequest(custom_profile="camie-tagger-v2", model_name="wd-vit-tagger-v3")
        )
        == "wd-vit-tagger-v3"
    )
    # model_name is stripped; None falls back to the registry default.
    assert (
        svc._resolve_model_name(TagRequest(model_name="  wd-vit-tagger-v3  "))
        == "wd-vit-tagger-v3"
    )
    assert svc._resolve_model_name(TagRequest()) == DEFAULT_TAGGER_MODEL


# ===========================================================================
# _format_runtime_adjustment_message — progress-UI string contract.
# ===========================================================================


def test_runtime_message_empty_without_backoff_steps() -> None:
    assert _format_runtime_adjustment_message({}) == ""
    assert _format_runtime_adjustment_message({"backoff_steps": []}) == ""


def test_quirk_cpu_fallback_flag_alone_yields_empty_message() -> None:
    """QUIRK: the empty-backoff early return wins even when used_cpu_fallback
    or final_chunk_size are set — those flags alone produce NO message."""
    assert (
        _format_runtime_adjustment_message(
            {"used_cpu_fallback": True, "final_chunk_size": 2}
        )
        == ""
    )


def test_runtime_message_gpu_backoff_appends_current_chunk() -> None:
    message = _format_runtime_adjustment_message(
        {
            "backoff_steps": [{"mode": "gpu_backoff", "from": 32, "to": 16}],
            "final_chunk_size": 16,
        }
    )
    assert message == "GPU batch 32->16, current chunk 16"


def test_runtime_message_skips_unknown_modes_and_prefers_cpu_over_chunk() -> None:
    # Unknown step modes contribute nothing, but final_chunk_size still prints.
    assert (
        _format_runtime_adjustment_message(
            {"backoff_steps": [{"mode": "???"}], "final_chunk_size": 4}
        )
        == "current chunk 4"
    )
    # used_cpu_fallback suppresses the "current chunk" suffix.
    message = _format_runtime_adjustment_message(
        {
            "backoff_steps": [{"mode": "cpu_fallback", "from": 4, "to": 1}],
            "used_cpu_fallback": True,
            "final_chunk_size": 1,
        }
    )
    assert message == "GPU batch 4->CPU fallback, continued on CPU"


# ===========================================================================
# _iter_rescaling_chunk_source — streaming twin of _iter_rescaling_batches
# (which is already pinned); completely untested before this file.
# ===========================================================================


def test_chunk_source_carries_ids_across_chunk_boundaries() -> None:
    out = list(_iter_rescaling_chunk_source([[1, 2, 3, 4, 5], [6, 7, 8]], lambda: 3))
    assert out == [(0, [1, 2, 3]), (3, [4, 5, 6]), (6, [7, 8])]


def test_chunk_source_rereads_batch_size_after_each_yield() -> None:
    state = {"size": 4}
    gen = _iter_rescaling_chunk_source([list(range(1, 11))], lambda: state["size"])
    first = next(gen)
    state["size"] = 2
    rest = list(gen)
    assert first == (0, [1, 2, 3, 4])
    assert rest == [(4, [5, 6]), (6, [7, 8]), (8, [9, 10])]


def test_chunk_source_empty_and_zero_size_edges() -> None:
    assert list(_iter_rescaling_chunk_source([], lambda: 3)) == []
    assert list(_iter_rescaling_chunk_source([[], []], lambda: 3)) == []
    # A pathological 0 batch size clamps to 1 instead of spinning forever.
    assert list(_iter_rescaling_chunk_source([[1, 2]], lambda: 0)) == [
        (0, [1]),
        (1, [2]),
    ]


# ===========================================================================
# _build_tag_progress_state — the payload shape every progress consumer
# (router, frontend poller, worker IPC) reads.
# ===========================================================================

PROGRESS_STATE_KEYS = {
    "status",
    "current",
    "processed",
    "total",
    "tagged",
    "errors",
    "message",
    "runtime_backend_target",
    "runtime_backend_actual",
    "runtime_backend_reason",
    "memory_pressure_warning",
    "run_id",
}


def test_progress_state_key_set_and_processed_mirror() -> None:
    state = _build_tag_progress_state("running", current=7)
    assert set(state.keys()) == PROGRESS_STATE_KEYS
    # "processed" is a straight mirror of "current" in the builder.
    assert state["processed"] == state["current"] == 7
    assert state["run_id"] == 0


def test_quirk_empty_last_run_stats_dict_is_omitted() -> None:
    """QUIRK: the gate is truthiness, not None-ness — an empty stats dict is
    dropped from the payload, so the frontend's pop-modal-when-key-present
    logic never fires for it."""
    assert "last_run_stats" not in _build_tag_progress_state("done", last_run_stats={})
    stats = {"total_processed": 1}
    state = _build_tag_progress_state("done", last_run_stats=stats)
    assert state["last_run_stats"] is stats


# ===========================================================================
# _E2ETaggingStub — the fake-tagger contract Playwright full-flow runs (and
# the in-process worker pins) depend on. If a split changes this shape, e2e
# suites break silently on CI only.
# ===========================================================================


def test_e2e_stub_result_shape_and_tag_rows(monkeypatch) -> None:
    monkeypatch.setattr(config, "TAG_SCORES_ENABLED", False)
    results = _E2ETaggingStub().tag_batch(["/tmp/My_pic-01.png"])
    assert isinstance(results, list) and len(results) == 1
    result = results[0]
    assert set(result.keys()) == {
        "all_tags",
        "general_tags",
        "character_tags",
        "rating",
        "error",
    }
    assert result["all_tags"] == [
        {"tag": "e2e_fixture", "confidence": 0.99, "category": "general"},
        {"tag": "My pic 01", "confidence": 0.88, "category": "general"},
        {"tag": "general", "confidence": 0.99, "category": "rating"},
    ]
    # general_tags excludes the rating row; character_tags always empty.
    assert result["general_tags"] == result["all_tags"][:2]
    assert result["character_tags"] == []
    assert result["rating"] == {"tag": "general", "confidence": 0.99}
    assert result["error"] is None


def test_e2e_stub_stem_derivation_and_all_separator_fallback(monkeypatch) -> None:
    """Underscores/hyphens become spaces with case preserved; a stem that is
    nothing but separators collapses to the literal "image"."""
    monkeypatch.setattr(config, "TAG_SCORES_ENABLED", False)
    stub = _E2ETaggingStub()
    assert stub.tag_batch(["/tmp/___.png"])[0]["all_tags"][1]["tag"] == "image"
    assert stub.tag_batch(["/tmp/A_b-C.png"])[0]["all_tags"][1]["tag"] == "A b C"


def test_e2e_stub_emits_tag_scores_only_when_config_enabled(monkeypatch) -> None:
    """BE-1 contract: with TAG_SCORES_ENABLED the stub mirrors the real
    _process_probs output — 4 score rows including one sub-threshold row
    (0.18) that the rethreshold / coverage-gap endpoints must be able to
    surface. The gate is read at call time from the config module."""
    stub = _E2ETaggingStub()

    monkeypatch.setattr(config, "TAG_SCORES_ENABLED", True)
    result = stub.tag_batch(["/tmp/pic.png"])[0]
    assert result["tag_scores"] == [
        {"tag": "e2e_fixture", "score": 0.99, "category": "general"},
        {"tag": "pic", "score": 0.88, "category": "general"},
        {"tag": "e2e_low_conf", "score": 0.18, "category": "general"},
        {"tag": "general", "score": 0.99, "category": "rating"},
    ]

    monkeypatch.setattr(config, "TAG_SCORES_ENABLED", False)
    assert "tag_scores" not in stub.tag_batch(["/tmp/pic.png"])[0]


def test_e2e_stub_runtime_info_shape_and_effective_batch_math(monkeypatch) -> None:
    monkeypatch.setattr(config, "TAG_SCORES_ENABLED", False)
    stub = _E2ETaggingStub()
    # effective = max(min_batch, min(preferred, max(1, len(paths))))
    _, info = stub.tag_batch(
        ["/tmp/a.png"],
        preferred_batch_size=8,
        min_batch_size=2,
        return_runtime_info=True,
    )
    assert info == {
        "requested_batch_size": 8,
        "effective_batch_size": 2,
        "fallbacks": [],
    }
    _, info = stub.tag_batch(
        [f"/tmp/{i}.png" for i in range(10)],
        preferred_batch_size=4,
        min_batch_size=1,
        return_runtime_info=True,
    )
    assert info["effective_batch_size"] == 4
    # Without return_runtime_info the return value is the bare results list.
    plain = stub.tag_batch(["/tmp/a.png"], preferred_batch_size=8)
    assert isinstance(plain, list)


def test_e2e_stub_noop_runtime_surface_and_getter() -> None:
    stub = _E2ETaggingStub()
    assert stub.use_gpu is False
    assert stub.load() is None
    assert stub.set_session_refresh_interval(180) is None
    # The getter swallows every kwarg the real get_tagger accepts and returns
    # a FRESH stub each call (no singleton reuse).
    one = _e2e_tagger_getter(model_name="x", use_gpu=True, force_reload=True)
    two = _e2e_tagger_getter()
    assert isinstance(one, _E2ETaggingStub)
    assert one is not two


# ===========================================================================
# Registry consistency + small pure statics.
# ===========================================================================


def test_tagger_model_hints_registry_stays_in_sync_with_config() -> None:
    """Every TAGGER_MODELS entry has a hint and vice versa. get_tagger_models
    has per-field fallbacks, but a missing hint would silently ship placeholder
    marketing copy for a real model."""
    assert set(TAGGER_MODEL_HINTS.keys()) == set(TAGGER_MODELS.keys())


def test_resolve_export_status_matrix() -> None:
    resolve = TaggingService._resolve_export_status
    assert resolve(exported=3, skipped=0, error_count=0) == "ok"
    assert resolve(exported=0, skipped=0, error_count=0) == "ok"
    assert resolve(exported=3, skipped=1, error_count=0) == "partial"
    assert resolve(exported=3, skipped=0, error_count=1) == "partial"
    assert resolve(exported=0, skipped=1, error_count=1) == "partial"
    assert resolve(exported=0, skipped=0, error_count=1) == "error"


def test_default_export_progress_state_shape() -> None:
    state = TaggingService._build_default_export_progress_state()
    assert state == {
        "status": "idle",
        "step": "idle",
        "current": 0,
        "total": 0,
        "message": "",
        "operation": "export",
        "result": None,
        "started_at": None,
        "updated_at": None,
    }


# ===========================================================================
# Catalog derived fields + library delegation (no DB — db calls are stubbed).
# ===========================================================================


def test_tagger_models_catalog_derived_role_and_prepare_fields() -> None:
    """The router suite pins thresholds/flags; these DERIVED fields (role,
    prepare id, custom-profile support, tags-file hint) are computed inline in
    get_tagger_models and were previously unpinned."""
    catalog = {m["name"]: m for m in TaggingService().get_tagger_models()["models"]}

    assert catalog["toriigate-0.5"]["smart_tag_role"] == "natural_language"
    assert catalog["toriigate-0.5"]["prepare_model_id"] == "toriigate"
    assert catalog["toriigate-0.5"]["custom_profile_supported"] is False

    assert catalog["oppai-oracle-v1.1"]["smart_tag_role"] == "booru"
    assert catalog["oppai-oracle-v1.1"]["prepare_model_id"] == "oppai-oracle"
    assert catalog["oppai-oracle-v1.1"]["custom_profile_supported"] is False

    assert catalog["wd-swinv2-tagger-v3"]["smart_tag_role"] == "booru"
    assert catalog["wd-swinv2-tagger-v3"]["prepare_model_id"] == "wd14"
    assert catalog["wd-swinv2-tagger-v3"]["custom_profile_supported"] is True
    assert (
        catalog["wd-swinv2-tagger-v3"]["custom_tags_file_hint"] == "selected_tags.csv"
    )

    assert catalog["camie-tagger-v2"]["custom_tags_file_hint"] == ".json metadata"


def test_get_tags_library_falls_back_to_frequency_for_invalid_sort(monkeypatch) -> None:
    captured = {}

    def fake_search_tags(search_query, sort_by="frequency", limit=None):
        captured.update(query=search_query, sort_by=sort_by, limit=limit)
        return {"tags": [], "total": 0}

    monkeypatch.setattr(tsvc.db, "search_tags", fake_search_tags)
    result = TaggingService().get_tags_library(
        sort_by="bogus", limit=5, search_query="girl"
    )
    assert captured == {"query": "girl", "sort_by": "frequency", "limit": 5}
    assert result == {"tags": [], "total": 0}


def test_quirk_get_all_tags_total_counts_before_limit(monkeypatch) -> None:
    """QUIRK: `total` is the FULL tag count even when `limit` truncates the
    returned list — consumers must not treat len(tags) as the total."""
    monkeypatch.setattr(
        tsvc.db,
        "get_all_tags",
        lambda: [{"tag": f"t{i}", "count": 1} for i in range(5)],
    )
    result = TaggingService().get_all_tags(limit=2)
    assert len(result["tags"]) == 2
    assert result["total"] == 5


def test_get_checkpoints_library_wraps_list_in_envelope(monkeypatch) -> None:
    rows = [{"name": "ckptA", "count": 3}]
    monkeypatch.setattr(
        tsvc.db, "get_all_checkpoints", lambda limit=None, search_query=None: rows
    )
    assert TaggingService().get_checkpoints_library() == {
        "checkpoints": rows,
        "total": 1,
    }
