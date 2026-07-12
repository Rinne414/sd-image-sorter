"""Tag-request validation: custom-ONNX profiles, model names, hardware floors.

Moved verbatim from services/tagging_service.py (decomposition 2026-07).
"""

import os

from fastapi import HTTPException

from config import DEFAULT_TAGGER_MODEL, TAGGER_MODELS
from services.tagging.catalog import (
    CUSTOM_ONNX_PROFILE_NAMES,
    CUSTOM_PROFILE_ALIASES,
    CUSTOM_PROFILE_MODEL_NAMES,
)
from services.tagging.request import TagRequest
from utils.path_validation import normalize_user_path, validate_file_path


class ValidationMixin:
    """Request-validation slice of TaggingService (assembled in services.tagging.service)."""

    def _resolve_custom_profile(self, request: TagRequest) -> str:
        """Resolve the custom ONNX profile selected by the user."""
        raw_profile = (
            (request.custom_profile or request.model_name or "wd14").strip().lower()
        )
        return CUSTOM_PROFILE_ALIASES.get(raw_profile, raw_profile or "wd14")

    def _resolve_model_name(self, request: TagRequest) -> str:
        """Resolve the effective built-in model/profile name for a request."""
        if request.model_path:
            profile = self._resolve_custom_profile(request)
            return CUSTOM_PROFILE_MODEL_NAMES.get(profile, profile)
        return (request.model_name or DEFAULT_TAGGER_MODEL).strip()

    def _validate_tag_request(self, request: TagRequest) -> None:
        """Reject unsafe or invalid tagger combinations before background work starts."""
        if request.model_path:
            custom_profile = self._resolve_custom_profile(request)
            if custom_profile not in CUSTOM_ONNX_PROFILE_NAMES:
                if custom_profile == "toriigate-0.5":
                    raise HTTPException(
                        status_code=400,
                        detail=(
                            "ToriiGate is not an ONNX tagger. Use the built-in ToriiGate entry for auto-download, "
                            "or add a dedicated local ToriiGate directory profile instead of the Custom ONNX path."
                        ),
                    )
                raise HTTPException(
                    status_code=400,
                    detail=f"Unsupported custom tagger profile: {custom_profile}",
                )
            normalized_model_path = normalize_user_path(request.model_path)
            model_ext = os.path.splitext(normalized_model_path)[1].lower()
            if model_ext != ".onnx":
                raise HTTPException(
                    status_code=400,
                    detail="Custom ONNX tagger model must be an .onnx file.",
                )
            is_valid_model_path, model_path_error = validate_file_path(
                normalized_model_path,
                allowed_extensions={".onnx"},
            )
            if not is_valid_model_path:
                raise HTTPException(
                    status_code=400,
                    detail=f"Custom ONNX tagger model path is invalid: {model_path_error}.",
                )
            request.model_path = normalized_model_path

        if request.tags_path and not request.model_path:
            raise HTTPException(
                status_code=400,
                detail="Custom tags/metadata path requires a Custom ONNX model_path.",
            )

        if request.tags_path:
            normalized_tags_path = normalize_user_path(request.tags_path)
            tags_ext = os.path.splitext(normalized_tags_path)[1].lower()
            custom_profile = self._resolve_custom_profile(request)
            allowed_tags_exts = (
                {".json"} if custom_profile == "camie-tagger-v2" else {".csv"}
            )
            if tags_ext not in allowed_tags_exts:
                allowed_text = " or ".join(sorted(allowed_tags_exts))
                raise HTTPException(
                    status_code=400,
                    detail=f"Custom tags/metadata file for {custom_profile} must be {allowed_text}.",
                )
            if request.model_path:
                is_valid_tags_path, tags_path_error = validate_file_path(
                    normalized_tags_path,
                    allowed_extensions=allowed_tags_exts,
                )
                if not is_valid_tags_path:
                    raise HTTPException(
                        status_code=400,
                        detail=f"Custom tags/metadata path for {custom_profile} is invalid: {tags_path_error}.",
                    )
                request.tags_path = normalized_tags_path

        model_name = self._resolve_model_name(request)
        if model_name not in TAGGER_MODELS:
            raise HTTPException(
                status_code=400,
                detail=f"Unknown tagger model: {model_name}",
            )

        model_config = TAGGER_MODELS.get(model_name, {})
        if model_config.get("disabled"):
            raise HTTPException(
                status_code=409,
                detail=model_config.get("disabled_reason")
                or f"Model {model_name} is not available in the current build.",
            )
        if model_config.get("captioner_only"):
            # Owner decision (2026-07-06): ToriiGate is a captioner, not a
            # tagger. Measured as a gallery tagger it emitted 5-7 tags/image
            # with non-danbooru words and invented anatomy. Caption with it
            # via Smart Tag's natural-language stage instead.
            raise HTTPException(
                status_code=400,
                detail=(
                    f"{model_name} is a captioner, not a tagger. "
                    "Use Smart Tag (natural-language mode) for captions."
                ),
            )
        if not request.model_path:
            self._validate_model_hardware_requirements(model_name, request.use_gpu)

    def _validate_model_hardware_requirements(
        self, model_name: str, use_gpu: bool
    ) -> None:
        """Reject models that should not run on the detected hardware."""
        model_config = TAGGER_MODELS.get(model_name, {})
        runtime_backend = str(model_config.get("runtime_backend", "wd14")).lower()
        if runtime_backend != "toriigate":
            return

        from hardware_monitor import get_system_info

        system_info = get_system_info()
        total_ram_gb = float(system_info.get("total_ram_gb") or 0)
        available_ram_gb = float(system_info.get("available_ram_gb") or 0)
        gpu_vram_total_mb = float(system_info.get("gpu_vram_total_mb") or 0)
        gpu_vram_available_mb = float(system_info.get("gpu_vram_available_mb") or 0)
        torch_cuda_available = bool(system_info.get("torch_cuda_available"))

        if use_gpu:
            min_total_ram_gb = float(model_config.get("minimum_total_ram_gb") or 0)
            min_available_ram_gb = float(
                model_config.get("minimum_available_ram_gb") or 0
            )
            min_gpu_vram_mb = float(model_config.get("minimum_gpu_vram_mb") or 0)
            min_gpu_available_vram_mb = float(
                model_config.get("minimum_gpu_available_vram_mb") or 0
            )

            failures = []
            if not torch_cuda_available:
                failures.append("PyTorch CUDA runtime is unavailable")
            if min_total_ram_gb and total_ram_gb and total_ram_gb < min_total_ram_gb:
                failures.append(
                    f"system RAM {total_ram_gb:.0f} GB < required {min_total_ram_gb:.0f} GB"
                )
            if (
                min_available_ram_gb
                and available_ram_gb
                and available_ram_gb < min_available_ram_gb
            ):
                failures.append(
                    f"free RAM {available_ram_gb:.1f} GB < required {min_available_ram_gb:.0f} GB"
                )
            if (
                min_gpu_vram_mb
                and gpu_vram_total_mb
                and gpu_vram_total_mb < min_gpu_vram_mb
            ):
                failures.append(
                    f"GPU VRAM {gpu_vram_total_mb / 1024:.1f} GB < required {min_gpu_vram_mb / 1024:.0f} GB"
                )
            if (
                min_gpu_available_vram_mb
                and gpu_vram_available_mb
                and gpu_vram_available_mb < min_gpu_available_vram_mb
            ):
                failures.append(
                    f"free VRAM {gpu_vram_available_mb / 1024:.1f} GB < required {min_gpu_available_vram_mb / 1024:.0f} GB"
                )

            if failures:
                detected = []
                if total_ram_gb:
                    detected.append(f"{total_ram_gb:.0f} GB RAM")
                if available_ram_gb:
                    detected.append(f"{available_ram_gb:.1f} GB free RAM")
                if gpu_vram_total_mb:
                    detected.append(f"{gpu_vram_total_mb / 1024:.1f} GB VRAM")
                if gpu_vram_available_mb:
                    detected.append(f"{gpu_vram_available_mb / 1024:.1f} GB free VRAM")
                raise HTTPException(
                    status_code=409,
                    detail=(
                        "ToriiGate GPU mode is blocked on this hardware. "
                        f"Minimum: {min_total_ram_gb:.0f} GB RAM and {min_gpu_vram_mb / 1024:.0f} GB VRAM. "
                        f"Detected: {', '.join(detected) if detected else 'unknown hardware'}. "
                        f"Reason: {'; '.join(failures)}."
                    ),
                )
        else:
            min_cpu_total_ram_gb = float(
                model_config.get("minimum_cpu_total_ram_gb") or 0
            )
            min_cpu_available_ram_gb = float(
                model_config.get("minimum_cpu_available_ram_gb") or 0
            )
            failures = []
            if (
                min_cpu_total_ram_gb
                and total_ram_gb
                and total_ram_gb < min_cpu_total_ram_gb
            ):
                failures.append(
                    f"system RAM {total_ram_gb:.0f} GB < required {min_cpu_total_ram_gb:.0f} GB"
                )
            if (
                min_cpu_available_ram_gb
                and available_ram_gb
                and available_ram_gb < min_cpu_available_ram_gb
            ):
                failures.append(
                    f"free RAM {available_ram_gb:.1f} GB < required {min_cpu_available_ram_gb:.0f} GB"
                )
            if failures:
                detected = []
                if total_ram_gb:
                    detected.append(f"{total_ram_gb:.0f} GB RAM")
                if available_ram_gb:
                    detected.append(f"{available_ram_gb:.1f} GB free RAM")
                raise HTTPException(
                    status_code=409,
                    detail=(
                        "ToriiGate CPU mode is blocked on this hardware. "
                        f"Minimum: {min_cpu_total_ram_gb:.0f} GB RAM. "
                        f"Detected: {', '.join(detected) if detected else 'unknown hardware'}. "
                        f"Reason: {'; '.join(failures)}."
                    ),
                )
