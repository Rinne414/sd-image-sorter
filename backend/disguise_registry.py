"""Where disguise files live, and which disguises this program made.

Each disguise written here is remembered by the SHA-256 of its bytes. No
marker goes into the file itself, so a shared disguise carries nothing that
ties it to this program or its user. A library scan asks
:func:`was_made_here` so it does not "restore" our own output back into a
duplicate of the original picture.

Kept outside the ``services`` package so ``image_manager`` can use it
without importing every service (which would be a circular import).
"""

from __future__ import annotations

import hashlib
import os
import threading
from pathlib import Path

from config import get_data_dir

REGISTRY_NAME = "made_here.sha256"
_lock = threading.Lock()


def disguise_dir() -> Path:
    folder = Path(get_data_dir()) / "disguise"
    folder.mkdir(parents=True, exist_ok=True)
    return folder


def _registry_path() -> Path:
    return disguise_dir() / REGISTRY_NAME


def remember_made(data: bytes) -> None:
    digest = hashlib.sha256(data).hexdigest()
    with _lock, open(_registry_path(), "a", encoding="ascii") as handle:
        handle.write(digest + "\n")


def was_made_here(path: os.PathLike | str) -> bool:
    """True when this program wrote exactly these bytes as a disguise."""
    registry = _registry_path()
    if not registry.is_file():
        return False
    digest = hashlib.sha256(Path(path).read_bytes()).hexdigest()
    with _lock, open(registry, encoding="ascii") as handle:
        return any(line.strip() == digest for line in handle)
