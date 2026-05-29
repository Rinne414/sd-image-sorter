"""OpenAI-compatible VLM provider.

Covers: OpenAI, Ollama, vLLM, LMStudio, OpenRouter, Volcengine Ark, any /v1/chat/completions endpoint.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any, Dict, List, Optional

import httpx

from vlm_providers.base import (
    ProviderError,
    VLMProvider,
    VLMResult,
    encode_image_base64,
    make_async_client,
)

logger = logging.getLogger(__name__)

NSFW_REFUSAL_MARKERS = [
    # Self-referential refusals — these reliably signal "I won't do this".
    "i cannot",
    "i can't",
    "i'm unable",
    "i am unable",
    "cannot process",
    "cannot assist",
    "unable to assist",
    "i'm sorry, but i can",
    "i am sorry, but i can",
    "i won't",
    "i will not",
    # Policy / "violates" wording — strong signal.
    "violates",
    "content policy",
    "against my guidelines",
    "against the guidelines",
    "against our policy",
    # Decline wording targeted at sexual/explicit content.
    "i can't describe",
    "i cannot describe",
    "i won't describe",
    "decline to describe",
    # NOTE: deliberately NOT triggering on bare phrases like
    # "as an ai", "sorry, but", "inappropriate", "not appropriate".
    # Real captions routinely contain these tokens (e.g. "an inappropriate
    # outfit" in the caption, or "as an AI-generated piece" describing the
    # image style). Earlier drafts of this list flagged those legitimate
    # captions as nsfw_refused, which then either dropped the caption or
    # spent retries fighting the model. Keep the list short and specific
    # to the refusal-grammar shapes models actually emit when they refuse.
]


class OpenAICompatProvider(VLMProvider):
    """Provider for any OpenAI-compatible /v1/chat/completions endpoint."""

    name = "openai_compat"

    async def caption_image(
        self,
        image_path: str,
        *,
        tags: Optional[List[str]] = None,
    ) -> VLMResult:
        image_b64 = encode_image_base64(image_path, self.config.max_image_size)
        user_message = self.build_user_message(tags)

        messages = []
        if self.config.system_prompt:
            messages.append({"role": "system", "content": self.config.system_prompt})
        messages.append({
            "role": "user",
            "content": [
                {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{image_b64}"}},
                {"type": "text", "text": user_message},
            ],
        })

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
                        error="Empty response after all retries",
                        error_type="empty_response",
                        retries_used=retries,
                        model=self.config.model,
                    )

                if self._is_nsfw_refusal(raw_text):
                    retries += 1
                    if attempt < self.config.max_retries and self.config.nsfw_retry_prompt:
                        messages[-1]["content"][-1]["text"] = self.config.nsfw_retry_prompt
                        await asyncio.sleep(self.config.retry_delay_seconds)
                        continue
                    parsed = self.parse_output(raw_text)
                    parsed.tokens_used = tokens
                    parsed.error = "NSFW content refused by model"
                    parsed.error_type = "nsfw_refused"
                    parsed.retries_used = retries
                    parsed.model = self.config.model
                    return parsed

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

    async def generate_text(
        self,
        prompt: str,
        *,
        system_prompt: str = "",
        max_tokens: int = 2048,
        temperature: float = 0.1,
    ) -> VLMResult:
        messages = []
        if system_prompt:
            messages.append({"role": "system", "content": system_prompt})
        messages.append({"role": "user", "content": str(prompt or "")})
        try:
            result = await self._request(messages, max_tokens=max_tokens, temperature=temperature)
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

    async def _request(self, messages: List[Dict], *, max_tokens: int = 1024, temperature: float = 0.3) -> Dict[str, Any]:
        url = self.config.endpoint.rstrip("/") + "/chat/completions"
        headers = {"Content-Type": "application/json"}
        if self.config.api_key:
            headers["Authorization"] = f"Bearer {self.config.api_key}"

        payload = {
            "model": self.config.model,
            "messages": messages,
            "max_tokens": max_tokens,
            "temperature": temperature,
        }

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
            raise ProviderError(
                f"Server error {resp.status_code}: {resp.text[:200]}",
                error_type="server_error",
                retryable=True,
            )
        if resp.status_code != 200:
            raise ProviderError(
                f"HTTP {resp.status_code}: {resp.text[:300]}",
                error_type=f"http_{resp.status_code}",
                retryable=False,
            )

        try:
            data = resp.json()
        except Exception:
            raise ProviderError("Invalid JSON response", error_type="parse_error", retryable=False)

        caption = ""
        choices = data.get("choices") or []
        if choices:
            msg = choices[0].get("message") or {}
            caption = msg.get("content") or ""

        usage = data.get("usage") or {}
        tokens = usage.get("total_tokens") or usage.get("completion_tokens") or 0

        return {"caption": caption, "tokens": tokens}

    async def test_connection(self) -> Dict[str, Any]:
        url = self.config.endpoint.rstrip("/") + "/models"
        headers = {}
        if self.config.api_key:
            headers["Authorization"] = f"Bearer {self.config.api_key}"

        try:
            async with make_async_client(self.config, timeout=10.0) as client:
                resp = await client.get(url, headers=headers)
            if resp.status_code == 200:
                data = resp.json()
                models = []
                if isinstance(data, dict) and "data" in data:
                    models = [m.get("id", "") for m in data["data"] if isinstance(m, dict)]
                return {"status": "ok", "models": models}
            return {"status": "ok", "models": [], "note": f"Models endpoint returned {resp.status_code}"}
        except httpx.TimeoutException:
            return {"status": "error", "error": "Connection timed out", "error_type": "timeout"}
        except httpx.ConnectError as e:
            return {"status": "error", "error": f"Cannot connect: {e}", "error_type": "connection"}
        except Exception as e:
            return {"status": "error", "error": str(e), "error_type": "unknown"}

    async def list_models(self) -> List[str]:
        result = await self.test_connection()
        return result.get("models", [])

    @staticmethod
    def _is_nsfw_refusal(text: str) -> bool:
        lower = text.lower()
        return any(marker in lower for marker in NSFW_REFUSAL_MARKERS)
