"""MP1 review follow-ups: stale widget values, LoraManager strings, fallbacks.

Every fixture is synthetic.
"""

from __future__ import annotations

from pathlib import Path

from metadata_parser import MetadataParser, parse_image
from tests.test_metadata_parser_false_positives import (
    CACHED_GENERATED_PROMPT,
    _llm_video_api_graph,
    _llm_video_ui_workflow,
    _write_png,
)

STALE_WIDGET_TEXT = (
    "An older run wrote this: the tall woman stands by a harbour wall at dusk "
    "while gulls circle the mast lights and the water keeps moving."
)


def _node(workflow: dict, node_id: int) -> dict:
    return next(node for node in workflow["nodes"] if node["id"] == node_id)


class TestStaleWidgetValuesAreNotAdopted:
    """ComfyUI keeps a linked input's hand-typed widget value; the upstream
    result is never written back. Only display nodes store a result."""

    def test_display_node_value_is_the_executed_prompt(self, tmp_path: Path):
        workflow = _llm_video_ui_workflow(STALE_WIDGET_TEXT)
        _node(workflow, 660)["widgets_values"] = [CACHED_GENERATED_PROMPT]

        result = parse_image(
            _write_png(
                tmp_path,
                "display.png",
                {"prompt": _llm_video_api_graph(), "workflow": workflow},
            )
        )

        assert result["prompt"] == CACHED_GENERATED_PROMPT

    def test_display_node_without_a_value_yields_no_prompt(self, tmp_path: Path):
        workflow = _llm_video_ui_workflow(STALE_WIDGET_TEXT)
        _node(workflow, 660)["widgets_values"] = [None, None, None]

        result = parse_image(
            _write_png(
                tmp_path,
                "empty_display.png",
                {"prompt": _llm_video_api_graph(), "workflow": workflow},
            )
        )

        assert not result["prompt"], result["prompt"]


# Digit-heavy file names: the tags are mostly digits and punctuation, which is
# what a formula check keys on, and seven of them read as a prompt by shape.
LORA_NAMES = ["k07_e012", "m13_v02", "p21_e040", "q33_v11", "r44_e005", "t55_v09", "u66_e100"]
LORA_STACK_TEXT = " ".join(f"<lora:{name}:0.{index + 4}0>" for index, name in enumerate(LORA_NAMES))
ENCODER_PROMPT = (
    "1girl, silver hair, red scarf, snowy street, lantern light, looking at viewer, "
    "masterpiece, best quality"
)
ENCODER_NEGATIVE = "worst quality, low quality, lowres, bad anatomy, blurry, watermark"


def _lora_manager_ui_workflow() -> dict:
    """UI-only graph: a LoraManager node (lora string kept in a widget) on the
    model path of a sampler whose prompts are literal encoder text."""
    return {
        "nodes": [
            {
                "id": 1,
                "type": "UNETLoader",
                "mode": 0,
                "inputs": [],
                "outputs": [{"name": "MODEL", "type": "MODEL", "links": [1]}],
                "widgets_values": ["base_model.safetensors", "default"],
            },
            {
                "id": 2,
                "type": "Lora Loader (LoraManager)",
                "mode": 0,
                "inputs": [
                    {"name": "model", "type": "MODEL", "link": 1},
                    {"name": "clip", "type": "CLIP", "link": None},
                    {"name": "lora_stack", "type": "LORA_STACK", "link": None},
                ],
                "outputs": [
                    {"name": "MODEL", "type": "MODEL", "links": [2]},
                    {"name": "CLIP", "type": "CLIP", "links": [3, 4]},
                    {"name": "trigger_words", "type": "STRING", "links": []},
                    {"name": "loaded_loras", "type": "STRING", "links": []},
                ],
                "widgets_values": [
                    {"version": 1, "textWidgetName": "text"},
                    LORA_STACK_TEXT,
                ],
            },
            {
                "id": 3,
                "type": "CLIPTextEncode",
                "mode": 0,
                "inputs": [
                    {"name": "clip", "type": "CLIP", "link": 3},
                    {"name": "text", "type": "STRING", "widget": {"name": "text"}, "link": None},
                ],
                "outputs": [{"name": "CONDITIONING", "type": "CONDITIONING", "links": [5]}],
                "widgets_values": [ENCODER_PROMPT],
            },
            {
                "id": 4,
                "type": "CLIPTextEncode",
                "mode": 0,
                "inputs": [
                    {"name": "clip", "type": "CLIP", "link": 4},
                    {"name": "text", "type": "STRING", "widget": {"name": "text"}, "link": None},
                ],
                "outputs": [{"name": "CONDITIONING", "type": "CONDITIONING", "links": [6]}],
                "widgets_values": [ENCODER_NEGATIVE],
            },
            {
                "id": 5,
                "type": "KSampler",
                "mode": 0,
                "inputs": [
                    {"name": "model", "type": "MODEL", "link": 2},
                    {"name": "positive", "type": "CONDITIONING", "link": 5},
                    {"name": "negative", "type": "CONDITIONING", "link": 6},
                    {"name": "latent_image", "type": "LATENT", "link": None},
                ],
                "outputs": [{"name": "LATENT", "type": "LATENT", "links": []}],
                "widgets_values": [1, "fixed", 20, 7, "euler", "normal", 1],
            },
        ],
        "links": [
            [1, 1, 0, 2, 0, "MODEL"],
            [2, 2, 0, 5, 0, "MODEL"],
            [3, 2, 1, 3, 0, "CLIP"],
            [4, 2, 1, 4, 0, "CLIP"],
            [5, 3, 0, 5, 1, "CONDITIONING"],
            [6, 4, 0, 5, 2, "CONDITIONING"],
        ],
    }


class TestLoraManagerStringIsNotAPrompt:
    def test_workflow_only_graph_keeps_every_lora(self, tmp_path: Path):
        result = parse_image(
            _write_png(tmp_path, "lm.png", {"workflow": _lora_manager_ui_workflow()})
        )

        assert result["generator"] == "comfyui"
        assert sorted(result["loras"]) == sorted(LORA_NAMES)

    def test_lora_string_is_not_the_prompt_when_the_encoders_are_literal(
        self, tmp_path: Path
    ):
        result = parse_image(
            _write_png(tmp_path, "lm_prompt.png", {"workflow": _lora_manager_ui_workflow()})
        )

        assert result["prompt"] == ENCODER_PROMPT
        assert result["negative_prompt"] == ENCODER_NEGATIVE

    def test_lora_string_alone_is_not_a_prompt_to_the_harvest(self):
        from prompt_text_scorer import harvest_prompt_candidates, pick_positive_negative

        nodes = {
            "2": {
                "class_type": "Lora Loader (LoraManager)",
                "inputs": {"text": LORA_STACK_TEXT},
            }
        }
        assert pick_positive_negative(harvest_prompt_candidates(nodes, ())) == (None, None)


# Two long clauses: each comma segment is far over 80 characters, so the shape
# score alone rejects it (0.15) although it is a perfectly good prompt.
LONG_CLAUSE_PROMPT = (
    "a tall woman with warm brown skin and long ivory-white hair stands on a wet harbour "
    "pier while the evening light turns the whole scene a deep amber colour, "
    "and behind her a row of old fishing boats rocks gently against the rope fenders "
    "as gulls circle the tall mast lights above the calm and slowly darkening water"
)


def _api_graph_with_display_node_on_the_path() -> dict:
    return {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": "base_model.safetensors"}},
        "2": {"class_type": "CLIPLoader", "inputs": {"clip_name": "text_encoder.safetensors"}},
        "3": {
            "class_type": "CLIPTextEncode",
            "inputs": {"clip": ["2", 0], "text": ["7", 0]},
        },
        "4": {
            "class_type": "CLIPTextEncode",
            "inputs": {"clip": ["2", 0], "text": ENCODER_NEGATIVE},
        },
        "5": {
            "class_type": "KSampler",
            "inputs": {
                "model": ["1", 0],
                "positive": ["3", 0],
                "negative": ["4", 0],
                "latent_image": ["9", 0],
                "seed": 1,
                "steps": 20,
                "cfg": 7,
                "sampler_name": "euler",
                "scheduler": "normal",
                "denoise": 1,
            },
        },
        "7": {"class_type": "PreviewAny", "inputs": {"source": ["8", 0]}},
        "8": {
            "class_type": "llama_cpp_instruct_adv",
            "inputs": {
                "custom_prompt": "Describe a harbour scene.",
                "system_prompt": "You are an expert prompt writer for image generation models.",
            },
        },
        "9": {"class_type": "EmptyLatentImage", "inputs": {"width": 512, "height": 512, "batch_size": 1}},
    }


def _ui_workflow_with_display_node_on_the_path(display_value: str) -> dict:
    def link_input(name: str, kind: str, link: int) -> dict:
        return {"name": name, "type": kind, "link": link}

    return {
        "nodes": [
            {"id": 1, "type": "UNETLoader", "mode": 0, "inputs": [],
             "outputs": [{"name": "MODEL", "type": "MODEL", "links": [1]}],
             "widgets_values": ["base_model.safetensors", "default"]},
            {"id": 2, "type": "CLIPLoader", "mode": 0, "inputs": [],
             "outputs": [{"name": "CLIP", "type": "CLIP", "links": [2, 3]}],
             "widgets_values": ["text_encoder.safetensors"]},
            {"id": 3, "type": "CLIPTextEncode", "mode": 0,
             "inputs": [link_input("clip", "CLIP", 2),
                        {"name": "text", "type": "STRING", "widget": {"name": "text"}, "link": 4}],
             "outputs": [{"name": "CONDITIONING", "type": "CONDITIONING", "links": [5]}],
             "widgets_values": [""]},
            {"id": 4, "type": "CLIPTextEncode", "mode": 0,
             "inputs": [link_input("clip", "CLIP", 3),
                        {"name": "text", "type": "STRING", "widget": {"name": "text"}, "link": None}],
             "outputs": [{"name": "CONDITIONING", "type": "CONDITIONING", "links": [6]}],
             "widgets_values": [ENCODER_NEGATIVE]},
            {"id": 5, "type": "KSampler", "mode": 0,
             "inputs": [link_input("model", "MODEL", 1), link_input("positive", "CONDITIONING", 5),
                        link_input("negative", "CONDITIONING", 6),
                        {"name": "latent_image", "type": "LATENT", "link": None}],
             "outputs": [{"name": "LATENT", "type": "LATENT", "links": []}],
             "widgets_values": [1, "fixed", 20, 7, "euler", "normal", 1]},
            {"id": 7, "type": "PreviewAny", "mode": 0,
             "inputs": [link_input("source", "*", 7)],
             "outputs": [{"name": "STRING", "type": "STRING", "links": [4]}],
             "widgets_values": [display_value]},
            {"id": 8, "type": "llama_cpp_instruct_adv", "mode": 0,
             "inputs": [{"name": "custom_prompt", "type": "STRING", "link": None,
                         "widget": {"name": "custom_prompt"}},
                        {"name": "system_prompt", "type": "STRING", "link": None,
                         "widget": {"name": "system_prompt"}}],
             "outputs": [{"name": "STRING", "type": "STRING", "links": [7]}],
             "widgets_values": ["Describe a harbour scene.",
                                "You are an expert prompt writer for image generation models."]},
        ],
        "links": [
            [1, 1, 0, 5, 0, "MODEL"],
            [2, 2, 0, 3, 0, "CLIP"],
            [3, 2, 0, 4, 0, "CLIP"],
            [4, 7, 0, 3, 1, "STRING"],
            [5, 3, 0, 5, 1, "CONDITIONING"],
            [6, 4, 0, 5, 2, "CONDITIONING"],
            [7, 8, 0, 7, 0, "*"],
        ],
    }


class TestDisplayNodeOnTheSamplerPath:
    def test_display_value_wins_over_the_shape_score(self, tmp_path: Path):
        result = parse_image(
            _write_png(
                tmp_path,
                "display_path.png",
                {
                    "prompt": _api_graph_with_display_node_on_the_path(),
                    "workflow": _ui_workflow_with_display_node_on_the_path(LONG_CLAUSE_PROMPT),
                },
            )
        )

        assert result["prompt"] == LONG_CLAUSE_PROMPT
        assert result["negative_prompt"] == ENCODER_NEGATIVE

    def test_workflow_only_display_value_is_read(self, tmp_path: Path):
        result = parse_image(
            _write_png(
                tmp_path,
                "display_path_ui.png",
                {"workflow": _ui_workflow_with_display_node_on_the_path(LONG_CLAUSE_PROMPT)},
            )
        )

        assert result["prompt"] == LONG_CLAUSE_PROMPT

    def test_display_node_without_value_leaves_the_positive_empty(self, tmp_path: Path):
        result = parse_image(
            _write_png(
                tmp_path,
                "display_path_empty.png",
                {
                    "prompt": _api_graph_with_display_node_on_the_path(),
                    "workflow": _ui_workflow_with_display_node_on_the_path(""),
                },
            )
        )

        assert not result["prompt"], result["prompt"]


DECOY_NOTE = (
    "A quiet workflow note describing how the lighting should be set up for a harbour "
    "scene at dusk with gentle fog"
)


class TestUiTraceOutranksTheHarvest:
    def test_ui_trace_beats_a_harvested_decoy_when_the_api_trace_is_empty(
        self, tmp_path: Path
    ):
        """The API graph's encoders are a custom node the tracer cannot read, and a
        note-like string sits upstream of the sampler. The UI workflow traces the
        real encoders, so it wins over the scored guess from the API graph."""
        api_graph = {
            "1": {"class_type": "UNETLoader", "inputs": {"unet_name": "base_model.safetensors"}},
            "8": {"class_type": "CLIPLoader", "inputs": {"clip_name": "text_encoder.safetensors"}},
            "6": {
                "class_type": "WorkflowNotesBox",
                "inputs": {"model": ["1", 0], "notes": DECOY_NOTE},
            },
            "3": {"class_type": "CustomPromptBox", "inputs": {"clip": ["8", 0]}},
            "4": {"class_type": "CustomPromptBox", "inputs": {"clip": ["8", 0]}},
            "5": {
                "class_type": "KSampler",
                "inputs": {
                    "model": ["6", 0],
                    "positive": ["3", 0],
                    "negative": ["4", 0],
                    "seed": 1,
                    "steps": 20,
                },
            },
        }

        result = parse_image(
            _write_png(
                tmp_path,
                "ui_first.png",
                {"prompt": api_graph, "workflow": _lora_manager_ui_workflow()},
            )
        )

        assert result["prompt"] == ENCODER_PROMPT
        assert result["negative_prompt"] == ENCODER_NEGATIVE


def _sampler_inputs(**links) -> dict:
    return {"seed": 1, "steps": 20, "cfg": 7, "sampler_name": "euler", **links}


class TestSamplerSideRules:
    def test_zero_out_on_the_negative_side_means_no_negative(self, tmp_path: Path):
        graph = {
            "1": {"class_type": "UNETLoader", "inputs": {"unet_name": "base_model.safetensors"}},
            "2": {"class_type": "CLIPLoader", "inputs": {"clip_name": "text_encoder.safetensors"}},
            "3": {
                "class_type": "CLIPTextEncode",
                "inputs": {"clip": ["2", 0], "text": ENCODER_PROMPT},
            },
            "4": {"class_type": "ConditioningZeroOut", "inputs": {"conditioning": ["3", 0]}},
            "5": {
                "class_type": "KSampler",
                "inputs": _sampler_inputs(model=["1", 0], positive=["3", 0], negative=["4", 0]),
            },
        }

        result = parse_image(_write_png(tmp_path, "zero_out.png", {"prompt": graph}))

        assert result["prompt"] == ENCODER_PROMPT
        assert not result["negative_prompt"], result["negative_prompt"]

    def test_basic_guider_conditioning_is_the_prompt(self, tmp_path: Path):
        graph = {
            "1": {"class_type": "UNETLoader", "inputs": {"unet_name": "base_model.safetensors"}},
            "2": {"class_type": "CLIPLoader", "inputs": {"clip_name": "text_encoder.safetensors"}},
            "3": {
                "class_type": "CLIPTextEncode",
                "inputs": {"clip": ["2", 0], "text": ENCODER_PROMPT},
            },
            "4": {
                "class_type": "BasicGuider",
                "inputs": {"model": ["1", 0], "conditioning": ["3", 0]},
            },
            "5": {"class_type": "RandomNoise", "inputs": {"noise_seed": 1}},
            "6": {
                "class_type": "SamplerCustomAdvanced",
                "inputs": {"noise": ["5", 0], "guider": ["4", 0]},
            },
        }

        # The tracer alone: the scored harvest would find this text anyway.
        positive, negative = MetadataParser()._trace_sampler_prompts(graph)
        assert positive == ENCODER_PROMPT
        assert negative is None

        result = parse_image(_write_png(tmp_path, "guider.png", {"prompt": graph}))
        assert result["generator"] == "comfyui"
        assert result["prompt"] == ENCODER_PROMPT

    def test_fallback_positive_equal_to_the_traced_negative_is_dropped(
        self, tmp_path: Path
    ):
        """A positive the tracer cannot read, and a negative that is not worded like
        one: the scored harvest finds the negative text and offers it as the
        positive. The same text on both sides is never the positive."""
        loose_negative = "ugly, deformed face, extra limbs, bad proportions, cropped, dull colors"
        graph = {
            "1": {"class_type": "UNETLoader", "inputs": {"unet_name": "base_model.safetensors"}},
            "2": {"class_type": "CLIPLoader", "inputs": {"clip_name": "text_encoder.safetensors"}},
            "3": {"class_type": "CustomPromptBox", "inputs": {"clip": ["2", 0]}},
            "4": {
                "class_type": "CLIPTextEncode",
                "inputs": {"clip": ["2", 0], "text": loose_negative},
            },
            "5": {
                "class_type": "KSampler",
                "inputs": _sampler_inputs(model=["1", 0], positive=["3", 0], negative=["4", 0]),
            },
        }

        result = parse_image(_write_png(tmp_path, "same_side.png", {"prompt": graph}))

        assert result["negative_prompt"] == loose_negative
        assert result["prompt"] != loose_negative


class TestConsumerMapIsBuiltOncePerGraph:
    def test_repeated_reachability_checks_reuse_the_map(self):
        parser = MetadataParser()
        nodes = {
            "1": {"class_type": "llama_cpp_instruct_adv",
                  "inputs": {"system_prompt": "You write prompts."}},
            "2": {"class_type": "PreviewAny", "inputs": {"source": ["1", 0]}},
            "3": {"class_type": "CLIPTextEncode", "inputs": {"text": ["2", 0]}},
        }
        calls = []
        original = parser._iter_comfyui_input_refs

        def counting(value):
            calls.append(1)
            return original(value)

        parser._iter_comfyui_input_refs = counting

        assert parser._comfyui_output_reaches_text_input(nodes, "1") is True
        first = len(calls)
        assert first > 0
        assert parser._comfyui_output_reaches_text_input(nodes, "1") is True
        assert parser._comfyui_output_reaches_text_input(nodes, "2") is True
        assert len(calls) == first


class TestFormulaWidgetsAreNotPrompts:
    def test_math_expression_widget_in_a_workflow_only_graph(self, tmp_path: Path):
        """A formula kept in a widget (no API graph to say what it is) must not
        become a text input of its node, or the tracer reads it as a prompt."""
        from tests.test_metadata_parser_false_positives import MATH_EXPRESSION

        workflow = _llm_video_ui_workflow(STALE_WIDGET_TEXT)
        workflow["nodes"].append(
            {
                "id": 131,
                "type": "ComfyMathExpression",
                "mode": 0,
                "inputs": [],
                "outputs": [{"name": "INT", "type": "INT", "links": [20]}],
                "widgets_values": [MATH_EXPRESSION],
            }
        )
        _node(workflow, 136)["inputs"].append(
            {"name": "length", "type": "INT", "link": 20}
        )
        workflow["links"].append([20, 131, 0, 136, 3, "INT"])

        result = parse_image(_write_png(tmp_path, "math_ui.png", {"workflow": workflow}))

        assert result["generator"] == "comfyui"
        assert not result["prompt"], result["prompt"]


class TestFillPromptSide:
    def test_candidate_that_extends_the_other_side_does_not_fill(self):
        parser = MetadataParser()
        extended = ENCODER_PROMPT + " <lora:extra_detail:0.6>"

        assert parser._fill_prompt_side(None, extended, ENCODER_PROMPT) is None
        assert parser._fill_prompt_side(None, ENCODER_NEGATIVE, ENCODER_PROMPT) == ENCODER_NEGATIVE

    def test_filled_side_is_only_upgraded_to_a_completed_form(self):
        parser = MetadataParser()
        completed = ENCODER_PROMPT + ", detailed background, soft shadows"

        assert parser._fill_prompt_side(ENCODER_PROMPT, completed, None) == completed
        assert parser._fill_prompt_side(ENCODER_PROMPT, ENCODER_NEGATIVE, None) == ENCODER_PROMPT
