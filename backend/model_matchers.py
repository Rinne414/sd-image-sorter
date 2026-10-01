"""Which files in a source root are the exact models this program pins (MS1a).

One matcher per model family. Each returns ``ExternalMatch`` rows (the
pinned model is here) and ``RejectedCandidate`` rows (looks related, but is
not the pinned model, so the Model Center can say *why* instead of staying
silent).

A match is **trusted**, and only then adopted, when
``model_roots.is_under_allowed_model_root`` accepts its path: the same rule
the loaders apply (SEC1b), so a card that shows "ready" never points at a
file the loader would refuse. Untrusted matches become suggestions ("found
ComfyUI with 8.5 GB usable, trust it?").

Verification levels, strongest first:

* ``sha`` — the SHA-256 equals the pin (files up to ``SHA_LIMIT_BYTES`` on a
  local disk; digests are cached by path, size and mtime).
* ``revision`` — a Hugging Face cache snapshot folder named after the pinned
  commit, with every required file present and non-empty.
* ``size`` — the byte size equals the pin (big files, or network/removable
  drives where hashing would take minutes).
* ``name`` — only the file name identifies it (privacy YOLO by the ``wenaka``
  convention, the aesthetic backbone), exactly as the existing loaders do.

Companion files that are small (``COMPANION_HASH_LIMIT_BYTES``) are always
hashed when a pin exists, even on network drives.

A different version is never adopted (TIPO v2 vs v2.1, another Florence
snapshot); it is reported as ``version_mismatch``. SAM3 checkpoints in Meta's
format are not matched at all: the loader needs the transformers folder.
Only the WD14 runtime family of ``TAGGER_MODELS`` is matched; OppaiOracle
needs its preprocessing/threshold sidecars and nobody has shown a ComfyUI
install carrying it, so it is left out until there is a real case.

Network rules: a folder or file that reaches a network location (UNC, mapped
or removable drive, Linux network mount, or a symlink/junction to one) is
never opened on the request thread; ``network_allowed`` is set only by the
background pass over trusted network roots. A single unreadable file becomes
a ``unreadable`` rejection, never an exception out of the matcher.
"""

from __future__ import annotations

import hashlib
import logging
import os
from dataclasses import dataclass, field, fields
from pathlib import Path
from typing import (
    Any,
    Callable,
    Dict,
    Iterable,
    List,
    Mapping,
    Optional,
    Protocol,
    Sequence,
    Tuple,
)

import model_roots
import model_source_paths
import model_sources
from model_sources import KIND_COMFYUI, KIND_FOLDER, KIND_HF_CACHE, SourceRoot
from tagger_models import TAGGER_MODELS

logger = logging.getLogger(__name__)

VERIFY_SHA = "sha"
VERIFY_REVISION = "revision"
VERIFY_SIZE = "size"
VERIFY_NAME = "name"
_VERIFY_RANK = {VERIFY_SHA: 0, VERIFY_REVISION: 0, VERIFY_SIZE: 1, VERIFY_NAME: 2}

SHA_LIMIT_BYTES = 500 * 1024 * 1024
COMPANION_HASH_LIMIT_BYTES = 16 * 1024 * 1024
_HASH_CHUNK = 1 << 20

REASON_SIZE = "size_mismatch"
REASON_SHA = "sha_mismatch"
REASON_MISSING_COMPANION = "missing_companion"
REASON_COMPANION = "companion_mismatch"
REASON_INCOMPLETE = "incomplete"
REASON_VERSION = "version_mismatch"
REASON_UNVERIFIED = "unverified"
REASON_UNREADABLE = "unreadable"

# Kaloscope 2.0 checkpoint (HF HEAD 2026-10-01: X-Linked-Size / X-Linked-ETag).
KALOSCOPE_CHECKPOINT_SIZE_BYTES = 2_937_892_740
KALOSCOPE_CHECKPOINT_SHA256 = (
    "a86ba2fcf430cbb653ac995f7ab9cce34667434ee084973e19edf431808a32ae"
)
KALOSCOPE_CHECKPOINT_NAME = "best_checkpoint.pth"
KALOSCOPE_CLASS_MAPPING_NAME = "class_mapping.csv"
KALOSCOPE_VARIANT = "kaloscope2.0"

# TAGGER_MODELS entries without a runtime_backend run on the WD14 ONNX tagger.
WD14_RUNTIME_BACKEND = "wd14"


@dataclass(frozen=True)
class FilePin:
    filename: str
    size_bytes: int
    sha256: str


# TIPO weights by tipo_service.MODEL_SPECS id (HF HEAD 2026-10-01).
TIPO_FILE_PINS: Dict[str, FilePin] = {
    "v2.1": FilePin(
        filename="TIPO-v2.1-1B-A200M-Q8_0.gguf",
        size_bytes=1_072_689_600,
        sha256="0847e9e2e667a009bc82ecf534b628425d515b0f74fb5c1dc0705568906c4773",
    ),
}


# Where ComfyUI nodes keep the files (comfyui-WD14-Tagger wd14tagger.py:33-38,
# ComfyUI-Booru-Tagger nodes.py:54-65) and the folder_paths names they register.
_WD14_COMFY_SUBDIRS = (
    "custom_nodes/comfyui-WD14-Tagger/models",
    "models/wd14_tagger",
    "custom_nodes/ComfyUI-Booru-Tagger/models",
    "models/booru_tagger",
)
_WD14_FOLDER_SUBDIRS = ("", "wd14_tagger", "booru_tagger", "wd14-tagger")
_WD14_EXTRA_KEYS = ("wd14_tagger", "booru_tagger")
_KALOSCOPE_COMFY_SUBDIRS = ("models/lsnet",)
_KALOSCOPE_FOLDER_SUBDIRS = ("", "lsnet", "artist")
_KALOSCOPE_EXTRA_KEYS = ("lsnet",)
_KALOSCOPE_WALK_DEPTH = 3
_YOLO_COMFY_SUBDIRS = (
    "models/ultralytics/segm",
    "models/ultralytics/bbox",
    "models/yolo",
)
_YOLO_FOLDER_SUBDIRS = ("", "ultralytics/segm", "ultralytics/bbox", "yolo")
_YOLO_EXTRA_KEYS = ("ultralytics", "ultralytics_bbox", "ultralytics_segm", "yolo")
_YOLO_SUFFIXES = (".pt", ".onnx")
_TIPO_COMFY_SUBDIRS = ("models/kgen", "models/kgen/gguf")
_TIPO_FOLDER_SUBDIRS = ("", "kgen", "tipo")
_TIPO_EXTRA_KEYS = ("kgen",)

TrustCheck = Callable[[str], bool]


@dataclass(frozen=True)
class ExternalMatch:
    model_id: str
    variant: Optional[str]
    path: str
    source: str  # the root it was found under
    folder: str  # the folder that would have to be trusted (root, or an extra_model_paths folder)
    source_kind: str
    origin: str
    verify: str
    size_bytes: int
    mtime_ns: int
    companions: Tuple[str, ...] = ()
    notes: Tuple[str, ...] = ()
    trusted_rank: int = model_sources.UNTRUSTED_RANK
    is_network: bool = False
    # Bytes the user does not have to download: the primary file plus its
    # companion files (a snapshot folder already counts everything inside).
    total_bytes: int = 0
    # model_roots.is_under_allowed_model_root(path): the loaders' own rule.
    trusted: bool = False

    def to_dict(self) -> Dict[str, Any]:
        data = {f.name: getattr(self, f.name) for f in fields(self)}
        data["companions"] = list(self.companions)
        data["notes"] = list(self.notes)
        return data

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "ExternalMatch":
        known = {f.name for f in fields(cls)}
        values = {k: v for k, v in data.items() if k in known}
        values["companions"] = tuple(values.get("companions") or ())
        values["notes"] = tuple(values.get("notes") or ())
        return cls(**values)


@dataclass(frozen=True)
class RejectedCandidate:
    model_id: str
    variant: Optional[str]
    path: str
    source: str
    reason: str
    detail: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return {f.name: getattr(self, f.name) for f in fields(self)}


@dataclass
class MatchReport:
    matches: List[ExternalMatch] = field(default_factory=list)
    rejected: List[RejectedCandidate] = field(default_factory=list)

    def extend(self, other: "MatchReport") -> None:
        self.matches.extend(other.matches)
        self.rejected.extend(other.rejected)


class DigestCache(Protocol):
    def cached_digest(self, path: str, size: int, mtime_ns: int) -> Optional[str]: ...

    def remember_digest(
        self, path: str, size: int, mtime_ns: int, digest: str
    ) -> None: ...


@dataclass(frozen=True)
class _CandidateDir:
    path: Path
    folder: str  # what a suggestion would ask the user to trust


# ---------------------------------------------------------------------------
# File helpers
# ---------------------------------------------------------------------------


def _hash_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(_HASH_CHUNK), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _stat_file(path: Path) -> Optional[os.stat_result]:
    """stat of a regular, non-empty file (symlinks resolved); ``None`` otherwise."""
    try:
        if not path.is_file():
            return None
        result = path.stat()
    except OSError:
        return None
    return result if result.st_size > 0 else None


def _plain_children(folder: Path) -> List[Path]:
    """Entries that are not symlinks or junctions, sorted; empty on error."""
    try:
        with os.scandir(folder) as entries:
            return sorted(
                Path(e.path) for e in entries if not model_sources.is_reparse_entry(e)
            )
    except OSError:
        return []


def _under(path: str, base: str) -> bool:
    key = os.path.normcase(path)
    base_key = os.path.normcase(base)
    return key == base_key or key.startswith(base_key.rstrip(os.sep) + os.sep)


class _Context:
    """One root's matching state: read policy, hashing policy, digest cache, trust."""

    def __init__(
        self,
        root: SourceRoot,
        digest_cache: Optional[DigestCache],
        trust_check: Optional[TrustCheck] = None,
        network_allowed: bool = False,
    ) -> None:
        self.root = root
        self.cache = digest_cache
        self.trust_check = trust_check or model_roots.is_under_allowed_model_root
        self.network_allowed = network_allowed or root.is_network
        self._verdicts: Dict[str, Tuple[bool, bool]] = {}
        # Already resolved by the link gate: the root and its yaml folders.
        self.bases: List[str] = [root.path] + [
            p for paths in root.extra_model_paths.values() for p in paths
        ]

    # read policy ---------------------------------------------------------

    def judge(self, path: Path) -> Tuple[bool, bool]:
        """(readable, is_network) for a path under this root."""
        return model_source_paths.judge_path(
            self.bases,
            str(path),
            network_allowed=self.network_allowed,
            cache=self._verdicts,
        )

    def may_read(self, path: Path) -> bool:
        return self.judge(path)[0]

    def stat_file(self, path: Path) -> Optional[os.stat_result]:
        """stat only when the read policy allows it."""
        if not self.may_read(path):
            return None
        return _stat_file(path)

    def candidate_dirs(
        self,
        comfy_subdirs: Sequence[str],
        folder_subdirs: Sequence[str],
        extra_keys: Sequence[str],
    ) -> List[_CandidateDir]:
        base = Path(self.root.path)
        raw: List[_CandidateDir] = []
        if self.root.kind == KIND_COMFYUI:
            raw.extend(
                _CandidateDir(base / sub, self.root.path) for sub in comfy_subdirs
            )
            for key in extra_keys:
                raw.extend(
                    _CandidateDir(Path(p), p)
                    for p in self.root.extra_model_paths.get(key, ())
                )
        elif self.root.kind == KIND_FOLDER:
            raw.extend(
                _CandidateDir((base / sub) if sub else base, self.root.path)
                for sub in folder_subdirs
            )
        dirs: List[_CandidateDir] = []
        seen: set = set()
        for candidate in raw:
            key = os.path.normcase(str(candidate.path))
            if key in seen:
                continue
            resolved = self._candidate_folder(candidate)
            if resolved is None:
                continue
            seen.add(key)
            dirs.append(resolved)
        return dirs

    def _candidate_folder(self, candidate: _CandidateDir) -> Optional[_CandidateDir]:
        """The candidate through the link gate; its ``folder`` is the real folder
        a suggestion would ask the user to trust (a junction's target, not the
        junction)."""
        kind, real = model_source_paths.resolve_local_chain(str(candidate.path))
        if kind == model_source_paths.KIND_MISSING:
            return None
        if kind == model_source_paths.KIND_NETWORK and not self.network_allowed:
            return None
        try:
            if not candidate.path.is_dir():
                return None
        except OSError:
            return None
        folder = self.root.path if _under(real, self.root.path) else real
        return _CandidateDir(candidate.path, folder)

    # hashing -------------------------------------------------------------

    def sha256(self, path: Path, stat: os.stat_result) -> str:
        """Digest, from the cache when size and mtime match; raises OSError."""
        key = str(path)
        if self.cache is not None:
            cached = self.cache.cached_digest(key, stat.st_size, stat.st_mtime_ns)
            if cached:
                return cached
        digest = _hash_file(path)
        if self.cache is not None:
            self.cache.remember_digest(key, stat.st_size, stat.st_mtime_ns, digest)
        return digest

    def is_network_file(self, path: Path) -> bool:
        return self.root.is_network or self.judge(path)[1]

    def can_hash_model(
        self, path: Path, stat: os.stat_result
    ) -> Tuple[bool, Optional[str]]:
        if self.is_network_file(path):
            return False, "hash_skipped_network"
        if stat.st_size > SHA_LIMIT_BYTES:
            return False, "hash_skipped_large"
        return True, None

    def check_companion(
        self, path: Path, pins: Sequence[str]
    ) -> Tuple[Optional[str], str]:
        """(reason, detail) for a required companion file; reason ``None`` when fine."""
        stat = self.stat_file(path)
        if stat is None:
            return (
                REASON_MISSING_COMPANION,
                f"{path.name} is missing, empty or not readable next to the model",
            )
        if not pins or stat.st_size > COMPANION_HASH_LIMIT_BYTES:
            return None, ""
        try:
            digest = self.sha256(path, stat)
        except OSError as exc:
            return REASON_UNREADABLE, f"{path.name} could not be read: {exc}"
        if digest not in pins:
            return (
                REASON_COMPANION,
                f"{path.name} differs from the pinned file (sha256 {digest[:8]})",
            )
        return None, ""

    # results -------------------------------------------------------------

    def match(
        self,
        model_id: str,
        variant: Optional[str],
        path: Path,
        stat: os.stat_result,
        verify: str,
        companions: Iterable[str] = (),
        notes: Iterable[str] = (),
        folder: Optional[str] = None,
    ) -> ExternalMatch:
        companion_paths = tuple(companions)
        total = stat.st_size
        if path.is_file():
            for companion in companion_paths:
                companion_stat = _stat_file(Path(companion))
                if companion_stat is not None:
                    total += companion_stat.st_size
        return ExternalMatch(
            model_id=model_id,
            variant=variant,
            path=str(path),
            source=self.root.path,
            folder=folder or self.root.path,
            source_kind=self.root.kind,
            origin=self.root.origin,
            verify=verify,
            size_bytes=stat.st_size,
            mtime_ns=stat.st_mtime_ns,
            companions=companion_paths,
            notes=tuple(notes),
            trusted_rank=self.root.trusted_rank,
            is_network=self.is_network_file(path),
            total_bytes=total,
            trusted=self._is_trusted(path),
        )

    def _is_trusted(self, path: Path) -> bool:
        try:
            return bool(self.trust_check(str(path)))
        except Exception as exc:  # the loader rule must never take detection down
            logger.warning("Trust check failed for %s: %s", path, exc)
            return False

    def reject(
        self,
        model_id: str,
        variant: Optional[str],
        path: Path,
        reason: str,
        detail: str = "",
    ) -> RejectedCandidate:
        return RejectedCandidate(
            model_id=model_id,
            variant=variant,
            path=str(path),
            source=self.root.path,
            reason=reason,
            detail=detail,
        )


def _verify_pinned_file(
    ctx: _Context,
    path: Path,
    stat: os.stat_result,
    size_bytes: Optional[int],
    sha256: Optional[str],
) -> Tuple[Optional[str], str, List[str]]:
    """Size pin, then SHA pin when hashing is allowed. Returns (reason, detail, notes)."""
    if size_bytes is not None and stat.st_size != size_bytes:
        return (
            REASON_SIZE,
            f"{stat.st_size} bytes, pinned file is {size_bytes} bytes",
            [],
        )
    if not sha256:
        return None, "", []
    allowed, note = ctx.can_hash_model(path, stat)
    if not allowed:
        return None, "", [note] if note else []
    try:
        digest = ctx.sha256(path, stat)
    except OSError as exc:
        return REASON_UNREADABLE, f"{path.name} could not be read: {exc}", []
    if digest != sha256:
        return (
            REASON_SHA,
            f"sha256 {digest[:8]} differs from the pinned {sha256[:8]}",
            [],
        )
    return None, "", ["sha_verified"]


# ---------------------------------------------------------------------------
# WD14 family (TAGGER_MODELS entries on the WD14 runtime with a size pin)
# ---------------------------------------------------------------------------


def is_wd14_runtime_entry(entry: Mapping[str, Any]) -> bool:
    return (
        str(entry.get("runtime_backend") or WD14_RUNTIME_BACKEND)
        == WD14_RUNTIME_BACKEND
    )


def _wd14_entries() -> List[Tuple[str, Dict[str, Any]]]:
    return [
        (name, entry)
        for name, entry in TAGGER_MODELS.items()
        if entry.get("size_bytes") and is_wd14_runtime_entry(entry)
    ]


# ---------------------------------------------------------------------------
# Privacy YOLO and TIPO
# ---------------------------------------------------------------------------


def _files_with_suffix(
    ctx: _Context, folder: Path, suffixes: Sequence[str]
) -> List[Tuple[Path, os.stat_result]]:
    files: List[Tuple[Path, os.stat_result]] = []
    for path in _plain_children(folder):
        if path.suffix.lower() not in suffixes:
            continue
        stat = ctx.stat_file(path)
        if stat is not None:
            files.append((path, stat))
    return files


def match_privacy_yolo(ctx: _Context) -> MatchReport:
    from model_health_paths import _infer_yolo_model_profile

    report = MatchReport()
    for candidate in ctx.candidate_dirs(
        _YOLO_COMFY_SUBDIRS, _YOLO_FOLDER_SUBDIRS, _YOLO_EXTRA_KEYS
    ):
        for path, stat in _files_with_suffix(ctx, candidate.path, _YOLO_SUFFIXES):
            # Class names would need the ultralytics runtime; the file name is
            # the only evidence available without loading weights.
            profile = _infer_yolo_model_profile([], path.name)
            if profile.get("recommended_for_censor"):
                report.matches.append(
                    ctx.match(
                        "censor-legacy",
                        None,
                        path,
                        stat,
                        VERIFY_NAME,
                        notes=[profile["id"]],
                        folder=candidate.folder,
                    )
                )
            else:
                report.rejected.append(
                    ctx.reject(
                        "censor-legacy",
                        None,
                        path,
                        REASON_UNVERIFIED,
                        "classes not checked; choose it by hand if it is a privacy-part detector",
                    )
                )
    return report


def _tipo_pin_for(path: Path) -> Optional[Tuple[str, FilePin]]:
    """The pinned build a file name claims to be (exact, or kgen's ``<repo>_<file>`` naming)."""
    for variant, pin in TIPO_FILE_PINS.items():
        if path.name == pin.filename or path.name.endswith("_" + pin.filename):
            return variant, pin
    return None


def match_tipo(ctx: _Context) -> MatchReport:
    report = MatchReport()
    expected = ", ".join(p.filename for p in TIPO_FILE_PINS.values())
    for candidate in ctx.candidate_dirs(
        _TIPO_COMFY_SUBDIRS, _TIPO_FOLDER_SUBDIRS, _TIPO_EXTRA_KEYS
    ):
        for path, stat in _files_with_suffix(ctx, candidate.path, (".gguf",)):
            if "tipo" not in path.name.lower():
                continue
            claimed = _tipo_pin_for(path)
            if claimed is None:
                report.rejected.append(
                    ctx.reject(
                        "tipo",
                        None,
                        path,
                        REASON_VERSION,
                        f"not the pinned {expected} build ({stat.st_size} bytes)",
                    )
                )
                continue
            variant, pin = claimed
            reason, detail, notes = _verify_pinned_file(
                ctx, path, stat, pin.size_bytes, pin.sha256
            )
            if reason == REASON_SIZE:
                reason, detail = (
                    REASON_VERSION,
                    f"named like {pin.filename} but {detail}",
                )
            if reason:
                report.rejected.append(
                    ctx.reject("tipo", variant, path, reason, detail)
                )
                continue
            verify = VERIFY_SHA if "sha_verified" in notes else VERIFY_SIZE
            report.matches.append(
                ctx.match(
                    "tipo",
                    variant,
                    path,
                    stat,
                    verify,
                    notes=notes,
                    folder=candidate.folder,
                )
            )
    return report


# ---------------------------------------------------------------------------
# Entry points
# ---------------------------------------------------------------------------


def match_hf_cache(ctx: _Context) -> MatchReport:
    from model_matchers_hf import (
        match_hf_cache as _match,
    )  # split module; imports this one

    return _match(ctx)


def _run_matcher(
    matcher: Callable[[_Context], MatchReport], ctx: _Context, report: MatchReport
) -> None:
    try:
        report.extend(matcher(ctx))
    except Exception as exc:  # one broken folder must not hide the others
        logger.warning("%s failed under %s: %s", matcher.__name__, ctx.root.path, exc)


def match_root(
    root: SourceRoot,
    *,
    digest_cache: Optional[DigestCache] = None,
    trust_check: Optional[TrustCheck] = None,
    network_allowed: bool = False,
) -> MatchReport:
    """Every match and rejection inside one root.

    ``trust_check`` defaults to ``model_roots.is_under_allowed_model_root``;
    ``network_allowed`` is set only by the background pass over network roots.
    """
    ctx = _Context(root, digest_cache, trust_check, network_allowed)
    report = MatchReport()
    if root.kind == KIND_HF_CACHE:
        _run_matcher(match_hf_cache, ctx, report)
        return report
    from model_matchers_tagger import match_kaloscope, match_wd14  # split module

    for matcher in (match_wd14, match_kaloscope, match_privacy_yolo, match_tipo):
        _run_matcher(matcher, ctx, report)
    if root.kind == KIND_FOLDER and model_sources._looks_like_hf_cache(Path(root.path)):
        _run_matcher(match_hf_cache, ctx, report)
    return report


def _sort_key(match: ExternalMatch) -> Tuple[int, int, int, str]:
    return (
        match.trusted_rank,
        _VERIFY_RANK.get(match.verify, 9),
        1 if match.is_network else 0,
        os.path.normcase(match.path),
    )


def select_best(matches: Iterable[ExternalMatch]) -> List[ExternalMatch]:
    """One copy per (model_id, variant): trusted order, then sha/revision > size > name, then local disk, then path."""
    chosen: Dict[Tuple[str, Optional[str]], ExternalMatch] = {}
    for match in sorted(matches, key=_sort_key):
        chosen.setdefault((match.model_id, match.variant), match)
    return list(chosen.values())
