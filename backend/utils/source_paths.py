"""
Helpers for resolving indexed source image paths across Windows and POSIX runtimes.
"""
import os
import re
from pathlib import PurePosixPath, PureWindowsPath
from typing import List, Optional

from utils.path_validation import normalize_user_path, translate_windows_drive_path_to_posix


WINDOWS_DRIVE_PATH_RE = re.compile(r"^[A-Za-z]:(?:[\\/]|$)")
POSIX_MNT_DRIVE_PATH_RE = re.compile(r"^/mnt/([A-Za-z])(?:/(.*))?$")


def _looks_windows_style_path(raw_path: str) -> bool:
    text = str(raw_path or "").strip()
    return bool(WINDOWS_DRIVE_PATH_RE.match(text) or text.startswith("\\\\"))


def _is_indexed_absolute_path(raw_path: str) -> bool:
    text = str(raw_path or "").strip()
    if not text:
        return False
    return text.startswith("/") or _looks_windows_style_path(text) or os.path.isabs(text)


def _normalize_windows_style_path(raw_path: str) -> str:
    pure_path = PureWindowsPath(str(raw_path or "").strip())
    if pure_path.drive and len(pure_path.drive) == 2 and pure_path.drive[1] == ":":
        anchor = f"{pure_path.drive[0].upper()}:{pure_path.root}"
        return str(PureWindowsPath(anchor or pure_path.drive.upper(), *pure_path.parts[1:]))
    return str(pure_path)


def _paths_match_for_runtime(candidate_path: str, real_path: str) -> bool:
    """Compare runtime paths without treating Windows case normalization as a symlink."""
    return os.path.normcase(os.path.normpath(real_path)) == os.path.normcase(os.path.normpath(candidate_path))


def translate_posix_mnt_path_to_windows_drive(raw_path: str) -> Optional[str]:
    """Translate /mnt/<drive>/... paths back to a Windows drive path."""
    text = str(raw_path or "").strip().replace("\\", "/")
    if not text:
        return None

    match = POSIX_MNT_DRIVE_PATH_RE.match(text)
    if not match:
        return None

    drive = match.group(1).upper()
    remainder = match.group(2) or ""
    parts = [part for part in remainder.split("/") if part]
    return str(PureWindowsPath(f"{drive}:\\", *parts))


def normalize_indexed_image_path(path: Optional[str]) -> str:
    """Normalize stored image paths without rewriting them to the current host style."""
    text = str(path or "").strip()
    if not text:
        return text

    if _looks_windows_style_path(text):
        return _normalize_windows_style_path(text)

    normalized = text.replace("\\", "/")
    return str(PurePosixPath(normalized))


def is_case_insensitive_indexed_path(path: Optional[str]) -> bool:
    """Return True when the indexed path represents a Windows-style location."""
    normalized = normalize_indexed_image_path(path)
    if not normalized:
        return False
    return _looks_windows_style_path(normalized) or bool(translate_posix_mnt_path_to_windows_drive(normalized))


def indexed_image_path_match_key(path: Optional[str]) -> str:
    """Build a lookup key that folds Windows-path case without mutating stored rows."""
    normalized = normalize_indexed_image_path(path)
    if not normalized:
        return normalized
    if is_case_insensitive_indexed_path(normalized):
        return normalized.lower()
    return normalized


def build_indexed_image_lookup_candidates(primary_path: str) -> List[str]:
    """Build equivalent stored-path candidates for cross-runtime DB lookups."""
    normalized_primary = normalize_indexed_image_path(primary_path)
    if not normalized_primary:
        return []

    candidates: List[str] = []
    seen: set[str] = set()

    def add(candidate: Optional[str]) -> None:
        normalized_candidate = normalize_indexed_image_path(candidate)
        match_key = indexed_image_path_match_key(normalized_candidate)
        if not normalized_candidate or match_key in seen:
            return
        seen.add(match_key)
        candidates.append(normalized_candidate)

    add(normalized_primary)

    translated_posix = translate_windows_drive_path_to_posix(normalized_primary)
    if translated_posix:
        add(translated_posix)

    translated_windows = translate_posix_mnt_path_to_windows_drive(normalized_primary)
    if translated_windows:
        add(translated_windows)

    if _looks_windows_style_path(normalized_primary):
        add(normalized_primary.replace("\\", "/"))
    elif "/" in normalized_primary and not normalized_primary.startswith("/"):
        add(normalized_primary.replace("/", "\\"))

    raw_path = str(primary_path or "").strip()
    if raw_path and raw_path != normalized_primary:
        add(raw_path)

    return candidates


def build_indexed_image_path_candidates(primary_path: str, *, backend_file: str) -> List[str]:
    """Build candidate filesystem paths for an indexed image source."""
    normalized_primary = normalize_indexed_image_path(primary_path)
    if not normalized_primary:
        return []

    candidates: List[str] = []
    seen: set[str] = set()

    def add(candidate: Optional[str]) -> None:
        text = str(candidate or "").strip()
        if not text:
            return
        key = indexed_image_path_match_key(text)
        if key in seen:
            return
        seen.add(key)
        candidates.append(text)

    for candidate in build_indexed_image_lookup_candidates(normalized_primary):
        add(candidate)

    backend_root = os.path.dirname(os.path.dirname(os.path.abspath(backend_file)))
    project_root = os.path.dirname(backend_root)
    absoluteish = _is_indexed_absolute_path(normalized_primary)
    if not absoluteish:
        relative_path = normalized_primary
        add(os.path.join(backend_root, relative_path))
        add(os.path.join(project_root, relative_path))
    else:
        # Older rows may have been absolutized from the wrong working directory.
        # When that happens, try swapping between project-root-relative and
        # backend-root-relative layouts before giving up.
        for absolute_candidate in build_indexed_image_lookup_candidates(normalized_primary):
            runtime_candidate = normalize_user_path(absolute_candidate)
            if not runtime_candidate or not os.path.isabs(runtime_candidate):
                continue

            candidate_path = os.path.abspath(runtime_candidate)
            try:
                relative_to_project = os.path.relpath(candidate_path, project_root)
                if not relative_to_project.startswith(".."):
                    add(os.path.join(backend_root, relative_to_project))
            except ValueError:
                pass

            try:
                relative_to_backend = os.path.relpath(candidate_path, backend_root)
                if not relative_to_backend.startswith(".."):
                    add(os.path.join(project_root, relative_to_backend))
            except ValueError:
                pass

    return candidates


def resolve_existing_indexed_image_path(
    primary_path: str,
    *,
    backend_file: str,
    allow_symlink: bool = False,
) -> Optional[str]:
    """Resolve an indexed image path to an existing absolute path."""
    for candidate in build_indexed_image_path_candidates(primary_path, backend_file=backend_file):
        try:
            candidate_path = os.path.abspath(normalize_user_path(candidate))
            if not os.path.exists(candidate_path):
                continue
            if not allow_symlink:
                if os.path.islink(candidate_path):
                    continue
                if not _paths_match_for_runtime(candidate_path, os.path.realpath(candidate_path)):
                    continue
            return candidate_path
        except OSError:
            continue
    return None
