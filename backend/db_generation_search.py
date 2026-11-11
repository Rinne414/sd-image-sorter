"""Search by sampler, steps and CFG: terms carried inside the search text.

"Which pictures used Euler a at 28 steps?" The answer sits in each picture's
parsed generation data, not in a column. These three terms ride in the
free-text search itself (``sampler:"euler a" steps:20..30 cfg<=7 rain``), so
they reach every place the search text already reaches (gallery pages, counts,
select-all, Auto-Separate, Manual Sort, bulk tagging, export) without a new
parameter threaded through each of them. This module takes the terms out of
the text and turns them into conditions; what is left is the ordinary search.

    sampler:VALUE      the sampler's name contains VALUE (spaces and underscores alike)
    steps:28           exactly 28;  steps:20..30  a range;  steps>=30  steps<=20
    cfg:7              the same forms as steps, with decimals

A term whose value is not readable is left in the text as ordinary words.
The values are read from ``metadata_json`` like the seed filter does, guarded
by ``json_valid`` (legacy rows may hold text that is not JSON).
"""

from __future__ import annotations

import re
from typing import Any, List, Optional, Tuple

_TERM = re.compile(
    r"(?<!\S)(sampler|steps|cfg)\s*(>=|<=|==|=|:|>|<)\s*(\"[^\"]*\"|\S+)",
    re.IGNORECASE,
)
_RANGE = re.compile(r"^(-?\d+(?:\.\d+)?)\.\.(-?\d+(?:\.\d+)?)$")


def _param(*names: str) -> str:
    """The first of the named generation parameters a picture has, as SQL."""
    paths = ", ".join(
        f"json_extract(i.metadata_json, '$._parsed.generation_params.{name}')"
        for name in names
    )
    # Guarded here, not in each condition: damaged metadata reads as "no such
    # parameter", and the same expression can be indexed (migration 070 builds
    # its indexes from these very strings, so the planner matches them).
    return f"CASE WHEN json_valid(i.metadata_json) THEN COALESCE({paths}) END"


_SAMPLER_SQL = (
    f"LOWER(REPLACE(CAST({_param('sampler', 'sampler_name')} AS TEXT), '_', ' '))"
)
_NUMBER_SQL = {
    "steps": f"CAST({_param('steps', 'num_inference_steps')} AS REAL)",
    "cfg": f"CAST({_param('cfg_scale', 'cfg', 'scale')} AS REAL)",
}
_HAS_SQL = {
    "steps": f"{_param('steps', 'num_inference_steps')} IS NOT NULL",
    "cfg": f"{_param('cfg_scale', 'cfg', 'scale')} IS NOT NULL",
}


def _number(text: str) -> Optional[float]:
    try:
        return float(text)
    except ValueError:
        return None


def _numeric_condition(
    key: str, operator: str, value: str
) -> Optional[Tuple[str, List[Any]]]:
    column = _NUMBER_SQL[key]
    present = _HAS_SQL[key]
    span = _RANGE.match(value)
    if span and operator in (":", "=", "=="):
        low, high = sorted((float(span.group(1)), float(span.group(2))))
        return f"({present} AND {column} BETWEEN ? AND ?)", [low, high]
    number = _number(value)
    if number is None:
        return None
    # As in the rest of the search syntax, < and > include the bound.
    if operator in (">=", ">"):
        return f"({present} AND {column} >= ?)", [number]
    if operator in ("<=", "<"):
        return f"({present} AND {column} <= ?)", [number]
    return f"({present} AND {column} = ?)", [number]


def extract(search: Optional[str]) -> Tuple[str, List[str], List[Any]]:
    """``(the search text without the generation terms, conditions, params)``."""
    text = str(search or "")
    conditions: List[str] = []
    params: List[Any] = []

    def take(match: "re.Match[str]") -> str:
        key = match.group(1).lower()
        operator = match.group(2)
        value = match.group(3).strip('"').strip()
        if not value:
            return match.group(0)
        if key == "sampler":
            if operator not in (":", "=", "=="):
                return match.group(0)
            needle = value.lower().replace("_", " ")
            escaped = (
                needle.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
            )
            conditions.append(f"({_SAMPLER_SQL} LIKE ? ESCAPE '\\')")
            params.append(f"%{escaped}%")
            return " "
        built = _numeric_condition(key, operator, value)
        if built is None:
            return match.group(0)
        conditions.append(built[0])
        params.extend(built[1])
        return " "

    rest = _TERM.sub(take, text)
    return (" ".join(rest.split()) if conditions else text), conditions, params


def index_expressions() -> dict:
    """Index name -> the expression it indexes (without the query's table alias)."""

    def bare(sql: str) -> str:
        return sql.replace("i.metadata_json", "metadata_json")

    return {
        "idx_images_gen_steps": bare(_NUMBER_SQL["steps"]),
        "idx_images_gen_cfg": bare(_NUMBER_SQL["cfg"]),
        "idx_images_gen_sampler": bare(_SAMPLER_SQL),
    }
