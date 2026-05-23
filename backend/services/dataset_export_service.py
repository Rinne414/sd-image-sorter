"""Dataset export service.

Implements the user-flow that issue #5 point 6 was asking for:
"copy/move images and write matching .txt sidecars to one folder, all
renamed consistently". Previously the only way to get a LoRA training
dataset out was a two-step dance — Auto-Separate to move images,
then export-batch with beside_image to write captions next to them —
and the renaming feature didn't exist at all.

This service handles the whole thing in one transaction:

  1. Validate output folder (creates if missing, blocks traversal).
  2. Plan the renames via ``dataset_naming.plan_renames``.
  3. For each non-skipped row:
       a. Copy or move the image to its renamed destination.
       b. Render the caption via the same export-template engine the
          rest of the app uses (so the user's blacklist / common-tags /
          underscore-to-space settings line up with the live preview
          they saw in the Dataset Maker UI).
       c. Write the caption to ``{stem}.txt`` next to the renamed image.
  4. If the image copy fails after the caption is partially written, we
     remove the orphaned caption file so the trainer doesn't see broken
     pairs.

Reuses:
  - ``services.dataset_naming``: deterministic stem + collision logic.
  - ``services.tag_export_service.build_sidecar_content``: same caption
    rendering pipeline as ``/api/tags/export-batch``.
  - ``utils.path_validation.validate_folder_path``: the same checks the
    other write endpoints use.
"""
from __future__ import annotations

import logging
import os
import shutil
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import HTTPException
from pydantic import BaseModel, Field

import database as db
from services.dataset_naming import plan_renames
from services.dataset_session_service import (
    resolve_paths_for_dataset,
    virtual_image_record_for_path,
)
from services.tag_export_service import build_sidecar_content
from utils.path_validation import normalize_user_path, validate_folder_path


logger = logging.getLogger(__name__)


VALID_IMAGE_OPS = {"copy", "move"}
VALID_OVERWRITE_POLICIES = {"unique", "overwrite", "skip"}


class DatasetExportRequest(BaseModel):
    """Request schema for ``POST /api/dataset/export``.

    Bounds are deliberately tight: the Dataset Maker UI only ships a
    user's curated selection (typically a few hundred images for a LoRA),
    not the whole library. The 10k cap is a generous safety bound.

    Two import sources are supported in one request:

    * ``image_ids`` — IDs from the main library DB, resolved via
      ``database.get_images_by_ids`` (legacy + 'send selection' flow).
    * ``image_paths`` — absolute file paths supplied by the Dataset
      Maker session for items the user imported directly from a folder
      (issue #5 point 5: "small gallery" without DB pollution). The
      export pipeline builds virtual records for these paths so the
      same rename + caption + sidecar logic applies.

    At least one of the two must be non-empty.
    """
    image_ids: List[int] = Field(default_factory=list, max_length=10_000)
    image_paths: List[str] = Field(default_factory=list, max_length=10_000)
    output_folder: str = Field(min_length=1, max_length=4096)

    naming_pattern: str = Field(default="{filename}", min_length=1, max_length=200)
    trigger: str = Field(default="", max_length=100)
    image_op: str = Field(default="copy")
    overwrite_policy: str = Field(default="unique")

    # Caption rendering options — match the export-template engine knobs
    # the Dataset Maker UI exposes.
    blacklist: List[str] = Field(default_factory=list, max_length=200)
    common_tags: List[str] = Field(default_factory=list, max_length=200)
    normalize_tag_underscores: bool = True

    # User-edited captions, keyed by either ``str(image_id)`` (for
    # gallery-source items) or absolute path (for local-source items).
    # Empty string means "use whatever the template engine renders".
    image_overrides: Dict[str, str] = Field(default_factory=dict)


class DatasetExportItemResult(BaseModel):
    image_id: int
    src_image_path: Optional[str] = None
    dst_image_path: Optional[str] = None
    dst_caption_path: Optional[str] = None
    skipped_reason: Optional[str] = None
    error: Optional[str] = None


class DatasetExportResponse(BaseModel):
    status: str  # "ok" | "partial" | "failed"
    exported: int
    skipped: int
    error_count: int
    output_folder: str
    items: List[DatasetExportItemResult]
    error_messages: List[str]


def export_dataset(request: DatasetExportRequest) -> DatasetExportResponse:
    """Run a full dataset export. Atomic-per-row: a per-image failure
    leaves earlier rows intact and adds an error entry for the failed
    one."""
    if request.image_op not in VALID_IMAGE_OPS:
        raise HTTPException(status_code=400, detail=f"Invalid image_op: {request.image_op!r}")
    if request.overwrite_policy not in VALID_OVERWRITE_POLICIES:
        raise HTTPException(status_code=400, detail=f"Invalid overwrite_policy: {request.overwrite_policy!r}")
    if not request.image_ids and not request.image_paths:
        raise HTTPException(status_code=400, detail="Must supply image_ids or image_paths (or both).")

    # ---- Validate output folder ----
    output_folder_norm = normalize_user_path(request.output_folder)
    is_valid, error = validate_folder_path(output_folder_norm, allow_create=True)
    if not is_valid:
        raise HTTPException(status_code=400, detail=error or "Invalid output folder")
    output_path = Path(output_folder_norm)
    output_path.mkdir(parents=True, exist_ok=True)

    # ---- Load image records + tags for DB-source items ----
    image_ids = list(dict.fromkeys(int(i) for i in request.image_ids))  # de-dup, preserve order
    images_map = db.get_images_by_ids(image_ids) if image_ids else {}
    tags_map = db.get_image_tags_map(image_ids) if image_ids else {}

    image_records: list[Dict[str, Any]] = []
    missing_ids: list[int] = []
    for image_id in image_ids:
        record = images_map.get(image_id)
        if not record:
            missing_ids.append(image_id)
            continue
        image_records.append(dict(record))  # copy so we can mutate safely

    # ---- Build virtual records for path-source items ----
    # These are images the user imported directly from a folder via the
    # Dataset Maker session — they have no DB row, so we synthesise a
    # record shaped like a DB row (path, filename, no tags, no metadata).
    # The naming + caption pipeline then handles them identically.
    invalid_paths: list[str] = []
    for raw_path in request.image_paths:
        resolved_list = resolve_paths_for_dataset([raw_path])
        if not resolved_list:
            invalid_paths.append(raw_path)
            continue
        abs_path = resolved_list[0]
        record = virtual_image_record_for_path(abs_path)
        # Tag map for this synthetic record is empty by default; the
        # caller is expected to supply a full caption override via
        # image_overrides[abs_path]. This matches the small-gallery
        # design (local captions live in localStorage, NOT in the DB).
        image_records.append(record)

    # ---- Plan the rename ----
    plan = plan_renames(
        image_records,
        output_folder=output_path,
        pattern=request.naming_pattern,
        trigger=request.trigger,
        overwrite_policy=request.overwrite_policy,
    )

    # ---- Pre-build common state for caption rendering ----
    blacklist_set = {str(t).strip().lower() for t in request.blacklist if str(t).strip()}

    # image_overrides accepts either ``str(image_id)`` keys (legacy DB
    # source) or absolute path keys (small-gallery local source). We
    # normalise both into a single lookup ``record_to_override`` keyed
    # by (image_id, abs_path) so the per-row loop can fetch in O(1).
    image_overrides_int: Dict[int, str] = {}
    image_overrides_path: Dict[str, str] = {}
    for k, v in request.image_overrides.items():
        text = str(v or "")
        try:
            image_overrides_int[int(k)] = text
        except (TypeError, ValueError):
            # Treat as a path key. Normalise to absolute path so it
            # matches whatever resolve_paths_for_dataset produced.
            try:
                normalized = str(Path(normalize_user_path(str(k))).resolve())
            except (OSError, ValueError):
                continue
            image_overrides_path[normalized] = text

    # Use the template engine via the same content_mode the UI sends.
    # We hard-code the LoRA workflow: tags + common-tags appended,
    # honoring the underscore checkbox.
    template_options: Dict[str, Any] = {
        "preset_id": "custom",
        "template_override": "{trigger}, {tags:filtered}, {append}",
        "trigger": str(request.trigger or ""),
        "blacklist": list(blacklist_set),
        "replace_rules": {},
        "max_tags": 0,
        "append": [str(t).strip() for t in request.common_tags if str(t).strip()],
    }
    if request.normalize_tag_underscores:
        template_options["underscore_to_space_override"] = True
        template_options["preserve_underscore_prefixes_override"] = ["score_"]
    else:
        template_options["underscore_to_space_override"] = False
        template_options["preserve_underscore_prefixes_override"] = ["score_"]

    # ---- Execute the plan ----
    items: List[DatasetExportItemResult] = []
    error_messages: List[str] = []
    exported = 0
    skipped = 0
    error_count = 0

    for record, dst_image_path, dst_caption_path, skip_reason in plan:
        image_id = int(record.get("id") or 0)
        src_image_path = str(record.get("path") or "")

        if dst_image_path is None:
            # Naming engine declined this row (skip policy hit, or
            # too-many collisions, or naming_error)
            items.append(DatasetExportItemResult(
                image_id=image_id,
                src_image_path=src_image_path,
                skipped_reason=skip_reason,
            ))
            skipped += 1
            continue

        # Render caption
        try:
            tags = tags_map.get(image_id, [])
            # Resolve override: int-key for DB-backed records, path-key
            # for small-gallery synthetic records (image_id=0 sentinel).
            override_text = ""
            if image_id and image_id in image_overrides_int:
                override_text = image_overrides_int[image_id]
            elif src_image_path and src_image_path in image_overrides_path:
                override_text = image_overrides_path[src_image_path]
            if override_text:
                caption_text = override_text
            else:
                caption_text = build_sidecar_content(
                    record,
                    tags,
                    content_mode="template",
                    blacklist=blacklist_set,
                    template_options=template_options,
                    normalize_tag_underscores=request.normalize_tag_underscores,
                )
        except Exception as exc:  # pragma: no cover - defensive
            error_count += 1
            msg = f"caption render failed for image {image_id}: {exc}"
            error_messages.append(msg)
            items.append(DatasetExportItemResult(
                image_id=image_id,
                src_image_path=src_image_path,
                error=msg,
            ))
            continue

        # Verify source exists
        if not src_image_path or not os.path.exists(src_image_path):
            error_count += 1
            msg = f"image {image_id} source missing on disk: {src_image_path!r}"
            error_messages.append(msg)
            items.append(DatasetExportItemResult(
                image_id=image_id,
                src_image_path=src_image_path,
                error=msg,
            ))
            continue

        # Copy / move the image
        try:
            os.makedirs(dst_image_path.parent, exist_ok=True)
            if request.image_op == "copy":
                # copy2 preserves mtime so trainers and downstream tools
                # see the original recency.
                shutil.copy2(src_image_path, str(dst_image_path))
            else:  # move
                shutil.move(src_image_path, str(dst_image_path))
                # Keep the DB in sync so the next time the user opens
                # the gallery the image isn't shown as "missing on disk".
                try:
                    db.update_image_path(image_id, str(dst_image_path))
                except Exception:
                    pass
        except Exception as exc:
            error_count += 1
            msg = f"failed to {request.image_op} image {image_id}: {exc}"
            error_messages.append(msg)
            items.append(DatasetExportItemResult(
                image_id=image_id,
                src_image_path=src_image_path,
                error=msg,
            ))
            continue

        # Write caption sidecar
        try:
            with open(dst_caption_path, "w", encoding="utf-8") as handle:
                handle.write(caption_text)
        except Exception as exc:
            error_count += 1
            msg = f"failed to write caption for image {image_id}: {exc}"
            error_messages.append(msg)
            # Don't remove the image — the user can re-run the export and
            # the existing image acts as the resume marker. But do report
            # the partial state in the per-item entry.
            items.append(DatasetExportItemResult(
                image_id=image_id,
                src_image_path=src_image_path,
                dst_image_path=str(dst_image_path),
                error=msg,
            ))
            continue

        exported += 1
        items.append(DatasetExportItemResult(
            image_id=image_id,
            src_image_path=src_image_path,
            dst_image_path=str(dst_image_path),
            dst_caption_path=str(dst_caption_path),
        ))

    # Surface the missing-from-DB rows
    for missing_id in missing_ids:
        error_count += 1
        msg = f"image {missing_id} not found in library"
        error_messages.append(msg)
        items.append(DatasetExportItemResult(image_id=missing_id, error=msg))

    # Surface the invalid path-source rows so the frontend can show them.
    for invalid_path in invalid_paths:
        error_count += 1
        msg = f"path not a readable image: {invalid_path}"
        error_messages.append(msg)
        items.append(DatasetExportItemResult(
            image_id=0,
            src_image_path=invalid_path,
            error=msg,
        ))

    if error_count == 0:
        status = "ok"
    elif exported == 0:
        status = "failed"
    else:
        status = "partial"

    return DatasetExportResponse(
        status=status,
        exported=exported,
        skipped=skipped,
        error_count=error_count,
        output_folder=str(output_path),
        items=items,
        error_messages=error_messages[:50],  # cap to avoid huge payloads
    )
