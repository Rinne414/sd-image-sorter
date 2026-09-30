"""The CPU stage of the style index (slice S1b): one picture at a time,
on the worker's helper threads, everything that happens before the GPU.

For a pending row: resolve the file, settle its pixel fingerprint (hashing
only when the scanner would re-read the file), claim or check the
fingerprint in the DB, decide whether the stored vector can be kept, decode
the picture and, when the identifier offers ``prepare_style_input``, turn
it into the model's input tensor so the decoded image can be dropped right
away. Errors are carried in the result, never raised: the worker reports
them per picture.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from typing import Any, Optional

from PIL import Image

import database as db
from exceptions import ServiceError
from image_fingerprint import compute_image_content_fingerprint
from services.derived_state_service import initialize_image_content_fingerprint
from utils.source_paths import resolve_existing_indexed_image_path

logger = logging.getLogger(__name__)

STYLE_VECTOR_FINGERPRINT_ERROR = "Could not fingerprint the image pixels."
STYLE_VECTOR_STALE_ERROR = (
    "The image changed since it was scanned; rescan the folder and try again."
)

# (image_id, path, stored_fingerprint, stored_version, image_fingerprint, source_mtime_ns, source_size)
PendingRow = tuple[
    int, str, Optional[str], Optional[str], Optional[str], Optional[int], Optional[int]
]


@dataclass
class PreparedPicture:
    """One picture after the CPU stage: on disk, fingerprinted, decoded."""

    image_id: int
    indexed_path: str
    image_path: str = ""
    fingerprint: str = ""
    image: Optional[Image.Image] = None
    # The model's own input (identifier.prepare_style_input), made on the
    # helper thread; when set, ``image`` has already been dropped.
    model_input: Any = None
    kept: bool = False
    error: Optional[Exception] = None

    @property
    def name(self) -> str:
        return os.path.basename(self.indexed_path or "") or str(self.image_id)

    @property
    def payload(self) -> Any:
        """What goes to the batch interface: the prepared input, else the picture."""
        return self.model_input if self.model_input is not None else self.image

    def close(self) -> None:
        if self.image is not None:
            self.image.close()
            self.image = None
        self.model_input = None


def fingerprint_for(
    image_path: str,
    known_fingerprint: Optional[str],
    source_mtime_ns: Optional[int],
    source_size: Optional[int],
) -> str:
    """The image's pixel fingerprint, hashed only when the file may have changed.

    The scanner calls a file unchanged when its mtime and size still match
    the indexed ones (``image_manager_gates._source_fingerprint_matches``)
    and only then keeps the stored fingerprint; the same rule here skips
    the SHA of pixels the scanner would not re-read. A file that changed
    on disk is hashed again and, if it no longer matches, refused by the
    caller.
    """
    known = str(known_fingerprint or "").strip()
    if known and source_mtime_ns is not None and source_size is not None:
        stat = os.stat(image_path)
        if stat.st_mtime_ns == int(source_mtime_ns) and stat.st_size == int(
            source_size
        ):
            return known
    return str(compute_image_content_fingerprint(image_path) or "").strip()


def prepare_picture(
    row: PendingRow, model_version: str, identifier=None
) -> PreparedPicture:
    """Resolve, fingerprint, gate, decode and (when the identifier offers
    ``prepare_style_input``) transform one picture: every CPU step, so the
    GPU stage only stacks and runs."""
    (
        image_id,
        indexed_path,
        stored_fingerprint,
        stored_version,
        image_fingerprint,
        source_mtime_ns,
        source_size,
    ) = row
    prepared = PreparedPicture(image_id=image_id, indexed_path=indexed_path)
    try:
        image_path = resolve_existing_indexed_image_path(
            indexed_path, backend_file=__file__
        )
        if not image_path:
            try:
                db.mark_image_unreadable(image_id, "File not found")
            except Exception:
                logger.debug(
                    "Failed to mark image %s unreadable during style extraction",
                    image_id,
                )
            raise FileNotFoundError(f"Image file not found for image {image_id}")
        prepared.image_path = image_path
        fingerprint = fingerprint_for(
            image_path, image_fingerprint, source_mtime_ns, source_size
        )
        if not fingerprint:
            raise ServiceError(STYLE_VECTOR_FINGERPRINT_ERROR)
        with db.get_db() as conn:
            current = initialize_image_content_fingerprint(
                conn.cursor(), image_id=image_id, content_fingerprint=fingerprint
            )
        if not current:
            raise ServiceError(STYLE_VECTOR_STALE_ERROR)
        prepared.fingerprint = fingerprint
        if stored_fingerprint == fingerprint and stored_version == model_version:
            # The scan had forgotten the fingerprint but the pixels are the
            # same: the stored vector is still right, no model run.
            prepared.kept = True
            return prepared
        with Image.open(image_path) as source:
            prepared.image = source.convert("RGB")
        prepare_input = getattr(identifier, "prepare_style_input", None)
        if callable(prepare_input):
            prepared.model_input = prepare_input(prepared.image)
            prepared.image.close()
            prepared.image = None
    except Exception as exc:  # reported per picture by the worker
        prepared.error = exc
    return prepared
