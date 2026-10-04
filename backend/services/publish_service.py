"""Publish-set workbench backend (v3.5.0 Tier 1 — Pixiv set publishing).

The workbench flow is: pick images in the gallery -> order them -> pair each
with its censored variant -> export a sequentially named, platform-ready set.

Two service entry points back it:

- ``find_censor_pairs``: for each library image, locate the censored variant
  produced by the censor editor's ``{stem}{suffix}.{ext}`` convention. The
  original's own directory is probed first (censor output usually lands next
  to the source), then the library is searched by exact filename.
- ``export_set``: copy the ordered set into a validated output folder as
  ``{prefix}{NN}.{ext}`` (Pixiv-style 01/02/03 naming) or under a name the
  Censor page gave it, choosing original or censored per item, plus an
  optional ``caption.txt``.

Safety rules: when a caller asks for the censored variant and none can be
resolved, that item FAILS — we never silently substitute the uncensored
original into a set headed for a public platform. Generation info (prompt,
model, seed in PNG text chunks, EXIF and XMP) is removed by default, with the
Censor page's own strip/minimal logic; "keep" exports the file unchanged.

The Censor page hands its results over explicitly: it renders them into a
staging folder (``create_staging_folder``) and sends each file's path as
``censored_path``, so nothing depends on guessing by file name.
"""
from __future__ import annotations

import logging
import os
import re
import shutil
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

from PIL import Image

from services.output_registry import remember_saved_output
from services.watermark_service import TextWatermarkConfig, WatermarkServiceError, apply_text_watermark

logger = logging.getLogger(__name__)

DEFAULT_CENSOR_SUFFIX = "_censored"
CENSOR_PAIR_EXTENSIONS = (".png", ".jpg", ".jpeg", ".webp")
MIN_PAD_WIDTH = 1
MAX_PAD_WIDTH = 4
CAPTION_FILENAME = "caption.txt"
_DB_BATCH = 900
METADATA_OPTIONS = ("strip", "keep", "minimal")
DEFAULT_METADATA_OPTION = "strip"
STAGING_DIRNAME = "publish-staging"
_STAGING_SESSION_NAME = re.compile(r"\d{8}-\d{6}-[0-9a-f]{8}")
_OUTPUT_FORMATS = {".png": "png", ".jpg": "jpg", ".jpeg": "jpg", ".webp": "webp"}
# Same encoder choices as the watermark export: re-encoding a publish copy
# must not cost visible quality (WebP stays lossless, JPEG keeps full chroma).
_ENCODER_OPTIONS = {
    "png": ("PNG", {}),
    "jpg": ("JPEG", {"quality": 95, "subsampling": 0}),
    "webp": ("WEBP", {"lossless": True}),
}
_METADATA_KWARGS = {
    "png": ("pnginfo", "dpi", "icc_profile"),
    "jpg": ("exif", "icc_profile", "dpi"),
    "webp": ("exif", "icc_profile"),
}


def normalize_metadata_option(option: Optional[str]) -> str:
    """Return strip / keep / minimal; anything else is a caller error."""
    normalized = str(option or DEFAULT_METADATA_OPTION).strip().lower()
    if normalized not in METADATA_OPTIONS:
        raise ValueError(f"Unsupported metadata option {option!r}; use strip, keep or minimal")
    return normalized


def _staging_root() -> Path:
    from config import get_data_dir

    return Path(get_data_dir()) / STAGING_DIRNAME


def create_staging_folder() -> Dict[str, str]:
    """Make a fresh folder for the Censor page to render its results into.

    Earlier sessions are removed first: a hand-over is only read by the one
    export that follows it, and each censored copy is a full-size image.
    """
    root = _staging_root()
    root.mkdir(parents=True, exist_ok=True)
    for child in root.iterdir():
        if child.is_dir() and _STAGING_SESSION_NAME.fullmatch(child.name):
            shutil.rmtree(child, ignore_errors=True)
    session = root / f"{time.strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:8]}"
    session.mkdir()
    return {"folder": str(session)}


def sanitize_censor_suffix(suffix: Optional[str]) -> str:
    """Keep the suffix filesystem-safe; mirror the censor editor's charset."""
    cleaned = re.sub(r"[^A-Za-z0-9_\-]", "", str(suffix or "").strip())
    return cleaned or DEFAULT_CENSOR_SUFFIX


def _fetch_image_rows(image_ids: List[int]) -> Dict[int, Dict[str, Any]]:
    import database as db

    rows: Dict[int, Dict[str, Any]] = {}
    if not image_ids:
        return rows
    with db.get_db() as conn:
        for start in range(0, len(image_ids), _DB_BATCH):
            batch = image_ids[start:start + _DB_BATCH]
            placeholders = ",".join("?" * len(batch))
            for row in conn.execute(
                f"""
                SELECT id, path, filename, width, height, file_size
                FROM images WHERE id IN ({placeholders})
                """,
                batch,
            ).fetchall():
                rows[int(row[0])] = {
                    "id": int(row[0]),
                    "path": row[1],
                    "filename": row[2],
                    "width": row[3],
                    "height": row[4],
                    "file_size": row[5],
                }
    return rows


def _censored_candidates(filename: str, suffix: str) -> List[str]:
    stem = Path(filename or "").stem
    if not stem:
        return []
    return [f"{stem}{suffix}{ext}" for ext in CENSOR_PAIR_EXTENSIONS]


def _probe_same_directory(original_path: str, candidates: List[str]) -> Optional[str]:
    """Look for a censored sibling next to the original file."""
    try:
        directory = Path(original_path).parent
    except (TypeError, ValueError):
        return None
    for name in candidates:
        candidate = directory / name
        try:
            if candidate.is_file():
                return str(candidate)
        except OSError:
            continue
    return None


def _probe_library(conn, candidates: List[str], exclude_id: int) -> Optional[str]:
    """Find an indexed censored variant anywhere in the library (newest wins)."""
    if not candidates:
        return None
    placeholders = ",".join("?" * len(candidates))
    rows = conn.execute(
        f"""
        SELECT path FROM images
        WHERE filename IN ({placeholders}) AND id != ?
        ORDER BY id DESC
        """,
        [*candidates, exclude_id],
    ).fetchall()
    for row in rows:
        path = row[0]
        try:
            if path and os.path.isfile(path):
                return str(path)
        except OSError:
            continue
    return None


def _resolve_censored_path(conn, row: Dict[str, Any], suffix: str) -> Optional[Dict[str, str]]:
    candidates = _censored_candidates(row.get("filename") or "", suffix)
    if not candidates:
        return None
    disk_hit = _probe_same_directory(row.get("path") or "", candidates)
    if disk_hit:
        return {"path": disk_hit, "source": "disk"}
    library_hit = _probe_library(conn, candidates, int(row["id"]))
    if library_hit:
        return {"path": library_hit, "source": "library"}
    return None


def find_censor_pairs(image_ids: List[int], censor_suffix: Optional[str] = None) -> Dict[str, Any]:
    """Resolve censored variants for the given library images (input order kept)."""
    import database as db

    suffix = sanitize_censor_suffix(censor_suffix)
    ordered_ids: List[int] = []
    seen = set()
    for raw_id in image_ids or []:
        image_id = int(raw_id)
        if image_id not in seen:
            seen.add(image_id)
            ordered_ids.append(image_id)

    rows = _fetch_image_rows(ordered_ids)
    pairs: List[Dict[str, Any]] = []
    found_count = 0
    with db.get_db() as conn:
        for image_id in ordered_ids:
            row = rows.get(image_id)
            if row is None:
                pairs.append({"image_id": image_id, "missing": True, "found": False})
                continue
            entry: Dict[str, Any] = {
                "image_id": image_id,
                "missing": False,
                "filename": row["filename"],
                "path": row["path"],
                "width": row["width"],
                "height": row["height"],
                "file_size": row["file_size"],
                "found": False,
                "censored_path": None,
                "censored_filename": None,
                "censored_source": None,
            }
            resolved = _resolve_censored_path(conn, row, suffix)
            if resolved:
                entry["found"] = True
                entry["censored_path"] = resolved["path"]
                entry["censored_filename"] = Path(resolved["path"]).name
                entry["censored_source"] = resolved["source"]
                found_count += 1
            pairs.append(entry)

    return {
        "pairs": pairs,
        "total": len(ordered_ids),
        "found_count": found_count,
        "censor_suffix": suffix,
    }


def _validated_output_folder(output_folder: str) -> Path:
    """Validate the export folder; blank means the built-in output/publish."""
    import config
    from utils.path_validation import validate_folder_path

    folder = str(output_folder or "").strip() or str(config.default_output_folder("publish"))
    is_valid, error = validate_folder_path(folder, allow_create=True)
    if not is_valid:
        raise ValueError(error or "Invalid output folder")
    return Path(folder).resolve()


def _explicit_censored_source(censored_path: str) -> Dict[str, Any]:
    from utils.path_validation import validate_file_path

    is_valid, error = validate_file_path(
        censored_path, allowed_extensions=set(_OUTPUT_FORMATS)
    )
    if not is_valid or not os.path.isfile(censored_path):
        raise FileNotFoundError(
            f"打码版文件不见了 / The censored file is gone ({error or censored_path})"
        )
    return {"path": str(censored_path), "used_censored": True}


def _resolve_export_source(conn, row: Dict[str, Any], use_censored: bool,
                           suffix: str, censored_path: Optional[str] = None) -> Dict[str, Any]:
    """Pick the file to copy. Censored-requested-but-missing is a hard error."""
    if use_censored and censored_path:
        return _explicit_censored_source(censored_path)
    if use_censored:
        resolved = _resolve_censored_path(conn, row, suffix)
        if resolved is None:
            raise FileNotFoundError(
                f"未找到打码版 / No censored variant ({Path(row['filename']).stem}{suffix}.*) found"
            )
        return {"path": resolved["path"], "used_censored": True}
    source = row.get("path") or ""
    if not source or not os.path.isfile(source):
        raise FileNotFoundError("原图文件已不在磁盘上 / Original file is missing on disk")
    return {"path": source, "used_censored": False}


def _output_name(item: Dict[str, Any], prefix: str, number: int, pad: int, extension: str) -> str:
    """The Censor page's name when one was sent, else the numbered name."""
    from utils.path_validation import sanitize_filename

    explicit = str(item.get("output_name") or "").strip()
    if explicit:
        stem = Path(sanitize_filename(explicit)).stem.strip()
        if stem:
            return f"{stem}{extension}"
    return f"{prefix}{number:0{pad}d}{extension}"


def _pick_metadata_kwargs(save_kwargs: Dict[str, object], output_format: str) -> Dict[str, object]:
    allowed = _METADATA_KWARGS[output_format]
    return {key: value for key, value in save_kwargs.items() if key in allowed}


def _write_export_copy(
    source_path: str,
    destination: Path,
    *,
    image_id: int,
    metadata_option: str,
    watermark: Optional[TextWatermarkConfig],
) -> None:
    """Write one publish copy; only an unwatermarked "keep" copies the bytes.

    Everything else is re-encoded through the Censor page's own metadata
    handling: ``_strip_all_metadata`` rebuilds the raster without any info,
    and ``_prepare_metadata_for_save`` decides what "keep" / "minimal" carry
    over from the library original.
    """
    watermark_on = watermark is not None and watermark.enabled
    if metadata_option == "keep" and not watermark_on:
        shutil.copy2(source_path, destination)
        return

    from services.censor.output_io import _normalize_censor_source, _save_pillow_image_atomically
    from services.censor_service import CensorService
    from services.image_metadata_writer import prepare_image_for_save

    output_format = _OUTPUT_FORMATS.get(destination.suffix.lower())
    if output_format is None:
        raise WatermarkServiceError(f"Unsupported image type {destination.suffix!r}")
    with Image.open(source_path) as opened:
        if getattr(opened, "is_animated", False):
            raise WatermarkServiceError(
                "这是动图，清除生成信息或加水印会丢掉动画；要原样导出请选「保留原始生成信息」"
                " / Animated image: removing generation info or adding a watermark would drop"
                " the animation. Choose 'Keep original metadata' to export it unchanged."
            )
        opened.load()
        image = opened.copy()
        image.info = dict(opened.info)

    if watermark_on:
        image = apply_text_watermark(image, watermark)

    censor = CensorService()
    if metadata_option == "keep":
        save_kwargs = censor._prepare_metadata_for_save(image, image_id, "keep", output_format)
    else:
        image = censor._strip_all_metadata(_normalize_censor_source(image))
        save_kwargs = (
            censor._prepare_metadata_for_save(image, image_id, "minimal", output_format)
            if metadata_option == "minimal"
            else {}
        )

    pil_format, encoder_options = _ENCODER_OPTIONS[output_format]
    warnings: List[str] = []
    image = prepare_image_for_save(image, pil_format, warnings)
    _save_pillow_image_atomically(
        image,
        str(destination),
        pil_format,
        {**encoder_options, **_pick_metadata_kwargs(save_kwargs, output_format)},
    )


def export_set(
    items: List[Dict[str, Any]],
    output_folder: str,
    name_prefix: str = "",
    start_index: int = 1,
    pad_width: int = 2,
    caption_text: str = "",
    censor_suffix: Optional[str] = None,
    overwrite: bool = False,
    watermark: Optional[TextWatermarkConfig] = None,
    metadata_option: Optional[str] = DEFAULT_METADATA_OPTION,
) -> Dict[str, Any]:
    """Copy the ordered set into ``output_folder`` with sequential names.

    Numbering is positional (position + start_index) so a failed item keeps
    every later item's number stable across a fix-and-retry.
    """
    import database as db
    from utils.path_validation import sanitize_filename

    metadata = normalize_metadata_option(metadata_option)
    suffix = sanitize_censor_suffix(censor_suffix)
    target = _validated_output_folder(output_folder)
    os.makedirs(target, exist_ok=True)

    raw_prefix = str(name_prefix or "").strip()
    # sanitize_filename falls back to "unnamed" on empty input — an empty
    # prefix is a valid choice here (plain 01.png / 02.png sets).
    prefix = sanitize_filename(raw_prefix).strip() if raw_prefix else ""
    pad = max(MIN_PAD_WIDTH, min(MAX_PAD_WIDTH, int(pad_width)))
    first_number = max(0, int(start_index))

    ordered_ids = [int(item.get("image_id") or 0) for item in items or []]
    rows = _fetch_image_rows(ordered_ids)

    exported: List[Dict[str, Any]] = []
    skipped_existing: List[Dict[str, Any]] = []
    # "Open folder" selects the first written file, else the first skipped one.
    exported_reveal_path: Optional[str] = None
    reveal_path: Optional[str] = None
    errors: List[Dict[str, Any]] = []
    used_names: set = set()

    with db.get_db() as conn:
        for position, item in enumerate(items or []):
            image_id = int(item.get("image_id") or 0)
            number = first_number + position
            row = rows.get(image_id)
            if row is None:
                errors.append({"image_id": image_id, "error": "Image not found in library"})
                continue
            try:
                source = _resolve_export_source(
                    conn, row, bool(item.get("use_censored")), suffix,
                    censored_path=item.get("censored_path"),
                )
            except FileNotFoundError as exc:
                errors.append({"image_id": image_id, "error": str(exc)})
                continue

            extension = Path(source["path"]).suffix.lower() or ".png"
            output_name = _output_name(item, prefix, number, pad, extension)
            if output_name.lower() in used_names:
                errors.append({
                    "image_id": image_id,
                    "error": f"这一组里文件名重复 / Duplicate file name in this set: {output_name}",
                })
                continue
            used_names.add(output_name.lower())
            destination = target / output_name
            if destination.exists() and not overwrite:
                skipped_existing.append({"image_id": image_id, "output_name": output_name})
                remember_saved_output(str(destination))
                reveal_path = reveal_path or str(destination)
                continue
            try:
                _write_export_copy(
                    source["path"],
                    destination,
                    image_id=image_id,
                    metadata_option=metadata,
                    watermark=watermark,
                )
            except (OSError, ValueError, WatermarkServiceError) as exc:
                logger.warning("Publish export copy failed for %s: %s", source["path"], exc)
                errors.append({"image_id": image_id, "error": f"Copy failed: {exc}"})
                continue
            exported.append({
                "index": number,
                "output_name": output_name,
                "image_id": image_id,
                "used_censored": source["used_censored"],
                "source_path": source["path"],
                "metadata": metadata,
            })
            remember_saved_output(str(destination))
            if not exported_reveal_path:
                exported_reveal_path = str(destination)

    caption_file: Optional[str] = None
    caption = str(caption_text or "").strip()
    if caption:
        caption_path = target / CAPTION_FILENAME
        try:
            # newline="\n": text mode would otherwise emit \r\n on Windows,
            # making caption bytes platform-dependent.
            caption_path.write_text(caption + "\n", encoding="utf-8", newline="\n")
            caption_file = CAPTION_FILENAME
        except OSError as exc:
            logger.warning("Publish caption write failed: %s", exc)
            errors.append({"image_id": None, "error": f"caption.txt write failed: {exc}"})

    return {
        "success": not errors,
        "exported": exported,
        "skipped_existing": skipped_existing,
        "errors": errors,
        "caption_file": caption_file,
        "output_folder": str(target),
        "reveal_path": exported_reveal_path or reveal_path,
        "metadata_option": metadata,
    }
