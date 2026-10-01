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
        state = self._trace_memo_state(nodes)
        frames = state.frames
        for frame in frames:
            frame.touched.add(node_id)
        self._trace_memo_note_depth(depth)

        key = (node_id, side)
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
        # frames hold only this walk's ancestors, which were all updated as it ran
        state.cache[key] = (
            [dict(item) for item in result],
            frozenset(frame.touched),
            frozenset(frame.touched & visited),
            depth,
            frame.max_depth - depth,
        )
        return result
