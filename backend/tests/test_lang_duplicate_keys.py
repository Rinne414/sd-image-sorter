"""A language file must not define the same key twice.

A duplicated key in an object literal silently keeps the last one, so a merge
that adds a key already present hides the earlier text. Loading the file only
shows the survivors, so the keys are read at token level: strings (single,
double, template), comments and nesting are honoured, and several keys on one
line are all seen. A sanity check ties the token count to what node actually
loads: found == loaded + duplicates.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from collections import Counter
from pathlib import Path

import pytest

LANG_DIR = Path(__file__).resolve().parents[2] / "frontend" / "js" / "lang"
FILES = ["en.js", "zh-CN.js"]


def _skip_string(text: str, start: int) -> int:
    """Return the index just past the string literal that opens at ``start``."""
    quote = text[start]
    index = start + 1
    while index < len(text):
        char = text[index]
        if char == "\\":
            index += 2
            continue
        if char == quote:
            return index + 1
        index += 1
    raise ValueError("unterminated string literal")


def top_level_keys(text: str) -> list[str]:
    """Keys of the first object literal, in order, duplicates kept."""
    keys: list[str] = []
    depth = 0
    index = 0
    previous_significant = ""
    while index < len(text):
        char = text[index]
        if text.startswith("//", index):
            index = text.find("\n", index)
            index = len(text) if index < 0 else index
            continue
        if text.startswith("/*", index):
            end = text.find("*/", index + 2)
            index = len(text) if end < 0 else end + 2
            continue
        if char in "'\"`":
            end = _skip_string(text, index)
            literal = text[index + 1 : end - 1]
            tail = text[end:].lstrip()
            if depth == 1 and previous_significant in "{," and tail.startswith(":"):
                keys.append(literal)
            previous_significant = '"'
            index = end
            continue
        if char in "{[(":
            depth += 1
        elif char in "}])":
            depth -= 1
        if not char.isspace():
            previous_significant = char
        index += 1
    return keys


def test_tokenizer_sees_quote_styles_comments_and_one_line_pairs():
    text = """window.X = {
        'a.b': 1, "c": 2, 'a.b': 3,
        // 'commented': 1,
        /* 'also': 1 */
        'nested': { 'inner': 1, 'inner': 2 },
        'text': 'looks: like, a "key": here',
        `tpl`: 4,
    };"""

    assert top_level_keys(text) == ["a.b", "c", "a.b", "nested", "text", "tpl"]


@pytest.mark.parametrize("name", FILES)
def test_language_file_has_no_duplicate_keys(name: str) -> None:
    keys = top_level_keys((LANG_DIR / name).read_text(encoding="utf-8"))
    duplicates = sorted(key for key, count in Counter(keys).items() if count > 1)

    assert keys, f"{name}: no keys found, the tokenizer is broken"
    assert not duplicates, f"{name} defines these keys more than once: {duplicates}"


@pytest.mark.skipif(shutil.which("node") is None, reason="node is required")
@pytest.mark.parametrize("name", FILES)
def test_token_count_matches_what_node_loads(name: str) -> None:
    path = LANG_DIR / name
    script = (
        "const vm=require('vm');const fs=require('fs');const w={};w.window=w;"
        "vm.createContext(w);vm.runInContext(fs.readFileSync(process.argv[1],'utf8'),w);"
        "const t=w.I18nLang_zhCN||w.I18nLang_en;console.log(JSON.stringify(Object.keys(t).length));"
    )
    loaded = int(
        json.loads(
            subprocess.run(
                ["node", "-e", script, str(path)],
                capture_output=True,
                text=True,
                timeout=60,
                check=True,
            ).stdout
        )
    )
    keys = top_level_keys(path.read_text(encoding="utf-8"))
    duplicated = sum(count - 1 for count in Counter(keys).values())

    assert len(keys) == loaded + duplicated
