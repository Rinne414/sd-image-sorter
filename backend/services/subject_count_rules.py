"""Subject-count conflicts in one caption: ``1girl`` beside ``2girls``, ``solo``
beside ``multiple girls``.

A trainer reads every tag as a statement about the picture, so two counts
that cannot both be true teach it nothing but noise. The idea (not the code)
comes from storyAura/BooruDatasetTagManagerPlus ``TagConsistencyPlanner`` and
starkoook/baka.

The rules, on tags folded to lower case with spaces instead of underscores:

* Count tags are ``Ngirl(s)`` / ``Nboy(s)`` / ``Nother(s)`` (``6+girls`` counts
  as 6) and ``multiple girls`` / ``boys`` / ``others`` (at least 2).
* In one family the highest count wins and the lower explicit counts go.
  ``multiple girls`` agrees with any count of 2 or more, so it stays.
* ``solo`` goes when the kept counts add up to two or more subjects (a girl and
  a boy included). ``solo focus`` is a different tag and is never touched.

This only proposes; the caller shows it and the user decides.
"""
from __future__ import annotations

import re
from typing import Dict, Iterable, List, Optional, Set

FAMILIES = ("girl", "boy", "other")
SOLO_TAG = "solo"
# "1girl", "2girls", "6+girls": a number, an optional plus, the noun (plural from 2).
_EXPLICIT = re.compile(r"^(\d+)(\+?)(girl|boy|other)(s?)$")
_MULTIPLE = re.compile(r"^multiple (girl|boy|other)s$")
_MULTIPLE_MEANS_AT_LEAST = 2


def _fold(tag: object) -> str:
    return " ".join(str(tag or "").strip().lower().replace("_", " ").split())


def _explicit_count(folded: str) -> Optional[tuple[str, int]]:
    match = _EXPLICIT.match(folded)
    if not match:
        return None
    count = int(match.group(1))
    plural = bool(match.group(4))
    # "1girls" and "2girl" are not tags anyone writes; do not guess at them.
    if count < 1 or plural != (count > 1):
        return None
    return match.group(3), count


def resolve_subject_counts(tags: Iterable[object]) -> Optional[Dict[str, List[str]]]:
    """``{"keep": [...], "drop": [...]}`` for one caption's tags, or None when
    its subject tags agree with each other."""
    explicit: Dict[str, Dict[str, int]] = {family: {} for family in FAMILIES}
    multiple: Set[str] = set()
    has_solo = False
    for raw in tags:
        folded = _fold(raw)
        if folded == SOLO_TAG:
            has_solo = True
            continue
        found = _explicit_count(folded)
        if found:
            explicit[found[0]][folded] = found[1]
            continue
        match = _MULTIPLE.match(folded)
        if match:
            multiple.add(match.group(1))

    keep: List[str] = []
    drop: List[str] = []
    subjects = 0
    for family in FAMILIES:
        counts = explicit[family]
        top = max(counts.values(), default=0)
        if family in multiple:
            top = max(top, _MULTIPLE_MEANS_AT_LEAST)
        subjects += top
        for tag, count in counts.items():
            (keep if count >= top else drop).append(tag)
        if family in multiple:
            keep.append(f"multiple {family}s")
    if has_solo and subjects >= 2:
        drop.append(SOLO_TAG)
    if not drop:
        return None
    return {"keep": sorted(keep), "drop": sorted(drop)}
