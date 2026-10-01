"""Which files in a source root are the exact models this program pins (MS1a).

One matcher per model family. Each returns ``ExternalMatch`` rows (adopt
this file) and ``RejectedCandidate`` rows (looks related, but is not the
pinned model, so the Model Center can say *why* instead of staying silent).

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
"""

from __future__ import annotations

import hashlib
import logging
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Protocol, Sequence, Tuple

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

# Kaloscope 2.0 checkpoint (HF HEAD 2026-10-01: X-Linked-Size / X-Linked-ETag).
KALOSCOPE_CHECKPOINT_SIZE_BYTES = 2_937_892_740
KALOSCOPE_CHECKPOINT_SHA256 = (
    "a86ba2fcf430cbb653ac995f7ab9cce34667434ee084973e19edf431808a32ae"
)
KALOSCOPE_CHECKPOINT_NAME = "best_checkpoint.pth"
KALOSCOPE_CLASS_MAPPING_NAME = "class_mapping.csv"
KALOSCOPE_VARIANT = "kaloscope2.0"


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


@dataclass(frozen=True)
class ExternalMatch:
    model_id: str
    variant: Optional[str]
    path: str
    source: str
    source_kind: str
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

    def to_dict(self) -> Dict[str, Any]:
        return {
            "model_id": self.model_id,
            "variant": self.variant,
            "path": self.path,
            "source": self.source,
            "source_kind": self.source_kind,
            "verify": self.verify,
            "size_bytes": self.size_bytes,
            "total_bytes": self.total_bytes,
            "mtime_ns": self.mtime_ns,
            "companions": list(self.companions),
            "notes": list(self.notes),
            "is_network": self.is_network,
        }


@dataclass(frozen=True)
class RejectedCandidate:
    model_id: str
    variant: Optional[str]
    path: str
    source: str
    reason: str
    detail: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return {
            "model_id": self.model_id,
            "variant": self.variant,
            "path": self.path,
            "source": self.source,
            "reason": self.reason,
            "detail": self.detail,
        }


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


class _Context:
    """One root's matching state: hashing policy and the digest cache."""

    def __init__(self, root: SourceRoot, digest_cache: Optional[DigestCache]) -> None:
        self.root = root
        self.cache = digest_cache

    def sha256(self, path: Path, stat: os.stat_result) -> str:
        key = str(path)
        if self.cache is not None:
            cached = self.cache.cached_digest(key, stat.st_size, stat.st_mtime_ns)
            if cached:
                return cached
        digest = _hash_file(path)
        if self.cache is not None:
            self.cache.remember_digest(key, stat.st_size, stat.st_mtime_ns, digest)
        return digest

    def can_hash_model(self, stat: os.stat_result) -> Tuple[bool, Optional[str]]:
        if self.root.is_network:
            return False, "hash_skipped_network"
        if stat.st_size > SHA_LIMIT_BYTES:
            return False, "hash_skipped_large"
        return True, None

    def check_companion(
        self, path: Path, pins: Sequence[str]
    ) -> Tuple[Optional[str], str]:
        """(reason, detail) for a required companion file; reason ``None`` when fine."""
        stat = _stat_file(path)
        if stat is None:
            return (
                REASON_MISSING_COMPANION,
                f"{path.name} is missing or empty next to the model",
            )
        if not pins or stat.st_size > COMPANION_HASH_LIMIT_BYTES:
            return None, ""
        digest = self.sha256(path, stat)
        if digest not in pins:
            return (
                REASON_COMPANION,
                f"{path.name} differs from the pinned file (sha256 {digest[:8]})",
            )
        return None, ""

    def candidate_dirs(
        self,
        comfy_subdirs: Sequence[str],
        folder_subdirs: Sequence[str],
        extra_keys: Sequence[str],
    ) -> List[Path]:
        base = Path(self.root.path)
        raw: List[Path] = []
        if self.root.kind == KIND_COMFYUI:
            raw.extend(base / sub for sub in comfy_subdirs)
            for key in extra_keys:
                raw.extend(Path(p) for p in self.root.extra_model_paths.get(key, ()))
        elif self.root.kind == KIND_FOLDER:
            raw.extend((base / sub) if sub else base for sub in folder_subdirs)
        dirs: List[Path] = []
        seen: set = set()
        for folder in raw:
            key = os.path.normcase(str(folder))
            if key in seen or not folder.is_dir():
                continue
            seen.add(key)
            dirs.append(folder)
        return dirs

    def match(
        self,
        model_id: str,
        variant: Optional[str],
        path: Path,
        stat: os.stat_result,
        verify: str,
        companions: Iterable[str] = (),
        notes: Iterable[str] = (),
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
            source_kind=self.root.kind,
            verify=verify,
            size_bytes=stat.st_size,
            mtime_ns=stat.st_mtime_ns,
            companions=companion_paths,
            notes=tuple(notes),
            trusted_rank=self.root.trusted_rank,
            is_network=self.root.is_network,
            total_bytes=total,
        )

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
    allowed, note = ctx.can_hash_model(stat)
    if not allowed:
        return None, "", [note] if note else []
    digest = ctx.sha256(path, stat)
    if digest != sha256:
        return (
            REASON_SHA,
            f"sha256 {digest[:8]} differs from the pinned {sha256[:8]}",
            [],
        )
    return None, "", ["sha_verified"]


# ---------------------------------------------------------------------------
# WD14 family (TAGGER_MODELS entries with a size pin)
# ---------------------------------------------------------------------------


def _wd14_layouts(
    folder: Path, variant: str, entry: Dict[str, Any]
) -> List[Tuple[Path, Path, Dict[str, Path]]]:
    """(model, tags, external-data) candidates: ComfyUI flat ``<variant>.onnx`` and app ``<variant>/<model_file>``."""
    model_file = str(entry.get("model_file") or "")
    tags_file = str(entry.get("tags_file") or "")
    external = {
        name: folder / variant / name for name in entry.get("external_data_files") or ()
    }
    layouts: List[Tuple[Path, Path, Dict[str, Path]]] = []
    if model_file and tags_file:
        layouts.append(
            (folder / variant / model_file, folder / variant / tags_file, external)
        )
    if model_file.endswith(".onnx") and tags_file.endswith(".csv") and not external:
        layouts.append((folder / f"{variant}.onnx", folder / f"{variant}.csv", {}))
    return layouts


def _wd14_entries() -> List[Tuple[str, Dict[str, Any]]]:
    return [
        (name, entry)
        for name, entry in TAGGER_MODELS.items()
        if entry.get("size_bytes")
    ]


def match_wd14(ctx: _Context) -> MatchReport:
    report = MatchReport()
    folders = ctx.candidate_dirs(
        _WD14_COMFY_SUBDIRS, _WD14_FOLDER_SUBDIRS, _WD14_EXTRA_KEYS
    )
    for folder in folders:
        for variant, entry in _wd14_entries():
            for model_path, tags_path, external in _wd14_layouts(
                folder, variant, entry
            ):
                stat = _stat_file(model_path)
                if stat is None:
                    continue
                _match_wd14_file(
                    ctx, report, variant, entry, model_path, stat, tags_path, external
                )
    return report


def _match_wd14_file(
    ctx: _Context,
    report: MatchReport,
    variant: str,
    entry: Dict[str, Any],
    model_path: Path,
    stat: os.stat_result,
    tags_path: Path,
    external: Dict[str, Path],
) -> None:
    reason, detail, notes = _verify_pinned_file(
        ctx, model_path, stat, entry.get("size_bytes"), entry.get("sha256")
    )
    if reason:
        report.rejected.append(ctx.reject("wd14", variant, model_path, reason, detail))
        return
    tags_pin = entry.get("tags_sha256")
    reason, detail = ctx.check_companion(tags_path, (tags_pin,) if tags_pin else ())
    if reason:
        report.rejected.append(ctx.reject("wd14", variant, model_path, reason, detail))
        return
    companions = [str(tags_path)]
    pins = entry.get("external_data_pins") or {}
    for name, path in external.items():
        ext_stat = _stat_file(path)
        if ext_stat is None:
            report.rejected.append(
                ctx.reject(
                    "wd14",
                    variant,
                    model_path,
                    REASON_MISSING_COMPANION,
                    f"{name} is missing",
                )
            )
            return
        pin = pins.get(name) or {}
        ext_reason, ext_detail, ext_notes = _verify_pinned_file(
            ctx, path, ext_stat, pin.get("size_bytes"), pin.get("sha256")
        )
        if ext_reason:
            report.rejected.append(
                ctx.reject(
                    "wd14", variant, model_path, ext_reason, f"{name}: {ext_detail}"
                )
            )
            return
        notes.extend(f"{name}:{n}" for n in ext_notes)
        companions.append(str(path))
    verify = VERIFY_SHA if "sha_verified" in notes else VERIFY_SIZE
    report.matches.append(
        ctx.match("wd14", variant, model_path, stat, verify, companions, notes)
    )


# ---------------------------------------------------------------------------
# Kaloscope 2.0 (artist)
# ---------------------------------------------------------------------------


def _walk_for_name(folder: Path, name: str, depth: int) -> List[Path]:
    found: List[Path] = []
    try:
        children = sorted(folder.iterdir())
    except OSError:
        return found
    for child in children:
        if child.name == name and _stat_file(child) is not None:
            found.append(child)
        elif depth > 0 and child.is_dir() and not child.name.startswith("."):
            found.extend(_walk_for_name(child, name, depth - 1))
    return found


def read_git_head_commit(repo: Path) -> Optional[str]:
    """The commit a checkout is at, from ``.git/HEAD`` (direct, loose ref or packed-refs)."""
    git_dir = repo / ".git"
    try:
        head = (git_dir / "HEAD").read_text(encoding="utf-8").strip()
    except OSError:
        return None
    if not head.startswith("ref:"):
        return head.lower() if len(head) == 40 else None
    ref = head[4:].strip()
    try:
        return (git_dir / ref).read_text(encoding="utf-8").strip().lower()
    except OSError:
        pass
    try:
        for line in (git_dir / "packed-refs").read_text(encoding="utf-8").splitlines():
            parts = line.strip().split()
            if len(parts) == 2 and parts[1] == ref:
                return parts[0].lower()
    except OSError:
        return None
    return None


def _kaloscope_runtime(ctx: _Context) -> Tuple[Optional[Path], str]:
    import artist_identifier

    base = Path(ctx.root.path)
    candidates = (
        [base / "custom_nodes" / "comfyui-lsnet"]
        if ctx.root.kind == KIND_COMFYUI
        else [base / "comfyui-lsnet", base / "comfyui-lsnet-runtime"]
    )
    for runtime in candidates:
        if not (runtime / "lsnet_model").is_dir():
            continue
        commit = read_git_head_commit(runtime)
        if commit == artist_identifier.ARTIST_LSNET_RUNTIME_REVISION.lower():
            return runtime, "runtime_revision_verified"
        return runtime, "runtime_revision_unverified"
    return None, "runtime_missing"


def match_kaloscope(ctx: _Context) -> MatchReport:
    import artist_identifier

    report = MatchReport()
    folders = ctx.candidate_dirs(
        _KALOSCOPE_COMFY_SUBDIRS, _KALOSCOPE_FOLDER_SUBDIRS, _KALOSCOPE_EXTRA_KEYS
    )
    mapping_pins = tuple(
        artist_identifier._EXPECTED_ARTIST_FILE_SHA256.get(
            KALOSCOPE_CLASS_MAPPING_NAME, ()
        )
    )
    seen: set = set()
    for folder in folders:
        for checkpoint in _walk_for_name(
            folder, KALOSCOPE_CHECKPOINT_NAME, _KALOSCOPE_WALK_DEPTH
        ):
            key = os.path.normcase(str(checkpoint))
            if key in seen:
                continue
            seen.add(key)
            stat = _stat_file(checkpoint)
            if stat is None:
                continue
            reason, detail, notes = _verify_pinned_file(
                ctx,
                checkpoint,
                stat,
                KALOSCOPE_CHECKPOINT_SIZE_BYTES,
                KALOSCOPE_CHECKPOINT_SHA256,
            )
            if reason:
                report.rejected.append(
                    ctx.reject("artist", KALOSCOPE_VARIANT, checkpoint, reason, detail)
                )
                continue
            mapping = next(
                (
                    p
                    for p in (
                        checkpoint.parent / KALOSCOPE_CLASS_MAPPING_NAME,
                        checkpoint.parent.parent / KALOSCOPE_CLASS_MAPPING_NAME,
                    )
                    if _stat_file(p) is not None
                ),
                checkpoint.parent / KALOSCOPE_CLASS_MAPPING_NAME,
            )
            reason, detail = ctx.check_companion(mapping, mapping_pins)
            if reason:
                report.rejected.append(
                    ctx.reject("artist", KALOSCOPE_VARIANT, checkpoint, reason, detail)
                )
                continue
            runtime, runtime_note = _kaloscope_runtime(ctx)
            companions = [str(mapping)] + ([str(runtime)] if runtime else [])
            verify = VERIFY_SHA if "sha_verified" in notes else VERIFY_SIZE
            report.matches.append(
                ctx.match(
                    "artist",
                    KALOSCOPE_VARIANT,
                    checkpoint,
                    stat,
                    verify,
                    companions,
                    notes + [runtime_note],
                )
            )
    return report


# ---------------------------------------------------------------------------
# Privacy YOLO and TIPO
# ---------------------------------------------------------------------------


def match_privacy_yolo(ctx: _Context) -> MatchReport:
    from model_health_paths import _infer_yolo_model_profile

    report = MatchReport()
    for folder in ctx.candidate_dirs(
        _YOLO_COMFY_SUBDIRS, _YOLO_FOLDER_SUBDIRS, _YOLO_EXTRA_KEYS
    ):
        try:
            files = sorted(
                p for p in folder.iterdir() if p.suffix.lower() in _YOLO_SUFFIXES
            )
        except OSError:
            continue
        for path in files:
            stat = _stat_file(path)
            if stat is None:
                continue
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


def match_tipo(ctx: _Context) -> MatchReport:
    report = MatchReport()
    for folder in ctx.candidate_dirs(
        _TIPO_COMFY_SUBDIRS, _TIPO_FOLDER_SUBDIRS, _TIPO_EXTRA_KEYS
    ):
        try:
            files = sorted(
                p
                for p in folder.iterdir()
                if p.suffix.lower() == ".gguf" and "tipo" in p.name.lower()
            )
        except OSError:
            continue
        for path in files:
            stat = _stat_file(path)
            if stat is None:
                continue
            for variant, pin in TIPO_FILE_PINS.items():
                name_ok = path.name == pin.filename or path.name.endswith(
                    "_" + pin.filename
                )
                if name_ok and stat.st_size == pin.size_bytes:
                    _, _, notes = _verify_pinned_file(
                        ctx, path, stat, pin.size_bytes, pin.sha256
                    )
                    verify = VERIFY_SHA if "sha_verified" in notes else VERIFY_SIZE
                    report.matches.append(
                        ctx.match("tipo", variant, path, stat, verify, notes=notes)
                    )
                    break
            else:
                report.rejected.append(
                    ctx.reject(
                        "tipo",
                        None,
                        path,
                        REASON_VERSION,
                        f"not the pinned {', '.join(p.filename for p in TIPO_FILE_PINS.values())} build ({stat.st_size} bytes)",
                    )
                )
    return report


# ---------------------------------------------------------------------------
# Entry points
# ---------------------------------------------------------------------------


def match_root(
    root: SourceRoot, *, digest_cache: Optional[DigestCache] = None
) -> MatchReport:
    """Every match and rejection inside one root."""
    ctx = _Context(root, digest_cache)
    report = MatchReport()
    from model_matchers_hf import match_hf_cache  # split module; imports this one

    if root.kind == KIND_HF_CACHE:
        report.extend(match_hf_cache(ctx))
        return report
    for matcher in (match_wd14, match_kaloscope, match_privacy_yolo, match_tipo):
        try:
            report.extend(matcher(ctx))
        except Exception as exc:  # one broken folder must not hide the others
            logger.warning("%s failed under %s: %s", matcher.__name__, root.path, exc)
    if root.kind == KIND_FOLDER and model_sources._looks_like_hf_cache(Path(root.path)):
        report.extend(match_hf_cache(ctx))
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
