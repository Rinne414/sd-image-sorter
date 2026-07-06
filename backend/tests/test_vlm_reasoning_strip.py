"""Tests for VLM reasoning stripping + truncation flagging (audit P2-9).

The OpenAI-compatible provider must strip ``<think>...</think>`` reasoning from
the answer content before parsing it into a caption/tags, ignore any sibling
``reasoning_content`` field, and flag ``finish_reason == "length"`` responses as
truncated without raising or auto-retrying.
"""
from __future__ import annotations

import asyncio

from PIL import Image

import vlm_providers.openai_compat as openai_compat
from vlm_providers.base import VLMConfig, strip_reasoning
from vlm_providers.openai_compat import OpenAICompatProvider


class _FakeResponse:
    def __init__(self, payload):
        self._payload = payload
        self.status_code = 200
        self.text = ""

    def json(self):
        return self._payload


class _FakeClient:
    """Minimal async-context-manager stand-in for httpx.AsyncClient."""

    def __init__(self, payload):
        self._payload = payload

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def post(self, url, json=None, headers=None):
        return _FakeResponse(self._payload)


def _install_fake_response(monkeypatch, payload):
    monkeypatch.setattr(
        openai_compat,
        "make_async_client",
        lambda config, timeout=None: _FakeClient(payload),
    )


def _provider(output_format="danbooru_tags"):
    return OpenAICompatProvider(
        VLMConfig(
            endpoint="https://example.test/v1",
            model="m",
            output_format=output_format,
            max_retries=0,
        )
    )


def test_strip_reasoning_removes_think_block_and_dangling_close():
    # Arrange / Act / Assert on the shared helper directly.
    assert strip_reasoning("<think>hidden</think>real answer") == "real answer"
    # Only the closing tag survived (opening dropped by a front token cap).
    assert strip_reasoning("leftover reasoning</think>the answer") == "the answer"
    # No think tags: unchanged apart from trimming.
    assert strip_reasoning("  just text  ") == "just text"


def test_think_block_stripped_before_parsing_tags(monkeypatch, tmp_path):
    # Arrange: content wraps chain-of-thought in <think> before the real tags.
    payload = {
        "choices": [
            {
                "message": {
                    "content": (
                        "<think>the user wants tags, let me look: maybe 1girl</think>"
                        "1girl, solo, long_hair"
                    )
                },
                "finish_reason": "stop",
            }
        ],
        "usage": {"total_tokens": 20},
    }
    _install_fake_response(monkeypatch, payload)
    image_path = tmp_path / "think.png"
    Image.new("RGB", (16, 16), color="white").save(image_path)

    # Act
    result = asyncio.run(_provider().caption_image(str(image_path)))

    # Assert: reasoning never reaches the parsed tags or the stored raw_text.
    assert result.error is None
    assert result.tags == ["1girl", "solo", "long_hair"]
    assert "<think>" not in result.raw_text
    assert not any("wants" in tag or "think" in tag for tag in result.tags)


def test_finish_reason_length_flags_truncation_without_error(monkeypatch, tmp_path):
    # Arrange: the model hit the token cap mid tag-list.
    payload = {
        "choices": [
            {"message": {"content": "1girl, solo, long"}, "finish_reason": "length"}
        ],
        "usage": {"total_tokens": 8},
    }
    _install_fake_response(monkeypatch, payload)
    image_path = tmp_path / "trunc.png"
    Image.new("RGB", (16, 16), color="white").save(image_path)

    # Act
    result = asyncio.run(_provider().caption_image(str(image_path)))

    # Assert: truncated flag set, no exception, no error surfaced.
    assert result.truncated is True
    assert result.error is None


def test_request_flags_truncation_and_ignores_reasoning_content(monkeypatch):
    # Arrange: a vendor that returns chain-of-thought in a sibling field.
    payload = {
        "choices": [
            {
                "message": {
                    "content": "a caption",
                    "reasoning_content": "SECRET CHAIN OF THOUGHT",
                },
                "finish_reason": "length",
            }
        ],
        "usage": {"completion_tokens": 3},
    }
    _install_fake_response(monkeypatch, payload)

    # Act
    result = asyncio.run(
        _provider("nl_caption")._request([{"role": "user", "content": "hi"}])
    )

    # Assert: truncation flagged; reasoning_content is never concatenated in.
    assert result["truncated"] is True
    assert result["caption"] == "a caption"
    assert "SECRET CHAIN OF THOUGHT" not in result["caption"]
