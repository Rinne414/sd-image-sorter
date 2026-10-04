"""Where an export's pairs land: flat, or kohya's ``<repeats>_<concept>`` folder.

kohya-ss sd-scripts' folder method (``--train_data_dir``) reads one subfolder
per concept and takes the repeat count from the folder name's ``<repeats>_``
prefix. With ``folder_layout="kohya"`` every artifact of the export (pairs,
masks, manifest, trainer config) lives in that subfolder, so the subfolder is
the export's effective output folder. ``"flat"`` writes into the chosen folder.

The client composes the concept name (trigger word, then project name) and
must send a name that is already safe as one folder name; this module only
validates it, so the path the page shows is exactly the path that is written.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any, Dict, Literal

FolderLayout = Literal["flat", "kohya"]

KOHYA_CONCEPT_MAX_LENGTH = 80
KOHYA_CONCEPT_FALLBACK = "dataset"
# Path separators, Windows-reserved punctuation, control characters and any
# whitespace. Whitespace is excluded so a folder name never needs quoting.
_UNSAFE_CONCEPT_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1f\x7f\s]')


def validate_kohya_concept(value: str) -> str:
    """Return ``value`` unchanged when it is safe as one folder name."""
    if _UNSAFE_CONCEPT_CHARS.search(value):
        raise ValueError(
            "kohya_concept must not contain spaces, path separators or any of "
            f'<>:"|?*; received={value!r}'
        )
    if value.startswith(".") or value.endswith("."):
        raise ValueError(
            f"kohya_concept must not start or end with a dot; received={value!r}"
        )
    return value


def kohya_folder_name(repeats: int, concept: str) -> str:
    return f"{int(repeats)}_{concept or KOHYA_CONCEPT_FALLBACK}"


def export_subfolder(request: Any) -> str:
    """The subfolder the request writes into, or ``""`` for the flat layout."""
    if getattr(request, "folder_layout", "flat") != "kohya":
        return ""
    return kohya_folder_name(request.trainer_repeats, request.kohya_concept)


def effective_output_folder(output_root: Path, request: Any) -> Path:
    subfolder = export_subfolder(request)
    return output_root / subfolder if subfolder else output_root


def folder_layout_record(output_root: Path, request: Any) -> Dict[str, Any]:
    """What the export manifest records about the layout."""
    return {
        "layout": getattr(request, "folder_layout", "flat"),
        "output_root": str(output_root),
        "subfolder": export_subfolder(request),
        "repeats": int(request.trainer_repeats),
    }
