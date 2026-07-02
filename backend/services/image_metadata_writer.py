"""Helpers for saving edited Reader metadata into image files."""

from __future__ import annotations

from typing import Any, Optional

from PIL import Image, PngImagePlugin


JPEG_LIMITATION_WARNING = "JPEG metadata support is limited; use PNG for the most reliable SD prompt preservation."
WEBP_LIMITATION_WARNING = "WebP metadata support depends on the viewer; use PNG if another tool fails to read the saved prompt."
JPEG_ALPHA_WARNING = "JPEG does not support transparency; transparent pixels were flattened onto a white background."

EDITED_METADATA_KEY_ALIASES = {
    "negative prompt": "negative_prompt",
    "negative_prompt": "negative_prompt",
    "checkpoint": "model",
    "model_name": "model",
    "cfg": "cfg_scale",
    "cfg_scale": "cfg_scale",
    "cfg scale": "cfg_scale",
    "lora": "loras",
    "lora_text": "loras",
    "lora metadata": "loras",
    "lora_metadata": "loras",
}

PARAMETER_EXPORT_ORDER = [
    ("steps", "Steps"),
    ("sampler", "Sampler"),
    ("cfg_scale", "CFG scale"),
    ("seed", "Seed"),
    ("size", "Size"),
    ("model", "Model"),
    ("model_hash", "Model hash"),
    ("clip_skip", "Clip skip"),
    ("denoising_strength", "Denoising strength"),
    ("schedule_type", "Schedule type"),
    ("loras", "LoRAs"),
]


def normalize_edited_metadata(metadata: Optional[dict[str, Any]]) -> dict[str, Any]:
    """Normalize metadata keys from the editor into a stable backend shape."""
    normalized: dict[str, Any] = {}

    for raw_key, raw_value in (metadata or {}).items():
        key = str(raw_key or "").strip()
        if not key:
            continue

        normalized_key = key.lower().replace("-", "_")
        canonical_key = EDITED_METADATA_KEY_ALIASES.get(normalized_key, normalized_key)
        value: Any = raw_value
        if isinstance(value, (list, tuple, set)):
            parts = [str(item).strip() for item in value if str(item).strip()]
            value = ", ".join(parts) if parts else None
        elif isinstance(value, str):
            stripped = value.strip()
            value = stripped if stripped else None

        if value is None:
            continue

        normalized[canonical_key] = value

    if "size" not in normalized:
        width = normalized.get("width")
        height = normalized.get("height")
        if width is not None and height is not None:
            normalized["size"] = f"{width}x{height}"

    return normalized


def build_sd_parameters_text(metadata: dict[str, Any]) -> str:
    """Build a WebUI-style parameters blob that the existing parser can read back."""
    prompt = str(metadata.get("prompt") or "").strip()
    negative_prompt = str(metadata.get("negative_prompt") or "").strip()
    lines: list[str] = []
    if prompt:
        lines.append(prompt)
    if negative_prompt:
        lines.append(f"Negative prompt: {negative_prompt}")

    parts: list[str] = []
    emitted_keys = set()
    for key, label in PARAMETER_EXPORT_ORDER:
        value = metadata.get(key)
        if value is None or value == "":
            continue
        emitted_keys.add(key)
        parts.append(f"{label}: {value}")

    extra_keys = sorted(
        key for key in metadata.keys()
        if key not in emitted_keys and key not in {"prompt", "negative_prompt", "width", "height"}
    )
    for key in extra_keys:
        value = metadata.get(key)
        if value is None or value == "":
            continue
        label = " ".join(part.capitalize() for part in key.split("_"))
        parts.append(f"{label}: {value}")

    if parts:
        lines.append(", ".join(parts))

    return "\n".join(lines).strip()


def build_pnginfo(metadata: dict[str, Any], parameters_text: str) -> PngImagePlugin.PngInfo:
    pnginfo = PngImagePlugin.PngInfo()
    if parameters_text:
        pnginfo.add_text("parameters", parameters_text)

    pnginfo.add_text("Software", "SD Image Sorter")

    for key, value in metadata.items():
        if value is None or value == "":
            continue
        pnginfo.add_text(str(key), str(value))

    return pnginfo


def build_exif_bytes(image: Image.Image, parameters_text: str) -> Optional[bytes]:
    try:
        exif = image.getexif()
        if parameters_text:
            exif[0x010E] = parameters_text
        exif[0x0131] = "SD Image Sorter"
        return exif.tobytes()
    except Exception:
        return None


def prepare_image_for_save(image: Image.Image, pil_format: str, warnings: list[str]) -> Image.Image:
    """Prepare image mode conversions required by the target output format."""
    if pil_format != "JPEG":
        return image.copy()

    if image.mode in ("RGB", "L", "CMYK"):
        return image.copy()

    converted = image.convert("RGBA")
    background = Image.new("RGBA", converted.size, (255, 255, 255, 255))
    background.alpha_composite(converted)
    warnings.append(JPEG_ALPHA_WARNING)
    return background.convert("RGB")

