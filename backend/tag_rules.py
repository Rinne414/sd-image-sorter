"""
Tag categorization rules and built-in mappings for SD Image Sorter.

Provides automatic tag categorization, tag sets (outfit groups),
and exclusion rules for intelligent prompt generation.
"""
import csv
import logging
import re
from pathlib import Path
from typing import Dict, List, Optional, Set, Tuple

logger = logging.getLogger(__name__)

# ============================================================
# Tag Category Mappings
# ============================================================
# Maps tag patterns to categories. Checked in order — first match wins.
# Patterns can be exact matches or prefix/suffix patterns.

# Meta tags (composition/count)
META_TAGS = {
    "1girl", "2girls", "3girls", "4girls", "5girls", "6+girls", "multiple_girls",
    "1boy", "2boys", "3boys", "4boys", "5boys", "6+boys", "multiple_boys",
    "solo", "duo", "trio", "group", "crowd",
    "1other", "androgynous", "male_focus", "female_focus",
    "comic", "4koma", "multiple_views", "highres", "absurdres",
    "tall_image", "wide_image", "portrait", "landscape",
    "signature", "artist_name", "twitter_username", "pixiv_username",
    "watermark", "username", "web_address", "url",
    "english_text", "japanese_text", "chinese_text", "korean_text", "text_focus",
    "speech_bubble", "thought_bubble", "spoken_heart", "spoken_ellipsis",
    "character_name", "copyright_name", "dated", "commission",
    "character_sheet", "reference_sheet", "concept_art",
    "check_translation", "translated", "partially_translated",
    "commentary", "commentary_request", "paid_reward_available",
    "cover", "cover_page", "novel_cover", "album_cover",
}

# Quality / booster tags
QUALITY_TAGS = {
    "masterpiece", "best_quality", "high_quality", "very_aesthetic",
    "amazing_quality", "absurdres", "highres", "incredibly_absurdres",
    "best quality", "amazing quality", "very aesthetic", "newest",
    "year_2024", "year_2025", "year_2026", "very_awa", "very awa",
    "huge_filesize", "huge filesize", "ultra-detailed", "high_resolution",
}

# Rating tags
RATING_TAGS = {
    "general", "sensitive", "questionable", "explicit",
    "nsfw", "sfw", "safe",
}

# Expression tags
EXPRESSION_TAGS = {
    "smile", "grin", "smirk", "frown", "angry", "crying", "tears",
    "blush", "embarrassed", "surprised", "shocked", "scared", "confused",
    "laughing", "open_mouth", "closed_mouth", "pout", "ahegao",
    "closed_eyes", "half-closed_eyes", "one_eye_closed", "wink",
    "looking_at_viewer", "looking_away", "looking_up", "looking_down",
    "looking_to_the_side", "looking_back", "eye_contact",
    "expressionless", "serious", "seductive_smile", "evil_smile",
    "tongue", "tongue_out", "drooling", "nosebleed",
    "happy", "sad", "sleepy", "tired", "drunk",
    ":d", ":o", ":3", "^^", ";)", "xd", "^_^", ">_<", "o_o", "@_@",
    "v-shaped_eyebrows", "raised_eyebrow", "furrowed_brow",
}

# Pose tags
POSE_TAGS = {
    "standing", "sitting", "kneeling", "lying", "squatting", "crouching",
    "leaning_forward", "leaning_back", "bending_over", "arched_back",
    "spread_legs", "crossed_legs", "indian_style", "seiza", "wariza",
    "arms_up", "arms_behind_back", "arms_behind_head", "arms_crossed",
    "hand_on_hip", "hand_on_own_chest", "hands_on_hips",
    "hand_up", "hands_up", "reaching", "pointing", "peace_sign", "v",
    "walking", "running", "jumping", "falling", "floating",
    "stretching", "dancing", "fighting_stance", "action",
    "on_back", "on_stomach", "on_side", "fetal_position",
    "all_fours", "upside-down", "suspended", "straddling",
    "back-to-back", "facing_another", "facing_away",
    "hugging", "carrying", "piggyback", "princess_carry",
    "cowgirl_position", "missionary", "doggy_style",
    "head_tilt", "head_rest", "chin_rest", "turned_head",
}

# Camera angle tags
ANGLE_TAGS = {
    "from_above", "from_below", "from_side", "from_behind",
    "dutch_angle", "pov", "first-person_view",
    "close-up", "upper_body", "lower_body", "full_body",
    "portrait", "cowboy_shot", "medium_shot",
    "bird's-eye_view", "worm's-eye_view",
    "dynamic_angle", "foreshortening", "fisheye",
    "face_focus", "ass_focus", "breast_focus",
    "feet_focus", "navel_focus", "hand_focus",
    "profile", "back",
}

# Body feature tags
BODY_TAGS = {
    # Hair
    "long_hair", "short_hair", "medium_hair", "very_long_hair",
    "twintails", "ponytail", "braid", "twin_braids", "side_ponytail",
    "hair_bun", "messy_hair", "straight_hair", "wavy_hair", "curly_hair",
    "bangs", "blunt_bangs", "swept_bangs", "side_bangs", "parted_bangs",
    "ahoge", "antenna_hair", "hair_over_one_eye", "sidelocks",
    "drill_hair", "hime_cut", "bob_cut", "pixie_cut",
    # Hair colors
    "blonde_hair", "brown_hair", "black_hair", "white_hair", "silver_hair",
    "red_hair", "pink_hair", "blue_hair", "green_hair", "purple_hair",
    "orange_hair", "grey_hair", "multicolored_hair", "gradient_hair",
    "streaked_hair", "two-tone_hair", "light_brown_hair", "dark_blue_hair",
    # Eyes
    "blue_eyes", "red_eyes", "green_eyes", "brown_eyes", "purple_eyes",
    "yellow_eyes", "golden_eyes", "pink_eyes", "orange_eyes", "grey_eyes",
    "heterochromia", "multicolored_eyes", "glowing_eyes", "empty_eyes",
    "slit_pupils", "heart-shaped_pupils", "star-shaped_pupils",
    # Body
    "large_breasts", "medium_breasts", "small_breasts", "flat_chest",
    "huge_breasts", "gigantic_breasts",
    "narrow_waist", "wide_hips", "thick_thighs", "long_legs",
    "muscular", "slim", "petite", "tall", "short",
    "dark_skin", "pale_skin", "tan", "tanned",
    "pointy_ears", "animal_ears", "cat_ears", "dog_ears", "fox_ears",
    "tail", "cat_tail", "fox_tail", "wings", "horns", "halo",
    "fangs", "sharp_teeth",
}

# Action tags
ACTION_TAGS = {
    "holding", "eating", "drinking", "reading", "writing",
    "singing", "playing_instrument", "cooking", "sleeping",
    "bathing", "showering", "swimming", "diving",
    "fighting", "shooting", "slashing", "casting_spell",
    "flying", "riding", "driving", "surfing",
    "kissing", "hugging_another", "hand_holding",
    "undressing", "dressing", "adjusting_clothes",
    "selfie", "phone", "using_phone",
    "crying", "praying", "meditating",
    "sex", "oral", "penetration", "masturbation",
    "fellatio", "cunnilingus", "handjob", "footjob",
    "grabbing", "groping", "licking", "biting",
    "hug", "embrace", "bleeding", "blood",
}

# Background / setting tags
BACKGROUND_TAGS = {
    "outdoors", "indoors", "simple_background", "white_background",
    "gradient_background", "blue_background", "black_background",
    "grey_background", "pink_background",
    "classroom", "school", "bedroom", "bathroom", "kitchen",
    "office", "library", "church", "temple", "shrine",
    "beach", "ocean", "sea", "lake", "river", "waterfall",
    "forest", "mountain", "field", "garden", "park",
    "city", "street", "alley", "rooftop", "balcony",
    "night", "day", "sunset", "sunrise", "twilight",
    "sky", "clouds", "rain", "snow", "storm",
    "space", "starry_sky", "moon", "underwater",
    "castle", "ruins", "cave", "dungeon",
    "train", "bus", "car_interior", "airplane",
    "stage", "arena", "pool", "hot_spring", "onsen",
    "fantasy", "sci-fi", "cyberpunk", "steampunk",
}

# Style / art style tags
STYLE_TAGS = {
    "anime", "manga", "realistic", "photorealistic", "3d",
    "sketch", "line_art", "lineart", "monochrome", "greyscale",
    "watercolor", "oil_painting", "digital_painting",
    "pixel_art", "cel_shading", "flat_color",
    "chibi", "super_deformed", "kemonomimi_mode",
    "traditional_media", "mixed_media", "collage",
    "art_nouveau", "art_deco", "ukiyo-e", "retro",
    "dark_theme", "light_theme", "pastel",
    "detailed", "intricate", "ornate", "minimalist",
    "cinematic_lighting", "dramatic_lighting", "soft_lighting",
    "depth_of_field", "motion_blur", "bokeh", "lens_flare",
}

NSFW_BODY_KEYWORDS = {
    "nipple", "nipples", "penis", "pussy", "vagina", "vaginal", "anus", "ass",
    "butt", "buttocks", "cleavage", "testicles", "stomach", "midriff", "sideboob",
    "breast", "boob", "boobs", "navel", "crotch", "groin", "cameltoe", "clitoris",
    "veins", "toe", "toes", "soles", "toenails", "fingernails", "nails", "tattoo",
    "eyelash", "eyelashes", "lip", "lips", "mole", "freckle", "scar", "birthmark",
    "abs", "collarbone", "armpit", "thigh_gap", "dimples", "cheek",
}

OUTFIT_DETAIL_KEYWORDS = {
    "sleeve", "sleeves", "shoulder", "off_shoulder", "open_clothes", "torn_clothes",
    "see-through", "see_through", "detached_sleeves", "wide_sleeves", "frills", "jewelry",
    "hairband", "hairclip", "headwear", "footwear", "thigh_strap", "nail_polish",
    "alternate_costume", "costume", "plaid", "detached", "clothes_lift", "clothes_pull",
    "japanese_clothes", "camisole", "fishnets", "loafers", "strap_slip", "clothing_cutout", "clothing_aside",
    "strapless", "fur_trim", "striped_clothes", "polka_dot", "lace_trim",
    "frilled", "pleated", "layered", "corset", "sash", "obi", "ascot",
    "neckerchief", "wrist_cuff", "cuffs", "armlet", "pauldron", "gauntlet",
    "epaulette", "holster", "sheath", "zettai_ryouiki",
    "hood", "hood_up", "hood_down", "hooded",
}

BACKGROUND_OBJECT_KEYWORDS = {
    "bed", "pillow", "window", "couch", "curtain", "curtains", "chair", "desk",
    "lamp", "food", "water", "flower", "flowers", "room", "sheet", "bed_sheet",
    "cloud", "plant", "petals", "tiles", "bag", "cup", "cellphone", "smartphone", "headphones",
    "tree", "grass", "fence", "wall", "door", "table", "bench", "stairs",
    "bridge", "fountain", "statue", "candle", "lantern", "chandelier",
    "vehicle", "train", "bicycle", "motorcycle",
}

ACTION_DETAIL_KEYWORDS = {
    "sex", "hetero", "threesome", "girl_on_top", "ejaculation", "cum", "cumdrip",
    "cum_on_body", "cum_in_pussy", "cum_in_mouth", "cum_overflow", "projectile_cum",
    "after_sex", "after_vaginal", "clothed_sex", "group_sex", "paizuri", "bound",
    "bondage", "restrained", "bdsm", "weapon", "condom", "sex_toy", "breast_press",
    "bent_over", "lifted_by_self", "arm_support", "arm_up", "hand_on_own_hip",
    "female_masturbation", "gag", "gagged", "rope", "leash", "presenting_foot", "mouth_hold", "looking_at_another",
    "sword", "gun", "rifle", "pistol", "knife", "dagger", "axe", "bow_(weapon)",
    "staff", "wand", "shield", "spear", "hammer",
    "smoking", "playing", "typing", "drawing", "painting", "waving",
}

EXPRESSION_DETAIL_KEYWORDS = {
    "sweat", "saliva", "parted_lips", "trembling", "wet", "fang", "heart", "blurry",
    "pov_crotch", "mismatched_pupils", "symbol-shaped_pupils",
}

META_DETAIL_KEYWORDS = {
    "censored", "uncensored", "bar_censor", "virtual_youtuber",
    "text", "username", "watermark", "signature", "symbol",
    "spoken", "dated", "commentary", "translation",
}

CHARACTER_DETAIL_KEYWORDS = {
    "loli", "fox_girl", "cat_girl", "dragon_girl", "dark-skinned_male", "furina_(genshin_impact)",
    "yuri", "hetero", "interracial",
    "dark-skinned_female", "animal_ear_fluff",
    "cosplay", "siblings", "couple", "family", "twins",
}

# Hairstyle patterns — tags about hair arrangement → body
HAIRSTYLE_KEYWORDS = {
    "bun", "updo", "side_up", "two_side_up", "one_side_up", "low_twintails",
    "high_ponytail", "low_ponytail", "double_bun", "half_updo", "chignon",
    "ringlets", "dreadlocks", "afro", "mohawk", "undercut", "shaved",
    "hair_over_shoulder", "hair_between_eyes", "hair_intakes", "forehead",
    "hair_ribbon", "hair_flower", "hair_tubes", "hair_rings",
    "makeup", "eyeshadow", "lipstick", "blush_stickers", "skindentation",
}

# Object / prop keywords → background
OBJECT_PROP_KEYWORDS = {
    "book", "bell", "fruit", "rose", "bird", "cat", "dog", "horse",
    "fish", "butterfly", "snake", "rabbit", "fox", "wolf",
    "cake", "candy", "ice_cream", "wine", "tea", "coffee",
    "umbrella", "fan", "mirror", "clock", "flag", "guitar", "piano",
    "ball", "balloon", "ribbon", "chains", "cuffs",
}

# Effect / rendering keywords → style
EFFECT_KEYWORDS = {
    "sparkle", "sparks", "glow", "glowing", "bloom", "chromatic_aberration",
    "halftone", "gradient", "shadow", "silhouette", "backlighting",
    "rim_lighting", "ambient", "particle", "dust", "smoke",
    "fire", "ice", "lightning", "magic", "aura", "energy",
    "border", "frame", "vignette",
}

# Outfit tag patterns (checked by substring matching)
OUTFIT_KEYWORDS = [
    "uniform", "dress", "shirt", "blouse", "jacket", "coat",
    "skirt", "pants", "shorts", "jeans", "leggings",
    "bikini", "swimsuit", "one-piece", "lingerie", "underwear",
    "bra", "panties", "thong", "stockings", "pantyhose",
    "socks", "thighhighs", "kneehighs", "boots", "shoes",
    "heels", "sandals", "sneakers", "slippers",
    "hat", "cap", "beret", "crown", "tiara", "headband",
    "ribbon", "bow", "hairpin", "hair_ornament",
    "glasses", "sunglasses", "monocle", "eyepatch",
    "necklace", "choker", "collar", "tie", "necktie",
    "scarf", "cape", "cloak", "apron", "gloves",
    "armor", "maid", "nurse", "military", "police",
    "school_uniform", "serafuku", "sailor", "blazer",
    "kimono", "yukata", "chinese_clothes", "hanfu",
    "leotard", "bodysuit", "jumpsuit", "overalls",
    "crop_top", "tank_top", "hoodie", "sweater", "vest",
    "bare", "naked", "nude", "topless", "bottomless",
    "towel", "sarong", "robe", "pajamas",
    "belt", "suspenders", "garter", "wristband", "bracelet",
    "earrings", "ring", "anklet", "piercing",
    "mask", "bandage", "headgear", "headpiece",
    "turtleneck", "highleg", "halterneck", "miniskirt",
    "micro_bikini", "side-tie", "string_bikini",
]

# ============================================================
# WD14 Character Tag Cache
# ============================================================
# Loaded lazily from selected_tags.csv files (category 4 = character)

_wd14_character_tags: Optional[Set[str]] = None


def _load_wd14_character_tags() -> Set[str]:
    """Load character tag names from all available WD14 selected_tags.csv files."""
    global _wd14_character_tags
    if _wd14_character_tags is not None:
        return _wd14_character_tags

    tags: Set[str] = set()
    try:
        from config import get_wd14_model_dir
        wd14_root = Path(get_wd14_model_dir())
    except Exception:
        # config might not be importable in all contexts; try relative path
        wd14_root = Path(__file__).resolve().parent.parent / "models" / "wd14-tagger"

    if not wd14_root.exists():
        _wd14_character_tags = tags
        return tags

    for csv_path in wd14_root.glob("*/selected_tags.csv"):
        try:
            with csv_path.open("r", encoding="utf-8") as f:
                reader = csv.DictReader(f)
                for row in reader:
                    if row.get("category") == "4":
                        tag_name = row.get("name", "").strip()
                        if tag_name:
                            tags.add(tag_name.lower().replace(" ", "_"))
        except Exception as exc:
            logger.debug("Failed to load character tags from %s: %s", csv_path, exc)

    logger.info("Loaded %d character tags from WD14 model files", len(tags))
    _wd14_character_tags = tags
    return tags


# Known franchise suffixes — tags matching `name_(franchise)` are characters
_FRANCHISE_SUFFIXES = {
    "kancolle", "kantai_collection", "fate", "genshin_impact", "honkai",
    "blue_archive", "umamusume", "azur_lane", "arknights", "touhou",
    "vocaloid", "pokemon", "naruto", "one_piece", "dragon_ball",
    "final_fantasy", "ff14", "ff7", "ff10", "idolmaster", "love_live",
    "bang_dream", "hololive", "nijisanji", "virtual_youtuber",
    "sword_art_online", "attack_on_titan", "demon_slayer", "jujutsu_kaisen",
    "spy_x_family", "re:zero", "konosuba", "overlord", "elden_ring",
    "original", "commission", "original_character",
}

# Pattern: name_(franchise) — very strong character signal
_FRANCHISE_PATTERN = re.compile(
    r"^[a-z][a-z0-9_]*\((" + "|".join(re.escape(f) for f in sorted(_FRANCHISE_SUFFIXES)) + r")\)$"
)


def categorize_tag(tag: str) -> str:
    """
    Categorize a single tag into a semantic category.

    Returns one of: character, artist, outfit, pose, body, expression,
    background, action, style, quality, meta, rating, angle, unknown
    """
    tag_lower = tag.lower().replace(" ", "_")

    # Exact set lookups first (fast)
    if tag_lower in RATING_TAGS:
        return "rating"
    if tag_lower in QUALITY_TAGS:
        return "quality"
    if tag_lower in META_TAGS:
        return "meta"
    if tag_lower in EXPRESSION_TAGS:
        return "expression"
    if tag_lower in POSE_TAGS:
        return "pose"
    if tag_lower in ANGLE_TAGS:
        return "angle"
    if tag_lower in BODY_TAGS:
        return "body"
    if tag_lower in ACTION_TAGS:
        return "action"
    if tag_lower in BACKGROUND_TAGS:
        return "background"
    if tag_lower in STYLE_TAGS:
        return "style"

    # Artist detection (prompt convention: "artist:name" or "(artist_name:weight)")
    if tag_lower.startswith("artist:") or tag_lower.startswith("artist_"):
        return "artist"

    # WD14-based character detection (loaded from selected_tags.csv) — checked
    # early because substring-based keyword matching below can false-positive
    # on character names (e.g. "hat" matching "hatsune_miku").
    wd14_chars = _load_wd14_character_tags()
    if wd14_chars and tag_lower in wd14_chars:
        return "character"

    # Franchise-suffix heuristic: name_(franchise) → character
    compact = tag_lower.replace("_(", "(").replace(")_", ")")
    if _FRANCHISE_PATTERN.match(compact):
        return "character"

    paren_match = re.search(r"\(([^)]+)\)$", tag_lower)
    if paren_match:
        franchise = paren_match.group(1).replace(" ", "_")
        if franchise in _FRANCHISE_SUFFIXES:
            return "character"

    tokens = {token for token in re.split(r"[_\-\s]+", tag_lower) if token}

    if re.match(r"^(year|era)_\d{4}$", tag_lower) or tokens.intersection({"year", "version", "resolution", "filesize", "ratio"}):
        return "meta"

    if tag_lower.endswith("_focus") or tag_lower.endswith("_view") or tag_lower.endswith("_shot") or tag_lower.startswith("from_"):
        return "angle"

    if tag_lower.endswith("_style") or tag_lower.endswith("style") or "lineart" in tag_lower or "render" in tag_lower:
        return "style"

    if tokens.intersection({"smile", "blush", "wink", "grin", "laughing", "crying", "expressionless", "seductive", "embarrassed", "surprised"}):
        return "expression"

    if tokens.intersection({"standing", "sitting", "kneeling", "lying", "leaning", "pose", "stretching", "jumping", "walking", "running", "hugging", "dancing", "squatting", "crouching", "floating", "tilt", "bent", "crossed"}):
        return "pose"

    if tokens.intersection({"outdoors", "indoors", "beach", "ocean", "sea", "sky", "forest", "night", "day", "sunset", "sunrise", "room", "bedroom", "bathroom", "classroom", "city", "street", "park", "garden", "field"}):
        return "background"

    if tokens.intersection({"hair", "eyes", "breasts", "chest", "thighs", "legs", "skin", "ears", "tail", "wings", "horns", "fangs", "teeth", "navel", "belly", "feet", "armpits"}):
        return "body"

    if tokens.intersection({"holding", "grabbing", "touching", "kissing", "licking", "biting", "reading", "writing", "drinking", "eating", "swimming"}):
        return "action"

    if any(keyword in tag_lower for keyword in NSFW_BODY_KEYWORDS):
        return "body"

    if any(keyword in tag_lower for keyword in OUTFIT_DETAIL_KEYWORDS):
        return "outfit"

    if any(keyword in tag_lower for keyword in BACKGROUND_OBJECT_KEYWORDS):
        return "background"

    if any(keyword in tag_lower for keyword in ACTION_DETAIL_KEYWORDS):
        return "action"

    if any(keyword in tag_lower for keyword in EXPRESSION_DETAIL_KEYWORDS):
        return "expression"

    if any(keyword in tag_lower for keyword in META_DETAIL_KEYWORDS):
        return "meta"

    if any(keyword in tag_lower for keyword in CHARACTER_DETAIL_KEYWORDS):
        return "character"

    # Outfit detection via keyword matching
    for keyword in OUTFIT_KEYWORDS:
        if keyword in tag_lower:
            return "outfit"

    # Hair/eye color tags that might not be in the BODY set
    if "_hair" in tag_lower or "_eyes" in tag_lower:
        return "body"

    # Hairstyle and body-detail patterns
    if any(keyword in tag_lower for keyword in HAIRSTYLE_KEYWORDS):
        return "body"

    # Object/prop keywords → background
    if any(keyword in tag_lower for keyword in OBJECT_PROP_KEYWORDS):
        return "background"

    # Effect/rendering keywords → style
    if any(keyword in tag_lower for keyword in EFFECT_KEYWORDS):
        return "style"

    # Meta heuristic: tags about image structure/annotations
    if tag_lower.startswith("no_") or tag_lower.startswith("non-") or tag_lower.endswith("_request"):
        return "meta"

    return "unknown"


def categorize_tags_batch(tags: List[str]) -> Dict[str, str]:
    """Categorize multiple tags at once. Returns {tag: category}."""
    return {tag: categorize_tag(tag) for tag in tags}


# ============================================================
# Built-in Tag Sets (outfits that go together)
# ============================================================

BUILTIN_TAG_SETS = [
    {
        "name": "School Uniform (Sailor)",
        "category": "outfit",
        "tags": [
            {"tag": "school_uniform", "weight": 1.0, "required": True},
            {"tag": "sailor_collar", "weight": 0.8, "required": False},
            {"tag": "serafuku", "weight": 0.7, "required": False},
            {"tag": "pleated_skirt", "weight": 0.9, "required": False},
            {"tag": "neckerchief", "weight": 0.5, "required": False},
            {"tag": "white_shirt", "weight": 0.6, "required": False},
            {"tag": "kneehighs", "weight": 0.5, "required": False},
        ]
    },
    {
        "name": "School Uniform (Blazer)",
        "category": "outfit",
        "tags": [
            {"tag": "school_uniform", "weight": 1.0, "required": True},
            {"tag": "blazer", "weight": 0.9, "required": True},
            {"tag": "pleated_skirt", "weight": 0.8, "required": False},
            {"tag": "white_shirt", "weight": 0.7, "required": False},
            {"tag": "necktie", "weight": 0.5, "required": False},
            {"tag": "thighhighs", "weight": 0.4, "required": False},
        ]
    },
    {
        "name": "Bikini",
        "category": "outfit",
        "tags": [
            {"tag": "bikini", "weight": 1.0, "required": True},
            {"tag": "bikini_top", "weight": 0.6, "required": False},
            {"tag": "bikini_bottom", "weight": 0.6, "required": False},
            {"tag": "navel", "weight": 0.7, "required": False},
            {"tag": "barefoot", "weight": 0.3, "required": False},
        ]
    },
    {
        "name": "Maid Outfit",
        "category": "outfit",
        "tags": [
            {"tag": "maid", "weight": 1.0, "required": True},
            {"tag": "maid_headdress", "weight": 0.9, "required": True},
            {"tag": "apron", "weight": 0.8, "required": False},
            {"tag": "frilled_apron", "weight": 0.6, "required": False},
            {"tag": "black_dress", "weight": 0.5, "required": False},
            {"tag": "white_apron", "weight": 0.5, "required": False},
        ]
    },
    {
        "name": "Chinese Dress",
        "category": "outfit",
        "tags": [
            {"tag": "china_dress", "weight": 1.0, "required": True},
            {"tag": "side_slit", "weight": 0.7, "required": False},
            {"tag": "mandarin_collar", "weight": 0.5, "required": False},
            {"tag": "floral_print", "weight": 0.3, "required": False},
        ]
    },
    {
        "name": "Kimono",
        "category": "outfit",
        "tags": [
            {"tag": "kimono", "weight": 1.0, "required": True},
            {"tag": "obi", "weight": 0.8, "required": False},
            {"tag": "japanese_clothes", "weight": 0.7, "required": False},
            {"tag": "wide_sleeves", "weight": 0.5, "required": False},
            {"tag": "sandals", "weight": 0.3, "required": False},
        ]
    },
    {
        "name": "Casual (Summer)",
        "category": "outfit",
        "tags": [
            {"tag": "casual", "weight": 1.0, "required": False},
            {"tag": "t-shirt", "weight": 0.7, "required": False},
            {"tag": "shorts", "weight": 0.6, "required": False},
            {"tag": "sneakers", "weight": 0.3, "required": False},
            {"tag": "sundress", "weight": 0.5, "required": False},
        ]
    },
    {
        "name": "Lingerie",
        "category": "outfit",
        "tags": [
            {"tag": "lingerie", "weight": 1.0, "required": True},
            {"tag": "bra", "weight": 0.7, "required": False},
            {"tag": "panties", "weight": 0.7, "required": False},
            {"tag": "garter_belt", "weight": 0.5, "required": False},
            {"tag": "thighhighs", "weight": 0.5, "required": False},
            {"tag": "lace", "weight": 0.4, "required": False},
        ]
    },
    {
        "name": "Nude",
        "category": "outfit",
        "tags": [
            {"tag": "nude", "weight": 1.0, "required": True},
            {"tag": "completely_nude", "weight": 0.5, "required": False},
            {"tag": "navel", "weight": 0.6, "required": False},
            {"tag": "barefoot", "weight": 0.3, "required": False},
        ]
    },
    {
        "name": "Witch",
        "category": "outfit",
        "tags": [
            {"tag": "witch", "weight": 1.0, "required": True},
            {"tag": "witch_hat", "weight": 0.9, "required": True},
            {"tag": "cape", "weight": 0.5, "required": False},
            {"tag": "staff", "weight": 0.4, "required": False},
            {"tag": "black_dress", "weight": 0.5, "required": False},
        ]
    },
]

# ============================================================
# Built-in Exclusion Rules
# ============================================================

BUILTIN_EXCLUSION_RULES = [
    {
        "name": "back_view_excludes_face",
        "description": "When character faces away, exclude direct facial features",
        "conditions": [
            {"tag": "from_behind", "type": "present"},
        ],
        "targets": [
            {"tag": "looking_at_viewer"},
            {"tag": "eye_contact"},
            {"category": None, "tag": "blue_eyes"},
            {"category": None, "tag": "red_eyes"},
            {"category": None, "tag": "green_eyes"},
            {"category": None, "tag": "brown_eyes"},
            {"category": None, "tag": "purple_eyes"},
            {"category": None, "tag": "yellow_eyes"},
            {"category": None, "tag": "golden_eyes"},
            {"category": None, "tag": "pink_eyes"},
            {"category": None, "tag": "orange_eyes"},
            {"tag": "smile"},
            {"tag": "grin"},
            {"tag": "open_mouth"},
            {"tag": "blush"},
            {"tag": "wink"},
            {"tag": "tongue_out"},
        ]
    },
    {
        "name": "facing_away_excludes_face",
        "description": "When facing away, exclude eye/expression details",
        "conditions": [
            {"tag": "facing_away", "type": "present"},
        ],
        "targets": [
            {"tag": "looking_at_viewer"},
            {"tag": "smile"},
            {"tag": "blush"},
        ]
    },
    {
        "name": "closed_eyes_excludes_eye_color",
        "description": "When eyes are closed, eye color is invisible",
        "conditions": [
            {"tag": "closed_eyes", "type": "present"},
        ],
        "targets": [
            {"tag": "blue_eyes"},
            {"tag": "red_eyes"},
            {"tag": "green_eyes"},
            {"tag": "brown_eyes"},
            {"tag": "purple_eyes"},
            {"tag": "yellow_eyes"},
            {"tag": "golden_eyes"},
            {"tag": "pink_eyes"},
            {"tag": "glowing_eyes"},
            {"tag": "heterochromia"},
            {"tag": "slit_pupils"},
        ]
    },
    {
        "name": "nude_excludes_outfit",
        "description": "When nude, most outfit tags are contradictory",
        "conditions": [
            {"tag": "nude", "type": "present"},
        ],
        "targets": [
            {"tag": "school_uniform"},
            {"tag": "dress"},
            {"tag": "shirt"},
            {"tag": "skirt"},
            {"tag": "pants"},
            {"tag": "bikini"},
            {"tag": "swimsuit"},
            {"tag": "kimono"},
            {"tag": "maid"},
            {"tag": "armor"},
            {"tag": "jacket"},
            {"tag": "coat"},
            {"tag": "blazer"},
            {"tag": "sweater"},
            {"tag": "hoodie"},
        ]
    },
    {
        "name": "monochrome_excludes_colors",
        "description": "Monochrome/greyscale makes color tags meaningless",
        "conditions": [
            {"tag": "monochrome", "type": "present"},
        ],
        "targets": [
            {"tag": "blonde_hair"},
            {"tag": "blue_hair"},
            {"tag": "red_hair"},
            {"tag": "pink_hair"},
            {"tag": "green_hair"},
            {"tag": "purple_hair"},
            {"tag": "blue_eyes"},
            {"tag": "red_eyes"},
            {"tag": "green_eyes"},
        ]
    },
    {
        "name": "solo_excludes_interaction",
        "description": "Solo images shouldn't have interaction tags",
        "conditions": [
            {"tag": "solo", "type": "present"},
        ],
        "targets": [
            {"tag": "kissing"},
            {"tag": "hugging_another"},
            {"tag": "hand_holding"},
            {"tag": "sex"},
            {"tag": "straddling"},
            {"tag": "back-to-back"},
        ]
    },
]

# ============================================================
# Weighted random selection groups
# ============================================================

WEIGHTED_GROUPS = {
    "pose": [
        ("standing", 35),
        ("sitting", 20),
        ("lying", 10),
        ("kneeling", 8),
        ("squatting", 5),
        ("walking", 5),
        ("leaning_forward", 5),
        ("arms_up", 4),
        ("all_fours", 3),
        ("floating", 3),
        ("crouching", 2),
    ],
    "expression": [
        ("smile", 25),
        ("blush", 15),
        ("open_mouth", 10),
        ("closed_eyes", 8),
        ("looking_at_viewer", 15),
        ("serious", 8),
        ("embarrassed", 5),
        ("wink", 4),
        ("tongue_out", 3),
        ("crying", 2),
        ("expressionless", 5),
    ],
    "angle": [
        ("upper_body", 25),
        ("cowboy_shot", 20),
        ("full_body", 15),
        ("close-up", 10),
        ("from_above", 8),
        ("from_below", 5),
        ("from_side", 7),
        ("from_behind", 5),
        ("pov", 5),
    ],
}


def get_exclusion_targets(active_tags: Set[str], rules: List[dict]) -> Set[str]:
    """
    Given a set of active tags and exclusion rules,
    return the set of tags that should be excluded.
    """
    excluded = set()

    for rule in rules:
        conditions = rule.get("conditions", [])
        targets = rule.get("targets", [])

        # Check if all conditions are met
        conditions_met = True
        for cond in conditions:
            cond_tag = cond["tag"].lower().replace(" ", "_")
            cond_type = cond.get("type", "present")

            tag_present = any(
                cond_tag in t.lower().replace(" ", "_")
                for t in active_tags
            )

            if cond_type == "present" and not tag_present:
                conditions_met = False
                break
            elif cond_type == "absent" and tag_present:
                conditions_met = False
                break

        if conditions_met:
            for target in targets:
                if "tag" in target and target["tag"]:
                    excluded.add(target["tag"].lower().replace(" ", "_"))
                if "category" in target and target.get("category"):
                    # Category-level exclusion would need the categorize_tag function
                    # For now, individual tag targets are sufficient
                    pass

    return excluded
