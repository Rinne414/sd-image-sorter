"""Where save flows write when their folder field is left blank, and "Open folder"."""
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

import config
from app_diagnostics import _open_path_in_file_manager as open_in_file_manager
from services.output_registry import was_saved_output
from utils.path_validation import is_directory_symlink_or_junction, validate_folder_path

router = APIRouter(prefix="/api/output-folders", tags=["output"])


def _describe() -> dict:
    return {
        "root": str(config.output_root()),
        "builtin_root": str(config.OUTPUT_DIR),
        "custom_root": config.get_output_root_setting(),
        "folders": {
            feature: str(config.default_output_folder(feature))
            for feature in config.OUTPUT_FEATURES
        },
    }


class OutputRootRequest(BaseModel):
    root: str = Field("", max_length=4096)


class RevealRequest(BaseModel):
    path: str = Field(..., min_length=1, max_length=4096)


@router.get("")
async def get_output_folders() -> dict:
    """Return the output root and the folder of every save flow."""
    return _describe()


@router.patch("")
def set_output_root(request: OutputRootRequest) -> dict:
    """Move every blank-folder save to another root; an empty root restores the program's output/."""
    root = request.root.strip()
    stored = ""
    if root:
        # Stored exactly as later saves will use it: a relative path would
        # follow the server's working folder, which differs per launcher.
        candidate = Path(root).expanduser()
        if not candidate.is_absolute():
            raise HTTPException(status_code=400, detail="Choose a full folder path, for example D:/SD outputs.")
        if candidate.exists() and not candidate.is_dir():
            raise HTTPException(status_code=400, detail="That path is a file, not a folder.")
        is_valid, error = validate_folder_path(str(candidate), allow_create=True)
        if not is_valid:
            raise HTTPException(status_code=400, detail=error or "Invalid output folder")
        if is_directory_symlink_or_junction(candidate):
            raise HTTPException(status_code=400, detail="Symlink paths are not allowed")
        stored = str(candidate)
    try:
        config.save_output_root_setting(stored)
    except OSError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return _describe()


@router.post("/reveal")
async def reveal_saved_output(request: RevealRequest) -> dict:
    """Show a file a save wrote while this server runs in the OS file manager, selected."""
    path = Path(request.path)
    if not was_saved_output(request.path) or not path.is_file():
        raise HTTPException(
            status_code=404,
            detail="Only files saved by this program in this session can be shown.",
        )
    if not await run_in_threadpool(open_in_file_manager, path):
        raise HTTPException(status_code=501, detail="No file manager is available on this computer.")
    return {"status": "ok"}
