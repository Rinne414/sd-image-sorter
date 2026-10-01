"""A language file must not define the same key twice.

A duplicated key in an object literal silently keeps the last one, so a merge
that adds a key already present hides the earlier text.
"""

from __future__ import annotations

import re
from collections import Counter
from pathlib import Path

import pytest

LANG_DIR = Path(__file__).resolve().parents[2] / "frontend" / "js" / "lang"
KEY_LINE = re.compile(r"^\s*'([A-Za-z0-9_.\-]+)'\s*:")


@pytest.mark.parametrize("name", ["en.js", "zh-CN.js"])
def test_language_file_has_no_duplicate_keys(name: str) -> None:
    text = (LANG_DIR / name).read_text(encoding="utf-8")
    counts = Counter(
        match.group(1)
        for line in text.splitlines()
        if (match := KEY_LINE.match(line))
    )
    duplicates = sorted(key for key, count in counts.items() if count > 1)
    assert not duplicates, f"{name} defines these keys more than once: {duplicates}"
