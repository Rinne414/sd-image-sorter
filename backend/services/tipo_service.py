"""TIPO tag-upsampling assist (roadmap #8, v1).

TIPO (Text to Image with text Presampling for Optimal prompting,
arXiv:2411.08127, KohakuBlueleaf/KGen) is a small LLaMA-architecture model
trained to EXPAND a danbooru tag list. WD14-family taggers can only score
labels that exist in their trained label set, so a concept without a label
is invisible to them — and therefore also invisible to the score-band
coverage-gaps flow, which reads stored tagger scores. TIPO proposes tags
from a different direction (language-model continuation over the danbooru
vocabulary), surfacing exactly those blind spots.

v1 guard rails:

* NEVER auto-applies — the endpoint only returns proposals; the frontend
  renders a default-unchecked checklist whose confirmed picks land in the
  least destructive place (the export "Common tags" box).
* every candidate passes the shared vocabulary gate
  (``services/vlm_tag_gate.py``), so out-of-vocab hallucinations are
  dropped before the user ever sees them; input tags are folded
  (case/underscore) and stripped; proposals are capped at 40.

Runtime: ``tipo-kgen`` + ``llama-cpp-python`` (CPU, GGUF) — an OPT-IN
dependency pair mirroring rembg in ``services/mask_service.py``: a missing
install raises a clear bilingual error carrying the exact pip command.
(Note: tipo-kgen 0.2.0 also declares torch/transformers as install deps —
``kgen.models`` imports them at module level — but only the llama_cpp GGUF
path is ever exercised here.)

Model licenses (per decision memo — keep documented):

* ``200m-ft`` (default) — TIPO-200M-ft via the QuantFactory GGUF mirror.
  License: kohaku-license-1.0 — free for local/personal use (this app is a
  local tool); redistribution/commercial hosting restricted.
* ``100m`` — TIPO-100M (KBlueLeaf official F16 GGUF). License: Apache-2.0,
  the license-safest choice.

Weights download on demand into ``DATA_DIR/models/tipo/`` (override with
``SD_IMAGE_SORTER_TIPO_DIR``) — never into the user profile.
"""

from __future__ import annotations

import logging
import os
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, Field

import config

logger = logging.getLogger(__name__)

PIP_INSTALL_HINT = "pip install llama-cpp-python tipo-kgen"

MISSING_DEPS_MESSAGE = (
    "TIPO is not installed. Install it into the backend environment with: "
    f"{PIP_INSTALL_HINT}  (CPU GGUF runtime; the model, ~100-250 MB, "
    "downloads on first use into DATA_DIR/models/tipo.) / 未安装 TIPO。"
    f"请在后端环境执行 {PIP_INSTALL_HINT}"
    "（CPU GGUF 运行时；首次使用会自动下载模型，约 100-250 MB）。"
)

# Hard ceiling on returned proposals — a review checklist longer than this
# stops being reviewable, and the model rarely produces more useful ones.
MAX_PROPOSALS = 40

# Buckets of the parsed TIPO result that contain proposable caption tags.
# artist is deliberately excluded (hallucinated artist names are the worst
# failure mode) and quality/meta/rating never belong in dataset captions.
_PROPOSAL_BUCKETS = ("special", "general", "characters", "copyrights")


@dataclass(frozen=True)
class TipoModelSpec:
    repo: str
    filename: str
    license_note: str


MODEL_SPECS: Dict[str, TipoModelSpec] = {
    "200m-ft": TipoModelSpec(
        repo="QuantFactory/TIPO-200M-ft-GGUF",
        filename="TIPO-200M-ft.Q8_0.gguf",
        license_note="kohaku-license-1.0 (free for local use)",
    ),
    "100m": TipoModelSpec(
        repo="KBlueLeaf/TIPO-100M",
        filename="TIPO-100M-F16.gguf",
        license_note="Apache-2.0 (license-safest)",
    ),
}


class TipoError(ValueError):
    """User-facing TIPO failure (router maps this to HTTP 400)."""


class TipoSuggestRequest(BaseModel):
    image_id: Optional[int] = Field(default=None, ge=1)
    tags: List[str] = Field(..., min_length=1, max_length=200)
    rating: Optional[str] = Field(default=None, max_length=32)
    aspect_ratio: Optional[float] = Field(default=None, gt=0.0, le=100.0)
    target: Literal["short", "long"] = "short"
    model: Literal["200m-ft", "100m"] = "200m-ft"


# llama.cpp contexts are not thread-safe and FastAPI runs sync endpoints in
# a threadpool — one lock guards load + generation (singleton model).
_RUNTIME_LOCK = threading.Lock()
_loaded_model_key: Optional[str] = None


def tipo_model_dir() -> Path:
    """Model weight home: DATA_DIR/models/tipo, env-overridable — the same
    stay-portable policy as rembg's ``_rembg_session_home``."""
    override = (os.environ.get("SD_IMAGE_SORTER_TIPO_DIR") or "").strip()
    path = Path(override) if override else Path(config.DATA_DIR) / "models" / "tipo"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _fold(tag: str) -> str:
    """Case/underscore fold matching ``vlm_tag_gate.normalize_tag`` output."""
    return (tag or "").strip().lower().replace(" ", "_")


def _import_kgen() -> Dict[str, Any]:
    """Import the opt-in TIPO runtime, or raise the actionable 400 message.

    tipo-kgen 0.2.0 verified API (src/kgen):
    * ``models.model_dir`` (module global), ``models.download_gguf(repo,
      filename)``, ``models.load_model(path, gguf=True, device="cpu")``
    * ``formatter.seperate_tags(tags) -> tag_map``
    * ``executor.tipo.parse_tipo_request(tag_map, nl_prompt, ...) ->
      (meta, operations, general, nl_prompt)``
    * ``executor.tipo.tipo_runner(meta, operations, general, nl_prompt,
      seed=..) -> (parsed, timing)``
    """
    try:
        import llama_cpp  # noqa: F401, PLC0415 - heavy opt-in dependency
        import kgen.models as kgen_models  # noqa: PLC0415
        from kgen.executor.tipo import (  # noqa: PLC0415
            parse_tipo_request,
            tipo_runner,
        )
        from kgen.formatter import seperate_tags  # noqa: PLC0415
    except ImportError as exc:
        raise TipoError(MISSING_DEPS_MESSAGE) from exc
    return {
        "models": kgen_models,
        "seperate_tags": seperate_tags,
        "parse_tipo_request": parse_tipo_request,
        "tipo_runner": tipo_runner,
    }


def _ensure_model_loaded(model_key: str) -> Dict[str, Any]:
    """Lazy singleton load of the requested GGUF. Caller holds the lock.

    Downloads on first real use only — never at import or startup. kgen's
    ``download_gguf`` renames the fetched file to ``{repo_tail}_{filename}``
    inside ``models.model_dir``, so the existence probe mirrors that.
    """
    global _loaded_model_key
    api = _import_kgen()
    models = api["models"]
    models.model_dir = tipo_model_dir()
    if _loaded_model_key == model_key and models.text_model is not None:
        return api
    spec = MODEL_SPECS[model_key]
    target = models.model_dir / f"{spec.repo.split('/')[-1]}_{spec.filename}"
    try:
        if not target.is_file():
            logger.info(
                "TIPO: downloading %s/%s (%s) into %s",
                spec.repo,
                spec.filename,
                spec.license_note,
                models.model_dir,
            )
            models.download_gguf(spec.repo, spec.filename)
        models.load_model(str(target), gguf=True, device="cpu")
    except TipoError:
        raise
    except Exception as exc:
        raise TipoError(
            f"TIPO model load failed: {exc} / TIPO 模型加载失败：{exc}"
        ) from exc
    _loaded_model_key = model_key
    logger.info("TIPO model %s loaded (%s)", model_key, spec.license_note)
    return api


def _generate_candidates(
    input_tags: List[str],
    rating: Optional[str],
    aspect_ratio: Optional[float],
    target: str,
    model_key: str,
) -> List[str]:
    """Run one TIPO pass and return the RAW candidate tag strings.

    Tests monkeypatch THIS function — everything above it needs the real
    runtime, everything below it (dedup, vocab gate, cap, categorization)
    is pure post-processing.
    """
    with _RUNTIME_LOCK:
        api = _ensure_model_loaded(model_key)
        tag_map = api["seperate_tags"](list(input_tags))
        if rating:
            tag_map["rating"] = [str(rating).strip().lower()]
        meta, operations, general, nl_prompt = api["parse_tipo_request"](
            tag_map,
            "",
            tag_length_target=target,
            nl_length_target=target,
            generate_extra_nl_prompt=False,
            add_quality=False,
        )
        if aspect_ratio:
            # Same convention as KohakuBlueleaf's z-tipo-extension: aspect
            # ratio rides the meta block of the TIPO prompt.
            meta["aspect_ratio"] = f"{float(aspect_ratio):.1f}"
        try:
            parsed, _timing = api["tipo_runner"](meta, operations, general, nl_prompt)
        except Exception as exc:
            raise TipoError(
                f"TIPO generation failed: {exc} / TIPO 生成失败：{exc}"
            ) from exc
    candidates: List[str] = []
    for bucket in _PROPOSAL_BUCKETS:
        value = parsed.get(bucket) or []
        if isinstance(value, list):
            candidates.extend(str(item) for item in value)
    return candidates


def _fill_aspect_ratio_from_image(image_id: int) -> Optional[float]:
    """Derive width/height aspect ratio from the gallery record."""
    import database as db  # noqa: PLC0415 - keep module import-light (router imports the request model)

    record = (db.get_images_by_ids([int(image_id)]) or {}).get(int(image_id))
    if not record:
        raise LookupError(f"Image {image_id} not found in library")
    width = record.get("width")
    height = record.get("height")
    if width and height:
        return float(width) / float(height)
    return None


def suggest_upsample(request: TipoSuggestRequest) -> Dict[str, Any]:
    """Propose vocabulary-gated tags the input list does not already carry.

    Returns ``{proposed_tags: [{tag, category}], model, elapsed_ms,
    input_tags}``. Read-only: nothing is written to the database — applying
    any proposal is a separate, human-confirmed frontend action.
    """
    input_tags = [str(tag).strip() for tag in request.tags if str(tag or "").strip()]
    if not input_tags:
        raise TipoError(
            "No usable input tags — send the queue's current tag list. "
            "/ 没有可用的输入标签 — 请传入队列当前的标签列表。"
        )

    aspect_ratio = request.aspect_ratio
    if aspect_ratio is None and request.image_id is not None:
        aspect_ratio = _fill_aspect_ratio_from_image(request.image_id)

    started = time.perf_counter()
    raw = _generate_candidates(
        input_tags, request.rating, aspect_ratio, request.target, request.model
    )
    elapsed_ms = int((time.perf_counter() - started) * 1000)

    # Lazy imports: the vocab gate pulls the ~140k-row bundled CSV and
    # tag_rules is a heavy rule table — neither belongs at module import.
    from services.vlm_tag_gate import filter_vlm_tags  # noqa: PLC0415
    from tag_rules import categorize_tag  # noqa: PLC0415

    folded_inputs = {_fold(tag) for tag in input_tags}
    fresh = [tag for tag in raw if _fold(tag) not in folded_inputs]
    accepted, dropped = filter_vlm_tags(fresh)
    proposals = [tag for tag in accepted if tag not in folded_inputs][:MAX_PROPOSALS]
    logger.info(
        "TIPO suggest: %s input tags -> %s raw / %s gated-out / %s proposed (%s ms)",
        len(input_tags),
        len(raw),
        dropped,
        len(proposals),
        elapsed_ms,
    )
    return {
        "proposed_tags": [
            {"tag": tag, "category": categorize_tag(tag)} for tag in proposals
        ],
        "model": request.model,
        "elapsed_ms": elapsed_ms,
        "input_tags": len(input_tags),
    }
