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

# How long to wait for the next piece of an answer. A model on this computer may
# first have to load (minutes for a large one); Stop ends the wait at any time.
REQUEST_TIMEOUT_SECONDS = 600.0
CONNECT_TIMEOUT_SECONDS = 20.0
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
        client = make_async_client(config, timeout)
    except ProviderError as exc:
        raise ModelError(str(exc)) from exc
    # A wrong address fails fast; a slow answer is waited for.
    client.timeout = httpx.Timeout(timeout, connect=CONNECT_TIMEOUT_SECONDS)
    return client


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


def _transport_error(exc: httpx.HTTPError) -> ModelError:
    """A connection problem in words the user can act on."""
    if isinstance(exc, httpx.ReadTimeout):
        minutes = int(REQUEST_TIMEOUT_SECONDS // 60)
        return ModelError(
            f"The model did not answer within {minutes} minutes. A model on this computer may still be "
            "loading or may be too large for it: try again, or choose a smaller model."
        )
    if isinstance(exc, httpx.ConnectError):
        return ModelError(
            "Could not connect to the model service. Check the address, and that the model server is running."
        )
    return ModelError(f"Could not reach the model service: {type(exc).__name__}: {exc}")


# --- Ollama -----------------------------------------------------------------
#
# Ollama's OpenAI-style endpoint cannot be told how much context to load, and
# takes the server's default. On the PC this was built on that default was
# 131,072 tokens: an 8B model took 26 GB, spilled out of the graphics card and
# needed more than ten minutes for one answer. Asked through Ollama's own
# /api/chat with the context below, the same model takes 6.5 GB and answers a
# tool call in seconds. So an Ollama server is recognised (it answers
# /api/version) and spoken to in its own format.
OLLAMA_CONTEXT_TOKENS = 16384
_OLLAMA_PROBE_SECONDS = 3.0
_ollama_servers: Dict[str, bool] = {}


def _ollama_root(endpoint: str) -> str:
    root = endpoint.rstrip("/")
    return root[: -len("/v1")] if root.endswith("/v1") else root


async def _is_ollama(config: Any) -> bool:
    root = _ollama_root(config.endpoint)
    if root in _ollama_servers:
        return _ollama_servers[root]
    found = False
    try:
        _check_address(root)
        async with _client(config, _OLLAMA_PROBE_SECONDS) as probe:
            response = await probe.get(root + "/api/version")
        found = response.status_code == 200 and "version" in response.json()
    except (httpx.HTTPError, ModelError, ValueError, AttributeError):
        found = False
    _ollama_servers[root] = found
    return found


def to_ollama_messages(messages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """The conversation in Ollama's shape: tool arguments as objects, results named by tool."""
    names: Dict[str, str] = {}
    converted: List[Dict[str, Any]] = []
    for message in messages:
        role = message.get("role")
        if role == "assistant":
            calls = []
            for call in message.get("tool_calls") or []:
                function = call.get("function") or {}
                names[str(call.get("id"))] = str(function.get("name") or "")
                try:
                    arguments = json.loads(function.get("arguments") or "{}")
                except ValueError:
                    arguments = {}
                calls.append(
                    {"function": {"name": function.get("name"), "arguments": arguments}}
                )
            entry: Dict[str, Any] = {
                "role": "assistant",
                "content": message.get("content") or "",
            }
            if calls:
                entry["tool_calls"] = calls
            converted.append(entry)
        elif role == "tool":
            converted.append(
                {
                    "role": "tool",
                    "content": str(message.get("content") or ""),
                    "tool_name": names.get(str(message.get("tool_call_id")), ""),
                }
            )
        else:
            converted.append(
                {"role": role, "content": str(message.get("content") or "")}
            )
    return converted


async def _stream_ollama(
    connection: Connection,
    config: Any,
    messages: List[Dict[str, Any]],
    tools: List[Dict[str, Any]],
    on_text: Callable[[str], Awaitable[None]],
    client: Optional[httpx.AsyncClient] = None,
) -> Reply:
    url = _ollama_root(config.endpoint) + "/api/chat"
    body: Dict[str, Any] = {
        "model": connection.model,
        "messages": to_ollama_messages(messages),
        "stream": True,
        "options": {"num_ctx": OLLAMA_CONTEXT_TOKENS},
    }
    if tools:
        body["tools"] = tools
    owned = client is None
    client = client or _client(config, REQUEST_TIMEOUT_SECONDS)
    reply = Reply()
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
            async for line in response.aiter_lines():
                if not line.strip():
                    continue
                try:
                    chunk = json.loads(line)
                except ValueError:
                    continue
                if chunk.get("error"):
                    raise ModelError(
                        f"The model service answered: {str(chunk['error'])[:ERROR_BODY_CHARS]}"
                    )
                message = chunk.get("message") or {}
                # The model's private reasoning ("thinking") is not shown or kept.
                piece = message.get("content")
                if isinstance(piece, str) and piece:
                    reply.text += piece
                    await on_text(piece)
                for call in message.get("tool_calls") or []:
                    function = call.get("function") or {}
                    if not function.get("name"):
                        continue
                    arguments = function.get("arguments")
                    reply.tool_calls.append(
                        {
                            "id": str(
                                call.get("id") or f"call_{uuid.uuid4().hex[:12]}"
                            ),
                            "type": "function",
                            "function": {
                                "name": str(function["name"]),
                                "arguments": arguments
                                if isinstance(arguments, str)
                                else json.dumps(arguments or {}, ensure_ascii=False),
                            },
                        }
                    )
                if chunk.get("done"):
                    reply.finish_reason = str(chunk.get("done_reason") or "stop")
    except httpx.HTTPError as exc:
        raise _transport_error(exc) from exc
    finally:
        if owned:
            await client.aclose()
    return reply


async def stream_reply(
    connection: Connection,
    messages: List[Dict[str, Any]],
    tools: List[Dict[str, Any]],
    on_text: Callable[[str], Awaitable[None]],
    client: Optional[httpx.AsyncClient] = None,
) -> Reply:
    """Ask the model for its next message; ``on_text`` gets each piece of text as it arrives."""
    config = connection.as_config(REQUEST_TIMEOUT_SECONDS)
    if client is None and await _is_ollama(config):
        return await _stream_ollama(connection, config, messages, tools, on_text)
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
        raise _transport_error(exc) from exc
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
