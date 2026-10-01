"""Trusted external model files, as the loaders and the Model Center see them (MS1b).

``model_sources_service.detect`` finds the pinned models that live in a
ComfyUI install or a Hugging Face cache and keeps the trusted ones in
``CONFIG_DIR/model_sources.json``. This module is the only reader of that
list on the loading side:

* the program's own folder always wins; a loader asks here only when its own
  files are missing;
* a recorded file counts only while ``model_roots.is_under_allowed_model_root``
  accepts it (a hand-edited index cannot widen the trust);
* a recorded file is compared with what is on disk (size and mtime, the files
  that make up a folder model by their sum). A file that is gone or changed
  is never replaced by another one: the lookup says so, the card turns into
  "missing" with the path, and the loader falls back to its normal "not
  prepared" behaviour;
* network files are not touched on the request thread (``check_network`` is
  off); they are served as recorded.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Dict, List, Mapping, Optional, Tuple

import model_roots
import model_sources_store

logger = logging.getLogger(__name__)

STATE_OK = "ok"
STATE_GONE = "gone"
STATE_CHANGED = "changed"

_KIND_LABELS = {
    "comfyui": "ComfyUI",
    "hf_cache": "Hugging Face cache",
    "folder": "trusted folder",
}

# Tests point this at a store in a temp folder; production reads the
# service's own store (the one ``detect`` writes).
_store_provider: Optional[Callable[[], model_sources_store.ModelSourcesStore]] = None


def _store() -> model_sources_store.ModelSourcesStore:
    if _store_provider is not None:
        return _store_provider()
    from services.model_sources_service import get_model_sources_service

    return get_model_sources_service().store


@dataclass(frozen=True)
class Resolution:
    """One recorded external model and whether it is still what was recorded."""

    model_id: str
    variant: Optional[str]
    path: str
    companions: Tuple[str, ...]
    source: str
    source_kind: str
    verify: str
    is_network: bool
    state: str
    size_bytes: int = 0

    @property
    def is_ok(self) -> bool:
        return self.state == STATE_OK

    @property
    def source_label(self) -> str:
        return _KIND_LABELS.get(self.source_kind, _KIND_LABELS["folder"])

    def source_info(self) -> Dict[str, Any]:
        """The card's ``source`` field."""
        return {
            "kind": self.source_kind,
            "root": self.source,
            "path": self.path,
            "verify": self.verify,
            "is_network": self.is_network,
            "size_bytes": self.size_bytes,
        }

    def problem(self) -> Dict[str, Any]:
        """The card's replacement message when the recorded file is gone or changed."""
        what = "gone" if self.state == STATE_GONE else "changed"
        return {
            "message": (
                f"Missing: the file in {self.source_label} is {what}: {self.path}"
            ),
            "message_key": f"models.external.{what}",
            "message_params": {
                "source": self.source_label,
                "kind": self.source_kind,
                "path": self.path,
            },
        }


def _same_variant(entry: Mapping[str, Any], variant: Optional[str]) -> bool:
    return (entry.get("variant") or None) == (variant or None)


def _stat_state(entry: Mapping[str, Any]) -> str:
    """ok / gone / changed for one recorded local entry, from the disk as it is now."""
    path = Path(str(entry.get("path") or ""))
    companions = [Path(str(c)) for c in entry.get("companions") or ()]
    size = int(entry.get("size_bytes") or 0)
    mtime_ns = int(entry.get("mtime_ns") or 0)
    try:
        if path.is_dir():
            files = [c for c in companions if not c.is_dir()]
            stats = [f.stat() for f in files]
            now_size = sum(s.st_size for s in stats)
            now_mtime = max((s.st_mtime_ns for s in stats), default=mtime_ns)
        else:
            primary = path.stat()
            now_size, now_mtime = primary.st_size, primary.st_mtime_ns
            for companion in companions:
                if not companion.is_dir() and companion.stat().st_size <= 0:
                    return STATE_CHANGED
    except (FileNotFoundError, NotADirectoryError):
        return STATE_GONE
    except OSError:
        return STATE_GONE
    if now_size != size or now_mtime != mtime_ns:
        return STATE_CHANGED
    return STATE_OK


def _resolve_entry(
    entry: Mapping[str, Any], *, check_network: bool, force_state: Optional[str] = None
) -> Optional[Resolution]:
    path = str(entry.get("path") or "")
    if not path or not model_roots.is_under_allowed_model_root(path):
        return None
    is_network = model_roots.is_network_path(path)
    if force_state is not None:
        state = force_state
    elif is_network and not check_network:
        state = STATE_OK
    else:
        state = _stat_state(entry)
    return Resolution(
        model_id=str(entry.get("model_id") or ""),
        variant=entry.get("variant") or None,
        path=path,
        companions=tuple(str(c) for c in entry.get("companions") or ()),
        source=str(entry.get("source") or ""),
        source_kind=str(entry.get("source_kind") or "folder"),
        verify=str(entry.get("verify") or ""),
        is_network=is_network,
        state=state,
        size_bytes=int(entry.get("size_bytes") or 0),
    )


def lookup(
    model_id: str, variant: Optional[str] = None, *, check_network: bool = False
) -> Optional[Resolution]:
    """The recorded trusted file for a model, or None when nothing trusted is recorded."""
    for entry in _store().matches():
        if entry.get("model_id") == model_id and _same_variant(entry, variant):
            resolved = _resolve_entry(entry, check_network=check_network)
            if resolved is not None:
                return resolved
    return None


def lost(model_id: str, variant: Optional[str] = None) -> Optional[Resolution]:
    """A trusted file that ``detect`` recorded once and no longer finds."""
    for entry in _store().lost():
        if entry.get("model_id") == model_id and _same_variant(entry, variant):
            path = str(entry.get("path") or "")
            exists = False
            if path and not model_roots.is_network_path(path):
                exists = os.path.exists(path)
            state = STATE_CHANGED if exists else STATE_GONE
            resolved = _resolve_entry(entry, check_network=False, force_state=state)
            if resolved is not None:
                return resolved
    return None


def problem(model_id: str, variant: Optional[str] = None) -> Optional[Resolution]:
    """The recorded file when it is gone or changed (never an unchanged one)."""
    current = lookup(model_id, variant)
    if current is not None:
        return None if current.is_ok else current
    return lost(model_id, variant)


def usable(
    model_id: str, variant: Optional[str] = None, *, check_network: bool = False
) -> Optional[Resolution]:
    """The recorded file when it is still what was recorded; a stale one is logged and refused."""
    found = lookup(model_id, variant, check_network=check_network)
    if found is None:
        return None
    if not found.is_ok:
        logger.warning(
            "%s file in %s is %s, not using it: %s",
            model_id,
            found.source_label,
            found.state,
            found.path,
        )
        return None
    return found


def usable_path(
    model_id: str, variant: Optional[str] = None, *, check_network: bool = False
) -> Optional[str]:
    found = usable(model_id, variant, check_network=check_network)
    return found.path if found is not None else None


def usable_companion(
    model_id: str, variant: Optional[str], index: int
) -> Optional[str]:
    """One companion path (a tag table, a class mapping, a runtime folder) by position."""
    found = usable(model_id, variant)
    if found is None or index >= len(found.companions):
        return None
    return found.companions[index]


def prefer_own(own: Path, model_id: str, variant: Optional[str] = None) -> Path:
    """``own`` when the program's folder has that file; else a trusted copy; else ``own``
    (so a missing file keeps its normal "expected path" and download target)."""
    try:
        if own.is_file() and own.stat().st_size > 0:
            return own
    except OSError:
        pass
    external = usable_path(model_id, variant)
    return Path(external) if external else own


def artist_runtime_path() -> Optional[str]:
    """The LSNet runtime that sits next to a recorded Kaloscope checkpoint."""
    found = usable("artist", "kaloscope2.0")
    if found is None or len(found.companions) < 2:
        return None
    runtime = found.companions[1]
    if found.is_network or os.path.isdir(runtime):
        return runtime
    return None


def wd14_files(variant: str) -> Optional[Tuple[str, str]]:
    """(model, tags) paths of a WD14-family variant found outside the program's folder."""
    found = usable("wd14", variant)
    if found is None or not found.companions:
        return None
    return found.path, found.companions[0]


def _same_file(first: str, second: str) -> bool:
    return os.path.normcase(os.path.normpath(first)) == os.path.normcase(
        os.path.normpath(second)
    )


def source_for_path(
    model_id: str, variant: Optional[str], path: Optional[str]
) -> Optional[Dict[str, Any]]:
    """The ``source`` of a card whose reported path is the recorded external file."""
    if not path:
        return None
    found = lookup(model_id, variant)
    if found is None or not found.is_ok or not _same_file(path, found.path):
        return None
    return found.source_info()
