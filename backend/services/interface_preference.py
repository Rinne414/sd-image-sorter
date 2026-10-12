"""Which interface opens at ``/``: the classic one or V Opus.

Both interfaces work on the same backend and library. The choice is made in
either interface's Settings and kept in ``CONFIG_DIR/interface.json``, so
every browser and every launch opens the same one. A missing or unreadable
file means the classic interface, the default.
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path

from config import CONFIG_DIR

logger = logging.getLogger(__name__)

CLASSIC = "classic"
VOPUS = "vopus"
INTERFACES = (CLASSIC, VOPUS)


def _preference_path() -> Path:
    return Path(CONFIG_DIR) / "interface.json"


def get_preferred_interface() -> str:
    """The remembered interface, ``classic`` unless ``vopus`` was chosen."""
    path = _preference_path()
    try:
        value = json.loads(path.read_text(encoding="utf-8")).get("interface")
    except FileNotFoundError:
        return CLASSIC
    except (OSError, ValueError, AttributeError) as exc:
        logger.warning("Ignoring unreadable interface choice in %s: %s", path, exc)
        return CLASSIC
    return value if value in INTERFACES else CLASSIC


def set_preferred_interface(value: str) -> str:
    """Remember ``value`` (one of ``INTERFACES``); written atomically."""
    if value not in INTERFACES:
        raise ValueError(f"Unknown interface: {value!r}")
    path = _preference_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    partial = path.with_name(path.name + ".tmp")
    partial.write_text(json.dumps({"interface": value}), encoding="utf-8")
    os.replace(partial, path)
    return value
