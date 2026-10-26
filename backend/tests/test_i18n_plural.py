"""English counts in the classic UI read right when the count is 1.

``I18n.format`` (frontend/js/i18n.js) writes "1 image is" for the pack text
"{count} images are"; Vopus does the same with frontend-v4/src/i18n/plural.ts.
These tests run the real i18n.js under node, keep the two word lists equal,
and hold every English count in lang/en.js to them (the same rules as
frontend-v4/src/i18n/packs.test.ts, part d).
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
HARNESS = Path(__file__).with_name("i18n_plural_harness.cjs")
VOPUS_PLURAL = ROOT / "frontend-v4" / "src" / "i18n" / "plural.ts"

pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="node is required")

# A plural-looking word right after a count that is not a noun.
NOT_NOUNS = {
    "is",
    "as",
    "has",
    "was",
    "this",
    "its",
    "ms",
    "s",
    "yes",
    "plus",
    "less",
    "across",
    "unless",
    "thus",
    "whose",
    "does",
    "needs",
    # verbs after a name ("{name} keeps installing", "{path} holds", "{tags} becomes")
    "keeps",
    "holds",
    "becomes",
}
# Words that start a phrase after a count but never modify its noun ("{n} from folders").
NOT_MODIFIERS = {
    "from",
    "with",
    "without",
    "of",
    "in",
    "into",
    "to",
    "for",
    "on",
    "at",
    "by",
    "and",
    "or",
    "as",
    "than",
    "the",
}


def _harness(*args: str):
    done = subprocess.run(
        ["node", str(HARNESS), *args],
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=True,
    )
    return json.loads(done.stdout)


@pytest.fixture(scope="module")
def data() -> dict:
    return _harness("data")


def _format(cases: list[tuple[str, dict]]) -> list[str]:
    return _harness(
        "format", json.dumps([{"template": t, "params": p} for t, p in cases])
    )


def test_a_count_of_one_takes_singular_words():
    cases = [
        ("{count} images", {"count": 1}),
        ("{count} images", {"count": 2}),
        ("{count} images", {"count": "1"}),
        ("{count} images are too small", {"count": 1}),
        (
            "<strong>{count}</strong> images will be {action}",
            {"count": 1, "action": "moved"},
        ),
        ("{count} folder images", {"count": 1}),
        ("{n} already have captions", {"n": 1}),
        ("Saved {done} of {total} images", {"done": 1, "total": 1}),
        ("{count} 张图片", {"count": 1}),
        ("{count} images", {"count": "1,000"}),
        ("Caption edits for {count} images were cleared", {"count": 1}),
        ("Caption edits for {count} images that were not exported", {"count": 1}),
        ("{count} problems stop this export.", {"count": 1}),
    ]
    assert _format(cases) == [
        "1 image",
        "2 images",
        "1 image",
        "1 image is too small",
        "<strong>1</strong> image will be moved",
        "1 folder image",
        "1 already has captions",
        "Saved 1 of 1 image",
        "1 张图片",
        "1,000 images",
        "Caption edits for 1 image were cleared",
        "Caption edits for 1 image that was not exported",
        "1 problem stops this export.",
    ]


def test_values_are_written_verbatim_everywhere():
    cases = [("{name} / {name}", {"name": "a$&b$1"}), ("no params", {})]
    assert _format(cases) == ["a$&b$1 / a$&b$1", "no params"]


def _vopus_lists() -> dict:
    text = VOPUS_PLURAL.read_text(encoding="utf-8")

    def block(start: str) -> str:
        head = text.index(start)
        return text[
            head : text.index("\n}", head)
            if "Record" in start
            else text.index("])", head)
        ]

    plurals = dict(
        re.findall(r"^\s+(\w+): '([\w-]+)',$", block("export const PLURALS"), re.M)
    )
    modifiers = re.findall(r"'([\w-]+)'", block("export const MODIFIERS"))
    verbs = dict(
        re.findall(r"^\s+(\w+): '([\w-]+)',$", block("export const VERBS"), re.M)
    )
    return {"PLURALS": plurals, "MODIFIERS": modifiers, "VERBS": verbs}


def test_the_word_lists_match_vopus(data):
    vopus = _vopus_lists()
    rules = data["rules"]
    assert len(vopus["PLURALS"]) > 40 and len(vopus["VERBS"]) > 5
    assert rules["PLURALS"] == vopus["PLURALS"]
    assert sorted(rules["MODIFIERS"]) == sorted(vopus["MODIFIERS"])
    assert rules["VERBS"] == vopus["VERBS"]


def _count_problems(text: str, plurals: dict, modifiers: set) -> list[str]:
    problems = []
    for m in re.finditer(r"\{\w+\}(?:</[a-z]+>)? ([a-z-]+)(?: ([a-z]+))?", text):
        nxt, after = m.group(1), m.group(2)
        if nxt in plurals:
            continue
        if after and after in plurals:
            if nxt not in modifiers and nxt not in NOT_MODIFIERS:
                problems.append(f'"{m.group(0)}": add "{nxt}" to MODIFIERS or reword')
        elif nxt.endswith("s") and nxt not in NOT_NOUNS:
            problems.append(f'"{m.group(0)}": add "{nxt}" to PLURALS or reword')
    for m in re.finditer(r"\b1 ([a-z]+)\b", text):
        if m.group(1) in plurals:
            problems.append(f'"{m.group(0)}": a fixed 1 before a plural')
    for m in re.finditer(r"\bthese \{\w+\}", text):
        problems.append(f'"{m.group(0)}": write "the {{n}}" ("these 1" reads wrong)')
    for m in re.finditer(r"\{\w+\} of [^,.;:!?]*? (?:are|were|have)\b", text):
        problems.append(
            f'"{m.group(0)}": reword, the count takes a singular verb when it is 1'
        )
    # format() only reaches a verb right after the count or its noun
    nouns = "|".join(plurals)
    late_verb = (
        r"\{\w+\} (?:[a-z-]+ )?(?:" + nouns + r") (?:in|on|at|from|with|without|for)\b"
        r"[^,.;:!?]*? (?:are|were|have)\b"
    )
    for m in re.finditer(late_verb, text):
        problems.append(
            f'"{m.group(0)}": reword, the verb after the phrase stays plural for 1'
        )
    for m in re.finditer(r"\{\w+\}[^,.;:!?]*? and (?:are|were|have)\b", text):
        problems.append(
            f'"{m.group(0)}": reword, the second verb after "and" stays plural for 1'
        )
    return problems


def _call_text(src: str, start: int) -> str:
    """The text of the call that opens at src[start] == '(' (strings skipped roughly)."""
    depth, i, quote = 0, start, ""
    while i < len(src):
        c = src[i]
        if quote:
            if c == "\\":
                i += 2
                continue
            if c == quote:
                quote = ""
        elif c in "'\"`":
            quote = c
        elif c in "([{":
            depth += 1
        elif c in ")]}":
            depth -= 1
            if depth == 0:
                return src[start : i + 1]
        i += 1
    return src[start:]


def test_format_values_are_values_not_functions():
    """I18n.format writes values as given: a replacer function (the old
    .replace(x, () => value) idiom) would print its own source."""
    problems = []
    for path in sorted((ROOT / "frontend" / "js").rglob("*.js")):
        if "vendor" in path.parts:
            continue
        src = path.read_text(encoding="utf-8")
        for m in re.finditer(r"I18n\.format\(", src):
            call = _call_text(src, m.end() - 1)
            if re.search(
                r"[{,]\s*\w+\s*:\s*(?:\([^)]*\)|\w+)\s*=>|[{,]\s*\w+\s*:\s*function\b",
                call,
            ):
                line = src.count("\n", 0, m.start()) + 1
                problems.append(f"{path.relative_to(ROOT).as_posix()}:{line}")
    assert problems == []


def test_the_error_screen_does_not_need_i18n():
    """error-fallback.js loads before i18n.js so a failed page still says what happened."""
    text = (ROOT / "frontend" / "js" / "error-fallback.js").read_text(encoding="utf-8")
    assert "I18n.format" not in text
    html = (ROOT / "frontend" / "index.html").read_text(encoding="utf-8")
    assert html.index("js/error-fallback.js") < html.index("js/i18n.js")


def test_every_english_count_reads_right_for_one(data):
    plurals = data["rules"]["PLURALS"]
    modifiers = set(data["rules"]["MODIFIERS"])
    problems = [
        f"{key}: {problem}"
        for key, text in data["en"].items()
        for problem in _count_problems(str(text), plurals, modifiers)
    ]
    assert problems == []
