"""Anthropic Claude VLM provider."""
from __future__ import annotations

import asyncio
import logging
from typing import Any, Dict, List, Optional

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


class AnthropicProvider(VLMProvider):
    """Provider for Anthropic Messages API (Claude Vision)."""

    name = "anthropic"

    async def caption_image(
        self,
        image_path: str,
        *,
        tags: Optional[List[str]] = None,
    ) -> VLMResult:
        image_b64 = encode_image_base64(image_path, self.config.max_image_size)
        user_message = self.build_user_message(tags)

        messages = [{
            "role": "user",
            "content": [
                {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": image_b64}},
                {"type": "text", "text": user_message},
            ],
        }]

        last_error = None
        retries = 0

        for attempt in range(self.config.max_retries + 1):
            try:
                result = await self._request(messages)
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

    async def _request(self, messages: List[Dict]) -> Dict[str, Any]:
        endpoint = self.config.endpoint.rstrip("/") or "https://api.anthropic.com"
        url = endpoint + "/v1/messages"
        headers = {
            "Content-Type": "application/json",
            "x-api-key": self.config.api_key,
            "anthropic-version": "2023-06-01",
        }

        payload: Dict[str, Any] = {
            "model": self.config.model or "claude-sonnet-4-6-20250514",
            "max_tokens": 1024,
            "messages": messages,
        }
        if self.config.system_prompt:
            payload["system"] = self.config.system_prompt

        async with make_async_client(self.config) as client:
            try:
                resp = await client.post(url, json=payload, headers=headers)
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
        if resp.status_code != 200:
            raise ProviderError(f"HTTP {resp.status_code}: {resp.text[:300]}", error_type=f"http_{resp.status_code}", retryable=False)

        data = resp.json()
        caption = ""
        for block in data.get("content", []):
            if block.get("type") == "text":
                caption += block.get("text", "")

        usage = data.get("usage") or {}
        tokens = (usage.get("input_tokens") or 0) + (usage.get("output_tokens") or 0)
        return {"caption": caption, "tokens": tokens}

    async def test_connection(self) -> Dict[str, Any]:
        endpoint = self.config.endpoint.rstrip("/") or "https://api.anthropic.com"
        headers = {"x-api-key": self.config.api_key, "anthropic-version": "2023-06-01"}
        try:
            async with make_async_client(self.config, timeout=10.0) as client:
                resp = await client.get(endpoint + "/v1/models", headers=headers)
            if resp.status_code == 200:
                return {"status": "ok", "models": []}
            if resp.status_code == 401:
                return {"status": "error", "error": "Invalid API key", "error_type": "auth"}
            return {"status": "ok", "models": [], "note": "Key accepted"}
        except Exception as e:
            return {"status": "error", "error": str(e), "error_type": "connection"}

    async def list_models(self) -> List[str]:
        return ["claude-sonnet-4-6-20250514", "claude-haiku-4-5-20251001", "claude-opus-4-7-20250219"]
