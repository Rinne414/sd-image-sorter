"""MP2 follow-ups to the MP1 ComfyUI parser fixes.

Every fixture is synthetic: graph shapes only, no owner image content.
"""

from __future__ import annotations

from pathlib import Path

from metadata_parser import MetadataParser, parse_image
from tests.test_metadata_parser_false_positives import _write_png

SCENE = (
    "1girl, standing in a quiet harbour town at dusk, gulls over the water, "
    "warm lantern light, detailed background, soft shadows"
)
LORA_STACK = "<lora:style-boost:0.80> <lora:character-a:0.50>"


def _sampler(positive: list, negative: list | None = None) -> dict:
    return {
        "class_type": "KSampler",
        "inputs": {"positive": positive, "negative": negative or ["neg", 0], "model": ["loader", 0]},
    }


def _parse(tmp_path: Path, name: str, graph: dict) -> dict:
    return parse_image(_write_png(tmp_path, name, {"prompt": graph}))


class TestLoraStringsAreNotTraced:
    def _graph(self) -> dict:
        return {
            "loader": {"class_type": "Lora Loader (LoraManager)", "inputs": {"text": LORA_STACK}},
            "toggle": {
                "class_type": "TriggerWord Toggle (LoraManager)",
                "inputs": {"group_mode": True, "trigger_words": ["loader", 0]},
            },
            "join": {
                "class_type": "StringConcatenate",
                "inputs": {"string_a": ["toggle", 0], "string_b": SCENE},
            },
            "enc": {"class_type": "CLIPTextEncode", "inputs": {"text": ["join", 0]}},
            "neg": {"class_type": "CLIPTextEncode", "inputs": {"text": "worst quality, lowres, bad anatomy"}},
            "ks": _sampler(["enc", 0]),
        }

    def test_trigger_word_output_that_is_only_lora_tags_is_not_the_prompt(self):
        pos, _neg = MetadataParser()._trace_sampler_prompts(self._graph())
        assert pos == SCENE

    def test_prompt_fragments_with_few_letters_are_kept(self):
        """Weighted artist chunks and lone separators are not formulas."""
        graph = self._graph()
        graph["join"]["inputs"]["string_b"] = ["tail", 0]
        graph["tail"] = {
            "class_type": "StringConcatenate",
            "inputs": {"string_a": SCENE, "string_b": "(name one:1.4),1=2,", "string_1": ",", "string_2": ";)"},
        }
        pos, _neg = MetadataParser()._trace_sampler_prompts(graph)
        assert pos == "\n".join([SCENE, "(name one:1.4),1=2,", ",", ";)"])

    def test_a_prompt_that_is_only_lora_tags_is_still_reported(self):
        graph = self._graph()
        graph["enc"] = {"class_type": "CLIPTextEncode", "inputs": {"text": LORA_STACK}}
        pos, _neg = MetadataParser()._trace_sampler_prompts(graph)
        assert pos == LORA_STACK

    def test_lora_only_source_falls_through_to_the_next_source(self, tmp_path: Path):
        graph = self._graph()
        graph["enc"] = {"class_type": "CLIPTextEncode", "inputs": {"text": ["toggle", 0]}}
        graph["toggle"]["inputs"]["fallback_text"] = ["alt", 0]
        graph["alt"] = {"class_type": "PrimitiveStringMultiline", "inputs": {"value": SCENE}}
        result = _parse(tmp_path, "fallthrough.png", graph)
        assert result["prompt"] == SCENE
