"""
Utilities for generating metadata-independent image content fingerprints.
"""
from __future__ import annotations

import hashlib
from typing import Optional

from PIL import Image


def compute_image_content_fingerprint(image_path: str) -> Optional[str]:
    """
    Return a stable digest for an image's visible pixel payload.

    The fingerprint intentionally ignores container metadata so the app can
    distinguish "same pixels, rewritten metadata" from "actual image changed".
    """
    if not image_path:
        return None

    with Image.open(image_path) as image:
        target_mode = "RGBA" if "A" in image.getbands() else "RGB"
        canonical = image.convert(target_mode)
        try:
            digest = hashlib.sha256()
            digest.update(f"{canonical.width}x{canonical.height}:{canonical.mode}".encode("utf-8"))
            digest.update(canonical.tobytes())
            return digest.hexdigest()
        finally:
            canonical.close()
