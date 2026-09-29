"""
Tests for enhanced ComfyUI workflow prompt inference.

Covers:
- Dynamic numbered text key matching (string_1, string_2, ..., string_N)
- Fallback strategy when no sampler nodes exist
- Concatenation node handling with unlimited numbered inputs
"""
import pytest
from metadata_parser import MetadataParser


class TestNumberedTextKeyMatching:
    """Test dynamic numbered text key matching for concatenation nodes."""

    def test_is_numbered_text_key_valid_patterns(self):
        """Should match string_N, text_N, prompt_N patterns."""
        parser = MetadataParser()

        # Valid patterns
        assert parser._is_numbered_text_key("string_1") is True
        assert parser._is_numbered_text_key("string_2") is True
        assert parser._is_numbered_text_key("string_10") is True
        assert parser._is_numbered_text_key("string_999") is True
        assert parser._is_numbered_text_key("text_1") is True
        assert parser._is_numbered_text_key("text_20") is True
        assert parser._is_numbered_text_key("prompt_1") is True
        assert parser._is_numbered_text_key("prompt_5") is True

        # Case insensitive
        assert parser._is_numbered_text_key("STRING_1") is True
        assert parser._is_numbered_text_key("Text_2") is True
        assert parser._is_numbered_text_key("PROMPT_3") is True

    def test_is_numbered_text_key_invalid_patterns(self):
        """Should reject non-matching patterns."""
        parser = MetadataParser()

        # Invalid patterns
        assert parser._is_numbered_text_key("string") is False
        assert parser._is_numbered_text_key("string_a") is False
        assert parser._is_numbered_text_key("text1") is False  # Missing underscore
        assert parser._is_numbered_text_key("1_string") is False
        assert parser._is_numbered_text_key("value_1") is False
        assert parser._is_numbered_text_key("input_1") is False
        assert parser._is_numbered_text_key("string_1_extra") is False

    def test_concat_node_with_many_numbered_inputs(self):
        """Should extract text from string_1 through string_20."""
        parser = MetadataParser()

        nodes = {
            "1": {
                "class_type": "StringConcatenate",
                "inputs": {
                    "string_1": "part1",
                    "string_2": "part2",
                    "string_3": "part3",
                    "string_4": "part4",
                    "string_5": "part5",
                    "string_10": "part10",
                    "string_20": "part20",
                }
            }
        }

        texts = parser._extract_text_from_node("1", nodes, set())

        # All parts should be extracted
        assert "part1" in texts
        assert "part2" in texts
        assert "part3" in texts
        assert "part4" in texts
        assert "part5" in texts
        assert "part10" in texts
        assert "part20" in texts

    def test_concat_node_preserves_order(self):
        """Should preserve input order: fixed keys first, then numbered keys sorted."""
        parser = MetadataParser()

        nodes = {
            "1": {
                "class_type": "JoinStrings",
                "inputs": {
                    "string_10": "late",
                    "string_1": "early1",
                    "string_a": "alpha",
                    "string_2": "early2",
                }
            }
        }

        texts = parser._extract_text_from_node("1", nodes, set())

        # Order: string_a first (priority key), then string_1, string_2, string_10 (numbered, sorted)
        assert texts == ["alpha", "early1", "early2", "late"]


class TestFallbackStrategy:
    """Test fallback prompt extraction when no sampler nodes exist."""

    def test_no_sampler_two_clip_nodes(self):
        """Should use first CLIP as positive, second as negative."""
        parser = MetadataParser()

        nodes = {
            "1": {
                "class_type": "CLIPTextEncode",
                "inputs": {"text": "positive prompt"}
            },
            "2": {
                "class_type": "CLIPTextEncode",
                "inputs": {"text": "negative prompt"}
            }
        }

        pos, neg = parser._trace_sampler_prompts(nodes)

        assert pos == "positive prompt"
        assert neg == "negative prompt"

    def test_no_sampler_single_clip_node(self):
        """Should extract single CLIP as positive only."""
        parser = MetadataParser()

        nodes = {
            "1": {
                "class_type": "CLIPTextEncode",
                "inputs": {"text": "only positive"}
            }
        }

        pos, neg = parser._trace_sampler_prompts(nodes)

        assert pos == "only positive"
        assert neg is None

    def test_no_sampler_multiple_clip_nodes(self):
        """Should combine all CLIP nodes as positive."""
        parser = MetadataParser()

        nodes = {
            "1": {
                "class_type": "CLIPTextEncode",
                "inputs": {"text": "prompt1"}
            },
            "2": {
                "class_type": "CLIPTextEncode",
                "inputs": {"text": "prompt2"}
            },
            "3": {
                "class_type": "CLIPTextEncode",
                "inputs": {"text": "prompt3"}
            }
        }

        pos, neg = parser._trace_sampler_prompts(nodes)

        # All prompts should be in positive (order may vary)
        assert "prompt1" in pos
        assert "prompt2" in pos
        assert "prompt3" in pos
        assert neg is None

    def test_no_sampler_no_clip_nodes(self):
        """Should return None when no sampler and no CLIP nodes."""
        parser = MetadataParser()

        nodes = {
            "1": {
                "class_type": "LoadImage",
                "inputs": {"image": "test.png"}
            }
        }

        pos, neg = parser._trace_sampler_prompts(nodes)

        assert pos is None
        assert neg is None

    def test_with_sampler_ignores_fallback(self):
        """Should use sampler path when sampler exists, ignoring fallback."""
        parser = MetadataParser()

        nodes = {
            "clip1": {
                "class_type": "CLIPTextEncode",
                "inputs": {"text": "positive from sampler"}
            },
            "clip2": {
                "class_type": "CLIPTextEncode",
                "inputs": {"text": "negative from sampler"}
            },
            "sampler": {
                "class_type": "KSampler",
                "inputs": {
                    "positive": ["clip1", 0],
                    "negative": ["clip2", 0]
                }
            }
        }

        pos, neg = parser._trace_sampler_prompts(nodes)

        assert pos == "positive from sampler"
        assert neg == "negative from sampler"


class TestConcatenationWithLinks:
    """Test concatenation nodes with upstream connections."""

    def test_concat_with_linked_inputs(self):
        """Should follow links to upstream text nodes."""
        parser = MetadataParser()

        nodes = {
            "text1": {
                "class_type": "StringConstant",
                "inputs": {"string": "hello"}
            },
            "text2": {
                "class_type": "StringConstant",
                "inputs": {"string": "world"}
            },
            "concat": {
                "class_type": "StringConcatenate",
                "inputs": {
                    "string_1": ["text1", 0],
                    "string_2": ["text2", 0]
                }
            }
        }

        texts = parser._extract_text_from_node("concat", nodes, set())

        assert "hello" in texts
        assert "world" in texts

    def test_concat_mixed_literal_and_links(self):
        """Should handle both literal strings and links."""
        parser = MetadataParser()

        nodes = {
            "text1": {
                "class_type": "StringConstant",
                "inputs": {"string": "linked"}
            },
            "concat": {
                "class_type": "JoinStrings",
                "inputs": {
                    "string_1": "literal",
                    "string_2": ["text1", 0],
                    "string_3": "another literal"
                }
            }
        }

        texts = parser._extract_text_from_node("concat", nodes, set())

        assert "literal" in texts
        assert "linked" in texts
        assert "another literal" in texts


class TestRealWorldWorkflow:
    """Integration tests with realistic workflow structures."""

    def test_workflow_only_no_sampler_two_prompts(self):
        """Real scenario: workflow JSON with 2 CLIP nodes, no sampler."""
        parser = MetadataParser()

        workflow = {
            "10": {
                "class_type": "CLIPTextEncode",
                "inputs": {
                    "text": "1girl, beautiful, detailed face",
                    "clip": ["5", 1]
                }
            },
            "11": {
                "class_type": "CLIPTextEncode",
                "inputs": {
                    "text": "bad quality, blurry, low resolution",
                    "clip": ["5", 1]
                }
            },
            "5": {
                "class_type": "CheckpointLoaderSimple",
                "inputs": {"ckpt_name": "model.safetensors"}
            }
        }

        pos, neg = parser._trace_sampler_prompts(workflow)

        assert pos == "1girl, beautiful, detailed face"
        assert neg == "bad quality, blurry, low resolution"

    def test_concat_chain_with_many_inputs(self):
        """Real scenario: concatenating 10+ prompt fragments."""
        parser = MetadataParser()

        nodes = {
            "concat": {
                "class_type": "CR Text Concatenate",
                "inputs": {
                    "text_1": "1girl",
                    "text_2": "long hair",
                    "text_3": "blue eyes",
                    "text_4": "white dress",
                    "text_5": "standing",
                    "text_6": "outdoors",
                    "text_7": "garden",
                    "text_8": "sunlight",
                    "text_9": "detailed",
                    "text_10": "high quality"
                }
            }
        }

        texts = parser._extract_text_from_node("concat", nodes, set())

        assert len(texts) == 10
        assert "1girl" in texts
        assert "high quality" in texts


class TestConditioningBridge:
    """Custom conditioning processors between the sampler and the text
    (v3.5.0, owner report: Anima* node packs produced empty positives)."""

    def _anima_style_graph(self):
        """Minimal replica of the AAA111 Random workflow shape:
        KSampler.positive → CrossAttn (custom keys only) → ArtistPack
        (base_prompt link) → ShowText (stale-able cache + live link) →
        Concatenate → two Text literals. Negative is a plain literal."""
        return {
            "12": {"class_type": "Text", "inputs": {"text": "masterpiece, best quality,"}},
            "13": {"class_type": "Text", "inputs": {"text": "1girl, black hair, hime cut"}},
            "14": {"class_type": "CR Text Concatenate", "inputs": {
                "separator": "", "text1": ["12", 0], "text2": ["13", 0]}},
            "15": {"class_type": "ShowText|pysssss", "inputs": {
                "text": ["14", 0], "text_0": "stale cached copy"}},
            "16": {"class_type": "AnimaArtistPack", "inputs": {
                "artist_chain": "0.6::@someone::", "base_prompt": ["15", 0], "clip": ["11", 1]}},
            "17": {"class_type": "AnimaArtistPreset", "inputs": {
                "preset": "drift_auto", "intensity": 1.0}},
            "18": {"class_type": "AnimaArtistCrossAttn", "inputs": {
                "combine_mode": "output_avg", "strength": 1.0,
                "model": ["11", 0], "artist_pack": ["16", 0],
                "advanced_options": ["17", 1], "preset": ["17", 0]}},
            "20": {"class_type": "CLIPTextEncode", "inputs": {
                "text": "worst quality, blurry", "clip": ["11", 1]}},
            "21": {"class_type": "KSampler", "inputs": {
                "seed": 1, "steps": 20, "positive": ["18", 1],
                "negative": ["20", 0], "model": ["18", 0], "latent_image": ["19", 0]}},
        }

    def test_bridges_custom_conditioning_nodes_to_the_prompt(self):
        parser = MetadataParser()
        pos, neg = parser._trace_sampler_prompts(self._anima_style_graph())

        assert pos is not None
        assert "masterpiece, best quality," in pos
        assert "1girl, black hair, hime cut" in pos
        # Live upstream wins over the ShowText display cache.
        assert "stale cached copy" not in pos
        assert neg == "worst quality, blurry"

    def test_bridge_never_walks_model_channels(self):
        """A text-bearing node reachable ONLY through the model link must
        stay invisible to the positive trace."""
        parser = MetadataParser()
        nodes = {
            "5": {"class_type": "SneakyModelPatcher", "inputs": {
                "text": "not a prompt", "model": ["6", 0]}},
            "18": {"class_type": "MysteryConditioner", "inputs": {
                "model": ["5", 0], "strength": 1.0}},
            "21": {"class_type": "KSampler", "inputs": {
                "positive": ["18", 0], "negative": ["18", 0]}},
        }
        pos, neg = parser._trace_sampler_prompts(nodes)
        assert pos is None
        assert neg is None


class TestImpactPackPipes:
    """Impact Pack pipes carry positive and negative in numbered output slots
    (modules/impact/pipe.py): the slot a link leaves from is the channel."""

    @staticmethod
    def _pipe_graph(from_pipe: str, pos_slot: int, neg_slot: int):
        return {
            "1": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "m.safetensors"}},
            "2": {"class_type": "CLIPTextEncode", "inputs": {"text": "1girl, red scarf, snowy street", "clip": ["1", 1]}},
            "3": {"class_type": "CLIPTextEncode", "inputs": {"text": "worst quality, blurry", "clip": ["1", 1]}},
            "4": {"class_type": "ToBasicPipe", "inputs": {
                "model": ["1", 0], "clip": ["1", 1], "vae": ["1", 2], "positive": ["2", 0], "negative": ["3", 0]}},
            "5": {"class_type": from_pipe, "inputs": {"basic_pipe": ["4", 0]}},
            "6": {"class_type": "KSampler", "inputs": {
                "seed": 1, "steps": 20, "cfg": 5.0, "sampler_name": "euler", "scheduler": "normal", "denoise": 1.0,
                "model": ["5", 0], "positive": ["5", pos_slot], "negative": ["5", neg_slot]}},
        }

    def test_from_basic_pipe_slots_three_and_four(self):
        parser = MetadataParser()
        pos, neg = parser._trace_sampler_prompts(self._pipe_graph("FromBasicPipe", 3, 4))
        assert pos == "1girl, red scarf, snowy street"
        assert neg == "worst quality, blurry"

    def test_from_basic_pipe_v2_shifts_the_slots_by_one(self):
        parser = MetadataParser()
        pos, neg = parser._trace_sampler_prompts(self._pipe_graph("FromBasicPipe_v2", 4, 5))
        assert pos == "1girl, red scarf, snowy street"
        assert neg == "worst quality, blurry"

    def test_model_slot_of_a_pipe_carries_no_text(self):
        parser = MetadataParser()
        nodes = self._pipe_graph("FromBasicPipe", 3, 4)
        # A sampler fed from the pipe's MODEL slot on the positive input is a
        # miswired graph; the tracer must not invent a prompt from the pipe.
        nodes["6"]["inputs"]["positive"] = ["5", 0]
        pos, neg = parser._trace_sampler_prompts(nodes)
        assert pos is None
        assert neg == "worst quality, blurry"

    def test_edit_basic_pipe_override_wins_over_the_builder(self):
        parser = MetadataParser()
        nodes = self._pipe_graph("FromBasicPipe", 3, 4)
        nodes["7"] = {"class_type": "CLIPTextEncode", "inputs": {"text": "1girl, red scarf, rooftop, sunset", "clip": ["1", 1]}}
        nodes["8"] = {"class_type": "EditBasicPipe", "inputs": {"basic_pipe": ["4", 0], "positive": ["7", 0]}}
        nodes["5"]["inputs"]["basic_pipe"] = ["8", 0]
        pos, neg = parser._trace_sampler_prompts(nodes)
        assert pos == "1girl, red scarf, rooftop, sunset"
        assert neg == "worst quality, blurry"  # untouched channel comes from the builder

    def test_two_passes_on_one_pipe_list_the_prompt_once(self):
        parser = MetadataParser()
        nodes = self._pipe_graph("FromBasicPipe", 3, 4)
        nodes["9"] = {"class_type": "FromBasicPipe", "inputs": {"basic_pipe": ["4", 0]}}
        nodes["10"] = {"class_type": "KSampler", "inputs": {
            "seed": 2, "steps": 12, "cfg": 5.0, "sampler_name": "euler", "scheduler": "normal", "denoise": 0.5,
            "model": ["9", 0], "positive": ["9", 3], "negative": ["9", 4]}}
        pos, neg = parser._trace_sampler_prompts(nodes)
        assert pos == "1girl, red scarf, snowy street"
        assert neg == "worst quality, blurry"

    def test_pipe_behind_a_switch_follows_the_selected_branch(self):
        """Owner workflow: FromBasicPipe_v2 fed by ComfySwitchNode choosing
        between two ToBasicPipe branches; the literal switch picks the branch."""
        parser = MetadataParser()
        nodes = {
            "1": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "m.safetensors"}},
            "2": {"class_type": "CLIPTextEncode", "inputs": {"text": "1girl, red scarf, plain branch", "clip": ["1", 1]}},
            "3": {"class_type": "CLIPTextEncode", "inputs": {"text": "1girl, red scarf, artist branch", "clip": ["1", 1]}},
            "4": {"class_type": "CLIPTextEncode", "inputs": {"text": "worst quality, blurry", "clip": ["1", 1]}},
            "5": {"class_type": "ToBasicPipe", "inputs": {
                "model": ["1", 0], "clip": ["1", 1], "vae": ["1", 2], "positive": ["2", 0], "negative": ["4", 0]}},
            "6": {"class_type": "ToBasicPipe", "inputs": {
                "model": ["1", 0], "clip": ["1", 1], "vae": ["1", 2], "positive": ["3", 0], "negative": ["4", 0]}},
            "7": {"class_type": "easy boolean", "inputs": {"value": False}},
            "8": {"class_type": "ComfySwitchNode", "inputs": {"switch": False, "on_false": ["5", 0], "on_true": ["6", 0]}},
            "9": {"class_type": "FromBasicPipe_v2", "inputs": {"basic_pipe": ["8", 0]}},
            "10": {"class_type": "AnimaFlowCorrectiveSampler", "inputs": {
                "seed": 1, "steps": 30, "cfg": 4.0, "model": ["9", 1], "positive": ["9", 4], "negative": ["9", 5]}},
        }
        pos, neg = parser._trace_sampler_prompts(nodes)
        assert pos == "1girl, red scarf, plain branch"
        assert neg == "worst quality, blurry"
        nodes["8"]["inputs"]["switch"] = True
        pos, _neg = parser._trace_sampler_prompts(nodes)
        assert pos == "1girl, red scarf, artist branch"

    def test_pipe_behind_an_unknown_passthrough_still_resolves(self):
        parser = MetadataParser()
        nodes = self._pipe_graph("FromBasicPipe", 3, 4)
        nodes["11"] = {"class_type": "SomeCustomPipeCache", "inputs": {"pipe_in": ["4", 0], "label": "x"}}
        nodes["5"]["inputs"]["basic_pipe"] = ["11", 0]
        pos, neg = parser._trace_sampler_prompts(nodes)
        assert pos == "1girl, red scarf, snowy street"
        assert neg == "worst quality, blurry"


class TestTagGeneratorBanLists:
    """A tag generator's ban/exclude list is wired from the negative prompt;
    following it would put the negative inside the positive."""

    def test_ban_tags_link_is_not_walked_into_the_positive(self):
        parser = MetadataParser()
        nodes = {
            "1": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "m.safetensors"}},
            "2": {"class_type": "CLIPTextEncode", "inputs": {"text": "worst quality, blurry, watermark", "clip": ["1", 1]}},
            "3": {"class_type": "ShowText|pysssss", "inputs": {"text": ["2", 0], "text_0": "worst quality, blurry, watermark"}},
            "4": {"class_type": "TIPO", "inputs": {"tags": "1girl, red scarf", "nl_prompt": "", "ban_tags": ["3", 0],
                                                    "tipo_model": "x.gguf", "seed": 1}},
            "5": {"class_type": "ShowText|pysssss", "inputs": {"text": ["4", 0], "text_0": "1girl, red scarf, snowy street, lantern light"}},
            "6": {"class_type": "CLIPTextEncode", "inputs": {"text": ["5", 0], "clip": ["1", 1]}},
            "7": {"class_type": "KSampler", "inputs": {"positive": ["6", 0], "negative": ["2", 0]}},
        }
        pos, neg = parser._trace_sampler_prompts(nodes)
        assert pos == "1girl, red scarf, snowy street, lantern light"
        assert "blurry" not in pos
        assert neg == "worst quality, blurry, watermark"


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
