"""Dataset export naming engine.

A deterministic stem-renaming engine for the Dataset Maker view's
"export" button. Keeps the algorithm in a tiny pure-python module so
it can be unit-tested without spinning up the FastAPI app.

Pattern variables (case-insensitive on the variable name only):
  {filename}    - original image stem (e.g. ``94F91B...``)
  {index}       - 1-based counter
  {index:03d}   - 0-padded counter; any digit count <= 8 supported
  {trigger}     - the trigger word the user typed in the UI
  {generator}   - generator metadata column (webui/comfyui/nai/...)
  {ext}         - original extension WITHOUT the dot (e.g. "png")
  {date}        - YYYY-MM-DD as of now()

The result stem is then sanitized via the v3.2.2-relaxed
``sanitize_filename`` so OS-illegal characters cannot survive a user
typing them into the trigger/pattern field. Parens, apostrophes,
commas, brackets etc. are PRESERVED (this matches the LoRA-pairing
fix in commit a44826b).

Collisions are resolved per ``overwrite_policy``:
  - ``unique``   -> add ``_1``, ``_2``, ... suffix until free
  - ``overwrite``-> reuse the path; caller is responsible for
    actually overwriting on disk
  - ``skip``     -> return ``None`` so the caller can record a
    ``skipped_existing`` row
"""
from __future__ import annotations

import os
import re
from datetime import datetime
from pathlib import Path
from typing import Dict, Optional, Tuple

from utils.path_validation import sanitize_filename


_PATTERN_VAR = re.compile(r"\{([a-zA-Z_][a-zA-Z0-9_]*)(?::(\d{1,2})d)?\}")
_DEFAULT_PATTERN = "{filename}"
_MAX_PADDING_DIGITS = 8


class NamingError(ValueError):
    """Raised when the user's naming pattern can never produce a usable stem."""


def render_stem(
    pattern: str,
    *,
    image_filename: str,
    index: int,
    trigger: str = "",
    generator: str = "",
) -> str:
    """Render a single output stem from the pattern.

    ``image_filename`` is the on-disk basename (with extension).
    ``index`` is the 1-based sequence number for this image.

    Returns the sanitized stem (no extension). Raises ``NamingError`` if
    the pattern is so broken it produced an empty string.
    """
    pat = (pattern or _DEFAULT_PATTERN).strip() or _DEFAULT_PATTERN

    stem = os.path.splitext(image_filename or "")[0]
    ext_no_dot = os.path.splitext(image_filename or "")[1].lstrip(".").lower()
    today_iso = datetime.now().strftime("%Y-%m-%d")

    def _replace(match: re.Match[str]) -> str:
        var = match.group(1).lower()
        padding = match.group(2)  # may be None
        if var == "filename":
            return stem
        if var == "index":
            if padding:
                width = min(int(padding), _MAX_PADDING_DIGITS)
                return f"{index:0{width}d}"
            return str(index)
        if var == "trigger":
            return str(trigger or "")
        if var == "generator":
            return str(generator or "")
        if var == "ext":
            return ext_no_dot
        if var == "date":
            return today_iso
        # Unknown variable: keep the literal so the user notices and fixes it
        return match.group(0)

    rendered = _PATTERN_VAR.sub(_replace, pat).strip()
    if not rendered:
        raise NamingError(
            f"Naming pattern {pat!r} produced an empty filename for image "
            f"{image_filename!r}. At minimum the pattern must contain "
            f"text or a non-empty variable."
        )

    # The image already exists on disk so its filename is OS-legal; sanitize
    # the rendered stem (which may now contain user-typed trigger text) to
    # block path separators and control chars while still preserving safe
    # characters like parens / apostrophes / commas.
    sanitized = sanitize_filename(rendered)
    # ``rendered`` is already a stem (no extension was added during the
    # variable substitution -- ``{filename}`` only expands to the stem,
    # and the user is responsible for adding ``{ext}`` if they want one).
    # Do NOT run ``os.path.splitext`` on the result: that would mistakenly
    # truncate stems containing dots, e.g. ``with.commas, sort`` -> ``with``.
    return sanitized or "unnamed"


def resolve_collision(
    folder: Path,
    base_stem: str,
    extension: str,
    *,
    used_paths: set[str],
    overwrite_policy: str,
) -> Optional[Path]:
    """Return the final write path for an image+caption pair, honoring the
    ``overwrite_policy``. Returns ``None`` to mean "skip this image".

    ``base_stem`` is the rendered+sanitized stem (no extension).
    ``extension`` is the file extension WITH the leading dot (e.g. ``.png``).
    ``used_paths`` is a set of image path strings already taken in this
    export run; we update it in-place when we pick a path.
    """
    primary = folder / f"{base_stem}{extension}"
    primary_str = str(primary)

    if overwrite_policy == "overwrite":
        if primary_str not in used_paths:
            used_paths.add(primary_str)
            return primary
        # Even with overwrite, two images can't claim the same name in
        # one run -- fall through to numeric suffix to disambiguate.

    if overwrite_policy == "skip":
        if primary_str in used_paths or primary.exists():
            return None
        used_paths.add(primary_str)
        return primary

    # ``unique`` (default): try the bare name first, then ``_1``, ``_2``...
    if primary_str not in used_paths and not primary.exists():
        used_paths.add(primary_str)
        return primary

    counter = 1
    while counter <= 10000:
        candidate = folder / f"{base_stem}_{counter}{extension}"
        candidate_str = str(candidate)
        if candidate_str not in used_paths and not candidate.exists():
            used_paths.add(candidate_str)
            return candidate
        counter += 1
    return None  # too many collisions; treat as skip


def plan_renames(
    image_records: list[Dict[str, str]],
    *,
    output_folder: Path,
    pattern: str,
    trigger: str,
    overwrite_policy: str,
) -> list[Tuple[Dict[str, str], Optional[Path], Optional[Path], Optional[str]]]:
    """Plan the per-image rename for an entire dataset export.

    Returns a list of tuples ``(record, dst_image_path, dst_caption_path,
    skip_reason)``. ``skip_reason`` is set when ``dst_image_path`` is
    ``None`` to explain why (currently always ``"existing"`` for the skip
    policy or ``"too_many_collisions"`` for unique with >10000 dupes).
    """
    used_image_paths: set[str] = set()
    used_caption_paths: set[str] = set()
    plan: list = []

    for idx, record in enumerate(image_records, start=1):
        image_filename = record.get("filename") or os.path.basename(record.get("path") or "")
        ext = os.path.splitext(image_filename)[1] or ".png"

        try:
            stem = render_stem(
                pattern,
                image_filename=image_filename,
                index=idx,
                trigger=trigger,
                generator=str(record.get("generator") or ""),
            )
        except NamingError as exc:
            plan.append((record, None, None, f"naming_error: {exc}"))
            continue

        image_path = resolve_collision(
            output_folder, stem, ext,
            used_paths=used_image_paths,
            overwrite_policy=overwrite_policy,
        )
        if image_path is None:
            plan.append((record, None, None, "existing" if overwrite_policy == "skip" else "too_many_collisions"))
            continue

        # Caption sidecar matches the image stem exactly.
        caption_stem = image_path.stem
        caption_path = output_folder / f"{caption_stem}.txt"
        # Add to used set so a downstream image with a different image_path
        # but same stem can't also claim this caption.
        used_caption_paths.add(str(caption_path))
        plan.append((record, image_path, caption_path, None))

    return plan
