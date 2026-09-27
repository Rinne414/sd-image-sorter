"""Prompt Lab: seed and count reach tag sets in the slot mode (V3.5 issue #26).

With slots or tag sets the generator took every tag-set member, required or
not, and never touched its seeded random generator, so a seed changed
nothing and asking for several prompts gave the same prompt several times.
Optional tag-set members are now drawn by their weight from the seeded
generator (the same rule as the automatic mode). The slot tags stay exactly
as the user placed them.
"""

from __future__ import annotations

from typing import Any, Dict

from prompt_generator import PromptGenerator

SAILOR = "School Uniform (Sailor)"


def _config(seed: int, **extra: Any) -> Dict[str, Any]:
    return {
        "categories": {
            "character": {"tags": ["hatsune_miku"], "weight": 0.5, "locked": False}
        },
        "tag_sets": [SAILOR],
        "quality_preset": "none",
        "include_negative": False,
        "count_tag": "",
        "seed": seed,
        **extra,
    }


def test_the_seed_draws_the_optional_tag_set_members():
    generator = PromptGenerator()

    prompts = {
        generator.generate(_config(seed))["positive_prompt"] for seed in range(12)
    }

    assert len(prompts) > 1, "every seed gave the same prompt"
    for prompt in prompts:
        assert "school_uniform" in prompt, "a required member is always there"
        assert "hatsune_miku" in prompt, "the slot tag is always there"


def test_the_same_seed_gives_the_same_prompt():
    generator = PromptGenerator()

    first = generator.generate(_config(7))["positive_prompt"]
    again = generator.generate(_config(7))["positive_prompt"]

    assert first == again


def test_several_prompts_from_one_request_differ(test_client):
    response = test_client.post("/api/prompts/generate", json=_config(3, count=6))

    assert response.status_code == 200, response.text
    prompts = [item["positive_prompt"] for item in response.json()["prompts"]]
    assert len(prompts) == 6
    assert len(set(prompts)) > 1


def test_the_answer_says_whether_anything_was_drawn():
    """Slots alone draw nothing, so seed and count cannot change the prompt; the page says so."""
    generator = PromptGenerator()

    slots_only = generator.generate({**_config(1), "tag_sets": []})
    with_tag_set = generator.generate(_config(1))
    automatic = generator.generate({"quality_preset": "none", "include_negative": False, "seed": 1})

    assert slots_only["random_part"] is False
    assert with_tag_set["random_part"] is True
    assert automatic["random_part"] is True


def test_the_route_passes_the_flag_for_every_prompt(test_client):
    response = test_client.post("/api/prompts/generate", json={**_config(3, count=2), "tag_sets": []})

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["random_part"] is False
    assert [item["random_part"] for item in body["prompts"]] == [False, False]
