"""
Intelligent prompt/tag generator for SD Image Sorter.

Generates random prompts by selecting from categorized tag pools
while respecting semantic exclusion rules and outfit tag sets.
"""
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
    META_TAGS,
    EXPRESSION_TAGS,
    POSE_TAGS,
    ANGLE_TAGS,
    BODY_TAGS,
    BACKGROUND_TAGS,
    STYLE_TAGS,
)


class PromptGenerator:
    """Generate random prompts respecting semantic rules."""

    def __init__(self, db_module=None):
        self.db = db_module
        self._tag_pool: Dict[str, List[Dict[str, Any]]] = {}  # category -> [tags]
        self._tag_sets: List[Dict[str, Any]] = self._normalize_builtin_tag_sets()
        self._exclusion_rules: List[Dict[str, Any]] = self._normalize_builtin_exclusion_rules()
        self._user_exclusion_rules: List[Dict[str, Any]] = []
        self._user_tag_sets: List[Dict[str, Any]] = []

    @staticmethod
    def _make_pool_entries(tags: List[str], category: str) -> List[Dict[str, Any]]:
        count = len(tags)
        entries = []
        for idx, tag in enumerate(tags):
            entries.append({
                "tag": tag,
                "count": max(1, count - idx),
                "category": category,
            })
        return entries

    @classmethod
    def _get_builtin_promptlab_pool(cls) -> Dict[str, List[Dict[str, Any]]]:
        outfit_tags: List[str] = []
        for tag_set in BUILTIN_TAG_SETS:
            for member in tag_set.get("tags", []):
                if isinstance(member, dict):
                    tag = str(member.get("tag") or "").strip()
                else:
                    tag = str(member or "").strip()
                if tag and tag not in outfit_tags:
                    outfit_tags.append(tag)

        background_tags = sorted(BACKGROUND_TAGS)[:36]
        body_tags = sorted(BODY_TAGS)[:36]
        style_tags = sorted(STYLE_TAGS)[:28]
        quality_tags = sorted({str(tag).replace("_", " ") if " " in str(tag) else str(tag) for tag in QUALITY_TAGS})

        return {
            "character": cls._make_pool_entries(
                ["1girl", "1boy", "solo", "multiple_girls", "multiple_boys", "androgynous"],
                "character",
            ),
            "outfit": cls._make_pool_entries(outfit_tags[:40], "outfit"),
            "pose": cls._make_pool_entries([tag for tag, _weight in WEIGHTED_GROUPS.get("pose", [])] or sorted(POSE_TAGS)[:20], "pose"),
            "expression": cls._make_pool_entries([tag for tag, _weight in WEIGHTED_GROUPS.get("expression", [])] or sorted(EXPRESSION_TAGS)[:20], "expression"),
            "angle": cls._make_pool_entries([tag for tag, _weight in WEIGHTED_GROUPS.get("angle", [])] or sorted(ANGLE_TAGS)[:16], "angle"),
            "background": cls._make_pool_entries(background_tags, "background"),
            "style": cls._make_pool_entries(style_tags, "style"),
            "body": cls._make_pool_entries(body_tags, "body"),
            "quality": cls._make_pool_entries(quality_tags[:16], "quality"),
            "meta": cls._make_pool_entries(sorted(META_TAGS)[:12], "meta"),
        }

    def _merge_builtin_promptlab_pool(self) -> None:
        """Ensure Prompt Lab stays useful even before the user has tagged a library."""
        builtin_pool = self._get_builtin_promptlab_pool()
        global_seen = {
            self._normalize_lookup_key(item.get("tag"))
            for items in self._tag_pool.values()
            for item in items
        }
        for category, fallback_tags in builtin_pool.items():
            existing = self._tag_pool.setdefault(category, [])
            for item in fallback_tags:
                key = self._normalize_lookup_key(item.get("tag"))
                if key in global_seen:
                    continue
                existing.append(dict(item))
                global_seen.add(key)

    def load_from_db(self):
        """Load tag pool from database (all tags with their categories)."""
        if not self.db:
            return

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
            self._user_tag_sets = []
            self._user_exclusion_rules = []
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
            overrides = {
                self._normalize_lookup_key(row[0]): row[1]
                for row in cursor.fetchall()
                if str(row[0] or "").strip() and str(row[1] or "").strip()
            }
            if overrides:
                rebuilt_pool: Dict[str, List[Dict[str, Any]]] = {}
                for cat_tags in self._tag_pool.values():
                    for tag_info in cat_tags:
                        target_category = overrides.get(
                            self._normalize_lookup_key(tag_info.get("tag")),
                            tag_info["category"],
                        )
                        normalized_tag_info = dict(tag_info)
                        normalized_tag_info["category"] = target_category
                        rebuilt_pool.setdefault(target_category, []).append(normalized_tag_info)
                self._tag_pool = rebuilt_pool

            self._merge_builtin_promptlab_pool()

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
                    "id": set_id,
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
                    "id": rule_id,
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

    def _append_tag(self, selected_tags: List[dict], seen_tags: Set[str], tag: Any, category: str):
        """Append a tag once, preserving the first category assignment."""
        safe_tag = str(tag or "").strip()
        if not safe_tag:
            return

        normalized = safe_tag.lower().replace(" ", "_")
        if normalized in seen_tags:
            return

        selected_tags.append({"tag": safe_tag, "category": category})
        seen_tags.add(normalized)

    def _normalize_manual_categories(self, raw_categories: Any) -> Dict[str, Dict[str, Any]]:
        """Normalize slot-based Prompt Lab categories from the API payload."""
        if not isinstance(raw_categories, dict):
            return {}

        normalized: Dict[str, Dict[str, Any]] = {}
        for category, value in raw_categories.items():
            if not isinstance(value, dict):
                continue

            tags = [
                str(tag).strip()
                for tag in value.get("tags", [])
                if str(tag or "").strip()
            ]
            if not tags:
                continue

            normalized[str(category)] = {
                "tags": tags,
                "weight": value.get("weight", 1.0),
                "locked": bool(value.get("locked", False)),
            }
        return normalized

    def _resolve_tag_sets(self, tag_set_refs: Any) -> List[dict]:
        """Resolve tag sets by API id or name."""
        if not isinstance(tag_set_refs, list):
            return []

        resolved: List[dict] = []
        all_sets = self.get_all_tag_sets()
        lookup = {}
        for idx, tag_set in enumerate(all_sets, start=1):
            lookup[str(idx)] = tag_set
            tag_set_id = tag_set.get("id")
            if tag_set_id is not None:
                lookup[str(tag_set_id)] = tag_set
            lookup[str(tag_set.get("name", "")).strip().lower()] = tag_set

        for ref in tag_set_refs:
            key = str(ref or "").strip()
            if not key:
                continue
            matched = lookup.get(key) or lookup.get(key.lower())
            if matched and matched not in resolved:
                resolved.append(matched)
        return resolved

    @staticmethod
    def _normalize_lookup_key(value: Any) -> str:
        return str(value or "").strip().lower().replace(" ", "_")

    @classmethod
    def _make_builtin_id(cls, prefix: str, value: Any, fallback_index: int) -> str:
        normalized = cls._normalize_lookup_key(value)
        if not normalized:
            normalized = str(fallback_index)
        return f"{prefix}:{normalized}"

    @classmethod
    def _normalize_builtin_tag_sets(cls) -> List[Dict[str, Any]]:
        normalized_sets: List[Dict[str, Any]] = []
        for idx, tag_set in enumerate(BUILTIN_TAG_SETS, start=1):
            normalized_sets.append({
                **tag_set,
                "id": tag_set.get("id") or cls._make_builtin_id("builtin-tag-set", tag_set.get("name"), idx),
            })
        return normalized_sets

    @classmethod
    def _normalize_builtin_exclusion_rules(cls) -> List[Dict[str, Any]]:
        normalized_rules: List[Dict[str, Any]] = []
        for idx, rule in enumerate(BUILTIN_EXCLUSION_RULES, start=1):
            normalized_rules.append({
                **rule,
                "id": rule.get("id") or cls._make_builtin_id("builtin-exclusion", rule.get("name"), idx),
            })
        return normalized_rules

    def _generate_from_manual_categories(self, config: Dict[str, Any]) -> Dict[str, Any]:
        """Generate a prompt from explicitly selected Prompt Lab slots."""
        selected_tags: List[dict] = []
        seen_tags: Set[str] = set()
        all_rules = self.get_all_rules()

        categories = self._normalize_manual_categories(config.get("categories"))
        tag_sets = self._resolve_tag_sets(config.get("tag_sets"))

        manual_quality = categories.get("quality", {}).get("tags", [])
        if manual_quality:
            for tag in manual_quality:
                self._append_tag(selected_tags, seen_tags, tag, "quality")
        else:
            quality_preset = config.get("quality_preset", "high")
            if quality_preset == "high":
                quality = ["masterpiece", "best_quality", "very_aesthetic", "absurdres", "newest"]
            elif quality_preset == "medium":
                quality = ["best_quality", "highres"]
            else:
                quality = []

            for tag in quality:
                self._append_tag(selected_tags, seen_tags, tag, "quality")

        count_tag = str(config.get("count_tag", "1girl") or "").strip()
        if count_tag:
            self._append_tag(selected_tags, seen_tags, count_tag, "meta")
            if count_tag in {"solo", "1girl", "1boy"}:
                self._append_tag(selected_tags, seen_tags, "solo", "meta")

        for tag_set in tag_sets:
            for member in tag_set.get("tags", []):
                if isinstance(member, dict):
                    tag = member.get("tag")
                    category = member.get("category") or tag_set.get("category") or "outfit"
                else:
                    tag = member
                    category = tag_set.get("category") or "outfit"
                self._append_tag(selected_tags, seen_tags, tag, str(category))

        ordered_categories = [
            "character", "artist", "style", "outfit", "pose", "expression",
            "body", "angle", "background", "quality",
        ]
        remaining_categories = [
            category for category in categories.keys()
            if category not in ordered_categories
        ]

        for category in ordered_categories + sorted(remaining_categories):
            if category == "quality":
                continue
            for tag in categories.get(category, {}).get("tags", []):
                self._append_tag(selected_tags, seen_tags, tag, category)

        prompt_parts = self._order_tags(selected_tags)
        positive_prompt = ", ".join(prompt_parts)
        negative_prompt = self._generate_negative(config) if config.get("include_negative", True) else ""

        validation = self.validate_prompt(prompt_parts)
        active_tag_set = {tag.lower().replace(" ", "_") for tag in prompt_parts}

        return {
            "positive_prompt": positive_prompt,
            "negative_prompt": negative_prompt,
            "tags_used": selected_tags,
            "exclusions_applied": list(get_exclusion_targets(active_tag_set, all_rules)),
            "warnings": validation.get("suggestions", []),
        }

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

        if config.get("categories") or config.get("tag_sets"):
            result = self._generate_from_manual_categories(config)
            if config.get("seed") is not None:
                random.seed()
            return result

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
            available_tags = [
                t for t in self._tag_pool[category]
                if t["tag"].lower().replace(" ", "_") not in excluded
            ]
            if available_tags:
                # Weight by frequency in library
                freq_weights = [t["count"] for t in available_tags]
                chosen = random.choices(available_tags, weights=freq_weights, k=1)[0]
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
