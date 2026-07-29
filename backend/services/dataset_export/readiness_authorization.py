"""Authorize Dataset Maker exports against a current Readiness proof."""

from __future__ import annotations

from typing import List, Optional

from fastapi import HTTPException

from services.bulk_job_service import (
    JOB_KIND_DATASET_READINESS,
    STATUS_CANCELLED,
    STATUS_DONE,
    STATUS_ERROR,
    get_bulk_job_service,
)
from services.dataset_export.models import (
    DatasetExportRequest,
    DatasetReadinessConflict,
    DatasetReadinessIssue,
    DatasetReadinessReport,
    DatasetReadinessRequest,
)
from services.dataset_export.readiness import (
    DATASET_READINESS_RULE_VERSION,
    dataset_readiness_fingerprint,
    run_dataset_readiness,
)
from services.dataset_export.readiness_proof_store import (
    ReadinessProof,
    ReadinessProofExpiredError,
    get_readiness_proof_store,
)


_RERUN_ACTION = (
    "Run Dataset Readiness again, then export with its report id and input fingerprint."
)


def _conflict(
    *,
    code: str,
    message: str,
    report_id: Optional[str],
    expected_input_fingerprint: Optional[str],
    observed_input_fingerprint: Optional[str],
    issues: List[DatasetReadinessIssue],
) -> HTTPException:
    detail = DatasetReadinessConflict.model_validate({
        "code": code,
        "message": message,
        "action": _RERUN_ACTION,
        "report_id": report_id,
        "expected_input_fingerprint": expected_input_fingerprint,
        "observed_input_fingerprint": observed_input_fingerprint,
        "rule_version": DATASET_READINESS_RULE_VERSION,
        "issues": issues,
    })
    return HTTPException(status_code=409, detail=detail.model_dump(mode="json"))


def _readiness_request(request: DatasetExportRequest) -> DatasetReadinessRequest:
    payload = request.model_dump(
        mode="json",
        exclude={"readiness_report_id", "readiness_input_fingerprint"},
        exclude_unset=True,
    )
    return DatasetReadinessRequest.model_validate(payload)


def _missing_proof_conflict(report_id: str) -> HTTPException:
    job = get_bulk_job_service().get_job(report_id)
    if job is None:
        code = "readiness_report_not_found"
        message = f"Dataset Readiness report was not found: report_id={report_id}"
    elif job["kind"] != JOB_KIND_DATASET_READINESS:
        code = "readiness_report_wrong_kind"
        message = (
            "The supplied report id belongs to a different job kind: "
            f"report_id={report_id}, kind={job['kind']}"
        )
    elif job["status"] == STATUS_CANCELLED:
        code = "readiness_report_cancelled"
        message = f"Dataset Readiness was cancelled: report_id={report_id}"
    elif job["status"] in {STATUS_ERROR, STATUS_DONE}:
        code = "readiness_report_unavailable"
        message = (
            "Dataset Readiness finished without an available authorization proof: "
            f"report_id={report_id}, status={job['status']}"
        )
    else:
        code = "readiness_report_not_ready"
        message = (
            "Dataset Readiness has not finished: "
            f"report_id={report_id}, status={job['status']}"
        )
    return _conflict(
        code=code,
        message=message,
        report_id=report_id,
        expected_input_fingerprint=None,
        observed_input_fingerprint=None,
        issues=[],
    )


def _get_proof(request: DatasetExportRequest) -> ReadinessProof:
    report_id = request.readiness_report_id
    supplied_fingerprint = request.readiness_input_fingerprint
    if report_id is None or supplied_fingerprint is None:
        raise _conflict(
            code="readiness_report_required",
            message="A current Dataset Readiness report is required before export.",
            report_id=report_id,
            expected_input_fingerprint=None,
            observed_input_fingerprint=supplied_fingerprint,
            issues=[],
        )
    try:
        proof = get_readiness_proof_store().get(report_id)
    except ReadinessProofExpiredError as exc:
        raise _conflict(
            code="readiness_report_expired",
            message=str(exc),
            report_id=report_id,
            expected_input_fingerprint=None,
            observed_input_fingerprint=supplied_fingerprint,
            issues=[],
        ) from exc
    if proof is None:
        raise _missing_proof_conflict(report_id)
    if supplied_fingerprint != proof.input_fingerprint:
        raise _conflict(
            code="readiness_fingerprint_mismatch",
            message=(
                "The supplied input fingerprint does not belong to this "
                f"Readiness report: report_id={report_id}"
            ),
            report_id=report_id,
            expected_input_fingerprint=proof.input_fingerprint,
            observed_input_fingerprint=supplied_fingerprint,
            issues=[],
        )
    return proof


def authorize_dataset_export(
    request: DatasetExportRequest,
) -> DatasetReadinessReport:
    """Re-run Readiness and reject stale or blocked proof before export writes."""
    proof = _get_proof(request)
    report_id = proof.report_id
    if proof.rule_version != DATASET_READINESS_RULE_VERSION:
        raise _conflict(
            code="readiness_rule_mismatch",
            message=(
                "Dataset Readiness rules changed after this report was created: "
                f"report_id={report_id}, proof_rule={proof.rule_version}, "
                f"current_rule={DATASET_READINESS_RULE_VERSION}"
            ),
            report_id=report_id,
            expected_input_fingerprint=proof.input_fingerprint,
            observed_input_fingerprint=request.readiness_input_fingerprint,
            issues=[],
        )
    readiness_request = _readiness_request(request)
    request_fingerprint = dataset_readiness_fingerprint(readiness_request)
    if request_fingerprint != proof.request_fingerprint:
        raise _conflict(
            code="readiness_request_mismatch",
            message=(
                "Export settings or selection differ from the reviewed Readiness request: "
                f"report_id={report_id}"
            ),
            report_id=report_id,
            expected_input_fingerprint=proof.input_fingerprint,
            observed_input_fingerprint=request.readiness_input_fingerprint,
            issues=[],
        )
    if proof.blocker_count > 0:
        raise _conflict(
            code="readiness_blocked",
            message=(
                "The reviewed Dataset Readiness report contains blocking issues: "
                f"report_id={report_id}, blocker_count={proof.blocker_count}"
            ),
            report_id=report_id,
            expected_input_fingerprint=proof.input_fingerprint,
            observed_input_fingerprint=proof.input_fingerprint,
            issues=list(proof.report.issues),
        )

    current = run_dataset_readiness(
        readiness_request,
        readiness_report_id=report_id,
        progress_callback=lambda _processed, _total, _message: None,
        cancellation_requested=lambda: False,
    )
    if current.summary.blocker_count > 0:
        raise _conflict(
            code="readiness_blocked",
            message=(
                "Current Dataset Readiness found blocking issues before export: "
                f"report_id={report_id}, blocker_count={current.summary.blocker_count}"
            ),
            report_id=report_id,
            expected_input_fingerprint=proof.input_fingerprint,
            observed_input_fingerprint=current.input_fingerprint,
            issues=list(current.issues),
        )
    if current.input_fingerprint != proof.input_fingerprint:
        raise _conflict(
            code="readiness_input_mismatch",
            message=(
                "Dataset inputs changed after the reviewed Readiness report: "
                f"report_id={report_id}"
            ),
            report_id=report_id,
            expected_input_fingerprint=proof.input_fingerprint,
            observed_input_fingerprint=current.input_fingerprint,
            issues=list(current.issues),
        )
    _get_proof(request)
    return current
