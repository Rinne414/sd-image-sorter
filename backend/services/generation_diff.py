"""What changed between two pictures: the question asked while iterating.

A person generating variations changes one or two things per try (a word, the
CFG, a LoRA weight) and then cannot tell which try had what. This compares the
generation data of two pictures and returns only the differences, in the terms
the person set: prompt words added and removed, settings that differ, LoRAs
added, removed or re-weighted. The seed is reported apart: it differs on almost
every try and says nothing about what the person changed.

Pure functions over the stored rows; nothing is read from the picture files.
"""

from __future__ import annotations

import json
import re
from typing import Any, Dict, List, Optional, Tuple

# Settings compared, in the order shown. Each: (key shown, names it may have in parsed data).
_SETTINGS: Tuple[Tuple[str, Tuple[str, ...]], ...] = (
    ("steps", ("steps",)),
    ("sampler", ("sampler", "sampler_name")),
    ("scheduler", ("scheduler", "schedule_type", "noise_schedule")),
    ("cfg", ("cfg_scale", "cfg", "scale")),
    ("denoise", ("denoise", "denoising_strength", "strength")),
    ("clip_skip", ("clip_skip",)),
    ("size", ()),  # filled from width x height
)
_WEIGHT_WRAPPERS = re.compile(r"^[\(\[\{]+|[\)\]\}]+$")
_WEIGHT_SUFFIX = re.compile(r":\s*-?\d+(?:\.\d+)?\s*$")
_LORA_TAG = re.compile(r"<lora:[^>]+>", re.IGNORECASE)


def _parsed(image: Dict[str, Any]) -> Dict[str, Any]:
    raw = image.get("metadata_json")
    try:
        data = json.loads(raw) if isinstance(raw, str) else (raw or {})
    except ValueError:
        data = {}
    parsed = data.get("_parsed") if isinstance(data, dict) else None
    return parsed if isinstance(parsed, dict) else {}


def _words(prompt: Optional[str]) -> List[str]:
    """A prompt as its comma-separated words, in order, without weight marks or LoRA tags."""
    text = _LORA_TAG.sub("", str(prompt or "")).replace("\n", ",")
    words: List[str] = []
    for piece in text.split(","):
        word = _WEIGHT_WRAPPERS.sub("", piece.strip())
        word = _WEIGHT_SUFFIX.sub("", word).strip()
        word = _WEIGHT_WRAPPERS.sub("", word).strip()
        if word and word not in words:
            words.append(word)
    return words


def _word_key(word: str) -> str:
    return word.lower().replace("_", " ")


def _text_change(before: Optional[str], after: Optional[str]) -> Dict[str, List[str]]:
    old, new = _words(before), _words(after)
    old_keys = {_word_key(word) for word in old}
    new_keys = {_word_key(word) for word in new}
    return {
        "added": [word for word in new if _word_key(word) not in old_keys],
        "removed": [word for word in old if _word_key(word) not in new_keys],
    }


def _number(value: Any) -> Any:
    """7.0 and 7 are the same setting; text stays text."""
    try:
        number = float(value)
    except (TypeError, ValueError):
        return str(value).strip() if value is not None else None
    return int(number) if number == int(number) else round(number, 4)


def _settings(image: Dict[str, Any]) -> Dict[str, Any]:
    params = _parsed(image).get("generation_params")
    params = params if isinstance(params, dict) else {}
    values: Dict[str, Any] = {}
    for key, names in _SETTINGS:
        for name in names:
            if params.get(name) not in (None, ""):
                values[key] = _number(params[name])
                break
    width = params.get("width") or image.get("width")
    height = params.get("height") or image.get("height")
    if width and height:
        values["size"] = f"{int(width)} x {int(height)}"
    values["model"] = image.get("checkpoint") or None
    values["seed"] = (
        _number(params.get("seed")) if params.get("seed") not in (None, "") else None
    )
    return values


def _loras(image: Dict[str, Any]) -> Dict[str, Optional[float]]:
    """LoRA name -> weight (None when the picture does not record one)."""
    found: Dict[str, Optional[float]] = {}
    for entry in _parsed(image).get("loras") or []:
        if isinstance(entry, dict) and entry.get("name"):
            weight = entry.get("weight")
            found[str(entry["name"])] = (
                _number(weight) if weight not in (None, "") else None
            )
        elif isinstance(entry, str) and entry:
            found[entry] = None
    if not found:
        try:
            names = json.loads(image.get("loras") or "[]")
        except ValueError:
            names = []
        found = {str(name): None for name in names if name}
    return found


def compare(before: Dict[str, Any], after: Dict[str, Any]) -> Dict[str, Any]:
    """What ``after`` has that ``before`` does not, and the other way round."""
    old, new = _settings(before), _settings(after)
    settings = [
        {"key": key, "before": old.get(key), "after": new.get(key)}
        for key in ("model", *(key for key, _names in _SETTINGS))
        if old.get(key) != new.get(key)
        and not (old.get(key) is None and new.get(key) is None)
    ]
    old_loras, new_loras = _loras(before), _loras(after)
    loras = {
        "added": [
            {"name": name, "weight": new_loras[name]}
            for name in new_loras
            if name not in old_loras
        ],
        "removed": [
            {"name": name, "weight": old_loras[name]}
            for name in old_loras
            if name not in new_loras
        ],
        "reweighted": [
            {"name": name, "before": old_loras[name], "after": new_loras[name]}
            for name in new_loras
            if name in old_loras and old_loras[name] != new_loras[name]
        ],
    }
    prompt = _text_change(before.get("prompt"), after.get("prompt"))
    negative = _text_change(before.get("negative_prompt"), after.get("negative_prompt"))
    has_data = bool(after.get("prompt") or new.get("steps")) and bool(
        before.get("prompt") or old.get("steps")
    )
    changed = bool(
        settings
        or any(loras.values())
        or any(prompt.values())
        or any(negative.values())
    )
    return {
        "before": {"id": before.get("id"), "filename": before.get("filename")},
        "after": {"id": after.get("id"), "filename": after.get("filename")},
        "comparable": has_data,
        "same": has_data and not changed,
        "seed": {
            "before": old.get("seed"),
            "after": new.get("seed"),
            "same": old.get("seed") == new.get("seed"),
        },
        "settings": settings,
        "loras": loras,
        "prompt": prompt,
        "negative_prompt": negative,
    }
