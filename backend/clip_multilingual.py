"""Text queries in languages other than English for the similarity search.

The library's picture vectors come from CLIP ViT-B/32, whose own text model
reads English only: a Chinese query returned the same unrelated pictures
whatever it said (measured on 147 pictures: 0 of the top 8 shared with the
English query in four of five pairs). ``sentence-transformers/
clip-ViT-B-32-multilingual-v1`` (Reimers & Gurevych; Apache-2.0) is a
multilingual DistilBERT distilled onto that same vector space, so it reads
50+ languages, Simplified and Traditional Chinese among them, against the
vectors the library already has: nothing is indexed again. With it the same
pairs share 6 to 8 of the top 8.

It is optional (about 132 MB, CPU, a few milliseconds per query). The 8-bit
ONNX file is used: on the measured pairs it ranks like the 539 MB one.

This module needs only onnxruntime, tokenizers and numpy, which the similarity
search already brings.
"""

from __future__ import annotations

import json
import logging
import platform
import struct
import threading
from pathlib import Path
from typing import Any, Callable, Dict, Optional

import numpy as np

import pinned_download

logger = logging.getLogger(__name__)

MODEL_ID = "clip-multilingual"
MODEL_NAME = "Multilingual text search"
REPO = "sentence-transformers/clip-ViT-B-32-multilingual-v1"
REVISION = "58edf8cada9e398793dca955574a48cbb7f18be2"
LICENSE = "Apache-2.0"
LINK = f"https://huggingface.co/{REPO}"
MAX_TOKENS = 128  # the model's own limit (sentence_bert_config.json)

_ONNX_X64 = pinned_download.PinnedFile(
    repo=REPO,
    revision=REVISION,
    remote_path="onnx/model_quint8_avx2.onnx",
    sha256="fbc8fbeaa5237d96bd1bf430057c70d34de8334a463e933a5faa305f6caeed9c",
    size_bytes=135_377_779,
)
_ONNX_ARM64 = pinned_download.PinnedFile(
    repo=REPO,
    revision=REVISION,
    remote_path="onnx/model_qint8_arm64.onnx",
    sha256="3bed77e83926519660b5c0833cb3321cfde952331edec4f7d501c7d384b8a8a7",
    size_bytes=135_336_307,
)
DENSE_FILE = pinned_download.PinnedFile(
    repo=REPO,
    revision=REVISION,
    remote_path="2_Dense/model.safetensors",
    sha256="d12568dc7300970a4d3dbb49068ad16cd89b99840b74b026f8e48071e9414f74",
    size_bytes=1_572_984,
)
TOKENIZER_FILE = pinned_download.PinnedFile(
    repo=REPO,
    revision=REVISION,
    remote_path="tokenizer.json",
    sha256="5b4e1a8171c81dfd666ae40265b9530c6e0b3d53923fe8ac493dcc84229adf81",
    size_bytes=1_961_847,
)


def onnx_file() -> pinned_download.PinnedFile:
    """The 8-bit file for this processor (the two builds are not interchangeable)."""
    return (
        _ONNX_ARM64 if platform.machine().lower() in {"arm64", "aarch64"} else _ONNX_X64
    )


def download_bytes() -> int:
    return onnx_file().size_bytes + DENSE_FILE.size_bytes + TOKENIZER_FILE.size_bytes


# ------------------------------------------------------------------- files
def models_dir() -> Path:
    """Beside the CLIP models, so it follows the same data folder and overrides."""
    import config

    return Path(config.CLIP_MODEL_DIR) / "clip-ViT-B-32-multilingual-v1"


def _paths() -> Dict[str, Path]:
    root = models_dir()
    return {
        "onnx": root / "model.onnx",
        "dense": root / "dense.safetensors",
        "tokenizer": root / "tokenizer.json",
    }


def _pinned() -> Dict[str, pinned_download.PinnedFile]:
    return {"onnx": onnx_file(), "dense": DENSE_FILE, "tokenizer": TOKENIZER_FILE}


def is_installed() -> bool:
    """Every file is there with exactly its pinned size (a cut-off download is not used)."""
    pinned = _pinned()
    for name, path in _paths().items():
        try:
            if path.stat().st_size != pinned[name].size_bytes:
                return False
        except OSError:
            return False
    return True


def health() -> Dict[str, Any]:
    installed = is_installed()
    megabytes = round(download_bytes() / (1024 * 1024))
    if installed:
        key = "models.clipMultilingual.ready"
        message = (
            "Ready: Find Similar reads descriptions in Chinese and 50+ other languages "
            f"(license {LICENSE}, from {REPO})."
        )
    else:
        key = "models.clipMultilingual.missing"
        message = (
            "Optional, not downloaded yet: describe pictures in Chinese and 50+ other "
            f"languages in Find Similar. About {megabytes} MB; the pictures are not indexed again."
        )
    return {
        "available": installed,
        "model_path": str(models_dir()) if installed else None,
        "expected_path": str(models_dir()),
        "download_mb": megabytes,
        "message_key": key,
        "message": message,
    }


def prepare(download_file: Callable[..., Path]) -> Dict[str, str]:
    """Download and verify the three pinned files; verified copies are kept as they are."""
    paths = _paths()
    for name, pinned in _pinned().items():
        pinned_download.fetch(pinned, paths[name], download_file, model_name=MODEL_NAME)
    release()
    return {"clip_multilingual_path": str(models_dir())}


# ----------------------------------------------------------------- queries
def needs_multilingual(text: str) -> bool:
    """Whether a query has letters the English text model cannot read.

    Accented Latin letters stay with the English model (names like "café");
    anything in a non-Latin script (CJK, kana, hangul, Cyrillic, Arabic, Thai,
    ...) asks for the multilingual one.
    """
    for char in str(text or ""):
        code = ord(char)
        if code < 0x0250:  # Basic Latin, Latin-1, Latin Extended-A/B
            continue
        if char.isalpha():
            return True
    return False


def read_dense_matrix(path: Path) -> np.ndarray:
    """The 768 -> 512 projection (no bias) from its safetensors file."""
    raw = path.read_bytes()
    (header_length,) = struct.unpack("<Q", raw[:8])
    header = json.loads(raw[8 : 8 + header_length])
    tensors = {name: meta for name, meta in header.items() if name != "__metadata__"}
    if len(tensors) != 1:
        raise RuntimeError(
            "The multilingual dense file holds an unexpected set of tensors."
        )
    meta = next(iter(tensors.values()))
    if meta.get("dtype") != "F32" or list(meta.get("shape") or []) != [512, 768]:
        raise RuntimeError(
            "The multilingual dense file is not a 512 x 768 float32 matrix."
        )
    start, end = meta["data_offsets"]
    body = raw[8 + header_length :]
    return np.frombuffer(body[start:end], dtype=np.float32).reshape(512, 768).copy()


class _Encoder:
    def __init__(self) -> None:
        import onnxruntime
        from tokenizers import Tokenizer

        paths = _paths()
        self.tokenizer = Tokenizer.from_file(str(paths["tokenizer"]))
        self.tokenizer.enable_truncation(max_length=MAX_TOKENS)
        options = onnxruntime.SessionOptions()
        options.intra_op_num_threads = 2  # one short query: no need for every core
        self.session = onnxruntime.InferenceSession(
            str(paths["onnx"]), sess_options=options, providers=["CPUExecutionProvider"]
        )
        self.input_names = {item.name for item in self.session.get_inputs()}
        self.dense = read_dense_matrix(paths["dense"])

    def encode(self, text: str) -> np.ndarray:
        encoding = self.tokenizer.encode(text)
        ids = np.asarray([encoding.ids], dtype=np.int64)
        mask = np.asarray([encoding.attention_mask], dtype=np.int64)
        feed = {"input_ids": ids, "attention_mask": mask}
        hidden = self.session.run(
            None,
            {name: value for name, value in feed.items() if name in self.input_names},
        )[0]
        weights = mask[..., None].astype(np.float32)
        pooled = (hidden * weights).sum(axis=1) / np.maximum(weights.sum(axis=1), 1e-9)
        vector = (pooled @ self.dense.T)[0]
        norm = float(np.linalg.norm(vector))
        return (vector / norm if norm > 0 else vector).astype(np.float32)


_encoder: Optional[_Encoder] = None
_encoder_lock = threading.Lock()


def encode(text: str) -> np.ndarray:
    """A unit vector for ``text`` in the CLIP ViT-B/32 picture space."""
    global _encoder
    with _encoder_lock:
        if _encoder is None:
            _encoder = _Encoder()
        return _encoder.encode(text)


def release() -> None:
    """Drop the loaded model (after its files changed)."""
    global _encoder
    with _encoder_lock:
        _encoder = None
