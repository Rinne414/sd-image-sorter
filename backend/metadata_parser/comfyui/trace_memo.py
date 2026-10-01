"""Memoised entry point for the ComfyUI text trace.

The trace walks the graph with a per-path ``visited`` set, so a shared input
reached by many routes is walked once per route: a chain of 21+ text nodes
cost 16-40 seconds. A subtree's answer depends only on its node and side, on
the depth it starts at (the depth cap) and on which of its nodes are already
on the current path (the cycle guard). This memo records the nodes a subtree
touched (and which of them were already on the path), the depth it started at
and the deepest depth it noted, and reuses the answer only where neither could
change it, so the result is identical to the plain walk.
"""

from __future__ import annotations

import re
import threading
from typing import Any, Dict, List, Optional, Set

# Mirrors the cap in ``_trace_to_text_with_source``.
TRACE_DEPTH_LIMIT = 20


class _Frame:
    __slots__ = ("touched", "max_depth")

    def __init__(self, depth: int) -> None:
        self.touched: Set[str] = set()
        self.max_depth = depth


class _MemoState(threading.local):
    nodes: Optional[Dict[str, dict]] = None
    size = -1
    # True while a trace may return strings that are only LoRA tags.
    keep_tag_stacks = False

    def __init__(self) -> None:
        self.cache: Dict[Any, Any] = {}
        self.frames: List[_Frame] = []


class ComfyUITraceMemoMixin:
    """Cached ``_extract_text_from_node_with_source`` (the plain walk is ``..._uncached``)."""

    _trace_memo = _MemoState()

    def _trace_memo_state(self, nodes: Dict[str, dict]) -> _MemoState:
        state = self._trace_memo
        # The graph is only mutated while it is built; a different dict or a
        # changed node count means a new graph, so the old answers are dropped.
        if state.nodes is not nodes or state.size != len(nodes):
            state.nodes = nodes
            state.size = len(nodes)
            state.cache = {}
            state.frames = []
        return state

    @staticmethod
    def _is_tag_stack_text(text: Any) -> bool:
        """A LoraManager trigger-word string is just ``<lora:...>`` tags, not a
        prompt, so a trace that reaches one carries on to the next source.

        Only whole tag stacks count: a formula test would also drop real
        fragments such as ``(artist name:1.4),1=2,`` or a lone ``,``."""
        from prompt_text_scorer import looks_like_tag_stack

        return isinstance(text, str) and looks_like_tag_stack(text)

    def _trace_texts_with_source(self, ref: Any, nodes: Dict[str, dict], side: Optional[str] = None) -> List[Dict[str, Any]]:
        """Trace one prompt input from the top, skipping LoRA-tag strings.

        A prompt that really is only LoRA tags still comes back: when the
        filtered trace finds nothing it is repeated with the strings allowed.
        """
        state = self._trace_memo_state(nodes)
        traced = self._trace_to_text_with_source(ref, nodes, set(), side=side)
        if traced:
            return traced
        state.keep_tag_stacks = True
        try:
            return self._trace_to_text_with_source(ref, nodes, set(), side=side)
        finally:
            state.keep_tag_stacks = False

    def _trace_texts(self, ref: Any, nodes: Dict[str, dict], side: Optional[str] = None) -> List[str]:
        return [item["text"] for item in self._trace_texts_with_source(ref, nodes, side) if item.get("text")]

    # Matched against whole words of the class name (``LLMChat`` yes,
    # ``AllMighty`` no); "promptexpand" is matched across two adjacent words.
    _RUNTIME_SOURCE_WORDS = frozenset({"llm", "vlm", "ollama", "gemini", "joycaption", "florence", "describe"})
    _CLASS_WORD_RE = re.compile(r"[A-Z]+(?![a-z])|[A-Z]?[a-z]+|\d+")

    def _is_runtime_text_source(self, node: Any, nodes: Dict[str, dict], node_id: str) -> bool:
        """A node that writes its text at run time (an LLM or prompt expander).

        Selectors, concatenators and switches are not: their text comes from
        the graph, and a display beside them can show a different run's pick.
        """
        if not isinstance(node, dict):
            return False
        if self._is_comfyui_instruct_node(node, nodes, node_id):
            return True
        words = [word.lower() for word in self._CLASS_WORD_RE.findall(str(node.get("class_type") or ""))]
        return bool(self._RUNTIME_SOURCE_WORDS.intersection(words)) or "promptexpand" in "".join(words)

    @staticmethod
    def _is_non_prompt_display_value(text: str) -> bool:
        from prompt_text_scorer import looks_like_formula_or_tag_stack, looks_like_non_prompt_value

        return looks_like_non_prompt_value(text) or looks_like_formula_or_tag_stack(text)

    def _read_display_of_runtime_source(
        self, node_id: str, slot: Any, nodes: Dict[str, dict]
    ) -> List[Dict[str, Any]]:
        """What display nodes beside the path stored for one output of a node.

        A run-time source (an LLM, a prompt expander) has no value in the
        graph, but a ShowText / PreviewAny fed by the same output keeps the
        result of the run even when it is not on the sampler's path. Only a
        stored display value counts; a widget typed before the input was
        wired is never read.
        """
        if not self._is_runtime_text_source(nodes.get(node_id), nodes, node_id):
            return []
        found: List[Dict[str, Any]] = []
        for display_id, display in nodes.items():
            inputs = display.get("inputs") if isinstance(display, dict) else None
            if not isinstance(inputs, dict) or not self._is_comfyui_display_node(display.get("class_type")):
                continue
            if not any(
                isinstance(value, (list, tuple)) and len(value) >= 2
                and str(value[0]) == str(node_id) and str(value[1]) == str(slot)
                for value in inputs.values()
            ):
                continue
            for key in ("text_0", "text", "string"):
                value = inputs.get(key)
                if isinstance(value, str) and value.strip() and not self._is_non_prompt_display_value(value):
                    found.append({
                        "text": value.strip(),
                        "source_node_id": str(display_id),
                        "source_class_type": display.get("class_type", ""),
                        "source_key": key,
                    })
                    break
        return self._pick_display_reading(found, nodes)

    def _pick_display_reading(self, found: List[Dict[str, Any]], nodes: Dict[str, dict]) -> List[Dict[str, Any]]:
        """One display reading, or none when displays of one output disagree.

        Equal values are one answer. Different values go to the display with
        the most downstream consumers; a tie reads nothing, because a wrong
        prompt is worse than no prompt.
        """
        if len({item["text"] for item in found}) <= 1:
            return found[:1]
        consumers = self._comfyui_consumer_map(nodes)
        ranked = sorted(found, key=lambda item: len(consumers.get(item["source_node_id"], [])), reverse=True)
        top = len(consumers.get(ranked[0]["source_node_id"], []))
        if top > len(consumers.get(ranked[1]["source_node_id"], [])):
            return ranked[:1]
        return []

    def _trace_memo_note_depth(self, depth: int) -> None:
        for frame in self._trace_memo.frames:
            if depth > frame.max_depth:
                frame.max_depth = depth

    def _extract_text_from_node_with_source(
        self,
        node_id: str,
        nodes: Dict[str, dict],
        visited: Set[str],
        depth: int = 0,
        side: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        # The memo assumes the ``nodes`` dict is not edited in place while it is
        # being traced (it is only mutated while the graph is built); a cached
        # answer is dropped only when the dict object or its length changes.
        state = self._trace_memo_state(nodes)
        frames = state.frames
        for frame in frames:
            frame.touched.add(node_id)
        self._trace_memo_note_depth(depth)

        key = (node_id, side, state.keep_tag_stacks)
        entry = state.cache.get(key)
        if entry is not None:
            result, touched, hits, start, height = entry
            same_cutoffs = depth == start or (
                start + height <= TRACE_DEPTH_LIMIT and depth + height <= TRACE_DEPTH_LIMIT
            )
            if same_cutoffs and touched & visited == hits:
                for frame in frames:
                    frame.touched |= touched
                self._trace_memo_note_depth(depth + height)
                return [dict(item) for item in result]

        frame = _Frame(depth)
        frame.touched.add(node_id)
        frames.append(frame)
        try:
            result = self._extract_text_from_node_with_source_uncached(
                node_id, nodes, visited, depth, side=side
            )
        finally:
            frames.pop()
        if not state.keep_tag_stacks:
            result = [item for item in result if not self._is_tag_stack_text(item.get("text"))]
        # frames hold only this walk's ancestors, which were all updated as it ran
        state.cache[key] = (
            [dict(item) for item in result],
            frozenset(frame.touched),
            frozenset(frame.touched & visited),
            depth,
            frame.max_depth - depth,
        )
        return result
