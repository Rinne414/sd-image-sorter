"""Golden regression tests for the v3.5.0 trainer-correctness batch.

Pins the P0-1 / P0-2 / P1-16 fixes with the exact fixture states that
reproduced F1/F2 in the live E2E round (explicit-rated image exported as
"safe"; multi-paragraph NL caption producing a 3-line file; character-mode
Smart Tag leaving no subject token and dropping the rating), plus the
kohya consumer rule: a trainer that reads only line 1 must see the whole
caption.
"""
import database
import pytest

from services.export_template_engine import (
    PRESETS,
    build_export_caption,
    flatten_single_line,
    quality_from_aesthetic_score,
    resolve_canonical_rating,
)
from services.export_validation import ExportValidator
from services.smart_tag_service import _persist_result, _rating_row_from


MULTI_PARAGRAPH_NL = (
    "A girl with long blue hair sits at a desk.\n\n"
    "Behind her, monitors cast a pale glow across scattered papers."
)


def _explicit_tags():
    return [
        {"tag": "1girl", "confidence": 0.99},
        {"tag": "explicit", "confidence": 0.92},
        {"tag": "blue_hair", "confidence": 0.90},
    ]


# ====================================================================
# P0-1 — per-image rating resolution (F1)
# ====================================================================

class TestPerImageRating:
    def test_explicit_image_never_exports_safe(self):
        rendered = build_export_caption(
            {"nl_caption": ""}, _explicit_tags(), preset_id="anima", trigger="t"
        )

        tokens = [part.strip() for part in rendered.split(",")]
        assert "explicit" in tokens
        assert "safe" not in tokens

    def test_rating_tag_not_duplicated_when_template_has_safety_slot(self):
        rendered = build_export_caption(
            {"nl_caption": ""}, _explicit_tags(), preset_id="anima", trigger="t"
        )

        assert rendered.count("explicit") == 1

    def test_anima_maps_questionable_to_nsfw(self):
        tags = [{"tag": "questionable", "confidence": 0.8}, {"tag": "solo", "confidence": 0.9}]

        rendered = build_export_caption({}, tags, preset_id="anima", trigger="t")

        tokens = [part.strip() for part in rendered.split(",")]
        assert "nsfw" in tokens
        assert "questionable" not in tokens

    def test_unrated_image_renders_no_safety_token(self):
        rendered = build_export_caption(
            {}, [{"tag": "solo", "confidence": 0.9}], preset_id="anima", trigger="t"
        )

        tokens = [part.strip() for part in rendered.split(",")]
        assert "safe" not in tokens
        assert "explicit" not in tokens

    def test_noobai_rating_slot_resolves_general_to_safe(self):
        tags = [{"tag": "general", "confidence": 0.95}, {"tag": "solo", "confidence": 0.9}]

        rendered = build_export_caption({}, tags, preset_id="noobai", trigger="t")

        tokens = [part.strip() for part in rendered.split(",")]
        assert "safe" in tokens
        assert "general" not in tokens

    def test_rating_override_wins_over_tag_rows(self):
        rendered = build_export_caption(
            {}, _explicit_tags(), preset_id="noobai", trigger="t", rating_override="sensitive"
        )

        tokens = [part.strip() for part in rendered.split(",")]
        assert "sensitive" in tokens

    def test_oppai_oracle_marker_resolves(self):
        tags = [{"tag": "rating:explicit", "confidence": 0.9}]

        assert resolve_canonical_rating({}, tags) == "explicit"

    def test_highest_confidence_rating_wins(self):
        tags = [
            {"tag": "general", "confidence": 0.30},
            {"tag": "explicit", "confidence": 0.90},
        ]

        assert resolve_canonical_rating({}, tags) == "explicit"


# ====================================================================
# P0-1 — quality resolution (score_5 hardcode removal)
# ====================================================================

class TestQualityResolution:
    def test_no_builtin_preset_hardcodes_score_5(self):
        for preset_id, preset in PRESETS.items():
            assert "score_5" not in str(preset.get("default_quality") or ""), preset_id

    def test_scored_image_uses_aesthetic_bucket(self):
        rendered = build_export_caption(
            {"aesthetic_score": 7.5},
            [{"tag": "solo", "confidence": 0.9}],
            preset_id="anima",
            trigger="t",
        )

        assert "masterpiece" in rendered

    def test_normal_band_score_renders_no_quality_token(self):
        rendered = build_export_caption(
            {"aesthetic_score": 4.5},
            [{"tag": "solo", "confidence": 0.9}],
            preset_id="anima",
            trigger="t",
        )

        assert "masterpiece" not in rendered
        assert "quality" not in rendered

    def test_unscored_image_keeps_preset_default(self):
        rendered = build_export_caption(
            {}, [{"tag": "solo", "confidence": 0.9}], preset_id="anima", trigger="t"
        )

        assert "masterpiece, best quality" in rendered

    def test_bucket_edges(self):
        assert quality_from_aesthetic_score(None) is None
        assert quality_from_aesthetic_score("not a number") is None
        assert quality_from_aesthetic_score(9.9) == "masterpiece, best quality"
        assert quality_from_aesthetic_score(4.2) == ""
        assert quality_from_aesthetic_score(1.0) == "worst quality"


# ====================================================================
# P0-2 — single-line guarantee (F2) + kohya consumer rule
# ====================================================================

class TestSingleLineGuarantee:
    @pytest.mark.parametrize("preset_id", ["anima", "anima_tags_only", "illustrious_pony", "noobai", "flux", "kohya_sd15"])
    def test_builtin_presets_emit_one_line(self, preset_id):
        image = {
            "nl_caption": MULTI_PARAGRAPH_NL,
            "prompt": "first line\nsecond line",
            "ai_caption": MULTI_PARAGRAPH_NL,
        }

        rendered = build_export_caption(image, _explicit_tags(), preset_id=preset_id, trigger="t")

        assert "\n" not in rendered, preset_id

    @pytest.mark.parametrize("preset_id", ["anima", "flux"])
    def test_kohya_first_line_sees_whole_caption(self, preset_id):
        """Consumer rule: kohya reads only splitlines()[0] of the sidecar."""
        image = {"nl_caption": MULTI_PARAGRAPH_NL, "ai_caption": MULTI_PARAGRAPH_NL}

        rendered = build_export_caption(image, _explicit_tags(), preset_id=preset_id, trigger="t")
        first_line = rendered.splitlines()[0] if rendered else ""

        assert first_line == rendered
        assert "monitors" in first_line  # second paragraph survived the flatten

    def test_custom_multiline_template_is_preserved(self):
        rendered = build_export_caption(
            {"nl_caption": "line one"},
            _explicit_tags(),
            preset_id="custom",
            template_override="{tags:filtered}\n{nl_caption}",
        )

        assert "\n" in rendered

    def test_flatten_helper_collapses_all_whitespace(self):
        assert flatten_single_line("a\n\nb\tc  d") == "a b c d"


# ====================================================================
# P3-11 — Anima category sections from tags.category
# ====================================================================

class TestAnimaCategorySections:
    def _category_tags(self):
        return [
            {"tag": "1girl", "confidence": 0.99, "category": "general"},
            {"tag": "long_hair", "confidence": 0.9, "category": "general"},
            {"tag": "shiroko_(blue_archive)", "confidence": 0.8, "category": "character"},
            {"tag": "blue_archive", "confidence": 0.7, "category": "copyright"},
            {"tag": "some_artist", "confidence": 0.6, "category": "artist"},
        ]

    def test_anima_official_section_order(self):
        """quality → safety → count → trigger → characters → copyright →
        @artists → general, sentence last (official Anima model card)."""
        image = {"nl_caption": "A girl stands in the rain."}
        rendered = build_export_caption(
            image, self._category_tags(), preset_id="anima", trigger="sks"
        )

        chars = rendered.index("shiroko (blue archive)")
        copy = rendered.index("blue archive,")
        artist = rendered.index("@some artist")
        general = rendered.index("long hair")
        assert rendered.index("sks") < chars < copy < artist < general
        assert rendered.rstrip().endswith("A girl stands in the rain.")

    def test_artist_at_modifier_prefixes_each_artist(self):
        rendered = build_export_caption(
            {}, self._category_tags(), preset_id="custom",
            template_override="{artists:@}",
        )
        assert rendered == "@some_artist"

    def test_category_split_falls_back_to_heuristic_without_category(self):
        """Legacy rows (source/category NULL) keep the parenthesized-suffix
        character heuristic."""
        tags = [
            {"tag": "1girl", "confidence": 0.99},
            {"tag": "hatsune_miku_(vocaloid)", "confidence": 0.8},
        ]
        rendered = build_export_caption(
            {}, tags, preset_id="custom",
            template_override="{characters} | {general}",
        )
        assert rendered.startswith("hatsune_miku_(vocaloid)")
        assert "1girl" in rendered.split("|")[1]

    def test_count_pattern_accepts_open_ended_danbooru_counts(self):
        tags = [{"tag": "6+girls", "confidence": 0.9, "category": "general"}]
        rendered = build_export_caption(
            {}, tags, preset_id="custom", template_override="{count}",
        )
        assert rendered == "6+girls"

    def test_sentence_zone_survives_dedup_and_sheds_tag_echo(self):
        """P3-14: with an ai_caption fallback (fused tags+sentence), the tag
        echo ahead of the sentence is stripped; the sentence itself is prose
        and must not lose comma segments to token dedup."""
        image = {"ai_caption": "1girl, long hair, A girl, with long hair, stands."}
        tags = [
            {"tag": "1girl", "confidence": 0.99, "category": "general"},
            {"tag": "long_hair", "confidence": 0.9, "category": "general"},
        ]
        rendered = build_export_caption(
            image, tags, preset_id="anima", trigger="",
        )
        # The echoed "1girl, long hair" tag run is deduped away; the prose
        # tail (which still contains commas) survives intact. (The final
        # period may be trimmed by the pre-existing trailing-separator
        # heuristic for short tails — not under test here.)
        assert rendered.count("1girl") == 1
        assert "A girl, with long hair, stands" in rendered


# ====================================================================
# P1-16 + P0-1b — Smart Tag persists trigger and rating rows
# ====================================================================

class TestSmartTagPersistence:
    def _captured_batch(self, monkeypatch, result):
        captured = {}

        def fake_add_tags_batch(batch, **kwargs):
            captured["batch"] = batch
            captured["kwargs"] = kwargs

        monkeypatch.setattr(database, "add_tags_batch", fake_add_tags_batch)
        _persist_result(1, result, merge_strategy="replace")
        # Provenance contract: smart-tag writes are pipeline-scoped tagger rows.
        assert captured["kwargs"] == {"default_source": "tagger", "replace_scope": "pipeline"}
        return captured["batch"][0]

    def test_trigger_persisted_as_top_confidence_row(self, monkeypatch):
        entry = self._captured_batch(monkeypatch, {
            "caption": "furina_v1, 1girl",
            "general_tags": ["1girl"],
            "general_tag_rows": [{"tag": "1girl", "confidence": 0.9}],
            "trigger_word": "furina_v1",
            "rating": "questionable",
            "nl_text": "",
        })

        tags = {row["tag"]: row for row in entry["tags"]}
        assert "furina_v1" in tags
        assert tags["furina_v1"]["confidence"] == 1.0
        assert entry["tags"][0]["tag"] == "furina_v1"  # first row → exports first

    def test_rating_persisted_as_tag_row(self, monkeypatch):
        entry = self._captured_batch(monkeypatch, {
            "caption": "1girl",
            "general_tags": ["1girl"],
            "general_tag_rows": [{"tag": "1girl", "confidence": 0.9}],
            "trigger_word": "",
            "rating": {"label": "explicit", "score": 0.87},
            "nl_text": "",
        })

        tags = {row["tag"]: row for row in entry["tags"]}
        assert "explicit" in tags
        assert tags["explicit"]["confidence"] == pytest.approx(0.87)

    def test_trigger_not_duplicated_when_already_tagged(self, monkeypatch):
        entry = self._captured_batch(monkeypatch, {
            "caption": "furina_v1, 1girl",
            "general_tags": ["furina_v1", "1girl"],
            "general_tag_rows": [
                {"tag": "furina_v1", "confidence": 0.85},
                {"tag": "1girl", "confidence": 0.9},
            ],
            "trigger_word": "furina_v1",
            "rating": None,
            "nl_text": "",
        })

        names = [row["tag"] for row in entry["tags"]]
        assert names.count("furina_v1") == 1

    def test_rating_row_normalization(self):
        assert _rating_row_from("rating:explicit") == ("explicit", 1.0)
        assert _rating_row_from({"label": "q", "score": 0.5}) == ("questionable", 0.5)
        assert _rating_row_from("") == ("", 0.0)
        assert _rating_row_from("weird") == ("", 0.0)


# ====================================================================
# Export validator — output-property checks
# ====================================================================

class TestExportValidator:
    def test_clean_export_reports_ok(self):
        validator = ExportValidator(content_mode="template", template_options={"trigger": "t"})

        validator.add(output_path="/x/a.txt", content="t, 1girl, solo", image_path="/x/a.png")
        summary = validator.summary()

        assert summary["ok"] is True
        assert summary["checked"] == 1

    def test_detects_multiline_caption(self):
        validator = ExportValidator(content_mode="tags_nl")

        validator.add(output_path="/x/a.txt", content="tags, line\nsecond", image_path="/x/a.png")
        codes = [w["code"] for w in validator.summary()["warnings"]]

        assert "multiline_caption" in codes

    def test_multiline_exempt_modes_stay_silent(self):
        validator = ExportValidator(content_mode="prompt_nl")

        validator.add(output_path="/x/a.txt", content="prompt\nnl text", image_path="/x/a.png")

        assert validator.summary()["ok"] is True

    def test_detects_unpaired_sidecar_rename(self):
        validator = ExportValidator(content_mode="tags")

        validator.add(output_path="/out/a_1.txt", content="solo", image_path="/src/dup/a.png")
        codes = [w["code"] for w in validator.summary()["warnings"]]

        assert "unpaired_sidecar" in codes

    def test_detects_missing_trigger(self):
        validator = ExportValidator(content_mode="template", template_options={"trigger": "my_oc"})

        validator.add(output_path="/x/a.txt", content="1girl, solo", image_path="/x/a.png")
        codes = [w["code"] for w in validator.summary()["warnings"]]

        assert "missing_trigger" in codes

    def test_trigger_matches_underscore_and_space_variants(self):
        validator = ExportValidator(content_mode="template", template_options={"trigger": "my_oc"})

        validator.add(output_path="/x/a.txt", content="my oc, 1girl", image_path="/x/a.png")

        assert validator.summary()["ok"] is True

    def test_detects_conflicting_ratings(self):
        validator = ExportValidator(content_mode="template")

        validator.add(output_path="/x/a.txt", content="safe, 1girl, explicit", image_path="/x/a.png")
        codes = [w["code"] for w in validator.summary()["warnings"]]

        assert "conflicting_ratings" in codes

    def test_detects_empty_caption(self):
        validator = ExportValidator(content_mode="tags")

        validator.add(output_path="/x/a.txt", content="   ", image_path="/x/a.png")
        codes = [w["code"] for w in validator.summary()["warnings"]]

        assert "empty_caption" in codes

    def test_warnings_aggregate_with_capped_examples(self):
        validator = ExportValidator(content_mode="tags")

        for index in range(10):
            validator.add(output_path=f"/x/f{index}.txt", content="", image_path=f"/x/f{index}.png")
        warnings = validator.summary()["warnings"]

        assert len(warnings) == 1
        assert warnings[0]["count"] == 10
        assert len(warnings[0]["examples"]) == 3
