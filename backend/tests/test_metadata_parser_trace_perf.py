"""MP2 item 1: text tracing over long shared-input chains must not go exponential.

Every graph is synthetic.
"""

from __future__ import annotations

import random
import time

from metadata_parser import MetadataParser


def _dead_end_chain(length: int) -> dict:
    """Each node reads the previous one through two keys; the bottom is a dead
    end, so a path-by-path walk visits 2**length routes before giving up."""
    nodes = {"0": {"class_type": "MysteryBox", "inputs": {"seed": 1}}}
    for index in range(1, length + 1):
        nodes[str(index)] = {
            "class_type": "MysteryBox",
            "inputs": {"alpha": [str(index - 1), 0], "beta": [str(index - 1), 0]},
        }
    return nodes


def _join_chain(length: int) -> dict:
    """A deep chain of join nodes with a literal each and a shared dead-end side branch."""
    nodes = {"dead": {"class_type": "MysteryBox", "inputs": {"seed": 1}}}
    nodes["0"] = {"class_type": "StringConcatenate", "inputs": {"string_a": "start", "string_b": ["dead", 0]}}
    for index in range(1, length + 1):
        nodes[str(index)] = {
            "class_type": "StringConcatenate",
            "inputs": {
                "string_a": [str(index - 1), 0],
                "string_b": f"part{index}",
                "string_c": ["dead", 0],
                "string_d": [str(index - 1), 0] if index % 2 else ["dead", 0],
            },
        }
    return nodes


def _trace(parser: MetadataParser, nodes: dict, top: str):
    return parser._trace_to_text_with_source([top, 0], nodes, set())


class TestTraceStaysLinear:
    def test_dead_end_chain_of_30_nodes_traces_in_under_a_second(self):
        parser = MetadataParser()
        nodes = _dead_end_chain(30)
        started = time.perf_counter()
        traced = _trace(parser, nodes, "30")
        assert time.perf_counter() - started < 1.0
        assert traced == []

    def test_join_chain_of_30_nodes_traces_in_under_a_second(self):
        parser = MetadataParser()
        nodes = _join_chain(30)
        started = time.perf_counter()
        traced = _trace(parser, nodes, "30")
        assert time.perf_counter() - started < 1.0
        assert any(item["text"] == "part30" for item in traced)

    def test_memoised_trace_equals_the_plain_walk_on_random_graphs(self):
        parser = MetadataParser()
        oracle = _PlainWalkParser()
        for seed in range(300):
            nodes = _random_graph(random.Random(seed))
            for side in (None, "positive", "negative"):
                for top in nodes:
                    plain = oracle._extract_text_from_node_with_source(top, nodes, set(), 0, side=side)
                    memo = parser._extract_text_from_node_with_source(top, nodes, set(), 0, side=side)
                    assert memo == plain, (seed, side, top)

    def test_memoised_trace_keeps_the_depth_cap_of_the_plain_walk(self):
        parser = MetadataParser()
        oracle = _PlainWalkParser()
        nodes = _join_chain(26)
        nodes["26b"] = {"class_type": "StringConcatenate", "inputs": {"string_a": ["26", 0], "string_b": ["10", 0]}}
        for top in ("26b", "26", "13", "5"):
            assert parser._trace_to_text_with_source([top, 0], nodes, set()) == oracle._trace_to_text_with_source(
                [top, 0], nodes, set()
            )


class _PlainWalkParser(MetadataParser):
    """The trace without the memo: the reference the memoised walk must equal."""

    def _extract_text_from_node_with_source(self, node_id, nodes, visited, depth=0, side=None):
        return self._extract_text_from_node_with_source_uncached(node_id, nodes, visited, depth, side=side)


def _random_graph(rng: random.Random) -> dict:
    classes = [
        "MysteryBox",
        "StringConcatenate",
        "CLIPTextEncode",
        "ShowText",
        "Reroute",
        "WeiLinPromptUI",
        "ControlNetApplyAdvanced",
    ]
    keys = ["text", "string_a", "string_b", "positive", "negative", "conditioning", "alpha", "text_0", "source"]
    count = rng.randint(4, 12)
    nodes = {}
    for index in range(count):
        inputs = {}
        for key in rng.sample(keys, rng.randint(1, 4)):
            roll = rng.random()
            if roll < 0.55:
                inputs[key] = [str(rng.randrange(count)), 0]  # may point at itself or form a cycle
            elif roll < 0.85:
                inputs[key] = f"lit{index}{key}"
        nodes[str(index)] = {"class_type": rng.choice(classes), "inputs": inputs}
    return nodes
