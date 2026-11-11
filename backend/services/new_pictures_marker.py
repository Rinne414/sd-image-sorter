"""Where "New pictures" left off, per library, kept by the program itself.

The marker (the time of the newest picture the user has dealt with) used to
live in the browser's own storage, so the browser and the desktop program each
had their own idea of what is new. It is one small JSON file in the state
folder now: ``{library id: marker}``.
"""

from __future__ import annotations

import json
import os
import threading
from pathlib import Path
from typing import Dict, Optional

import config
from library_context import get_current_library_id

FILENAME = "new-pictures-markers.json"
MAX_MARKER_CHARS = 40
_lock = threading.Lock()


def _path() -> Path:
    return Path(config.STATE_DIR) / FILENAME


def _read() -> Dict[str, str]:
    try:
        data = json.loads(_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    if not isinstance(data, dict):
        return {}
    return {str(k): v for k, v in data.items() if isinstance(v, str) and v}


def get_marker() -> Optional[str]:
    """The open library's marker, or None when it has none yet."""
    with _lock:
        return _read().get(get_current_library_id())


def set_marker(marker: Optional[str]) -> Optional[str]:
    """Store (or with None, forget) the open library's marker; returns the one before."""
    value = (marker or "").strip()[:MAX_MARKER_CHARS]
    library_id = get_current_library_id()
    with _lock:
        markers = _read()
        previous = markers.get(library_id)
        if value:
            markers[library_id] = value
        else:
            markers.pop(library_id, None)
        path = _path()
        path.parent.mkdir(parents=True, exist_ok=True)
        staged = path.with_suffix(".json.tmp")
        staged.write_text(json.dumps(markers, ensure_ascii=False), encoding="utf-8")
        os.replace(staged, path)
    return previous
