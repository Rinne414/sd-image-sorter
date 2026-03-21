"""
Prompt generation and tag management router.

Endpoints for tag categorization, tag sets, exclusion rules,
and intelligent random prompt generation.
"""
from typing import List, Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

import database as db
from tag_rules import categorize_tag, categorize_tags_batch
from prompt_generator import get_generator


router = APIRouter(prefix="/api/prompts", tags=["prompts"])


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
    name: str
    description: str = ""
    category: str = "outfit"
    tags: List[TagSetMember]


class TagSetResponse(BaseModel):
    id: int
    name: str
    description: str
    category: str
    tags: List[TagSetMember]


class ExclusionCondition(BaseModel):
    tag: str
    type: str = "present"


class ExclusionTarget(BaseModel):
    tag: str = ""
    category: str = ""


class ExclusionRuleCreate(BaseModel):
    rule_name: str
    description: str = ""
    conditions: List[ExclusionCondition]
    targets: List[ExclusionTarget]


class ExclusionRuleResponse(BaseModel):
    id: Optional[int] = None
    name: str
    description: str
    conditions: List[ExclusionCondition]
    targets: List[ExclusionTarget]


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
    quality_preset: str = "high"
    count_tag: str = "1girl"
    nsfw: bool = False
    include_negative: bool = True
    seed: Optional[int] = None


class ValidateRequest(BaseModel):
    tags: List[str]


class PresetSave(BaseModel):
    name: str
    config: GenerateConfig


# ============================================================
# Tag Category Endpoints
# ============================================================

@router.get("/categories")
async def list_categories():
    """List all tag categories with counts."""
    gen = get_generator(db)
    pool = gen.get_tag_pool()
    result = {}
    for category, tags in pool.items():
        result[category] = {
            "count": len(tags),
            "top_tags": [t["tag"] for t in sorted(tags, key=lambda x: x["count"], reverse=True)[:10]],
        }
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
                "name": s["name"],
                "category": s["category"],
                "description": s.get("description", ""),
                "tag_count": len(s["tags"]),
                "tags": s["tags"],
            }
            for s in all_sets
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


@router.delete("/sets/{name}")
async def delete_tag_set(name: str):
    """Delete a user-defined tag set."""
    with db.get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT id FROM tag_sets WHERE name = ?", (name,))
        row = cursor.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail=f"Tag set '{name}' not found")
        set_id = row[0]
        cursor.execute("DELETE FROM tag_set_members WHERE set_id = ?", (set_id,))
        cursor.execute("DELETE FROM tag_sets WHERE id = ?", (set_id,))
    gen = get_generator(db)
    gen.load_from_db()
    return {"deleted": True, "name": name}


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
                "name": r["name"],
                "description": r.get("description", ""),
                "conditions": r.get("conditions", []),
                "targets": r.get("targets", []),
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


@router.delete("/exclusions/{name}")
async def delete_exclusion_rule(name: str):
    """Delete a user-defined exclusion rule."""
    with db.get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT id FROM tag_exclusions WHERE rule_name = ?", (name,))
        row = cursor.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail=f"Exclusion rule '{name}' not found")
        rule_id = row[0]
        cursor.execute("DELETE FROM tag_exclusion_conditions WHERE exclusion_id = ?", (rule_id,))
        cursor.execute("DELETE FROM tag_exclusion_targets WHERE exclusion_id = ?", (rule_id,))
        cursor.execute("DELETE FROM tag_exclusions WHERE id = ?", (rule_id,))
    gen = get_generator(db)
    gen.load_from_db()
    return {"deleted": True, "name": name}


# ============================================================
# Prompt Generation Endpoints
# ============================================================

@router.post("/generate")
async def generate_prompt(config: GenerateConfig):
    """Generate a random prompt based on configuration."""
    gen = get_generator(db)
    result = gen.generate(config.model_dump())
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
            (data.name, json.dumps(data.config.model_dump())),
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
