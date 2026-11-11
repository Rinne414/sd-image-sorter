"""One streamed chat-completions call, with tool calls.

Speaks the OpenAI chat format, which is also what LM Studio, Ollama, llama.cpp,
OpenRouter and the compatibility endpoints of Gemini and Claude accept. The
reply is read as a stream so the text appears while it is written and a stop
ends the request at once.
"""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass, field
from typing import Any, AsyncIterator, Awaitable, Callable, Dict, List, Optional

import httpx

from assistant.settings import Connection
from vlm_providers.base import ProviderError, assert_safe_request_url, make_async_client

REQUEST_TIMEOUT_SECONDS = 180.0
ERROR_BODY_CHARS = 400


class ModelError(RuntimeError):
    """The model service refused or could not be reached; the message is shown to the user."""


@dataclass
class Reply:
    text: str = ""
    tool_calls: List[Dict[str, Any]] = field(default_factory=list)
    finish_reason: str = ""

    def as_message(self) -> Dict[str, Any]:
        message: Dict[str, Any] = {"role": "assistant", "content": self.text or None}
        if self.tool_calls:
            message["tool_calls"] = self.tool_calls
        return message


def _headers(connection: Connection, api_key: str) -> Dict[str, str]:
    headers = {"Content-Type": "application/json", "Accept": "text/event-stream"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    return headers


def _explain(status: int, body: str) -> str:
    """A model service error in words a user can act on; never the key."""
    text = body.strip()
    try:
        parsed = json.loads(text)
        detail = parsed.get("error")
        if isinstance(detail, dict):
            detail = detail.get("message")
        text = str(detail or parsed.get("message") or text)
    except (ValueError, AttributeError):
        if text.lstrip().startswith("<"):
            text = "The address answered with a web page, not an API reply. Check the address (it usually ends in /v1)."
    return f"The model service answered {status}: {text[:ERROR_BODY_CHARS]}"


def _check_address(url: str) -> None:
    try:
        assert_safe_request_url(url)
    except ProviderError as exc:
        raise ModelError(str(exc)) from exc


def _client(config: Any, timeout: float) -> httpx.AsyncClient:
    try:
        return make_async_client(config, timeout)
    except ProviderError as exc:
        raise ModelError(str(exc)) from exc


async def _lines(response: httpx.Response) -> AsyncIterator[Dict[str, Any]]:
    async for line in response.aiter_lines():
        if not line.startswith("data:"):
            continue
        payload = line[5:].strip()
        if not payload or payload == "[DONE]":
            continue
        try:
            chunk = json.loads(payload)
        except ValueError:
            continue
        if isinstance(chunk, dict):
            yield chunk


def _merge_tool_call(calls: Dict[int, Dict[str, Any]], delta: Dict[str, Any]) -> None:
    index = int(delta.get("index") or 0)
    call = calls.setdefault(
        index, {"id": "", "type": "function", "function": {"name": "", "arguments": ""}}
    )
    if delta.get("id"):
        call["id"] = delta["id"]
    function = delta.get("function") or {}
    if function.get("name"):
        call["function"]["name"] = function["name"]
    if function.get("arguments"):
        call["function"]["arguments"] += function["arguments"]


async def stream_reply(
    connection: Connection,
    messages: List[Dict[str, Any]],
    tools: List[Dict[str, Any]],
    on_text: Callable[[str], Awaitable[None]],
    client: Optional[httpx.AsyncClient] = None,
) -> Reply:
    """Ask the model for its next message; ``on_text`` gets each piece of text as it arrives."""
    config = connection.as_config(REQUEST_TIMEOUT_SECONDS)
    url = config.endpoint.rstrip("/") + "/chat/completions"
    _check_address(url)
    body: Dict[str, Any] = {
        "model": connection.model,
        "messages": messages,
        "stream": True,
    }
    if tools:
        body["tools"] = tools
        body["tool_choice"] = "auto"

    owned = client is None
    client = client or _client(config, REQUEST_TIMEOUT_SECONDS)
    reply = Reply()
    calls: Dict[int, Dict[str, Any]] = {}
    try:
        async with client.stream(
            "POST", url, json=body, headers=_headers(connection, config.api_key)
        ) as response:
            if response.status_code >= 400:
                raise ModelError(
                    _explain(
                        response.status_code,
                        (await response.aread()).decode("utf-8", "replace"),
                    )
                )
            async for chunk in _lines(response):
                if chunk.get("error"):
                    raise ModelError(_explain(200, json.dumps(chunk)))
                for choice in chunk.get("choices") or []:
                    delta = choice.get("delta") or {}
                    piece = delta.get("content")
                    if isinstance(piece, str) and piece:
                        reply.text += piece
                        await on_text(piece)
                    for tool_delta in delta.get("tool_calls") or []:
                        _merge_tool_call(calls, tool_delta)
                    if choice.get("finish_reason"):
                        reply.finish_reason = str(choice["finish_reason"])
    except httpx.HTTPError as exc:
        raise ModelError(
            f"Could not reach the model service: {type(exc).__name__}: {exc}"
        ) from exc
    finally:
        if owned:
            await client.aclose()

    for index in sorted(calls):
        call = calls[index]
        if not call["function"]["name"]:
            continue
        call["id"] = call["id"] or f"call_{uuid.uuid4().hex[:12]}"
        reply.tool_calls.append(call)
    return reply


async def list_models(connection: Connection) -> List[str]:
    """The model names the service offers (for the settings panel's picker)."""
    config = connection.as_config(30.0)
    url = config.endpoint.rstrip("/") + "/models"
    _check_address(url)
    async with _client(config, 30.0) as client:
        try:
            response = await client.get(
                url, headers=_headers(connection, config.api_key)
            )
        except httpx.HTTPError as exc:
            raise ModelError(
                f"Could not reach the model service: {type(exc).__name__}: {exc}"
            ) from exc
    if response.status_code >= 400:
        raise ModelError(_explain(response.status_code, response.text))
    try:
        rows = response.json().get("data") or []
    except (ValueError, AttributeError) as exc:
        raise ModelError(
            "The address did not answer with a model list. Check the address (it usually ends in /v1)."
        ) from exc
    return sorted(
        str(row.get("id")) for row in rows if isinstance(row, dict) and row.get("id")
    )
