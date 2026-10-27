"""Exact caption token counts for the dataset Check step, per base model.

SDXL: CLIP ViT-L/14 (2 MB). FLUX: T5 v1.1 XXL (2 MB). Krea 2: Qwen3 (11 MB).
Anima: Qwen3 and T5 (14 MB). A base model's files are fetched once, on
request. Until they are there the count endpoint answers ``available: false``
and the UI keeps its labelled estimate; nothing is blocked.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field

from services import caption_tokenizer_service as tokenizers

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["dataset"])


class CaptionTokensRequest(BaseModel):
    """Request body for ``POST /api/dataset/caption-tokens``."""

    model_config = ConfigDict(extra="ignore")

    profile: str = Field(default="anima", max_length=32)
    texts: List[str] = Field(default_factory=list)


@router.get(
    "/dataset/caption-tokens/status",
    summary="Are the exact caption tokenizers ready?",
)
def get_caption_tokens_status(
    profile: str = Query(default=tokenizers.DEFAULT_PROFILE, max_length=32),
) -> Dict[str, Any]:
    try:
        return tokenizers.get_status(profile)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post(
    "/dataset/caption-tokens/prepare",
    summary="Download a base model's caption tokenizer files (2 to 14 MB, once)",
    description=(
        "Installs the `tokenizers` package when it is missing, then downloads the "
        "tokenizer files the `profile` (sdxl, flux, krea2, anima) counts with, "
        "pinned to a Hugging Face commit and verified by SHA-256, on a background "
        "thread. Progress and failures show in "
        "`GET /api/dataset/caption-tokens/status?profile=...`."
    ),
)
def post_caption_tokens_prepare(
    profile: str = Query(default=tokenizers.DEFAULT_PROFILE, max_length=32),
) -> Dict[str, Any]:
    try:
        return tokenizers.start_prepare(profile)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post(
    "/dataset/caption-tokens",
    summary="Exact token counts of captions",
    description=(
        "Counts each text with the tokenizers a base model reads captions with, "
        "and says how many tokens of a caption it keeps (`limit`). `sdxl`: CLIP "
        "ViT-L/14 without start and end tokens (75). `flux`: T5 v1.1 XXL with its "
        "end token (512). `krea2`: Qwen3 (507: the rest of 512 is its prompt "
        "template). `anima`: Qwen3-0.6B and T5 v1.1 XXL (512 each). "
        "`available: false` means a tokenizer file or the package is missing: no "
        "number is guessed."
    ),
)
def post_caption_tokens(payload: CaptionTokensRequest) -> Dict[str, Any]:
    try:
        return tokenizers.count_tokens(payload.profile, payload.texts)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("Caption token count failed")
        raise HTTPException(
            status_code=500, detail="Token count failed. / 无法计算 token 数。"
        ) from exc
