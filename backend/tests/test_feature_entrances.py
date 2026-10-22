"""
Feature-entrance check (owner, 2026-10-23): a feature's entrance may not
silently disappear from an interface that should have it.

docs/feature-entrances.json lists every user-facing feature with the classic
interface (frontend/index.html) as the baseline. This static half fails when a
classic entrance is gone, when a new classic button belongs to no feature, or
when a removal has no recorded reason, date and owner's words. The real-browser
half is tests/e2e/specs/feature-entrances.spec.ts.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
REGISTRY_PATH = ROOT / "docs" / "feature-entrances.json"
CLASSIC_HTML_PATH = ROOT / "frontend" / "index.html"

ID_SELECTOR_RE = re.compile(r"#([\w-]+)")
ATTR_SELECTOR_RE = re.compile(r'\[([\w-]+)="([^"]*)"\]')
BUTTON_ID_RE = re.compile(r'<button\b[^>]*?\bid="([^"]+)"', re.S)
HOW_TO_REMOVE = (
    "Bring it back. If the owner agreed to remove it, move the feature (or the "
    "selector) to 'removed' in docs/feature-entrances.json with date, reason and "
    "the owner's words."
)


def _registry() -> dict:
    return json.loads(REGISTRY_PATH.read_text(encoding="utf-8"))


def _classic_html() -> str:
    return CLASSIC_HTML_PATH.read_text(encoding="utf-8")


def _selector_in_html(selector: str, html: str) -> bool:
    id_match = ID_SELECTOR_RE.fullmatch(selector)
    if id_match:
        return re.search(rf'\bid="{re.escape(id_match.group(1))}"', html) is not None
    attr_match = ATTR_SELECTOR_RE.fullmatch(selector)
    if attr_match:
        name, value = attr_match.groups()
        return re.search(rf'\b{re.escape(name)}="{re.escape(value)}"', html) is not None
    raise AssertionError(
        f'Classic selectors must be #id or [attr="value"], got {selector!r}'
    )


def test_every_feature_is_named_in_both_languages_with_a_classic_entrance():
    features = _registry()["features"]
    ids = [feature["id"] for feature in features]
    assert len(ids) == len(set(ids)), "feature ids must be unique"
    for feature in features:
        assert feature.get("en") and feature.get("zh"), (
            f"{feature['id']} needs an English and a Chinese name"
        )
        assert feature.get("classic"), (
            f"{feature['id']} needs at least one classic selector"
        )


def test_every_classic_entrance_still_exists():
    html = _classic_html()
    gone = [
        f"{feature['id']} ({feature['en']}): {selector}"
        for feature in _registry()["features"]
        for selector in feature["classic"]
        if not _selector_in_html(selector, html)
    ]
    assert not gone, (
        "Classic entrances are gone:\n  " + "\n  ".join(gone) + "\n" + HOW_TO_REMOVE
    )


def test_every_classic_button_belongs_to_a_feature():
    registry = _registry()
    claimed = {
        selector[1:]
        for feature in registry["features"]
        for selector in feature["classic"]
        if selector.startswith("#")
    }
    claimed.update(
        button_id for group in registry["not_entrances"] for button_id in group["ids"]
    )
    unclaimed = [
        button_id
        for button_id in BUTTON_ID_RE.findall(_classic_html())
        if button_id not in claimed
    ]
    assert not unclaimed, (
        "New classic buttons that no feature lists: "
        + ", ".join(unclaimed)
        + ". Add each to its feature in docs/feature-entrances.json (a new feature needs "
        "en/zh names and its vopus/next status), or to not_entrances with the reason."
    )


def test_not_entrances_are_current_and_explained():
    html = _classic_html()
    for group in _registry()["not_entrances"]:
        assert group.get("reason"), "every not_entrances group needs a reason"
        stale = [
            button_id for button_id in group["ids"] if f'id="{button_id}"' not in html
        ]
        assert not stale, f"not_entrances lists buttons that no longer exist: {stale}"


def test_removals_carry_date_reason_and_owner_words():
    registry = _registry()
    live = {feature["id"] for feature in registry["features"]}
    for removal in registry["removed"]:
        for field in ("id", "interface", "date", "reason", "owner_words"):
            assert removal.get(field), f"removed entry {removal} needs {field!r}"
        assert re.fullmatch(r"\d{4}-\d{2}-\d{2}", removal["date"]), (
            f"{removal['id']}: date must be YYYY-MM-DD"
        )
        if removal["interface"] == "classic":
            assert removal["id"] not in live or removal.get("selector"), (
                f"{removal['id']} is listed as removed from classic but is still a live feature"
            )
