"""Trainer-consumability validation for caption sidecar exports.

Runs incrementally inside the batch-export loop (O(1) memory: aggregate
counters plus at most three example filenames per warning code) and returns
a compact summary the export modal can surface.

The checks validate OUTPUT PROPERTIES, not code paths — a caption that is
multi-line, unpaired, trigger-less, empty, or self-contradictory is a broken
training sample no matter which pipeline produced it. That is what makes the
validator catch future regressions of these classes automatically.
"""
from __future__ import annotations

import os
from typing import Any, Dict, List, Optional

# Content modes whose output is legitimately multi-line by design
# (parameter blocks, JSON payloads, the explicitly two-line prompt_nl mode).
MULTILINE_EXEMPT_MODES = {"prompt_negative", "a1111", "json", "prompt_nl"}

# Modes whose output is a comma-separated tag caption — the only place a
# standalone rating token is meaningful enough to check for contradictions.
_RATING_CHECK_MODES = {"tags", "caption_tags", "caption_merged", "tags_nl", "template"}

# Rating words graded by level; two different levels in one caption means
# the caption argues with itself (e.g. "safe, …, explicit" — F1).
_RATING_LEVELS: Dict[str, int] = {
    "safe": 0,
    "sensitive": 1,
    "questionable": 2,
    "nsfw": 2,
    "explicit": 3,
}

_MAX_EXAMPLES = 3

_WARNING_MESSAGES: Dict[str, str] = {
    "empty_caption": "Caption file is empty — the trainer sees an uncaptioned image.",
    "multiline_caption": "Caption spans multiple lines — kohya-style trainers read only the first line.",
    "unpaired_sidecar": "Caption filename does not match its image, so the trainer will never pair them.",
    "missing_trigger": "The configured trigger word is missing from the caption.",
    "conflicting_ratings": "Caption contains two different rating tokens (e.g. 'safe' and 'explicit').",
}


def _normalize_token(token: str) -> str:
    return " ".join(str(token or "").replace("_", " ").split()).lower()


class ExportValidator:
    """Incremental caption-quality checks for one export run."""

    def __init__(
        self,
        *,
        content_mode: str,
        template_options: Optional[Dict[str, Any]] = None,
    ) -> None:
        self.content_mode = str(content_mode or "").strip().lower()
        trigger = ""
        if self.content_mode == "template" and isinstance(template_options, dict):
            trigger = str(template_options.get("trigger") or "").strip()
        self._trigger_norm = _normalize_token(trigger)
        self.checked = 0
        self._hits: Dict[str, Dict[str, Any]] = {}

    def _hit(self, code: str, example: str) -> None:
        entry = self._hits.setdefault(code, {"count": 0, "examples": []})
        entry["count"] += 1
        if example and len(entry["examples"]) < _MAX_EXAMPLES:
            entry["examples"].append(example)

    def add(self, *, output_path: str, content: str, image_path: str = "", pair_suffix: str = "") -> None:
        """Record one written sidecar for validation.

        ``pair_suffix`` marks a deliberately-suffixed twin file (the split
        export's ``{stem}_nl.txt``): the suffix is stripped before the
        pairing check so the twin is not flagged as an unpaired sidecar.
        """
        self.checked += 1
        text = str(content or "")
        name = os.path.basename(str(output_path or ""))

        if not text.strip():
            self._hit("empty_caption", name)
            return

        if self.content_mode not in MULTILINE_EXEMPT_MODES and "\n" in text.strip():
            self._hit("multiline_caption", name)

        if image_path:
            image_stem = os.path.splitext(os.path.basename(str(image_path)))[0]
            sidecar_stem = os.path.splitext(name)[0]
            if pair_suffix and sidecar_stem.endswith(pair_suffix):
                sidecar_stem = sidecar_stem[: -len(pair_suffix)]
            if image_stem and sidecar_stem and sidecar_stem != image_stem:
                self._hit("unpaired_sidecar", name)

        needs_tokens = bool(self._trigger_norm) or self.content_mode in _RATING_CHECK_MODES
        if not needs_tokens:
            return
        tokens = {_normalize_token(part) for part in text.split(",")}
        tokens.discard("")

        if self._trigger_norm and self._trigger_norm not in tokens:
            self._hit("missing_trigger", name)

        if self.content_mode in _RATING_CHECK_MODES:
            levels = {_RATING_LEVELS[t] for t in tokens if t in _RATING_LEVELS}
            if len(levels) >= 2:
                self._hit("conflicting_ratings", name)

    def summary(self) -> Dict[str, Any]:
        """Aggregate result for the export response, worst codes first."""
        order = [
            "unpaired_sidecar",
            "empty_caption",
            "multiline_caption",
            "missing_trigger",
            "conflicting_ratings",
        ]
        warnings: List[Dict[str, Any]] = []
        for code in order:
            entry = self._hits.get(code)
            if not entry:
                continue
            warnings.append(
                {
                    "code": code,
                    "count": entry["count"],
                    "examples": list(entry["examples"]),
                    "message": _WARNING_MESSAGES.get(code, code),
                }
            )
        return {"checked": self.checked, "ok": not warnings, "warnings": warnings}
