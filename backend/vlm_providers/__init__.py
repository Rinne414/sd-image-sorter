"""
VLM (Vision Language Model) provider system for natural language image captioning.

Supports multiple providers: OpenAI-compatible, Anthropic, Google Gemini (public + Vertex AI),
and local models via Ollama. Includes proxy support, retry logic, and danbooru tag generation modes.
"""
from vlm_providers.base import (
    OUTPUT_FORMAT_BOTH,
    OUTPUT_FORMAT_NL,
    OUTPUT_FORMAT_TAGS,
    VALID_OUTPUT_FORMATS,
    ProviderError,
    VLMConfig,
    VLMProvider,
    VLMResult,
    detect_provider,
    encode_image_base64,
    make_async_client,
)
from vlm_providers.registry import PROMPT_PRESETS, get_provider, list_providers

__all__ = [
    "VLMProvider",
    "VLMResult",
    "VLMConfig",
    "ProviderError",
    "get_provider",
    "list_providers",
    "detect_provider",
    "PROMPT_PRESETS",
    "OUTPUT_FORMAT_NL",
    "OUTPUT_FORMAT_TAGS",
    "OUTPUT_FORMAT_BOTH",
    "VALID_OUTPUT_FORMATS",
    "encode_image_base64",
    "make_async_client",
]
