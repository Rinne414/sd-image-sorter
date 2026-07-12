"""Tagger model catalog: custom-ONNX profile tables, model hints, catalog assembly.

Moved verbatim from services/tagging_service.py (decomposition 2026-07).
"""

from typing import Any, Dict

from config import DEFAULT_TAGGER_MODEL, TAGGER_MODELS

CUSTOM_PROFILE_ALIASES = {
    "": "wd14",
    "custom": "wd14",
    "wd14": "wd14",
    "wd14-compatible": "wd14",
    "wd14_csv": "wd14",
    "wd14-csv": "wd14",
    "wd-eva02-large-tagger-v3": "wd14",
    "wd-swinv2-tagger-v3": "wd14",
    "wd-convnext-tagger-v3": "wd14",
    "wd-vit-tagger-v3": "wd14",
    "wd-vit-large-tagger-v3": "wd14",
    "camie-tagger-v2": "camie-tagger-v2",
    "pixai-tagger-v0.9": "pixai-tagger-v0.9",
    "toriigate-0.5": "toriigate-0.5",
    "oppai-oracle-v1.1": "oppai-oracle-v1.1",
}
CUSTOM_ONNX_PROFILE_NAMES = {
    "wd14",
    "camie-tagger-v2",
    "pixai-tagger-v0.9",
}
CUSTOM_WD14_PROFILE_MODEL = "wd-swinv2-tagger-v3"
CUSTOM_PROFILE_MODEL_NAMES = {
    "wd14": CUSTOM_WD14_PROFILE_MODEL,
    "camie-tagger-v2": "camie-tagger-v2",
    "pixai-tagger-v0.9": "pixai-tagger-v0.9",
}

TAGGER_MODEL_HINTS = {
    "wd-eva02-large-tagger-v3": {
        "summary": "Most accurate overall — confirmed best in the v3.5.0 live test (highest precision at default threshold, zero hallucinations). The app drives it with adaptive runtime limits instead of forcing CPU by default.",
        "speed": "Slow",
        "memory": "High",
        "best_for": "Max Quality / final library cleanup",
        "safe_mode_note": "Adaptive runtime keeps GPU throughput first, while automatic hardware clamps still cap the true batch size for long runs.",
        "gpu_default": True,
        "gpu_confirmation_required": False,
        "gpu_locked": False,
        "runtime_note": "Adaptive max-throughput runtime. Highest quality without a forced CPU default.",
        "quality_score": 5,
        "speed_score": 3,
        "stability_score": 3,
    },
    "wd-swinv2-tagger-v3": {
        "summary": "Balanced quality and speed. Good default if you are not sure.",
        "speed": "Medium",
        "memory": "Medium",
        "best_for": "Recommended general use",
        "recommended": True,
        "safe_mode_note": "Uses GPU by default. Switch to CPU manually only when troubleshooting.",
        "gpu_default": True,
        "gpu_confirmation_required": False,
        "quality_score": 4,
        "speed_score": 4,
        "stability_score": 4,
    },
    "wd-convnext-tagger-v3": {
        "summary": "Faster than the larger models while keeping decent tagging quality.",
        "speed": "Medium-fast",
        "memory": "Medium",
        "best_for": "Daily tagging on average PCs",
        "safe_mode_note": "A good fallback when EVA02 feels too heavy.",
        "gpu_default": True,
        "gpu_confirmation_required": False,
        "quality_score": 3,
        "speed_score": 4,
        "stability_score": 4,
    },
    "wd-vit-tagger-v3": {
        "summary": "Lightweight and quick, but less accurate than the larger models.",
        "speed": "Fast",
        "memory": "Low",
        "best_for": "Weak machines / fastest pass",
        "safe_mode_note": "Best pick for weak machines. CPU works, but it is slower.",
        "gpu_default": True,
        "gpu_confirmation_required": False,
        "quality_score": 2,
        "speed_score": 5,
        "stability_score": 5,
    },
    "wd-vit-large-tagger-v3": {
        "summary": "A middle ground between ViT speed and EVA02 accuracy.",
        "speed": "Medium",
        "memory": "Medium-high",
        "best_for": "Better accuracy without going full EVA02",
        "safe_mode_note": "Switch to CPU manually only when troubleshooting model load.",
        "gpu_default": True,
        "gpu_confirmation_required": False,
        "quality_score": 4,
        "speed_score": 3,
        "stability_score": 3,
    },
    "camie-tagger-v2": {
        "summary": "Much newer danbooru-era tag space with WD-level accuracy (v3.5.0 live test: 4/4 characters found). Strong artist / character / copyright / year coverage, but it can emit many more tags if the threshold is set too low.",
        "speed": "Medium-slow",
        "memory": "High",
        "best_for": "Modern tag coverage / deeper library enrichment",
        "safe_mode_note": "Camie uses ImageNet normalization and a much larger tag space. Keep the higher default threshold unless you intentionally want denser tags.",
        "gpu_default": True,
        "gpu_confirmation_required": False,
        "gpu_locked": False,
        "runtime_note": "Adaptive runtime with denser modern tags. Better coverage than older WD models, but heavier and noisier if you lower the threshold too much.",
        "quality_score": 4,
        "speed_score": 2,
        "stability_score": 3,
    },
    "pixai-tagger-v0.9": {
        "summary": "Highest recall of all bundled taggers (v3.5.0 live test), but it also produces confident hallucinations — wrong tags ABOVE the confidence threshold that thresholding cannot remove. Best used inside multi-tagger consensus, which removed 11/12 hallucinations in testing.",
        "speed": "Medium-slow",
        "memory": "High",
        "best_for": "Recall-heavy passes / multi-tagger consensus member",
        "safe_mode_note": "Uses direct 448 resize and [-1, 1] normalization. This ONNX export has no native rating head, so the app derives a practical rating fallback from the returned tags. Review its solo output before training on it.",
        "gpu_default": True,
        "gpu_confirmation_required": False,
        "gpu_locked": False,
        "runtime_note": "Adaptive runtime with newer PixAI tags. Heavier than the small WD models and should still be watched on long GPU runs.",
        "quality_score": 4,
        "speed_score": 2,
        "stability_score": 3,
    },
    "toriigate-0.5": {
        "summary": "Large anime-art multimodal CAPTIONER — writes excellent natural-language captions with strong NSFW, character, and copyright knowledge. Not a tagger: measured as one it emitted 5-7 loose tags per image with invented details, so tag mode is disabled (owner decision, v3.5.0).",
        "speed": "Slow",
        "memory": "Very high",
        "best_for": "Natural-language captions via Smart Tag (not booru tagging)",
        "gpu_default": True,
        "gpu_confirmation_required": False,
        "gpu_locked": False,
        "runtime_note": "Runs through the dedicated Transformers VLM backend instead of the WD14 ONNX runtime. GPU is strongly recommended, and the app keeps chunk size fixed to 1.",
        "quality_score": 5,
        "speed_score": 1,
        "stability_score": 2,
    },
    "oppai-oracle-v1.1": {
        "summary": "Grio43 OppaiOracle V1.1: 448x448 ViT (~247M params, 19,294 general tags) trained on a cleaned anime corpus. Highest reported macro-F1 in the open anime tagger comparison.",
        "speed": "Slow",
        "memory": "High",
        "best_for": "Highest-quality general tagging on anime / illustration images",
        "safe_mode_note": "Two-input ONNX (pixel_values + padding_mask). General-only vocabulary; rating tags exposed via the rating:* head. v3.5.0 live test: its ratings run about one level looser than WD models (explicit content can rate as questionable) — don't rely on it alone for strict rating gates.",
        "gpu_default": True,
        "gpu_confirmation_required": False,
        "gpu_locked": False,
        "runtime_note": "Runs through the dedicated OppaiOracleTagger backend. CPU inference is ~1s/image; a GPU is strongly recommended for batch jobs.",
        "quality_score": 5,
        "speed_score": 2,
        "stability_score": 4,
    },
}


class CatalogMixin:
    """Model-catalog slice of TaggingService (assembled in services.tagging.service)."""

    def get_tagger_models(self) -> Dict[str, Any]:
        """Return tagger model catalog with UI/runtime guidance."""
        models = [
            {
                "name": name,
                "path": config["repo_id"],
                "description": TAGGER_MODEL_HINTS.get(name, {}).get(
                    "summary", f"{name} model"
                ),
                "disabled": bool(
                    config.get("disabled")
                    or TAGGER_MODEL_HINTS.get(name, {}).get("disabled", False)
                ),
                "disabled_reason": config.get("disabled_reason", ""),
                "default_threshold": config.get("default_threshold"),
                "default_character_threshold": config.get(
                    "default_character_threshold"
                ),
                "default_copyright_threshold": config.get(
                    "default_copyright_threshold"
                ),
                "default_max_tags_per_image": config.get("default_max_tags_per_image"),
                "speed": TAGGER_MODEL_HINTS.get(name, {}).get("speed", "Unknown"),
                "memory": TAGGER_MODEL_HINTS.get(name, {}).get("memory", "Unknown"),
                "best_for": TAGGER_MODEL_HINTS.get(name, {}).get(
                    "best_for", "General use"
                ),
                "recommended": TAGGER_MODEL_HINTS.get(name, {}).get(
                    "recommended", False
                ),
                "safe_mode_note": TAGGER_MODEL_HINTS.get(name, {}).get(
                    "safe_mode_note",
                    "Switch to CPU only when troubleshooting runtime issues.",
                ),
                "gpu_default": TAGGER_MODEL_HINTS.get(name, {}).get(
                    "gpu_default", True
                ),
                "gpu_confirmation_required": TAGGER_MODEL_HINTS.get(name, {}).get(
                    "gpu_confirmation_required", False
                ),
                "gpu_locked": TAGGER_MODEL_HINTS.get(name, {}).get("gpu_locked", False),
                "runtime_note": TAGGER_MODEL_HINTS.get(name, {}).get(
                    "runtime_note", ""
                ),
                "quality_score": TAGGER_MODEL_HINTS.get(name, {}).get(
                    "quality_score", 3
                ),
                "speed_score": TAGGER_MODEL_HINTS.get(name, {}).get("speed_score", 3),
                "stability_score": TAGGER_MODEL_HINTS.get(name, {}).get(
                    "stability_score", 3
                ),
                "runtime_backend": config.get("runtime_backend", "wd14"),
                "captioner_only": bool(config.get("captioner_only", False)),
                "smart_tag_role": "natural_language"
                if config.get("runtime_backend") == "toriigate"
                else "booru",
                "prepare_model_id": (
                    "toriigate"
                    if config.get("runtime_backend") == "toriigate"
                    else "oppai-oracle"
                    if config.get("runtime_backend") == "oppai-oracle"
                    else "wd14"
                ),
                "runtime_safety_tier": config.get("runtime_safety_tier", "balanced"),
                "minimum_total_ram_gb": config.get("minimum_total_ram_gb"),
                "minimum_available_ram_gb": config.get("minimum_available_ram_gb"),
                "minimum_gpu_vram_mb": config.get("minimum_gpu_vram_mb"),
                "minimum_gpu_available_vram_mb": config.get(
                    "minimum_gpu_available_vram_mb"
                ),
                "minimum_cpu_total_ram_gb": config.get("minimum_cpu_total_ram_gb"),
                "minimum_cpu_available_ram_gb": config.get(
                    "minimum_cpu_available_ram_gb"
                ),
                "custom_profile_supported": str(
                    config.get("runtime_backend", "wd14")
                ).lower()
                not in {"toriigate", "oppai-oracle"},
                "custom_metadata_format": config.get("metadata_format", "wd14_csv"),
                "custom_tags_file_hint": ".json metadata"
                if config.get("metadata_format") == "camie_v2"
                else "selected_tags.csv",
            }
            for name, config in TAGGER_MODELS.items()
        ]
        return {
            "models": models,
            "default": DEFAULT_TAGGER_MODEL,
        }
