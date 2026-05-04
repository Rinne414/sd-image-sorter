"""
Prompt generation and tag management router.

Endpoints for tag categorization, tag sets, exclusion rules,
and intelligent random prompt generation.
"""
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field, field_validator

from prompt_generator import get_generator
from services.prompt_service import PromptService
from services.service_provider import ServiceProvider


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


def _configure_prompt_service(service: PromptService) -> None:
    service.set_generator_getter(get_generator)


_prompt_service_provider = ServiceProvider(
    lambda: PromptService(generator_getter=get_generator),
    on_set=_configure_prompt_service,
)


def get_prompt_service() -> PromptService:
    service = _prompt_service_provider.get()
    service.set_generator_getter(get_generator)
    return service


set_prompt_service = _prompt_service_provider.set


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
async def list_categories(
    service: PromptService = Depends(get_prompt_service),
):
    """
    List all tag categories with tag arrays for Prompt Lab.

    Returns tags organized by category for use in prompt generation.

    Returns:
        Dict with 'categories' mapping category names to tag arrays
    """
    return service.list_categories()


@router.get("/category/{name}")
async def get_category_tags(
    name: str,
    limit: int = Query(100, ge=1, le=1000),
    offset: int = Query(0, ge=0),
    service: PromptService = Depends(get_prompt_service),
):
    """Get all tags in a specific category."""
    return service.get_category_tags(name, limit, offset)


@router.post("/categorize")
async def categorize_tags(
    tags: List[str],
    service: PromptService = Depends(get_prompt_service),
):
    """Auto-categorize a list of tags."""
    return service.categorize_tags(tags)


@router.post("/recategorize")
async def recategorize_tag(
    tag: str,
    category: str,
    service: PromptService = Depends(get_prompt_service),
):
    """Override the category of a tag (user-defined)."""
    return service.recategorize_tag(tag, category)


# ============================================================
# Tag Set Endpoints
# ============================================================

@router.get("/sets")
async def list_tag_sets(
    service: PromptService = Depends(get_prompt_service),
):
    """List all tag sets (built-in + user-defined)."""
    return service.list_tag_sets()


@router.post("/sets")
async def create_tag_set(
    data: TagSetCreate,
    service: PromptService = Depends(get_prompt_service),
):
    """Create a new user-defined tag set."""
    return service.create_tag_set(
        name=data.name,
        description=data.description,
        category=data.category,
        tags=[member.model_dump() for member in data.tags],
    )


@router.delete("/sets/{set_ref}")
async def delete_tag_set(
    set_ref: str,
    service: PromptService = Depends(get_prompt_service),
):
    """Delete a user-defined tag set by id or legacy name."""
    return service.delete_tag_set(set_ref)


# ============================================================
# Exclusion Rule Endpoints
# ============================================================

@router.get("/exclusions")
async def list_exclusion_rules(
    service: PromptService = Depends(get_prompt_service),
):
    """List all exclusion rules (built-in + user-defined)."""
    return service.list_exclusion_rules()


@router.post("/exclusions")
async def create_exclusion_rule(
    data: ExclusionRuleCreate,
    service: PromptService = Depends(get_prompt_service),
):
    """Create a new user-defined exclusion rule."""
    return service.create_exclusion_rule(
        rule_name=data.rule_name,
        description=data.description,
        conditions=[condition.model_dump() for condition in data.conditions],
        targets=[target.model_dump() for target in data.targets],
    )


@router.delete("/exclusions/{rule_ref}")
async def delete_exclusion_rule(
    rule_ref: str,
    service: PromptService = Depends(get_prompt_service),
):
    """Delete a user-defined exclusion rule by id or legacy name."""
    return service.delete_exclusion_rule(rule_ref)


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
async def generate_prompt(
    config: GenerateConfig,
    service: PromptService = Depends(get_prompt_service),
):
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
    return service.generate_prompt(config.model_dump())


@router.post("/validate")
async def validate_prompt(
    data: ValidateRequest,
    service: PromptService = Depends(get_prompt_service),
):
    """Validate a set of tags against exclusion rules."""
    return service.validate_prompt(data.tags)


# ============================================================
# Preset Endpoints
# ============================================================

@router.get("/presets")
async def list_presets(
    service: PromptService = Depends(get_prompt_service),
):
    """List saved generation presets."""
    return service.list_presets()


@router.post("/presets")
async def save_preset(
    data: PresetSave,
    service: PromptService = Depends(get_prompt_service),
):
    """Save a generation preset."""
    return service.save_preset(data.name, data.config)


@router.delete("/presets/{preset_id}")
async def delete_preset(
    preset_id: int,
    service: PromptService = Depends(get_prompt_service),
):
    """Delete a generation preset."""
    return service.delete_preset(preset_id)


@router.get("/stats")
async def prompt_stats(
    tag_limit: int = Query(100, ge=1, le=10000),
    high_tag_limit: int = Query(100, ge=1, le=10000),
    checkpoint_limit: int = Query(30, ge=1, le=5000),
    leader_limit: int = Query(24, ge=1, le=5000),
    recipe_limit: int = Query(24, ge=1, le=5000),
    scored_limit: int = Query(24, ge=1, le=5000),
    service: PromptService = Depends(get_prompt_service),
):
    """Analyze prompt patterns across the image library.

    Returns tag frequency, checkpoint usage, high-aesthetic prompt patterns,
    and average prompt statistics.
    """
    return service.get_prompt_stats(
        tag_limit=tag_limit,
        high_tag_limit=high_tag_limit,
        checkpoint_limit=checkpoint_limit,
        leader_limit=leader_limit,
        recipe_limit=recipe_limit,
        scored_limit=scored_limit,
    )


@router.get("/compare")
async def compare_prompts(
    id_a: int = Query(..., description="First image ID"),
    id_b: int = Query(..., description="Second image ID"),
    service: PromptService = Depends(get_prompt_service),
):
    """Compare prompts and tags of two images side by side."""
    return service.compare_prompts(id_a=id_a, id_b=id_b)
