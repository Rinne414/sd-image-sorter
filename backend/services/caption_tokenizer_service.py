"""Exact caption token counts with the tokenizers each base model reads captions with.

* Anima: Qwen3-0.6B plus a T5 v1.1 XXL tokenizer, so a caption has two lengths:
  Qwen3 tokens (no special tokens added) and T5 tokens (one end token added).
* FLUX: T5 v1.1 XXL, 512 tokens (the CLIP-L pooled vector is a summary).
* Krea 2: a Qwen3-VL encoder. Its tokenizer is Qwen3's: the same vocabulary,
  merges, pre-tokenizer and added tokens as Qwen3-0.6B's tokenizer.json
  (Qwen/Qwen3-VL-4B-Instruct, checked 2026-10-27, and the same token ids on
  4,000 generated captions), so the Qwen3-0.6B file counts it. The diffusers
  Krea2Pipeline (v0.42.1, ``get_text_hidden_states``) puts a 34-token system
  prefix before the caption, truncates at 512 + 34 - 5 and drops the prefix, so
  a caption keeps 507 tokens, not 512.
* SDXL (and no base model chosen): CLIP ViT-L/14. SDXL's two text encoders
  share its vocabulary and merges (stabilityai/stable-diffusion-xl-base-1.0
  tokenizer and tokenizer_2), and the fast tokenizer.json counted the same as
  transformers' CLIPTokenizer with ftfy (what kohya's sd-scripts uses) on 4,000
  generated captions. Counted without the start and end tokens: 75 fit.

The estimate the Check step used before ("one token per four letters") is only
close for CLIP; these numbers are exact.

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
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

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
    # OpenAI's CLIP tokenizer (MIT, github.com/openai/CLIP); its normalizer
    # already folds whitespace runs and case, as CLIP's own tokenizer does.
    "clip_vit_l_14": TokenizerSpec(
        id="clip_vit_l_14",
        label="CLIP ViT-L/14",
        file=pinned_download.PinnedFile(
            repo="openai/clip-vit-large-patch14",
            revision="32bd64288804d66eefd0ccbe215aa642df71cc41",
            remote_path="tokenizer.json",
            sha256="a83e0809aa4c3af7208b2df632a7a69668c6d48775b3c3fe4e1b1199d1f8b8f4",
            size_bytes=2_224_003,
        ),
        add_special_tokens=False,
        collapse_spaces=False,
    ),
}


@dataclass(frozen=True)
class CountProfile:
    """How one base model reads a caption: with which tokenizers, and how many tokens fit."""

    label: str
    tokenizers: Tuple[str, ...]
    #: Tokens of the caption the model keeps; a count over it is cut.
    limit: int


#: Which tokenizers a base model's captions are counted with, by target model.
#: No base model chosen counts as CLIP (``sdxl``), as the estimate always did.
PROFILES: Dict[str, CountProfile] = {
    "sdxl": CountProfile("SDXL", ("clip_vit_l_14",), 75),
    "flux": CountProfile("FLUX", ("t5_v1_1_xxl",), 512),
    "krea2": CountProfile("Krea 2", ("qwen3_0_6b",), 507),
    "anima": CountProfile("Anima", ("qwen3_0_6b", "t5_v1_1_xxl"), 512),
}
DEFAULT_PROFILE = "anima"

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
# One download at a time; a model asked for while another downloads waits its
# turn. Each model has its own "preparing" and its own error.
_prepare_state: Dict[str, Any] = {"active": False, "queue": [], "errors": {}, "step": ""}


def _profile(profile: str) -> CountProfile:
    if profile not in PROFILES:
        raise ValueError(
            f"No tokenizer profile named {profile!r}; supported: {', '.join(PROFILES)}"
        )
    return PROFILES[profile]


def _profile_specs(profile: str) -> List[TokenizerSpec]:
    return [SPECS[spec_id] for spec_id in _profile(profile).tokenizers]


def get_status(profile: str = DEFAULT_PROFILE) -> Dict[str, Any]:
    """Whether ``profile``'s tokenizers are here; a file another model needs does not count."""
    files = [
        {
            "id": spec.id,
            "label": spec.label,
            "size_bytes": spec.file.size_bytes,
            "present": _is_verified(spec),
        }
        for spec in _profile_specs(profile)
    ]
    package = tokenizers_installed()
    with _prepare_lock:
        waiting = profile in _prepare_state["queue"]
        current = bool(_prepare_state["queue"]) and _prepare_state["queue"][0] == profile
        step = _prepare_state["step"] if current else ""
        error = _prepare_state["errors"].get(profile)
    return {
        "profile": profile,
        "model": PROFILES[profile].label,
        "limit": PROFILES[profile].limit,
        "available": package and all(f["present"] for f in files),
        "tokenizers_package": package,
        "files": files,
        "download_bytes": sum(f["size_bytes"] for f in files if not f["present"]),
        "download_bytes_total": sum(f["size_bytes"] for f in files),
        "preparing": waiting,
        "step": step,
        "error": error,
    }


def count_tokens(profile: str, texts: Sequence[str]) -> Dict[str, Any]:
    """Token counts of each text for every tokenizer of ``profile``.

    ``available`` is false (and ``counts`` empty) while a file or the package is
    missing: the caller says so and keeps its estimate, nothing is guessed here.
    """
    specs = _profile_specs(profile)
    metrics = [{"id": s.id, "label": s.label} for s in specs]
    missing = [s.id for s in specs if not _is_verified(s)]
    limit = PROFILES[profile].limit
    if missing or not tokenizers_installed():
        return {
            "profile": profile,
            "limit": limit,
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
        "limit": limit,
        "available": True,
        "metrics": metrics,
        "missing": [],
        "counts": counts,
    }


# ---- first use: the package and the files ---------------------------------------


def prepare_blocking(profile: str = DEFAULT_PROFILE) -> None:
    """Install ``tokenizers`` when missing, then fetch ``profile``'s pinned files; raises on failure."""
    specs = _profile_specs(profile)
    if not tokenizers_installed():
        with _prepare_lock:
            _prepare_state["step"] = "package"
        _install_package()
    download = _download_file()
    for spec in specs:
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


def start_prepare(profile: str = DEFAULT_PROFILE) -> Dict[str, Any]:
    """Queue ``profile``'s download and run the queue on a background thread, one at a time."""
    status = get_status(profile)
    if status["available"]:
        return {"status": "ready"}
    with _prepare_lock:
        if profile in _prepare_state["queue"]:
            return {"status": "running"}
        _prepare_state["queue"].append(profile)
        _prepare_state["errors"].pop(profile, None)
        if _prepare_state["active"]:
            return {"status": "queued"}
        _prepare_state["active"] = True

    def worker() -> None:
        while True:
            with _prepare_lock:
                if not _prepare_state["queue"]:
                    _prepare_state.update({"active": False, "step": ""})
                    return
                current = _prepare_state["queue"][0]
                _prepare_state["step"] = ""
            error: Optional[str] = None
            try:
                prepare_blocking(current)
            except Exception as exc:  # noqa: BLE001 - shown through the status endpoint
                logger.exception("Tokenizer download failed")
                error = str(exc)
            with _prepare_lock:
                _prepare_state["queue"].pop(0)
                if error:
                    _prepare_state["errors"][current] = error

    threading.Thread(
        target=worker, name="caption-tokenizer-prepare", daemon=True
    ).start()
    return {"status": "started"}
