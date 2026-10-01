"""The tags that may name an end of a style-map axis (slice S4e).

Only tags that say HOW a picture is drawn: medium and technique, colour
treatment, rendering, art style. Subject, clothing, pose, composition and
camera angle say WHAT is drawn and never label an axis, so an axis that
separates "nude from clothed" is reported as having no style difference.

Every tag is a WD14 general tag in the vocabulary (``selected_tags.csv``) of
at least one shipped tagger: ``wd-swinv2-tagger-v3`` and
``wd-eva02-large-tagger-v3`` share one vocabulary (S), ``pixai-tagger-v0.9``
has its own (P). Checked against the files on 2026-10-02; ``tagger`` below
says which vocabularies carry the tag. Sources are Danbooru's tag groups
(danbooru.donmai.us/wiki_pages/tag_group:<name>):

- ``colors``: Colors (No Color, Partial Coloring, Specific Palettes, Filters,
  Techniques)
- ``aesthetic``: Visual aesthetic > Art styles
- ``composition``: Image composition > styles and rendering effects
- ``medium``: the media and technique tags Danbooru files under traditional /
  digital media, 3d and chibi (wiki pages of the tags themselves)

Names for the page live in the language packs as ``stylemap.tag.<tag>``;
a tag without one is shown as its English name.
"""

from __future__ import annotations

from typing import Dict, Tuple

# (tag, source group, tagger vocabularies: S = WD v3 pair, P = PixAI)
_ROWS: Tuple[Tuple[str, str, str], ...] = (
    # medium and technique
    ("sketch", "medium", "SP"),
    ("lineart", "colors", "SP"),
    ("traditional_media", "medium", "S"),
    ("faux_traditional_media", "medium", "SP"),
    ("watercolor_(medium)", "medium", "S"),
    ("watercolor_pencil_(medium)", "medium", "S"),
    ("painting_(medium)", "medium", "S"),
    ("acrylic_paint_(medium)", "medium", "S"),
    ("ink_(medium)", "medium", "S"),
    ("marker_(medium)", "medium", "S"),
    ("colored_pencil_(medium)", "medium", "S"),
    ("pastel_(medium)", "medium", "S"),
    ("graphite_(medium)", "medium", "S"),
    ("oekaki", "medium", "SP"),
    ("3d", "medium", "P"),
    ("pixel_art", "medium", "P"),
    ("low_poly", "aesthetic", "P"),
    ("cel_shading", "medium", "P"),
    ("flat_color", "colors", "SP"),
    ("anime_coloring", "colors", "SP"),
    ("color_trace", "colors", "SP"),
    ("blending", "colors", "SP"),
    ("ligne_claire", "colors", "SP"),
    ("painterly", "medium", "SP"),
    ("halftone", "medium", "SP"),
    ("chibi", "medium", "SP"),
    ("western_comics_(style)", "aesthetic", "SP"),
    ("toon_(style)", "aesthetic", "P"),
    # colour treatment
    ("monochrome", "colors", "SP"),
    ("greyscale", "colors", "SP"),
    ("partially_colored", "colors", "SP"),
    ("greyscale_with_colored_background", "colors", "SP"),
    ("spot_color", "colors", "SP"),
    ("limited_palette", "colors", "SP"),
    ("muted_color", "colors", "SP"),
    ("pastel_colors", "colors", "SP"),
    ("sepia", "colors", "SP"),
    ("high_contrast", "colors", "SP"),
    ("colorful", "colors", "SP"),
    ("neon_palette", "colors", "P"),
    # rendering and filters
    ("vignetting", "colors", "SP"),
    ("chromatic_aberration", "colors", "SP"),
    ("film_grain", "composition", "SP"),
    ("double_exposure", "colors", "P"),
    ("glitch", "aesthetic", "SP"),
    # art style and era
    ("realistic", "composition", "SP"),
    ("photorealistic", "composition", "SP"),
    ("abstract", "aesthetic", "SP"),
    ("surreal", "aesthetic", "SP"),
    ("art_nouveau", "aesthetic", "SP"),
    ("nihonga", "aesthetic", "P"),
    ("retro_artstyle", "aesthetic", "SP"),
    ("1970s_(style)", "aesthetic", "SP"),
    ("1980s_(style)", "aesthetic", "SP"),
    ("1990s_(style)", "aesthetic", "SP"),
    ("2000s_(style)", "aesthetic", "SP"),
)

STYLE_AXIS_TAGS: Tuple[str, ...] = tuple(row[0] for row in _ROWS)
STYLE_AXIS_TAG_SET = frozenset(STYLE_AXIS_TAGS)
STYLE_AXIS_SOURCES: Dict[str, str] = {row[0]: row[1] for row in _ROWS}
