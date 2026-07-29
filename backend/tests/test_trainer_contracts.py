from __future__ import annotations

import importlib
import importlib.util
import json
import subprocess
import sys
import threading
import tomllib
from pathlib import Path
from types import ModuleType

import pytest
from PIL import Image
from pydantic import ValidationError
from fastapi import HTTPException

from services.dataset_export.models import DatasetExportRequest
from services.dataset_export.engine import export_dataset as export_dataset_engine


pytestmark = pytest.mark.usefixtures("authorize_legacy_dataset_exports")


ROOT = Path(__file__).resolve().parents[2]
VERIFIER = ROOT / "scripts" / "verify_kohya_trainer_contract.py"
VALID_FIXTURE = (
    ROOT
    / "backend"
    / "tests"
    / "fixtures"
    / "kohya"
    / "v0.11.1"
    / "valid-dataset-config.toml"
)
REJECTED_FIXTURE = (
    ROOT
    / "backend"
    / "tests"
    / "fixtures"
    / "kohya"
    / "v0.11.1"
    / "upstream-rejected-dataset-config.toml"
)
PINNED_COMMIT = "6721028c79ee85a78b3a06dfd8954dae310a1cce"
ANIMA_PINNED_COMMIT = "13eaf97a3903405baa939d7cb4a524f8f3e11303"


def _contract_module():
    return importlib.import_module("services.dataset_export.kohya_contract")


def _anima_contract_module():
    return importlib.import_module("services.dataset_export.anima_contract")


def _verifier_module() -> ModuleType:
    spec = importlib.util.spec_from_file_location("kohya_contract_verifier_test", VERIFIER)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Could not load verifier module: {VERIFIER}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _request(tmp_path: Path, **updates: object) -> DatasetExportRequest:
    values: dict[str, object] = {
        "image_paths": [str(tmp_path / "source.png")],
        "output_folder": str(tmp_path),
        "trainer_config": "kohya_toml",
    }
    values.update(updates)
    return DatasetExportRequest.model_validate(values)


def _stage_images(test_db, tmp_path: Path, count: int) -> list[int]:
    source_dir = tmp_path / "sources"
    source_dir.mkdir()
    image_ids: list[int] = []
    for index in range(count):
        source = source_dir / f"source-{index}.png"
        Image.new("RGB", (16, 16), color=(10 + index, 20, 30)).save(source)
        image_ids.append(test_db.add_image(path=str(source), filename=source.name))
    return image_ids


def _save_mask(mask_dir: Path, image_id: int) -> None:
    mask_dir.mkdir(parents=True, exist_ok=True)
    Image.new("L", (16, 16), color=255).save(mask_dir / f"{image_id}.png")


def _single_previous_config(output_dir: Path) -> Path:
    matches = tuple(output_dir.glob("dataset_config.toml.previous.*"))
    assert len(matches) == 1
    return matches[0]


def test_trainers_endpoint_returns_both_strict_verified_contracts(test_client):
    contract_module = _contract_module()
    anima_contract_module = _anima_contract_module()

    response = test_client.get("/api/dataset/trainers")

    assert response.status_code == 200, response.text
    body = response.json()
    assert set(body) == {"trainers"}
    assert len(body["trainers"]) == 2
    trainers = {trainer["id"]: trainer for trainer in body["trainers"]}
    assert set(trainers) == {"kohya_sd_scripts", "anima_lora"}
    trainer = trainers["kohya_sd_scripts"]
    assert trainer["id"] == "kohya_sd_scripts"
    assert trainer["wire_value"] == "kohya_toml"
    assert trainer["contract_version"] == "1.0.0"
    assert trainer["verified"] is True
    assert trainer["upstream"] == {
        "repository": "https://github.com/kohya-ss/sd-scripts",
        "tag": "v0.11.1",
        "commit": PINNED_COMMIT,
    }
    assert trainer["mask_export_modes"] == ["none", "kohya"]
    assert trainer["capabilities"]["caption_extensions"] == [".txt"]
    assert trainer["capabilities"]["conditioning_training_args"] == ["--masked_loss"]
    assert trainer["option_bounds"] == {
        "repeats": {"minimum": 1, "maximum": 1000, "default": 10},
        "batch_size": {"minimum": 1, "maximum": 64, "default": 2},
        "resolution": {"minimum": 256, "maximum": 4096, "default": 1024},
        "keep_tokens": {"minimum": 0, "maximum": 50, "default": 0},
    }
    assert trainer["generated_artifacts"]["dataset_config"] == "dataset_config.toml"
    assert trainer["verification_boundary"]["module"] == "library.config_util"
    assert trainer["verification_boundary"]["validates_artifact_completeness"] is False
    assert trainer["verification_boundary"]["artifact_completeness_gate"] == (
        "all_conditioning_files_before_generation"
    )
    assert trainer["verification_boundary"]["requires_module_path_match"] is True
    contract_module.KohyaTrainerContract.model_validate_json(json.dumps(trainer))
    with pytest.raises(ValidationError):
        contract_module.KohyaTrainerContract.model_validate_json(
            json.dumps({**trainer, "extra": True})
        )

    anima = trainers["anima_lora"]
    assert anima["wire_value"] == "anima_lora_toml"
    assert anima["contract_version"] == "1.0.0"
    assert anima["verified"] is True
    assert anima["upstream"] == {
        "repository": "https://github.com/sorryhyun/anima_lora",
        "tag": "v1.14.2.hotfix",
        "commit": ANIMA_PINNED_COMMIT,
        "license": "MIT",
        "python_requirement": "==3.13.*",
    }
    assert anima["mask_export_modes"] == ["none", "anima_lora"]
    assert anima["capabilities"]["caption_extensions"] == [".txt"]
    assert anima["capabilities"]["loss_mask_suffix"] == "_mask.png"
    assert anima["capabilities"]["class_tokens_behavior"] == "forbidden"
    assert anima["option_bounds"] == {
        "repeats": {"minimum": 1, "maximum": 1000, "default": 10},
        "batch_size": {"minimum": 1, "maximum": 64, "default": 2},
        "resolution": {"minimum": 1024, "maximum": 1024, "default": 1024},
        "keep_tokens": {"minimum": 0, "maximum": 0, "default": 0},
    }
    assert anima["generated_artifacts"]["loss_mask"] == (
        "<relative-path>/<image-stem>_mask.png"
    )
    assert anima["verification_boundary"]["module"] == "library.config.loader"
    assert anima["verification_boundary"]["validates_artifact_completeness"] is False
    assert anima["verification_boundary"]["artifact_completeness_gate"] == (
        "all_captions_and_requested_masks_before_generation"
    )
    anima_contract_module.AnimaTrainerContract.model_validate_json(json.dumps(anima))
    with pytest.raises(ValidationError):
        anima_contract_module.AnimaTrainerContract.model_validate_json(
            json.dumps({**anima, "extra": True})
        )


def test_anima_export_writes_distinct_minimal_toml(test_client, test_db, tmp_path: Path):
    image_id = _stage_images(test_db, tmp_path, 1)[0]
    output_dir = tmp_path / "anima-output"

    response = test_client.post(
        "/api/dataset/export",
        json={
            "image_ids": [image_id],
            "output_folder": str(output_dir),
            "naming_pattern": "{filename}",
            "image_overrides": {str(image_id): "subject, blue eyes"},
            "trainer_config": "anima_lora_toml",
            "trainer_repeats": 7,
            "trainer_batch": 3,
        },
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "ok"
    config_path = Path(body["trainer_config_path"])
    parsed = tomllib.loads(config_path.read_text(encoding="utf-8"))
    assert set(parsed) == {"datasets"}
    dataset = parsed["datasets"][0]
    subset = dataset["subsets"][0]
    assert dataset == {
        "batch_size": 3,
        "subsets": [{
            "image_dir": str(output_dir).replace("\\", "/"),
            "caption_extension": ".txt",
            "num_repeats": 7,
        }],
    }
    assert "general" not in parsed
    assert "resolution" not in dataset
    assert "class_tokens" not in subset
    assert "conditioning_data_dir" not in subset
    assert "mask_dir" not in subset


def test_anima_export_writes_complete_loss_mask_package(
    test_client,
    test_db,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    from services import mask_service

    image_ids = _stage_images(test_db, tmp_path, 2)
    mask_dir = tmp_path / "anima-stored-masks"
    monkeypatch.setattr(mask_service, "MASKS_DIR", mask_dir)
    for image_id in image_ids:
        _save_mask(mask_dir, image_id)
    output_dir = tmp_path / "anima-masked-output"

    response = test_client.post(
        "/api/dataset/export",
        json={
            "image_ids": image_ids,
            "output_folder": str(output_dir),
            "naming_pattern": "{filename}",
            "image_overrides": {
                str(image_id): f"subject {index}"
                for index, image_id in enumerate(image_ids)
            },
            "mask_export": "anima_lora",
            "trainer_config": "anima_lora_toml",
        },
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "ok"
    assert body["masks_written"] == 2
    assert body["masks_missing"] == 0
    assert (output_dir / "mask" / "source-0_mask.png").is_file()
    assert (output_dir / "mask" / "source-1_mask.png").is_file()
    parsed = tomllib.loads(Path(body["trainer_config_path"]).read_text(encoding="utf-8"))
    subset = parsed["datasets"][0]["subsets"][0]
    assert subset["mask_dir"] == str(output_dir / "mask").replace("\\", "/")
    assert "conditioning_data_dir" not in subset


def test_anima_export_withholds_config_when_requested_mask_is_missing(
    test_client,
    test_db,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    from services import mask_service

    image_ids = _stage_images(test_db, tmp_path, 2)
    mask_dir = tmp_path / "partial-anima-stored-masks"
    monkeypatch.setattr(mask_service, "MASKS_DIR", mask_dir)
    _save_mask(mask_dir, image_ids[0])
    output_dir = tmp_path / "partial-anima-output"
    output_dir.mkdir()
    stale_config = output_dir / "dataset_config.toml"
    stale_content = "# Generated by SD Image Sorter for anima_lora v1.14.2.hotfix.\n"
    stale_config.write_text(stale_content, encoding="utf-8")

    response = test_client.post(
        "/api/dataset/export",
        json={
            "image_ids": image_ids,
            "output_folder": str(output_dir),
            "naming_pattern": "{filename}",
            "image_overrides": {
                str(image_id): f"subject {index}"
                for index, image_id in enumerate(image_ids)
            },
            "mask_export": "anima_lora",
            "trainer_config": "anima_lora_toml",
        },
    )

    assert response.status_code == 409, response.text
    body = response.json()
    assert body["code"] == "readiness_blocked"
    assert "anima_mask_missing" in {issue["code"] for issue in body["issues"]}
    assert stale_config.read_text(encoding="utf-8") == stale_content
    assert tuple(output_dir.glob("dataset_config.toml.previous.*")) == ()


def test_anima_masked_path_source_fails_closed_without_stored_mask(
    test_client,
    tmp_path: Path,
):
    source = tmp_path / "path-source.png"
    Image.new("RGB", (16, 16), color=(10, 20, 30)).save(source)
    output_dir = tmp_path / "path-source-output"

    response = test_client.post(
        "/api/dataset/export",
        json={
            "image_paths": [str(source)],
            "output_folder": str(output_dir),
            "naming_pattern": "{filename}",
            "image_overrides": {str(source.resolve()): "subject"},
            "mask_export": "anima_lora",
            "trainer_config": "anima_lora_toml",
        },
    )

    assert response.status_code == 409, response.text
    body = response.json()
    assert body["code"] == "readiness_blocked"
    assert "anima_mask_missing" in {issue["code"] for issue in body["issues"]}
    assert output_dir.exists() is False


def test_anima_cancelled_export_invalidates_previous_generated_config(
    tmp_path: Path,
) -> None:
    source = tmp_path / "cancel-source.png"
    Image.new("RGB", (16, 16), color=(10, 20, 30)).save(source)
    output_dir = tmp_path / "cancel-output"
    output_dir.mkdir()
    target = output_dir / "dataset_config.toml"
    stale_content = "# Generated by SD Image Sorter for anima_lora v1.14.2.hotfix.\n"
    target.write_text(stale_content, encoding="utf-8")
    cancel_event = threading.Event()
    cancel_event.set()
    request = DatasetExportRequest(
        image_paths=[str(source)],
        output_folder=str(output_dir),
        image_overrides={str(source.resolve()): "subject"},
        trainer_config="anima_lora_toml",
    )

    result = export_dataset_engine(request, cancel_event=cancel_event)

    assert result.status == "cancelled"
    assert result.trainer_config_path is None
    assert target.exists() is False
    assert _single_previous_config(output_dir).read_text(encoding="utf-8") == stale_content


def test_anima_zero_export_invalidates_previous_generated_config(
    tmp_path: Path,
) -> None:
    source = tmp_path / "skip-source.png"
    Image.new("RGB", (16, 16), color=(10, 20, 30)).save(source)
    output_dir = tmp_path / "skip-output"
    output_dir.mkdir()
    Image.new("RGB", (16, 16), color=(30, 20, 10)).save(
        output_dir / source.name
    )
    target = output_dir / "dataset_config.toml"
    stale_content = "# Generated by SD Image Sorter for anima_lora v1.14.2.hotfix.\n"
    target.write_text(stale_content, encoding="utf-8")
    request = DatasetExportRequest(
        image_paths=[str(source)],
        output_folder=str(output_dir),
        overwrite_policy="skip",
        image_overrides={str(source.resolve()): "subject"},
        trainer_config="anima_lora_toml",
    )

    result = export_dataset_engine(request)

    assert result.exported == 0
    assert result.trainer_config_path is None
    assert target.exists() is False
    assert _single_previous_config(output_dir).read_text(encoding="utf-8") == stale_content


def test_anima_export_rejects_unknown_existing_config_without_writes(
    test_client,
    tmp_path: Path,
) -> None:
    source = tmp_path / "custom-config-source.png"
    Image.new("RGB", (16, 16), color=(10, 20, 30)).save(source)
    output_dir = tmp_path / "custom-config-output"
    output_dir.mkdir()
    target = output_dir / "dataset_config.toml"
    custom_content = "# User-maintained trainer config\n"
    target.write_text(custom_content, encoding="utf-8")

    response = test_client.post(
        "/api/dataset/export",
        json={
            "image_paths": [str(source)],
            "output_folder": str(output_dir),
            "image_overrides": {str(source.resolve()): "subject"},
            "trainer_config": "anima_lora_toml",
        },
    )

    assert response.status_code == 409, response.text
    assert "not generated by SD Image Sorter" in response.json()["error"]
    assert target.read_text(encoding="utf-8") == custom_content
    assert (output_dir / source.name).exists() is False
    assert tuple(output_dir.glob("dataset_config.toml.previous.*")) == ()


def test_anima_queued_cancel_preserves_previous_config_until_worker(
    test_client,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import services.dataset_export_service as export_service
    from services.bulk_job_service import get_bulk_job_service

    source = tmp_path / "queued-cancel-source.png"
    Image.new("RGB", (16, 16), color=(10, 20, 30)).save(source)
    output_dir = tmp_path / "queued-cancel-output"
    output_dir.mkdir()
    target = output_dir / "dataset_config.toml"
    stale_content = "# Generated by SD Image Sorter for anima_lora v1.14.2.hotfix.\n"
    target.write_text(stale_content, encoding="utf-8")
    held_tasks: list[tuple[object, tuple[object, ...], dict[str, object]]] = []

    def hold_background_task(self, func, *args, **kwargs) -> None:
        held_tasks.append((func, args, kwargs))

    monkeypatch.setattr(export_service.BackgroundTasks, "add_task", hold_background_task)
    response = test_client.post(
        "/api/dataset/export/start",
        json={
            "image_paths": [str(source)],
            "output_folder": str(output_dir),
            "image_overrides": {str(source.resolve()): "subject"},
            "trainer_config": "anima_lora_toml",
        },
    )

    assert response.status_code == 200, response.text
    job_id = response.json()["job_id"]
    assert len(held_tasks) == 1
    assert target.read_text(encoding="utf-8") == stale_content
    assert tuple(output_dir.glob("dataset_config.toml.previous.*")) == ()
    cancelled = test_client.post(f"/api/bulk-jobs/{job_id}/cancel")
    assert cancelled.status_code == 200, cancelled.text
    assert cancelled.json()["status"] == "cancelled"
    assert get_bulk_job_service().get_job(job_id)["result"]["trainer_config_path"] is None


def test_anima_invalidation_preserves_existing_user_previous_file(
    tmp_path: Path,
) -> None:
    source = tmp_path / "preserve-source.png"
    Image.new("RGB", (16, 16), color=(10, 20, 30)).save(source)
    output_dir = tmp_path / "preserve-output"
    output_dir.mkdir()
    target = output_dir / "dataset_config.toml"
    stale_content = "# Generated by SD Image Sorter for anima_lora v1.14.2.hotfix.\n"
    target.write_text(stale_content, encoding="utf-8")
    user_previous = output_dir / "dataset_config.toml.previous"
    user_content = b"user-maintained previous config\x00\xff"
    user_previous.write_bytes(user_content)
    cancel_event = threading.Event()
    cancel_event.set()
    request = DatasetExportRequest(
        image_paths=[str(source)],
        output_folder=str(output_dir),
        image_overrides={str(source.resolve()): "subject"},
        trainer_config="anima_lora_toml",
    )

    result = export_dataset_engine(request, cancel_event=cancel_event)

    assert result.status == "cancelled"
    assert target.exists() is False
    assert user_previous.read_bytes() == user_content
    archives = tuple(output_dir.glob("dataset_config.toml.previous.*"))
    assert len(archives) == 1
    assert archives[0].read_text(encoding="utf-8") == stale_content


def test_anima_invalidation_preserves_concurrently_replaced_active_config(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import services.dataset_export.artifacts as artifacts
    source = tmp_path / "race-source.png"
    Image.new("RGB", (16, 16), color=(10, 20, 30)).save(source)
    output_dir = tmp_path / "race-output"
    output_dir.mkdir()
    target = output_dir / "dataset_config.toml"
    target.write_text(
        "# Generated by SD Image Sorter for anima_lora v1.14.2.hotfix.\n",
        encoding="utf-8",
    )
    replacement = output_dir / "concurrent-user-config.toml"
    replacement_content = b"concurrent user config\x00\xff"
    replacement.write_bytes(replacement_content)
    real_replace = artifacts.os.replace

    def replace_after_concurrent_change(source_path: str, destination_path: str) -> None:
        if Path(source_path) == target:
            real_replace(str(replacement), str(target))
        real_replace(source_path, destination_path)

    monkeypatch.setattr(artifacts.os, "replace", replace_after_concurrent_change)
    cancel_event = threading.Event()
    cancel_event.set()
    request = DatasetExportRequest(
        image_paths=[str(source)],
        output_folder=str(output_dir),
        image_overrides={str(source.resolve()): "subject"},
        trainer_config="anima_lora_toml",
    )

    with pytest.raises(HTTPException) as exc:
        export_dataset_engine(request, cancel_event=cancel_event)

    assert exc.value.status_code == 409
    assert "changed while it was being invalidated" in str(exc.value.detail)
    assert target.exists() is False
    archives = tuple(output_dir.glob("dataset_config.toml.previous.*"))
    assert len(archives) == 1
    assert archives[0].read_bytes() == replacement_content


@pytest.mark.parametrize(
    "updates, expected",
    [
        ({"content_mode": "json"}, "requires text captions"),
        ({"trainer_keep_tokens": 1}, "trainer_keep_tokens=0"),
        ({"trainer_resolution": 768}, "trainer_resolution=1024"),
        ({"mask_export": "kohya"}, "mask_export='none' or 'anima_lora'"),
    ],
)
def test_anima_export_rejects_unsupported_request_options(
    test_client,
    tmp_path: Path,
    updates: dict[str, object],
    expected: str,
):
    source = tmp_path / "source.png"
    Image.new("RGB", (16, 16), color=(10, 20, 30)).save(source)
    payload: dict[str, object] = {
        "image_paths": [str(source)],
        "output_folder": str(tmp_path / "out"),
        "image_overrides": {str(source.resolve()): "subject"},
        "trainer_config": "anima_lora_toml",
    }
    payload.update(updates)

    response = test_client.post("/api/dataset/export", json=payload)

    assert response.status_code == 400, response.text
    assert expected in response.json()["error"]
    assert (tmp_path / "out").exists() is False


def test_kohya_selected_rejects_json_captions_before_export(test_client, tmp_path: Path):
    source = tmp_path / "source.png"
    Image.new("RGB", (16, 16), color=(10, 20, 30)).save(source)

    response = test_client.post("/api/dataset/export", json={
        "image_paths": [str(source)],
        "output_folder": str(tmp_path / "out"),
        "trainer_config": "kohya_toml",
        "content_mode": "json",
    })

    assert response.status_code == 400, response.text
    assert "Kohya contract requires text captions" in response.json()["error"]
    assert (tmp_path / "out").exists() is False


def test_kohya_partial_conditioning_masks_fail_without_config(tmp_path: Path):
    contract_module = _contract_module()
    request = _request(tmp_path, mask_export="kohya")

    with pytest.raises(
        contract_module.KohyaTrainerContractError,
        match="requires a conditioning mask for every exported image",
    ):
        contract_module.write_kohya_dataset_config(
            tmp_path,
            request,
            masks_written=1,
            masks_missing=1,
        )

    assert (tmp_path / "dataset_config.toml").exists() is False


def test_kohya_partial_conditioning_export_is_partial_without_config(
    test_client,
    test_db,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    from services import mask_service

    image_ids = _stage_images(test_db, tmp_path, 2)
    mask_dir = tmp_path / "stored-masks"
    monkeypatch.setattr(mask_service, "MASKS_DIR", mask_dir)
    _save_mask(mask_dir, image_ids[0])
    output_dir = tmp_path / "partial-mask-output"

    result = export_dataset_engine(DatasetExportRequest(
        image_ids=image_ids,
        output_folder=str(output_dir),
        naming_pattern="{filename}",
        mask_export="kohya",
        trainer_config="kohya_toml",
    ))

    assert result.status == "partial"
    assert result.error_count > 0
    assert result.masks_written == 1
    assert result.masks_missing == 1
    assert any(
        "requires a conditioning mask for every exported image" in message
        for message in result.error_messages
    )
    assert result.trainer_config_path is None
    assert (output_dir / "dataset_config.toml").exists() is False
    manifest = json.loads((output_dir / "export_manifest.json").read_text(encoding="utf-8"))
    assert manifest["package_status"] == "incomplete"
    assert manifest["counts"]["failed"] > 0


def test_kohya_invalid_mask_directory_blocks_before_export(
    test_client,
    test_db,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    from services import mask_service

    image_id = _stage_images(test_db, tmp_path, 1)[0]
    mask_dir = tmp_path / "stored-masks"
    monkeypatch.setattr(mask_service, "MASKS_DIR", mask_dir)
    _save_mask(mask_dir, image_id)
    output_dir = tmp_path / "failed-mask-output"
    output_dir.mkdir()
    (output_dir / "mask").write_text("blocks the mask directory", encoding="utf-8")

    with pytest.raises(HTTPException) as exc:
        export_dataset_engine(DatasetExportRequest(
            image_ids=[image_id],
            output_folder=str(output_dir),
            naming_pattern="{filename}",
            mask_export="kohya",
            trainer_config="kohya_toml",
        ))

    assert exc.value.status_code == 409
    assert "mask directory" in str(exc.value.detail)
    assert list(output_dir.glob("*.png")) == []
    assert (output_dir / "dataset_config.toml").exists() is False
    assert (output_dir / "export_manifest.json").exists() is False


def test_kohya_config_write_failure_is_actionable(
    test_client,
    test_db,
    tmp_path: Path,
):
    image_id = _stage_images(test_db, tmp_path, 1)[0]
    output_dir = tmp_path / "failed-config-output"
    output_dir.mkdir()
    config_target = output_dir / "dataset_config.toml"
    config_target.mkdir()

    result = export_dataset_engine(DatasetExportRequest(
        image_ids=[image_id],
        output_folder=str(output_dir),
        naming_pattern="{filename}",
        trainer_config="kohya_toml",
    ))

    assert result.status == "partial"
    assert result.error_count == 1
    assert any(
        "Kohya dataset config could not be written" in message
        and str(config_target).casefold() in message.casefold()
        for message in result.error_messages
    )
    assert result.trainer_config_path is None
    manifest = json.loads((output_dir / "export_manifest.json").read_text(encoding="utf-8"))
    assert manifest["package_status"] == "incomplete"
    assert manifest["counts"]["failed"] == 1


def test_kohya_withholds_config_when_caption_write_fails(
    test_client,
    test_db,
    tmp_path: Path,
):
    image_ids = _stage_images(test_db, tmp_path, 2)
    output_dir = tmp_path / "caption-failure-output"
    output_dir.mkdir()
    failed_caption = output_dir / "source-1.txt"
    failed_caption.mkdir()

    result = export_dataset_engine(DatasetExportRequest(
        image_ids=image_ids,
        output_folder=str(output_dir),
        naming_pattern="{filename}",
        overwrite_policy="overwrite",
        trainer_config="kohya_toml",
    ))

    assert result.status == "partial"
    assert result.exported == 1
    assert result.error_count == 1
    assert any("failed to write caption" in message for message in result.error_messages)
    assert sum(
        "Kohya dataset config withheld" in message
        for message in result.error_messages
    ) == 1
    assert result.trainer_config_path is None
    assert (output_dir / "dataset_config.toml").exists() is False
    assert (output_dir / "source-1.png").is_file()
    assert failed_caption.is_file() is False
    manifest = json.loads((output_dir / "export_manifest.json").read_text(encoding="utf-8"))
    assert manifest["package_status"] == "incomplete"
    assert manifest["counts"]["failed"] == 1


def test_kohya_writer_toml_escapes_trigger_and_validates_round_trip(tmp_path: Path):
    contract_module = _contract_module()
    trigger = 'hero"quoted"\\token'
    request = _request(tmp_path, trigger=trigger, trainer_keep_tokens=2)

    target = contract_module.write_kohya_dataset_config(
        tmp_path,
        request,
        masks_written=0,
        masks_missing=0,
    )

    parsed = tomllib.loads(Path(target).read_text(encoding="utf-8"))
    subset = parsed["datasets"][0]["subsets"][0]
    assert subset["class_tokens"] == trigger
    assert subset["caption_extension"] == ".txt"
    assert subset["shuffle_caption"] is True
    assert subset["keep_tokens"] == 2


def test_kohya_conditioning_config_omits_class_tokens(tmp_path: Path):
    contract_module = _contract_module()
    request = _request(
        tmp_path,
        mask_export="kohya",
        trigger="hero_trigger",
    )

    target = contract_module.write_kohya_dataset_config(
        tmp_path,
        request,
        masks_written=1,
        masks_missing=0,
    )

    parsed = tomllib.loads(Path(target).read_text(encoding="utf-8"))
    subset = parsed["datasets"][0]["subsets"][0]
    assert subset["conditioning_data_dir"] == str(tmp_path / "mask").replace("\\", "/")
    assert "class_tokens" not in subset


def test_verifier_requires_explicit_existing_environment(tmp_path: Path):
    result = subprocess.run(
        [
            sys.executable,
            str(VERIFIER),
            "--sd-scripts-root",
            str(tmp_path / "missing-sd-scripts"),
            "--sd-scripts-python",
            str(tmp_path / "missing-python"),
            str(tmp_path / "missing-config.toml"),
        ],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode != 0
    assert "sd-scripts root does not exist" in result.stderr
    assert str(tmp_path / "missing-sd-scripts").casefold() in result.stderr.casefold()


def test_verifier_rejects_versioned_contract_fixture_before_upstream(tmp_path: Path):
    result = subprocess.run(
        [
            sys.executable,
            str(VERIFIER),
            "--sd-scripts-root",
            str(tmp_path),
            "--sd-scripts-python",
            sys.executable,
            str(REJECTED_FIXTURE),
        ],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode != 0
    assert "failed local contract validation" in result.stderr
    assert "unsupported_contract_probe" in result.stderr


def test_verifier_rejects_upstream_commit_drift(tmp_path: Path):
    checkout = tmp_path / "sd-scripts"
    checkout.mkdir()
    subprocess.run(["git", "init", "--quiet"], cwd=checkout, check=True)
    subprocess.run(["git", "config", "user.email", "test@example.invalid"], cwd=checkout, check=True)
    subprocess.run(["git", "config", "user.name", "Contract Test"], cwd=checkout, check=True)
    (checkout / "README.md").write_text("test checkout", encoding="utf-8")
    subprocess.run(["git", "add", "README.md"], cwd=checkout, check=True)
    subprocess.run(["git", "commit", "--quiet", "-m", "test"], cwd=checkout, check=True)
    config = tmp_path / "dataset_config.toml"
    config.write_text(
        "[general]\nenable_bucket = true\n"
        "[[datasets]]\nresolution = 1024\nbatch_size = 2\n"
        "[[datasets.subsets]]\nimage_dir = \"./images\"\n"
        "caption_extension = \".txt\"\nnum_repeats = 10\n",
        encoding="utf-8",
    )

    result = subprocess.run(
        [
            sys.executable,
            str(VERIFIER),
            "--sd-scripts-root",
            str(checkout),
            "--sd-scripts-python",
            sys.executable,
            str(config),
        ],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode != 0
    assert "sd-scripts commit mismatch" in result.stderr
    assert PINNED_COMMIT in result.stderr


def test_verifier_rejects_dirty_tracked_checkout(tmp_path: Path):
    verifier = _verifier_module()
    checkout = tmp_path / "sd-scripts"
    checkout.mkdir()
    tracked = checkout / "tracked.txt"
    subprocess.run(["git", "init", "--quiet"], cwd=checkout, check=True)
    subprocess.run(["git", "config", "user.email", "test@example.invalid"], cwd=checkout, check=True)
    subprocess.run(["git", "config", "user.name", "Contract Test"], cwd=checkout, check=True)
    tracked.write_text("clean", encoding="utf-8")
    subprocess.run(["git", "add", "tracked.txt"], cwd=checkout, check=True)
    subprocess.run(["git", "commit", "--quiet", "-m", "test"], cwd=checkout, check=True)
    tracked.write_text("dirty", encoding="utf-8")

    with pytest.raises(verifier.KohyaVerifierError) as exc:
        verifier._require_clean_checkout(checkout.resolve(), "before module path probe")

    message = str(exc.value)
    assert "sd-scripts tracked checkout is dirty" in message
    assert "before module path probe" in message
    assert "tracked.txt" in message


def test_verifier_rejects_module_import_outside_pinned_root(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    verifier = _verifier_module()
    checkout = tmp_path / "sd-scripts"
    expected_module = checkout / "library" / "config_util.py"
    expected_module.parent.mkdir(parents=True)
    expected_module.write_text("# pinned module", encoding="utf-8")
    foreign_module = tmp_path / "vendor" / "sd-scripts" / "library" / "config_util.py"
    foreign_module.parent.mkdir(parents=True)
    foreign_module.write_text("# foreign module", encoding="utf-8")
    monkeypatch.setattr(verifier, "_checkout_commit", lambda _root: PINNED_COMMIT)
    monkeypatch.setattr(verifier, "_require_clean_checkout", lambda _root, _phase: None)

    calls: list[tuple[list[str], dict[str, object]]] = []

    def fake_run(command: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
        calls.append((command, kwargs))
        return subprocess.CompletedProcess(
            command,
            0,
            stdout=f"SD_IMAGE_SORTER_KOHYA_MODULE={foreign_module.resolve()}\n",
            stderr="",
        )

    monkeypatch.setattr(verifier.subprocess, "run", fake_run)

    with pytest.raises(verifier.KohyaVerifierError) as exc:
        verifier.verify_contract(checkout, Path(sys.executable), VALID_FIXTURE)

    message = str(exc.value)
    assert "sd-scripts module path mismatch" in message
    assert str(expected_module.resolve()).casefold() in message.casefold()
    assert str(foreign_module.resolve()).casefold() in message.casefold()
    assert len(calls) == 1


def test_verifier_probes_and_imports_with_same_runtime_context(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    verifier = _verifier_module()
    checkout = tmp_path / "sd-scripts"
    expected_module = checkout / "library" / "config_util.py"
    expected_module.parent.mkdir(parents=True)
    expected_module.write_text("# pinned module", encoding="utf-8")
    monkeypatch.setattr(verifier, "_checkout_commit", lambda _root: PINNED_COMMIT)
    monkeypatch.setattr(verifier, "_require_clean_checkout", lambda _root, _phase: None)

    calls: list[tuple[list[str], dict[str, object]]] = []

    def fake_run(command: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
        calls.append((command, kwargs))
        if command[1] == "-c":
            return subprocess.CompletedProcess(
                command,
                0,
                stdout=f"SD_IMAGE_SORTER_KOHYA_MODULE={expected_module.resolve()}\n",
                stderr="",
            )
        return subprocess.CompletedProcess(command, 0, stdout="accepted", stderr="")

    monkeypatch.setattr(verifier.subprocess, "run", fake_run)

    result = verifier.verify_contract(checkout, Path(sys.executable), VALID_FIXTURE)

    assert result["module_path"] == str(expected_module.resolve())
    assert len(calls) == 2
    probe_command, probe_kwargs = calls[0]
    import_command, import_kwargs = calls[1]
    assert probe_command[:2] == [str(Path(sys.executable).resolve()), "-c"]
    assert import_command[1:3] == ["-m", "library.config_util"]
    assert probe_kwargs["cwd"] == import_kwargs["cwd"] == checkout.resolve()
    assert probe_kwargs["env"] is import_kwargs["env"]
