"""POST /api/open-path: show an existing folder in the OS file manager."""

# ``sys`` / ``subprocess`` are read as module attributes at call time so tests
# can patch ``file_manager.sys.platform`` and ``file_manager.subprocess.Popen``.
import subprocess
import sys

from fastapi import APIRouter
from pydantic import BaseModel, Field

from services.file_manager_service import open_directory

router = APIRouter(prefix="/api", tags=["files"])


class OpenPathRequest(BaseModel):
    path: str = Field(
        ...,
        min_length=1,
        max_length=4096,
        description="An existing folder on this computer",
    )


@router.post(
    "/open-path",
    summary="Open a folder in the file explorer",
    description="""
Open an existing folder (for example an export destination) in the OS file explorer.

The path must be an existing directory; a file, a missing folder or a suspicious path is refused.
Supports Windows (explorer), macOS (open) and Linux (xdg-open). No shell is involved.
    """,
    responses={
        200: {
            "description": "Folder opened",
            "content": {
                "application/json": {
                    "example": {"success": True, "path": "D:/exports/pixiv"}
                }
            },
        },
        400: {"description": "Not a folder, or the path is not allowed"},
        404: {"description": "The folder does not exist"},
        500: {"description": "The file explorer could not be started"},
    },
)
async def open_path(body: OpenPathRequest):
    """Open an existing folder in the OS file explorer."""
    return open_directory(body.path, platform=sys.platform, popen=subprocess.Popen)
