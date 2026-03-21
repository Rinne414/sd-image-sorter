"""
Intelligent prompt/tag generator for SD Image Sorter.

Generates random prompts by selecting from categorized tag pools
while respecting semantic exclusion rules and outfit tag sets.
"""
import json
import random
from typing import Dict, List, Optional, Set, Tuple, Any

from tag_rules import (
    categorize_tag,
    categorize_tags_batch,
    get_exclusion_targets,
    BUILTIN_TAG_SETS,
    BUILTIN_EXCLUSION_RULES,
    WEIGHTED_GROUPS,
    QUALITY_TAGS,
)


class PromptGenerator:
    """Generate random prompts respecting semantic rules."""

    def __init__(self, db_module=None):
        self.db = db_module
        self._tag_pool = {}  # category -> [tags]
        self._tag_sets = list(BUILTIN_TAG_SETS)
        self._exclusion_rules = list(BUILTIN_EXCLUSION_RULES)
        self._user_exclusion_rules = []
        self._user_tag_sets = []

    def load_from_db(self):
        """Load tag pool from database (all tags with their categories)."""
        if not self.db:
            return

        from contextlib import contextmanager
        with self.db.get_db() as conn:
            cursor = conn.cursor()

            # Load all tags with counts
            cursor.execute("""
                SELECT tag, COUNT(*) as count
                FROM tags
                GROUP BY tag
                HAVING count >= 2
                ORDER BY count DESC
            """)
            all_tags = cursor.fetchall()

            # Build tag pool by category
            self._tag_pool = {}
            for row in all_tags:
                tag = row[0]
                count = row[1]
                category = categorize_tag(tag)
                if category not in self._tag_pool:
                    self._tag_pool[category] = []
                self._tag_pool[category].append({
                    "tag": tag,
                    "count": count,
                    "category": category,
                })

            # Load user-defined tag categories
            cursor.execute("SELECT tag, category, subcategory FROM tag_categories WHERE is_user_defined = 1")
            for row in cursor.fetchall():
                tag, category, subcategory = row[0], row[1], row[2]
                # Override the auto-categorization
                for cat_tags in self._tag_pool.values():
                    for t in cat_tags:
                        if t["tag"] == tag:
                            t["category"] = category
                            break

            # Load user-defined tag sets
            cursor.execute("SELECT id, name, description, category FROM tag_sets")
            sets = cursor.fetchall()
            for s in sets:
                set_id, name, desc, category = s[0], s[1], s[2], s[3]
                cursor.execute(
                    "SELECT tag, weight, is_required FROM tag_set_members WHERE set_id = ?",
                    (set_id,)
                )
                members = cursor.fetchall()
                self._user_tag_sets.append({
                    "name": name,
                    "category": category,
                    "description": desc,
                    "tags": [
                        {"tag": m[0], "weight": m[1], "required": bool(m[2])}
                        for m in members
                    ]
                })

            # Load user-defined exclusion rules
            cursor.execute("SELECT id, rule_name, description FROM tag_exclusions")
            rules = cursor.fetchall()
            for r in rules:
                rule_id, rule_name, desc = r[0], r[1], r[2]
                cursor.execute(
                    "SELECT condition_tag, condition_type FROM tag_exclusion_conditions WHERE exclusion_id = ?",
                    (rule_id,)
                )
                conditions = [{"tag": c[0], "type": c[1]} for c in cursor.fetchall()]

                cursor.execute(
                    "SELECT excluded_tag, excluded_category FROM tag_exclusion_targets WHERE exclusion_id = ?",
                    (rule_id,)
                )
                targets = [
                    {"tag": t[0], "category": t[1]}
                    for t in cursor.fetchall()
                ]

                self._user_exclusion_rules.append({
                    "name": rule_name,
                    "description": desc,
                    "conditions": conditions,
                    "targets": targets,
                })

    def get_all_rules(self) -> List[dict]:
        """Get all exclusion rules (built-in + user-defined)."""
        return self._exclusion_rules + self._user_exclusion_rules

    def get_all_tag_sets(self) -> List[dict]:
        """Get all tag sets (built-in + user-defined)."""
        return self._tag_sets + self._user_tag_sets

    def get_tag_pool(self) -> Dict[str, List[dict]]:
        """Get the tag pool organized by category."""
        return dict(self._tag_pool)

    def generate(self, config: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """
        Generate a random prompt based on configuration.

        Config options:
            character: str or None (specific character or random)
            outfit: str or None (specific outfit set name or random)
            pose: str or None (specific or random)
            expression: str or None (specific or random)
            angle: str or None (specific or random)
            background: str or None (specific or random)
            style: str or None (specific or random)
            artist: str or None (specific or random or none)
            quality_preset: str ("high", "medium", "none")
            count_tag: str ("1girl", "2girls", etc.)
            nsfw: bool (allow NSFW tags)
            include_negative: bool (generate negative prompt too)
            seed: int or None (for reproducible generation)

        Returns:
            {
                "positive_prompt": str,
                "negative_prompt": str,
                "tags_used": [{"tag": str, "category": str}],
                "exclusions_applied": [str],
                "warnings": [str],
            }
        """
        if config is None:
            config = {}

        # Set seed for reproducibility if provided
        if config.get("seed") is not None:
            random.seed(config["seed"])

        selected_tags = []
        active_tag_set = set()
        warnings = []
        all_rules = self.get_all_rules()

        # Step 1: Quality tags
        quality_preset = config.get("quality_preset", "high")
        if quality_preset == "high":
            quality = ["masterpiece", "best_quality", "very_aesthetic", "absurdres", "newest"]
        elif quality_preset == "medium":
            quality = ["best_quality", "highres"]
        else:
            quality = []

        for q in quality:
            selected_tags.append({"tag": q, "category": "quality"})
            active_tag_set.add(q)

        # Step 2: Count/meta tag
        count_tag = config.get("count_tag", "1girl")
        if count_tag:
            selected_tags.append({"tag": count_tag, "category": "meta"})
            active_tag_set.add(count_tag)
            if count_tag == "solo" or count_tag == "1girl" or count_tag == "1boy":
                selected_tags.append({"tag": "solo", "category": "meta"})
                active_tag_set.add("solo")

        # Step 3: Character (optional)
        character = config.get("character")
        if character == "random" and "character" in self._tag_pool:
            char_tags = self._tag_pool["character"]
            if char_tags:
                chosen = random.choice(char_tags)
                selected_tags.append({"tag": chosen["tag"], "category": "character"})
                active_tag_set.add(chosen["tag"])
        elif character and character != "none":
            selected_tags.append({"tag": character, "category": "character"})
            active_tag_set.add(character)

        # Step 4: Outfit set
        outfit = config.get("outfit")
        all_sets = self.get_all_tag_sets()

        if outfit == "random" and all_sets:
            nsfw = config.get("nsfw", False)
            available_sets = all_sets
            if not nsfw:
                available_sets = [s for s in all_sets if s["name"] not in ("Nude", "Lingerie")]
            if available_sets:
                chosen_set = random.choice(available_sets)
                self._apply_tag_set(chosen_set, selected_tags, active_tag_set)
        elif outfit and outfit != "none":
            matching_sets = [s for s in all_sets if s["name"] == outfit]
            if matching_sets:
                self._apply_tag_set(matching_sets[0], selected_tags, active_tag_set)
            else:
                # Treat as a raw tag
                selected_tags.append({"tag": outfit, "category": "outfit"})
                active_tag_set.add(outfit)

        # Step 5: Pose (with exclusion checking)
        excluded = get_exclusion_targets(active_tag_set, all_rules)
        pose = config.get("pose")
        pose_tag = self._pick_from_category(
            "pose", pose, excluded, WEIGHTED_GROUPS.get("pose")
        )
        if pose_tag:
            selected_tags.append({"tag": pose_tag, "category": "pose"})
            active_tag_set.add(pose_tag)
            # Recompute exclusions with new tag
            excluded = get_exclusion_targets(active_tag_set, all_rules)

        # Step 6: Camera angle
        angle = config.get("angle")
        angle_tag = self._pick_from_category(
            "angle", angle, excluded, WEIGHTED_GROUPS.get("angle")
        )
        if angle_tag:
            selected_tags.append({"tag": angle_tag, "category": "angle"})
            active_tag_set.add(angle_tag)
            excluded = get_exclusion_targets(active_tag_set, all_rules)

        # Step 7: Body features (hair, eyes - respecting exclusions)
        body = config.get("body")
        if body != "none":
            body_tags = self._pick_body_features(excluded)
            for bt in body_tags:
                selected_tags.append({"tag": bt, "category": "body"})
                active_tag_set.add(bt)
            excluded = get_exclusion_targets(active_tag_set, all_rules)

        # Step 8: Expression (respecting exclusions)
        expression = config.get("expression")
        expr_tag = self._pick_from_category(
            "expression", expression, excluded, WEIGHTED_GROUPS.get("expression")
        )
        if expr_tag:
            selected_tags.append({"tag": expr_tag, "category": "expression"})
            active_tag_set.add(expr_tag)

        # Step 9: Background
        background = config.get("background")
        bg_tag = self._pick_from_category("background", background, excluded)
        if bg_tag:
            selected_tags.append({"tag": bg_tag, "category": "background"})
            active_tag_set.add(bg_tag)

        # Step 10: Style/artist (optional)
        artist = config.get("artist")
        if artist == "random" and "artist" in self._tag_pool:
            artist_tags = self._tag_pool["artist"]
            if artist_tags:
                chosen = random.choice(artist_tags)
                selected_tags.append({"tag": chosen["tag"], "category": "artist"})

        style = config.get("style")
        style_tag = self._pick_from_category("style", style, excluded)
        if style_tag:
            selected_tags.append({"tag": style_tag, "category": "style"})

        # Build prompt string with conventional ordering
        prompt_parts = self._order_tags(selected_tags)
        positive_prompt = ", ".join(prompt_parts)

        # Generate negative prompt
        negative_prompt = ""
        if config.get("include_negative", True):
            negative_prompt = self._generate_negative(config)

        # Check for warnings
        excluded_final = get_exclusion_targets(active_tag_set, all_rules)
        exclusions_applied = [t for t in excluded_final if t in active_tag_set]
        if exclusions_applied:
            for ex in exclusions_applied:
                warnings.append(f"Tag '{ex}' conflicts with other selected tags")

        # Reset random seed
        if config.get("seed") is not None:
            random.seed()

        return {
            "positive_prompt": positive_prompt,
            "negative_prompt": negative_prompt,
            "tags_used": selected_tags,
            "exclusions_applied": list(excluded_final),
            "warnings": warnings,
        }

    def validate_prompt(self, tags: List[str]) -> Dict[str, Any]:
        """
        Check a set of tags for rule violations.

        Returns:
            {
                "valid": bool,
                "violations": [{"rule": str, "conflicting_tags": [str]}],
                "suggestions": [str],
            }
        """
        active_set = set(t.lower().replace(" ", "_") for t in tags)
        all_rules = self.get_all_rules()
        violations = []
        suggestions = []

        for rule in all_rules:
            conditions = rule.get("conditions", [])
            targets = rule.get("targets", [])

            # Check if conditions are met
            conditions_met = True
            triggering_tags = []
            for cond in conditions:
                cond_tag = cond["tag"].lower().replace(" ", "_")
                tag_present = cond_tag in active_set
                if cond.get("type", "present") == "present" and not tag_present:
                    conditions_met = False
                    break
                if tag_present:
                    triggering_tags.append(cond_tag)

            if conditions_met:
                conflicting = []
                for target in targets:
                    target_tag = target.get("tag", "").lower().replace(" ", "_")
                    if target_tag and target_tag in active_set:
                        conflicting.append(target_tag)

                if conflicting:
                    violations.append({
                        "rule": rule["name"],
                        "description": rule.get("description", ""),
                        "triggering_tags": triggering_tags,
                        "conflicting_tags": conflicting,
                    })

        if violations:
            for v in violations:
                for ct in v["conflicting_tags"]:
                    suggestions.append(
                        f"Consider removing '{ct}' (conflicts with {', '.join(v['triggering_tags'])} — {v['rule']})"
                    )

        return {
            "valid": len(violations) == 0,
            "violations": violations,
            "suggestions": suggestions,
        }

    def _apply_tag_set(self, tag_set: dict, selected_tags: list, active_set: set):
        """Apply a tag set, adding required tags and randomly selecting optional ones."""
        for member in tag_set["tags"]:
            tag = member["tag"]
            weight = member.get("weight", 1.0)
            required = member.get("required", False)

            if required or random.random() < weight:
                selected_tags.append({"tag": tag, "category": "outfit"})
                active_set.add(tag)

    def _pick_from_category(
        self,
        category: str,
        user_choice: Optional[str],
        excluded: Set[str],
        weighted_options: Optional[List[Tuple[str, int]]] = None,
    ) -> Optional[str]:
        """Pick a tag from a category, respecting exclusions."""
        if user_choice == "none":
            return None
        if user_choice and user_choice != "random":
            tag_lower = user_choice.lower().replace(" ", "_")
            if tag_lower not in excluded:
                return user_choice
            return None

        # Use weighted options if available
        if weighted_options:
            available = [
                (tag, weight) for tag, weight in weighted_options
                if tag.lower().replace(" ", "_") not in excluded
            ]
            if available:
                tags, weights = zip(*available)
                return random.choices(tags, weights=weights, k=1)[0]

        # Fall back to tag pool
        if category in self._tag_pool:
            available = [
                t for t in self._tag_pool[category]
                if t["tag"].lower().replace(" ", "_") not in excluded
            ]
            if available:
                # Weight by frequency in library
                weights = [t["count"] for t in available]
                chosen = random.choices(available, weights=weights, k=1)[0]
                return chosen["tag"]

        return None

    def _pick_body_features(self, excluded: Set[str]) -> List[str]:
        """Pick random body features (hair color, eye color, etc.)."""
        features = []

        # Pick a hair color
        hair_colors = [
            "blonde_hair", "brown_hair", "black_hair", "white_hair",
            "red_hair", "pink_hair", "blue_hair", "silver_hair",
            "purple_hair", "green_hair",
        ]
        available_hair = [h for h in hair_colors if h not in excluded]
        if available_hair:
            features.append(random.choice(available_hair))

        # Pick a hair length
        hair_lengths = ["long_hair", "short_hair", "medium_hair", "very_long_hair"]
        features.append(random.choice(hair_lengths))

        # Pick an eye color
        eye_colors = [
            "blue_eyes", "red_eyes", "green_eyes", "brown_eyes",
            "purple_eyes", "yellow_eyes", "golden_eyes",
        ]
        available_eyes = [e for e in eye_colors if e not in excluded]
        if available_eyes:
            features.append(random.choice(available_eyes))

        # Maybe add breast size (50% chance, only for female characters)
        if random.random() < 0.3:
            sizes = ["large_breasts", "medium_breasts", "small_breasts", "flat_chest"]
            available_sizes = [s for s in sizes if s not in excluded]
            if available_sizes:
                features.append(random.choice(available_sizes))

        return features

    def _order_tags(self, tags: List[dict]) -> List[str]:
        """Order tags in conventional SD prompt ordering."""
        order = [
            "quality", "style", "artist", "meta", "character",
            "body", "outfit", "pose", "expression", "action",
            "angle", "background", "rating",
        ]
        category_order = {cat: i for i, cat in enumerate(order)}

        sorted_tags = sorted(
            tags,
            key=lambda t: category_order.get(t.get("category", "unknown"), 99)
        )
        return [t["tag"] for t in sorted_tags]

    def _generate_negative(self, config: dict) -> str:
        """Generate a negative prompt based on quality preset."""
        quality = config.get("quality_preset", "high")

        if quality == "high":
            return (
                "worst quality, low quality, bad quality, lowres, "
                "bad anatomy, bad hands, extra fingers, fewer fingers, "
                "missing fingers, extra arms, extra legs, "
                "blurry, jpeg artifacts, signature, watermark, text, "
                "username, logo, censored, bar_censor, mosaic_censoring"
            )
        elif quality == "medium":
            return (
                "worst quality, low quality, blurry, "
                "bad anatomy, extra fingers, watermark, text"
            )
        return ""


# Singleton instance
_generator = None


def get_generator(db_module=None) -> PromptGenerator:
    """Get the singleton prompt generator instance."""
    global _generator
    if _generator is None:
        _generator = PromptGenerator(db_module=db_module)
        if db_module:
            _generator.load_from_db()
    return _generator
