from __future__ import annotations

import asyncio

from vlm_providers import VLMConfig
from vlm_providers.anthropic import AnthropicProvider
from vlm_providers.gemini import GeminiProvider
from vlm_providers.openai_compat import OpenAICompatProvider


def test_openai_compat_generate_text_uses_text_only_request(monkeypatch):
    provider = OpenAICompatProvider(VLMConfig(endpoint="http://example.test/v1", model="dummy"))
    captured = {}

    async def fake_request(messages, **kwargs):
        captured["messages"] = messages
        captured["kwargs"] = kwargs
        return {"caption": "translated", "tokens": 3}

    monkeypatch.setattr(provider, "_request", fake_request)

    result = asyncio.run(provider.generate_text("hello", system_prompt="sys", max_tokens=123, temperature=0.2))

    assert result.caption == "translated"
    assert captured["messages"] == [
        {"role": "system", "content": "sys"},
        {"role": "user", "content": "hello"},
    ]
    assert captured["kwargs"]["max_tokens"] == 123
    assert captured["kwargs"]["temperature"] == 0.2


def test_openai_compat_generate_text_rejects_empty_response(monkeypatch):
    provider = OpenAICompatProvider(VLMConfig(endpoint="http://example.test/v1", model="dummy"))

    async def fake_request(messages, **kwargs):
        return {"caption": "   ", "tokens": 1}

    monkeypatch.setattr(provider, "_request", fake_request)

    result = asyncio.run(provider.generate_text("hello"))

    assert result.error_type == "empty_response"
    assert "empty" in result.error


def test_anthropic_generate_text_uses_text_block(monkeypatch):
    provider = AnthropicProvider(VLMConfig(endpoint="http://example.test", model="dummy"))
    captured = {}

    async def fake_request(messages, **kwargs):
        captured["messages"] = messages
        captured["kwargs"] = kwargs
        return {"caption": "translated", "tokens": 4}

    monkeypatch.setattr(provider, "_request", fake_request)

    result = asyncio.run(provider.generate_text("hello", system_prompt="sys"))

    assert result.caption == "translated"
    assert captured["messages"][0]["content"][0] == {"type": "text", "text": "hello"}
    assert captured["kwargs"]["system_prompt"] == "sys"


def test_anthropic_generate_text_rejects_empty_response(monkeypatch):
    provider = AnthropicProvider(VLMConfig(endpoint="http://example.test", model="dummy"))

    async def fake_request(messages, **kwargs):
        return {"caption": "", "tokens": 1}

    monkeypatch.setattr(provider, "_request", fake_request)

    result = asyncio.run(provider.generate_text("hello"))

    assert result.error_type == "empty_response"


def test_gemini_generate_text_uses_public_text_request(monkeypatch):
    provider = GeminiProvider(VLMConfig(endpoint="http://example.test", model="dummy"))
    captured = {}

    async def fake_text_request(prompt, **kwargs):
        captured["prompt"] = prompt
        captured["kwargs"] = kwargs
        return {"caption": "translated", "tokens": 5}

    monkeypatch.setattr(provider, "_public_text_request", fake_text_request)

    result = asyncio.run(provider.generate_text("hello", system_prompt="sys", max_tokens=321))

    assert result.caption == "translated"
    assert captured["prompt"] == "hello"
    assert captured["kwargs"]["system_prompt"] == "sys"
    assert captured["kwargs"]["max_tokens"] == 321


def test_gemini_generate_text_rejects_empty_response(monkeypatch):
    provider = GeminiProvider(VLMConfig(endpoint="http://example.test", model="dummy"))

    async def fake_text_request(prompt, **kwargs):
        return {"caption": "\n", "tokens": 1}

    monkeypatch.setattr(provider, "_public_text_request", fake_text_request)

    result = asyncio.run(provider.generate_text("hello"))

    assert result.error_type == "empty_response"
