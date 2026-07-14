"""Contracts for caption-oriented local VLM recommendations."""

from vlm_providers.local_models import RECOMMENDED_MODELS


def test_qwen3_vl_recommendations_use_explicit_instruct_variants() -> None:
    qwen_models = {
        model["id"]: model
        for model in RECOMMENDED_MODELS
        if str(model["id"]).startswith("qwen3-vl:")
    }

    assert set(qwen_models) == {
        "qwen3-vl:8b-instruct",
        "qwen3-vl:32b-instruct",
    }
    assert qwen_models["qwen3-vl:8b-instruct"]["size_gb"] == 6.1
    assert qwen_models["qwen3-vl:32b-instruct"]["size_gb"] == 21.0
