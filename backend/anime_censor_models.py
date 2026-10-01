"""deepghs anime censor + face detectors (MIT): files, health and setup.

- Anime censor detector (``nipple_f`` / ``penis`` / ``pussy``) from
  ``deepghs/anime_censor_detection`` ``censor_detect_v1.0_s``; the model card
  reports F1 0.83 at confidence 0.238. It is saved into the Privacy YOLO
  folder, so the Censor page lists it like any privacy YOLO model and the
  lightweight ONNX runtime runs it (no Ultralytics).
- Anime face detector from ``deepghs/anime_face_detection``
  ``face_detect_v1.4_s``, F1 0.95 at confidence 0.307, used by the face guard
  so an automatic mosaic does not land on a face.

Both files are pinned to a repository commit and verified by SHA-256, which
equals Hugging Face's LFS etag for the file.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Dict

import config
import model_external
import pinned_download

logger = logging.getLogger(__name__)

CENSOR_CONFIDENCE = 0.238
FACE_CONFIDENCE = 0.307


@dataclass(frozen=True)
class PinnedFile(pinned_download.PinnedFile):
    key: str = ""
    filename: str = ""


CENSOR_FILE = PinnedFile(
    key="censor",
    repo="deepghs/anime_censor_detection",
    revision="0cf62fd6b28213b40ae0c0055f92e7ae6a96bdc2",
    remote_path="censor_detect_v1.0_s/model.onnx",
    sha256="2c2524824d7d320c5619a0a73702a2e2186f619067c823d211e94f7cfe489cba",
    size_bytes=44_586_353,
    filename="deepghs_anime_censor_v1.0_s.onnx",
)
FACE_FILE = PinnedFile(
    key="face",
    repo="deepghs/anime_face_detection",
    revision="784dc4c0bb692351ddcdbe6131a050b17d3025d5",
    remote_path="face_detect_v1.4_s/model.onnx",
    sha256="403b5bc93b6ff789b7d183418df4a1364049bac00c24acd927604a7ff6891483",
    size_bytes=44_583_229,
    filename="deepghs_anime_face_v1.4_s.onnx",
)
TOTAL_BYTES = CENSOR_FILE.size_bytes + FACE_FILE.size_bytes


def censor_model_path() -> Path:
    return Path(config.get_yolo_model_dir()) / CENSOR_FILE.filename


def face_model_path() -> Path:
    return Path(config.DATA_DIR) / "models" / "censor-face" / FACE_FILE.filename


def _path_for(pinned: PinnedFile) -> Path:
    return censor_model_path() if pinned.key == "censor" else face_model_path()


def censor_model_in_use() -> Path:
    """The detector to read: the program's own file, else a trusted copy."""
    return model_external.prefer_own(censor_model_path(), "censor-anime", "censor")


def face_model_in_use() -> Path:
    """The face detector to read: the program's own file, else a trusted copy."""
    return model_external.prefer_own(face_model_path(), "censor-anime", "face")


def health() -> Dict[str, Any]:
    censor = censor_model_in_use()
    face = face_model_in_use()
    censor_ok = pinned_download.is_present(censor)
    face_ok = pinned_download.is_present(face)
    if censor_ok and face_ok:
        key, message = (
            "models.censorAnime.ready",
            "Anime censor detector and face guard are ready.",
        )
    elif censor_ok or face_ok:
        key, message = (
            "models.censorAnime.partial",
            "Only part of the anime censor models is downloaded. Click Prepare / Download to finish.",
        )
    else:
        key, message = (
            "models.censorAnime.missing",
            "Not downloaded yet. Click Prepare / Download (~89 MB).",
        )
    return {
        "available": censor_ok and face_ok,
        "censor_model_path": str(censor) if censor_ok else None,
        "face_model_path": str(face) if face_ok else None,
        "source": (
            model_external.source_for_path("censor-anime", "censor", str(censor))
            if censor_ok
            else None
        )
        or (
            model_external.source_for_path("censor-anime", "face", str(face))
            if face_ok
            else None
        ),
        "expected_censor_path": str(censor_model_path()),
        "expected_face_path": str(face_model_path()),
        "message_key": key,
        "message": message,
    }


def prepare(download_file: Callable[..., Path]) -> Dict[str, str]:
    """Download and verify both files; a verified copy on disk is kept as is."""
    return {
        f"{pinned.key}_model_path": _prepare_one(pinned, download_file)
        for pinned in (CENSOR_FILE, FACE_FILE)
    }


def _prepare_one(pinned: PinnedFile, download_file: Callable[..., Path]) -> str:
    in_use = model_external.prefer_own(_path_for(pinned), "censor-anime", pinned.key)
    if in_use != _path_for(pinned):
        return str(in_use)  # a trusted copy is in use; nothing to download
    return str(pinned_download.fetch(pinned, _path_for(pinned), download_file, model_name="Anime censor detector"))
