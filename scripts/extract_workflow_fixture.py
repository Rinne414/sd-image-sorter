"""Extract a ComfyUI workflow from a PNG into a regression-corpus fixture.

Whenever an image parses wrong, freeze its shape forever:

    python scripts/extract_workflow_fixture.py "D:/path/to/image.png" my-case-name

writes ``backend/tests/fixtures/comfyui_workflows/my-case-name.json`` with
the image's ``prompt`` chunk and an EMPTY ``expect`` block — fill in the
expected fragments, run the corpus test, fix the parser, and the case is
protected for good.

Privacy note: the raw graph may embed personal folder names inside string
values. Review the fixture before committing; --redact-paths rewrites
Windows/Unix absolute paths inside string values to <path>.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
FIXTURE_DIR = REPO_ROOT / "backend" / "tests" / "fixtures" / "comfyui_workflows"

_ABS_PATH_RE = re.compile(r"(?:[A-Za-z]:[\\/]|/(?:home|mnt|media|Users)/)[^\s,\"']*")


def _redact(value):
    if isinstance(value, str):
        return _ABS_PATH_RE.sub("<path>", value)
    if isinstance(value, list):
        return [_redact(item) for item in value]
    if isinstance(value, dict):
        return {key: _redact(item) for key, item in value.items()}
    return value


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("image", help="PNG produced by ComfyUI")
    parser.add_argument("name", help="fixture name (kebab-case)")
    parser.add_argument("--redact-paths", action="store_true",
                        help="replace absolute paths inside string values with <path>")
    parser.add_argument("--force", action="store_true", help="overwrite an existing fixture")
    args = parser.parse_args()

    from PIL import Image

    image_path = Path(args.image)
    if not image_path.is_file():
        print(f"ERROR: not a file: {image_path}")
        return 2

    with Image.open(image_path) as img:
        raw = (getattr(img, "text", None) or {}).get("prompt")
    if not raw:
        print("ERROR: no ComfyUI 'prompt' text chunk in this PNG")
        return 2
    try:
        prompt_data = json.loads(raw)
    except ValueError as exc:
        print(f"ERROR: prompt chunk is not valid JSON: {exc}")
        return 2

    if args.redact_paths:
        prompt_data = _redact(prompt_data)

    fixture = {
        "name": args.name,
        "description": f"Extracted from {image_path.name}. TODO: describe why this shape matters.",
        "prompt_data": prompt_data,
        "expect": {
            "positive_contains": [],
            "positive_not_contains": [],
            "negative_contains": [],
        },
    }

    FIXTURE_DIR.mkdir(parents=True, exist_ok=True)
    out_path = FIXTURE_DIR / f"{args.name}.json"
    if out_path.exists() and not args.force:
        print(f"ERROR: {out_path} exists (use --force to overwrite)")
        return 2
    out_path.write_text(json.dumps(fixture, indent=2, ensure_ascii=False) + "\n",
                        encoding="utf-8", newline="\n")

    node_count = len(prompt_data) if isinstance(prompt_data, dict) else 0
    print(f"Wrote {out_path} ({node_count} nodes).")
    print("Next: fill in expect.positive_contains / negative_contains, review for")
    print("private strings, then run: pytest backend/tests/test_comfyui_workflow_corpus.py")
    return 0


if __name__ == "__main__":
    sys.exit(main())
