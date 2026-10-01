"""Model Center cards: where a ready model comes from, and why a trusted one is missing (MS1b).

``model_health`` already reports ``source`` on each section that can be served
from a trusted folder (a ComfyUI install, a Hugging Face cache). This turns
that into the card's ``source`` field, and when a card is missing because the
trusted file it was recorded from is gone or changed, replaces its message
with one that names the path.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple

import model_external

# card id -> (model_id, variant) as the matchers record them; wd14 and the
# anime censor pair name their variant from health.
_CARD_MODELS: Dict[str, Tuple[str, Optional[str]]] = {
    "florence2": ("florence2", "base"),
    "lucida": ("lucida", "pinned"),
    "artist": ("artist", "kaloscope2.0"),
    "tipo": ("tipo", "v2.1"),
    "censor-legacy": ("censor-legacy", None),
    "censor-anime": ("censor-anime", "censor"),
    "aesthetic-waifu": ("aesthetic-waifu", None),
    "aesthetic-anime": ("aesthetic-anime", None),
}


def _health_source(card_id: str, health: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    sections = {
        "florence2": health.get("florence2"),
        "lucida": health.get("lucida"),
        "artist": health.get("artist"),
        "tipo": health.get("tipo"),
        "censor-legacy": (health.get("censor") or {}).get("legacy"),
        "censor-anime": health.get("censor_anime"),
        "aesthetic-waifu": health.get("aesthetic_waifu"),
        "aesthetic-anime": health.get("aesthetic_anime"),
    }
    section = sections.get(card_id) or {}
    return section.get("source")


def _wd14_sources(health: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
    models = (health.get("wd14") or {}).get("installed_models") or []
    return {m["name"]: m["source"] for m in models if m.get("source")}


def _problem_target(
    card_id: str, health: Dict[str, Any]
) -> Optional[Tuple[str, Optional[str]]]:
    if card_id == "wd14":
        default = (health.get("wd14") or {}).get("default_model")
        return ("wd14", default) if default else None
    return _CARD_MODELS.get(card_id)


def _annotate_card(card: Dict[str, Any], health: Dict[str, Any]) -> Dict[str, Any]:
    card_id = card.get("id")
    updated = dict(card)
    if card_id == "wd14":
        variant_sources = _wd14_sources(health)
        updated["variant_sources"] = variant_sources
        updated["source"] = (health.get("wd14") or {}).get("source") or next(
            iter(variant_sources.values()), None
        )
    elif card_id == "aesthetic":
        path = card.get("backbone_path")
        updated["source"] = model_external.source_for_path(
            "aesthetic", "backbone", path
        )
    else:
        updated["source"] = _health_source(card_id, health)
    if card.get("status") == "ready":
        return updated
    target = _problem_target(card_id, health)
    broken = model_external.problem(*target) if target else None
    if broken is not None:
        updated.update(broken.problem())
    return updated


def annotate_inventory(
    cards: List[Dict[str, Any]], health: Dict[str, Any]
) -> List[Dict[str, Any]]:
    """The cards with ``source`` set, and a path-naming message when a trusted file went missing."""
    return [_annotate_card(card, health) for card in cards]
