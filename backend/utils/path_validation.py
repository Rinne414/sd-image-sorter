"""
Path validation utilities for secure file operations.
Prevents directory traversal attacks and validates file paths.
"""
import os
import re
from dataclasses import dataclass
from pathlib import Path, PureWindowsPath
from typing import Optional, Tuple
from urllib.parse import unquote

from config import (
    MAX_PATH_DEPTH,
    MAX_PATH_LENGTH,
    MAX_FILENAME_LENGTH,
    ALLOWED_IMAGE_EXTENSIONS,  # noqa: F401  re-exported for image_service/sorting/etc.
    ALLOWED_MODEL_EXTENSIONS,  # noqa: F401  re-exported for model/download consumers
)


# Suspicious patterns for directory traversal and injection attacks
# Note: We don't check for ':' here because Windows drive letters (C:\) use it
SUSPICIOUS_PATTERNS = [
    r'[\x00-\x1f]',    # Control characters including null byte
    r'[\x7f-\x9f]',    # Extended control characters
    r'^\s+$',          # Whitespace-only
    r'^\.+$',          # Dot-only names (., .., ...)
]

# Invalid characters for filename components (not full paths)
INVALID_FILENAME_CHARS = r'[<>:"|?*]'
SUPPORTED_OUTPUT_IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp"}
WINDOWS_DRIVE_PATH_RE = re.compile(r"^[A-Za-z]:[\\/]")


class PathValidationError(ValueError):
    """Raised when a requested file path fails security validation."""


@dataclass(frozen=True)
class ImageOutputPath:
    """Validated destination for writing an image file."""

    path: Path
    parent: Path
    extension: str
    exists: bool


def translate_windows_drive_path_to_posix(raw_path: str) -> Optional[str]:
    """
    Map a Windows drive path to /mnt/<drive>/... when running on non-Windows systems.

    This keeps WSL users from having valid Windows paths rejected or treated as
    relative filenames on POSIX.
    """
    if os.name == "nt":
        return None

    text = str(raw_path or "").strip()
    if not WINDOWS_DRIVE_PATH_RE.match(text):
        return None

    try:
        windows_path = PureWindowsPath(text)
    except Exception:
        return None

    drive = windows_path.drive.rstrip(":")
    if len(drive) != 1 or not drive.isalpha():
        return None

    parts = [part for part in windows_path.parts[1:] if part not in ("\\", "/")]
    return os.path.join("/mnt", drive.lower(), *parts)


def normalize_user_path(path: Optional[str]) -> str:
    """Normalize user-entered paths so the rest of validation sees a real filesystem path."""
    text = str(path or "").strip()
    if not text:
        return text

    translated = translate_windows_drive_path_to_posix(text)
    return translated or text


def _extract_path_leaf(path_str: str) -> str:
    """Return the last real path segment, handling both POSIX and Windows separators."""
    text = str(path_str or "").strip()
    if re.fullmatch(r"[A-Za-z]:[\\/]*", text):
        return ""

    parts = [part for part in re.split(r"[\\/]+", text) if part]
    return parts[-1] if parts else ""


def _contains_suspicious_patterns(path_str: str) -> bool:
    """
    Check if a path string contains suspicious patterns.

    Checks for directory traversal and injection attacks, but NOT Windows
    drive letter colons which are valid in full paths.

    Args:
        path_str: The path string to check

    Returns:
        True if suspicious patterns found, False otherwise
    """
    variants = []
    candidate = str(path_str or "")
    for _ in range(3):
        if candidate in variants:
            break
        variants.append(candidate)
        candidate = unquote(candidate)

    for value in variants:
        for pattern in SUSPICIOUS_PATTERNS:
            if re.search(pattern, value):
                return True

        normalized = value.replace("\\", "/")
        parts = [part for part in normalized.split("/") if part not in ("", ".")]
        if any(part == ".." for part in parts):
            return True
    return False


def _contains_invalid_filename_chars(path_str: str) -> bool:
    """
    Check if the filename component contains invalid characters.

    This checks only the filename part, not the full path, so Windows
    drive letters like 'C:' are not flagged.

    Args:
        path_str: The path string to check

    Returns:
        True if filename contains invalid characters, False otherwise
    """
    filename = _extract_path_leaf(path_str)
    if not filename:
        return False

    # Check for invalid characters in the filename only
    if re.search(INVALID_FILENAME_CHARS, filename):
        return True
    return False


def _is_same_or_subpath(parent: Path, child: Path) -> bool:
    """
    Check if child is the same as parent or is a subdirectory of parent.
    Uses proper path comparison, not string prefix matching.

    Args:
        parent: The parent directory path
        child: The child path to check

    Returns:
        True if child is parent or is inside parent, False otherwise
    """
    try:
        parent_resolved = parent.resolve()
        child_resolved = child.resolve()

        # Check if they are the same path
        if parent_resolved == child_resolved:
            return True

        # Check if child is a descendant of parent
        # This uses Path.parents which is a sequence of ancestor paths
        return parent_resolved in child_resolved.parents
    except (ValueError, OSError):
        return False


def _validate_path_depth(path: Path) -> bool:
    """
    Check if a path exceeds the maximum allowed depth.

    Args:
        path: The path to check

    Returns:
        True if path depth is acceptable, False otherwise
    """
    try:
        parts = path.parts
        return len(parts) <= MAX_PATH_DEPTH
    except (ValueError, OSError):
        return False


def _validate_symlink_target(path: Path, allowed_base: Optional[Path] = None) -> bool:
    """
    Validate that a symlink target is safe.

    Args:
        path: The path to check (may be a symlink)
        allowed_base: If provided, symlink target must be within this base

    Returns:
        True if symlink is safe or not a symlink, False otherwise
    """
    try:
        if not path.exists():
            return True

        if path.is_symlink():
            # Resolve the symlink target
            target = path.resolve()

            # If we have an allowed base, check the target is within it
            if allowed_base is not None:
                allowed_resolved = allowed_base.resolve()
                return _is_same_or_subpath(allowed_resolved, target)

            # Without a base, just ensure the target exists and is accessible
            return target.exists()

        return True
    except (ValueError, OSError):
        return False


def is_safe_path(base_path: str, user_path: str) -> bool:
    """
    Check if a user-provided path is safely within the base path.
    Prevents directory traversal attacks like '../../../etc/passwd'.

    Args:
        base_path: The allowed base directory
        user_path: The user-provided path to validate

    Returns:
        True if path is safe, False otherwise
    """
    if not base_path or not user_path:
        return False

    # Check for suspicious patterns in the raw user input
    if _contains_suspicious_patterns(user_path):
        return False

    # Check for invalid characters in filename component
    if _contains_invalid_filename_chars(user_path):
        return False

    try:
        base = Path(normalize_user_path(base_path)).resolve()
        target = Path(normalize_user_path(user_path))

        # Check path depth before resolving
        if not _validate_path_depth(target):
            return False

        # Now resolve the target
        target_resolved = target.resolve()

        # Use proper path comparison instead of string prefix
        if not _is_same_or_subpath(base, target_resolved):
            return False

        # Validate symlink target if applicable
        if target.exists() and target.is_symlink():
            if not _validate_symlink_target(target, base):
                return False

        return True
    except (ValueError, OSError):
        return False


def validate_folder_path(
    path: str,
    allow_create: bool = False,
    allowed_base: Optional[str] = None
) -> Tuple[bool, Optional[str]]:
    """
    Validate that a folder path is safe and exists (or can be created).

    Args:
        path: The folder path to validate
        allow_create: If True, the folder doesn't need to exist
        allowed_base: If provided, path must be within this base directory

    Returns:
        Tuple of (is_valid, error_message)
    """
    if not path or not isinstance(path, str):
        return False, "Path cannot be empty"

    # Check for suspicious patterns (directory traversal, control chars)
    if _contains_suspicious_patterns(path):
        return False, "Path contains invalid or suspicious characters"

    # Check for invalid characters in filename component (but allow Windows drive letters)
    if _contains_invalid_filename_chars(path):
        return False, "Path contains invalid filename characters"

    # Check path length before processing
    if len(path) > MAX_PATH_LENGTH:
        return False, f"Path exceeds maximum length of {MAX_PATH_LENGTH} characters"

    # Resolve to absolute path
    try:
        normalized_path = normalize_user_path(path)
        path_obj = Path(normalized_path)
    except (ValueError, OSError) as e:
        return False, f"Invalid path format: {str(e)}"

    # Check path depth
    if not _validate_path_depth(path_obj):
        return False, f"Path depth exceeds maximum of {MAX_PATH_DEPTH}"

    try:
        resolved = path_obj.resolve()
    except (ValueError, OSError) as e:
        return False, f"Cannot resolve path: {str(e)}"

    # Check resolved path length
    resolved_str = str(resolved)
    if len(resolved_str) > MAX_PATH_LENGTH:
        return False, f"Resolved path exceeds maximum length of {MAX_PATH_LENGTH} characters"

    # If allowed_base is specified, verify the path is within it
    if allowed_base:
        try:
            base_resolved = Path(normalize_user_path(allowed_base)).resolve()
            if not _is_same_or_subpath(base_resolved, resolved):
                return False, "Path is outside allowed directory"
        except (ValueError, OSError) as e:
            return False, f"Invalid base directory: {str(e)}"

    if allow_create:
        # Check if parent directory exists or can be created
        parent = resolved.parent
        if not parent.exists():
            # Walk up to find the first existing ancestor
            current = parent
            while current != current.parent:  # Stop at root
                if current.exists():
                    # Found existing ancestor, verify it's a directory
                    if not current.is_dir():
                        return False, f"Ancestor path '{current}' is not a directory"
                    break
                current = current.parent
            else:
                # Reached root without finding existing path
                # Check if root exists (e.g., drive letter on Windows)
                root = resolved.anchor
                if not root or not Path(root).exists():
                    return False, "Drive or root path does not exist"

        # Check for symlink safety
        if resolved.exists() and resolved.is_symlink():
            if allowed_base and not _validate_symlink_target(resolved, Path(normalize_user_path(allowed_base))):
                return False, "Symlink target is outside allowed directory"

        return True, None
    else:
        if not resolved.exists():
            return False, "Path does not exist"
        if not resolved.is_dir():
            return False, "Path is not a directory"

        # Check for symlink safety
        if resolved.is_symlink():
            if allowed_base and not _validate_symlink_target(resolved, Path(normalize_user_path(allowed_base))):
                return False, "Symlink target is outside allowed directory"

        return True, None


def validate_file_path(
    path: str,
    allowed_extensions: Optional[set] = None,
    allowed_base: Optional[str] = None
) -> Tuple[bool, Optional[str]]:
    """
    Validate that a file path is safe and exists.

    Args:
        path: The file path to validate
        allowed_extensions: Set of allowed file extensions (e.g., {'.png', '.jpg'})
        allowed_base: If provided, path must be within this base directory

    Returns:
        Tuple of (is_valid, error_message)
    """
    if not path or not isinstance(path, str):
        return False, "Path cannot be empty"

    # Check for suspicious patterns (directory traversal, control chars)
    if _contains_suspicious_patterns(path):
        return False, "Path contains invalid or suspicious characters"

    # Check for invalid characters in filename component (but allow Windows drive letters)
    if _contains_invalid_filename_chars(path):
        return False, "Path contains invalid filename characters"

    # Check path length before processing
    if len(path) > MAX_PATH_LENGTH:
        return False, f"Path exceeds maximum length of {MAX_PATH_LENGTH} characters"

    try:
        normalized_path = normalize_user_path(path)
        path_obj = Path(normalized_path)
    except (ValueError, OSError) as e:
        return False, f"Invalid path format: {str(e)}"

    # Check path depth
    if not _validate_path_depth(path_obj):
        return False, f"Path depth exceeds maximum of {MAX_PATH_DEPTH}"

    try:
        resolved = path_obj.resolve()
    except (ValueError, OSError) as e:
        return False, f"Cannot resolve path: {str(e)}"

    # Check resolved path length
    resolved_str = str(resolved)
    if len(resolved_str) > MAX_PATH_LENGTH:
        return False, f"Resolved path exceeds maximum length of {MAX_PATH_LENGTH} characters"

    # If allowed_base is specified, verify the path is within it
    if allowed_base:
        try:
            base_resolved = Path(normalize_user_path(allowed_base)).resolve()
            if not _is_same_or_subpath(base_resolved, resolved):
                return False, "Path is outside allowed directory"
        except (ValueError, OSError) as e:
            return False, f"Invalid base directory: {str(e)}"

    if not resolved.exists():
        return False, "File does not exist"

    if not resolved.is_file():
        return False, "Path is not a file"

    # Validate symlink target if applicable
    if resolved.is_symlink():
        if allowed_base and not _validate_symlink_target(resolved, Path(normalize_user_path(allowed_base))):
            return False, "Symlink target is outside allowed directory"
        elif not allowed_base:
            # Even without a base, validate the symlink resolves to an existing file
            try:
                target = resolved.resolve()
                if not target.exists():
                    return False, "Symlink target does not exist"
                if not target.is_file():
                    return False, "Symlink target is not a file"
            except (ValueError, OSError):
                return False, "Cannot resolve symlink target"

    if allowed_extensions:
        ext = resolved.suffix.lower()
        if ext not in allowed_extensions:
            return False, f"File extension '{ext}' not allowed"

    return True, None


def sanitize_filename(filename: str) -> str:
    """
    Sanitize a filename to remove potentially dangerous characters.

    v3.2.2: switched from an allow-list (``[\\w\\s\\.\\-]``) to a
    block-list of OS-illegal characters. The old allow-list mangled
    legitimate characters like parentheses, apostrophes, commas, and
    brackets — turning ``my (lora char).png`` into ``my _lora char_.png``.
    For LoRA training that pairs caption sidecars with images by exact
    basename match, that mangling broke pairing silently.

    The block list is the union of:
      - Path separators: ``/``, ``\\``, ``\\x00`` (null byte)
      - Windows-illegal characters: ``< > : " | ? *``
      - Control characters ``\\x00-\\x1f`` and ``\\x7f-\\x9f``

    Everything else — letters (any Unicode), digits, spaces, parens,
    apostrophes, commas, brackets, ampersands, hashtags, etc. — is
    preserved. The function is still safe against directory traversal
    because path separators are explicitly stripped, and the caller
    (e.g. ``validate_output_path``) does an additional resolve-and-
    compare check.

    Args:
        filename: The filename to sanitize

    Returns:
        Sanitized filename
    """
    if not filename:
        return "unnamed"

    # Remove path separators (handles both forward and backslash) and pull
    # out the last segment so a value like ``../foo/bar.png`` becomes
    # ``bar.png`` before we even start the per-character pass.
    filename = _extract_path_leaf(filename)

    # Strip control characters first (always unsafe)
    filename = re.sub(r'[\x00-\x1f\x7f-\x9f]', '', filename)

    # Collapse path-traversal dotdots so they cannot survive into the
    # final filename even after the regex pass below.
    filename = re.sub(r'\.\.', '.', filename)

    # Block list: replace OS-illegal characters with ``_`` so the
    # filename remains writable on Windows / macOS / Linux.
    #   /  \  - path separators
    #   <  >  - Windows redirect / illegal
    #   :     - Windows drive separator / NTFS stream
    #   "     - Windows illegal in filename
    #   |     - Windows pipe / illegal
    #   ?  *  - Windows wildcard / illegal
    sanitized = re.sub(r'[\x00<>:"/\\|?*]', '_', filename)

    # Remove leading/trailing spaces only (keep dots for extensions like .png)
    sanitized = sanitized.strip(' ')

    # Remove leading dots only if there are multiple (like .hidden files become hidden)
    # But preserve single leading dot for hidden files and extension dots
    while sanitized.startswith('..'):
        sanitized = sanitized[1:]

    # Ensure we don't end up with an empty string
    if not sanitized:
        return "unnamed"

    # Limit length
    if len(sanitized) > MAX_FILENAME_LENGTH:
        name, ext = os.path.splitext(sanitized)
        sanitized = name[:MAX_FILENAME_LENGTH - len(ext)] + ext

    return sanitized


def validate_image_output_path(
    path: str,
    allow_overwrite: bool = False,
    allowed_base: Optional[str] = None,
) -> ImageOutputPath:
    """
    Validate a full output image path for safe write operations.

    Unlike validate_output_path(), this accepts the final path directly and is
    intended for save-as workflows where the client chooses both directory and
    filename up front.

    Raises:
        PathValidationError: When the requested path is unsafe or unsupported.
    """
    if not path or not isinstance(path, str):
        raise PathValidationError("Output path cannot be empty")

    if _contains_suspicious_patterns(path):
        raise PathValidationError("Output path contains invalid or suspicious characters")

    if _contains_invalid_filename_chars(path):
        raise PathValidationError("Output path contains invalid filename characters")

    if len(path) > MAX_PATH_LENGTH:
        raise PathValidationError(f"Output path exceeds maximum length of {MAX_PATH_LENGTH} characters")

    try:
        requested_path = Path(normalize_user_path(path))
    except (ValueError, OSError) as exc:
        raise PathValidationError(f"Invalid output path format: {exc}") from exc

    if not _validate_path_depth(requested_path):
        raise PathValidationError(f"Output path depth exceeds maximum of {MAX_PATH_DEPTH}")

    extension = requested_path.suffix.lower()
    if extension not in SUPPORTED_OUTPUT_IMAGE_EXTENSIONS:
        raise PathValidationError("Unsupported output format. Use PNG, JPG/JPEG, or WebP")

    parent = requested_path.parent if str(requested_path.parent) not in ("", ".") else Path.cwd()
    try:
        if not parent.exists():
            raise PathValidationError("Output parent directory does not exist")
        if not parent.is_dir():
            raise PathValidationError("Output parent path is not a directory")
        if parent.is_symlink():
            raise PathValidationError("Output parent directory cannot be a symlink")
        resolved_parent = parent.resolve()
    except PathValidationError:
        raise
    except (ValueError, OSError) as exc:
        raise PathValidationError(f"Cannot resolve output parent directory: {exc}") from exc

    if allowed_base:
        try:
            base_resolved = Path(normalize_user_path(allowed_base)).resolve()
        except (ValueError, OSError) as exc:
            raise PathValidationError(f"Invalid base directory: {exc}") from exc
        if not _is_same_or_subpath(base_resolved, resolved_parent):
            raise PathValidationError("Output path is outside the allowed directory")

    candidate_output = resolved_parent / requested_path.name
    if candidate_output.exists() and candidate_output.is_symlink():
        raise PathValidationError("Output file cannot be a symlink")

    try:
        resolved_output = candidate_output.resolve(strict=False)
    except (ValueError, OSError) as exc:
        raise PathValidationError(f"Cannot resolve output file path: {exc}") from exc

    if not _is_same_or_subpath(resolved_parent, resolved_output) or resolved_output.parent != resolved_parent:
        raise PathValidationError("Resolved output path escapes the target directory")

    if not _validate_path_depth(resolved_output):
        raise PathValidationError(f"Output path depth exceeds maximum of {MAX_PATH_DEPTH}")

    if len(str(resolved_output)) > MAX_PATH_LENGTH:
        raise PathValidationError(f"Output path exceeds maximum length of {MAX_PATH_LENGTH} characters")

    exists = resolved_output.exists()
    if exists:
        if resolved_output.is_dir():
            raise PathValidationError("Output path points to a directory, not a file")
        if not allow_overwrite:
            return ImageOutputPath(
                path=resolved_output,
                parent=resolved_parent,
                extension=extension,
                exists=True,
            )

    return ImageOutputPath(
        path=resolved_output,
        parent=resolved_parent,
        extension=extension,
        exists=exists,
    )


def validate_output_path(
    path: str,
    filename: str,
    allowed_base: Optional[str] = None
) -> Tuple[bool, Optional[str], Optional[str]]:
    """
    Validate an output path and filename, creating directory if needed.

    Args:
        path: The output directory path
        filename: The desired filename
        allowed_base: If provided, output must be within this base directory

    Returns:
        Tuple of (is_valid, error_message, full_output_path)
    """
    normalized_path = normalize_user_path(path)
    normalized_allowed_base = normalize_user_path(allowed_base) if allowed_base else None
    is_valid, error = validate_folder_path(normalized_path, allow_create=True, allowed_base=normalized_allowed_base)
    if not is_valid:
        return False, error, None

    safe_filename = sanitize_filename(filename)

    try:
        resolved_dir = Path(normalized_path).resolve()
        full_path = resolved_dir / safe_filename

        # Resolve to check the final path
        resolved_full = full_path.resolve()

        # CRITICAL: Use proper path comparison instead of string prefix matching
        # This prevents bypasses like paths that start with the same string but are different directories
        # e.g., /app/uploads vs /app/uploads_backup would incorrectly match with string prefix
        if not _is_same_or_subpath(resolved_dir, resolved_full):
            return False, "Resolved path escapes target directory", None

        # Additional check: the filename component should not have changed the directory
        # This catches cases where the filename itself contains path components
        # (already handled by sanitize_filename, but defense in depth)
        if resolved_full.parent != resolved_dir:
            # The resolved path's parent should be exactly the target directory
            # If not, something is wrong (e.g., symlink tricks, path traversal)
            return False, "Invalid filename results in path escape", None

        # Check path depth and length for the final path
        if not _validate_path_depth(resolved_full):
            return False, f"Output path depth exceeds maximum of {MAX_PATH_DEPTH}", None

        if len(str(resolved_full)) > MAX_PATH_LENGTH:
            return False, f"Output path exceeds maximum length of {MAX_PATH_LENGTH} characters", None

        # Validate symlink target if the resolved path exists and is a symlink
        if resolved_full.exists() and resolved_full.is_symlink():
            if normalized_allowed_base and not _validate_symlink_target(resolved_full, Path(normalized_allowed_base)):
                return False, "Symlink target is outside allowed directory", None

        return True, None, str(resolved_full)
    except (ValueError, OSError) as e:
        return False, f"Invalid path: {str(e)}", None
