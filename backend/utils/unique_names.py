"""One auto-number style for every save: name.ext, then name_2.ext, name_3.ext ...

Owner decision 2026-10-04: the first copy keeps its name and later copies
count from 2, so the number reads as "the second one", "the third one".
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Callable, Optional

MAX_NUMBERED_COPIES = 10_000


def numbered_filename(stem: str, ext: str, number: int) -> str:
    """``stem + ext`` for the first copy, ``stem_<number> + ext`` after it."""
    return f"{stem}{ext}" if number <= 1 else f"{stem}_{number}{ext}"


def first_free_path(
    folder: Path,
    stem: str,
    ext: str,
    *,
    taken: Optional[Callable[[Path], bool]] = None,
) -> Path:
    """First numbered name in ``folder`` that is not on disk and not ``taken``.

    Raises FileExistsError after MAX_NUMBERED_COPIES names.
    """
    for number in range(1, MAX_NUMBERED_COPIES + 1):
        candidate = Path(folder) / numbered_filename(stem, ext, number)
        if not os.path.lexists(candidate) and not (taken and taken(candidate)):
            return candidate
    raise FileExistsError(f"No free file name left for {stem}{ext} in {folder}")
