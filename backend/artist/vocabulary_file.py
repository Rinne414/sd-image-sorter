"""The artist model's answer set, read from its class mapping file on disk.

"Is my artist in the vocabulary?" used to need the 2.8 GB model in memory:
after the program let the model go (or after a restart) the page answered
"run an identification first", although the answer is a 0.7 MB CSV beside the
weights. This reads that file. It never downloads and never loads the model.
"""

from __future__ import annotations

import csv
import logging
import os
from typing import FrozenSet, Optional, Tuple

logger = logging.getLogger(__name__)

_cache: Tuple[Optional[str], float, FrozenSet[str]] = (None, 0.0, frozenset())


def _read_names(csv_path: str) -> FrozenSet[str]:
    names = set()
    with open(csv_path, "r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        if not reader.fieldnames or "class_name" not in reader.fieldnames:
            return frozenset()
        for row in reader:
            name = str(row.get("class_name") or "").strip().strip("'").strip('"')
            if name:
                names.add(name.lower())
    return frozenset(names)


def names_on_disk() -> FrozenSet[str]:
    """Lower-cased artist names of the prepared model; empty when it is not on disk."""
    global _cache
    try:
        from artist.assets import require_local_artist_assets

        csv_path = require_local_artist_assets()["class_mapping_path"]
        modified = os.path.getmtime(csv_path)
    except (
        Exception
    ) as exc:  # not prepared, or the file is gone: there is no answer set
        logger.debug("No artist class mapping on disk: %s", exc)
        return frozenset()
    if _cache[0] == csv_path and _cache[1] == modified:
        return _cache[2]
    try:
        names = _read_names(csv_path)
    except (OSError, ValueError, csv.Error) as exc:
        logger.warning("Could not read the artist class mapping %s: %s", csv_path, exc)
        return frozenset()
    _cache = (csv_path, modified, names)
    return names
