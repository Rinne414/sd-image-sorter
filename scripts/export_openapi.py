#!/usr/bin/env python3
"""Export the FastAPI OpenAPI schema without starting the server."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent.parent
BACKEND_DIR = ROOT / "backend"


def _sorted_schema(value: Any) -> Any:
    """Return a recursively key-sorted copy for stable snapshots."""
    if isinstance(value, dict):
        return {key: _sorted_schema(value[key]) for key in sorted(value)}
    if isinstance(value, list):
        return [_sorted_schema(item) for item in value]
    return value


def load_openapi_schema() -> dict[str, Any]:
    """Load the app module and return its OpenAPI schema."""
    sys.path.insert(0, str(BACKEND_DIR))
    from main import app  # pylint: disable=import-outside-toplevel

    return _sorted_schema(app.openapi())


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output",
        "-o",
        type=Path,
        help="Write schema JSON to this path instead of stdout.",
    )
    args = parser.parse_args()

    schema = load_openapi_schema()
    payload = json.dumps(schema, indent=2, ensure_ascii=False) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(payload, encoding="utf-8")
    else:
        print(payload, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
