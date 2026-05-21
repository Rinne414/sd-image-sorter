"""Base class and data types for VLM providers."""
from __future__ import annotations

import base64
import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

import httpx
from PIL import Image

logger = logging.getLogger(__name__)


# Output format constants
OUTPUT_FORMAT_NL = "nl_caption"
OUTPUT_FORMAT_TAGS = "danbooru_tags"
OUTPUT_FORMAT_BOTH = "both"
VALID_OUTPUT_FORMATS = {OUTPUT_FORMAT_NL, OUTPUT_FORMAT_TAGS, OUTPUT_FORMAT_BOTH}


class ProviderError(Exception):
    """Raised when a VLM provider encounters an error."""

    def __init__(self, message: str, error_type: str = "unknown", retryable: bool = False):
        super().__init__(message)
        self.error_type = error_type
        self.retryable = retryable


@dataclass
class VLMConfig:
    """Configuration for a VLM provider instance."""

    provider: str = "openai_compat"
    endpoint: str = ""
    api_key: str = ""
    model: str = ""
    max_retries: int = 3
    retry_delay_seconds: float = 2.0
    timeout_seconds: float = 60.0
    concurrent_requests: int = 2
    system_prompt: str = ""
    user_prompt: str = ""
    user_prompt_with_tags: str = ""  # Used when image already has danbooru tags
    include_tags_as_context: bool = True
    max_image_size: int = 1024
    nsfw_retry_prompt: str = ""

    # v3.2.1 additions
    output_format: str = OUTPUT_FORMAT_NL  # nl_caption | danbooru_tags | both
    http_proxy: str = ""    # HTTP proxy URL (e.g., http://proxy:8080)
    https_proxy: str = ""   # HTTPS proxy URL
    socks_proxy: str = ""   # SOCKS proxy URL (e.g., socks5://localhost:1080)
    # Vertex AI specific (only used when provider=='gemini' and using Vertex)
    use_vertex: bool = False
    vertex_project: str = ""
    vertex_location: str = "us-central1"
    service_account_json: str = ""  # JSON content or path to file

    def to_dict(self) -> Dict[str, Any]:
        return {
            "provider": self.provider,
            "endpoint": self.endpoint,
            "api_key": "***" if self.api_key else "",
            "model": self.model,
            "max_retries": self.max_retries,
            "retry_delay_seconds": self.retry_delay_seconds,
            "timeout_seconds": self.timeout_seconds,
            "concurrent_requests": self.concurrent_requests,
            "system_prompt": self.system_prompt,
            "user_prompt": self.user_prompt,
            "user_prompt_with_tags": self.user_prompt_with_tags,
            "include_tags_as_context": self.include_tags_as_context,
            "max_image_size": self.max_image_size,
            "nsfw_retry_prompt": self.nsfw_retry_prompt,
            "output_format": self.output_format,
            "http_proxy": self.http_proxy,
            "https_proxy": self.https_proxy,
            "socks_proxy": self.socks_proxy,
            "use_vertex": self.use_vertex,
            "vertex_project": self.vertex_project,
            "vertex_location": self.vertex_location,
            "service_account_json": "***" if self.service_account_json else "",
        }

    def get_proxies(self) -> Optional[Dict[str, str]]:
        """Build proxies dict for httpx based on config. Returns None if no proxies."""
        proxies: Dict[str, str] = {}
        if self.socks_proxy:
            # SOCKS proxies apply to both http and https
            proxies["http://"] = self.socks_proxy
            proxies["https://"] = self.socks_proxy
        else:
            if self.http_proxy:
                proxies["http://"] = self.http_proxy
            if self.https_proxy:
                proxies["https://"] = self.https_proxy
        return proxies or None


@dataclass
class VLMResult:
    """Result from a VLM captioning request."""

    caption: str = ""           # Natural language caption
    tags: List[str] = field(default_factory=list)  # Parsed danbooru-style tags
    tokens_used: int = 0
    error: Optional[str] = None
    error_type: Optional[str] = None
    retries_used: int = 0
    model: str = ""
    raw_text: str = ""          # Original raw output for debugging


def encode_image_base64(image_path: str, max_size: int = 1024) -> str:
    """Load and resize image, return base64-encoded JPEG."""
    with Image.open(image_path) as img:
        img = img.convert("RGB")
        w, h = img.size
        if max(w, h) > max_size:
            scale = max_size / max(w, h)
            img = img.resize(
                (int(w * scale), int(h * scale)),
                getattr(Image, "Resampling", Image).LANCZOS,
            )
        import io
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=85)
        return base64.b64encode(buf.getvalue()).decode("ascii")


def make_async_client(config: VLMConfig, timeout: Optional[float] = None) -> httpx.AsyncClient:
    """Build an httpx.AsyncClient with proxy support derived from config.

    Falls back gracefully if SOCKS support is unavailable (httpx[socks] not installed).
    """
    actual_timeout = timeout if timeout is not None else config.timeout_seconds
    proxies = config.get_proxies()
    kwargs: Dict[str, Any] = {"timeout": actual_timeout}
    if proxies:
        # httpx 0.28+ uses 'proxy' singular; older accepts 'proxies' dict.
        # Try modern API first.
        try:
            # Pick the appropriate proxy: if all schemes use the same proxy, use 'proxy'
            unique_proxies = set(proxies.values())
            if len(unique_proxies) == 1:
                kwargs["proxy"] = next(iter(unique_proxies))
            else:
                # Different proxies for http vs https - use mounts
                from httpx import AsyncHTTPTransport
                mounts = {scheme: AsyncHTTPTransport(proxy=url) for scheme, url in proxies.items()}
                kwargs["mounts"] = mounts
        except Exception as e:
            logger.warning(f"Failed to apply proxy config (will retry without): {e}")
            kwargs.pop("proxy", None)
            kwargs.pop("mounts", None)
    try:
        return httpx.AsyncClient(**kwargs)
    except (TypeError, ValueError) as e:
        # SOCKS or proxy not supported - retry without proxy
        logger.warning(f"Proxy unsupported ({e}); install 'httpx[socks]' to enable. Falling back to direct connection.")
        kwargs.pop("proxy", None)
        kwargs.pop("mounts", None)
        return httpx.AsyncClient(timeout=actual_timeout)


def detect_provider(endpoint: str) -> str:
    """Auto-detect provider type from endpoint URL pattern.

    Returns one of: 'anthropic', 'gemini', 'openai_compat'.
    Defaults to 'openai_compat' for unknown endpoints (covers Ollama, vLLM, OpenRouter, etc.).
    """
    if not endpoint:
        return "openai_compat"
    lower = endpoint.lower()
    if "anthropic.com" in lower or "/v1/messages" in lower:
        return "anthropic"
    if "googleapis.com" in lower or "generativelanguage" in lower or "aiplatform" in lower:
        return "gemini"
    return "openai_compat"


class VLMProvider:
    """Abstract base for VLM providers."""

    name: str = "base"

    def __init__(self, config: VLMConfig):
        self.config = config

    async def caption_image(
        self,
        image_path: str,
        *,
        tags: Optional[List[str]] = None,
    ) -> VLMResult:
        """Generate a natural language caption (or tags) for an image.

        Result depends on config.output_format:
        - nl_caption: VLMResult.caption populated, tags empty
        - danbooru_tags: VLMResult.tags populated, caption may be empty
        - both: both populated (parsed from hybrid output)
        """
        raise NotImplementedError

    async def test_connection(self) -> Dict[str, Any]:
        """Test if the provider is reachable. Returns status dict."""
        raise NotImplementedError

    async def list_models(self) -> List[str]:
        """Fetch available models from the provider. May return empty list."""
        return []

    def build_user_message(self, tags: Optional[List[str]] = None) -> str:
        """Build the user prompt, optionally including tags as context."""
        tag_str = ", ".join(tags) if tags else ""

        # If tags exist and we have a dedicated with-tags prompt, use it
        if tags and self.config.include_tags_as_context and self.config.user_prompt_with_tags:
            prompt = self.config.user_prompt_with_tags
            prompt = prompt.replace("{tags}", tag_str)
            return prompt.strip()

        # Fallback: use the regular user_prompt
        prompt = self.config.user_prompt
        if tags and self.config.include_tags_as_context:
            if "{tags}" in prompt:
                prompt = prompt.replace("{tags}", tag_str)
            else:
                prompt += f"\n\nThe following danbooru-style tags describe this image:\n{tag_str}"
        else:
            prompt = prompt.replace("{tags}", "")

        return prompt.strip()

    def parse_output(self, raw_text: str) -> VLMResult:
        """Parse raw VLM text output into VLMResult based on output_format.

        Supports:
        - nl_caption: returns text as caption
        - danbooru_tags: parses comma/newline-separated tags
        - both: parses <NL>...</NL><TAGS>...</TAGS> hybrid format
        """
        result = VLMResult(raw_text=raw_text)
        text = raw_text.strip()

        if self.config.output_format == OUTPUT_FORMAT_NL:
            result.caption = text
            return result

        if self.config.output_format == OUTPUT_FORMAT_TAGS:
            result.tags = _parse_tag_list(text)
            return result

        if self.config.output_format == OUTPUT_FORMAT_BOTH:
            nl_part, tags_part = _parse_hybrid_output(text)
            result.caption = nl_part
            result.tags = _parse_tag_list(tags_part) if tags_part else []
            # If parsing failed (no markers), put entire text in caption
            if not result.caption and not result.tags:
                result.caption = text
            return result

        # Unknown format - treat as caption
        result.caption = text
        return result


def _parse_tag_list(text: str) -> List[str]:
    """Parse comma- or newline-separated tag list. Drops empty/whitespace-only tags."""
    if not text:
        return []
    # Replace common delimiters with comma
    normalized = text.replace("\n", ",").replace(";", ",")
    raw_tags = [t.strip() for t in normalized.split(",")]
    # Filter empty, very short (<2 chars), or excessively long (>100 chars) tags
    return [t for t in raw_tags if t and 2 <= len(t) <= 100]


def _parse_hybrid_output(text: str) -> tuple[str, str]:
    """Parse <NL>...</NL><TAGS>...</TAGS> hybrid output.

    Returns (nl_text, tags_text). Either may be empty if not found.
    Falls back to splitting on common boundary markers if XML-style tags absent.
    """
    import re

    nl_match = re.search(r"<NL>(.*?)</NL>", text, re.DOTALL | re.IGNORECASE)
    tags_match = re.search(r"<TAGS>(.*?)</TAGS>", text, re.DOTALL | re.IGNORECASE)

    nl_text = nl_match.group(1).strip() if nl_match else ""
    tags_text = tags_match.group(1).strip() if tags_match else ""

    if nl_text or tags_text:
        return nl_text, tags_text

    # Fallback: try to split on common section markers
    # e.g., "Description: ...\nTags: ..."
    desc_match = re.search(r"(?:description|caption)[:：]\s*(.+?)(?:\n\s*tags?[:：]|\Z)", text, re.IGNORECASE | re.DOTALL)
    tag_match = re.search(r"tags?[:：]\s*(.+?)\Z", text, re.IGNORECASE | re.DOTALL)
    if desc_match or tag_match:
        return (
            desc_match.group(1).strip() if desc_match else "",
            tag_match.group(1).strip() if tag_match else "",
        )

    return "", ""
