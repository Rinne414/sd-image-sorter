"""Bounded in-memory authorization proofs for Dataset Readiness reports."""

from __future__ import annotations

import re
import threading
import time
from dataclasses import dataclass
from typing import Callable, Dict, Literal, Optional

from services.dataset_export.models import DatasetReadinessReport
from services.service_provider import ServiceProvider


READINESS_PROOF_TTL_SECONDS = 15 * 60
READINESS_PROOF_CAPACITY = 50
_REPORT_ID_PATTERN = re.compile(r"^[a-f0-9]{32}$")


class ReadinessProofExpiredError(LookupError):
    """Raised when a requested proof existed but exceeded its lifetime."""


@dataclass(frozen=True)
class ReadinessProof:
    report_id: str
    request_fingerprint: str
    input_fingerprint: str
    rule_version: str
    status: Literal["ready", "warnings", "blocked"]
    blocker_count: int
    warning_count: int
    report: DatasetReadinessReport
    created_at: float
    expires_at: float


class ReadinessProofStore:
    """Thread-safe, process-local proof registry with deterministic eviction."""

    def __init__(
        self,
        *,
        ttl_seconds: float,
        capacity: int,
        clock: Callable[[], float],
    ) -> None:
        if ttl_seconds <= 0:
            raise ValueError("Readiness proof TTL must be greater than zero")
        if capacity <= 0:
            raise ValueError("Readiness proof capacity must be greater than zero")
        self._ttl_seconds = float(ttl_seconds)
        self._capacity = int(capacity)
        self._clock = clock
        self._proofs: Dict[str, ReadinessProof] = {}
        self._lock = threading.Lock()

    def prepare(
        self,
        report: DatasetReadinessReport,
        request_fingerprint: str,
    ) -> ReadinessProof:
        """Build an immutable proof before the bulk-job commit lock is entered."""
        if _REPORT_ID_PATTERN.fullmatch(report.report_id) is None:
            raise ValueError(
                "Readiness proof report_id must be exactly 32 lowercase hex characters"
            )
        if re.fullmatch(r"[a-f0-9]{64}", request_fingerprint) is None:
            raise ValueError(
                "Readiness proof request_fingerprint must be exactly 64 lowercase hex characters"
            )
        created_at = float(self._clock())
        copied_report = report.model_copy(deep=True)
        return ReadinessProof(
            report_id=copied_report.report_id,
            request_fingerprint=request_fingerprint,
            input_fingerprint=copied_report.input_fingerprint,
            rule_version=copied_report.rule_version,
            status=copied_report.summary.status,
            blocker_count=copied_report.summary.blocker_count,
            warning_count=copied_report.summary.warning_count,
            report=copied_report,
            created_at=created_at,
            expires_at=created_at + self._ttl_seconds,
        )

    def publish(self, proof: ReadinessProof) -> None:
        """Publish one prepared proof without performing source or database I/O."""
        with self._lock:
            self._prune_expired_unlocked(float(self._clock()))
            self._proofs[proof.report_id] = proof
            excess = len(self._proofs) - self._capacity
            if excess <= 0:
                return
            ordered = sorted(
                self._proofs.values(),
                key=lambda item: (item.created_at, item.report_id),
            )
            for item in ordered[:excess]:
                self._proofs.pop(item.report_id, None)

    def get(self, report_id: str) -> Optional[ReadinessProof]:
        with self._lock:
            proof = self._proofs.get(report_id)
            if proof is None:
                return None
            if proof.expires_at <= float(self._clock()):
                self._proofs.pop(report_id, None)
                raise ReadinessProofExpiredError(
                    f"Dataset Readiness proof expired: report_id={report_id}"
                )
            return proof

    def _prune_expired_unlocked(self, now: float) -> None:
        expired_ids = [
            report_id
            for report_id, proof in self._proofs.items()
            if proof.expires_at <= now
        ]
        for report_id in expired_ids:
            self._proofs.pop(report_id, None)


def _new_readiness_proof_store() -> ReadinessProofStore:
    return ReadinessProofStore(
        ttl_seconds=READINESS_PROOF_TTL_SECONDS,
        capacity=READINESS_PROOF_CAPACITY,
        clock=time.time,
    )


_readiness_proof_provider = ServiceProvider(_new_readiness_proof_store)


def get_readiness_proof_store() -> ReadinessProofStore:
    return _readiness_proof_provider.get()


def set_readiness_proof_store(service: Optional[ReadinessProofStore]) -> None:
    _readiness_proof_provider.set(service)
