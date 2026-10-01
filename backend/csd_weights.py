"""CSD (Contrastive Style Descriptors) weights: the pinned file and its loader.

``tomg-group-umd/CSD-ViT-L`` (Somepalli et al., 2024; weights CC-BY-4.0, code
MIT) is a whole fine-tuned OpenAI CLIP ViT-L/14 plus a style projection. It is
an optional model of the style map: a 2.44 GB pickle with no safetensors and
no ONNX build, so it needs torch and open_clip (the optional Aesthetic runtime
group) and is read with ``torch.load(weights_only=True)`` and the shortest
possible allow-list.

This module holds everything that does not need torch at import time: the
pin, the file lookup (the program's folder first, then a trusted copy), the
health card and the checkpoint reader / key mapping. The model itself lives in
``csd_encoder``.
"""

from __future__ import annotations

import argparse
import importlib.metadata
import importlib.util
import logging
import re
from pathlib import Path
from typing import Any, Callable, Dict, Mapping, Optional, Tuple

import model_external
import pinned_download

logger = logging.getLogger(__name__)

CSD_SPACE = "csd"
CSD_LICENSE = "CC-BY-4.0"
CSD_LINK = "https://huggingface.co/tomg-group-umd/CSD-ViT-L"
CSD_FILENAME = "csd_vit_l_pytorch_model.bin"
CSD_FILE = pinned_download.PinnedFile(
    repo="tomg-group-umd/CSD-ViT-L",
    revision="5bc26a6fb0487f3f00a2a7313135103a005b1b67",
    remote_path="pytorch_model.bin",
    sha256="40e92fad63a361b8136100cd234c42d401ef9b34ff1748234318929ebcc7e7a1",
    size_bytes=2_438_228_893,
)
# Stamped on every stored vector: a different pinned file makes every row "to extract" again.
CSD_MODEL_VERSION = f"csd:vit-l-14:{CSD_FILE.sha256[:12]}"

_PREFIXES = ("module.",)
_BACKBONE_PREFIX = "backbone."
_STYLE_KEY = "last_layer_style"
# Trained alongside the style head but not used for style vectors.
_IGNORED_KEYS = ("last_layer_content",)


# torch 2.4 - 2.5.1 can be made to run code by a crafted checkpoint even with
# weights_only=True (CVE-2025-32434, fixed in 2.6), so older torch never loads one.
MIN_TORCH = (2, 6)
TORCH_TOO_OLD_ERROR = (
    "CSD needs torch 2.6 or newer to read its checkpoint safely. Click Prepare / Download "
    "for CSD in the Model Center to update it. / CSD 需要 torch 2.6 或更新版本才能安全读取权重："
    "请到模型中心点击 CSD 的「准备 / 下载」更新依赖。"
)


class CsdWeightsError(RuntimeError):
    """The CSD checkpoint is unreadable, not a safe checkpoint, or not shaped as expected."""


# ------------------------------------------------------------------- files
def models_dir() -> Path:
    return Path(__file__).parent.parent / "models" / "csd"


def model_path() -> Path:
    return models_dir() / CSD_FILENAME


def _own_file_complete() -> bool:
    """The program's own file has exactly the pinned size (a cut-off or other
    build is not used; Prepare replaces it)."""
    try:
        return model_path().stat().st_size == CSD_FILE.size_bytes
    except OSError:
        return False


def _own_file_incomplete() -> bool:
    return pinned_download.is_present(model_path()) and not _own_file_complete()


def weights_in_use() -> Path:
    """The file to read: the program's own when it is the pinned size, else a
    trusted copy (a Hugging Face cache or ComfyUI folder), else the own path
    (where Prepare puts it)."""
    if _own_file_complete():
        return model_path()
    external = model_external.usable_path(CSD_SPACE)
    return Path(external) if external else model_path()


def is_installed() -> bool:
    path = weights_in_use()
    if path == model_path() and _own_file_incomplete():
        return False
    return pinned_download.is_present(path)


def torch_version() -> Optional[Tuple[int, ...]]:
    """The installed torch as numbers (``2.13.0+cu126`` -> (2, 13, 0)), None when absent."""
    try:
        raw = importlib.metadata.version("torch")
    except importlib.metadata.PackageNotFoundError:
        return None
    return tuple(int(part) for part in re.findall(r"\d+", raw.split("+")[0])[:3])


_INSTALLED = object()


def torch_is_safe(version: Any = _INSTALLED) -> bool:
    """Whether ``version`` (default: the installed torch; None = no torch) is new enough."""
    found = torch_version() if version is _INSTALLED else version
    return found is not None and found >= MIN_TORCH


def runtime_available() -> bool:
    """open_clip and a torch new enough to read the checkpoint safely (the
    Aesthetic runtime group) are installed."""
    return importlib.util.find_spec("open_clip") is not None and torch_is_safe()


def health() -> Dict[str, Any]:
    path = weights_in_use()
    installed = is_installed()
    if _own_file_incomplete() and path == model_path():
        key, message = (
            "models.csd.incomplete",
            "The CSD file is incomplete or from another version. Click Prepare / Download to replace it.",
        )
    elif not installed:
        key, message = (
            "models.csd.missing",
            "Optional, not downloaded yet: about 2.44 GB from tomg-group-umd/CSD-ViT-L (license CC-BY-4.0). Needs torch; Prepare / Download sets it up.",
        )
    elif not runtime_available():
        key, message = (
            "models.csd.needsRuntime",
            "Downloaded. It also needs torch 2.6 or newer and open_clip: click Prepare / Download.",
        )
    else:
        key, message = (
            "models.csd.ready",
            "CSD is ready (license CC-BY-4.0, from tomg-group-umd/CSD-ViT-L). Build the CSD index on the Style Map to use it.",
        )
    return {
        "available": installed and runtime_available(),
        "model_path": str(path) if installed else None,
        "source": (
            model_external.source_for_path(CSD_SPACE, None, str(path))
            if installed
            else None
        ),
        "expected_path": str(model_path()),
        "message_key": key,
        "message": message,
    }


def prepare(download_file: Callable[..., Path]) -> Dict[str, str]:
    """Download and verify the pinned checkpoint; a verified copy is kept as is."""
    in_use = weights_in_use()
    if in_use != model_path():
        return {"csd_weights_path": str(in_use)}  # a trusted copy is in use
    path = pinned_download.fetch(
        CSD_FILE, model_path(), download_file, model_name="CSD style descriptors"
    )
    return {"csd_weights_path": str(path)}


# ----------------------------------------------------------------- reading
def _allowed_pickle_globals() -> list:
    """What a training checkpoint of CSD needs and nothing else: the saved
    ``argparse.Namespace`` and the numpy scalars of the optimiser state."""
    import numpy as np

    try:  # numpy 2 renamed numpy.core to numpy._core
        multiarray = importlib.import_module("numpy._core.multiarray")
    except ImportError:
        multiarray = importlib.import_module("numpy.core.multiarray")
    # The checkpoint names the scalar helper by its numpy 1.x path.
    allowed = [
        argparse.Namespace,
        np.dtype,
        multiarray.scalar,
        (multiarray.scalar, "numpy.core.multiarray.scalar"),
    ]
    dtypes = getattr(np, "dtypes", None)
    for name in ("Float64DType", "Int64DType"):
        dtype_class = getattr(dtypes, name, None)
        if dtype_class is not None:
            allowed.append(dtype_class)
    return allowed


def load_state_dict_file(path: Path) -> Mapping[str, Any]:
    """The ``model_state_dict`` of the checkpoint, read without running pickled code."""
    import torch

    if not torch_is_safe(torch_version()):
        raise CsdWeightsError(TORCH_TOO_OLD_ERROR)

    def read(**extra):
        with torch.serialization.safe_globals(_allowed_pickle_globals()):
            return torch.load(str(path), map_location="cpu", weights_only=True, **extra)

    try:
        try:
            checkpoint = read(mmap=True)  # leaves the optimiser state on disk
        except RuntimeError:
            checkpoint = read()  # an old, non-zip checkpoint cannot be mapped
    except Exception as exc:  # unreadable or refused by the allow-list
        raise CsdWeightsError(
            f"The CSD checkpoint could not be read safely: {exc}"
        ) from exc
    state = checkpoint.get("model_state_dict") if isinstance(checkpoint, dict) else None
    if not isinstance(state, dict):
        raise CsdWeightsError("The CSD checkpoint has no model_state_dict.")
    return state


def _strip(key: str) -> str:
    for prefix in _PREFIXES:
        if key.startswith(prefix):
            return key[len(prefix) :]
    return key


def split_state_dict(state: Mapping[str, Any]) -> Tuple[Dict[str, Any], Any]:
    """(backbone state for the open_clip visual tower, style head matrix).

    The checkpoint was saved from a ``DataParallel`` wrapper around a model
    holding ``backbone`` (the CLIP visual tower without its projection) and
    two heads. Any key that is none of these is an error: a changed layout
    must not load half-silently.
    """
    backbone: Dict[str, Any] = {}
    style = None
    for raw_key, value in state.items():
        key = _strip(raw_key)
        if key.startswith(_BACKBONE_PREFIX):
            backbone[key[len(_BACKBONE_PREFIX) :]] = value
        elif key == _STYLE_KEY:
            style = value
        elif key not in _IGNORED_KEYS:
            raise CsdWeightsError(f"Unexpected key in the CSD checkpoint: {raw_key}")
    if not backbone:
        raise CsdWeightsError("The CSD checkpoint has no backbone weights.")
    if style is None:
        raise CsdWeightsError(
            "The CSD checkpoint has no style head (last_layer_style)."
        )
    return backbone, style
