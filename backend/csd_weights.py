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
import importlib.util
import logging
from pathlib import Path
from typing import Any, Callable, Dict, Mapping, Tuple

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


class CsdWeightsError(RuntimeError):
    """The CSD checkpoint is unreadable, not a safe checkpoint, or not shaped as expected."""


# ------------------------------------------------------------------- files
def models_dir() -> Path:
    return Path(__file__).parent.parent / "models" / "csd"


def model_path() -> Path:
    return models_dir() / CSD_FILENAME


def weights_in_use() -> Path:
    """The file to read: the program's own, else a trusted copy (a Hugging Face
    cache or ComfyUI folder), else the own path (where Prepare puts it)."""
    return model_external.prefer_own(model_path(), CSD_SPACE)


def is_installed() -> bool:
    return pinned_download.is_present(weights_in_use())


def runtime_available() -> bool:
    """torch and open_clip, the Aesthetic runtime group, are importable."""
    return all(
        importlib.util.find_spec(name) is not None for name in ("torch", "open_clip")
    )


def health() -> Dict[str, Any]:
    path = weights_in_use()
    installed = is_installed()
    if not installed:
        key, message = (
            "models.csd.missing",
            "Optional, not downloaded yet: about 2.44 GB from tomg-group-umd/CSD-ViT-L (license CC-BY-4.0). Needs torch; Prepare / Download sets it up.",
        )
    elif not runtime_available():
        key, message = (
            "models.csd.needsRuntime",
            "Downloaded. It also needs the torch runtime: click Prepare / Download.",
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
