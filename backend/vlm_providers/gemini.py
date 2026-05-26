"""Google Gemini / Vertex AI VLM provider.

Supports two modes:
- Public Gemini API (https://generativelanguage.googleapis.com/) using API key.
- Vertex AI (https://{region}-aiplatform.googleapis.com/) using service account JSON for OAuth2 token.

When use_vertex=True, requires google-auth library. Falls back gracefully with helpful error.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from typing import Any, Dict, List, Optional, Tuple

import httpx

from vlm_providers.base import (
    ProviderError,
    VLMConfig,
    VLMProvider,
    VLMResult,
    encode_image_base64,
    make_async_client,
)

logger = logging.getLogger(__name__)


# Cache: (service_account_json_hash) -> (token, expiry_epoch)
_VERTEX_TOKEN_CACHE: Dict[str, Tuple[str, float]] = {}


def _hash_sa(sa_content: str) -> str:
    """Stable cache key for a service account credential string."""
    import hashlib
    return hashlib.sha256(sa_content.encode("utf-8", errors="ignore")).hexdigest()[:16]


def _resolve_service_account(sa_input: str) -> Optional[Dict[str, Any]]:
    """Resolve service_account_json field: may be raw JSON or a file path."""
    if not sa_input:
        return None
    sa_input = sa_input.strip()
    # If looks like JSON object, parse directly
    if sa_input.startswith("{"):
        try:
            return json.loads(sa_input)
        except json.JSONDecodeError:
            return None
    # Otherwise treat as file path
    try:
        if os.path.isfile(sa_input):
            with open(sa_input, "r", encoding="utf-8") as f:
                return json.load(f)
    except (OSError, json.JSONDecodeError):
        return None
    return None


async def _get_vertex_access_token(config: VLMConfig) -> str:
    """Mint a Vertex AI access token using the service account.

    Caches tokens for ~50 minutes (default JWT lifetime is 1 hour).
    Raises ProviderError on auth failure.
    """
    sa_data = _resolve_service_account(config.service_account_json)
    if not sa_data:
        raise ProviderError(
            "Vertex AI requires service_account_json (JSON content or file path)",
            error_type="auth",
            retryable=False,
        )

    cache_key = _hash_sa(config.service_account_json)
    cached = _VERTEX_TOKEN_CACHE.get(cache_key)
    if cached and cached[1] > time.time() + 60:
        return cached[0]

    try:
        # Lazy import — only required for Vertex
        from google.oauth2 import service_account  # type: ignore[import-untyped]
        from google.auth.transport.requests import Request  # type: ignore[import-untyped]
    except ImportError:
        raise ProviderError(
            "Vertex AI requires 'google-auth' package. Install with: pip install google-auth",
            error_type="missing_dependency",
            retryable=False,
        )

    try:
        credentials = service_account.Credentials.from_service_account_info(
            sa_data,
            scopes=["https://www.googleapis.com/auth/cloud-platform"],
        )
        # Refresh in a thread to avoid blocking the event loop
        loop = asyncio.get_event_loop()
        await loop.run_in_executor(None, credentials.refresh, Request())
        token = credentials.token
        expiry = credentials.expiry.timestamp() if credentials.expiry else (time.time() + 3000)
        _VERTEX_TOKEN_CACHE[cache_key] = (token, expiry)
        return token
    except Exception as e:
        raise ProviderError(f"Vertex auth failed: {e}", error_type="auth", retryable=False)


class GeminiProvider(VLMProvider):
    """Provider for Google Gemini / Vertex AI."""

    name = "gemini"

    async def caption_image(
        self,
        image_path: str,
        *,
        tags: Optional[List[str]] = None,
    ) -> VLMResult:
        image_b64 = encode_image_base64(image_path, self.config.max_image_size)
        user_message = self.build_user_message(tags)

        last_error = None
        retries = 0

        for attempt in range(self.config.max_retries + 1):
            try:
                result = await self._request(image_b64, user_message)
                raw_text = result.get("caption", "").strip()
                tokens = result.get("tokens", 0)

                if not raw_text:
                    retries += 1
                    if attempt < self.config.max_retries:
                        await asyncio.sleep(self.config.retry_delay_seconds)
                        continue
                    return VLMResult(
                        error="Empty response",
                        error_type="empty_response",
                        retries_used=retries,
                        model=self.config.model,
                    )

                parsed = self.parse_output(raw_text)
                parsed.tokens_used = tokens
                parsed.retries_used = retries
                parsed.model = self.config.model
                return parsed

            except ProviderError as e:
                last_error = e
                retries += 1
                if not e.retryable or attempt >= self.config.max_retries:
                    break
                await asyncio.sleep(self.config.retry_delay_seconds * (attempt + 1))

        return VLMResult(
            error=str(last_error) if last_error else "Unknown error",
            error_type=last_error.error_type if last_error else "unknown",
            retries_used=retries,
            model=self.config.model,
        )

    async def _request(self, image_b64: str, user_message: str) -> Dict[str, Any]:
        if self.config.use_vertex:
            return await self._vertex_request(image_b64, user_message)
        return await self._public_request(image_b64, user_message)

    async def generate_text(
        self,
        prompt: str,
        *,
        system_prompt: str = "",
        max_tokens: int = 2048,
        temperature: float = 0.1,
    ) -> VLMResult:
        try:
            if self.config.use_vertex:
                result = await self._vertex_text_request(
                    str(prompt or ""),
                    system_prompt=system_prompt,
                    max_tokens=max_tokens,
                    temperature=temperature,
                )
            else:
                result = await self._public_text_request(
                    str(prompt or ""),
                    system_prompt=system_prompt,
                    max_tokens=max_tokens,
                    temperature=temperature,
                )
            raw_text = result.get("caption", "").strip()
            if not raw_text:
                return VLMResult(error="Provider returned an empty text response", error_type="empty_response", model=self.config.model)
            return VLMResult(
                caption=raw_text,
                tokens_used=int(result.get("tokens", 0) or 0),
                model=self.config.model,
                raw_text=raw_text,
            )
        except ProviderError as e:
            return VLMResult(error=str(e), error_type=e.error_type, model=self.config.model)

    async def _public_request(self, image_b64: str, user_message: str) -> Dict[str, Any]:
        """Public Gemini API (generativelanguage.googleapis.com)."""
        model = self.config.model or "gemini-2.0-flash"
        endpoint = self.config.endpoint.rstrip("/") or "https://generativelanguage.googleapis.com"
        url = f"{endpoint}/v1beta/models/{model}:generateContent?key={self.config.api_key}"
        return await self._do_request(url, image_b64, user_message, headers={})

    async def _public_text_request(
        self,
        user_message: str,
        *,
        system_prompt: str,
        max_tokens: int,
        temperature: float,
    ) -> Dict[str, Any]:
        model = self.config.model or "gemini-2.0-flash"
        endpoint = self.config.endpoint.rstrip("/") or "https://generativelanguage.googleapis.com"
        url = f"{endpoint}/v1beta/models/{model}:generateContent?key={self.config.api_key}"
        return await self._do_request(
            url,
            None,
            user_message,
            headers={},
            system_prompt=system_prompt,
            max_tokens=max_tokens,
            temperature=temperature,
        )

    async def _vertex_request(self, image_b64: str, user_message: str) -> Dict[str, Any]:
        """Vertex AI Gemini endpoint with OAuth bearer token."""
        if not self.config.vertex_project:
            raise ProviderError("Vertex requires vertex_project", error_type="config", retryable=False)
        model = self.config.model or "gemini-2.0-flash-001"
        location = self.config.vertex_location or "us-central1"
        endpoint = self.config.endpoint.rstrip("/") or f"https://{location}-aiplatform.googleapis.com"
        url = (
            f"{endpoint}/v1/projects/{self.config.vertex_project}"
            f"/locations/{location}/publishers/google/models/{model}:generateContent"
        )
        token = await _get_vertex_access_token(self.config)
        headers = {"Authorization": f"Bearer {token}"}
        return await self._do_request(url, image_b64, user_message, headers=headers)

    async def _vertex_text_request(
        self,
        user_message: str,
        *,
        system_prompt: str,
        max_tokens: int,
        temperature: float,
    ) -> Dict[str, Any]:
        if not self.config.vertex_project:
            raise ProviderError("Vertex requires vertex_project", error_type="config", retryable=False)
        model = self.config.model or "gemini-2.0-flash-001"
        location = self.config.vertex_location or "us-central1"
        endpoint = self.config.endpoint.rstrip("/") or f"https://{location}-aiplatform.googleapis.com"
        url = (
            f"{endpoint}/v1/projects/{self.config.vertex_project}"
            f"/locations/{location}/publishers/google/models/{model}:generateContent"
        )
        token = await _get_vertex_access_token(self.config)
        headers = {"Authorization": f"Bearer {token}"}
        return await self._do_request(
            url,
            None,
            user_message,
            headers=headers,
            system_prompt=system_prompt,
            max_tokens=max_tokens,
            temperature=temperature,
        )

    async def _do_request(
        self,
        url: str,
        image_b64: Optional[str],
        user_message: str,
        *,
        headers: Dict[str, str],
        system_prompt: Optional[str] = None,
        max_tokens: int = 1024,
        temperature: float = 0.3,
    ) -> Dict[str, Any]:
        parts: List[Dict[str, Any]] = []
        if image_b64:
            parts.append({"inline_data": {"mime_type": "image/jpeg", "data": image_b64}})
        parts.append({"text": user_message})
        payload: Dict[str, Any] = {
            "contents": [{"parts": parts}],
            "generationConfig": {"maxOutputTokens": max_tokens, "temperature": temperature},
        }
        effective_system_prompt = self.config.system_prompt if system_prompt is None else system_prompt
        if effective_system_prompt:
            payload["systemInstruction"] = {"parts": [{"text": effective_system_prompt}]}

        send_headers = {"Content-Type": "application/json", **headers}

        async with make_async_client(self.config) as client:
            try:
                resp = await client.post(url, json=payload, headers=send_headers)
            except httpx.TimeoutException:
                raise ProviderError("Request timed out", error_type="timeout", retryable=True)
            except httpx.ConnectError as e:
                raise ProviderError(f"Connection failed: {e}", error_type="connection", retryable=True)
            except httpx.RequestError as e:
                raise ProviderError(f"Request error: {e}", error_type="network", retryable=True)

        if resp.status_code == 429:
            raise ProviderError("Rate limited", error_type="rate_limit", retryable=True)
        if resp.status_code >= 500:
            raise ProviderError(f"Server error {resp.status_code}", error_type="server_error", retryable=True)
        if resp.status_code == 401 or resp.status_code == 403:
            raise ProviderError(f"Auth failed: {resp.text[:300]}", error_type="auth", retryable=False)
        if resp.status_code != 200:
            raise ProviderError(f"HTTP {resp.status_code}: {resp.text[:300]}", error_type=f"http_{resp.status_code}", retryable=False)

        data = resp.json()
        caption = ""
        candidates = data.get("candidates") or []
        if candidates:
            content = candidates[0].get("content") or {}
            for part in content.get("parts") or []:
                if "text" in part:
                    caption += part["text"]

        usage = data.get("usageMetadata") or {}
        tokens = (usage.get("promptTokenCount") or 0) + (usage.get("candidatesTokenCount") or 0)
        return {"caption": caption, "tokens": tokens}

    async def test_connection(self) -> Dict[str, Any]:
        if self.config.use_vertex:
            return await self._test_vertex()
        return await self._test_public()

    async def _test_public(self) -> Dict[str, Any]:
        endpoint = self.config.endpoint.rstrip("/") or "https://generativelanguage.googleapis.com"
        url = f"{endpoint}/v1beta/models?key={self.config.api_key}"
        try:
            async with make_async_client(self.config, timeout=10.0) as client:
                resp = await client.get(url)
            if resp.status_code == 200:
                data = resp.json()
                models = [
                    m.get("name", "").split("/")[-1]
                    for m in data.get("models", [])
                    if "gemini" in m.get("name", "").lower()
                ]
                return {"status": "ok", "models": models}
            if resp.status_code in (400, 401, 403):
                return {"status": "error", "error": "Invalid API key", "error_type": "auth"}
            return {"status": "error", "error": f"HTTP {resp.status_code}", "error_type": "unknown"}
        except Exception as e:
            return {"status": "error", "error": str(e), "error_type": "connection"}

    async def _test_vertex(self) -> Dict[str, Any]:
        try:
            await _get_vertex_access_token(self.config)
        except ProviderError as e:
            return {"status": "error", "error": str(e), "error_type": e.error_type}
        # Try to list models in the project
        try:
            location = self.config.vertex_location or "us-central1"
            endpoint = self.config.endpoint.rstrip("/") or f"https://{location}-aiplatform.googleapis.com"
            token = await _get_vertex_access_token(self.config)
            url = f"{endpoint}/v1/publishers/google/models"
            async with make_async_client(self.config, timeout=10.0) as client:
                resp = await client.get(url, headers={"Authorization": f"Bearer {token}"})
            if resp.status_code == 200:
                data = resp.json()
                models = [
                    m.get("name", "").split("/")[-1]
                    for m in data.get("publisherModels", [])
                    if "gemini" in m.get("name", "").lower()
                ]
                return {"status": "ok", "models": models, "note": "Vertex AI"}
            return {"status": "ok", "models": [], "note": f"Vertex auth OK, model list HTTP {resp.status_code}"}
        except Exception as e:
            return {"status": "error", "error": str(e), "error_type": "connection"}

    async def list_models(self) -> List[str]:
        result = await self.test_connection()
        return result.get("models", [])
