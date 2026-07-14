"""Smart Tag request contract: SmartTagRequest + payload coercion/validation.

Owns SmartTagRequest, _coerce_request and its coercion helpers
(_tagger_defaults / _coerce_threshold / _coerce_max_tags /
_coerce_toriigate_max_tokens), the dataset-scan-token helpers, the
local-OpenAI-compatible endpoint gate used by request validation, and
_request_total (request-size accounting for job progress).

Split verbatim out of services/smart_tag_service.py.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

from config import ALLOWED_IMAGE_EXTENSIONS, DEFAULT_TAGGER_MODEL, TAGGER_MODELS
from services.tag_export_service import count_selection_token_ids
from services.tag_training_filters import normalize_training_purpose
from utils.path_validation import normalize_user_path


# Hosts that resolve to the user's own machine. Local OpenAI-compatible
# servers (Ollama, vLLM, LM Studio, llama.cpp) accept requests without
# an API key, so the smart-tag start gate must let an empty key through
# in that case. Cloud gateways (api.openai.com, openrouter.ai, aihubmix
# proxies, etc.) still require a key.
_LOCAL_OPENAI_COMPAT_HOSTS: frozenset = frozenset({
    "localhost",
    "127.0.0.1",
    "0.0.0.0",
    "::1",
    "[::1]",
    "host.docker.internal",
})

_LOCAL_OPENAI_COMPAT_HOST_SUFFIXES: Tuple[str, ...] = (
    ".local",
    ".lan",
    ".internal",
    ".home",
    ".home.arpa",
)


def _is_local_openai_compat_endpoint(provider_name: str, endpoint: str) -> bool:
    """Return True if ``endpoint`` is a local OpenAI-compatible server.

    Local servers (Ollama / vLLM / LM Studio / llama.cpp) ship without auth
    by default. The smart-tag start gate uses this to decide whether an
    empty ``api_key`` is acceptable. Anthropic and Gemini are always cloud,
    so we never relax the key check for those providers regardless of the
    endpoint string.
    """
    if (provider_name or "").lower() not in {"", "openai_compat"}:
        return False
    cleaned = (endpoint or "").strip()
    if not cleaned:
        return False
    try:
        from urllib.parse import urlparse

        parsed = urlparse(cleaned)
    except Exception:  # noqa: BLE001
        return False
    host = (parsed.hostname or "").strip().lower()
    if not host:
        return False
    if host in _LOCAL_OPENAI_COMPAT_HOSTS:
        return True
    for suffix in _LOCAL_OPENAI_COMPAT_HOST_SUFFIXES:
        if host.endswith(suffix):
            return True
    # Private RFC1918 ranges (192.168.x.x, 10.x.x.x, 172.16-31.x.x) are
    # also LAN-local; treat them the same as loopback.
    parts = host.split(".")
    if len(parts) == 4 and all(part.isdigit() for part in parts):
        try:
            octets = [int(part) for part in parts]
        except ValueError:
            return False
        if octets[0] == 10:
            return True
        if octets[0] == 192 and octets[1] == 168:
            return True
        if octets[0] == 172 and 16 <= octets[1] <= 31:
            return True
    return False


class SmartTagCaptionProfile(str, Enum):
    """Supported model-specific caption contracts."""

    KREA2_LONG_NL = "krea2_long_nl"


@dataclass
class SmartTagRequest:
    """Input contract for ``start_smart_tag_job``.

    image_ids OR image_paths is required. Gallery IDs write back to the DB;
    path-source items return captions through the job results endpoint so the
    Dataset Maker can store them in local caption overrides.
    """
    image_ids: List[int] = field(default_factory=list)
    selection_token: Optional[str] = None
    selection_count: Optional[int] = None
    image_paths: List[str] = field(default_factory=list)
    dataset_scan_token: Optional[str] = None
    dataset_scan_count: Optional[int] = None
    training_purpose: str = "general"
    trigger_word: str = ""
    merge_strategy: str = "replace"  # replace | append
    auto_strip_noise: bool = True
    skip_existing: bool = True
    enable_wd14: bool = True
    enable_vlm: bool = True
    tagger_model: str = ""  # "" -> use the configured default
    use_gpu: bool = True
    general_threshold: float = 0.35
    character_threshold: float = 0.85
    copyright_threshold: float = 0.35
    max_tags_per_image: int = 0
    natural_language_mode: str = "vlm"  # vlm | toriigate
    caption_profile: Optional[SmartTagCaptionProfile] = None
    # v3.2.2 T-power-PR2 (D): multi-tagger consensus.
    # When ``taggers`` is non-empty, the orchestrator runs each one
    # sequentially against the image and fuses the per-tag votes via
    # ``compute_consensus_tags``. ``tagger_model`` is ignored in this mode.
    # Default: empty list = legacy single-tagger path. ``consensus_min``
    # is the minimum sum of weights for a tag to survive the vote;
    # ``consensus_skip_categories`` lists category names that bypass the
    # vote with OR semantics (default: 'character' + 'copyright', because
    # most taggers can't recognize specific characters reliably).
    taggers: List[Dict[str, Any]] = field(default_factory=list)
    consensus_min: int = 2
    consensus_skip_categories: List[str] = field(
        default_factory=lambda: ["character", "copyright"]
    )
    # ToriiGate generation parameters (v3.4.3). caption_length picks the
    # prompt + token budget (brief→160, detailed→512); max_new_tokens 0 means
    # "derive from length"; grounding feeds the WD14 tags to ToriiGate as
    # reference input (official model usage, mirrors the VLM {tags} context).
    toriigate_caption_length: str = "detailed"
    toriigate_max_new_tokens: int = 0
    vlm_grounding: bool = True
    toriigate_grounding: bool = True
    # SEP-2: dataset-specific intrinsic-trait list (the user's pruned traits).
    # Injected into the VLM prompt as a "never mention these" block so prose
    # captions cannot re-introduce features the tag blacklist absorbed into
    # the trigger word.
    suppressed_traits: List[str] = field(default_factory=list)


def _coerce_dataset_scan_token(payload: Dict[str, Any]) -> Optional[str]:
    for key in (
        "dataset_scan_token",
        "dataset_manifest_token",
        "dataset_session_token",
        "scan_token",
        "session_token",
    ):
        value = str(payload.get(key) or "").strip()
        if value:
            return value
    return None


def _load_dataset_scan_paths(scan_token: str) -> List[str]:
    from services.dataset_session_service import iter_scan_manifest_paths

    return [str(path) for path in iter_scan_manifest_paths(scan_token) if str(path or "").strip()]


def _count_dataset_scan_token_paths(scan_token: str) -> int:
    from services.dataset_session_service import count_scan_manifest_paths

    return count_scan_manifest_paths(scan_token)


def _tagger_defaults(model_name: str) -> Dict[str, Any]:
    name = str(model_name or "").strip().lower()
    if not name:
        name = DEFAULT_TAGGER_MODEL
    if name == "oppai-oracle":
        name = "oppai-oracle-v1.1"
    config = TAGGER_MODELS.get(name, {})
    general = float(config.get("default_threshold", 0.35))
    character = float(config.get("default_character_threshold", 0.85))
    copyright = float(config.get("default_copyright_threshold", general))
    max_tags = int(config.get("default_max_tags_per_image", 0) or 0)
    return {
        "general_threshold": general,
        "character_threshold": character,
        "copyright_threshold": copyright,
        "max_tags_per_image": max_tags,
    }


def _coerce_threshold(raw: Any, default: float) -> float:
    if raw is None or raw == "":
        return float(default)
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return float(default)
    return max(0.0, min(1.0, value))


def _coerce_max_tags(raw: Any, default: int) -> int:
    if raw is None or raw == "":
        return max(0, int(default or 0))
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return max(0, int(default or 0))
    return max(0, min(2000, value))


def _coerce_toriigate_max_tokens(raw: Any) -> int:
    """0 means "derive from caption_length"; explicit values clamp to [32, 1024]."""
    try:
        value = int(raw or 0)
    except (TypeError, ValueError):
        return 0
    if value <= 0:
        return 0
    return max(32, min(1024, value))


def _coerce_caption_profile(raw: object) -> Optional[SmartTagCaptionProfile]:
    if raw is None:
        return None
    if isinstance(raw, SmartTagCaptionProfile):
        return raw
    value = str(raw).strip()
    try:
        return SmartTagCaptionProfile(value)
    except ValueError as exc:
        allowed = ", ".join(profile.value for profile in SmartTagCaptionProfile)
        raise ValueError(
            f"caption_profile must be one of: {allowed}. Received: {value!r}."
        ) from exc


def _coerce_request(payload: Dict[str, Any]) -> SmartTagRequest:
    image_ids = payload.get("image_ids") or []
    if not isinstance(image_ids, list):
        raise ValueError("image_ids must be a list of integers")
    cleaned_ids: List[int] = []
    seen_ids: Set[int] = set()
    for raw in image_ids:
        try:
            image_id = int(raw)
        except (TypeError, ValueError):
            raise ValueError(f"image_ids contains non-integer entry: {raw!r}")
        if image_id > 0 and image_id not in seen_ids:
            seen_ids.add(image_id)
            cleaned_ids.append(image_id)

    selection_token = str(payload.get("selection_token") or "").strip() or None
    selection_count: Optional[int] = None
    if selection_token:
        try:
            selection_count = int(count_selection_token_ids(selection_token))
        except Exception as exc:  # noqa: BLE001
            detail = getattr(exc, "detail", None) or str(exc)
            raise ValueError(f"Invalid selection_token: {detail}") from exc

    raw_paths = payload.get("image_paths") or []
    if not isinstance(raw_paths, list):
        raise ValueError("image_paths must be a list of file paths")
    cleaned_paths: List[str] = []
    seen_paths: Set[str] = set()
    for raw_path in raw_paths:
        if not raw_path:
            continue
        try:
            path = Path(normalize_user_path(str(raw_path))).resolve()
        except (OSError, ValueError) as exc:
            raise ValueError(f"image_paths contains invalid path: {raw_path!r}") from exc
        if path.suffix.lower() not in ALLOWED_IMAGE_EXTENSIONS:
            continue
        if path.is_file():
            path_str = str(path)
            if path_str not in seen_paths:
                seen_paths.add(path_str)
                cleaned_paths.append(path_str)

    dataset_scan_token = _coerce_dataset_scan_token(payload)
    dataset_scan_count: Optional[int] = None
    if dataset_scan_token:
        try:
            dataset_scan_count = _count_dataset_scan_token_paths(dataset_scan_token)
        except Exception as exc:  # noqa: BLE001
            raise ValueError(f"Invalid dataset scan token: {exc}") from exc

    if not cleaned_ids and not selection_token and not cleaned_paths and not dataset_scan_token:
        raise ValueError("Smart Tag needs image_ids, selection_token, image_paths, or dataset_scan_token.")

    # Fix M3: trigger word must be a single token (no internal whitespace) or
    # it gets injected as multiple comma-separated tokens in the final caption.
    # Empty trigger is fine (means "don't inject"); leading/trailing whitespace
    # is stripped silently.
    trigger_word_raw = str(payload.get("trigger_word") or "").strip()
    if trigger_word_raw and re.search(r"\s", trigger_word_raw):
        raise ValueError(
            "Trigger word should be a single token without spaces. "
            "Use underscores or camelcase: 'my_lora_trigger' or 'myLoraTrigger'."
        )

    # Fix B2: reject (enable_vlm=True, nl_mode='vlm', no VLM endpoint) at
    # request validation time instead of letting the worker silently fall
    # back to booru-only output. The user clicked "WD14 + VLM" so an empty
    # VLM config is an explicit configuration error, not a soft degrade.
    enable_vlm_flag = bool(payload.get("enable_vlm", True))
    nl_mode_value = payload.get("natural_language_mode")
    nl_mode_raw = (
        "vlm"
        if nl_mode_value is None
        else str(nl_mode_value).strip().lower()
    )
    nl_mode_normalized = (
        "toriigate"
        if nl_mode_raw in {"toriigate", "torii", "toriigate-0.5"}
        else "vlm"
    )
    caption_profile = _coerce_caption_profile(payload.get("caption_profile"))
    if caption_profile is not None and not enable_vlm_flag:
        raise ValueError(
            "caption_profile requires enable_vlm=true because caption profiles "
            "apply only to VLM natural-language captions. Remove caption_profile "
            "or enable VLM captioning."
        )
    if caption_profile is not None and nl_mode_raw != "vlm":
        raise ValueError(
            "caption_profile requires natural_language_mode='vlm'; received "
            f"natural_language_mode={nl_mode_raw!r}. Remove caption_profile "
            "or select VLM natural-language captioning."
        )
    if enable_vlm_flag and nl_mode_normalized == "vlm":
        try:
            # Lazy import to avoid hard coupling between the service layer
            # and the VLM router module on startup.
            from routers.vlm import _build_config as _build_vlm_config

            vlm_config = _build_vlm_config()
        except Exception as exc:  # noqa: BLE001
            raise ValueError(
                "Natural-language captioning is enabled, but the VLM "
                f"configuration could not be loaded: {exc}. Open VLM Settings "
                "and configure an endpoint, or disable natural-language captioning."
            ) from exc
        provider_name = (getattr(vlm_config, "provider", "") or "").strip().lower()
        endpoint = (getattr(vlm_config, "endpoint", "") or "").strip()
        api_key = (getattr(vlm_config, "api_key", "") or "").strip()
        use_vertex = bool(getattr(vlm_config, "use_vertex", False))
        vertex_project = (getattr(vlm_config, "vertex_project", "") or "").strip()

        # Vertex AI auth path: project + service-account credentials, no api_key.
        if provider_name == "gemini" and use_vertex:
            if not vertex_project:
                raise ValueError(
                    "Natural-language captioning via Vertex AI is enabled, but "
                    "VLM Settings has no Vertex project configured. Open VLM "
                    "Settings and set the Vertex project, or disable natural-"
                    "language captioning."
                )
        else:
            if not endpoint:
                raise ValueError(
                    "Natural-language captioning is enabled, but VLM Settings "
                    "has no endpoint configured. Open VLM Settings and "
                    "configure an endpoint, or disable natural-language "
                    "captioning."
                )
            # Local OpenAI-compatible servers (Ollama, vLLM, LM Studio, etc.)
            # accept requests without an api_key. Only require api_key when
            # the endpoint points at something other than a loopback / *.local
            # / *.lan host so cloud providers still get caught early.
            if not api_key and not _is_local_openai_compat_endpoint(provider_name, endpoint):
                raise ValueError(
                    "Natural-language captioning is enabled, but VLM Settings "
                    "has no API key configured. Open VLM Settings and "
                    "configure an API key, or disable natural-language "
                    "captioning."
                )

    tagger_model = str(payload.get("tagger_model") or "").strip()
    single_defaults = _tagger_defaults(tagger_model)

    # T-power-PR2 (D): coerce taggers list to a stable shape.
    raw_taggers = payload.get("taggers") or []
    cleaned_taggers: List[Dict[str, Any]] = []
    multi_max_tag_defaults: List[int] = []
    if isinstance(raw_taggers, list):
        for entry in raw_taggers:
            if not isinstance(entry, dict):
                continue
            model = str(entry.get("model") or "").strip()
            if not model:
                continue
            defaults = _tagger_defaults(model)
            if int(defaults.get("max_tags_per_image") or 0) > 0:
                multi_max_tag_defaults.append(int(defaults["max_tags_per_image"]))
            general_threshold = _coerce_threshold(
                entry.get("general_threshold"),
                defaults["general_threshold"],
            )
            cleaned_taggers.append({
                "model": model,
                "weight": float(entry.get("weight") or 1.0),
                "general_threshold": general_threshold,
                "character_threshold": _coerce_threshold(
                    entry.get("character_threshold"),
                    defaults["character_threshold"],
                ),
                "copyright_threshold": _coerce_threshold(
                    entry.get("copyright_threshold"),
                    defaults.get("copyright_threshold", general_threshold),
                ),
            })

    raw_skip = payload.get("consensus_skip_categories")
    if raw_skip is None:
        skip_categories = ["character", "copyright"]
    elif isinstance(raw_skip, list):
        skip_categories = [str(s).strip().lower() for s in raw_skip if str(s).strip()]
    else:
        skip_categories = ["character", "copyright"]

    max_tags_default = (
        min(multi_max_tag_defaults)
        if multi_max_tag_defaults and payload.get("max_tags_per_image") in (None, "")
        else single_defaults["max_tags_per_image"]
    )

    return SmartTagRequest(
        image_ids=cleaned_ids,
        selection_token=selection_token,
        selection_count=selection_count,
        image_paths=cleaned_paths,
        dataset_scan_token=dataset_scan_token,
        dataset_scan_count=dataset_scan_count,
        training_purpose=normalize_training_purpose(payload.get("training_purpose")),
        trigger_word=trigger_word_raw,
        merge_strategy=str(payload.get("merge_strategy") or "replace").strip().lower(),
        auto_strip_noise=bool(payload.get("auto_strip_noise", True)),
        skip_existing=bool(payload.get("skip_existing", True)),
        enable_wd14=bool(payload.get("enable_wd14", True)),
        enable_vlm=enable_vlm_flag,
        tagger_model=tagger_model,
        use_gpu=bool(payload.get("use_gpu", True)),
        general_threshold=_coerce_threshold(
            payload.get("general_threshold"),
            single_defaults["general_threshold"],
        ),
        character_threshold=_coerce_threshold(
            payload.get("character_threshold"),
            single_defaults["character_threshold"],
        ),
        copyright_threshold=_coerce_threshold(
            payload.get("copyright_threshold"),
            single_defaults["copyright_threshold"],
        ),
        max_tags_per_image=_coerce_max_tags(
            payload.get("max_tags_per_image"),
            max_tags_default,
        ),
        natural_language_mode=nl_mode_normalized,
        caption_profile=caption_profile,
        taggers=cleaned_taggers,
        consensus_min=max(1, int(payload.get("consensus_min", 2) or 2)),
        consensus_skip_categories=skip_categories,
        toriigate_caption_length=(
            "brief"
            if str(payload.get("toriigate_caption_length") or "").strip().lower() == "brief"
            else "detailed"
        ),
        toriigate_max_new_tokens=_coerce_toriigate_max_tokens(
            payload.get("toriigate_max_new_tokens")
        ),
        vlm_grounding=bool(payload.get("vlm_grounding", True)),
        toriigate_grounding=bool(payload.get("toriigate_grounding", True)),
        suppressed_traits=[
            str(trait).strip()
            for trait in (payload.get("suppressed_traits") or [])
            if str(trait or "").strip()
        ][:500],
    )


def _request_total(req: SmartTagRequest) -> int:
    total = len(req.image_ids) + len(req.image_paths)
    if req.selection_token:
        total += int(req.selection_count if req.selection_count is not None else count_selection_token_ids(req.selection_token))
    if req.dataset_scan_token:
        total += int(req.dataset_scan_count if req.dataset_scan_count is not None else _count_dataset_scan_token_paths(req.dataset_scan_token))
    return total
