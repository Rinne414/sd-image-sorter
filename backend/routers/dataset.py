"""``/api/dataset/*`` routes.

Phase 2 of the Dataset Maker tab introduced in v3.2.2 (issue #5
points 5/6 follow-up). The single endpoint here drives the "Export
dataset" button: copy/move images to a target folder under a chosen
naming pattern, and write the matching .txt caption sidecars in
the same operation.
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException

from services.dataset_export_service import (
    DatasetExportRequest,
    DatasetExportResponse,
    export_dataset,
)


logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api", tags=["dataset"])


@router.post(
    "/dataset/export",
    response_model=DatasetExportResponse,
    summary="Export a curated dataset (images + captions) to one folder",
    description=(
        "Combined image-and-caption export for LoRA training datasets. "
        "Renames every image according to the supplied pattern, copies "
        "(or moves) it to the output folder, and writes the matching "
        "``.txt`` sidecar with the same stem.\n\n"
        "Pattern variables: ``{filename}``, ``{index}``, ``{index:03d}`` "
        "(0-padded counter), ``{trigger}``, ``{generator}``, ``{ext}``, "
        "``{date}``."
    ),
    responses={
        200: {"description": "Export completed (status field is ``ok`` / ``partial`` / ``failed``)"},
        400: {"description": "Invalid request payload (output folder, image_op, or overwrite_policy)"},
    },
)
def post_dataset_export(payload: DatasetExportRequest) -> DatasetExportResponse:
    try:
        return export_dataset(payload)
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Dataset export failed")
        raise HTTPException(status_code=500, detail=f"Dataset export failed: {exc}") from exc
