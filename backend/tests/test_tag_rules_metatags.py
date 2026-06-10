"""Unit tests for tag_rules.categorize_tag danbooru metatag handling.

Guards the v3.3.x dataset-maker tag-color/group feature: every tag must land in
one of the 14 categories the frontend renders, and the unambiguous danbooru
colon/score metatags must not fall through to 'unknown'.
"""
import csv
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from tag_rules import categorize_tag  # noqa: E402

CATEGORIES = {
    "character", "artist", "outfit", "pose", "body", "expression",
    "background", "action", "style", "quality", "meta", "rating", "angle", "unknown",
}


def test_danbooru_rating_metatag_is_rating():
    assert categorize_tag("rating:safe") == "rating"
    assert categorize_tag("rating:questionable") == "rating"
    assert categorize_tag("rating:explicit") == "rating"


def test_score_metatags_are_quality():
    assert categorize_tag("score:8") == "quality"
    assert categorize_tag("score_9") == "quality"
    assert categorize_tag("score_8_up") == "quality"


def test_score_prefix_does_not_overmatch_real_words():
    # "scoreboard" must NOT be miscategorized as quality by the score_ prefix rule.
    assert categorize_tag("scoreboard") != "quality"


def test_common_tags_keep_expected_groups():
    expected = {
        "masterpiece": "quality",
        "1girl": "character",
        "solo": "character",
        "multiple_girls": "character",
        "blue_eyes": "body",
        "school_uniform": "outfit",
        "standing": "pose",
        "smile": "expression",
        "from_above": "angle",
        "holding": "action",
        "outdoors": "background",
        "watercolor": "style",
    }
    for tag, cat in expected.items():
        assert categorize_tag(tag) == cat, f"{tag} -> {categorize_tag(tag)} (expected {cat})"


def test_tagger_vocab_general_tags_get_semantic_groups():
    expected = {
        "anime girl": "character",
        "transparent_background": "background",
        "yellow_background": "background",
        "building": "background",
        "bush": "background",
        "burger": "background",
        "power_lines": "background",
        "utility_pole": "background",
        "facial_mark": "body",
        "thick_eyebrows": "body",
        "pectorals": "body",
        "cardigan": "outfit",
        "backpack": "outfit",
        "helmet": "outfit",
        "floral_print": "outfit",
        "single_thighhigh": "outfit",
        "leg_up": "pose",
        "own_hands_together": "pose",
        "hand_on_another's_face": "pose",
        "facing_viewer": "pose",
        "interlocked_fingers": "pose",
        "arm_behind_back": "pose",
        "short_twintails": "body",
        "multiple_tails": "body",
        "single_horn": "body",
        "cropped_torso": "body",
        "cherry_blossoms": "background",
        "scenery": "background",
        "full_moon": "background",
        "katana": "action",
        "pantyshot": "angle",
        "erection": "body",
        "lace": "outfit",
        "mary_janes": "outfit",
        "outline": "style",
        "motion_lines": "meta",
        ";d": "expression",
        ":<": "expression",
        ":t": "expression",
        "tomato": "background",
        "bulge": "body",
        "partially_unzipped": "outfit",
        "double_v": "pose",
        "blue_halo": "body",
        "looking_ahead": "expression",
        "straight-on": "angle",
        "pov_hands": "angle",
        "aged_up": "character",
        "minigirl": "character",
        "brother_and_sister": "character",
        "v_arms": "pose",
        "spread_arms": "pose",
        "top-down_bottom-up": "pose",
        "+_+": "expression",
        "=_=": "expression",
        "halloween": "style",
        "alternate_color": "style",
        "zoom_layer": "style",
        "teddy_bear": "background",
        "popsicle": "background",
        "chopsticks": "background",
        "spoon": "background",
        "camera": "background",
        "sportswear": "outfit",
        "bandana": "outfit",
        "mustache": "body",
        "eyeliner": "body",
        "bespectacled": "outfit",
        "gakuran": "outfit",
        "geta": "outfit",
        "tabi": "outfit",
        "bodystocking": "outfit",
        "tube_top": "outfit",
        "mittens": "outfit",
        "wristwatch": "outfit",
        "haori": "outfit",
        "shota": "character",
        "android": "character",
        "nun": "character",
        "angel": "character",
        "witch": "character",
        "fairy": "character",
        "vampire": "character",
        "yokozuwari": "pose",
        "leg_lift": "pose",
        "on_one_knee": "pose",
        "on_ground": "pose",
        "open_hand": "pose",
        "partially_visible_vulva": "body",
        "lactation": "body",
        "antlers": "body",
        "scales": "body",
        "whisker_markings": "body",
        "facepaint": "body",
        "basket": "background",
        "car": "background",
        "pen": "background",
        "controller": "background",
        "cable": "background",
        "tatami": "background",
        "torii": "background",
        "architecture": "background",
        "red_moon": "background",
        "dildo": "action",
        "gangbang": "action",
        "headpat": "action",
        "bukkake": "action",
        "shibari": "action",
        "imminent_penetration": "action",
        "public_indecency": "action",
        "orgasm": "action",
        "smug": "expression",
        "talking": "expression",
        "wince": "expression",
        "0_0": "expression",
        "zzz": "expression",
        "silent_comic": "meta",
        "3koma": "meta",
        "company_connection": "meta",
        "name_connection": "meta",
        "gameplay_mechanics": "meta",
        "bad_anatomy": "quality",
        "limited_palette": "style",
        "electricity": "style",
        "cheerleader": "outfit",
        "name_tag": "outfit",
        "ear_ornament": "outfit",
        "harness": "outfit",
        "greaves": "outfit",
        "single_shoe": "outfit",
        "negligee": "outfit",
        "tutu": "outfit",
        "uwabaki": "outfit",
        "presenting": "pose",
        "thumbs_up": "pose",
        "head_down": "pose",
        "between_fingers": "pose",
        "reclining": "pose",
        "annoyed": "expression",
        "nervous": "expression",
        "moaning": "expression",
        "shouting": "expression",
        "yawning": "expression",
        "panicking": "expression",
        "gyaru": "character",
        "giantess": "character",
        "cyborg": "character",
        "jiangshi": "character",
        "superhero": "character",
        "seraph": "character",
        "foreskin": "body",
        "huge_ahoge": "body",
        "extra_arms": "body",
        "topknot": "body",
        "bruise": "body",
        "ribs": "body",
        "paintbrush": "background",
        "frog": "background",
        "vines": "background",
        "house": "background",
        "doughnut": "background",
        "monitor": "background",
        "chalkboard": "background",
        "elevator": "background",
        "digital_media_player": "background",
        "cookie": "background",
        "eighth_note": "background",
        "pulled_by_self": "action",
        "kicking": "action",
        "peeing": "action",
        "69": "action",
        "deepthroat": "action",
        "orgy": "action",
        "murder": "action",
        "after_fellatio": "action",
        "prone_bone": "action",
        "strangling": "action",
        "asphyxiation": "action",
        "foot_worship": "action",
        "incest": "action",
        "humiliation": "action",
        "public_use": "action",
        "defloration": "action",
        "suggestive_fluid": "body",
        "median_furrow": "body",
        "obese": "body",
        "material_growth": "body",
        "long_tongue": "expression",
        "squeans": "expression",
        "shower_head": "background",
        "gym": "background",
        "rubber_duck": "background",
        "bulletin_board": "background",
        "still_life": "style",
        "tally": "meta",
        "take_your_pick": "meta",
        "side-by-side": "meta",
        "trefoil": "meta",
        "handstand": "pose",
        "dorsiflexion": "pose",
        "choke_hold": "action",
        "lamia": "character",
        "kyuubi": "character",
        "wedgie": "outfit",
        "zenra": "outfit",
        "nudist": "outfit",
        "too_many": "meta",
        "company_name": "meta",
        "content_rating": "meta",
        "roman_numeral": "meta",
        "square_4koma": "meta",
        "partially_colored": "style",
        "negative_space": "style",
        "high_contrast": "style",
        "rotational_symmetry": "style",
        "film_grain": "style",
    }
    for tag, cat in expected.items():
        assert categorize_tag(tag) == cat, f"{tag} -> {categorize_tag(tag)} (expected {cat})"


def test_pose_v_rule_does_not_overmatch_clothing_necklines():
    assert categorize_tag("v-neck") != "pose"


# v3.4.0 regression guard for the v3.3.3/v3.3.4 categorize_tag reorder bug:
# generic object nouns in BACKGROUND_DETAIL_TOKENS / BACKGROUND_OBJECT_KEYWORDS
# (tank, pencil, key, shell, egg, moon, winter, summer, frog, cherry, ...)
# must not steal garment/action/body tags from their categories.
def test_generic_object_nouns_do_not_steal_outfit_tags():
    expected_outfit = [
        "tank_top", "pencil_skirt", "key_necklace", "shell_bikini",
        "winter_coat", "summer_uniform", "moon_print", "cherry_blossom_print",
        "winter_clothes",
    ]
    for tag in expected_outfit:
        assert categorize_tag(tag) == "outfit", f"{tag} -> {categorize_tag(tag)} (expected outfit)"


def test_generic_object_nouns_do_not_steal_action_and_body_tags():
    assert categorize_tag("holding_egg") == "action"
    assert categorize_tag("egg_hair_ornament") == "body"
    assert categorize_tag("frog_hair_ornament") == "body"


def test_genuine_background_tags_stay_background():
    """The outfit/body/action precedence fix must not overcorrect: genuine
    scenery/object tags keep their background classification."""
    expected_background = [
        # exact scenery/object tags
        "house", "indoors", "outdoors", "cityscape", "tank", "winter",
        "summer", "egg", "pencil", "key", "shell", "moon",
        # suffix / token / keyword rules
        "forest_background", "night_sky", "wooden_floor", "full_moon",
        # "bra" in OUTFIT_KEYWORDS must not veto "branch"/"branches"
        "branch", "branches", "tree", "scenery",
    ]
    for tag in expected_background:
        assert categorize_tag(tag) == "background", f"{tag} -> {categorize_tag(tag)} (expected background)"


def test_shot_suffix_rule_only_matches_underscore_shot():
    """endswith("shot") misrouted screenshots into "angle" (v3.3.4)."""
    assert categorize_tag("cowboy_shot") == "angle"
    assert categorize_tag("wide_shot") == "angle"
    assert categorize_tag("pantyshot") == "angle"
    assert categorize_tag("anime_screenshot") == "meta"
    assert categorize_tag("screenshot") == "meta"
    assert categorize_tag("game_screenshot") == "meta"


def test_all_local_tagger_csv_tags_are_categorized():
    repo_root = Path(__file__).resolve().parents[2]
    csv_paths = []
    for root in [
        repo_root / "data" / "models" / "wd14-tagger",
        repo_root / "models" / "wd14-tagger",
        repo_root / "data" / "models" / "oppai-oracle",
    ]:
        if root.exists():
            csv_paths.extend(root.rglob("selected_tags.csv"))
    csv_paths = sorted(set(csv_paths))
    if not csv_paths:
        pytest.skip("No local tagger selected_tags.csv files are available")

    unknown = []
    for csv_path in csv_paths:
        with csv_path.open("r", encoding="utf-8-sig") as handle:
            for row in csv.DictReader(handle):
                tag = (row.get("name") or "").strip()
                if tag and categorize_tag(tag) == "unknown":
                    unknown.append(f"{csv_path.parent.name}:{tag}")

    assert unknown == []


def test_made_up_tags_still_fall_back_to_unknown():
    assert categorize_tag("zzz_made_up_tag") == "unknown"


def test_every_result_is_a_known_category():
    sample = [
        "masterpiece", "1girl", "blue_eyes", "school_uniform", "standing",
        "looking_at_viewer", "from_above", "holding_cup", "outdoors", "watercolor",
        "rating:safe", "score_9", "zzz_made_up_tag",
    ]
    for tag in sample:
        assert categorize_tag(tag) in CATEGORIES
