"""Queue a prompt on the user's ComfyUI (``POST {address}/prompt``).

The browser page cannot call ComfyUI itself (another origin), so the backend
does it. The address comes from Settings; it must be an http(s) URL, and a
redirect is reported, never followed (it could point at another host).
"""

from __future__ import annotations

import ipaddress
import re
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
# A node error line is a sentence; the rest of a long answer is not for the user.
ERROR_LINE_MAX_CHARS = 300


@dataclass
class ComfyUIError(Exception):
    """A ComfyUI call that did not queue; ``message`` is shown to the user."""

    code: str
    message: str
    status_code: int = 502
    details: List[str] = field(default_factory=list)
    # Values for the page's own sentence for ``code`` (address, reason ...).
    params: Dict[str, Any] = field(default_factory=dict)

    def __str__(self) -> str:
        return self.message


class ComfyUIAddressError(ValueError):
    """An unusable ComfyUI address; ``code`` names the problem for the page."""

    def __init__(self, message: str, code: str) -> None:
        super().__init__(message)
        self.code = code


# One dot-separated part of a computer name: letters, digits, - and _ (Docker
# service names use _), not starting or ending with -.
_HOST_LABEL_RE = re.compile(r"^(?!-)[A-Za-z0-9_-]{1,63}(?<!-)$")
# What a path behind a reverse proxy may hold unescaped; quotes, < > and
# backslashes are typos, not addresses.
_PATH_RE = re.compile(r"^[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$")
_PORT_MESSAGE = "The port in the ComfyUI address is not a number from 1 to 65535."


def _valid_host(host: str) -> bool:
    """localhost, an IPv4/IPv6 address, or a computer name."""
    try:
        ipaddress.ip_address(host)
        return True
    except ValueError:
        pass
    labels = host.rstrip(".").split(".")
    if len(host) > 253 or not all(_HOST_LABEL_RE.match(label) for label in labels):
        return False
    # Only digits but not an IPv4 address (999.1.1.1, 1.2.3) is a typo.
    return not all(label.isdigit() for label in labels)


def _checked_port(parts: Any) -> None:
    try:
        port = parts.port
    except ValueError as exc:
        raise ComfyUIAddressError(_PORT_MESSAGE, "comfyui_address_port") from exc
    if port == 0:
        raise ComfyUIAddressError(_PORT_MESSAGE, "comfyui_address_port")


def normalize_comfyui_url(raw: Any) -> str:
    """``127.0.0.1:8188/`` -> ``http://127.0.0.1:8188``; ComfyUIAddressError when unusable."""
    text = str(raw or "").strip()
    if not text:
        return DEFAULT_COMFYUI_URL
    if any(char.isspace() for char in text):
        raise ComfyUIAddressError(
            "The ComfyUI address cannot contain spaces.", "comfyui_address_spaces"
        )
    if "://" not in text:
        text = f"http://{text}"
    parts = urlsplit(text)
    if parts.scheme.lower() not in ("http", "https"):
        raise ComfyUIAddressError(
            "The ComfyUI address must start with http:// or https://.",
            "comfyui_address_scheme",
        )
    if not parts.hostname:
        raise ComfyUIAddressError(
            "The ComfyUI address needs a host, for example http://127.0.0.1:8188.",
            "comfyui_address_no_host",
        )
    if parts.username or parts.password or parts.query or parts.fragment:
        raise ComfyUIAddressError(
            "Write the ComfyUI address without a user name, ? or #.",
            "comfyui_address_extras",
        )
    if not _valid_host(parts.hostname):
        raise ComfyUIAddressError(
            "The host in the ComfyUI address is not valid: use localhost, an IP "
            "address such as 127.0.0.1, or a computer name.",
            "comfyui_address_host",
        )
    _checked_port(parts)
    if not _PATH_RE.match(parts.path):
        raise ComfyUIAddressError(
            "The path in the ComfyUI address has characters an address cannot hold.",
            "comfyui_address_path",
        )
    return f"{parts.scheme.lower()}://{parts.netloc}{parts.path.rstrip('/')}"


def configured_comfyui_url() -> str:
    """The address from Settings, or the default when none is set."""
    return normalize_comfyui_url(config.get_comfyui_url_setting())


def _clip(value: Any) -> str:
    text = " ".join(str(value or "").split())
    if len(text) > ERROR_LINE_MAX_CHARS:
        return text[: ERROR_LINE_MAX_CHARS - 3] + "..."
    return text


def _node_error_lines(payload: Dict[str, Any]) -> List[str]:
    lines: List[str] = []
    node_errors = payload.get("node_errors")
    if not isinstance(node_errors, dict):
        return lines
    for node_id, info in node_errors.items():
        if not isinstance(info, dict):
            continue
        node_type = _clip(info.get("class_type") or "node")
        for error in info.get("errors") or []:
            if isinstance(error, dict):
                detail = error.get("details") or error.get("message") or ""
                lines.append(f"{node_type} #{_clip(node_id)}: {_clip(detail)}".strip())
    return lines


def _rejected(response: httpx.Response, base_url: str) -> ComfyUIError:
    try:
        payload = response.json()
    except ValueError:
        payload = {}
    payload = payload if isinstance(payload, dict) else {}
    error = payload.get("error")
    # Only ComfyUI's own error message and node errors reach the user, never a
    # raw body (an address pointed at another program would echo its page).
    reason = _clip(error.get("message") if isinstance(error, dict) else None)
    reason = reason or f"HTTP {response.status_code}"
    return ComfyUIError(
        code="comfyui_rejected",
        message=f"ComfyUI at {base_url} did not queue this recipe: {reason}",
        status_code=422,
        details=_node_error_lines(payload),
        params={"address": base_url, "reason": reason},
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
                code="comfyui_timeout",
                message=f"ComfyUI at {base_url} did not answer in time. It may be busy; try again.",
                status_code=504,
                params={"address": base_url},
            ) from exc
        except httpx.HTTPError as exc:
            raise ComfyUIError(
                code="comfyui_unreachable",
                message=f"ComfyUI is not reachable at {base_url}. Start ComfyUI, or check the address in Settings.",
                status_code=502,
                params={"address": base_url},
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
            code="comfyui_redirect",
            message=(
                f"ComfyUI at {base_url} sent this request on to {location}; it was not followed. "
                "Check the address in Settings."
            ),
            params={"address": base_url, "location": location},
        )
    if response.status_code >= 400:
        raise _rejected(response, base_url)
    try:
        payload = response.json()
    except ValueError:
        payload = None
    if not isinstance(payload, dict) or not payload.get("prompt_id"):
        raise ComfyUIError(
            code="comfyui_bad_answer",
            message=f"The program at {base_url} answered, but not like ComfyUI. Check the address in Settings.",
            params={"address": base_url},
        )
    return {"prompt_id": str(payload["prompt_id"]), "number": payload.get("number")}
