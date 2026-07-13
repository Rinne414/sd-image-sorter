"""_FRANCHISE_SUFFIXES and the compiled _FRANCHISE_PATTERN
(verbatim from tag_rules).

The pattern derivation MUST stay in this module, AFTER the suffix set
(pinned by tests/test_tag_rules_pins.py::TestDerivedConstants).
"""

import re

# Known franchise suffixes — tags matching `name_(franchise)` are characters
_FRANCHISE_SUFFIXES = {
    "kancolle",
    "kantai_collection",
    "fate",
    "genshin_impact",
    "honkai",
    "blue_archive",
    "umamusume",
    "azur_lane",
    "arknights",
    "touhou",
    "vocaloid",
    "pokemon",
    "naruto",
    "one_piece",
    "dragon_ball",
    "final_fantasy",
    "ff14",
    "ff7",
    "ff10",
    "idolmaster",
    "love_live",
    "bang_dream",
    "hololive",
    "nijisanji",
    "virtual_youtuber",
    "sword_art_online",
    "attack_on_titan",
    "demon_slayer",
    "jujutsu_kaisen",
    "spy_x_family",
    "re:zero",
    "konosuba",
    "overlord",
    "elden_ring",
    "original",
    "commission",
    "original_character",
}

# Pattern: name_(franchise) — very strong character signal
_FRANCHISE_PATTERN = re.compile(
    r"^[a-z][a-z0-9_]*\(("
    + "|".join(re.escape(f) for f in sorted(_FRANCHISE_SUFFIXES))
    + r")\)$"
)
