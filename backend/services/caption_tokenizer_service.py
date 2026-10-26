"""Exact caption token counts with the tokenizers Anima reads its captions with.

Anima's text side is Qwen3-0.6B plus a T5 v1.1 XXL tokenizer, so a caption has
two lengths: Qwen3 tokens (no special tokens added) and T5 tokens (one end
token added). The estimate the Check step used before ("one token per four
letters") is only close for CLIP; these two numbers are exact.

The tokenizer files are small data files, fetched once on first use through
``pinned_download`` (a Hugging Face commit and a SHA-256 for each file, so a
wrong or changed file is never used):

* Qwen3-0.6B ``tokenizer.json``, 11.4 MB, Apache-2.0.
* T5 v1.1 XXL: Google publishes its ``spiece.model`` only; the ready-made fast
  ``tokenizer.json`` (2.4 MB, Apache-2.0) sits in ``google/flan-t5-xxl``, which
  ships the very same ``spiece.model`` (identical SHA-256). Checked on
  2026-10-27: on 4,000 generated captions (tags, long sentences, Chinese and
  Japanese text, emoji, odd spaces) the count made with it, on text whose
  whitespace is collapsed to single spaces, equals SentencePiece's own count
  plus the end token every time. Without the collapse a double space or a line
  break adds a token, so the T5 count always collapses whitespace first. Text
  that contains a special-token word such as ``</s>`` is counted as that one
  token, which is what the real encoder does too.

The counting itself is the ``tokenizers`` package (the same Rust library
``transformers`` uses). It comes with the AI tools and is installed on demand
when it is missing, like the other optional packages.
"""

from __future__ import annotations

import importlib.util
import logging
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Sequence

import config
import pinned_download

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class TokenizerSpec:
    id: str
    label: str
    file: pinned_download.PinnedFile
    #: Qwen3 counts the text as is; T5 gets its end token.
    add_special_tokens: bool
    #: T5 counts the text with whitespace runs collapsed to one space (see the module notes).
    collapse_spaces: bool


SPECS: Dict[str, TokenizerSpec] = {
    "qwen3_0_6b": TokenizerSpec(
        id="qwen3_0_6b",
        label="Qwen3-0.6B",
        file=pinned_download.PinnedFile(
            repo="Qwen/Qwen3-0.6B",
            revision="c1899de289a04d12100db370d81485cdf75e47ca",
            remote_path="tokenizer.json",
            sha256="aeb13307a71acd8fe81861d94ad54ab689df773318809eed3cbe794b4492dae4",
            size_bytes=11_422_654,
        ),
        add_special_tokens=False,
        collapse_spaces=False,
    ),
    "t5_v1_1_xxl": TokenizerSpec(
        id="t5_v1_1_xxl",
        label="T5 v1.1 XXL",
        file=pinned_download.PinnedFile(
            repo="google/flan-t5-xxl",
            revision="ae7c9136adc7555eeccc78cdd960dfd60fb346ce",
            remote_path="tokenizer.json",
            sha256="fe2ebbbbde2985be723e0ce18217853e4020c5e9d35bd07be2c27ab9d3ead57a",
            size_bytes=2_424_064,
        ),
        add_special_tokens=True,
        collapse_spaces=True,
    ),
}

#: Which tokenizers a base model's captions are counted with.
PROFILES: Dict[str, Sequence[str]] = {"anima": ("qwen3_0_6b", "t5_v1_1_xxl")}

_PACKAGE_REQUIREMENT = "tokenizers"


def models_root() -> Path:
    return Path(config.DATA_DIR) / "models" / "tokenizers"


def tokenizer_path(spec: TokenizerSpec) -> Path:
    return models_root() / spec.id / "tokenizer.json"


def tokenizers_installed() -> bool:
    return importlib.util.find_spec("tokenizers") is not None


def _install_package() -> None:
    """Install the ``tokenizers`` package into the app's own environment (a ~3 MB wheel)."""
    import optional_dependencies

    optional_dependencies.ensure_imports([_PACKAGE_REQUIREMENT])
    if not tokenizers_installed():
        raise RuntimeError(
            "tokenizers was installed but cannot be imported yet; restart the program"
        )


def _download_file() -> Callable[..., Path]:
    from services.model_service import _direct_download_file

    return _direct_download_file


# ---- loading ---------------------------------------------------------------

_lock = threading.Lock()
#: ``{id: (path, size, mtime_ns, tokenizer)}`` of tokenizers read and checked already.
_loaded: Dict[str, Any] = {}


def _is_verified(spec: TokenizerSpec) -> bool:
    path = tokenizer_path(spec)
    try:
        if not pinned_download.is_present(path):
            return False
        stat = path.stat()
        cached = _loaded.get(spec.id)
        if cached and cached[:3] == (str(path), stat.st_size, stat.st_mtime_ns):
            return True
        return (
            stat.st_size == spec.file.size_bytes
            and pinned_download.sha256_of(path) == spec.file.sha256
        )
    except OSError:
        return False


def _load_tokenizer(spec: TokenizerSpec) -> Any:
    from tokenizers import Tokenizer

    path = tokenizer_path(spec)
    stat = path.stat()
    with _lock:
        cached = _loaded.get(spec.id)
        if cached and cached[:3] == (str(path), stat.st_size, stat.st_mtime_ns):
            return cached[3]
        tokenizer = Tokenizer.from_file(str(path))
        tokenizer.no_padding()
        tokenizer.no_truncation()
        _loaded[spec.id] = (str(path), stat.st_size, stat.st_mtime_ns, tokenizer)
        return tokenizer


def text_for(spec: TokenizerSpec, text: str) -> str:
    return " ".join(text.split()) if spec.collapse_spaces else text


# ---- status and counting -------------------------------------------------------

_prepare_lock = threading.Lock()
_prepare_state: Dict[str, Any] = {"active": False, "error": None, "step": ""}


def _profile_specs(profile: str) -> List[TokenizerSpec]:
    if profile not in PROFILES:
        raise ValueError(
            f"No tokenizer profile named {profile!r}; supported: {', '.join(PROFILES)}"
        )
    return [SPECS[spec_id] for spec_id in PROFILES[profile]]


def get_status() -> Dict[str, Any]:
    files = [
        {
            "id": spec.id,
            "label": spec.label,
            "size_bytes": spec.file.size_bytes,
            "present": _is_verified(spec),
        }
        for spec in SPECS.values()
    ]
    package = tokenizers_installed()
    with _prepare_lock:
        state = dict(_prepare_state)
    return {
        "available": package and all(f["present"] for f in files),
        "tokenizers_package": package,
        "files": files,
        "download_bytes": sum(f["size_bytes"] for f in files if not f["present"]),
        "download_bytes_total": sum(f["size_bytes"] for f in files),
        "preparing": bool(state["active"]),
        "step": state["step"],
        "error": state["error"],
    }


def count_tokens(profile: str, texts: Sequence[str]) -> Dict[str, Any]:
    """Token counts of each text for every tokenizer of ``profile``.

    ``available`` is false (and ``counts`` empty) while a file or the package is
    missing: the caller says so and keeps its estimate, nothing is guessed here.
    """
    specs = _profile_specs(profile)
    metrics = [{"id": s.id, "label": s.label} for s in specs]
    missing = [s.id for s in specs if not _is_verified(s)]
    if missing or not tokenizers_installed():
        return {
            "profile": profile,
            "available": False,
            "metrics": metrics,
            "missing": missing,
            "counts": [],
        }
    counts: List[Dict[str, int]] = [{} for _ in texts]
    for spec in specs:
        tokenizer = _load_tokenizer(spec)
        encodings = tokenizer.encode_batch(
            [text_for(spec, text) for text in texts],
            add_special_tokens=spec.add_special_tokens,
        )
        for row, encoding in zip(counts, encodings):
            row[spec.id] = len(encoding.ids)
    return {
        "profile": profile,
        "available": True,
        "metrics": metrics,
        "missing": [],
        "counts": counts,
    }


# ---- first use: the package and the files ---------------------------------------


def prepare_blocking() -> None:
    """Install ``tokenizers`` when missing, then fetch each pinned file; raises on failure."""
    if not tokenizers_installed():
        with _prepare_lock:
            _prepare_state["step"] = "package"
        _install_package()
    download = _download_file()
    for spec in SPECS.values():
        with _prepare_lock:
            _prepare_state["step"] = spec.id
        pinned_download.fetch(
            spec.file,
            tokenizer_path(spec),
            download,
            model_name=f"{spec.label} tokenizer",
        )
    with _lock:
        _loaded.clear()


def start_prepare() -> Dict[str, Any]:
    """Run ``prepare_blocking`` on a background thread; one at a time."""
    status = get_status()
    if status["available"]:
        return {"status": "ready"}
    with _prepare_lock:
        if _prepare_state["active"]:
            return {"status": "running"}
        _prepare_state.update({"active": True, "error": None, "step": ""})

    def worker() -> None:
        error: Optional[str] = None
        try:
            prepare_blocking()
        except Exception as exc:  # noqa: BLE001 - shown through the status endpoint
            logger.exception("Tokenizer download failed")
            error = str(exc)
        with _prepare_lock:
            _prepare_state.update({"active": False, "error": error, "step": ""})

    threading.Thread(
        target=worker, name="caption-tokenizer-prepare", daemon=True
    ).start()
    return {"status": "started"}
