"""Queue a prompt on the user's ComfyUI (``POST {address}/prompt``).

The browser page cannot call ComfyUI itself (another origin), so the backend
does it. The address comes from Settings; it must be an http(s) URL, and a
redirect is reported, never followed (it could point at another host).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional
from urllib.parse import urlsplit

import httpx

import config

DEFAULT_COMFYUI_URL = "http://127.0.0.1:8188"
CLIENT_ID = "sd-image-sorter"
# Queueing returns at once; a slow answer means a busy or stuck ComfyUI.
CONNECT_TIMEOUT_SECONDS = 5.0
ANSWER_TIMEOUT_SECONDS = 60.0


@dataclass
class ComfyUIError(Exception):
    """A ComfyUI call that did not queue; ``message`` is shown to the user."""

    code: str
    message: str
    status_code: int = 502
    details: List[str] = field(default_factory=list)

    def __str__(self) -> str:
        return self.message


def normalize_comfyui_url(raw: Any) -> str:
    """``127.0.0.1:8188/`` -> ``http://127.0.0.1:8188``; raises ValueError when unusable."""
    text = str(raw or "").strip()
    if not text:
        return DEFAULT_COMFYUI_URL
    if "://" not in text:
        text = f"http://{text}"
    parts = urlsplit(text)
    if parts.scheme.lower() not in ("http", "https"):
        raise ValueError("The ComfyUI address must start with http:// or https://.")
    if not parts.hostname:
        raise ValueError(
            "The ComfyUI address needs a host, for example http://127.0.0.1:8188."
        )
    if parts.username or parts.password or parts.query or parts.fragment:
        raise ValueError("Write the ComfyUI address without a user name, ? or #.")
    try:
        parts.port
    except ValueError as exc:
        raise ValueError(
            "The port in the ComfyUI address is not a number from 1 to 65535."
        ) from exc
    return f"{parts.scheme.lower()}://{parts.netloc}{parts.path.rstrip('/')}"


def configured_comfyui_url() -> str:
    """The address from Settings, or the default when none is set."""
    return normalize_comfyui_url(config.get_comfyui_url_setting())


def _node_error_lines(payload: Dict[str, Any]) -> List[str]:
    lines: List[str] = []
    node_errors = payload.get("node_errors")
    if not isinstance(node_errors, dict):
        return lines
    for node_id, info in node_errors.items():
        if not isinstance(info, dict):
            continue
        node_type = info.get("class_type") or "node"
        for error in info.get("errors") or []:
            if isinstance(error, dict):
                detail = error.get("details") or error.get("message") or ""
                lines.append(f"{node_type} #{node_id}: {detail}".strip())
    return lines


def _rejected(response: httpx.Response, base_url: str) -> ComfyUIError:
    try:
        payload = response.json()
    except ValueError:
        payload = {}
    payload = payload if isinstance(payload, dict) else {}
    error = payload.get("error")
    reason = error.get("message") if isinstance(error, dict) else None
    reason = reason or response.text.strip()[:500] or f"HTTP {response.status_code}"
    return ComfyUIError(
        code="rejected",
        message=f"ComfyUI at {base_url} did not queue this recipe: {reason}",
        status_code=422,
        details=_node_error_lines(payload),
    )


def _post_prompt(base_url: str, body: Dict[str, Any]) -> httpx.Response:
    timeout = httpx.Timeout(ANSWER_TIMEOUT_SECONDS, connect=CONNECT_TIMEOUT_SECONDS)
    # trust_env=False: a system proxy must not carry a local ComfyUI call.
    with httpx.Client(
        timeout=timeout, follow_redirects=False, trust_env=False
    ) as client:
        try:
            return client.post(f"{base_url}/prompt", json=body)
        except httpx.TimeoutException as exc:
            raise ComfyUIError(
                code="timeout",
                message=f"ComfyUI at {base_url} did not answer in time. It may be busy; try again.",
                status_code=504,
            ) from exc
        except httpx.HTTPError as exc:
            raise ComfyUIError(
                code="unreachable",
                message=f"ComfyUI is not reachable at {base_url}. Start ComfyUI, or check the address in Settings.",
                status_code=502,
            ) from exc


def queue_prompt(
    base_url: str,
    api_prompt: Dict[str, Any],
    workflow: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Queue ``api_prompt``; the workflow rides along so the new picture embeds it."""
    body: Dict[str, Any] = {"prompt": api_prompt, "client_id": CLIENT_ID}
    if workflow:
        body["extra_data"] = {"extra_pnginfo": {"workflow": workflow}}
    response = _post_prompt(base_url, body)
    if response.is_redirect:
        location = response.headers.get("location", "another address")
        raise ComfyUIError(
            code="redirect",
            message=(
                f"ComfyUI at {base_url} sent this request on to {location}; it was not followed. "
                "Check the address in Settings."
            ),
        )
    if response.status_code >= 400:
        raise _rejected(response, base_url)
    try:
        payload = response.json()
    except ValueError:
        payload = None
    if not isinstance(payload, dict) or not payload.get("prompt_id"):
        raise ComfyUIError(
            code="bad_answer",
            message=f"The program at {base_url} answered, but not like ComfyUI. Check the address in Settings.",
        )
    return {"prompt_id": str(payload["prompt_id"]), "number": payload.get("number")}
