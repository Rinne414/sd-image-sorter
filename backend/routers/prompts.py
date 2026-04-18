"""
Prompt generation and tag management router.

Endpoints for tag categorization, tag sets, exclusion rules,
and intelligent random prompt generation.
"""
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field, field_validator

import database as db
from tag_rules import categorize_tag, categorize_tags_batch
from prompt_generator import get_generator


router = APIRouter(prefix="/api/prompts", tags=["prompts"])

_RECIPE_TOKEN_EXCLUDES = (
    "negative prompt",
    "steps:",
    "cfg scale",
    "cfg:",
    "sampler:",
    "scheduler:",
    "seed:",
    "size:",
    "model hash",
    "output format",
    "generation time",
)


def _is_useful_recipe_token(token: str) -> bool:
    text = str(token or "").strip().lower()
    if not text or len(text) < 2:
        return False
    return not any(excluded in text for excluded in _RECIPE_TOKEN_EXCLUDES)


# ============================================================
# Pydantic Models
# ============================================================

class TagCategoryResponse(BaseModel):
    tag: str
    category: str
    count: int = 0


class TagSetMember(BaseModel):
    tag: str
    weight: float = 1.0
    required: bool = True


class TagSetCreate(BaseModel):
    name: str = Field(..., min_length=1)
    description: str = ""
    category: str = Field("outfit", min_length=1)
    tags: List[TagSetMember] = Field(..., min_length=1)


class TagSetResponse(BaseModel):
    id: int
    name: str
    description: str
    category: str
    tags: List[TagSetMember]


class ExclusionCondition(BaseModel):
    tag: str = Field(..., min_length=1)
    type: str = Field("present", pattern="^(present|missing)$")


class ExclusionTarget(BaseModel):
    tag: str = ""
    category: str = ""


class ExclusionRuleCreate(BaseModel):
    rule_name: str = Field(..., min_length=1)
    description: str = ""
    conditions: List[ExclusionCondition] = Field(..., min_length=1)
    targets: List[ExclusionTarget] = Field(..., min_length=1)


class ExclusionRuleResponse(BaseModel):
    id: Optional[int] = None
    name: str
    description: str
    conditions: List[ExclusionCondition]
    targets: List[ExclusionTarget]


class PromptCategoryConfig(BaseModel):
    tags: List[str] = Field(default_factory=list)
    weight: float = Field(1.0, ge=0.0, le=1.0)
    locked: bool = False


class GenerateConfig(BaseModel):
    character: Optional[str] = None
    outfit: Optional[str] = None
    pose: Optional[str] = None
    expression: Optional[str] = None
    angle: Optional[str] = None
    background: Optional[str] = None
    style: Optional[str] = None
    artist: Optional[str] = None
    body: Optional[str] = None
    quality_preset: Optional[str] = Field("high", pattern="^(high|medium|low|none)?$")
    count_tag: Optional[str] = None
    nsfw: bool = False
    include_negative: bool = True
    seed: Optional[int] = Field(default=None, ge=0)
    count: int = Field(1, ge=1, le=20)
    categories: Dict[str, PromptCategoryConfig] = Field(default_factory=dict)
    tag_sets: List[Any] = Field(default_factory=list)


class ValidateRequest(BaseModel):
    tags: List[str] = Field(..., min_length=1)


class PresetSave(BaseModel):
    name: str
    config: dict

    @field_validator('config')
    @classmethod
    def validate_config_size(cls, v):
        import json
        if len(json.dumps(v)) > 65536:
            raise ValueError('Config too large')
        return v


def _normalize_prompt_resource_ref(value: Any) -> str:
    return str(value or "").strip()


# ============================================================
# Tag Category Endpoints
# ============================================================

@router.get(
    "/categories",
    summary="List tag categories",
    description="""
Get all available tag categories with their associated tags.

Categories are used in the Prompt Lab for organizing tags by type:
- `character`: Character tags (1girl, 1boy, solo, etc.)
- `outfit`: Clothing and outfit tags
- `pose`: Body pose tags
- `expression`: Facial expression tags
- `background`: Background and setting tags
- `style`: Art style tags
- `angle`: Camera angle tags
- `body`: Body feature tags
    """,
    responses={
        200: {
            "description": "Tag categories",
            "content": {
                "application/json": {
                    "example": {
                        "categories": {
                            "character": ["1girl", "1boy", "solo"],
                            "outfit": ["dress", "school_uniform", "swimsuit"],
                            "pose": ["standing", "sitting", "lying"]
                        }
                    }
                }
            }
        }
    }
)
async def list_categories():
    """
    List all tag categories with tag arrays for Prompt Lab.

    Returns tags organized by category for use in prompt generation.

    Returns:
        Dict with 'categories' mapping category names to tag arrays
    """
    gen = get_generator(db)
    pool = gen.get_tag_pool()
    result = {}
    for category, tags in pool.items():
        ordered_tags = sorted(tags, key=lambda x: x["count"], reverse=True)
        result[category] = [t["tag"] for t in ordered_tags]
    return {"categories": result}


@router.get("/category/{name}")
async def get_category_tags(
    name: str,
    limit: int = Query(100, ge=1, le=1000),
    offset: int = Query(0, ge=0),
):
    """Get all tags in a specific category."""
    gen = get_generator(db)
    pool = gen.get_tag_pool()
    if name not in pool:
        raise HTTPException(status_code=404, detail=f"Category '{name}' not found")

    tags = sorted(pool[name], key=lambda x: x["count"], reverse=True)
    total = len(tags)
    page = tags[offset:offset + limit]
    return {
        "category": name,
        "total": total,
        "tags": page,
    }


@router.post("/categorize")
async def categorize_tags(tags: List[str]):
    """Auto-categorize a list of tags."""
    results = categorize_tags_batch(tags)
    return {"results": [{"tag": t, "category": c} for t, c in results.items()]}


@router.post("/recategorize")
async def recategorize_tag(tag: str, category: str):
    """Override the category of a tag (user-defined)."""
    with db.get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """INSERT OR REPLACE INTO tag_categories (tag, category, is_user_defined)
               VALUES (?, ?, 1)""",
            (tag, category),
        )
    gen = get_generator(db)
    gen.load_from_db()
    return {"tag": tag, "category": category, "saved": True}


# ============================================================
# Tag Set Endpoints
# ============================================================

@router.get("/sets")
async def list_tag_sets():
    """List all tag sets (built-in + user-defined)."""
    gen = get_generator(db)
    all_sets = gen.get_all_tag_sets()
    return {
        "sets": [
            {
                "id": s.get("id", idx + 1),
                "name": s["name"],
                "category": s["category"],
                "description": s.get("description", ""),
                "tag_count": len(s["tags"]),
                "members": [
                    {
                        "tag": member["tag"] if isinstance(member, dict) else member,
                        "category": s["category"],
                        "weight": member.get("weight", 1.0) if isinstance(member, dict) else 1.0,
                        "required": member.get("required", True) if isinstance(member, dict) else True,
                    }
                    for member in s["tags"]
                ],
                "tags": s["tags"],
            }
            for idx, s in enumerate(all_sets)
        ],
        "total": len(all_sets),
    }


@router.post("/sets")
async def create_tag_set(data: TagSetCreate):
    """Create a new user-defined tag set."""
    with db.get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "INSERT INTO tag_sets (name, description, category) VALUES (?, ?, ?)",
            (data.name, data.description, data.category),
        )
        set_id = cursor.lastrowid
        for member in data.tags:
            cursor.execute(
                "INSERT INTO tag_set_members (set_id, tag, weight, is_required) VALUES (?, ?, ?, ?)",
                (set_id, member.tag, member.weight, int(member.required)),
            )
    # Reload generator to include new set
    gen = get_generator(db)
    gen.load_from_db()
    return {"id": set_id, "name": data.name, "created": True}


@router.delete("/sets/{set_ref}")
async def delete_tag_set(set_ref: str):
    """Delete a user-defined tag set by id or legacy name."""
    normalized_ref = _normalize_prompt_resource_ref(set_ref)
    with db.get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT id, name FROM tag_sets WHERE CAST(id AS TEXT) = ? OR name = ?",
            (normalized_ref, normalized_ref),
        )
        row = cursor.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail=f"Tag set '{set_ref}' not found")
        set_id, set_name = row[0], row[1]
        cursor.execute("DELETE FROM tag_set_members WHERE set_id = ?", (set_id,))
        cursor.execute("DELETE FROM tag_sets WHERE id = ?", (set_id,))
    gen = get_generator(db)
    gen.load_from_db()
    return {"deleted": True, "id": set_id, "name": set_name}


# ============================================================
# Exclusion Rule Endpoints
# ============================================================

@router.get("/exclusions")
async def list_exclusion_rules():
    """List all exclusion rules (built-in + user-defined)."""
    gen = get_generator(db)
    all_rules = gen.get_all_rules()
    return {
        "rules": [
            {
                "id": r.get("id"),
                "name": r["name"],
                "description": r.get("description", ""),
                "conditions": [
                    {"tag": c.get("tag", c.get("condition_tag", "")), "type": c.get("type", c.get("condition_type", "present"))}
                    for c in r.get("conditions", [])
                ],
                "targets": [
                    {"tag": t.get("tag", t.get("excluded_tag", "")), "category": t.get("category", t.get("excluded_category", ""))}
                    for t in r.get("targets", [])
                ],
            }
            for r in all_rules
        ],
        "total": len(all_rules),
    }


@router.post("/exclusions")
async def create_exclusion_rule(data: ExclusionRuleCreate):
    """Create a new user-defined exclusion rule."""
    with db.get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "INSERT INTO tag_exclusions (rule_name, description) VALUES (?, ?)",
            (data.rule_name, data.description),
        )
        rule_id = cursor.lastrowid
        for cond in data.conditions:
            cursor.execute(
                "INSERT INTO tag_exclusion_conditions (exclusion_id, condition_tag, condition_type) VALUES (?, ?, ?)",
                (rule_id, cond.tag, cond.type),
            )
        for target in data.targets:
            cursor.execute(
                "INSERT INTO tag_exclusion_targets (exclusion_id, excluded_tag, excluded_category) VALUES (?, ?, ?)",
                (rule_id, target.tag, target.category),
            )
    gen = get_generator(db)
    gen.load_from_db()
    return {"id": rule_id, "name": data.rule_name, "created": True}


@router.delete("/exclusions/{rule_ref}")
async def delete_exclusion_rule(rule_ref: str):
    """Delete a user-defined exclusion rule by id or legacy name."""
    normalized_ref = _normalize_prompt_resource_ref(rule_ref)
    with db.get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT id, rule_name FROM tag_exclusions WHERE CAST(id AS TEXT) = ? OR rule_name = ?",
            (normalized_ref, normalized_ref),
        )
        row = cursor.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail=f"Exclusion rule '{rule_ref}' not found")
        rule_id, rule_name = row[0], row[1]
        cursor.execute("DELETE FROM tag_exclusion_conditions WHERE exclusion_id = ?", (rule_id,))
        cursor.execute("DELETE FROM tag_exclusion_targets WHERE exclusion_id = ?", (rule_id,))
        cursor.execute("DELETE FROM tag_exclusions WHERE id = ?", (rule_id,))
    gen = get_generator(db)
    gen.load_from_db()
    return {"deleted": True, "id": rule_id, "name": rule_name}


# ============================================================
# Prompt Generation Endpoints
# ============================================================

@router.post(
    "/generate",
    summary="Generate random prompt",
    description="""
Generate a random prompt based on provided configuration.

The generator randomly selects tags from each specified category
while respecting exclusion rules (e.g., no swimsuit with school uniform).

Set a `seed` for reproducible prompt generation.
    """,
    responses={
        200: {
            "description": "Generated prompt",
            "content": {
                "application/json": {
                    "example": {
                        "prompt": "1girl, solo, masterpiece, best quality, dress, standing, smile",
                        "negative_prompt": "lowres, bad anatomy, bad hands",
                        "seed": 12345,
                        "config": {}
                    }
                }
            }
        }
    }
)
async def generate_prompt(config: GenerateConfig):
    """
    Generate a random prompt based on configuration.

    Randomly selects tags from each specified category and combines
    them into a complete prompt. Applies exclusion rules to prevent
    conflicting tags.

    Args:
        config: GenerateConfig with:
            - character: Character tag (e.g., "1girl")
            - outfit: Outfit category or specific tag
            - pose: Pose category or specific tag
            - expression: Expression category or specific tag
            - angle: Camera angle
            - background: Background type
            - style: Art style
            - artist: Artist style to emulate
            - body: Body features
            - quality_preset: "high", "medium", "low", or "none"
            - count_tag: Character count tag (e.g., "1girl", "2girls") or empty for none
            - nsfw: Include NSFW tags
            - include_negative: Generate negative prompt
            - seed: Random seed for reproducibility

    Returns:
        Dict containing:
        - prompt: Generated positive prompt
        - negative_prompt: Generated negative prompt (if enabled)
        - seed: Seed used for generation
        - config: Effective configuration used
    """
    gen = get_generator(db)
    result = gen.generate(config.model_dump())
    # Normalize response — backend returns positive_prompt, expose as both keys
    result.setdefault('prompt', result.get('positive_prompt', ''))
    return result


@router.post("/validate")
async def validate_prompt(data: ValidateRequest):
    """Validate a set of tags against exclusion rules."""
    gen = get_generator(db)
    result = gen.validate_prompt(data.tags)
    return result


# ============================================================
# Preset Endpoints
# ============================================================

@router.get("/presets")
async def list_presets():
    """List saved generation presets."""
    import json
    with db.get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT id, name, config_json, created_at FROM prompt_presets ORDER BY created_at DESC")
        rows = cursor.fetchall()
        return {
            "presets": [
                {
                    "id": r[0],
                    "name": r[1],
                    "config": json.loads(r[2]),
                    "created_at": r[3],
                }
                for r in rows
            ],
        }


@router.post("/presets")
async def save_preset(data: PresetSave):
    """Save a generation preset."""
    import json
    with db.get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "INSERT INTO prompt_presets (name, config_json) VALUES (?, ?)",
            (data.name, json.dumps(data.config)),
        )
        return {"id": cursor.lastrowid, "name": data.name, "saved": True}


@router.delete("/presets/{preset_id}")
async def delete_preset(preset_id: int):
    """Delete a generation preset."""
    with db.get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("DELETE FROM prompt_presets WHERE id = ?", (preset_id,))
        if cursor.rowcount == 0:
            raise HTTPException(status_code=404, detail="Preset not found")
    return {"deleted": True}


@router.get("/stats")
async def prompt_stats(
    tag_limit: int = Query(100, ge=1, le=10000),
    high_tag_limit: int = Query(100, ge=1, le=10000),
    checkpoint_limit: int = Query(30, ge=1, le=5000),
    leader_limit: int = Query(24, ge=1, le=5000),
    recipe_limit: int = Query(24, ge=1, le=5000),
    scored_limit: int = Query(24, ge=1, le=5000),
):
    """Analyze prompt patterns across the image library.

    Returns tag frequency, checkpoint usage, high-aesthetic prompt patterns,
    and average prompt statistics.
    """
    with db.get_db() as conn:
        cursor = conn.cursor()
        effective_checkpoint_limit = max(checkpoint_limit, recipe_limit)
        effective_leader_limit = max(leader_limit, recipe_limit)

        # Total images
        total = cursor.execute("SELECT COUNT(*) FROM images").fetchone()[0]

        # Top tags
        top_tags_total = cursor.execute(
            "SELECT COUNT(*) FROM (SELECT tag FROM tags GROUP BY tag)"
        ).fetchone()[0]
        top_tags = []
        for row in cursor.execute(
            "SELECT tag, COUNT(*) as cnt FROM tags GROUP BY tag ORDER BY cnt DESC LIMIT ?",
            (tag_limit,),
        ).fetchall():
            top_tags.append({"tag": row[0], "count": row[1], "pct": round(row[1] / max(total, 1) * 100, 1)})

        # Top checkpoints
        top_checkpoints_total = cursor.execute(
            "SELECT COUNT(*) FROM ("
            "SELECT checkpoint FROM images "
            "WHERE checkpoint IS NOT NULL AND TRIM(checkpoint) != '' "
            "GROUP BY checkpoint"
            ")"
        ).fetchone()[0]
        top_checkpoints = []
        for row in cursor.execute(
            "SELECT checkpoint, COUNT(*) as cnt FROM images WHERE checkpoint IS NOT NULL AND TRIM(checkpoint) != '' "
            "GROUP BY checkpoint ORDER BY cnt DESC LIMIT ?",
            (effective_checkpoint_limit,),
        ).fetchall():
            checkpoint_name = str(row[0] or "").strip()
            if not checkpoint_name:
                continue
            top_checkpoints.append({"name": checkpoint_name, "count": row[1]})

        checkpoint_score_leaders_total = cursor.execute(
            "SELECT COUNT(*) FROM ("
            "SELECT checkpoint FROM images "
            "WHERE checkpoint IS NOT NULL AND TRIM(checkpoint) != '' AND aesthetic_score IS NOT NULL "
            "GROUP BY checkpoint "
            "HAVING COUNT(*) >= 3"
            ")"
        ).fetchone()[0]
        checkpoint_score_leaders = []
        for row in cursor.execute(
            "SELECT checkpoint, AVG(aesthetic_score) as avg_score, COUNT(*) as cnt "
            "FROM images "
            "WHERE checkpoint IS NOT NULL AND TRIM(checkpoint) != '' AND aesthetic_score IS NOT NULL "
            "GROUP BY checkpoint "
            "HAVING COUNT(*) >= 3 "
            "ORDER BY avg_score DESC, cnt DESC "
            "LIMIT ?",
            (effective_leader_limit,),
        ).fetchall():
            checkpoint_name = str(row[0] or "").strip()
            if not checkpoint_name:
                continue
            checkpoint_score_leaders.append({
                "name": checkpoint_name,
                "avg_score": round(row[1] or 0, 2),
                "count": row[2],
            })

        recipe_sources = checkpoint_score_leaders[:recipe_limit] if checkpoint_score_leaders else top_checkpoints[:recipe_limit]
        checkpoint_recipes_total = checkpoint_score_leaders_total if checkpoint_score_leaders_total else top_checkpoints_total
        checkpoint_recipes = []
        for leader in recipe_sources:
            recipe_tags = []
            tag_query = (
                "SELECT t.tag, COUNT(*) as cnt "
                "FROM tags t "
                "INNER JOIN images i ON t.image_id = i.id "
                "WHERE i.checkpoint = ? "
            )
            if leader.get("avg_score") is not None:
                tag_query += "AND i.aesthetic_score IS NOT NULL "
            tag_query += (
                "GROUP BY t.tag "
                "ORDER BY cnt DESC "
                "LIMIT ?"
            )

            for row in cursor.execute(tag_query, (leader["name"], recipe_limit)).fetchall():
                if _is_useful_recipe_token(row[0]):
                    recipe_tags.append(row[0])

            if not recipe_tags:
                prompt_counts = {}
                for row in cursor.execute(
                    "SELECT prompt FROM images WHERE checkpoint = ? AND prompt IS NOT NULL AND prompt != '' LIMIT 1000",
                    (leader["name"],)
                ).fetchall():
                    for token in db.extract_prompt_tokens(row[0]):
                        if _is_useful_recipe_token(token):
                            prompt_counts[token] = prompt_counts.get(token, 0) + 1

                recipe_tags = [
                    token for token, _count in sorted(
                        prompt_counts.items(),
                        key=lambda item: item[1],
                        reverse=True
                    )[:recipe_limit]
                ]

            checkpoint_recipes.append({
                "name": leader["name"],
                "avg_score": leader.get("avg_score"),
                "count": leader["count"],
                "tags": recipe_tags,
            })

        # Prompt length stats
        prompt_stats_row = cursor.execute(
            "SELECT AVG(LENGTH(prompt)), MAX(LENGTH(prompt)), MIN(LENGTH(CASE WHEN prompt IS NOT NULL AND prompt != '' THEN prompt END)) "
            "FROM images WHERE prompt IS NOT NULL AND prompt != ''"
        ).fetchone()
        avg_len = round(prompt_stats_row[0] or 0)
        max_len = prompt_stats_row[1] or 0
        min_len = prompt_stats_row[2] or 0

        # High aesthetic images' common tags (score >= 7)
        high_score_tags_total = cursor.execute(
            "SELECT COUNT(*) FROM ("
            "SELECT t.tag FROM tags t "
            "INNER JOIN images i ON t.image_id = i.id "
            "WHERE i.aesthetic_score >= 7 "
            "GROUP BY t.tag"
            ")"
        ).fetchone()[0]
        high_score_tags = []
        for row in cursor.execute(
            "SELECT t.tag, COUNT(*) as cnt FROM tags t "
            "INNER JOIN images i ON t.image_id = i.id "
            "WHERE i.aesthetic_score >= 7 "
            "GROUP BY t.tag ORDER BY cnt DESC LIMIT ?",
            (high_tag_limit,),
        ).fetchall():
            high_score_tags.append({"tag": row[0], "count": row[1]})

        # Low aesthetic images' common tags (score < 4)
        low_score_tags = []
        for row in cursor.execute(
            "SELECT t.tag, COUNT(*) as cnt FROM tags t "
            "INNER JOIN images i ON t.image_id = i.id "
            "WHERE i.aesthetic_score IS NOT NULL AND i.aesthetic_score < 4 "
            "GROUP BY t.tag ORDER BY cnt DESC LIMIT ?",
            (high_tag_limit,),
        ).fetchall():
            low_score_tags.append({"tag": row[0], "count": row[1]})

        # Scored count
        scored = cursor.execute("SELECT COUNT(*) FROM images WHERE aesthetic_score IS NOT NULL").fetchone()[0]

        top_scored_images = []
        for row in cursor.execute(
            "SELECT id, filename, checkpoint, prompt, aesthetic_score "
            "FROM images "
            "WHERE aesthetic_score IS NOT NULL "
            "ORDER BY aesthetic_score DESC, id DESC "
            "LIMIT ?",
            (scored_limit,),
        ).fetchall():
            top_scored_images.append({
                "id": row[0],
                "filename": row[1],
                "checkpoint": row[2],
                "prompt": row[3] or "",
                "aesthetic_score": row[4],
            })

        return {
            "total_images": total,
            "scored_images": scored,
            "top_tags": top_tags,
            "top_tags_total": top_tags_total,
            "top_tags_has_more": top_tags_total > len(top_tags),
            "top_checkpoints": top_checkpoints,
            "top_checkpoints_total": top_checkpoints_total,
            "top_checkpoints_has_more": top_checkpoints_total > len(top_checkpoints),
            "checkpoint_score_leaders": checkpoint_score_leaders,
            "checkpoint_score_leaders_total": checkpoint_score_leaders_total,
            "checkpoint_score_leaders_has_more": checkpoint_score_leaders_total > len(checkpoint_score_leaders),
            "checkpoint_recipes": checkpoint_recipes,
            "checkpoint_recipes_total": checkpoint_recipes_total,
            "checkpoint_recipes_has_more": checkpoint_recipes_total > len(checkpoint_recipes),
            "prompt_length": {"avg": avg_len, "max": max_len, "min": min_len},
            "high_aesthetic_tags": high_score_tags,
            "high_aesthetic_tags_total": high_score_tags_total,
            "high_aesthetic_tags_has_more": high_score_tags_total > len(high_score_tags),
            "low_aesthetic_tags": low_score_tags,
            "top_scored_images": top_scored_images,
            "top_scored_images_total": scored,
            "top_scored_images_has_more": scored > len(top_scored_images),
        }


@router.get("/compare")
async def compare_prompts(
    id_a: int = Query(..., description="First image ID"),
    id_b: int = Query(..., description="Second image ID"),
):
    """Compare prompts and tags of two images side by side."""
    img_a = db.get_image_by_id(id_a)
    img_b = db.get_image_by_id(id_b)
    if not img_a or not img_b:
        raise HTTPException(status_code=404, detail="One or both images not found")

    tags_a = set(t["tag"] for t in db.get_image_tags(id_a))
    tags_b = set(t["tag"] for t in db.get_image_tags(id_b))

    prompt_a = img_a.get("prompt") or ""
    prompt_b = img_b.get("prompt") or ""

    tokens_a = set(t.strip() for t in prompt_a.split(",") if t.strip())
    tokens_b = set(t.strip() for t in prompt_b.split(",") if t.strip())

    return {
        "image_a": {"id": id_a, "filename": img_a["filename"], "prompt": prompt_a,
                     "checkpoint": img_a.get("checkpoint"), "aesthetic_score": img_a.get("aesthetic_score")},
        "image_b": {"id": id_b, "filename": img_b["filename"], "prompt": prompt_b,
                     "checkpoint": img_b.get("checkpoint"), "aesthetic_score": img_b.get("aesthetic_score")},
        "tags_common": sorted(tags_a & tags_b),
        "tags_only_a": sorted(tags_a - tags_b),
        "tags_only_b": sorted(tags_b - tags_a),
        "prompt_common": sorted(tokens_a & tokens_b),
        "prompt_only_a": sorted(tokens_a - tokens_b),
        "prompt_only_b": sorted(tokens_b - tokens_a),
    }
