"""Where else a model this program needs may already live (MS1a, 2026-10).

People who run ComfyUI usually already hold the WD14 taggers, Kaloscope,
Florence-2 and friends. Instead of downloading a second copy, the Model
Center can read them from a *trusted folder*. This module finds the
candidate roots; ``model_matchers`` decides which files inside them are the
exact pinned models.

Three cost tiers, cheapest first:

* **T0** — the trusted-folder list and ``COMFYUI_PATH`` (a few stat calls).
* **T1** — fixed install locations: Comfy Desktop's install folders and
  ``~/Documents/ComfyUI``.
* **T2** — a depth-2 directory-name scan (``/comfy/i``) of every fixed local
  drive (791 ms over six drives on the owner's PC). It runs on a background
  thread, once per process unless a rescan is asked for, and its result is
  saved in ``CONFIG_DIR/model_sources.json`` so the next start can show the
  cached roots while the fresh scan is still running.

Hugging Face caches are added as roots too: ``HF_HUB_CACHE``, ``HF_HOME/hub``,
the user's global ``~/.cache/huggingface/hub`` (the launcher points
``HF_HOME`` at ``data/hf``, so the global cache is otherwise invisible to this
program) and each ComfyUI install's ``models/hub``.

Network rules (SEC1b parity): the request thread never touches a network
path, not even ``isdir``. A root on a UNC path, a mapped or removable drive
or (Linux) a network mount is only judged on the background thread, and its
result is served from the cache. Inside a local root, a folder or file that
reaches a network location through a symlink or junction is skipped unless
that background pass explicitly allows it. Folders named in an
``extra_model_paths.yaml`` on a network path are dropped the same way.

Everything here is read-only. Nothing is ever written into a ComfyUI install
or a cache; the only file written is this program's own index.
"""

from __future__ import annotations

import logging
import ntpath
import os
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import (
    Any,
    Dict,
    Iterable,
    List,
    Mapping,
    Optional,
    Sequence,
    Tuple,
)

from model_source_paths import (
    KIND_LOCAL,
    KIND_NETWORK,
    _same_path,
    _windows_form,
    is_network_path,
    is_reparse_entry,
    list_fixed_drives,
    normalize_path,
    resolve_local_chain,
)

logger = logging.getLogger(__name__)

# Set to 0 to switch off the *automatic* finding (COMFYUI_PATH, fixed install
# folders, the drive scan, the global Hugging Face cache). Folders the user
# added to the trusted list are still read. The end-to-end tests and CI set it
# so the machine they run on cannot change what Model Center shows.
DISCOVERY_ENV = "SD_IMAGE_SORTER_MODEL_SOURCE_DISCOVERY"


def discovery_enabled(env: Optional[Mapping[str, str]] = None) -> bool:
    environment = os.environ if env is None else env
    return str(environment.get(DISCOVERY_ENV, "1")).strip().lower() not in {
        "0",
        "false",
        "no",
        "off",
    }


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
    trusted list (``UNTRUSTED_RANK`` otherwise). ``is_network`` roots exist
    only on the background thread; big files there are never hashed.
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


@dataclass(frozen=True)
class PendingRoot:
    """A network root: judged only by the background job, served from its cache."""

    path: str
    kind: str
    origin: str
    trusted_rank: int = UNTRUSTED_RANK

    @property
    def key(self) -> str:
        return source_key(self.path)


def source_key(path: object) -> str:
    """One comparable spelling for a root path, local or UNC, with or without a trailing slash."""
    normalized = ntpath.normpath(_windows_form(path))
    return os.path.normcase(normalized.rstrip("\\") or normalized)


# ---------------------------------------------------------------------------
# ComfyUI roots and extra_model_paths.yaml
# ---------------------------------------------------------------------------


def _local_file(path: str) -> bool:
    kind, real = resolve_local_chain(path)
    return kind == KIND_LOCAL and os.path.isfile(real)


def _entry_exists(path: str) -> bool:
    """lstat succeeds: a folder, or a link of any kind (never followed here)."""
    try:
        os.lstat(path)
    except OSError:
        return False
    return True


def is_comfyui_root(path: Path | str) -> bool:
    """``folder_paths.py`` is a local file (links followed only while local)
    and a ``models`` entry exists; nothing behind a network link is read."""
    root = str(path)
    return _local_file(os.path.join(root, "folder_paths.py")) and _entry_exists(
        os.path.join(root, "models")
    )


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


def _read_yaml(yaml_file: Path) -> Optional[Dict[str, Any]]:
    try:
        import yaml

        with open(yaml_file, "r", encoding="utf-8") as stream:
            config = yaml.safe_load(stream)
    except (OSError, ValueError) as exc:
        logger.debug("extra_model_paths.yaml not readable at %s: %s", yaml_file, exc)
        return None
    except Exception as exc:  # yaml.YAMLError and friends
        logger.warning(
            "extra_model_paths.yaml at %s could not be parsed: %s", yaml_file, exc
        )
        return None
    return config if isinstance(config, dict) else None


def _add_folder(paths: List[str], normalized: str, is_default: bool) -> None:
    """folder_paths.add_model_folder_path semantics: default goes first, no duplicates."""
    if normalized in paths:
        if is_default and paths[0] != normalized:
            paths.remove(normalized)
            paths.insert(0, normalized)
    elif is_default:
        paths.insert(0, normalized)
    else:
        paths.append(normalized)


def _section_folders(
    section: Dict[str, Any], yaml_dir: str, folders: Dict[str, List[str]]
) -> None:
    conf = dict(section)
    base_path: Optional[str] = None
    if "base_path" in conf:
        base_path = os.path.expandvars(os.path.expanduser(str(conf.pop("base_path"))))
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
            _add_folder(
                folders.setdefault(name, []), os.path.normpath(full_path), is_default
            )


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
    config = _read_yaml(yaml_file)
    if config is None:
        return {}
    yaml_dir = os.path.dirname(os.path.abspath(str(yaml_file)))
    folders: Dict[str, List[str]] = {}
    for section in config.values():
        if isinstance(section, dict):
            _section_folders(section, yaml_dir, folders)
    return folders


def _resolve_extra_folders(
    folders: Dict[str, List[str]], *, network_allowed: bool
) -> Dict[str, List[str]]:
    """Each yaml folder through the link gate: local ones by their real path,
    network ones only when allowed, missing ones dropped."""
    kept: Dict[str, List[str]] = {}
    for name, paths in folders.items():
        for raw in paths:
            kind, real = resolve_local_chain(raw)
            if kind == KIND_LOCAL or (kind == KIND_NETWORK and network_allowed):
                if real not in kept.setdefault(name, []):
                    kept[name].append(real)
    return {name: paths for name, paths in kept.items() if paths}


def _looks_like_hf_cache(path: Path) -> bool:
    try:
        return any(
            child.name.startswith("models--") and child.is_dir()
            for child in path.iterdir()
        )
    except OSError:
        return False


def _comfyui_source_root(
    folder: Path, origin: str, trusted_rank: int, *, network_allowed: bool
) -> Optional[SourceRoot]:
    comfy = resolve_comfyui_root(folder)
    if comfy is None:
        return None
    comfy_path = os.path.normpath(str(comfy))
    extra = _resolve_extra_folders(
        load_extra_model_paths(comfy / "extra_model_paths.yaml"),
        network_allowed=network_allowed,
    )
    return SourceRoot(
        path=comfy_path,
        kind=KIND_COMFYUI,
        origin=origin,
        is_network=is_network_path(comfy_path),
        version=read_comfyui_version(comfy),
        trusted_rank=trusted_rank,
        extra_model_paths=extra,
    )


def build_source_root(
    raw_path: str,
    *,
    kind: str = "auto",
    origin: str,
    trusted_rank: int = UNTRUSTED_RANK,
    network_allowed: bool = False,
) -> Optional[SourceRoot]:
    """Classify one path. ``None`` when it does not exist, is not what ``kind``
    says, or reaches the network (directly or through a link) while
    ``network_allowed`` is False: then nothing behind the link is stat'ed.
    The root's path is the real folder every local link leads to."""
    try:
        chain_kind, path = resolve_local_chain(normalize_path(raw_path))
    except (TypeError, ValueError):
        return None
    if chain_kind == KIND_NETWORK and not network_allowed:
        return None
    if chain_kind != KIND_LOCAL and chain_kind != KIND_NETWORK:
        return None
    if not os.path.isdir(path):
        return None
    folder = Path(path)
    resolved_kind = kind if kind in KINDS else "auto"
    if resolved_kind in ("auto", KIND_COMFYUI):
        comfy = _comfyui_source_root(
            folder, origin, trusted_rank, network_allowed=network_allowed
        )
        if comfy is not None or resolved_kind == KIND_COMFYUI:
            return comfy
    if resolved_kind == KIND_HF_CACHE or (
        resolved_kind == "auto" and _looks_like_hf_cache(folder)
    ):
        resolved_kind = KIND_HF_CACHE
    else:
        resolved_kind = KIND_FOLDER
    return SourceRoot(
        path=path,
        kind=resolved_kind,
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


def _probe_candidates(environment: Mapping[str, str], home_dir: Path) -> List[Path]:
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
    return [c for c in candidates if not is_network_path(str(c))]


def _plain_subdirs(folder: Path) -> List[str]:
    """Child directories that are not symlinks or junctions, sorted."""
    try:
        with os.scandir(folder) as entries:
            return sorted(
                e.path
                for e in entries
                if not is_reparse_entry(e) and e.is_dir(follow_symlinks=False)
            )
    except OSError:
        return []


def probe_known_locations(
    *, env: Optional[Mapping[str, str]] = None, home: Optional[Path] = None
) -> List[str]:
    """Comfy Desktop install folders and ``~/Documents/ComfyUI`` (docs.comfy.org)."""
    environment = os.environ if env is None else env
    home_dir = Path.home() if home is None else Path(home)
    found: List[str] = []
    for raw_candidate in _probe_candidates(environment, home_dir):
        kind, real = resolve_local_chain(str(raw_candidate))
        if kind != KIND_LOCAL or not os.path.isdir(real):
            continue
        candidate = Path(real)
        if resolve_comfyui_root(candidate) is not None:
            found.append(str(candidate))
            continue
        # An "installs" folder holds one subfolder per install.
        found.extend(
            child
            for child in _plain_subdirs(candidate)
            if resolve_comfyui_root(child) is not None
        )
    return found


# ---------------------------------------------------------------------------
# T2: drive scan walk (run by model_sources_store on the background thread)
# ---------------------------------------------------------------------------


def _scan_children(folder: str) -> List[str]:
    try:
        with os.scandir(folder) as entries:
            return [
                entry.path
                for entry in entries
                if entry.name.lower() not in _SCAN_SKIP_NAMES
                and not entry.name.startswith(".")
                and not is_reparse_entry(entry)
                and _is_dir_no_follow(entry)
                and not (sys.platform != "win32" and is_network_path(entry.path))
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
            for candidate in [level1, *_scan_children(level1)]:
                if not _COMFY_NAME_RE.search(os.path.basename(candidate)):
                    continue
                resolved = resolve_comfyui_root(candidate)
                if resolved is not None:
                    found.setdefault(os.path.normcase(str(resolved)), str(resolved))
    return sorted(found.values())


# ---------------------------------------------------------------------------
# Putting the tiers together
# ---------------------------------------------------------------------------


class _RootCollector:
    """Local roots are built now; network ones are queued for the background job."""

    def __init__(self) -> None:
        self.roots: List[SourceRoot] = []
        self.pending: List[PendingRoot] = []

    def add(
        self, raw: str, *, kind: str, origin: str, trusted_rank: int = UNTRUSTED_RANK
    ) -> None:
        text = str(raw or "").strip()
        if not text:
            return
        chain_kind, real = resolve_local_chain(normalize_path(text))
        if chain_kind == KIND_NETWORK:
            # Only a trusted entry earns a background look; anything else
            # that leads to the network (directly or through a link) is dropped.
            if trusted_rank >= UNTRUSTED_RANK:
                logger.debug("Skipping network model source %s (%s)", text, origin)
                return
            pending = PendingRoot(
                path=text, kind=kind, origin=origin, trusted_rank=trusted_rank
            )
            if not any(p.key == pending.key for p in self.pending):
                self.pending.append(pending)
            return
        if chain_kind != KIND_LOCAL:
            return
        root = build_source_root(
            real, kind=kind, origin=origin, trusted_rank=trusted_rank
        )
        if root is not None and not any(
            _same_path(r.path, root.path) for r in self.roots
        ):
            self.roots.append(root)


def _comfyui_hub_candidates(roots: Sequence[SourceRoot]) -> List[Tuple[str, int]]:
    """Each local ComfyUI's ``models/hub`` unless it is a link to a network place."""
    hubs: List[Tuple[str, int]] = []
    for root in roots:
        if root.kind != KIND_COMFYUI:
            continue
        kind, real = resolve_local_chain(os.path.join(root.path, "models", "hub"))
        if kind == KIND_LOCAL:
            hubs.append((real, root.trusted_rank))
    return hubs


def detect_source_roots(
    trusted_folders: Optional[Iterable[Mapping[str, Any]]] = None,
    *,
    env: Optional[Mapping[str, str]] = None,
    home: Optional[Path] = None,
    scan_cache: Sequence[str] = (),
    probe: bool = True,
) -> Tuple[List[SourceRoot], List[PendingRoot]]:
    """T0 trusted list and ``COMFYUI_PATH``, T1 probes, cached T2 roots, then HF caches.

    Returns (local roots in priority order, network roots left to the
    background job). Trusted folders keep their list order and rank;
    everything found automatically comes after them.
    """
    environment = os.environ if env is None else env
    collector = _RootCollector()
    for rank, entry in enumerate(trusted_folders or ()):
        collector.add(
            str(entry.get("path") or ""),
            kind=str(entry.get("kind") or "auto"),
            origin=ORIGIN_TRUSTED,
            trusted_rank=rank,
        )
    if discovery_enabled(environment):
        collector.add(
            str(environment.get("COMFYUI_PATH") or ""),
            kind=KIND_COMFYUI,
            origin=ORIGIN_ENV,
        )
    else:
        probe, scan_cache = False, ()
    if probe:
        for found in probe_known_locations(env=environment, home=home):
            collector.add(found, kind=KIND_COMFYUI, origin=ORIGIN_PROBE)
    for cached in scan_cache:
        collector.add(cached, kind=KIND_COMFYUI, origin=ORIGIN_SCAN)
    for hub in hf_cache_roots(env=environment, home=home) if discovery_enabled(environment) else ():
        collector.add(hub, kind=KIND_HF_CACHE, origin=ORIGIN_HF_DEFAULT)
    for hub, rank in _comfyui_hub_candidates(collector.roots):
        collector.add(
            hub, kind=KIND_HF_CACHE, origin=ORIGIN_COMFYUI_HUB, trusted_rank=rank
        )
    return collector.roots, collector.pending
