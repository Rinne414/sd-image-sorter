"""Tests for the Smart Tag service: noise-strip, training-purpose, caption assembly.

These pin the four pieces of logic that, if they regress, will silently
ship bad LoRA captions:

1. Noise-tag filter — `masterpiece`, `score_9`, `anime`, `year 2024`,
   etc. must be stripped before going anywhere near the VLM or the
   final caption.
2. Training-purpose alias map — `style_lora` -> `style`, `nsfw` ->
   `general`, etc.
3. Prompt-preset wording — the STYLE / CHARACTER / GENERAL prompts must
   direct the VLM toward the right kind of description for each training
   intent. We assert FUNCTIONAL content (mentions clothing? forbids
   identity features?) rather than verbatim wording so the prose can
   evolve.
4. Caption assembly — trigger word at front (or skipped if already
   present), tags deduped, NL sentences glued on the end.
"""
from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from services.smart_tag_service import (  # noqa: E402
    DEFAULT_NOISE_TAGS,
    META_NOISE_TAGS,
    PROMPT_PRESETS,
    SMART_TAG_MAX_ERRORS,
    SmartTagJobState,
    SmartTagRequest,
    QUALITY_NOISE_TAGS,
    SAFETY_NOISE_TAGS,
    SCORE_NOISE_TAGS,
    TIME_NOISE_TAGS,
    TRAINING_PURPOSE_ALIASES,
    _coerce_request,
    _run_pipeline,
    assemble_caption,
    build_vlm_prompt,
    compute_consensus_tags,
    filter_noise_tags,
    get_caption_results_page,
    is_noise_tag,
    normalize_training_purpose,
)
import services.smart_tag_service as smart_tag_service  # noqa: E402


# ---------------------------------------------------------------------------
# Noise-tag filter
# ---------------------------------------------------------------------------


def test_quality_noise_tags_are_stripped() -> None:
    assert is_noise_tag("masterpiece")
    assert is_noise_tag("MASTERPIECE")
    assert is_noise_tag("best quality")
    assert is_noise_tag("worst_quality") is False  # underscore variant we don't track
    # Both the space form and the underscore form are in the set, so:
    assert is_noise_tag("best_quality")
    assert is_noise_tag("high_quality")


def test_score_family_is_stripped_via_regex() -> None:
    """The score_N family includes bare and `_up` rollups, plus the rare
    space-separated form."""
    assert is_noise_tag("score_7")
    assert is_noise_tag("score_9_up")
    assert is_noise_tag("score 7")
    assert is_noise_tag("SCORE_8_UP")
    assert is_noise_tag("score_42")  # regex matches arbitrary digits


def test_safety_and_meta_tags_are_stripped() -> None:
    for t in ["safe", "sensitive", "questionable", "nsfw", "explicit"]:
        assert is_noise_tag(t)
    for t in ["anime", "illustration", "monochrome", "sketch", "official_art"]:
        assert is_noise_tag(t), t
    # OppaiOracle-style rating:* prefix
    for t in ["rating:general", "rating:explicit"]:
        assert is_noise_tag(t)


def test_year_tag_is_stripped() -> None:
    assert is_noise_tag("year 2024")
    assert is_noise_tag("YEAR 2018")
    assert is_noise_tag("2024")


def test_real_tags_are_kept() -> None:
    for tag in ["1girl", "blue_eyes", "long_hair", "smile", "bikini", "outdoors"]:
        assert is_noise_tag(tag) is False, tag


def test_symbol_noise_tags_are_stripped() -> None:
    for tag in [":3", ":p", "@_@", ">_<", "^^^"]:
        assert is_noise_tag(tag)


def test_filter_noise_tags_preserves_order_and_drops_noise() -> None:
    inp = ["masterpiece", "1girl", "score_9", "blue eyes", "anime", "long hair"]
    out, stripped = filter_noise_tags(inp)
    assert out == ["1girl", "blue eyes", "long hair"]
    assert stripped == 3


def test_default_noise_set_is_union_of_all_buckets() -> None:
    expected_subset = QUALITY_NOISE_TAGS | SCORE_NOISE_TAGS | SAFETY_NOISE_TAGS | META_NOISE_TAGS | TIME_NOISE_TAGS
    assert expected_subset.issubset(DEFAULT_NOISE_TAGS)


# ---------------------------------------------------------------------------
# Training-purpose normalisation
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "given,expected",
    [
        ("style", "style"),
        ("style_lora", "style"),
        ("Style-LoRA", "style"),
        ("art", "style"),
        ("character", "character"),
        ("character_lora", "character"),
        ("char", "character"),
        ("general", "general"),
        ("concept", "concept"),
        ("concept_lora", "concept"),
        ("nsfw", "general"),
        ("nsfw_lora", "general"),
        ("", "general"),
        (None, "general"),
        ("totally_unknown", "general"),
    ],
)
def test_normalize_training_purpose(given, expected) -> None:
    assert normalize_training_purpose(given) == expected


def test_training_purpose_alias_table_is_complete() -> None:
    """Every alias must map to a key that exists in PROMPT_PRESETS."""
    for alias, canonical in TRAINING_PURPOSE_ALIASES.items():
        assert canonical in PROMPT_PRESETS, f"{alias} -> {canonical} missing preset"


# ---------------------------------------------------------------------------
# Prompt presets — sanity-check that each preset directs the VLM toward
# the right kind of natural-language description for its training intent.
# We assert FUNCTIONAL content (does the prompt cover lighting? clothing?
# does it forbid identity features?) rather than verbatim wording so the
# wording can evolve without breaking tests.
# ---------------------------------------------------------------------------


def test_style_preset_targets_medium_lighting_composition() -> None:
    prompt = PROMPT_PRESETS["style"].lower()
    # The whole point of the STYLE preset is that it teaches the text
    # encoder the visual style, so these terms must appear.
    for needle in ["medium", "lighting", "composition", "style"]:
        assert needle in prompt, needle
    # And the prompt must direct the VLM AWAY from enumerating clothing
    # (that's character-LoRA territory). We allow any phrasing as long
    # as the prompt says "don't" (or "do not") about clothing.
    assert "clothing" in prompt
    assert ("do not" in prompt) or ("don't" in prompt)


def test_character_preset_excludes_fixed_identity_features() -> None:
    """Character LoRA must avoid teaching hair / eye / signature outfit."""
    prompt = PROMPT_PRESETS["character"]
    assert "do not describe" in prompt.lower()
    assert "hair color" in prompt.lower()
    assert "eye color" in prompt.lower()
    assert "signature outfit" in prompt.lower()


def test_general_preset_covers_subject_pose_clothing_background_lighting() -> None:
    prompt = PROMPT_PRESETS["general"]
    for term in ["subject", "pose", "clothing", "background", "lighting"]:
        assert term in prompt.lower(), term


def test_concept_preset_emphasises_the_concept() -> None:
    prompt = PROMPT_PRESETS["concept"]
    assert "concept" in prompt.lower()


def test_build_vlm_prompt_strips_noise_before_substituting() -> None:
    """The VLM must not see `masterpiece, score_9, anime` in its tag list."""
    prompt = build_vlm_prompt("style", ["masterpiece", "1girl", "score_9", "anime", "blue eyes"])
    assert "masterpiece" not in prompt
    assert "score_9" not in prompt
    assert "anime" not in prompt
    assert "1girl" in prompt
    assert "blue eyes" in prompt


def test_build_vlm_prompt_respects_alias_for_unknown_purpose() -> None:
    """Unknown training_purpose -> falls through to general preset."""
    prompt = build_vlm_prompt("totally_unknown", ["1girl"])
    assert prompt == build_vlm_prompt("general", ["1girl"])


# ---------------------------------------------------------------------------
# Caption assembly + trigger injection
# ---------------------------------------------------------------------------


def test_assemble_caption_basic_layout() -> None:
    out = assemble_caption(
        rating="questionable",
        general_tags=["1girl", "long_hair", "blue_eyes"],
        character_tags=["furina_(genshin_impact)"],
        nl_text="A young girl stands on a balcony at sunset.",
        trigger_word="myloratrigger",
        auto_strip_noise=True,
    )
    # Trigger first, then characters, then generals, then NL.
    assert out.startswith("myloratrigger,")
    assert "furina (genshin impact)" in out
    assert "1girl" in out
    assert "long hair" in out
    assert "blue eyes" in out
    assert out.endswith("A young girl stands on a balcony at sunset.")


def test_assemble_caption_strips_noise_when_enabled() -> None:
    out = assemble_caption(
        rating="general",
        general_tags=["masterpiece", "1girl", "score_9", "blue_eyes", "anime"],
        character_tags=[],
        nl_text="",
        trigger_word="",
        auto_strip_noise=True,
    )
    assert "masterpiece" not in out
    assert "score_9" not in out
    assert "anime" not in out
    assert "1girl" in out
    assert "blue eyes" in out


def test_assemble_caption_keeps_noise_when_disabled() -> None:
    out = assemble_caption(
        rating="general",
        general_tags=["masterpiece", "1girl"],
        character_tags=[],
        nl_text="",
        trigger_word="",
        auto_strip_noise=False,
    )
    assert "masterpiece" in out
    assert "1girl" in out


def test_assemble_caption_does_not_duplicate_existing_trigger() -> None:
    """If trigger is already in the WD14 tag list, do not prepend it again."""
    out = assemble_caption(
        rating=None,
        general_tags=["mytrigger", "1girl", "blue_eyes"],
        character_tags=[],
        nl_text="",
        trigger_word="mytrigger",
        auto_strip_noise=True,
    )
    # mytrigger appears exactly once in the final caption.
    assert out.count("mytrigger") == 1
    # And the original tag-list ordering is preserved (mytrigger was at
    # index 0 of general_tags, so it stays at the front).
    assert "mytrigger" in out
    # 1girl and blue eyes also stay.
    assert "1girl" in out
    assert "blue eyes" in out


def test_assemble_caption_underscore_to_space() -> None:
    """Underscores in tag names get swapped to spaces, except score_N."""
    out = assemble_caption(
        rating=None,
        general_tags=["long_hair", "blue_eyes", "score_9"],
        character_tags=[],
        nl_text="",
        trigger_word="",
        auto_strip_noise=False,
    )
    assert "long hair" in out
    assert "blue eyes" in out
    # score_9 keeps the underscore (Pony recipe convention)
    assert "score_9" in out


def test_assemble_caption_dedupes_repeated_tags() -> None:
    out = assemble_caption(
        rating=None,
        general_tags=["1girl", "1girl", "BLUE_EYES", "blue eyes"],
        character_tags=["1girl"],
        nl_text="",
        trigger_word="",
        auto_strip_noise=True,
    )
    assert out.count("1girl") == 1
    assert out.count("blue eyes") == 1


def test_assemble_caption_handles_empty_inputs() -> None:
    out = assemble_caption(
        rating=None,
        general_tags=[],
        character_tags=[],
        nl_text="",
        trigger_word="",
        auto_strip_noise=True,
    )
    assert out == ""


def test_assemble_caption_only_nl_when_no_tags() -> None:
    out = assemble_caption(
        rating=None,
        general_tags=[],
        character_tags=[],
        nl_text="A photograph of a sunset.",
        trigger_word="",
        auto_strip_noise=True,
    )
    assert out == "A photograph of a sunset."


def test_assemble_caption_only_trigger_and_tags_when_no_nl() -> None:
    out = assemble_caption(
        rating=None,
        general_tags=["1girl", "blue_eyes"],
        character_tags=[],
        nl_text="",
        trigger_word="myloratrigger",
        auto_strip_noise=True,
    )
    assert "myloratrigger" in out
    assert "1girl" in out
    assert "blue eyes" in out
    assert "." not in out  # no NL sentence appended


# ---------------------------------------------------------------------------
# Multi-tagger booru consensus
# ---------------------------------------------------------------------------


def test_consensus_keeps_copyright_tags_separate_but_or_merged() -> None:
    fused = compute_consensus_tags(
        [
            {
                "model": "tagger-a",
                "weight": 1,
                "general_tags": [
                    {"tag": "1girl", "confidence": 0.95},
                    {"tag": "solo", "confidence": 0.80},
                ],
                "copyright_tags": [{"tag": "touhou", "confidence": 0.70}],
                "character_tags": [{"tag": "reimu_hakurei", "confidence": 0.60}],
                "rating": "general",
            },
            {
                "model": "tagger-b",
                "weight": 1,
                "general_tags": [
                    {"tag": "1girl", "confidence": 0.90},
                    {"tag": "smile", "confidence": 0.88},
                ],
                "copyright_tags": [{"tag": "project_moon", "confidence": 0.72}],
                "character_tags": [],
                "rating": "general",
            },
        ],
        consensus_min=2,
        skip_categories=["character", "copyright"],
    )

    assert [tag["tag"] for tag in fused["general_tags"]] == ["1girl"]
    assert {tag["tag"] for tag in fused["copyright_tags"]} == {"touhou", "project_moon"}
    assert {tag["tag"] for tag in fused["character_tags"]} == {"reimu_hakurei"}


def test_multi_tagger_pipeline_uses_copyright_threshold_and_caption(monkeypatch) -> None:
    calls = []

    class FakeTagger:
        def __init__(self, model_name: str) -> None:
            self.model_name = model_name

        def load(self) -> None:
            calls.append(("load", self.model_name))

        def tag(self, image_path, *, threshold, character_threshold, copyright_threshold):
            calls.append((self.model_name, threshold, character_threshold, copyright_threshold))
            if self.model_name == "tagger-a":
                return {
                    "general_tags": [
                        {"tag": "1girl", "confidence": 0.95},
                        {"tag": "solo", "confidence": 0.80},
                    ],
                    "copyright_tags": [{"tag": "touhou", "confidence": 0.70}],
                    "character_tags": [{"tag": "reimu_hakurei", "confidence": 0.60}],
                    "rating": "general",
                }
            return {
                "general_tags": [
                    {"tag": "1girl", "confidence": 0.90},
                    {"tag": "smile", "confidence": 0.88},
                ],
                "copyright_tags": [{"tag": "project_moon", "confidence": 0.72}],
                "character_tags": [],
                "rating": "general",
            }

    def fake_resolve(model_name, **kwargs):
        assert kwargs["copyright_threshold"] == 0.42
        return FakeTagger(model_name)

    monkeypatch.setattr(smart_tag_service, "_resolve_tagger_by_model", fake_resolve)

    req = SmartTagRequest(
        image_paths=["/tmp/fake.png"],
        enable_wd14=True,
        enable_vlm=False,
        taggers=[
            {
                "model": "tagger-a",
                "weight": 1,
                "general_threshold": 0.35,
                "character_threshold": 0.85,
                "copyright_threshold": 0.42,
            },
            {
                "model": "tagger-b",
                "weight": 1,
                "general_threshold": 0.35,
                "character_threshold": 0.85,
                "copyright_threshold": 0.42,
            },
        ],
        consensus_min=2,
        consensus_skip_categories=["character", "copyright"],
        copyright_threshold=0.42,
    )

    # Mirror the orchestrator: pre-compute per-tagger outputs, then call
    # _process_one_image with precomputed_tagger_outputs. The tagger-loading
    # loop now lives in _run_smart_tag_pipeline so models aren't reloaded per
    # image (v3.2.2 multi-tagger refactor).
    precomputed = []
    for entry in req.taggers:
        model_name = entry["model"]
        gen_th = float(entry["general_threshold"])
        char_th = float(entry["character_threshold"])
        copy_th = float(entry["copyright_threshold"])
        one_tagger = smart_tag_service._resolve_tagger_by_model(
            model_name,
            general_threshold=gen_th,
            character_threshold=char_th,
            copyright_threshold=copy_th,
        )
        one_tagger.load()
        out = one_tagger.tag(
            "/tmp/fake.png",
            threshold=gen_th,
            character_threshold=char_th,
            copyright_threshold=copy_th,
        )
        precomputed.append({
            "model": model_name,
            "weight": float(entry.get("weight") or 1.0),
            "general_tags": out.get("general_tags") or [],
            "copyright_tags": out.get("copyright_tags") or [],
            "character_tags": out.get("character_tags") or [],
            "rating": out.get("rating"),
        })

    result = smart_tag_service._process_one_image(
        image_path="/tmp/fake.png",
        image_id=0,
        req=req,
        tagger=None,
        vlm_provider=None,
        precomputed_tagger_outputs=precomputed,
    )

    assert result["general_tags"] == ["1girl"]
    assert set(result["copyright_tags"]) == {"touhou", "project_moon"}
    assert result["character_tags"] == ["reimu_hakurei"]
    assert "touhou" in result["caption"]
    assert "project moon" in result["caption"]
    assert "solo" not in result["caption"]
    assert ("tagger-a", 0.35, 0.85, 0.42) in calls
    assert ("tagger-b", 0.35, 0.85, 0.42) in calls


def test_multi_tagger_pipeline_runs_taggers_then_vlm_with_fused_tag_context(monkeypatch) -> None:
    events = []

    class FakeTagger:
        def __init__(self, model_name: str) -> None:
            self.model_name = model_name

        def load(self) -> None:
            events.append(("load", self.model_name))

        def tag(self, image_path, *, threshold, character_threshold, copyright_threshold):
            events.append(("tag", self.model_name))
            if self.model_name == "tagger-a":
                return {
                    "general_tags": [{"tag": "1girl", "confidence": 0.95}],
                    "copyright_tags": [{"tag": "blue_archive", "confidence": 0.80}],
                    "character_tags": [{"tag": "shiroko_(blue_archive)", "confidence": 0.70}],
                    "rating": "general",
                }
            return {
                "general_tags": [
                    {"tag": "1girl", "confidence": 0.90},
                    {"tag": "blue_eyes", "confidence": 0.88},
                ],
                "copyright_tags": [],
                "character_tags": [],
                "rating": "general",
            }

    class FakeVlm:
        def __init__(self) -> None:
            self.config = SimpleNamespace(
                user_prompt="original",
                user_prompt_with_tags="original with tags",
                include_tags_as_context=True,
            )
            self.received_tags = None
            self.prompt_seen = None

        async def caption_image(self, image_path, *, tags=None):
            events.append(("vlm", tuple(tags or [])))
            self.received_tags = list(tags or [])
            self.prompt_seen = self.config.user_prompt
            return SimpleNamespace(caption="A natural language sentence.")

    monkeypatch.setattr(
        smart_tag_service,
        "_resolve_tagger_by_model",
        lambda model_name, **kwargs: FakeTagger(model_name),
    )

    vlm = FakeVlm()
    req = SmartTagRequest(
        image_paths=["/tmp/fake.png"],
        enable_wd14=True,
        enable_vlm=True,
        taggers=[
            {"model": "tagger-a", "general_threshold": 0.35, "character_threshold": 0.85},
            {"model": "tagger-b", "general_threshold": 0.35, "character_threshold": 0.85},
        ],
        consensus_min=1,
        consensus_skip_categories=["character", "copyright"],
    )

    # Mirror the orchestrator: pre-compute per-tagger outputs, then call
    # _process_one_image with precomputed_tagger_outputs (post-refactor flow).
    precomputed = []
    for entry in req.taggers:
        model_name = entry["model"]
        gen_th = float(entry["general_threshold"])
        char_th = float(entry["character_threshold"])
        copy_th = float(entry.get("copyright_threshold") or req.copyright_threshold or gen_th)
        one_tagger = smart_tag_service._resolve_tagger_by_model(
            model_name,
            general_threshold=gen_th,
            character_threshold=char_th,
            copyright_threshold=copy_th,
        )
        one_tagger.load()
        out = one_tagger.tag(
            "/tmp/fake.png",
            threshold=gen_th,
            character_threshold=char_th,
            copyright_threshold=copy_th,
        )
        precomputed.append({
            "model": model_name,
            "weight": float(entry.get("weight") or 1.0),
            "general_tags": out.get("general_tags") or [],
            "copyright_tags": out.get("copyright_tags") or [],
            "character_tags": out.get("character_tags") or [],
            "rating": out.get("rating"),
        })

    result = smart_tag_service._process_one_image(
        image_path="/tmp/fake.png",
        image_id=0,
        req=req,
        tagger=None,
        vlm_provider=vlm,
        precomputed_tagger_outputs=precomputed,
    )

    assert events == [
        ("load", "tagger-a"),
        ("tag", "tagger-a"),
        ("load", "tagger-b"),
        ("tag", "tagger-b"),
        ("vlm", ("1girl", "blue_eyes", "blue_archive", "shiroko_(blue_archive)")),
    ]
    assert vlm.received_tags == ["1girl", "blue_eyes", "blue_archive", "shiroko_(blue_archive)"]
    assert "1girl" in vlm.prompt_seen
    assert "blue_archive" in vlm.prompt_seen
    assert "shiroko_(blue_archive)" in vlm.prompt_seen
    assert result["nl_text"] == "A natural language sentence."
    assert "A natural language sentence." in result["caption"]


def test_multi_tagger_pipeline_respects_vlm_include_tags_context_off(monkeypatch) -> None:
    class FakeTagger:
        def load(self) -> None:
            pass

        def tag(self, image_path, *, threshold, character_threshold, copyright_threshold):
            return {
                "general_tags": [{"tag": "1girl", "confidence": 0.95}],
                "copyright_tags": [{"tag": "blue_archive", "confidence": 0.80}],
                "character_tags": [{"tag": "shiroko_(blue_archive)", "confidence": 0.70}],
                "rating": "general",
            }

    class FakeVlm:
        def __init__(self) -> None:
            self.config = SimpleNamespace(
                user_prompt="original",
                user_prompt_with_tags="original with tags",
                include_tags_as_context=False,
            )
            self.received_tags = "not-called"
            self.prompt_seen = None

        async def caption_image(self, image_path, *, tags=None):
            self.received_tags = tags
            self.prompt_seen = self.config.user_prompt
            return SimpleNamespace(caption="No tag context sentence.")

    monkeypatch.setattr(
        smart_tag_service,
        "_resolve_tagger_by_model",
        lambda model_name, **kwargs: FakeTagger(),
    )

    vlm = FakeVlm()
    req = SmartTagRequest(
        image_paths=["/tmp/fake.png"],
        enable_wd14=True,
        enable_vlm=True,
        taggers=[{"model": "tagger-a"}],
        consensus_min=1,
    )

    result = smart_tag_service._process_one_image(
        image_path="/tmp/fake.png",
        image_id=0,
        req=req,
        tagger=None,
        vlm_provider=vlm,
    )

    assert vlm.received_tags is None
    assert "1girl" not in vlm.prompt_seen
    assert "blue_archive" not in vlm.prompt_seen
    assert "shiroko_(blue_archive)" not in vlm.prompt_seen
    assert result["nl_text"] == "No tag context sentence."


def test_single_tagger_pipeline_preserves_confidence_rows() -> None:
    class FakeTagger:
        def tag(self, image_path, *, threshold, character_threshold, copyright_threshold):
            return {
                "general_tags": [
                    {"tag": "1girl", "confidence": 0.93},
                    {"tag": "blue_eyes", "confidence": 0.81},
                ],
                "copyright_tags": [{"tag": "blue_archive", "confidence": 0.74}],
                "character_tags": [{"tag": "shiroko_(blue_archive)", "confidence": 0.66}],
                "rating": "general",
            }

    req = SmartTagRequest(
        image_paths=["/tmp/fake.png"],
        enable_wd14=True,
        enable_vlm=False,
        copyright_threshold=0.42,
    )

    result = smart_tag_service._process_one_image(
        image_path="/tmp/fake.png",
        image_id=0,
        req=req,
        tagger=FakeTagger(),
        vlm_provider=None,
    )

    assert result["general_tags"] == ["1girl", "blue_eyes"]
    assert result["copyright_tags"] == ["blue_archive"]
    assert result["character_tags"] == ["shiroko_(blue_archive)"]
    assert result["general_tag_rows"] == [
        {"tag": "1girl", "confidence": 0.93, "category": "general"},
        {"tag": "blue_eyes", "confidence": 0.81, "category": "general"},
    ]
    assert result["copyright_tag_rows"] == [
        {"tag": "blue_archive", "confidence": 0.74, "category": "copyright"}
    ]
    assert result["character_tag_rows"] == [
        {"tag": "shiroko_(blue_archive)", "confidence": 0.66, "category": "character"}
    ]


def test_persist_result_writes_model_confidences(monkeypatch) -> None:
    captured = []

    monkeypatch.setitem(
        sys.modules,
        "database",
        SimpleNamespace(add_tags_batch=lambda rows: captured.extend(rows)),
    )

    smart_tag_service._persist_result(
        123,
        {
            "caption": "general, shiroko, 1girl, blue eyes",
            "general_tags": ["1girl", "blue_eyes"],
            "copyright_tags": ["blue_archive"],
            "character_tags": ["shiroko_(blue_archive)"],
            "general_tag_rows": [
                {"tag": "1girl", "confidence": 0.93, "category": "general"},
                {"tag": "blue_eyes", "confidence": 0.81, "category": "general"},
            ],
            "copyright_tag_rows": [
                {"tag": "blue_archive", "confidence": 0.74, "category": "copyright"}
            ],
            "character_tag_rows": [
                {"tag": "shiroko_(blue_archive)", "confidence": 0.66, "category": "character"}
            ],
        },
        "replace",
    )

    assert len(captured) == 1
    assert captured[0]["image_id"] == 123
    assert captured[0]["ai_caption"] == "general, shiroko, 1girl, blue eyes"
    assert captured[0]["tags"] == [
        {"tag": "shiroko_(blue_archive)", "confidence": 0.66, "category": "character"},
        {"tag": "1girl", "confidence": 0.93, "category": "general"},
        {"tag": "blue_eyes", "confidence": 0.81, "category": "general"},
        {"tag": "blue_archive", "confidence": 0.74, "category": "copyright"},
    ]


def test_coerce_request_uses_model_specific_smart_tag_defaults(monkeypatch) -> None:
    monkeypatch.setattr(smart_tag_service, "count_selection_token_ids", lambda token: 10)

    req = _coerce_request({
        "selection_token": "token-abc",
        "tagger_model": "oppai-oracle-v1.1",
        "enable_vlm": False,
    })

    assert req.general_threshold == pytest.approx(0.7927)
    assert req.character_threshold == pytest.approx(1.0)
    assert req.copyright_threshold == pytest.approx(0.7927)
    assert req.max_tags_per_image == 60


def test_coerce_request_uses_each_consensus_tagger_default(monkeypatch) -> None:
    monkeypatch.setattr(smart_tag_service, "count_selection_token_ids", lambda token: 10)

    req = _coerce_request({
        "selection_token": "token-abc",
        "enable_vlm": False,
        "taggers": [
            {"model": "oppai-oracle-v1.1"},
            {"model": "pixai-tagger-v0.9"},
        ],
    })

    assert req.taggers[0]["general_threshold"] == pytest.approx(0.7927)
    assert req.taggers[0]["character_threshold"] == pytest.approx(1.0)
    assert req.taggers[1]["general_threshold"] == pytest.approx(0.45)
    assert req.taggers[1]["character_threshold"] == pytest.approx(0.85)
    assert req.max_tags_per_image == 60


def test_smart_tag_strips_noise_rows_and_caps_general_tags() -> None:
    class FakeTagger:
        def tag(self, image_path, *, threshold, character_threshold, copyright_threshold):
            return {
                "general_tags": [
                    {"tag": "absurdres", "confidence": 0.99},
                    {"tag": "2024", "confidence": 0.98},
                    {"tag": ":3", "confidence": 0.97},
                    {"tag": "keep_a", "confidence": 0.96},
                    {"tag": "keep_b", "confidence": 0.95},
                ],
                "copyright_tags": [{"tag": "series_name", "confidence": 0.40}],
                "character_tags": [{"tag": "character_name", "confidence": 0.30}],
                "rating": "general",
            }

    req = SmartTagRequest(
        image_paths=["/tmp/fake.png"],
        enable_wd14=True,
        enable_vlm=False,
        auto_strip_noise=True,
        max_tags_per_image=3,
    )

    result = smart_tag_service._process_one_image(
        image_path="/tmp/fake.png",
        image_id=0,
        req=req,
        tagger=FakeTagger(),
        vlm_provider=None,
    )

    assert result["general_tags"] == ["keep_a"]
    assert result["copyright_tags"] == ["series_name"]
    assert result["character_tags"] == ["character_name"]
    assert "absurdres" not in result["caption"]
    assert "2024" not in result["caption"]
    assert ":3" not in result["caption"]
    assert "keep b" not in result["caption"]


def test_smart_tag_max_tags_zero_keeps_all_non_noise_tags() -> None:
    class FakeTagger:
        def tag(self, image_path, *, threshold, character_threshold, copyright_threshold):
            return {
                "general_tags": [
                    {"tag": "keep_c", "confidence": 0.10},
                    {"tag": "keep_a", "confidence": 0.96},
                    {"tag": "keep_b", "confidence": 0.95},
                ],
                "copyright_tags": [],
                "character_tags": [],
                "rating": "general",
            }

    req = SmartTagRequest(
        image_paths=["/tmp/fake.png"],
        enable_wd14=True,
        enable_vlm=False,
        auto_strip_noise=True,
        max_tags_per_image=0,
    )

    result = smart_tag_service._process_one_image(
        image_path="/tmp/fake.png",
        image_id=0,
        req=req,
        tagger=FakeTagger(),
        vlm_provider=None,
    )

    assert result["general_tags"] == ["keep_c", "keep_a", "keep_b"]
    assert "keep c" in result["caption"]


# ---------------------------------------------------------------------------
# Large-source contracts — selection/dataset tokens must stay chunked and
# path-source caption results must not accumulate in job memory.
# ---------------------------------------------------------------------------


def test_coerce_request_accepts_selection_token_without_explicit_ids(monkeypatch) -> None:
    monkeypatch.setattr(smart_tag_service, "count_selection_token_ids", lambda token: 123)

    req = _coerce_request({
        "selection_token": "token-abc",
        "enable_wd14": False,
        "enable_vlm": False,
    })

    assert req.image_ids == []
    assert req.selection_token == "token-abc"
    assert req.selection_count == 123


def test_coerce_request_accepts_dataset_scan_token_alias(monkeypatch) -> None:
    monkeypatch.setattr(smart_tag_service, "_count_dataset_scan_token_paths", lambda token: 77)

    req = _coerce_request({
        "scan_token": "0123456789abcdef0123456789abcdef",
        "enable_wd14": False,
        "enable_vlm": False,
    })

    assert req.dataset_scan_token == "0123456789abcdef0123456789abcdef"
    assert req.dataset_scan_count == 77


def test_run_pipeline_streams_selection_token_id_chunks(monkeypatch) -> None:
    observed_resolve_chunks = []
    persisted_ids = []

    monkeypatch.setattr(smart_tag_service, "SMART_TAG_ID_CHUNK_SIZE", 2)
    monkeypatch.setattr(
        smart_tag_service,
        "iter_selection_token_id_chunks",
        lambda token, chunk_size: iter([[1, 2], [3, 4], [5]]),
    )

    def fake_resolve(ids):
        observed_resolve_chunks.append(list(ids))
        assert len(ids) <= 2
        return {int(image_id): f"/tmp/image-{image_id}.png" for image_id in ids}

    monkeypatch.setattr(smart_tag_service, "_resolve_image_paths", fake_resolve)
    monkeypatch.setattr(
        smart_tag_service,
        "_process_one_image",
        lambda **kwargs: {
            "caption": f"caption {kwargs['image_id']}",
            "general_tags": [],
            "character_tags": [],
        },
    )
    monkeypatch.setattr(
        smart_tag_service,
        "_persist_result",
        lambda image_id, result, merge_strategy: persisted_ids.append(image_id),
    )

    job = SmartTagJobState(job_id="selection-job")
    req = SmartTagRequest(
        selection_token="selection-token",
        selection_count=5,
        enable_wd14=False,
        enable_vlm=False,
    )

    _run_pipeline(job, req)

    assert observed_resolve_chunks == [[1, 2], [3, 4], [5]]
    assert persisted_ids == [1, 2, 3, 4, 5]
    assert job.status == "completed"
    assert job.total == 5
    assert job.processed == 5


def test_path_caption_results_are_paged_from_file_not_kept_in_memory(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(smart_tag_service, "_get_caption_results_dir", lambda: tmp_path)
    monkeypatch.setattr(
        smart_tag_service,
        "_process_one_image",
        lambda **kwargs: {
            "caption": f"caption for {kwargs['image_path']}",
            "general_tags": [],
            "character_tags": [],
        },
    )

    job = SmartTagJobState(job_id="path-job")
    req = SmartTagRequest(
        image_paths=[f"/tmp/local-{index}.png" for index in range(3)],
        enable_wd14=False,
        enable_vlm=False,
    )

    _run_pipeline(job, req)

    assert not hasattr(job, "caption_results")
    assert job.caption_result_count == 3
    assert len(job.recent_caption_results) == 3

    first_page = get_caption_results_page(job, offset=0, limit=2)
    assert first_page["total"] == 3
    assert first_page["has_more"] is True
    assert [row["path"] for row in first_page["results"]] == [
        "/tmp/local-0.png",
        "/tmp/local-1.png",
    ]

    second_page = get_caption_results_page(job, offset=2, limit=2)
    assert second_page["has_more"] is False
    assert [row["path"] for row in second_page["results"]] == ["/tmp/local-2.png"]


def test_run_pipeline_keeps_only_bounded_recent_errors(monkeypatch) -> None:
    monkeypatch.setattr(
        smart_tag_service,
        "_process_one_image",
        lambda **kwargs: (_ for _ in ()).throw(RuntimeError("boom")),
    )

    count = SMART_TAG_MAX_ERRORS + 5
    job = SmartTagJobState(job_id="error-job")
    req = SmartTagRequest(
        image_paths=[f"/tmp/error-{index}.png" for index in range(count)],
        enable_wd14=False,
        enable_vlm=False,
    )

    _run_pipeline(job, req)

    assert job.failed == count
    assert len(job.errors) == SMART_TAG_MAX_ERRORS
    assert job.errors[0]["image_id"] == f"/tmp/error-{count - SMART_TAG_MAX_ERRORS}.png"


# ---------------------------------------------------------------------------
# Fix B2: VLM endpoint missing -> reject at _coerce_request, not silent fallback
# ---------------------------------------------------------------------------


def test_coerce_request_rejects_vlm_enabled_without_endpoint(monkeypatch) -> None:
    """If enable_vlm=True and nl_mode='vlm' but VLM Settings has no endpoint,
    _coerce_request must raise ValueError so the /start route returns 400
    instead of letting the worker silently fall back to booru-only output.
    """
    fake_config = SimpleNamespace(endpoint="", api_key="")
    monkeypatch.setattr(
        "routers.vlm._build_config",
        lambda overrides=None: fake_config,
    )

    with pytest.raises(ValueError, match="VLM Settings"):
        _coerce_request({
            "image_paths": [],
            "image_ids": [1],
            "enable_vlm": True,
            "enable_wd14": True,
            "natural_language_mode": "vlm",
        })


def test_coerce_request_rejects_vlm_enabled_with_endpoint_but_no_api_key(monkeypatch) -> None:
    fake_config = SimpleNamespace(
        provider="openai_compat",
        endpoint="https://example.invalid/v1",
        api_key="",
        use_vertex=False,
        vertex_project="",
    )
    monkeypatch.setattr(
        "routers.vlm._build_config",
        lambda overrides=None: fake_config,
    )

    with pytest.raises(ValueError, match="VLM Settings"):
        _coerce_request({
            "image_ids": [1],
            "enable_vlm": True,
            "natural_language_mode": "vlm",
        })


@pytest.mark.parametrize(
    "endpoint",
    [
        "http://localhost:11434/v1",
        "http://127.0.0.1:11434/v1",
        "http://[::1]:11434/v1",
        "http://host.docker.internal:11434/v1",
        "http://my-rig.local:11434/v1",
        "http://10.0.0.5:8000/v1",
        "http://192.168.1.42:1234/v1",
        "http://172.16.0.5:8080/v1",
    ],
)
def test_coerce_request_allows_local_openai_compat_without_api_key(monkeypatch, endpoint) -> None:
    """Ollama / vLLM / LM Studio on localhost or LAN need no api_key.

    Reproduces the v3.2.2 bug where a configured local endpoint was rejected
    with "VLM Settings has no endpoint or API key configured" because the
    gate required api_key unconditionally.
    """
    fake_config = SimpleNamespace(
        provider="openai_compat",
        endpoint=endpoint,
        api_key="",
        use_vertex=False,
        vertex_project="",
    )
    monkeypatch.setattr(
        "routers.vlm._build_config",
        lambda overrides=None: fake_config,
    )

    req = _coerce_request({
        "image_ids": [1],
        "enable_vlm": True,
        "natural_language_mode": "vlm",
    })
    assert req.enable_vlm is True


def test_coerce_request_allows_gemini_vertex_without_api_key(monkeypatch) -> None:
    """Vertex AI auth uses service-account creds, not api_key."""
    fake_config = SimpleNamespace(
        provider="gemini",
        endpoint="",
        api_key="",
        use_vertex=True,
        vertex_project="my-project",
    )
    monkeypatch.setattr(
        "routers.vlm._build_config",
        lambda overrides=None: fake_config,
    )

    req = _coerce_request({
        "image_ids": [1],
        "enable_vlm": True,
        "natural_language_mode": "vlm",
    })
    assert req.enable_vlm is True


def test_coerce_request_rejects_gemini_vertex_without_project(monkeypatch) -> None:
    fake_config = SimpleNamespace(
        provider="gemini",
        endpoint="",
        api_key="",
        use_vertex=True,
        vertex_project="",
    )
    monkeypatch.setattr(
        "routers.vlm._build_config",
        lambda overrides=None: fake_config,
    )

    with pytest.raises(ValueError, match="Vertex"):
        _coerce_request({
            "image_ids": [1],
            "enable_vlm": True,
            "natural_language_mode": "vlm",
        })


def test_coerce_request_allows_toriigate_without_vlm_endpoint(monkeypatch) -> None:
    """ToriiGate is a local model — it must NOT require a VLM endpoint."""
    # _build_config should not be called in toriigate mode. Set a sentinel
    # that would raise if invoked.
    def _boom(overrides=None):
        raise AssertionError("VLM config must not be loaded in toriigate mode")

    monkeypatch.setattr("routers.vlm._build_config", _boom)

    req = _coerce_request({
        "image_ids": [1],
        "enable_vlm": True,
        "natural_language_mode": "toriigate",
    })
    assert req.natural_language_mode == "toriigate"


def test_coerce_request_allows_vlm_disabled_without_endpoint(monkeypatch) -> None:
    """enable_vlm=False short-circuits the endpoint check."""
    def _boom(overrides=None):
        raise AssertionError("VLM config must not be loaded when enable_vlm=False")

    monkeypatch.setattr("routers.vlm._build_config", _boom)

    req = _coerce_request({
        "image_ids": [1],
        "enable_vlm": False,
    })
    assert req.enable_vlm is False


# ---------------------------------------------------------------------------
# Fix M3: trigger word with internal whitespace is rejected at validation time
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "trigger",
    [
        "my lora trigger",
        "two words",
        "leading_ok and_trailing_ok with space",
        "tab\there",
    ],
)
def test_coerce_request_rejects_trigger_word_with_internal_whitespace(trigger) -> None:
    with pytest.raises(ValueError, match="single token"):
        _coerce_request({
            "image_ids": [1],
            "enable_vlm": False,
            "trigger_word": trigger,
        })


@pytest.mark.parametrize(
    "trigger",
    [
        "",
        "  ",  # whitespace-only -> stripped to empty -> allowed
        "single",
        "my_lora_trigger",
        "myLoraTrigger",
        "  trailing_and_leading_ok  ",  # outer whitespace stripped silently
    ],
)
def test_coerce_request_allows_valid_trigger_words(trigger) -> None:
    req = _coerce_request({
        "image_ids": [1],
        "enable_vlm": False,
        "trigger_word": trigger,
    })
    # Outer whitespace must be stripped, but the inner content stays intact.
    assert req.trigger_word == trigger.strip()
