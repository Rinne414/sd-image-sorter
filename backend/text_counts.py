"""English counts in backend messages: "1 image", "3 images".

The frontend writes its counts through I18n.format (frontend/js/i18n.js); the
English messages built here say the singular for exactly one as well.
"""

from __future__ import annotations


def count_text(count: object, singular: str, plural: str = "") -> str:
    """The count and its noun, singular when the count is exactly 1."""
    noun = singular if str(count) == "1" else (plural or f"{singular}s")
    return f"{count} {noun}"
