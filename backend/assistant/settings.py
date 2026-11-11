"""Which chat model the assistant talks to, and how much it may do.

The assistant has its own endpoint, key and model. It may instead use the AI
caption service the user already set up (as long as that one speaks the OpenAI
chat format), but only after the user said so on the setup screen, which shows
what is sent: having a caption service is not consent to send it conversations.
The network proxy of the caption service is reused either way.

The file lives in the config folder beside the other settings and holds the
key the same way the caption service does. The key never leaves through the
settings endpoint (only its first characters are shown), and it is dropped
when the address moves to another host, so a key is never sent to a service it
was not entered for.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Dict, Optional
from urllib.parse import urlsplit

import config
from vlm_providers.base import VLMConfig, _redact_url

ACCESS_ASK = "ask"  # reads run; every change waits for a confirmation
ACCESS_READ_ONLY = "read_only"  # the change tools are not offered at all
ACCESS_AUTO = "auto"  # changes run without asking (no tool deletes or moves files)
ACCESS_MODES = (ACCESS_ASK, ACCESS_READ_ONLY, ACCESS_AUTO)

DEFAULT_MAX_ROUNDS = 12
MAX_EXTRA_INSTRUCTIONS = 4000

_FILE_NAME = "assistant.json"


@dataclass(frozen=True)
class Connection:
    """A resolved model service: where the requests go."""

    endpoint: str
    api_key: str
    model: str
    source: str  # "own" | "caption_service"
    http_proxy: str = ""
    https_proxy: str = ""
    socks_proxy: str = ""

    def as_config(self, timeout_seconds: float = 120.0) -> VLMConfig:
        """The shape the shared HTTP client helpers take (proxy, key safety)."""
        return VLMConfig(
            provider="openai_compat",
            endpoint=self.endpoint,
            api_key=self.api_key,
            model=self.model,
            timeout_seconds=timeout_seconds,
            http_proxy=self.http_proxy,
            https_proxy=self.https_proxy,
            socks_proxy=self.socks_proxy,
        )


def _path():
    return config.CONFIG_DIR / _FILE_NAME


def load() -> Dict[str, Any]:
    path = _path()
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def _normalize(endpoint: str) -> str:
    from routers.vlm_debug import _normalize_openai_endpoint

    return _normalize_openai_endpoint(endpoint or "")


def _host(endpoint: str) -> str:
    try:
        return (urlsplit(_normalize(endpoint)).hostname or "").lower()
    except ValueError:
        return ""


def save(changes: Dict[str, Any]) -> Dict[str, Any]:
    """Merge ``changes`` into the stored settings (None leaves a value as it is).

    ``clear_api_key`` removes the stored key. A key is also removed when the
    address moves to another host and no new key comes with it.
    """
    current = load()
    old_host = _host(str(current.get("endpoint") or ""))
    for key in ("endpoint", "api_key", "model"):
        if changes.get(key) is not None:
            current[key] = str(changes[key]).strip()
    if changes.get("access") is not None:
        current["access"] = (
            changes["access"] if changes["access"] in ACCESS_MODES else ACCESS_ASK
        )
    if changes.get("extra_instructions") is not None:
        current["extra_instructions"] = str(changes["extra_instructions"])[
            :MAX_EXTRA_INSTRUCTIONS
        ]
    if changes.get("use_caption_service") is not None:
        current["use_caption_service"] = bool(changes["use_caption_service"])
    moved = _host(str(current.get("endpoint") or "")) != old_host
    if changes.get("clear_api_key") or (moved and not changes.get("api_key")):
        current["api_key"] = ""
    config.CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    _path().write_text(
        json.dumps(current, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    return current


def access_mode(stored: Optional[Dict[str, Any]] = None) -> str:
    value = (stored if stored is not None else load()).get("access")
    return value if value in ACCESS_MODES else ACCESS_ASK


def _caption_service() -> Dict[str, Any]:
    """The AI caption service settings (the file its own router keeps)."""
    try:
        data = json.loads(
            (config.CONFIG_DIR / "vlm-settings.json").read_text(encoding="utf-8")
        )
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def caption_service_offer() -> Optional[Dict[str, str]]:
    """The caption service, when the assistant could use it (chat format, has a model)."""
    service = _caption_service()
    if (service.get("provider") or "openai_compat") != "openai_compat":
        return None
    endpoint = _normalize(str(service.get("endpoint") or ""))
    model = str(service.get("model") or "").strip()
    if not endpoint or not model:
        return None
    return {"endpoint": endpoint, "model": model}


def resolve(
    stored: Optional[Dict[str, Any]] = None, need_model: bool = True
) -> Optional[Connection]:
    """The model service to use now, or None when nothing is set up.

    ``need_model=False`` accepts an address without a model: enough to ask the
    service which models it has. The caption service is used only when the
    user chose that on the setup screen.
    """
    own = stored if stored is not None else load()
    service = _caption_service()
    proxies = {
        "http_proxy": str(service.get("http_proxy") or ""),
        "https_proxy": str(service.get("https_proxy") or ""),
        "socks_proxy": str(service.get("socks_proxy") or ""),
    }
    endpoint = _normalize(str(own.get("endpoint") or ""))
    model = str(own.get("model") or "").strip()
    if endpoint and (model or not need_model):
        return Connection(
            endpoint, str(own.get("api_key") or ""), model, "own", **proxies
        )
    offer = caption_service_offer()
    if offer is None or endpoint or not own.get("use_caption_service"):
        return None
    return Connection(
        offer["endpoint"],
        str(service.get("api_key") or ""),
        offer["model"],
        "caption_service",
        **proxies,
    )


def public_view() -> Dict[str, Any]:
    """What the settings panel shows: never the key, and addresses without credentials."""
    own = load()
    connection = resolve(own)
    key = str(own.get("api_key") or "")
    offer = caption_service_offer()
    return {
        "endpoint": _redact_url(str(own.get("endpoint") or ""))
        if own.get("endpoint")
        else "",
        "model": str(own.get("model") or ""),
        "api_key_display": (key[:6] + "***") if key else "",
        "access": access_mode(own),
        "extra_instructions": str(own.get("extra_instructions") or ""),
        "use_caption_service": bool(own.get("use_caption_service")),
        "caption_service": {
            "endpoint": _redact_url(offer["endpoint"]),
            "model": offer["model"],
        }
        if offer
        else None,
        "ready": connection is not None,
        "using": (
            {
                "source": connection.source,
                "endpoint": _redact_url(connection.endpoint),
                "model": connection.model,
            }
            if connection
            else None
        ),
    }
