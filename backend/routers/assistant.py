"""The built-in assistant's endpoints: settings, a run, its events, confirm, stop."""

from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from assistant import llm, runs, settings, tools

router = APIRouter(prefix="/api/assistant", tags=["assistant"])


class SettingsRequest(BaseModel):
    endpoint: Optional[str] = Field(default=None, max_length=2048)
    api_key: Optional[str] = Field(default=None, max_length=4096)
    model: Optional[str] = Field(default=None, max_length=300)
    access: Optional[str] = Field(default=None, pattern="^(ask|read_only|auto)$")
    extra_instructions: Optional[str] = Field(
        default=None, max_length=settings.MAX_EXTRA_INSTRUCTIONS
    )
    # Use the AI caption service for the assistant (said on the setup screen).
    use_caption_service: Optional[bool] = None
    # Remove the stored key.
    clear_api_key: Optional[bool] = None


class RunRequest(BaseModel):
    messages: List[Dict[str, Any]] = Field(..., min_length=1)
    # What the user is looking at: page, filters, selected ids, language.
    view: Dict[str, Any] = Field(default_factory=dict)


class ConfirmRequest(BaseModel):
    id: str = Field(..., min_length=1, max_length=64)
    approved: bool


def _run_or_404(run_id: str) -> runs.Run:
    run = runs.find(run_id)
    if run is None:
        raise HTTPException(
            status_code=404, detail="This run is gone. Send the message again."
        )
    return run


@router.get("/settings")
async def get_settings():
    """The assistant's settings as the panel shows them (the key is never returned)."""
    return settings.public_view()


@router.post("/settings")
async def save_settings(request: SettingsRequest):
    """Save the assistant's model service and how much it may do."""
    settings.save(request.model_dump())
    return settings.public_view()


@router.get("/tools")
async def list_tools():
    """What the assistant can do, by class (read, show, change): shown in its panel."""
    return {
        "tools": [
            {"name": tool.name, "kind": tool.kind, "description": tool.description}
            for tool in tools.offered(read_only=False)
        ]
    }


@router.post("/models")
async def list_models():
    """The models the configured service offers."""
    connection = settings.resolve(need_model=False)
    if connection is None:
        raise HTTPException(
            status_code=400, detail="Enter the address of a model service first."
        )
    try:
        return {"models": await llm.list_models(connection)}
    except llm.ModelError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@router.post("/test")
async def test_connection():
    """One short question to the model, to prove the address, key and model work."""
    connection = settings.resolve()
    if connection is None:
        raise HTTPException(
            status_code=400, detail="Enter the address of a model service first."
        )

    async def ignore(_piece: str) -> None:
        return None

    question = [{"role": "user", "content": "Reply with the single word: ready"}]
    try:
        reply = await llm.stream_reply(connection, question, [], ignore)
    except llm.ModelError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {"ok": True, "model": connection.model, "reply": reply.text[:200]}


@router.post("/runs")
async def start_run(request: RunRequest):
    """Start the assistant on the conversation so far; returns the run to poll."""
    try:
        run = runs.start(request.messages, request.view)
    except RuntimeError as exc:
        if str(exc) == "not_configured":
            raise HTTPException(
                status_code=409, detail="The assistant has no model service yet."
            ) from exc
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"run_id": run.id}


@router.get("/runs/{run_id}/events")
async def run_events(run_id: str, after: int = 0):
    """Events of a run from index ``after``; waits a while when there is nothing new yet."""
    run = _run_or_404(run_id)
    events = await run.events_after(max(0, after))
    return {
        "events": events,
        "next": max(0, after) + len(events),
        "finished": run.finished_at is not None,
    }


@router.post("/runs/{run_id}/confirm")
async def confirm_change(run_id: str, request: ConfirmRequest):
    """The user's answer to a change the assistant wants to make."""
    if not _run_or_404(run_id).answer(request.id, request.approved):
        raise HTTPException(
            status_code=409, detail="This confirmation is no longer waiting."
        )
    return {"ok": True}


@router.post("/runs/{run_id}/stop")
async def stop_run(run_id: str):
    """Stop a run: ends the model request and refuses a waiting confirmation."""
    _run_or_404(run_id).stop()
    return {"ok": True}
