"""Per-batch working folders under ``<data dir>/batches/<batch_id>/``.

Only files this app derived live here (censored working copies). The database
column ``batch_items.censored_path`` is the truth: a file without a row is
garbage and is removed; a row whose file vanished counts as "no censored copy".
Paths are stored relative to the batch folder so a portable install can move.
"""

from __future__ import annotations

import logging
import shutil
from pathlib import Path

from config import get_data_dir
from utils.path_validation import is_directory_symlink_or_junction

logger = logging.getLogger(__name__)

CENSORED_DIR = "censored"


def batches_root() -> Path:
    return Path(get_data_dir()) / "batches"


def batch_folder(batch_id: int) -> Path:
    return batches_root() / str(int(batch_id))


def censored_relative_path(image_id: int) -> str:
    return f"{CENSORED_DIR}/{int(image_id)}.png"


def resolve_censored_path(batch_id: int, relative_path: str | None) -> Path | None:
    """Return the absolute working-copy path when it stays inside the batch folder."""
    if not relative_path:
        return None
    folder = batch_folder(batch_id).resolve()
    candidate = (folder / relative_path).resolve()
    if candidate.parent != folder / CENSORED_DIR:
        logger.warning(
            "Ignoring censored path outside batch %s: %r", batch_id, relative_path
        )
        return None
    return candidate


def existing_censored_path(batch_id: int, relative_path: str | None) -> Path | None:
    path = resolve_censored_path(batch_id, relative_path)
    if path is None or not path.is_file():
        return None
    return path


def remove_file_quietly(path: Path | None) -> None:
    if path is None:
        return
    try:
        path.unlink(missing_ok=True)
    except OSError:
        logger.warning("Could not remove batch working file %s", path, exc_info=True)


def remove_batch_folder(batch_id: int) -> None:
    """Delete one batch's working folder; never follows a link out of it."""
    folder = batch_folder(batch_id)
    if not folder.exists() and not folder.is_symlink():
        return
    if folder.is_symlink() or is_directory_symlink_or_junction(folder):
        folder.unlink()
        return
    if folder.resolve().parent != batches_root().resolve():
        raise RuntimeError(f"Batch folder {folder} is outside the batches root")
    shutil.rmtree(folder)


def prune_censored_files(batch_id: int, item_image_ids: set[int]) -> None:
    """Remove working copies of images that are no longer items of the batch.

    An image row deleted from the Library takes its batch item with it (FK
    cascade), which leaves its file behind; this is where it goes. Keyed by
    item membership, not by ``censored_path``, so a copy another request is
    saving for a current item is never raced away.
    """
    censored_dir = batch_folder(batch_id) / CENSORED_DIR
    if not censored_dir.is_dir() or is_directory_symlink_or_junction(censored_dir):
        return
    keep = {Path(censored_relative_path(image_id)).name for image_id in item_image_ids}
    for entry in censored_dir.iterdir():
        # Dot-names are another request's in-flight staging files.
        if entry.name.startswith("."):
            continue
        if entry.is_file() and entry.name not in keep:
            remove_file_quietly(entry)
