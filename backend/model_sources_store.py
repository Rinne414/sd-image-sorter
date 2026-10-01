"""The model-sources index file and the background scan generations (MS1a).

``CONFIG_DIR/model_sources.json`` keeps the drive-scan cache, the digest
cache, the trusted matches for the loaders (MS1b) and the background
results for network roots. A file that cannot be parsed is renamed to
``.bak`` and the store starts empty; a save that fails keeps the data in
memory and logs. The store never raises into a request.

The drive scan runs on a daemon thread. Each start is a *generation*; an
older generation that finishes late never overwrites a newer result, and
the status stays ``running`` until every generation has finished.
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
import threading
import time
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Mapping, Optional, Sequence

import model_sources

logger = logging.getLogger(__name__)


class ModelSourcesStore:
    """``CONFIG_DIR/model_sources.json``: scan cache, digest cache, chosen matches, network results.

    A file that cannot be parsed is renamed to ``.bak`` and the store starts
    empty; a save that fails keeps the data in memory and logs. The store
    never raises into a request.
    """

    VERSION = 2

    def __init__(self, path: Path | str) -> None:
        self.path = Path(path)
        self._lock = threading.Lock()
        self._data = self._load()

    @classmethod
    def _empty(cls) -> Dict[str, Any]:
        return {
            "version": cls.VERSION,
            "scan": {},
            "digests": {},
            "matches": [],
            "lost": [],
            "network": {},
        }

    def _load(self) -> Dict[str, Any]:
        try:
            raw = self.path.read_bytes()
        except OSError:
            return self._empty()
        try:
            data = json.loads(raw.decode("utf-8"))
        except ValueError as exc:  # JSONDecodeError and UnicodeDecodeError
            self._quarantine(f"not valid JSON ({exc})")
            return self._empty()
        if not isinstance(data, dict):
            self._quarantine(f"holds a {type(data).__name__}, not an object")
            return self._empty()
        if data.get("version") != self.VERSION:
            logger.info(
                "model_sources.json at %s is version %r, this build writes %r; starting fresh",
                self.path,
                data.get("version"),
                self.VERSION,
            )
            return self._empty()
        base = self._empty()
        for key in base:
            value = data.get(key)
            if isinstance(value, type(base[key])):
                base[key] = value
        return base

    def _quarantine(self, why: str) -> None:
        backup = self.path.with_suffix(self.path.suffix + ".bak")
        try:
            os.replace(self.path, backup)
            logger.warning(
                "model_sources.json at %s is %s; moved to %s and starting fresh",
                self.path,
                why,
                backup.name,
            )
        except OSError as exc:
            logger.warning(
                "model_sources.json at %s is %s and could not be moved aside (%s); starting fresh",
                self.path,
                why,
                exc,
            )

    def _save(self) -> None:
        """Atomic replace through a uniquely named temp file in the same folder; never raises."""
        tmp_name = None
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile(
                "w",
                encoding="utf-8",
                dir=self.path.parent,
                prefix=self.path.name + ".",
                suffix=".tmp",
                delete=False,
            ) as handle:
                tmp_name = handle.name
                json.dump(self._data, handle, indent=2, sort_keys=True)
            os.replace(tmp_name, self.path)
        except OSError as exc:
            logger.warning(
                "model_sources.json at %s could not be saved (%s); keeping it in memory",
                self.path,
                exc,
            )
            if tmp_name:
                try:
                    os.unlink(tmp_name)
                except OSError:
                    pass

    # scan cache -----------------------------------------------------------

    def save_scan(self, roots: Iterable[str], *, scanned_at: float) -> None:
        with self._lock:
            self._data["scan"] = {
                "scanned_at": float(scanned_at),
                "roots": [str(r) for r in roots],
            }
            self._save()

    def scan_roots(self) -> List[str]:
        """Cached local roots that still are ComfyUI installs."""
        with self._lock:
            entries = list(self._data.get("scan", {}).get("roots") or [])
        return [
            str(e)
            for e in entries
            if isinstance(e, str)
            and not model_sources.is_network_path(e)
            and model_sources.is_comfyui_root(e)
        ]

    def scanned_at(self) -> Optional[float]:
        with self._lock:
            value = self._data.get("scan", {}).get("scanned_at")
        return float(value) if isinstance(value, (int, float)) else None

    # digest cache ---------------------------------------------------------

    @staticmethod
    def _digest_key(path: str, size: int, mtime_ns: int) -> str:
        return f"{os.path.normcase(path)}|{size}|{mtime_ns}"

    def cached_digest(self, path: str, size: int, mtime_ns: int) -> Optional[str]:
        with self._lock:
            value = self._data["digests"].get(self._digest_key(path, size, mtime_ns))
        return str(value) if value else None

    def remember_digest(self, path: str, size: int, mtime_ns: int, digest: str) -> None:
        with self._lock:
            self._data["digests"][self._digest_key(path, size, mtime_ns)] = digest
            self._save()

    # chosen (trusted) matches --------------------------------------------

    @staticmethod
    def _match_key(entry: Mapping[str, Any]) -> tuple:
        return (entry.get("model_id"), entry.get("variant") or None)

    def save_matches(self, matches: Iterable[Mapping[str, Any]]) -> None:
        """Replace the chosen matches. A model that had a match and has none now
        moves to ``lost`` (so the card can say its file is gone); one that is
        found again leaves ``lost``."""
        new = [dict(m) for m in matches]
        found = {self._match_key(m) for m in new}
        with self._lock:
            lost = [
                e
                for e in self._data.get("lost") or []
                if isinstance(e, dict) and self._match_key(e) not in found
            ]
            seen = {self._match_key(e) for e in lost}
            for old in self._data.get("matches") or []:
                if not isinstance(old, dict):
                    continue
                key = self._match_key(old)
                if key not in found and key not in seen:
                    lost.append(dict(old))
                    seen.add(key)
            self._data["matches"] = new
            self._data["lost"] = lost
            self._save()

    def matches(self) -> List[Dict[str, Any]]:
        with self._lock:
            return [dict(m) for m in self._data.get("matches") or [] if isinstance(m, dict)]

    def lost(self) -> List[Dict[str, Any]]:
        """Trusted matches an earlier ``detect`` recorded that are no longer found."""
        with self._lock:
            return [dict(m) for m in self._data.get("lost") or [] if isinstance(m, dict)]

    # network roots (judged on the background thread) ----------------------

    def save_network_result(
        self, key: str, payload: Mapping[str, Any], *, generation: int
    ) -> None:
        with self._lock:
            current = self._data["network"].get(key) or {}
            if int(current.get("generation") or 0) > generation:
                return
            self._data["network"][key] = dict(payload, generation=generation)
            self._save()

    def network_result(self, key: str) -> Optional[Any]:
        """The cached result as stored (the caller validates its shape), or None."""
        with self._lock:
            value = self._data["network"].get(key)
        return dict(value) if isinstance(value, dict) else value


class _ScanState:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.next_generation = 0
        self.completed_generation = 0
        self.running: Dict[int, threading.Thread] = {}
        self.scanned_at: Optional[float] = None
        self.error: Optional[str] = None


_scan_state = _ScanState()

ScanWork = Callable[[int], None]


def _finish_generation(
    state: _ScanState,
    store: ModelSourcesStore,
    generation: int,
    roots: List[str],
    error: Optional[str],
) -> None:
    with state.lock:
        if generation < state.completed_generation:
            return  # an older scan must not overwrite a newer result
        state.completed_generation = generation
        state.error = error
        if error is None:
            state.scanned_at = time.time()
    if error is None:
        store.save_scan(roots, scanned_at=state.scanned_at or time.time())


def _scan_worker(
    state: _ScanState,
    store: ModelSourcesStore,
    generation: int,
    drives: Optional[Sequence[str]],
    work: Optional[ScanWork],
    on_done: Optional[Callable[[], None]],
) -> None:
    started = time.perf_counter()
    roots: List[str] = []
    error: Optional[str] = None
    try:
        roots = model_sources.scan_drives_for_comfyui(drives)
        if work is not None:
            work(generation)
        logger.info(
            "ComfyUI drive scan #%d: %d root(s) in %.0f ms",
            generation,
            len(roots),
            (time.perf_counter() - started) * 1000,
        )
    except Exception as exc:
        logger.warning("ComfyUI drive scan #%d failed: %s", generation, exc)
        error = str(exc)
    finally:
        _finish_generation(state, store, generation, roots, error)
        with state.lock:
            state.running.pop(generation, None)
        if on_done is not None:
            on_done()


def start_background_scan(
    store: ModelSourcesStore,
    *,
    drives: Optional[Sequence[str]] = None,
    work: Optional[ScanWork] = None,
    force: bool = False,
    on_done: Optional[Callable[[], None]] = None,
) -> Optional[int]:
    """Start the T2 scan (plus ``work(generation)``, e.g. the network roots) on a daemon thread.

    Without ``force`` only the first call per process starts one; with it a new
    generation starts even while an older one runs. Returns the generation, or
    None when nothing was started.
    """
    state = _scan_state
    with state.lock:
        if not force and state.next_generation > 0:
            return None
        state.next_generation += 1
        generation = state.next_generation
        thread = threading.Thread(
            target=_scan_worker,
            args=(state, store, generation, drives, work, on_done),
            name=f"model-sources-scan-{generation}",
            daemon=True,
        )
        state.running[generation] = thread
    thread.start()
    return generation


def is_scan_running() -> bool:
    with _scan_state.lock:
        return bool(_scan_state.running)


def wait_for_scans(timeout: float = 30.0) -> bool:
    """Join every running scan thread (tests, scripts). True when none is left."""
    deadline = time.monotonic() + timeout
    while True:
        with _scan_state.lock:
            threads = list(_scan_state.running.values())
        if not threads:
            return True
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return False
        threads[0].join(remaining)


def scan_status(store: Optional[ModelSourcesStore] = None) -> Dict[str, Any]:
    state = _scan_state
    with state.lock:
        running = bool(state.running)
        completed = state.completed_generation
        scanned_at = state.scanned_at
        error = state.error
    if scanned_at is None and store is not None:
        scanned_at = store.scanned_at()
    if running:
        status = "running"
    elif error:
        status = "error"
    elif scanned_at is not None:
        status = "done"
    else:
        status = "never"
    return {
        "status": status,
        "scanned_at": scanned_at,
        "error": error,
        "completed_generation": completed,
    }


def default_store_path() -> Path:
    import config

    return Path(config.CONFIG_DIR) / "model_sources.json"
