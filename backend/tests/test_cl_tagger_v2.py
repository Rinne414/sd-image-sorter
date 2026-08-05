"""Contract tests for the optional CL Tagger v2 backend.

These tests deliberately stop at registry, metadata, preprocessing, and mocked
download seams. They never construct an ONNX Runtime session or fetch weights.
"""

from __future__ import annotations

import sys
import logging
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

import cl_tagger_v2
from config import TAGGER_MODELS


def test_registry_pins_stable_v2_00_and_runtime_contract() -> None:
    entry = TAGGER_MODELS["cl-tagger-v2"]

    assert entry["repo_id"] == "cella110n/cl_tagger_v2"
    assert entry["revision"] == "b57909b8e9c63f71e208a26473e7aabdf45ed6b6"
    assert entry["model_file"] == "v2_00/model.onnx"
    assert entry["tags_file"] == "v2_00/model_vocabulary.json"
    assert entry["runtime_backend"] == "cl-tagger-v2"
    assert entry["default_threshold"] == 0.55
    assert entry["input_layout"] == "nchw"
    assert entry["input_normalization"] == "minus_one_to_one"


def test_required_files_are_runtime_minimum_and_optional_split_files_are_explicit() -> None:
    assert cl_tagger_v2.CL_TAGGER_V2_REQUIRED_FILES == (
        "v2_00/model.onnx",
        "v2_00/model.onnx.data",
        "v2_00/model_vocabulary.json",
        "v2_00/model_metadata.json",
        "v2_00/model_tag_metrics.npz",
    )
    assert "v2_00/model_split_files/manifest.json" in cl_tagger_v2.CL_TAGGER_V2_OPTIONAL_FILES
    assert "v2_00/model_ood_ref.npz" in cl_tagger_v2.CL_TAGGER_V2_OPTIONAL_FILES


def test_parse_vocabulary_preserves_categories_and_indices() -> None:
    vocabulary = cl_tagger_v2.parse_vocabulary(
        {
            "idx_to_tag": {
                "0": "character_name",
                "1": "series_name",
                "2": "blue_hair",
                "3": "explicit",
                "4": "best",
            },
            "tag_to_category": {
                "character_name": "character",
                "series_name": "copyright",
                "blue_hair": "general",
                "explicit": "rating",
                "best": "quality",
            },
            "categories": ["character", "copyright", "general", "rating", "quality"],
        }
    )

    assert vocabulary.character_tags == ((0, "character_name"),)
    assert vocabulary.copyright_tags == ((1, "series_name"),)
    assert vocabulary.general_tags == ((2, "blue_hair"), (4, "best"))
    assert vocabulary.rating_tags == ((3, "explicit"),)
    assert vocabulary.general_category_overrides == {"best": "quality"}


def test_model_file_validation_requires_all_runtime_files(tmp_path: Path) -> None:
    model_dir = tmp_path / "cl-tagger-v2"
    model_dir.mkdir()

    assert cl_tagger_v2.has_complete_runtime_files(model_dir) is False

    for filename in cl_tagger_v2.CL_TAGGER_V2_REQUIRED_FILES:
        path = model_dir / filename
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"fixture")

    assert cl_tagger_v2.has_complete_runtime_files(model_dir) is True


def test_download_uses_pinned_revision_and_official_huggingface_only(
    monkeypatch, tmp_path: Path, caplog
) -> None:
    caplog.set_level(logging.INFO)
    calls = []

    def fake_download(**kwargs):
        calls.append(kwargs)
        target = Path(kwargs["local_dir"]) / kwargs["filename"]
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(b"fixture")
        return str(target)

    monkeypatch.setattr(
        cl_tagger_v2,
        "hf_hub",
        SimpleNamespace(hf_hub_download=fake_download),
    )
    tagger = cl_tagger_v2.CLTaggerV2Tagger(
        model_name="cl-tagger-v2",
        model_path=None,
        tags_path=None,
        model_dir=str(tmp_path / "models"),
        threshold=0.55,
        character_threshold=0.55,
        copyright_threshold=0.55,
        use_gpu=False,
    )

    model_path, vocabulary_path = tagger._download_model()

    assert model_path.replace("\\", "/").endswith("v2_00/model.onnx")
    assert vocabulary_path.replace("\\", "/").endswith("v2_00/model_vocabulary.json")
    assert calls
    assert all(call["repo_id"] == "cella110n/cl_tagger_v2" for call in calls)
    assert all(call["revision"] == "b57909b8e9c63f71e208a26473e7aabdf45ed6b6" for call in calls)
    assert all(call["endpoint"] == "https://huggingface.co" for call in calls)
    records = [
        record
        for record in caplog.records
        if record.message == "Model artifact validation"
    ]
    assert {record.artifact_file for record in records} == set(
        cl_tagger_v2.CL_TAGGER_V2_REQUIRED_FILES
    )
    assert all(record.status == "file_ready" for record in records)


def test_download_reports_gated_huggingface_access(monkeypatch, tmp_path):
    class _Response:
        status_code = 403

    class _GatedError(RuntimeError):
        response = _Response()

    monkeypatch.setattr(
        cl_tagger_v2,
        "hf_hub",
        SimpleNamespace(hf_hub_download=lambda **_kwargs: (_ for _ in ()).throw(_GatedError("403 gated"))),
    )
    tagger = cl_tagger_v2.CLTaggerV2Tagger(
        model_name="cl-tagger-v2",
        model_path=None,
        tags_path=None,
        model_dir=str(tmp_path / "models"),
        threshold=0.55,
        character_threshold=0.55,
        copyright_threshold=0.55,
        use_gpu=False,
    )

    with pytest.raises(cl_tagger_v2.CLTaggerV2AuthRequiredError) as error:
        tagger._download_model()

    message = str(error.value).lower()
    assert "403" in message
    assert "gated" in message
    assert "token" in message or "accept" in message


def test_prepare_route_maps_gated_download_to_external_auth_guidance(
    monkeypatch,
    tmp_path,
) -> None:
    from services import model_service

    monkeypatch.setattr(
        model_service,
        "ensure_group",
        lambda _group: model_service.DependencyInstallResult((), False),
    )
    monkeypatch.setattr(
        cl_tagger_v2.config,
        "get_cl_tagger_v2_model_dir",
        lambda: str(tmp_path / "models"),
    )

    def fail_gated_prepare() -> str:
        raise cl_tagger_v2.CLTaggerV2AuthRequiredError("401 gated checkpoint")

    monkeypatch.setattr(cl_tagger_v2, "prepare_checkpoint", fail_gated_prepare)

    with pytest.raises(model_service.ExternalAuthRequiredError) as error:
        model_service.ModelService().prepare_model("cl-tagger-v2")

    payload = error.value.payload
    assert payload["type"] == "ExternalAuthRequired"
    assert payload["provider"] == "Hugging Face"
    assert payload["external_url"] == "https://huggingface.co/cella110n/cl_tagger_v2"
    # Path separators differ on Windows vs POSIX runners — compare as Path.
    target_dir = Path(payload["target_dir"])
    assert target_dir.name == "cl-tagger-v2"
    assert target_dir.parent.name == "models"
    assert any("terms" in step.lower() for step in payload["manual_steps"])
    assert any("token" in step.lower() for step in payload["manual_steps"])


def test_process_logits_matches_public_tag_result_shape() -> None:
    tagger = object.__new__(cl_tagger_v2.CLTaggerV2Tagger)
    tagger.model_name = "cl-tagger-v2"
    tagger.threshold = 0.55
    tagger.character_threshold = 0.55
    tagger.copyright_threshold = 0.55
    tagger._output_activation = "sigmoid"
    tagger._rating_fallback_mode = "none"
    tagger.general_tags = ((0, "blue_hair"),)
    tagger.copyright_tags = ((1, "series_name"),)
    tagger.character_tags = ((2, "character_name"),)
    tagger.rating_tags = ((3, "explicit"),)
    tagger._general_category_overrides = {}

    result = tagger._process_probs(
        np.asarray([8.0, 7.0, 6.0, 5.0], dtype=np.float32),
        threshold=0.55,
        character_threshold=0.55,
        copyright_threshold=0.55,
    )

    assert [item["tag"] for item in result["general_tags"]] == ["blue_hair"]
    assert [item["tag"] for item in result["copyright_tags"]] == ["series_name"]
    assert [item["tag"] for item in result["character_tags"]] == ["character_name"]
    assert result["rating"] == "explicit"
    assert {item["tag"] for item in result["all_tags"]} == {
        "blue_hair",
        "series_name",
        "character_name",
        "explicit",
    }


def test_smart_tag_dispatches_cl_tagger_v2_without_loading_weights(monkeypatch) -> None:
    calls = []
    sentinel = object()

    def fake_getter(**kwargs):
        calls.append(kwargs)
        return sentinel

    monkeypatch.setitem(
        sys.modules,
        "cl_tagger_v2",
        SimpleNamespace(get_cl_tagger_v2_tagger=fake_getter),
    )

    from services.smart_tag.request import SmartTagRequest
    from services.smart_tag.tagging import _resolve_tagger, _resolve_tagger_by_model

    request = SmartTagRequest(
        tagger_model="cl-tagger-v2",
        use_gpu=False,
        general_threshold=0.6,
        character_threshold=0.7,
        copyright_threshold=0.8,
    )

    assert _resolve_tagger(request) is sentinel
    assert _resolve_tagger_by_model(
        "cl-tagger-v2",
        general_threshold=0.6,
        character_threshold=0.7,
        copyright_threshold=0.8,
        use_gpu=False,
    ) is sentinel
    assert len(calls) == 2
    assert all(call["model_path"] is None for call in calls)
    assert all(call["tags_path"] is None for call in calls)


def test_prepare_route_uses_download_only_checkpoint_helper(monkeypatch) -> None:
    from services import model_service

    calls = []
    monkeypatch.setattr(
        model_service,
        "ensure_group",
        lambda group: calls.append(group)
        or model_service.DependencyInstallResult((), False),
    )
    monkeypatch.setitem(
        sys.modules,
        "cl_tagger_v2",
        SimpleNamespace(
            CLTaggerV2AuthRequiredError=cl_tagger_v2.CLTaggerV2AuthRequiredError,
            prepare_checkpoint=lambda: "C:/models/cl-tagger-v2",
        ),
    )

    result = model_service.ModelService().prepare_model("cl-tagger-v2")

    assert calls == ["cl-tagger-v2"]
    assert result == {
        "status": "ok",
        "model_id": "cl-tagger-v2",
        "message": (
            "CL Tagger v2 runtime and pinned files are ready. "
            "The gated checkpoint was fetched from official Hugging Face."
        ),
        "paths": {"checkpoint_path": "C:/models/cl-tagger-v2"},
    }


def test_regular_tag_request_accepts_cl_tagger_v2_without_hardware_probe() -> None:
    from services.tagging.request import TagRequest
    from services.tagging.service import TaggingService

    TaggingService()._validate_tag_request(
        TagRequest(model_name="cl-tagger-v2", use_gpu=False)
    )
