"""Strict provenance contract for one tag-writer family."""

from __future__ import annotations

import hashlib
import hmac
import re
from pathlib import Path
from typing import Annotated, Literal, Mapping, Self, Sequence

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, model_validator


ModelFileIdentity = tuple[int, int, int, int]
_LOCAL_MODEL_PATTERN = re.compile(r"local:[0-9a-f]{64}")
_ONNX_PROVIDER_PATTERN = re.compile(r"[A-Za-z][A-Za-z0-9_]*ExecutionProvider")
_HF_REPOSITORY_SEGMENT_PATTERN = re.compile(
    r"[A-Za-z0-9_](?:[A-Za-z0-9._-]*[A-Za-z0-9_])?"
)


def _trimmed_identity(value: str) -> str:
    if value != value.strip():
        raise ValueError("provenance identity must not have leading or trailing whitespace")
    return value


def _sha256_revision(value: str) -> str:
    if re.fullmatch(r"sha256:[0-9a-f]{64}", value) is None:
        raise ValueError("model revision must be a lowercase SHA-256 identity")
    return value


def require_image_content_fingerprint(value: str | None) -> str:
    """Return a verified pixel fingerprint or reject unverifiable lineage."""

    if value is None or re.fullmatch(r"[0-9a-f]{64}", value) is None:
        raise ValueError("writer provenance requires a lowercase SHA-256 image content fingerprint")
    return value


def model_file_identity(model_path: str | Path) -> ModelFileIdentity:
    source_stat = Path(model_path).stat()
    return (
        int(source_stat.st_dev),
        int(source_stat.st_ino),
        int(source_stat.st_size),
        int(source_stat.st_mtime_ns),
    )


def model_file_snapshot(model_path: str | Path) -> tuple[ModelFileIdentity, str]:
    path = Path(model_path)
    identity_before = model_file_identity(path)
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    identity_after = model_file_identity(path)
    if identity_before != identity_after:
        raise RuntimeError("Model file changed while its SHA-256 was computed")
    return identity_after, digest.hexdigest()


def _is_huggingface_repository_identity(value: str) -> bool:
    if len(value) > 96 or value.count("/") != 1 or "--" in value or ".." in value:
        return False
    namespace, repository = value.split("/", 1)
    return bool(
        _HF_REPOSITORY_SEGMENT_PATTERN.fullmatch(namespace)
        and _HF_REPOSITORY_SEGMENT_PATTERN.fullmatch(repository)
    )


def _is_onnx_provider_chain(value: str) -> bool:
    providers = value.split(",")
    return bool(
        providers
        and len(providers) == len(set(providers))
        and all(_ONNX_PROVIDER_PATTERN.fullmatch(provider) for provider in providers)
    )


ProvenanceIdentity = Annotated[
    str,
    Field(min_length=1, max_length=512),
    AfterValidator(_trimmed_identity),
]
ModelRevision = Annotated[
    str,
    Field(min_length=71, max_length=71),
    AfterValidator(_sha256_revision),
]
ImageContentFingerprint = Annotated[
    str,
    Field(min_length=64, max_length=64),
    AfterValidator(require_image_content_fingerprint),
]


def _runtime_provider_identity(runtime_providers: Sequence[str]) -> str:
    runtime_provider = ",".join(
        str(value).strip() for value in runtime_providers if str(value).strip()
    )
    if not runtime_provider:
        raise ValueError("WD14 writer provenance requires the ONNX runtime provider chain")
    return runtime_provider


class TagWriterProvenance(BaseModel):
    """Identity written only by the built-in WD14 tagger path."""

    model_config = ConfigDict(extra="forbid", strict=True, frozen=True)

    writer_family: Literal["wd14"]
    provider: Literal["huggingface", "local_onnx"]
    model: ProvenanceIdentity
    revision: ModelRevision
    runtime_provider: ProvenanceIdentity

    @model_validator(mode="after")
    def validate_provider_identity(self) -> Self:
        if self.provider == "local_onnx":
            if _LOCAL_MODEL_PATTERN.fullmatch(self.model) is None:
                raise ValueError(
                    "local ONNX writer provenance requires model=local:<lowercase SHA-256>"
                )
        elif not _is_huggingface_repository_identity(self.model):
            raise ValueError(
                "Hugging Face writer provenance requires a valid namespace/repository identity"
            )
        if not _is_onnx_provider_chain(self.runtime_provider):
            raise ValueError(
                "WD14 writer provenance requires a comma-separated ONNX provider chain"
            )
        return self


def replace_wd14_runtime_providers(
    provenance: TagWriterProvenance,
    runtime_providers: Sequence[str],
) -> TagWriterProvenance:
    """Return the same immutable model identity with the active provider chain."""

    return TagWriterProvenance(
        writer_family=provenance.writer_family,
        provider=provenance.provider,
        model=provenance.model,
        revision=provenance.revision,
        runtime_provider=_runtime_provider_identity(runtime_providers),
    )


def require_unchanged_wd14_loaded_model(
    provenance: TagWriterProvenance,
    resolved_model_path: str | None,
    loaded_model_file_identity: ModelFileIdentity | None,
    loaded_model_file_sha256: str | None,
) -> None:
    """Reject a batch when inference used a different loaded model revision."""

    if not resolved_model_path:
        raise ValueError("WD14 writer provenance requires a resolved model file")
    if loaded_model_file_identity is None:
        raise ValueError(
            "WD14 writer provenance requires the model identity loaded by ONNX Runtime"
        )
    if (
        loaded_model_file_sha256 is None
        or re.fullmatch(r"[0-9a-f]{64}", loaded_model_file_sha256) is None
    ):
        raise ValueError(
            "WD14 writer provenance requires the model SHA-256 loaded by ONNX Runtime"
        )
    current_identity = model_file_identity(resolved_model_path)
    if current_identity != loaded_model_file_identity:
        raise RuntimeError(
            "WD14 model file changed after the active ONNX session loaded; "
            "tags were not published"
        )
    loaded_revision = f"sha256:{loaded_model_file_sha256}"
    if not hmac.compare_digest(provenance.revision, loaded_revision):
        raise RuntimeError(
            "WD14 loaded model revision changed during tagging; tags were not published"
        )


def build_wd14_writer_provenance(
    effective_model_name: str,
    requested_model_path: str | None,
    model_config: Mapping[str, object],
    resolved_model_path: str | None,
    runtime_providers: Sequence[str],
    loaded_model_file_identity: ModelFileIdentity | None,
    loaded_model_file_sha256: str | None,
) -> TagWriterProvenance | None:
    """Build provenance only when the worker knows the loaded model identity."""

    writer_family = str(model_config.get("writer_family", "")).strip().lower()
    if writer_family != "wd14":
        return None
    if not resolved_model_path:
        raise ValueError("WD14 writer provenance requires a resolved model file")
    if not runtime_providers:
        raise ValueError("WD14 writer provenance requires the ONNX runtime provider chain")
    model_path = Path(resolved_model_path)
    if not model_path.is_file():
        raise FileNotFoundError(
            f"WD14 writer provenance model file does not exist: {model_path}"
        )
    if loaded_model_file_identity is None:
        raise ValueError(
            "WD14 writer provenance requires the model identity loaded by ONNX Runtime"
        )
    if (
        loaded_model_file_sha256 is None
        or re.fullmatch(r"[0-9a-f]{64}", loaded_model_file_sha256) is None
    ):
        raise ValueError(
            "WD14 writer provenance requires the model SHA-256 loaded by ONNX Runtime"
        )
    current_identity, current_sha256 = model_file_snapshot(model_path)
    if (
        current_identity != loaded_model_file_identity
        or not hmac.compare_digest(current_sha256, loaded_model_file_sha256)
    ):
        raise RuntimeError(
            "WD14 model file changed after the ONNX session loaded; tags were not published"
        )
    revision = f"sha256:{loaded_model_file_sha256}"
    runtime_provider = _runtime_provider_identity(runtime_providers)
    model_name = str(effective_model_name).strip()
    if not model_name:
        raise ValueError("WD14 writer provenance requires an effective model name")
    repo_id = model_config.get("repo_id")
    if requested_model_path:
        model = f"local:{loaded_model_file_sha256}"
        provider = "local_onnx"
    elif isinstance(repo_id, str) and repo_id.strip():
        model = repo_id.strip()
        provider = "huggingface"
    else:
        raise ValueError("WD14 writer provenance requires a Hugging Face repository identity")
    return TagWriterProvenance(
        writer_family="wd14",
        provider=provider,
        model=model,
        revision=revision,
        runtime_provider=runtime_provider,
    )
