"""Exact caption token counts for the dataset Check step (Anima: Qwen3-0.6B and T5 v1.1 XXL).

The tokenizer files are fetched once, on request (about 14 MB). Until they are
there the count endpoint answers ``available: false`` and the UI keeps its
labelled estimate; nothing is blocked.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List

from fastapi import APIRouter, HTTPException
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
def get_caption_tokens_status() -> Dict[str, Any]:
    return tokenizers.get_status()


@router.post(
    "/dataset/caption-tokens/prepare",
    summary="Download the caption tokenizer files (about 14 MB, once)",
    description=(
        "Installs the `tokenizers` package when it is missing, then downloads the "
        "Qwen3-0.6B and T5 v1.1 XXL tokenizer files pinned to a Hugging Face "
        "commit and verified by SHA-256, on a background thread. Progress and "
        "failures show in `GET /api/dataset/caption-tokens/status`."
    ),
)
def post_caption_tokens_prepare() -> Dict[str, Any]:
    return tokenizers.start_prepare()


@router.post(
    "/dataset/caption-tokens",
    summary="Exact token counts of captions",
    description=(
        "Counts each text with the tokenizers a base model reads captions with. "
        "`anima` gives Qwen3-0.6B (no special tokens) and T5 v1.1 XXL (one end "
        "token added) counts. `available: false` means a tokenizer file or the "
        "package is missing: no number is guessed."
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
