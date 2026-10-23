"""Build the Chrome/Edge and Firefox extension folders and zips.

    python browser-extension/build.py [OUT_DIR]

Writes OUT_DIR/chrome/, OUT_DIR/firefox/ and a zip of each (default
OUT_DIR: browser-extension/dist). The program itself builds the same folders
into its data folder when you open Settings > Browser extension, so users
never need this script.
"""

from __future__ import annotations

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "backend"))

from services.browser_extension_package import TARGETS, build_target, zip_target  # noqa: E402


def main(argv: list[str]) -> int:
    out_dir = Path(argv[1]).resolve() if len(argv) > 1 else HERE / "dist"
    for target in TARGETS:
        folder = build_target(target, out_dir / target)
        archive = zip_target(folder, out_dir / f"sd-image-sorter-{target}.zip")
        print(f"{target}: {folder} ({archive.name})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
