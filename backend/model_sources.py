"""Where else a model this program needs may already live (MS1a, 2026-10).

People who run ComfyUI usually already hold the WD14 taggers, Kaloscope,
Florence-2 and friends. Instead of downloading a second copy, the Model
Center can read them from a *trusted folder*. This module finds the
candidate roots; ``model_matchers`` decides which files inside them are the
exact pinned models.

Three cost tiers, cheapest first:

* **T0** — the trusted-folder list and ``COMFYUI_PATH`` (a few stat calls).
* **T1** — fixed install locations: Comfy Desktop's install folders,
  ``~/Documents/ComfyUI`` and the Desktop ``extra_models_config.yaml``.
* **T2** — a depth-2 directory-name scan (``/comfy/i``) of every fixed local
  drive (791 ms over six drives on the owner's PC). It runs at most once per
  process on a background thread and its result is saved with each root's
  mtime in ``CONFIG_DIR/model_sources.json`` so later starts skip it.

Hugging Face caches are added as roots too: ``HF_HUB_CACHE``, ``HF_HOME/hub``,
the user's global ``~/.cache/huggingface/hub`` (the launcher points
``HF_HOME`` at ``data/hf``, so the global cache is otherwise invisible to this
program) and each ComfyUI install's ``models/hub``.

Everything here is read-only. Nothing is ever written into a ComfyUI install
or a cache; the only file written is this program's own index.

The trusted-folder list itself (``/api/models/trusted-folders``) is owned by
another slice; this module only *reads* it through
``set_trusted_folder_provider``.
"""

from __future__ import annotations

import json
import logging
import os
import re
import sys
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Mapping, Optional, Sequence

logger = logging.getLogger(__name__)

KIND_COMFYUI = "comfyui"
KIND_HF_CACHE = "hf_cache"
KIND_FOLDER = "folder"
KINDS = (KIND_COMFYUI, KIND_HF_CACHE, KIND_FOLDER)

ORIGIN_TRUSTED = "trusted"
ORIGIN_ENV = "env"
ORIGIN_PROBE = "probe"
ORIGIN_SCAN = "scan"
ORIGIN_HF_DEFAULT = "hf_default"
ORIGIN_COMFYUI_HUB = "comfyui_hub"

# Roots that are not in the trusted list sort after every trusted one.
UNTRUSTED_RANK = 1000

# Windows drive types (GetDriveTypeW).
_DRIVE_REMOVABLE = 2
_DRIVE_FIXED = 3
_DRIVE_REMOTE = 4

# Directory names never descended into during the T2 scan.
_SCAN_SKIP_NAMES = {
    "$recycle.bin",
    "system volume information",
    "windows",
    "programdata",
    "node_modules",
    "__pycache__",
}
_COMFY_NAME_RE = re.compile(r"comfy", re.IGNORECASE)
_VERSION_RE = re.compile(r"""__version__\s*=\s*['"]([^'"]+)['"]""")

# Same mapping as ComfyUI folder_paths.map_legacy (0.36.0).
_LEGACY_FOLDER_NAMES = {"unet": "diffusion_models", "clip": "text_encoders"}


@dataclass(frozen=True)
class SourceRoot:
    """One place to look for models.

    ``path`` is normalized and absolute. ``kind`` says how to search it,
    ``origin`` says how it was found, ``trusted_rank`` is its index in the
    trusted list (``UNTRUSTED_RANK`` otherwise). ``is_network`` also covers
    removable drives: both are slow, so big files there are not hashed.
    """

    path: str
    kind: str
    origin: str
    is_network: bool = False
    version: Optional[str] = None
    trusted_rank: int = UNTRUSTED_RANK
    extra_model_paths: Dict[str, List[str]] = field(
        default_factory=dict, compare=False, hash=False
    )

    def to_dict(self) -> Dict[str, Any]:
        return {
            "path": self.path,
            "kind": self.kind,
            "origin": self.origin,
            "is_network": self.is_network,
            "version": self.version,
            "trusted": self.trusted_rank < UNTRUSTED_RANK,
        }


# ---------------------------------------------------------------------------
# Trusted-folder provider (storage and API belong to another slice)
# ---------------------------------------------------------------------------

TrustedFolderProvider = Callable[[], Sequence[Mapping[str, Any]]]
_trusted_provider: Optional[TrustedFolderProvider] = None


def set_trusted_folder_provider(provider: Optional[TrustedFolderProvider]) -> None:
    """Install the function that returns ``[{path, kind, added_at}, ...]``."""
    global _trusted_provider
    _trusted_provider = provider


def get_trusted_folders() -> List[Mapping[str, Any]]:
    if _trusted_provider is None:
        return []
    try:
        return list(_trusted_provider())
    except (
        Exception
    ) as exc:  # the list is user data; a broken store must not hide detection
        logger.warning("Trusted folder list unavailable: %s", exc)
        return []


# ---------------------------------------------------------------------------
# Path helpers
# ---------------------------------------------------------------------------


def normalize_path(raw: str) -> str:
    expanded = os.path.expanduser(os.path.expandvars(str(raw).strip()))
    return os.path.normpath(os.path.abspath(expanded))


def _same_path(a: str, b: str) -> bool:
    return os.path.normcase(a) == os.path.normcase(b)


def _drive_type(path: str) -> Optional[int]:
    if sys.platform != "win32":
        return None
    drive, _ = os.path.splitdrive(path)
    if not drive or drive.startswith("\\\\"):
        return None
    try:
        import ctypes

        return int(ctypes.windll.kernel32.GetDriveTypeW(drive + "\\"))
    except Exception:
        return None


def is_network_path(path: str) -> bool:
    """UNC paths, mapped network drives and removable drives (all slow)."""
    text = str(path)
    if text.startswith("\\\\") or text.startswith("//"):
        return True
    return _drive_type(text) in (_DRIVE_REMOTE, _DRIVE_REMOVABLE)


def list_fixed_drives() -> List[str]:
    """Roots the T2 scan walks: fixed local drives on Windows, a few folders elsewhere."""
    if sys.platform == "win32":
        try:
            import ctypes
            import string

            mask = ctypes.windll.kernel32.GetLogicalDrives()
        except Exception:
            return []
        drives = []
        for index, letter in enumerate(string.ascii_uppercase):
            if not mask & (1 << index):
                continue
            root = f"{letter}:\\"
            if _drive_type(root) == _DRIVE_FIXED:
                drives.append(root)
        return drives
    candidates = [str(Path.home()), "/opt", "/srv", "/mnt"]
    return [c for c in candidates if os.path.isdir(c)]


# ---------------------------------------------------------------------------
# ComfyUI roots and extra_model_paths.yaml
# ---------------------------------------------------------------------------


def is_comfyui_root(path: Path | str) -> bool:
    root = Path(path)
    try:
        return (root / "folder_paths.py").is_file() and (root / "models").is_dir()
    except OSError:
        return False


def resolve_comfyui_root(path: Path | str) -> Optional[Path]:
    """The install itself, or the ``ComfyUI/`` folder inside an aki/portable shell."""
    candidate = Path(path)
    if is_comfyui_root(candidate):
        return candidate
    inner = candidate / "ComfyUI"
    if is_comfyui_root(inner):
        return inner
    return None


def read_comfyui_version(root: Path | str) -> Optional[str]:
    version_file = Path(root) / "comfyui_version.py"
    try:
        text = version_file.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None
    match = _VERSION_RE.search(text)
    return match.group(1) if match else None


def load_extra_model_paths(yaml_path: Path | str) -> Dict[str, List[str]]:
    """Parse ``extra_model_paths.yaml`` exactly like ComfyUI ``utils/extra_config.py``.

    Returns ``{folder_name: [absolute normalized paths]}``. Sections are
    arbitrary; ``base_path`` is expandvars + expanduser and, when relative,
    joined to the yaml's own folder; ``is_default`` puts that section's
    folders first; every other key is a newline-separated list of folders
    joined under ``base_path`` (or the yaml folder when there is none).
    Legacy folder names map like ``folder_paths.map_legacy``. A missing or
    unreadable file is simply empty: this is a hint, never an error.
    """
    yaml_file = Path(yaml_path)
    try:
        import yaml

        with open(yaml_file, "r", encoding="utf-8") as stream:
            config = yaml.safe_load(stream)
    except (OSError, ValueError) as exc:
        logger.debug("extra_model_paths.yaml not readable at %s: %s", yaml_file, exc)
        return {}
    except Exception as exc:  # yaml.YAMLError and friends
        logger.warning(
            "extra_model_paths.yaml at %s could not be parsed: %s", yaml_file, exc
        )
        return {}
    if not isinstance(config, dict):
        return {}

    yaml_dir = os.path.dirname(os.path.abspath(str(yaml_file)))
    folders: Dict[str, List[str]] = {}
    for section in config.values():
        if not isinstance(section, dict):
            continue
        conf = dict(section)
        base_path: Optional[str] = None
        if "base_path" in conf:
            base_path = os.path.expandvars(
                os.path.expanduser(str(conf.pop("base_path")))
            )
            if not os.path.isabs(base_path):
                base_path = os.path.abspath(os.path.join(yaml_dir, base_path))
        is_default = bool(conf.pop("is_default", False))
        for folder_name, value in conf.items():
            if value is None:
                continue
            name = _LEGACY_FOLDER_NAMES.get(str(folder_name), str(folder_name))
            for entry in str(value).split("\n"):
                if len(entry) == 0:
                    continue
                full_path = entry
                if base_path:
                    full_path = os.path.join(base_path, full_path)
                elif not os.path.isabs(full_path):
                    full_path = os.path.abspath(os.path.join(yaml_dir, entry))
                normalized = os.path.normpath(full_path)
                paths = folders.setdefault(name, [])
                if normalized in paths:
                    if is_default and paths[0] != normalized:
                        paths.remove(normalized)
                        paths.insert(0, normalized)
                elif is_default:
                    paths.insert(0, normalized)
                else:
                    paths.append(normalized)
    return folders


def _looks_like_hf_cache(path: Path) -> bool:
    try:
        return any(
            child.name.startswith("models--") and child.is_dir()
            for child in path.iterdir()
        )
    except OSError:
        return False


def build_source_root(
    raw_path: str,
    *,
    kind: str = "auto",
    origin: str,
    trusted_rank: int = UNTRUSTED_RANK,
) -> Optional[SourceRoot]:
    """Classify one path. ``None`` when it does not exist or is not what ``kind`` says."""
    try:
        path = normalize_path(raw_path)
    except (TypeError, ValueError):
        return None
    if not os.path.isdir(path):
        return None
    folder = Path(path)
    resolved_kind = kind if kind in KINDS else "auto"
    if resolved_kind in ("auto", KIND_COMFYUI):
        comfy = resolve_comfyui_root(folder)
        if comfy is not None:
            comfy_path = os.path.normpath(str(comfy))
            return SourceRoot(
                path=comfy_path,
                kind=KIND_COMFYUI,
                origin=origin,
                is_network=is_network_path(comfy_path),
                version=read_comfyui_version(comfy),
                trusted_rank=trusted_rank,
                extra_model_paths=load_extra_model_paths(
                    comfy / "extra_model_paths.yaml"
                ),
            )
        if resolved_kind == KIND_COMFYUI:
            return None
    if resolved_kind in ("auto", KIND_HF_CACHE):
        if resolved_kind == KIND_HF_CACHE or _looks_like_hf_cache(folder):
            return SourceRoot(
                path=path,
                kind=KIND_HF_CACHE,
                origin=origin,
                is_network=is_network_path(path),
                trusted_rank=trusted_rank,
            )
    return SourceRoot(
        path=path,
        kind=KIND_FOLDER,
        origin=origin,
        is_network=is_network_path(path),
        trusted_rank=trusted_rank,
    )


# ---------------------------------------------------------------------------
# Hugging Face cache roots
# ---------------------------------------------------------------------------


def hf_cache_roots(
    *, env: Optional[Mapping[str, str]] = None, home: Optional[Path] = None
) -> List[str]:
    """``HF_HUB_CACHE``, ``HF_HOME/hub``, then the global ``~/.cache/huggingface/hub``."""
    environment = os.environ if env is None else env
    home_dir = Path.home() if home is None else Path(home)
    roots: List[str] = []
    hub_cache = str(environment.get("HF_HUB_CACHE") or "").strip()
    if hub_cache:
        roots.append(hub_cache)
    hf_home = str(environment.get("HF_HOME") or "").strip()
    if hf_home:
        roots.append(os.path.join(hf_home, "hub"))
    roots.append(str(home_dir / ".cache" / "huggingface" / "hub"))
    unique: List[str] = []
    for root in roots:
        normalized = os.path.normpath(os.path.expanduser(os.path.expandvars(root)))
        if not any(_same_path(normalized, seen) for seen in unique):
            unique.append(normalized)
    return unique


# ---------------------------------------------------------------------------
# T1: fixed install locations
# ---------------------------------------------------------------------------


def probe_known_locations(
    *, env: Optional[Mapping[str, str]] = None, home: Optional[Path] = None
) -> List[str]:
    """Comfy Desktop install folders and ``~/Documents/ComfyUI`` (docs.comfy.org)."""
    environment = os.environ if env is None else env
    home_dir = Path.home() if home is None else Path(home)
    candidates: List[Path] = []
    local_app_data = str(environment.get("LOCALAPPDATA") or "").strip()
    if local_app_data:
        candidates.append(Path(local_app_data) / "Comfy-Desktop" / "ComfyUI-Installs")
    user_profile = str(environment.get("USERPROFILE") or "").strip()
    profile = Path(user_profile) if user_profile else home_dir
    candidates.append(profile / "ComfyUI-Installs")
    candidates.append(profile / "Documents" / "ComfyUI")
    candidates.append(home_dir / "ComfyUI")
    candidates.append(home_dir / "ComfyUI_windows_portable")

    found: List[str] = []
    for candidate in candidates:
        if not candidate.is_dir():
            continue
        if resolve_comfyui_root(candidate) is not None:
            found.append(str(candidate))
            continue
        # An "installs" folder holds one subfolder per install.
        try:
            children = sorted(child for child in candidate.iterdir() if child.is_dir())
        except OSError:
            continue
        found.extend(
            str(child) for child in children if resolve_comfyui_root(child) is not None
        )
    return found


# ---------------------------------------------------------------------------
# T2: drive scan (background, once per process, persisted)
# ---------------------------------------------------------------------------


def _scan_children(folder: str) -> List[os.DirEntry]:
    try:
        with os.scandir(folder) as entries:
            return [
                entry
                for entry in entries
                if entry.name.lower() not in _SCAN_SKIP_NAMES
                and not entry.name.startswith(".")
                and _is_dir_no_follow(entry)
            ]
    except OSError:
        return []


def _is_dir_no_follow(entry: os.DirEntry) -> bool:
    try:
        return entry.is_dir(follow_symlinks=False)
    except OSError:
        return False


def scan_drives_for_comfyui(drives: Optional[Sequence[str]] = None) -> List[str]:
    """Depth-2 name match ``/comfy/i`` under each drive root; returns real ComfyUI roots, sorted."""
    roots = list_fixed_drives() if drives is None else list(drives)
    found: Dict[str, str] = {}
    for drive in roots:
        for level1 in _scan_children(drive):
            candidates = [level1.path]
            candidates.extend(entry.path for entry in _scan_children(level1.path))
            for candidate in candidates:
                if not _COMFY_NAME_RE.search(os.path.basename(candidate)):
                    continue
                resolved = resolve_comfyui_root(candidate)
                if resolved is None:
                    continue
                key = os.path.normcase(str(resolved))
                found.setdefault(key, str(resolved))
    return sorted(found.values())


class ModelSourcesStore:
    """``CONFIG_DIR/model_sources.json``: scan cache, digest cache, chosen matches."""

    VERSION = 1

    def __init__(self, path: Path | str) -> None:
        self.path = Path(path)
        self._lock = threading.Lock()
        self._data = self._load()

    def _load(self) -> Dict[str, Any]:
        try:
            raw = self.path.read_text(encoding="utf-8")
        except OSError:
            return self._empty()
        try:
            data = json.loads(raw)
        except json.JSONDecodeError as exc:
            logger.warning(
                "model_sources.json at %s is corrupt (%s); starting fresh",
                self.path,
                exc,
            )
            return self._empty()
        if not isinstance(data, dict):
            return self._empty()
        base = self._empty()
        for key in base:
            value = data.get(key)
            if isinstance(value, type(base[key])):
                base[key] = value
        return base

    @classmethod
    def _empty(cls) -> Dict[str, Any]:
        return {"version": cls.VERSION, "scan": {}, "digests": {}, "matches": []}

    def _save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(self.path.suffix + ".tmp")
        tmp.write_text(
            json.dumps(self._data, indent=2, sort_keys=True), encoding="utf-8"
        )
        os.replace(tmp, self.path)

    # scan cache -----------------------------------------------------------

    def save_scan(self, roots: Iterable[str], *, scanned_at: float) -> None:
        entries = []
        for root in roots:
            try:
                mtime_ns = os.stat(root).st_mtime_ns
            except OSError:
                continue
            entries.append({"path": str(root), "mtime_ns": mtime_ns})
        with self._lock:
            self._data["scan"] = {"scanned_at": float(scanned_at), "roots": entries}
            self._save()

    def scan_roots(self) -> List[str]:
        """Cached roots that still are ComfyUI installs."""
        with self._lock:
            entries = list(self._data.get("scan", {}).get("roots") or [])
        return [
            str(e["path"])
            for e in entries
            if isinstance(e, dict) and is_comfyui_root(str(e.get("path", "")))
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

    # chosen matches -------------------------------------------------------

    def save_matches(self, matches: Iterable[Mapping[str, Any]]) -> None:
        with self._lock:
            self._data["matches"] = [dict(m) for m in matches]
            self._save()

    def matches(self) -> List[Dict[str, Any]]:
        with self._lock:
            return [dict(m) for m in self._data.get("matches") or []]


class _ScanState:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.started = False
        self.running = False
        self.scanned_at: Optional[float] = None
        self.roots: List[str] = []
        self.error: Optional[str] = None


_scan_state = _ScanState()


def _run_scan(store: ModelSourcesStore, drives: Optional[Sequence[str]]) -> List[str]:
    started = time.perf_counter()
    roots = scan_drives_for_comfyui(drives)
    store.save_scan(roots, scanned_at=time.time())
    logger.info(
        "ComfyUI drive scan: %d root(s) in %.0f ms",
        len(roots),
        (time.perf_counter() - started) * 1000,
    )
    return roots


def ensure_background_scan(
    store: ModelSourcesStore,
    *,
    drives: Optional[Sequence[str]] = None,
    on_done: Optional[Callable[[], None]] = None,
) -> bool:
    """Start the T2 scan on a daemon thread, once per process. Returns True when started."""
    state = _scan_state
    with state.lock:
        if state.started:
            return False
        state.started = True
        state.running = True

    def worker() -> None:
        try:
            roots = _run_scan(store, drives)
            with state.lock:
                state.roots = roots
                state.scanned_at = time.time()
        except Exception as exc:
            logger.warning("ComfyUI drive scan failed: %s", exc)
            with state.lock:
                state.error = str(exc)
        finally:
            with state.lock:
                state.running = False
            if on_done is not None:
                on_done()

    threading.Thread(target=worker, name="model-sources-scan", daemon=True).start()
    return True


def rescan_now(
    store: ModelSourcesStore, *, drives: Optional[Sequence[str]] = None
) -> List[str]:
    """The Model Center's manual rescan: synchronous, result persisted."""
    state = _scan_state
    with state.lock:
        state.started = True
        state.running = True
    try:
        roots = _run_scan(store, drives)
        with state.lock:
            state.roots = roots
            state.scanned_at = time.time()
            state.error = None
        return roots
    finally:
        with state.lock:
            state.running = False


def scan_status(store: Optional[ModelSourcesStore] = None) -> Dict[str, Any]:
    state = _scan_state
    with state.lock:
        running = state.running
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
    return {"status": status, "scanned_at": scanned_at, "error": error}


# ---------------------------------------------------------------------------
# Putting the tiers together
# ---------------------------------------------------------------------------


def _append_root(roots: List[SourceRoot], root: Optional[SourceRoot]) -> None:
    if root is None:
        return
    if any(_same_path(existing.path, root.path) for existing in roots):
        return
    roots.append(root)


def detect_source_roots(
    trusted_folders: Optional[Iterable[Mapping[str, Any]]] = None,
    *,
    env: Optional[Mapping[str, str]] = None,
    home: Optional[Path] = None,
    scan_cache: Sequence[str] = (),
    probe: bool = True,
) -> List[SourceRoot]:
    """T0 trusted list and ``COMFYUI_PATH``, T1 probes, cached T2 roots, then HF caches.

    Order is priority order: trusted folders keep their list order and rank,
    everything found automatically comes after them.
    """
    environment = os.environ if env is None else env
    roots: List[SourceRoot] = []

    for rank, entry in enumerate(trusted_folders or ()):
        raw = str(entry.get("path") or "").strip()
        if not raw:
            continue
        kind = str(entry.get("kind") or "auto")
        _append_root(
            roots,
            build_source_root(raw, kind=kind, origin=ORIGIN_TRUSTED, trusted_rank=rank),
        )

    comfy_env = str(environment.get("COMFYUI_PATH") or "").strip()
    if comfy_env:
        _append_root(
            roots, build_source_root(comfy_env, kind=KIND_COMFYUI, origin=ORIGIN_ENV)
        )

    if probe:
        for found in probe_known_locations(env=environment, home=home):
            _append_root(
                roots, build_source_root(found, kind=KIND_COMFYUI, origin=ORIGIN_PROBE)
            )

    for cached in scan_cache:
        _append_root(
            roots, build_source_root(cached, kind=KIND_COMFYUI, origin=ORIGIN_SCAN)
        )

    for hub in hf_cache_roots(env=environment, home=home):
        _append_root(
            roots, build_source_root(hub, kind=KIND_HF_CACHE, origin=ORIGIN_HF_DEFAULT)
        )

    for root in list(roots):
        if root.kind != KIND_COMFYUI:
            continue
        hub = os.path.join(root.path, "models", "hub")
        _append_root(
            roots,
            build_source_root(
                hub,
                kind=KIND_HF_CACHE,
                origin=ORIGIN_COMFYUI_HUB,
                trusted_rank=root.trusted_rank,
            ),
        )
    return roots


def default_store_path() -> Path:
    import config

    return Path(config.CONFIG_DIR) / "model_sources.json"
