"""Text and JSON formats a generator reads back (Send to generator).

Pure builders, no I/O:
- WebUI/A1111 "parameters" text: what WebUI's "read generation parameters"
  arrow parses (prompt, ``Negative prompt:`` line, one settings line).
- NovelAI text: prompt, character slots and undesired content, labelled.
- ComfyUI: the API prompt and the UI workflow from the PNG text chunks, a
  workflow ComfyUI's canvas accepts on paste, and seed randomisation.
"""

from __future__ import annotations

import copy
import json
import random
import re
from pathlib import PurePath
from typing import Any, Dict, Iterable, List, Optional, Tuple

# ComfyUI / NovelAI sampler ids -> the names WebUI lists in its Sampler box.
_SAMPLER_NAMES = {
    "euler": "Euler",
    "euler_ancestral": "Euler a",
    "heun": "Heun",
    "dpm_2": "DPM2",
    "dpm_2_ancestral": "DPM2 a",
    "lms": "LMS",
    "dpm_fast": "DPM fast",
    "dpm_adaptive": "DPM adaptive",
    "dpmpp_2s_ancestral": "DPM++ 2S a",
    "dpmpp_sde": "DPM++ SDE",
    "dpmpp_sde_gpu": "DPM++ SDE",
    "dpmpp_2m": "DPM++ 2M",
    "dpmpp_2m_sde": "DPM++ 2M SDE",
    "dpmpp_2m_sde_gpu": "DPM++ 2M SDE",
    "dpmpp_3m_sde": "DPM++ 3M SDE",
    "dpmpp_3m_sde_gpu": "DPM++ 3M SDE",
    "ddim": "DDIM",
    "uni_pc": "UniPC",
    "uni_pc_bh2": "UniPC",
    "lcm": "LCM",
    "restart": "Restart",
}

# ComfyUI scheduler ids -> WebUI's "Schedule type" names.
_SCHEDULER_NAMES = {
    "normal": "Normal",
    "karras": "Karras",
    "exponential": "Exponential",
    "sgm_uniform": "SGM Uniform",
    "simple": "Simple",
    "ddim_uniform": "DDIM",
    "beta": "Beta",
    "kl_optimal": "KL Optimal",
    "polyexponential": "Polyexponential",
    "align_your_steps": "Align Your Steps",
}

_MODEL_EXTENSIONS = (".safetensors", ".ckpt", ".pt", ".pth", ".bin", ".gguf", ".sft")
SEED_INPUT_NAMES = ("seed", "noise_seed")
# Seeds every sampler node accepts (WebUI and most custom nodes stop at 32 bits).
_SEED_UPPER_BOUND = 2**32


def webui_sampler_name(value: Any) -> str:
    """Name a sampler the way WebUI lists it; unknown names pass through."""
    text = str(value or "").strip()
    key = text.lower()
    if key.startswith("k_"):
        key = key[2:]
    return _SAMPLER_NAMES.get(key, text)


def webui_scheduler_name(value: Any) -> str:
    text = str(value or "").strip()
    return _SCHEDULER_NAMES.get(text.lower(), text)


def webui_model_name(checkpoint: Any) -> str:
    """``models/sdxl/anima.safetensors`` -> ``anima`` (WebUI's Model field)."""
    text = str(checkpoint or "").strip()
    if not text:
        return ""
    name = PurePath(text.replace("\\", "/")).name
    lowered = name.lower()
    for ext in _MODEL_EXTENSIONS:
        if lowered.endswith(ext):
            return name[: -len(ext)]
    return name


def _quote(value: Any) -> str:
    """WebUI's own quoting: a value with , : or a newline goes in JSON quotes."""
    text = str(value)
    if "," not in text and ":" not in text and "\n" not in text:
        return text
    return json.dumps(text, ensure_ascii=False)


def _number(value: Any) -> Optional[str]:
    if isinstance(value, bool) or value is None or value == "":
        return None
    if isinstance(value, float):
        return f"{value:g}"
    return str(value).strip() or None


def _partial_denoise(value: Any) -> Optional[str]:
    """Denoise below 1 only: 1 is a plain txt2img run, and WebUI would read it
    as a hires-fix strength."""
    try:
        return _number(value) if float(value) < 1 else None
    except (TypeError, ValueError):
        return None


def _first(params: Dict[str, Any], *keys: str) -> Any:
    for key in keys:
        value = params.get(key)
        if value not in (None, ""):
            return value
    return None


def build_webui_settings_line(
    params: Optional[Dict[str, Any]],
    *,
    checkpoint: Any = None,
    width: Any = None,
    height: Any = None,
) -> str:
    """The ``Steps: 28, Sampler: Euler a, ...`` line WebUI writes and reads."""
    params = params or {}
    size = _first(params, "size")
    if not size and width and height:
        size = f"{int(width)}x{int(height)}"
    model = webui_model_name(_first(params, "model") or checkpoint)
    fields: List[Tuple[str, Optional[str]]] = [
        ("Steps", _number(_first(params, "steps"))),
        (
            "Sampler",
            webui_sampler_name(_first(params, "sampler", "sampler_name")) or None,
        ),
        (
            "Schedule type",
            webui_scheduler_name(
                _first(params, "schedule_type", "scheduler", "noise_schedule")
            )
            or None,
        ),
        ("CFG scale", _number(_first(params, "cfg_scale", "cfg", "scale"))),
        ("Seed", _number(_first(params, "seed", "noise_seed"))),
        ("Size", str(size) if size else None),
        ("Model hash", _first(params, "model_hash")),
        ("Model", model or None),
        ("Denoising strength", _partial_denoise(_first(params, "denoising_strength"))),
        ("Clip skip", _number(_first(params, "clip_skip"))),
    ]
    present = [(label, value) for label, value in fields if value]
    # WebUI reads a last line as settings only when it starts with Steps and
    # has 3+ fields; a shorter line would be pasted into the prompt instead.
    if len(present) < 3 or present[0][0] != "Steps":
        return ""
    return ", ".join(f"{label}: {_quote(value)}" for label, value in present)


def build_webui_text(prompt: Any, negative: Any, settings_line: str) -> str:
    """Prompt, ``Negative prompt:`` line, settings line: WebUI's paste format."""
    parts = [str(prompt or "").strip()]
    negative_text = str(negative or "").strip()
    if negative_text:
        parts.append(f"Negative prompt: {negative_text}")
    if settings_line:
        parts.append(settings_line)
    return "\n".join(parts).strip()


def build_nai_text(
    prompt: Any, negative: Any, character_prompts: Optional[Iterable[Any]] = None
) -> str:
    """NovelAI prompt, its character slots, then the undesired content, labelled."""
    blocks = [str(prompt or "").strip()]
    for index, entry in enumerate(character_prompts or [], start=1):
        if not isinstance(entry, dict):
            continue
        slot_prompt = str(entry.get("prompt") or "").strip()
        slot_negative = str(entry.get("negative_prompt") or "").strip()
        if slot_prompt:
            blocks.append(f"Character {index}: {slot_prompt}")
        if slot_negative:
            blocks.append(f"Character {index} Undesired Content: {slot_negative}")
    negative_text = str(negative or "").strip()
    if negative_text:
        blocks.append(f"Undesired Content: {negative_text}")
    return "\n\n".join(block for block in blocks if block)


def _json_object(value: Any) -> Optional[Dict[str, Any]]:
    if isinstance(value, dict):
        return value
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = json.loads(value)
    except (TypeError, ValueError):
        return None
    return parsed if isinstance(parsed, dict) else None


def comfy_api_prompt(chunks: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """The API-format prompt (``prompt`` chunk): node id -> {class_type, inputs}."""
    prompt = _json_object(chunks.get("prompt"))
    if not prompt:
        return None
    nodes = [node for node in prompt.values() if isinstance(node, dict)]
    if not nodes or not all("class_type" in node for node in nodes):
        return None
    return prompt


def comfy_workflow(chunks: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """The UI workflow (``workflow`` chunk): has a ``nodes`` list."""
    workflow = _json_object(chunks.get("workflow"))
    if not workflow or not isinstance(workflow.get("nodes"), list):
        return None
    return workflow


def pasteable_workflow(workflow: Dict[str, Any]) -> Dict[str, Any]:
    """A copy ComfyUI's canvas loads on Ctrl+V: it needs version, nodes and extra."""
    result = dict(workflow)
    if not isinstance(result.get("extra"), dict):
        result["extra"] = {}
    if not isinstance(result.get("version"), (int, float, str)):
        result["version"] = 0.4
    return result


def _is_literal_seed(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def count_seed_inputs(api_prompt: Dict[str, Any]) -> int:
    """How many seed inputs hold a number (linked inputs are lists)."""
    return sum(
        1
        for node in api_prompt.values()
        if isinstance(node, dict) and isinstance(node.get("inputs"), dict)
        for name in SEED_INPUT_NAMES
        if _is_literal_seed(node["inputs"].get(name))
    )


def randomize_seeds(
    api_prompt: Dict[str, Any], rng: Optional[random.Random] = None
) -> Tuple[Dict[str, Any], int]:
    """New random value for every ``seed``/``noise_seed`` input that holds a number.

    Inputs linked to another node (``["12", 0]``) and negative special values
    (-1 = "random" in some seed nodes) are left alone. Returns a new prompt and
    how many inputs changed.
    """
    rng = rng or random.SystemRandom()
    result = copy.deepcopy(api_prompt)
    changed = 0
    for node in result.values():
        inputs = node.get("inputs") if isinstance(node, dict) else None
        if not isinstance(inputs, dict):
            continue
        for name in SEED_INPUT_NAMES:
            if _is_literal_seed(inputs.get(name)):
                inputs[name] = rng.randrange(_SEED_UPPER_BOUND)
                changed += 1
    return result, changed


_UNSAFE_FILENAME = re.compile(r'[<>:"/\\|?*\x00-\x1f]+')


def workflow_file_stem(filename: Any, image_id: int) -> str:
    """``sunset.png`` -> ``sunset``; a name that cannot be a file falls back to the id."""
    stem = PurePath(str(filename or "")).stem
    stem = _UNSAFE_FILENAME.sub("_", stem).strip(" .")
    return stem or f"image-{image_id}"
