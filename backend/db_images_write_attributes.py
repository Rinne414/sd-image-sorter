"""User/AI attribute writers for images (split from db_images_write.py).

``update_image_caption``, ``set_image_captions``, ``set_user_rating``, and
``update_image_colors`` moved here verbatim in the 2026-07 db_images_write
split. Consumers keep importing through the ``database`` facade (which
re-exports these via ``db_images_write``); do not import this module
directly from feature code — ``db_images_write`` itself imports this module
at the end of its body, so a direct import that wins the race would trip
the managed import cycle and fail loudly.

Imports only from db_core / typing; it must not import from ``database``.
"""
from typing import Optional, List, Dict, Any

from db_core import get_db


def update_image_caption(image_id: int, caption: str, nl_caption: Optional[str] = None) -> None:
    """Update the composed ``ai_caption`` (and optionally pure ``nl_caption``).

    ``caption`` is the composed/display caption (may contain booru tags).
    ``nl_caption`` is the pure natural-language sentence from a VLM. When
    ``nl_caption`` is None the existing value is preserved (COALESCE) so callers
    that only know the composed caption never clobber the pure NL field.
    """
    with get_db() as conn:
        conn.execute(
            "UPDATE images SET ai_caption = ?, nl_caption = COALESCE(?, nl_caption) WHERE id = ?",
            (caption, nl_caption, image_id),
        )

def set_image_captions(
    image_id: int,
    *,
    ai_caption: Optional[str] = None,
    nl_caption: Optional[str] = None,
    set_ai_caption: bool = False,
    set_nl_caption: bool = False,
) -> bool:
    """Explicit-set caption writer for the manual caption editor (FE-3).

    Unlike ``update_image_caption`` (COALESCE semantics for pipeline
    callers), a field here is written IFF its ``set_*`` flag is True --
    including an empty string, so the editor can deliberately clear one
    caption without touching the other. Returns False when no row matched.
    """
    assignments = []
    params: List[Any] = []
    if set_ai_caption:
        assignments.append("ai_caption = ?")
        params.append(ai_caption)
    if set_nl_caption:
        assignments.append("nl_caption = ?")
        params.append(nl_caption)
    if not assignments:
        return False
    params.append(image_id)
    with get_db() as conn:
        cursor = conn.execute(
            f"UPDATE images SET {', '.join(assignments)} WHERE id = ?",
            params,
        )
        return int(cursor.rowcount or 0) > 0


def set_user_rating(image_id: int, stars: int) -> bool:
    """Set the user-assigned star rating (0-5; 0 = unrated) for one image.

    Returns True when a row was updated, False when no image has ``image_id``.
    Raises ``ValueError`` when ``stars`` is outside 0-5 so a bad client value
    fails loudly at the boundary instead of writing garbage.
    """
    try:
        stars_int = int(stars)
    except (TypeError, ValueError):
        raise ValueError(f"user_rating must be an integer 0-5, got {stars!r}")
    if not 0 <= stars_int <= 5:
        raise ValueError(f"user_rating must be between 0 and 5, got {stars_int}")
    with get_db() as conn:
        cursor = conn.execute(
            "UPDATE images SET user_rating = ? WHERE id = ?",
            (stars_int, image_id),
        )
        return int(cursor.rowcount or 0) > 0

def update_image_colors(image_id: int, color_data: Dict[str, Any]) -> None:
    """Update color analysis columns for an image (v3.2.1).

    color_data should match the keys returned by color_analyzer.analyze_image_colors():
      dominant_colors, avg_brightness, color_temperature, color_saturation,
      brightness_histogram, brightness_skew, brightness_distribution.
    """
    if not color_data:
        return
    with get_db() as conn:
        conn.execute(
            """
            UPDATE images
            SET dominant_colors = ?,
                dominant_color_tags = ?,
                avg_brightness = ?,
                color_temperature = ?,
                color_saturation = ?,
                brightness_histogram = ?,
                brightness_skew = ?,
                brightness_distribution = ?
            WHERE id = ?
            """,
            (
                color_data.get("dominant_colors"),
                color_data.get("dominant_color_tags"),
                color_data.get("avg_brightness"),
                color_data.get("color_temperature"),
                color_data.get("color_saturation"),
                color_data.get("brightness_histogram"),
                color_data.get("brightness_skew"),
                color_data.get("brightness_distribution"),
                image_id,
            ),
        )

