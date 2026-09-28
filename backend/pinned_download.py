"""Download a model file pinned to a Hugging Face commit and verified by SHA-256.

The SHA-256 equals Hugging Face's LFS etag for the file, so a pin can be
checked against the hub without trusting any mirror. The official endpoint
is tried first (or whatever the user's download-source setting orders),
then the mirror; a wrong checksum is never installed and a verified copy on
disk is never downloaded again.
"""

from __future__ import annotations

import hashlib
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, List

from model_download_sources import get_hf_endpoint_order

logger = logging.getLogger(__name__)

DOWNLOAD_TIMEOUT_SECONDS = 600


@dataclass(frozen=True)
class PinnedFile:
    repo: str
    revision: str
    remote_path: str
    sha256: str
    size_bytes: int


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def is_present(path: Path) -> bool:
    try:
        return path.is_file() and path.stat().st_size > 0
    except OSError:
        return False


def fetch(
    pinned: PinnedFile,
    target: Path,
    download_file: Callable[..., Path],
    *,
    model_name: str,
) -> Path:
    """Place a verified copy of ``pinned`` at ``target``; raise RuntimeError when every source fails."""
    if is_present(target) and sha256_of(target) == pinned.sha256:
        return target
    target.parent.mkdir(parents=True, exist_ok=True)
    staging = target.with_name(target.name + ".download")
    failures: List[str] = []
    for endpoint in get_hf_endpoint_order(model_name=model_name):
        url = f"{endpoint.rstrip('/')}/{pinned.repo}/resolve/{pinned.revision}/{pinned.remote_path}"
        try:
            download_file(url, staging, timeout=DOWNLOAD_TIMEOUT_SECONDS)
        except Exception as exc:  # network / HTTP errors: try the next endpoint
            failures.append(f"{endpoint}: {exc}")
            staging.unlink(missing_ok=True)
            continue
        if sha256_of(staging) != pinned.sha256:
            failures.append(f"{endpoint}: checksum mismatch")
            staging.unlink(missing_ok=True)
            continue
        staging.replace(target)
        logger.info("%s ready at %s", model_name, target)
        return target
    raise RuntimeError(
        f"Could not download {pinned.repo}/{pinned.remote_path}. " + "; ".join(failures)
    )
