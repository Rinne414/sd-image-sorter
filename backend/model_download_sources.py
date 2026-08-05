"""Shared model download-source selection.

The Setup "Download Source" setting is user-facing, so every model path that
touches HuggingFace needs the same interpretation:

- auto: official HuggingFace first, then hf-mirror fallback
- hf-mirror: hf-mirror first, then official fallback
- modelscope: use ModelScope in model-specific code when a real ModelScope
  repo exists; HuggingFace-only models fall back to hf-mirror first

Some third-party libraries read ``HF_ENDPOINT`` at import/call time instead of
accepting an endpoint argument. ``apply_hf_endpoint`` updates both the process
environment and an already-imported huggingface_hub constants module.
"""
from __future__ import annotations

import logging
import os
import re
from pathlib import Path
from typing import List, Optional, Sequence, TypedDict

logger = logging.getLogger(__name__)


class ModelArtifactStatus(TypedDict):
    """Structured status for one downloaded model artifact."""

    artifact_file: str
    status: str
    size_bytes: int


def is_nonempty_model_file(path: Path) -> bool:
    """Return whether ``path`` is a regular, non-empty file."""
    try:
        return path.is_file() and path.stat().st_size > 0
    except OSError:
        return False


def missing_model_artifacts(
    model_dir: Path,
    required_files: Sequence[str],
) -> tuple[str, ...]:
    """Return required artifact names that are absent or zero bytes."""
    return tuple(
        filename
        for filename in required_files
        if not is_nonempty_model_file(model_dir / filename)
    )


def log_model_artifact_status(
    model_logger: logging.Logger,
    *,
    model_id: str,
    revision: Optional[str],
    endpoint: str,
    model_dir: Path,
    required_files: Sequence[str],
) -> tuple[str, ...]:
    """Log one structured readiness record for every required artifact."""
    statuses: list[ModelArtifactStatus] = []
    for artifact_file in required_files:
        path = model_dir / artifact_file
        size_bytes = 0
        try:
            if path.is_file():
                size_bytes = path.stat().st_size
        except OSError:
            size_bytes = 0
        status = "file_ready" if size_bytes > 0 and path.is_file() else "file_missing"
        statuses.append(
            {
                "artifact_file": artifact_file,
                "status": status,
                "size_bytes": size_bytes,
            }
        )
        log_method = model_logger.info if status == "file_ready" else model_logger.warning
        log_method(
            "Model artifact validation",
            extra={
                "model_id": model_id,
                "revision": revision,
                "endpoint": endpoint_label(endpoint),
                **statuses[-1],
            },
        )
    return tuple(
        item["artifact_file"]
        for item in statuses
        if item["status"] == "file_missing"
    )

HF_OFFICIAL_ENDPOINT = "https://huggingface.co"
HF_MIRROR_ENDPOINT = "https://hf-mirror.com"

_INITIAL_HF_ENDPOINT = str(os.environ.get("HF_ENDPOINT", "") or "").strip().rstrip("/")
_APP_SET_ENDPOINT: Optional[str] = None


def _dedupe_endpoints(endpoints: list[str]) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for endpoint in endpoints:
        normalized = str(endpoint or "").strip().rstrip("/")
        if not normalized:
            continue
        key = normalized.lower()
        if key in seen:
            continue
        seen.add(key)
        result.append(normalized)
    return result


def _get_persisted_download_mirror() -> str:
    try:
        from config import get_download_mirror

        return get_download_mirror()
    except Exception as exc:  # noqa: BLE001 - downloader fallback must not crash import-time paths
        logger.warning("Could not read download mirror setting; using auto: %s", exc)
        return "auto"


def get_hf_endpoint_order(*, mirror: Optional[str] = None, model_name: str = "") -> List[str]:
    """Return HuggingFace-compatible endpoints in the order they should be tried.

    The returned values are full endpoint URLs, including the official endpoint.
    Passing them to huggingface_hub's ``endpoint=`` parameter is valid.
    """
    selected = str(mirror or _get_persisted_download_mirror() or "auto").strip().lower()
    if selected not in {"auto", "hf-mirror", "modelscope"}:
        selected = "auto"

    env_endpoint = _INITIAL_HF_ENDPOINT

    if selected == "hf-mirror":
        return _dedupe_endpoints([HF_MIRROR_ENDPOINT, env_endpoint, HF_OFFICIAL_ENDPOINT])

    if selected == "modelscope":
        if model_name:
            logger.info(
                "Download Source is ModelScope, but %s is HuggingFace-hosted; "
                "using hf-mirror fallback for this model.",
                model_name,
            )
        return _dedupe_endpoints([HF_MIRROR_ENDPOINT, env_endpoint, HF_OFFICIAL_ENDPOINT])

    return _dedupe_endpoints([env_endpoint, HF_OFFICIAL_ENDPOINT, HF_MIRROR_ENDPOINT])


def apply_hf_endpoint(endpoint: str, *, purpose: str = "") -> str:
    """Make a HuggingFace endpoint visible to libraries that read globals/env.

    Returns the normalized endpoint that was applied.
    """
    global _APP_SET_ENDPOINT

    normalized = str(endpoint or HF_OFFICIAL_ENDPOINT).strip().rstrip("/") or HF_OFFICIAL_ENDPOINT
    os.environ["HF_ENDPOINT"] = normalized
    _APP_SET_ENDPOINT = normalized

    try:
        import huggingface_hub.constants as constants  # type: ignore

        constants.ENDPOINT = normalized
        constants.HUGGINGFACE_CO_URL_TEMPLATE = (
            normalized + "/{repo_id}/resolve/{revision}/{filename}"
        )
    except Exception as exc:  # noqa: BLE001 - best-effort compatibility patch
        logger.debug("Could not patch huggingface_hub endpoint for %s: %s", purpose or normalized, exc)

    if purpose:
        logger.info("Using HuggingFace endpoint %s for %s", normalized, purpose)
    return normalized


def apply_hf_endpoint_monkeypatch(endpoint: str, *, purpose: str = "") -> str:
    """Patch common huggingface_hub entry points for libraries without endpoint args.

    FastEmbed 0.8 calls top-level ``model_info`` and ``list_repo_tree`` without
    passing an endpoint, so merely setting ``HF_ENDPOINT`` after import is not
    enough. This wrapper keeps the patch process-local and idempotent.
    """
    normalized = apply_hf_endpoint(endpoint, purpose=purpose)
    try:
        import huggingface_hub  # type: ignore
        import huggingface_hub.hf_api as hf_api  # type: ignore

        if not getattr(huggingface_hub, "_sd_image_sorter_endpoint_patch", False):
            def model_info_with_endpoint(*args, **kwargs):
                kwargs.pop("endpoint", None)
                return hf_api.HfApi(endpoint=os.environ.get("HF_ENDPOINT") or HF_OFFICIAL_ENDPOINT).model_info(
                    *args,
                    **kwargs,
                )

            def list_repo_tree_with_endpoint(*args, **kwargs):
                kwargs.pop("endpoint", None)
                return hf_api.HfApi(endpoint=os.environ.get("HF_ENDPOINT") or HF_OFFICIAL_ENDPOINT).list_repo_tree(
                    *args,
                    **kwargs,
                )

            huggingface_hub.model_info = model_info_with_endpoint
            huggingface_hub.list_repo_tree = list_repo_tree_with_endpoint
            huggingface_hub._sd_image_sorter_endpoint_patch = True

        try:
            import fastembed.common.model_management as fastembed_model_management  # type: ignore

            fastembed_model_management.model_info = huggingface_hub.model_info
            fastembed_model_management.list_repo_tree = huggingface_hub.list_repo_tree
        except Exception as exc:  # noqa: BLE001
            logger.debug("FastEmbed endpoint patch skipped for %s: %s", purpose or normalized, exc)
    except Exception as exc:  # noqa: BLE001
        logger.debug("Could not monkeypatch huggingface_hub endpoint for %s: %s", purpose or normalized, exc)
    return normalized


def endpoint_label(endpoint: str) -> str:
    normalized = str(endpoint or "").strip().rstrip("/")
    if normalized == HF_OFFICIAL_ENDPOINT:
        return "huggingface.co"
    if normalized == HF_MIRROR_ENDPOINT:
        return "hf-mirror.com"
    return normalized or "huggingface.co"


def hf_error_metadata(error: BaseException) -> dict[str, object]:
    """Return redacted, structured metadata for a Hugging Face failure."""
    response = getattr(error, "response", None)
    status_code = getattr(response, "status_code", None)
    if status_code is None:
        status_code = getattr(error, "status_code", None)
    try:
        normalized_status: int | None = int(status_code) if status_code is not None else None
    except (TypeError, ValueError):
        normalized_status = None

    error_type = type(error).__name__
    raw_detail = str(error)
    redacted_detail = re.sub(
        r"(?i)(authorization\s*:\s*bearer\s+)[^\s,;]+",
        r"\1<redacted>",
        raw_detail,
    )
    redacted_detail = re.sub(
        r"(?i)((?:access[_-]?token|token)\s*[=:]\s*)[^\s,;]+",
        r"\1<redacted>",
        redacted_detail,
    )
    lowered = f"{error_type} {raw_detail}".lower()
    gated = normalized_status in {401, 403} or any(
        marker in lowered
        for marker in ("gated", "access denied", "unauthorized", "authorization", "accept the terms")
    )
    not_found = normalized_status == 404 or "not found" in lowered or "repositorynotfound" in lowered
    return {
        "error_type": error_type,
        "status_code": normalized_status,
        "gated": gated,
        "not_found": not_found,
        "error": redacted_detail,
    }


def format_hf_download_error(
    *,
    model_id: str,
    revision: str,
    endpoint: str,
    error: BaseException,
) -> str:
    """Build an actionable, token-free error for a pinned Hub download."""
    metadata = hf_error_metadata(error)
    status = metadata["status_code"]
    status_text = f" HTTP {status}" if isinstance(status, int) else ""
    if metadata["gated"]:
        action = (
            "This checkpoint is gated: accept its terms on the official Hugging Face page "
            "and configure a Hugging Face token, then retry Prepare / Download."
        )
    elif metadata["not_found"]:
        action = (
            "The pinned repository or revision was not found. Verify network access and the "
            "pinned revision before retrying."
        )
    else:
        action = "Check network access and retry Prepare / Download."
    return (
        f"Hugging Face download failed{status_text} for repo {model_id!r} at revision "
        f"{revision!r} via {endpoint_label(endpoint)} ({metadata['error_type']}): "
        f"{metadata['error']}. {action}"
    )
