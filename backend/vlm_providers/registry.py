"""Provider registry and prompt presets."""
from __future__ import annotations

from typing import Dict, List

from vlm_providers.base import VLMConfig, VLMProvider, detect_provider


def get_provider(config: VLMConfig) -> VLMProvider:
    """Create a provider instance from config."""
    provider_type = config.provider.lower().strip()

    if provider_type == "anthropic":
        from vlm_providers.anthropic import AnthropicProvider
        return AnthropicProvider(config)
    if provider_type == "gemini":
        from vlm_providers.gemini import GeminiProvider
        return GeminiProvider(config)

    from vlm_providers.openai_compat import OpenAICompatProvider
    return OpenAICompatProvider(config)


def list_providers() -> List[Dict[str, str]]:
    return [
        {"id": "openai_compat", "name": "OpenAI Compatible", "description": "OpenAI, Ollama, vLLM, LMStudio, OpenRouter, Volcengine Ark, etc."},
        {"id": "anthropic", "name": "Anthropic Claude", "description": "Claude 3.5/4 Sonnet, Opus, Haiku"},
        {"id": "gemini", "name": "Google Gemini", "description": "Gemini 2.0 Flash/Pro (public API or Vertex AI)"},
    ]


# Prompt presets keyed by output target.
# Each preset has system_prompt + user_prompt (and optional user_prompt_with_tags).
# Special keys: "output_format" = nl_caption | danbooru_tags | both
PROMPT_PRESETS: Dict[str, Dict[str, str]] = {
    "lora_training": {
        "name": "LoRA Training (NL caption)",
        "output_format": "nl_caption",
        "system_prompt": (
            "You are an image captioning expert for AI model training datasets. "
            "Write factual, detailed descriptions of images. Never embellish or add information not visible. "
            "Do not use markdown. Do not start with 'The image shows' or 'This is'."
        ),
        "user_prompt": (
            "Describe this image in 2-4 sentences for AI training. "
            "Cover: the main subject, their pose/action, clothing, the environment, lighting direction, and camera angle. "
            "Be specific about spatial relationships (left/right/foreground/background). Write in plain English."
        ),
        "user_prompt_with_tags": (
            "The following danbooru-style tags describe this image:\n{tags}\n\n"
            "Write a natural language caption (2-4 sentences) that complements these tags. "
            "Focus on spatial relationships, lighting, atmosphere, and composition that tags cannot express. "
            "Do not restate the tags as sentences. Write in plain English."
        ),
    },
    "anima_flux": {
        "name": "Anima / FLUX (Detailed NL)",
        "output_format": "nl_caption",
        "system_prompt": (
            "You are a precise image description writer for AI training. "
            "Describe exactly what is visible. Include spatial positions (left, right, center, foreground, background), "
            "lighting quality, and composition. No narrative, no emotion interpretation, no speculation."
        ),
        "user_prompt": (
            "Write a detailed factual description of this image in 3-5 sentences. "
            "Structure: subject appearance and pose, then environment and background, then lighting and atmosphere. "
            "Include direction words (left, right, above, below). Be specific about colors, materials, and textures."
        ),
        "user_prompt_with_tags": (
            "The following tags describe this image:\n{tags}\n\n"
            "Write a detailed natural language description (3-5 sentences) that adds information beyond these tags. "
            "Focus on: exact spatial positions, lighting direction and quality, material textures, atmosphere. "
            "Do not repeat tag information. Describe as if someone must recreate this image from your text alone."
        ),
    },
    "short_caption": {
        "name": "Short Caption",
        "output_format": "nl_caption",
        "system_prompt": "You are an image captioner. Write brief, accurate descriptions.",
        "user_prompt": "Describe this image in one sentence (under 30 words). Focus on the main subject and action only.",
        "user_prompt_with_tags": (
            "Tags: {tags}\n\n"
            "Write one sentence (under 30 words) describing what the tags cannot: the mood, composition, or spatial arrangement."
        ),
    },
    "character_lora": {
        "name": "Character LoRA Training",
        "output_format": "nl_caption",
        "system_prompt": (
            "You are writing training captions for a character LoRA. "
            "Focus on describing the scene, pose, and composition. "
            "Do NOT describe the character's fixed features (hair color, eye color) unless they differ from normal. "
            "Those are handled by tags. Focus on what changes between images."
        ),
        "user_prompt": (
            "Describe this character image for LoRA training in 2-3 sentences. "
            "Focus on: pose, expression, camera angle, background, lighting, and any accessories or outfit details. "
            "Do not describe permanent character features (hair/eye color, body type) — only scene-specific details."
        ),
        "user_prompt_with_tags": (
            "Character tags: {tags}\n\n"
            "Write 2-3 sentences describing scene-specific details NOT covered by the tags above. "
            "Focus on: pose direction, spatial arrangement, lighting, background details, expression nuance. "
            "Skip permanent character features already in the tags."
        ),
    },
    "nsfw_relaxed": {
        "name": "NSFW-Tolerant (Local Models)",
        "output_format": "nl_caption",
        "system_prompt": (
            "You are an image captioning system for an adult art training dataset. "
            "Describe all visible content factually and completely, including nudity and sexual content. "
            "Use clinical/anatomical terms. Do not add moral judgments or warnings."
        ),
        "user_prompt": (
            "Describe this image completely in 2-4 sentences. Include all visible body parts, poses, "
            "and interactions factually. Use anatomical terms. Cover: subjects, pose, setting, lighting."
        ),
        "user_prompt_with_tags": (
            "Tags: {tags}\n\n"
            "Write a complete factual description (2-4 sentences) complementing these tags. "
            "Include spatial relationships and any details the tags miss. Use clinical terms for anatomy."
        ),
    },
    # === v3.2.1 additions: danbooru tag generators ===
    "vlm_danbooru": {
        "name": "Danbooru Tags (VLM as tagger)",
        "output_format": "danbooru_tags",
        "system_prompt": (
            "You are a danbooru tagging expert. Your only output is a comma-separated list of "
            "danbooru-style tags describing the image. Use lowercase with underscores instead of spaces "
            "(e.g., long_hair, blue_eyes, school_uniform). No prose, no sentences, no markdown."
        ),
        "user_prompt": (
            "Output only a comma-separated list of danbooru tags for this image. "
            "Include: subject count (1girl, 2boys, etc), character features (hair color/length/style, eye color, "
            "ethnicity if relevant), clothing, pose, action, expression, setting, accessories, art style, and rating "
            "(safe, sensitive, questionable, explicit). Aim for 15-30 specific tags. "
            "Format: tag1, tag2, tag3, ..."
        ),
        "user_prompt_with_tags": (
            "Existing tags from a local tagger: {tags}\n\n"
            "Refine and expand this danbooru tag list. Output ONLY a comma-separated tag list. "
            "Add missing tags you observe. Remove obviously wrong tags. Use lowercase with underscores. "
            "Keep accurate tags from the input. Aim for 15-30 specific tags total."
        ),
    },
    "vlm_hybrid": {
        "name": "Hybrid (NL + Tags)",
        "output_format": "both",
        "system_prompt": (
            "You output both a natural language caption AND a list of danbooru tags. "
            "Use this exact format with XML-style markers:\n"
            "<NL>2-4 sentences of natural language description here</NL>\n"
            "<TAGS>tag1, tag2, tag3, ...</TAGS>\n"
            "Tags use lowercase with underscores. NL uses plain English sentences."
        ),
        "user_prompt": (
            "Describe this image in the hybrid format:\n"
            "<NL>...</NL> for 2-4 sentences covering subject, pose, scene, lighting, composition.\n"
            "<TAGS>...</TAGS> for 15-30 danbooru-style tags (lowercase_with_underscores)."
        ),
        "user_prompt_with_tags": (
            "Existing tags: {tags}\n\n"
            "Output:\n"
            "<NL>2-4 sentences of natural language adding spatial/lighting/atmosphere details NOT in tags above</NL>\n"
            "<TAGS>refined and expanded danbooru tag list, 15-30 tags total</TAGS>"
        ),
    },
}


__all__ = ["get_provider", "list_providers", "detect_provider", "PROMPT_PRESETS"]
