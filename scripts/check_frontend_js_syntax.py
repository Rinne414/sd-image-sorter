"""Parse every frontend script the way the browser loads it.

Classic scripts go through ``node --check <file>``. ES modules (a top-level
``import`` or ``export``, e.g. style-map/*) are parsed as modules from stdin
with ``node --input-type=module --check``: ``node --check`` on a module file
let a broken template literal through (2026-10-26, a stray ``}``` in
style-map/custom-axes-view.js passed while the page failed to load it).

Usage: check_frontend_js_syntax.py NODE FILE...
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

MODULE_SYNTAX = re.compile(r"^\s*(import\s[^(]|import\{|export\s)", re.MULTILINE)


def is_module(source: str) -> bool:
    return bool(MODULE_SYNTAX.search(source))


def check(node: str, path: Path) -> bool:
    source = path.read_text(encoding="utf-8")
    if is_module(source):
        result = subprocess.run(
            [node, "--input-type=module", "--check"],
            input=source,
            encoding="utf-8",
            capture_output=True,
        )
    else:
        result = subprocess.run(
            [node, "--check", str(path)], encoding="utf-8", capture_output=True
        )
    if result.returncode != 0:
        print(f"{path}:\n{result.stderr.strip()}\n", file=sys.stderr)
    return result.returncode == 0


def main(argv: list[str]) -> int:
    node, *files = argv
    failed = [path for path in map(Path, files) if not check(node, path)]
    print(f"Checked {len(files)} frontend JS files, {len(failed)} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
