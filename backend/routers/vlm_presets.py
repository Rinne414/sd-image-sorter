"""Saved VLM prompt presets: create, update, delete (GitHub issue #21).

``GET /api/vlm/presets`` stays on routers/vlm.py and lists the built-in
presets followed by the user's own. The routes here register on the ONE
shared ``router`` of routers/vlm.py, which imports this module last, so they
follow every older route in the pinned route table.
"""

from __future__ import annotations

from typing import Any, Dict, Literal, Optional

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field

from routers.vlm import router
from services import vlm_prompt_presets as preset_store

OutputFormat = Literal["nl_caption", "danbooru_tags", "both"]
PRESET_NAME_MAX_LENGTH = 200


class PromptPresetCreateRequest(BaseModel):
    """A new saved preset; ``id`` is sent only when Undo brings back a deleted one."""

    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=PRESET_NAME_MAX_LENGTH)
    output_format: OutputFormat = "nl_caption"
    system_prompt: str = ""
    user_prompt: str = ""
    user_prompt_with_tags: str = ""
    id: Optional[str] = Field(default=None, max_length=64)


class PromptPresetUpdateRequest(BaseModel):
    """Only the fields present change."""

    model_config = ConfigDict(extra="forbid")

    name: Optional[str] = Field(
        default=None, min_length=1, max_length=PRESET_NAME_MAX_LENGTH
    )
    output_format: Optional[OutputFormat] = None
    system_prompt: Optional[str] = None
    user_prompt: Optional[str] = None
    user_prompt_with_tags: Optional[str] = None


def _refused(exc: preset_store.PresetError) -> HTTPException:
    return HTTPException(status_code=exc.status_code, detail=exc.as_detail())


@router.post("/presets")
async def create_prompt_preset(request: PromptPresetCreateRequest) -> Dict[str, Any]:
    fields = request.model_dump(exclude={"name", "id"})
    try:
        preset = preset_store.create_preset(request.name, fields, preset_id=request.id)
    except preset_store.PresetError as exc:
        raise _refused(exc) from exc
    return {"preset": preset}


@router.patch("/presets/{preset_id}")
async def update_prompt_preset(
    preset_id: str, request: PromptPresetUpdateRequest
) -> Dict[str, Any]:
    fields = request.model_dump(exclude={"name"}, exclude_none=True)
    try:
        preset = preset_store.update_preset(preset_id, name=request.name, fields=fields)
    except preset_store.PresetError as exc:
        raise _refused(exc) from exc
    return {"preset": preset}


@router.delete("/presets/{preset_id}")
async def delete_prompt_preset(preset_id: str) -> Dict[str, Any]:
    try:
        preset = preset_store.delete_preset(preset_id)
    except preset_store.PresetError as exc:
        raise _refused(exc) from exc
    return {"deleted": preset}
