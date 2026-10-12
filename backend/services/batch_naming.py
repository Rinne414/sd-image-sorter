"""Output names for a batch export: ``{batch}_{n:02}`` style templates.

Tokens: ``{batch}`` (batch name), ``{original}`` (the original file's name
without extension), ``{n}`` (the number) and ``{n:0W}`` (the number padded
with zeros to W digits, W = 1..9). Anything else in braces is an error rather
than being written into a file name literally.
"""

from __future__ import annotations

import os
import re

from utils.path_validation import sanitize_filename

_TOKEN = re.compile(r"\{([^{}]*)\}")
_PADDED_NUMBER = re.compile(r"^n:0([1-9])$")
IMAGE_SUFFIXES = (".png", ".jpg", ".jpeg", ".webp")


class BatchNameTemplateError(ValueError):
    def __init__(self, template: str, token: str):
        self.template = template
        self.token = token
        super().__init__(
            f"Unknown or broken token {token!r} in name template {template!r}"
        )


def _token_value(
    template: str, token: str, batch: str, number: int, original: str
) -> str:
    if token == "batch":
        return batch
    if token == "original":
        return original
    if token == "n":
        return str(number)
    padded = _PADDED_NUMBER.match(token)
    if padded:
        return f"{number:0{int(padded.group(1))}d}"
    raise BatchNameTemplateError(template, "{" + token + "}")


def render_output_stem(template: str, *, batch: str, number: int, original: str) -> str:
    """Render the template into a file-name stem (no extension, not yet sanitized)."""
    rendered = _TOKEN.sub(
        lambda match: _token_value(template, match.group(1), batch, number, original),
        template,
    )
    literal_parts = _TOKEN.sub("", template)
    if "{" in literal_parts or "}" in literal_parts:
        brace = "{" if "{" in literal_parts else "}"
        raise BatchNameTemplateError(template, brace)
    return rendered


def validate_template(template: str) -> None:
    render_output_stem(template, batch="batch", number=1, original="original")


def safe_stem(stem: str) -> str:
    """File-system safe stem; a typed image extension is dropped (format decides it)."""
    base, extension = os.path.splitext(stem)
    if extension.lower() in IMAGE_SUFFIXES:
        stem = base
    # sanitize_filename keeps only the last path segment; a batch called
    # "2026/09" should become "2026_09", not "09".
    stem = stem.replace("/", "_").replace("\\", "_")
    cleaned = sanitize_filename(stem).rstrip(". ")
    return cleaned or "unnamed"
