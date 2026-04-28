"""
Shared tag export helper for services that write per-image .txt tag files.
"""
from __future__ import annotations

import os
from typing import Any, Dict, List

from fastapi import HTTPException

import database as db
from utils.path_validation import normalize_user_path, validate_folder_path


def export_tags_batch_request(request: Any) -> Dict[str, Any]:
    """Export tags for each image to individual .txt files.

    Returns a normalized internal payload so callers can keep their
    legacy API response shapes without copy-maintaining the file-writing logic.
    """
    output_folder = normalize_user_path(str(request.output_folder or ""))
    is_valid, error = validate_folder_path(output_folder, allow_create=True)
    if not is_valid:
        raise HTTPException(status_code=400, detail=error or "Invalid output folder")

    blacklist = {str(tag or "").strip().lower() for tag in (request.blacklist or []) if str(tag or "").strip()}
    prefix = str(request.prefix or "")

    exported = 0
    error_count = 0
    error_messages: List[str] = []
    used_output_paths = set()
    output_folder_ready = os.path.isdir(output_folder)

    for image_id in request.image_ids:
        try:
            image = db.get_image_by_id(image_id)
            if not image:
                error_count += 1
                error_messages.append(f"Image {image_id} not found")
                continue

            tags = db.get_image_tags(image_id)
            filtered_tags = [t["tag"] for t in tags if str(t["tag"] or "").strip().lower() not in blacklist]
            file_content = ", ".join(filtered_tags)
            if prefix:
                file_content = f"{prefix}{file_content}" if file_content else prefix.rstrip(", ")

            basename = os.path.splitext(image["filename"])[0]
            candidate_names = [f"{basename}.txt", f"{image['filename']}.txt"]
            txt_path = None

            for candidate_name in candidate_names:
                candidate_path = os.path.join(output_folder, candidate_name)
                if candidate_path not in used_output_paths and not os.path.exists(candidate_path):
                    txt_path = candidate_path
                    break

            if txt_path is None:
                stem = image["filename"]
                counter = 1
                while True:
                    candidate_path = os.path.join(output_folder, f"{stem}_{counter}.txt")
                    if candidate_path not in used_output_paths and not os.path.exists(candidate_path):
                        txt_path = candidate_path
                        break
                    counter += 1

            if not output_folder_ready:
                try:
                    os.makedirs(output_folder, exist_ok=True)
                except OSError as exc:
                    raise HTTPException(status_code=400, detail=f"Cannot create output folder: {exc}") from exc
                output_folder_ready = True

            with open(txt_path, "w", encoding="utf-8") as handle:
                handle.write(file_content)

            used_output_paths.add(txt_path)
            exported += 1
        except HTTPException:
            raise
        except Exception as exc:
            error_count += 1
            error_messages.append(f"Error exporting tags for image {image_id}: {exc}")

    return {
        "exported": exported,
        "error_count": error_count,
        "error_messages": error_messages,
        "total": len(request.image_ids),
    }
