"""Built-in output folders: where each save flow writes when its folder is left blank."""
from fastapi import APIRouter

import config

router = APIRouter(prefix="/api/output-folders", tags=["output"])


@router.get("")
async def get_output_folders() -> dict:
    """Return the built-in output folder of every save flow."""
    return {
        "root": str(config.OUTPUT_DIR),
        "folders": {
            feature: str(config.default_output_folder(feature))
            for feature in config.OUTPUT_FEATURES
        },
    }
