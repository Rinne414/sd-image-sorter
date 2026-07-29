"""Focused contracts for the exact-output Dataset Readiness preflight."""

from __future__ import annotations

import shutil
import json
import threading
import tracemalloc
from pathlib import Path

import pytest
from PIL import Image

import services.dataset_session_service as dataset_session_service
import services.dataset_export.readiness as readiness_module
import routers.dataset as dataset_router
from services import mask_service
from services.bulk_job_service import (
    JOB_KIND_DATASET_READINESS,
    BulkJobService,
    get_bulk_job_service,
)
from services.dataset_export.engine import export_dataset
from services.dataset_export.models import (
    DatasetExportRequest,
    DatasetReadinessReport,
    DatasetReadinessRequest,
)
from services.dataset_export.readiness import run_dataset_readiness
from services.dataset_export.readiness_proof_store import (
    ReadinessProof,
    ReadinessProofExpiredError,
    ReadinessProofStore,
    get_readiness_proof_store,
)


def _readiness_request(
    image_paths: list[str],
    dataset_scan_tokens: list[dict[str, object]],
    output_folder: Path,
    image_overrides: dict[str, str],
) -> DatasetReadinessRequest:
    return DatasetReadinessRequest(
        image_paths=image_paths,
        dataset_scan_tokens=dataset_scan_tokens,
        output_folder=str(output_folder),
        naming_pattern="{filename}",
        trigger="subject",
        content_mode="tags",
        image_overrides=image_overrides,
        overwrite_policy="unique",
    )


def _run(request: DatasetReadinessRequest) -> DatasetReadinessReport:
    return run_dataset_readiness(
        request,
        readiness_report_id="readiness-test",
        progress_callback=lambda _processed, _total, _message: None,
        cancellation_requested=lambda: False,
    )


def _proof(store: ReadinessProofStore, report_id: str) -> ReadinessProof:
    report = DatasetReadinessReport.model_validate({
        "report_id": report_id,
        "input_fingerprint": "2" * 64,
        "rule_version": "dataset-readiness-v1",
        "summary": {
            "status": "ready",
            "total_requested": 1,
            "processed": 1,
            "trainable_pairs": 1,
            "blocker_count": 0,
            "warning_count": 0,
        },
        "issues": [],
        "total_issues": 0,
        "issues_truncated": False,
        "sample_pairs": [],
        "sample_pairs_truncated": False,
    })
    return store.prepare(report, "1" * 64)


def test_readiness_proof_store_expires_evicts_and_does_not_survive_restart() -> None:
    now = [100.0]
    store = ReadinessProofStore(
        ttl_seconds=10.0,
        capacity=2,
        clock=lambda: now[0],
    )
    first = _proof(store, "a" * 32)
    store.publish(first)
    now[0] = 101.0
    second = _proof(store, "b" * 32)
    store.publish(second)
    now[0] = 102.0
    third = _proof(store, "c" * 32)
    store.publish(third)

    assert store.get("a" * 32) is None
    assert store.get("b" * 32) == second
    assert store.get("c" * 32) == third
    assert ReadinessProofStore(
        ttl_seconds=10.0,
        capacity=2,
        clock=lambda: now[0],
    ).get("b" * 32) is None

    now[0] = 112.0
    with pytest.raises(ReadinessProofExpiredError, match="expired"):
        store.get("b" * 32)


def test_readiness_request_fingerprint_excludes_export_proof_fields(
    tmp_path: Path,
) -> None:
    request = _readiness_request([], [], tmp_path / "proof-fields", {})
    with_proof = DatasetReadinessRequest.model_validate({
        **request.model_dump(mode="json"),
        "readiness_report_id": "a" * 32,
        "readiness_input_fingerprint": "b" * 64,
    })

    assert readiness_module.dataset_readiness_fingerprint(request) == (
        readiness_module.dataset_readiness_fingerprint(with_proof)
    )


def test_readiness_plans_exact_outputs_without_creating_output_directory(
    tmp_path: Path,
) -> None:
    source = tmp_path / "source.png"
    Image.new("RGB", (8, 8), color=(10, 20, 30)).save(source)
    output_folder = tmp_path / "not-created" / "dataset"
    request = _readiness_request(
        [str(source)],
        [],
        output_folder,
        {str(source.resolve()): "subject, blue eyes"},
    )

    report = _run(request)

    assert report.summary.status == "ready"
    assert report.summary.total_requested == 1
    assert report.summary.processed == 1
    assert report.summary.trainable_pairs == 1
    assert report.sample_pairs[0].output_image_path == str(output_folder / "source.png")
    assert report.sample_pairs[0].output_caption_path == str(output_folder / "source.txt")
    assert output_folder.exists() is False


def test_anima_readiness_blocks_requested_missing_loss_mask(
    test_db,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = tmp_path / "anima-missing-mask.png"
    Image.new("RGB", (8, 8), color=(10, 20, 30)).save(source)
    image_id = test_db.add_image(path=str(source), filename=source.name)
    monkeypatch.setattr(mask_service, "MASKS_DIR", tmp_path / "stored-masks")
    output_folder = tmp_path / "anima-missing-mask-output"
    request = DatasetReadinessRequest(
        image_ids=[image_id],
        output_folder=str(output_folder),
        naming_pattern="{filename}",
        image_overrides={str(image_id): "subject"},
        mask_export="anima_lora",
        trainer_config="anima_lora_toml",
    )

    report = _run(request)

    assert report.summary.status == "blocked"
    assert report.summary.trainable_pairs == 1
    issues = [issue for issue in report.issues if issue.code == "anima_mask_missing"]
    assert len(issues) == 1
    assert issues[0].image_id == image_id
    assert issues[0].source_path == str(source.resolve())
    assert issues[0].destination == str(output_folder / "mask" / "anima-missing-mask_mask.png")
    assert output_folder.exists() is False


def test_anima_readiness_accepts_complete_loss_mask_without_writing(
    test_db,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = tmp_path / "anima-complete-mask.png"
    Image.new("RGB", (8, 8), color=(10, 20, 30)).save(source)
    image_id = test_db.add_image(path=str(source), filename=source.name)
    masks_dir = tmp_path / "stored-masks"
    monkeypatch.setattr(mask_service, "MASKS_DIR", masks_dir)
    masks_dir.mkdir()
    Image.new("L", (8, 8), color=255).save(masks_dir / f"{image_id}.png")
    output_folder = tmp_path / "anima-complete-mask-output"
    request = DatasetReadinessRequest(
        image_ids=[image_id],
        output_folder=str(output_folder),
        naming_pattern="{filename}",
        image_overrides={str(image_id): "subject"},
        mask_export="anima_lora",
        trainer_config="anima_lora_toml",
    )

    report = _run(request)

    assert report.summary.status == "ready"
    assert report.summary.trainable_pairs == 1
    assert "anima_mask_missing" not in {issue.code for issue in report.issues}
    assert output_folder.exists() is False


def test_kohya_readiness_blocks_requested_missing_conditioning_mask(
    test_db,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = tmp_path / "kohya-missing-mask.png"
    Image.new("RGB", (8, 8), color=(10, 20, 30)).save(source)
    image_id = test_db.add_image(path=str(source), filename=source.name)
    monkeypatch.setattr(mask_service, "MASKS_DIR", tmp_path / "stored-masks")
    output_folder = tmp_path / "kohya-missing-mask-output"
    request = DatasetReadinessRequest(
        image_ids=[image_id],
        output_folder=str(output_folder),
        naming_pattern="{filename}",
        image_overrides={str(image_id): "subject"},
        mask_export="kohya",
        trainer_config="kohya_toml",
    )

    report = _run(request)

    assert report.summary.status == "blocked"
    issues = [issue for issue in report.issues if issue.code == "kohya_mask_missing"]
    assert len(issues) == 1
    assert issues[0].image_id == image_id
    assert issues[0].destination == str(output_folder / "mask" / source.name)
    assert output_folder.exists() is False


def test_kohya_readiness_blocks_path_source_without_conditioning_mask(
    tmp_path: Path,
) -> None:
    source = tmp_path / "kohya-path-source.png"
    Image.new("RGB", (8, 8), color=(10, 20, 30)).save(source)
    output_folder = tmp_path / "kohya-path-mask-output"
    request = DatasetReadinessRequest(
        image_paths=[str(source)],
        output_folder=str(output_folder),
        naming_pattern="{filename}",
        image_overrides={str(source.resolve()): "subject"},
        mask_export="kohya",
        trainer_config="kohya_toml",
    )

    report = _run(request)

    assert report.summary.status == "blocked"
    issues = [issue for issue in report.issues if issue.code == "kohya_mask_missing"]
    assert len(issues) == 1
    assert issues[0].image_id is None
    assert issues[0].destination == str(output_folder / "mask" / source.name)
    assert output_folder.exists() is False


def test_readiness_traverses_complete_scan_token_larger_than_db_chunk(
    tmp_path: Path,
    monkeypatch,
) -> None:
    source_folder = tmp_path / "large-source"
    source_folder.mkdir()
    seed = source_folder / "image-0000.png"
    Image.new("RGB", (1, 1), color=(1, 2, 3)).save(seed)
    for index in range(1, 501):
        shutil.copyfile(seed, source_folder / f"image-{index:04d}.png")

    scan_dir = tmp_path / "scan-manifests"
    scan_dir.mkdir()
    monkeypatch.setattr(dataset_session_service, "_SCAN_DIR", scan_dir)
    scan = dataset_session_service.scan_folder_for_dataset(
        str(source_folder),
        recursive=False,
        limit=1,
    )
    output_folder = tmp_path / "large-output"
    source_overrides = {
        str(path.resolve()): "subject"
        for path in source_folder.glob("*.png")
    }
    request = _readiness_request(
        [],
        [{"scan_token": scan["scan_token"], "exclude_paths": []}],
        output_folder,
        source_overrides,
    )

    report = _run(request)

    assert report.summary.status == "ready"
    assert report.summary.total_requested == 501
    assert report.summary.processed == 501
    assert report.summary.trainable_pairs == 501
    assert output_folder.exists() is False


def test_readiness_blocks_empty_caption_and_missing_source_with_stable_fingerprint(
    tmp_path: Path,
) -> None:
    source = tmp_path / "empty-caption.png"
    Image.new("RGB", (8, 8), color=(30, 20, 10)).save(source)
    missing = tmp_path / "missing.png"
    output_folder = tmp_path / "blocked-output"
    request = _readiness_request(
        [str(source), str(missing)],
        [],
        output_folder,
        {str(source.resolve()): ""},
    )

    equivalent_payload = request.model_dump(mode="json")
    equivalent_payload["image_paths"] = [
        path.replace("\\", "/")
        for path in equivalent_payload["image_paths"]
    ]
    equivalent_payload["output_folder"] = str(output_folder).replace("\\", "/")
    equivalent_payload["image_overrides"] = {
        key.replace("\\", "/"): value
        for key, value in equivalent_payload["image_overrides"].items()
    }

    first = _run(request)
    second = _run(DatasetReadinessRequest.model_validate(equivalent_payload))

    assert first.summary.status == "blocked"
    assert first.summary.total_requested == 2
    assert first.summary.processed == 2
    assert first.summary.trainable_pairs == 0
    assert first.summary.blocker_count >= 2
    assert {issue.code for issue in first.issues} >= {
        "empty_caption",
        "source_unreadable",
        "zero_trainable_pairs",
    }
    assert first.input_fingerprint == second.input_fingerprint
    assert len(first.input_fingerprint) == 64
    assert output_folder.exists() is False


def test_readiness_issues_are_bounded(tmp_path: Path) -> None:
    missing_paths = [str(tmp_path / f"missing-{index:03d}.png") for index in range(105)]
    request = _readiness_request(
        missing_paths,
        [],
        tmp_path / "bounded-output",
        {},
    )

    report = _run(request)

    assert len(report.issues) == 100
    assert report.total_issues == 106
    assert report.issues_truncated is True


def test_readiness_start_uses_shared_bulk_job_status_contract(
    test_client,
    tmp_path: Path,
) -> None:
    source = tmp_path / "api-source.png"
    Image.new("RGB", (8, 8), color=(5, 10, 15)).save(source)
    output_folder = tmp_path / "api-output"
    request = _readiness_request(
        [str(source)],
        [],
        output_folder,
        {str(source.resolve()): "subject"},
    )

    response = test_client.post(
        "/api/dataset/readiness/start",
        json=request.model_dump(mode="json"),
    )

    assert response.status_code == 202
    envelope = response.json()
    assert set(envelope) == {
        "id",
        "job_id",
        "kind",
        "status",
        "total",
        "processed",
        "message",
    }
    assert envelope["id"] == envelope["job_id"]
    assert envelope["kind"] == JOB_KIND_DATASET_READINESS
    assert envelope["status"] == "queued"
    assert envelope["total"] == 1

    status = test_client.get(f"/api/bulk-jobs/{envelope['job_id']}")
    assert status.status_code == 200
    job = status.json()
    assert job["kind"] == JOB_KIND_DATASET_READINESS
    assert job["status"] == "done"
    assert job["processed"] == 1
    assert job["result"]["summary"]["status"] == "ready"
    assert job["result"]["summary"]["trainable_pairs"] == 1
    proof = get_readiness_proof_store().get(envelope["job_id"])
    assert proof is not None
    assert proof.input_fingerprint == job["result"]["input_fingerprint"]
    assert proof.status == "ready"
    assert output_folder.exists() is False


def test_blocked_readiness_job_atomically_publishes_proof(
    test_client,
    tmp_path: Path,
) -> None:
    request = _readiness_request(
        [str(tmp_path / "missing.png")],
        [],
        tmp_path / "blocked-proof-output",
        {},
    )

    started = test_client.post(
        "/api/dataset/readiness/start",
        json=request.model_dump(mode="json"),
    )
    job_id = started.json()["job_id"]
    job = test_client.get(f"/api/bulk-jobs/{job_id}").json()
    proof = get_readiness_proof_store().get(job_id)

    assert job["status"] == "done"
    assert job["result"]["summary"]["status"] == "blocked"
    assert proof is not None
    assert proof.status == "blocked"
    assert proof.blocker_count > 0


def test_readiness_worker_error_publishes_no_proof(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    request = _readiness_request([], [], tmp_path / "error-proof-output", {})
    service = BulkJobService()
    job_id = service.create_job(JOB_KIND_DATASET_READINESS, message="Queued")

    def fail_readiness(*_args, **_kwargs):
        raise RuntimeError("injected readiness failure")

    monkeypatch.setattr(dataset_router, "run_dataset_readiness", fail_readiness)
    service.run_job(
        job_id,
        lambda handle: dataset_router._run_dataset_readiness_job(request, handle),
    )

    assert service.get_job(job_id)["status"] == "error"
    assert get_readiness_proof_store().get(job_id) is None


def test_readiness_jobs_use_shared_cancel_endpoint(test_client) -> None:
    job_id = get_bulk_job_service().create_job(
        JOB_KIND_DATASET_READINESS,
        total=3,
        message="Queued",
    )

    response = test_client.post(f"/api/bulk-jobs/{job_id}/cancel")

    assert response.status_code == 200
    assert response.json()["kind"] == JOB_KIND_DATASET_READINESS
    assert response.json()["status"] == "cancelled"


def test_readiness_start_rejects_coerced_source_types(
    test_client,
    tmp_path: Path,
) -> None:
    request = _readiness_request(
        [str(tmp_path / "source.png")],
        [],
        tmp_path / "strict-output",
        {},
    ).model_dump(mode="json")
    request["image_paths"] = [123]

    response = test_client.post("/api/dataset/readiness/start", json=request)

    assert response.status_code == 400


def test_readiness_blocks_folder_caption_stem_collision(tmp_path: Path) -> None:
    png_dir = tmp_path / "png-source"
    jpg_dir = tmp_path / "jpg-source"
    png_dir.mkdir()
    jpg_dir.mkdir()
    png_path = png_dir / "same.png"
    jpg_path = jpg_dir / "same.jpg"
    Image.new("RGB", (8, 8), color=(10, 20, 30)).save(png_path)
    Image.new("RGB", (8, 8), color=(30, 20, 10)).save(jpg_path)
    request = _readiness_request(
        [str(png_path), str(jpg_path)],
        [],
        tmp_path / "collision-output",
        {
            str(png_path.resolve()): "subject",
            str(jpg_path.resolve()): "subject",
        },
    )

    report = _run(request)

    assert report.summary.status == "blocked"
    assert report.summary.trainable_pairs == 1
    assert "caption_destination_collision" in {issue.code for issue in report.issues}


def test_readiness_blocks_unpaired_unique_sidecar_beside_image(tmp_path: Path) -> None:
    source = tmp_path / "a.png"
    Image.new("RGB", (8, 8), color=(10, 10, 10)).save(source)
    (tmp_path / "a.txt").write_text("old caption", encoding="utf-8")
    request = _readiness_request(
        [str(source)],
        [],
        tmp_path / "unused",
        {str(source.resolve()): "subject"},
    ).model_copy(update={"output_mode": "beside_image"})

    report = _run(request)

    assert report.summary.status == "blocked"
    assert report.summary.trainable_pairs == 0
    assert "unpaired_sidecar" in {issue.code for issue in report.issues}
    assert all(pair.output_caption_path != str(tmp_path / "a_1.txt") for pair in report.sample_pairs)


@pytest.mark.parametrize(
    "invalid_fields",
    [
        {"output_mode": "invalid"},
        {"image_op": "invalid"},
        {"overwrite_policy": "invalid"},
        {"content_mode": "invalid"},
        {"mask_export": "invalid"},
        {"trainer_config": "invalid"},
        {"mask_export": "onetrainer", "trainer_config": "kohya_toml"},
        {"output_mode": "beside_image", "trainer_config": "kohya_toml"},
    ],
    ids=[
        "output-mode",
        "image-op",
        "overwrite-policy",
        "content-mode",
        "mask-export",
        "trainer-config",
        "mask-trainer-combination",
        "beside-image-trainer-config",
    ],
)
def test_readiness_start_rejects_invalid_export_contract(
    test_client,
    tmp_path: Path,
    invalid_fields: dict[str, str],
) -> None:
    source = tmp_path / "valid.png"
    Image.new("RGB", (8, 8), color=(10, 20, 30)).save(source)
    request = _readiness_request(
        [str(source)],
        [],
        tmp_path / "invalid-output",
        {str(source.resolve()): "subject"},
    ).model_dump(mode="json")
    request.update(invalid_fields)

    response = test_client.post("/api/dataset/readiness/start", json=request)

    assert response.status_code == 400
    assert (tmp_path / "invalid-output").exists() is False


def test_readiness_start_rejects_existing_file_as_output_folder_without_writes(
    test_client,
    tmp_path: Path,
) -> None:
    source = tmp_path / "valid.png"
    Image.new("RGB", (8, 8), color=(10, 20, 30)).save(source)
    output_file = tmp_path / "output-target"
    output_file.write_bytes(b"keep-this-content")
    request = _readiness_request(
        [str(source)],
        [],
        output_file,
        {str(source.resolve()): "subject"},
    )

    response = test_client.post(
        "/api/dataset/readiness/start",
        json=request.model_dump(mode="json"),
    )

    assert response.status_code == 400
    assert output_file.is_file()
    assert output_file.read_bytes() == b"keep-this-content"
    assert (tmp_path / "dataset_config.toml").exists() is False
    assert (tmp_path / "export_manifest.json").exists() is False


def test_readiness_surfaces_existing_export_validator_warnings(tmp_path: Path) -> None:
    source = tmp_path / "warnings.png"
    Image.new("RGB", (8, 8), color=(20, 20, 20)).save(source)
    request = DatasetReadinessRequest(
        image_paths=[str(source)],
        output_folder=str(tmp_path / "warning-output"),
        naming_pattern="{filename}",
        trigger="hero",
        content_mode="template",
        template_options={"trigger": "hero"},
        image_overrides={str(source.resolve()): "safe, explicit,\nsecond line"},
        overwrite_policy="unique",
    )

    report = _run(request)

    warning_codes = {
        issue.code
        for issue in report.issues
        if issue.severity == "warning"
    }
    assert report.summary.status == "warnings"
    assert report.summary.blocker_count == 0
    assert warning_codes >= {
        "multiline_caption",
        "missing_trigger",
        "conflicting_ratings",
    }


def test_readiness_fingerprint_changes_with_source_content(tmp_path: Path) -> None:
    source = tmp_path / "mutable.png"
    Image.new("RGB", (8, 8), color=(1, 2, 3)).save(source)
    request = _readiness_request(
        [str(source)],
        [],
        tmp_path / "fingerprint-output",
        {str(source.resolve()): "subject"},
    )
    first = _run(request)
    Image.new("RGB", (8, 8), color=(3, 2, 1)).save(source)

    second = _run(request)

    assert first.input_fingerprint != second.input_fingerprint


def test_readiness_fingerprint_hashes_the_selected_caption_utf8(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = tmp_path / "caption-fingerprint.png"
    Image.new("RGB", (8, 8), color=(1, 2, 3)).save(source)
    request = _readiness_request(
        [str(source)],
        [],
        tmp_path / "caption-fingerprint-output",
        {str(source.resolve()): "subject"},
    )
    captions = iter(("first caption", "second caption"))
    monkeypatch.setattr(
        readiness_module,
        "_render_dataset_sidecar",
        lambda *_args, **_kwargs: next(captions),
    )

    first = _run(request)
    second = _run(request)

    assert first.input_fingerprint != second.input_fingerprint


def test_readiness_fingerprint_changes_with_scan_manifest_item(
    tmp_path: Path,
    monkeypatch,
) -> None:
    source_dir = tmp_path / "scan-source"
    source_dir.mkdir()
    first_source = source_dir / "first.png"
    second_source = source_dir / "second.png"
    Image.new("RGB", (8, 8), color=(1, 1, 1)).save(first_source)
    Image.new("RGB", (8, 8), color=(2, 2, 2)).save(second_source)
    scan_dir = tmp_path / "scan-manifests"
    scan_dir.mkdir()
    monkeypatch.setattr(dataset_session_service, "_SCAN_DIR", scan_dir)
    scan = dataset_session_service.scan_folder_for_dataset(
        str(source_dir),
        recursive=False,
        limit=1,
    )
    token = scan["scan_token"]
    request = _readiness_request(
        [],
        [{"scan_token": token, "exclude_paths": []}],
        tmp_path / "scan-output",
        {
            str(first_source.resolve()): "subject",
            str(second_source.resolve()): "subject",
        },
    )
    first = _run(request)
    manifest_path = scan_dir / f"{token}.paths.jsonl"
    manifest_path.write_text(
        json.dumps({"path": str(second_source.resolve()), "filename": second_source.name}) + "\n",
        encoding="utf-8",
    )

    second = _run(request)

    assert first.input_fingerprint != second.input_fingerprint


def test_readiness_fingerprint_changes_with_db_tags(
    test_db,
    tmp_path: Path,
) -> None:
    source = tmp_path / "db-source.png"
    Image.new("RGB", (8, 8), color=(4, 5, 6)).save(source)
    image_id = test_db.add_image(str(source), source.name)
    test_db.add_tags(image_id, [{"tag": "solo", "confidence": 0.9}])
    request = DatasetReadinessRequest(
        image_ids=[image_id],
        output_folder=str(tmp_path / "db-output"),
        naming_pattern="{filename}",
        trigger="subject",
        content_mode="tags",
        overwrite_policy="unique",
    )
    first = _run(request)
    test_db.add_tags(image_id, [{"tag": "1girl", "confidence": 0.95}])

    second = _run(request)

    assert first.input_fingerprint != second.input_fingerprint


def test_kohya_readiness_fingerprint_changes_with_stored_mask_bytes(
    test_db,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = tmp_path / "kohya-mask-source.png"
    Image.new("RGB", (8, 8), color=(10, 20, 30)).save(source)
    image_id = test_db.add_image(path=str(source), filename=source.name)
    masks_dir = tmp_path / "stored-masks"
    masks_dir.mkdir()
    monkeypatch.setattr(mask_service, "MASKS_DIR", masks_dir)
    mask_path = masks_dir / f"{image_id}.png"
    Image.new("L", (8, 8), color=10).save(mask_path)
    request = DatasetReadinessRequest(
        image_ids=[image_id],
        output_folder=str(tmp_path / "kohya-output"),
        image_overrides={str(image_id): "subject"},
        mask_export="kohya",
    )

    first = _run(request)
    Image.new("L", (8, 8), color=240).save(mask_path)
    second = _run(request)

    assert first.summary.status == second.summary.status == "ready"
    assert first.input_fingerprint != second.input_fingerprint


def test_readiness_fingerprint_changes_when_planned_destination_changes(
    tmp_path: Path,
) -> None:
    source = tmp_path / "destination-source.png"
    Image.new("RGB", (8, 8), color=(10, 20, 30)).save(source)
    output = tmp_path / "destination-output"
    request = _readiness_request(
        [str(source)],
        [],
        output,
        {str(source.resolve()): "subject"},
    )

    first = _run(request)
    output.mkdir()
    (output / "destination-source.png").write_bytes(b"occupied")
    second = _run(request)

    assert first.sample_pairs[0].output_image_path != second.sample_pairs[0].output_image_path
    assert first.input_fingerprint != second.input_fingerprint


def test_readiness_rejects_fake_png_with_readable_bytes(tmp_path: Path) -> None:
    source = tmp_path / "fake.png"
    source.write_bytes(b"\x89PNG\r\n\x1a\nnot-an-image")
    request = _readiness_request(
        [str(source)],
        [],
        tmp_path / "fake-output",
        {str(source.resolve()): "subject"},
    )

    report = _run(request)

    assert report.summary.status == "blocked"
    assert "source_unreadable" in {issue.code for issue in report.issues}


def test_readiness_duplicate_local_and_scan_matches_export_skip(
    tmp_path: Path,
    monkeypatch,
) -> None:
    source_dir = tmp_path / "duplicate-source"
    source_dir.mkdir()
    source = source_dir / "duplicate.png"
    Image.new("RGB", (8, 8), color=(9, 8, 7)).save(source)
    scan_dir = tmp_path / "duplicate-manifests"
    scan_dir.mkdir()
    monkeypatch.setattr(dataset_session_service, "_SCAN_DIR", scan_dir)
    scan = dataset_session_service.scan_folder_for_dataset(
        str(source_dir),
        recursive=False,
        limit=1,
    )
    request = _readiness_request(
        [str(source)],
        [{"scan_token": scan["scan_token"], "exclude_paths": []}],
        tmp_path / "duplicate-output",
        {str(source.resolve()): "subject"},
    )

    report = _run(request)
    exported = export_dataset(DatasetExportRequest.model_validate(request.model_dump(mode="json")))

    assert report.summary.trainable_pairs == exported.exported == 1
    assert exported.skipped == 1
    assert "duplicate_source" in {issue.code for issue in report.issues}


def test_readiness_db_missing_preserves_export_index_parity(
    tmp_path: Path,
) -> None:
    source = tmp_path / "indexed.png"
    Image.new("RGB", (8, 8), color=(6, 7, 8)).save(source)
    request = _readiness_request(
        [str(source)],
        [],
        tmp_path / "index-output",
        {str(source.resolve()): "subject"},
    ).model_copy(update={"image_ids": [999_999], "naming_pattern": "{index}"})

    report = _run(request)
    exported = export_dataset(DatasetExportRequest.model_validate(request.model_dump(mode="json")))

    assert Path(report.sample_pairs[0].output_image_path or "").name == "1.png"
    exported_item = next(item for item in exported.items if item.dst_image_path)
    assert Path(exported_item.dst_image_path or "").name == "1.png"


def test_readiness_db_row_with_missing_source_consumes_export_index_like_engine(
    test_db,
    tmp_path: Path,
) -> None:
    missing_source = tmp_path / "missing-db-source.png"
    missing_image_id = test_db.add_image(
        path=str(missing_source),
        filename=missing_source.name,
        generator="unknown",
    )
    valid_source = tmp_path / "valid-local-source.png"
    Image.new("RGB", (8, 8), color=(6, 7, 8)).save(valid_source)
    request = _readiness_request(
        [str(valid_source)],
        [],
        tmp_path / "index-output",
        {
            str(missing_image_id): "subject",
            str(valid_source.resolve()): "subject",
        },
    ).model_copy(
        update={"image_ids": [missing_image_id], "naming_pattern": "{index}"}
    )

    report = _run(request)
    exported = export_dataset(
        DatasetExportRequest.model_validate(request.model_dump(mode="json"))
    )

    assert "source_unreadable" in {issue.code for issue in report.issues}
    assert Path(report.sample_pairs[0].output_image_path or "").name == "2.png"
    exported_item = next(item for item in exported.items if item.dst_image_path)
    assert Path(exported_item.dst_image_path or "").name == "2.png"


def test_readiness_issues_have_stable_repair_contract(tmp_path: Path) -> None:
    missing = tmp_path / "missing.png"
    request = _readiness_request(
        [str(missing)],
        [],
        tmp_path / "issue-output",
        {},
    )

    first = _run(request)
    second = _run(request)

    assert [issue.issue_id for issue in first.issues] == [issue.issue_id for issue in second.issues]
    for issue in first.issues:
        assert issue.rule_version == first.rule_version
        assert issue.evidence.observed
        assert issue.evidence.expected
        assert issue.action
        assert hasattr(issue, "destination")


def test_readiness_running_job_cooperatively_cancels(
    tmp_path: Path,
    monkeypatch,
) -> None:
    first_source = tmp_path / "cancel-1.png"
    second_source = tmp_path / "cancel-2.png"
    Image.new("RGB", (8, 8), color=(1, 2, 3)).save(first_source)
    Image.new("RGB", (8, 8), color=(3, 2, 1)).save(second_source)
    request = _readiness_request(
        [str(first_source), str(second_source)],
        [],
        tmp_path / "cancel-output",
        {
            str(first_source.resolve()): "subject",
            str(second_source.resolve()): "subject",
        },
    )
    first_processed = threading.Event()
    release_worker = threading.Event()
    real_run = dataset_router.run_dataset_readiness

    def controlled_run(
        payload,
        *,
        readiness_report_id,
        progress_callback,
        cancellation_requested,
    ):
        def controlled_progress(processed: int, total: int, message: str) -> None:
            progress_callback(processed, total, message)
            if processed == 1:
                first_processed.set()
                if not release_worker.wait(timeout=5):
                    raise TimeoutError("Cancellation test did not release readiness worker")

        return real_run(
            payload,
            readiness_report_id=readiness_report_id,
            progress_callback=controlled_progress,
            cancellation_requested=cancellation_requested,
        )

    monkeypatch.setattr(dataset_router, "run_dataset_readiness", controlled_run)
    service = BulkJobService()
    job_id = service.create_job(JOB_KIND_DATASET_READINESS, total=2, message="Queued")
    worker = threading.Thread(
        target=service.run_job,
        args=(job_id, lambda handle: dataset_router._run_dataset_readiness_job(request, handle)),
    )
    worker.start()
    assert first_processed.wait(timeout=5)
    assert service.get_job(job_id)["status"] == "running"

    service.cancel_job(job_id)
    release_worker.set()
    worker.join(timeout=5)

    assert worker.is_alive() is False
    assert service.get_job(job_id)["status"] == "cancelled"
    assert get_readiness_proof_store().get(job_id) is None


def test_readiness_100k_unique_valid_scan_planning_has_measured_peak_memory(
    tmp_path: Path,
    monkeypatch,
) -> None:
    token = "a" * 32
    monkeypatch.setattr(
        readiness_module,
        "_requested_item_count",
        lambda _request: 100_000,
    )
    monkeypatch.setattr(
        readiness_module,
        "_iter_requested_scan_paths",
        lambda _request: (
            f"synthetic-source-{index:06d}.png"
            for index in range(100_000)
        ),
    )
    monkeypatch.setattr(
        readiness_module,
        "_inspect_source",
        lambda path, _cancellation_requested: (
            path,
            1,
            1,
            "0" * 64,
            8,
            8,
        ),
    )
    monkeypatch.setattr(
        readiness_module,
        "_render_dataset_sidecar",
        lambda *_args, **_kwargs: "subject",
    )
    request = _readiness_request(
        [],
        [{"scan_token": token, "exclude_paths": []}],
        tmp_path / "memory-output",
        {},
    )

    tracemalloc.start()
    report = _run(request)
    _, peak_bytes = tracemalloc.get_traced_memory()
    tracemalloc.stop()
    peak_mib = peak_bytes / (1024 * 1024)
    print(f"100k unique readiness planning peak: {peak_mib:.2f} MiB")

    assert report.summary.processed == 100_000
    assert report.summary.trainable_pairs == 100_000
    assert report.total_issues == 0
    assert len(report.issues) == 0
    assert report.sample_pairs[0].output_image_path is not None
    assert report.sample_pairs[-1].output_image_path is not None
    assert report.sample_pairs_truncated is True
    assert peak_mib < 160
