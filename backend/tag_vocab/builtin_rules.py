"""Built-in tag sets, exclusion rules and weighted groups
(verbatim from tag_rules).

Data-only module; import via the tag_rules facade, not from here.
"""

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
        ],
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
        ],
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
        ],
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
        ],
    },
    {
        "name": "Chinese Dress",
        "category": "outfit",
        "tags": [
            {"tag": "china_dress", "weight": 1.0, "required": True},
            {"tag": "side_slit", "weight": 0.7, "required": False},
            {"tag": "mandarin_collar", "weight": 0.5, "required": False},
            {"tag": "floral_print", "weight": 0.3, "required": False},
        ],
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
        ],
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
        ],
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
        ],
    },
    {
        "name": "Nude",
        "category": "outfit",
        "tags": [
            {"tag": "nude", "weight": 1.0, "required": True},
            {"tag": "completely_nude", "weight": 0.5, "required": False},
            {"tag": "navel", "weight": 0.6, "required": False},
            {"tag": "barefoot", "weight": 0.3, "required": False},
        ],
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
        ],
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
        ],
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
        ],
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
        ],
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
        ],
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
        ],
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
        ],
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
