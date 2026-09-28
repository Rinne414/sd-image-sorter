"""
LAION Aesthetic Predictor integration.

Uses CLIP ViT-L/14 embeddings + a tiny linear head trained on human aesthetic ratings.
Outputs a score from ~1 to ~10. The bulk download is about 1.7 GB (ViT-L/14
backbone + head). Model Manager Prepare / Download is the supported install
path. If files are still missing, scoring may fetch them from Hugging Face.

Waifu Scorer V3 is an optional anime aesthetic head (0-10) on the same
normalized CLIP embedding: once its 11 MB file is installed, the same CLIP
pass yields both scores.
"""
import logging
import os
import threading
import warnings
from dataclasses import dataclass
from typing import Any, Callable, Dict, Optional
from pathlib import Path

import pinned_download

from ai_runtime_guard import (
    PRIORITY_NORMAL,
    clear_torch_cuda_cache,
    cuda_has_headroom,
    exclusive_ai_runtime,
    looks_like_cuda_oom,
)
from model_download_sources import apply_hf_endpoint, endpoint_label, get_hf_endpoint_order

logger = logging.getLogger(__name__)

_predictor = None
_clip_model = None
_clip_preprocess = None
_device = None
_load_lock = threading.Lock()
_inference_lock = threading.Lock()
_force_cpu_after_gpu_failure = False
_waifu_head = None
# Set when the installed Waifu file cannot be loaded, so every picture does
# not retry it; cleared by a fresh Prepare / Download or a model reload.
_waifu_head_failed = False

# Cache for is_available() so the frontend's /api/aesthetic/status poll does
# not run a fresh ``import torch`` on every call. When torch is absent (the
# default lightweight-mode state until Setup Now → Prepare for Aesthetic Score
# is clicked), the previous code logged the same WARNING line on every poll,
# producing repeated "Aesthetic predictor torch import failed: No module
# named 'torch'" entries in the launcher console. The cache is invalidated
# by reset_availability_cache(), which the model-service prepare flow calls
# after installing the aesthetic dependency group.
_availability_cache: Optional[bool] = None
_availability_cache_lock = threading.Lock()
_availability_warning_logged: bool = False

_MIN_AESTHETIC_CUDA_FREE_MB = 3800
_AESTHETIC_HEAD_FILENAME = "sa_0_4_vit_l_14_linear.pth"
# Bumped when stored scores stop being comparable: 2 = CLIP built with QuickGELU.
AESTHETIC_SCORE_VERSION = 2
_AESTHETIC_BACKBONE_REPO_DIR = "models--timm--vit_large_patch14_clip_224.openai"
_AESTHETIC_BACKBONE_FILENAMES = (
    "open_clip_model.safetensors",
    "pytorch_model.bin",
    "ViT-L-14.pt",
)

WAIFU_HEAD_FILENAME = "waifu_scorer_v3.safetensors"
WAIFU_HEAD_FILE = pinned_download.PinnedFile(
    repo="Eugeoter/waifu-scorer-v3",
    revision="c2a747fd61d310a90e9cbbf8fc590c522f234424",
    remote_path="model.safetensors",
    sha256="7def1b66314e318d9b045ff225fd51bb83bfbca855b12b2e213a5483efe37efd",
    size_bytes=11_219_340,
)
WAIFU_SCORE_MIN = 0.0
WAIFU_SCORE_MAX = 10.0


@dataclass(frozen=True)
class AestheticScores:
    """Scores from one CLIP pass: LAION (~1-10) and, when installed, Waifu Scorer V3 (0-10)."""

    laion: float
    waifu: Optional[float] = None


def _get_models_dir() -> Path:
    models_dir = Path(__file__).parent.parent / "models" / "aesthetic"
    models_dir.mkdir(parents=True, exist_ok=True)
    return models_dir


def _is_nonempty_file(path: Path) -> bool:
    try:
        return path.is_file() and path.stat().st_size > 0
    except OSError:
        return False


def _aesthetic_cache_roots() -> tuple[Path, ...]:
    """Return deterministic cache roots used by open_clip and Hugging Face."""
    roots: list[Path] = []
    hf_home = str(os.environ.get("HF_HOME") or "").strip()
    if hf_home:
        roots.append(Path(hf_home) / "hub")
    roots.append(Path.home() / ".cache" / "huggingface" / "hub")
    torch_home = str(os.environ.get("TORCH_HOME") or "").strip()
    if torch_home:
        roots.append(Path(torch_home) / "checkpoints")
    roots.extend(
        (
            Path.home() / ".cache" / "clip",
            Path.home() / ".cache" / "torch" / "hub" / "checkpoints",
        )
    )
    unique: list[Path] = []
    seen: set[str] = set()
    for root in roots:
        key = os.path.normcase(str(root.resolve(strict=False)))
        if key in seen:
            continue
        seen.add(key)
        unique.append(root)
    return tuple(unique)


def get_aesthetic_backbone_path() -> Optional[Path]:
    """Return a non-empty local ViT-L/14 checkpoint used by open_clip."""
    for cache_root in _aesthetic_cache_roots():
        snapshot_root = cache_root / _AESTHETIC_BACKBONE_REPO_DIR / "snapshots"
        if snapshot_root.is_dir():
            for snapshot in sorted(snapshot_root.iterdir(), reverse=True):
                for filename in _AESTHETIC_BACKBONE_FILENAMES[:2]:
                    candidate = snapshot / filename
                    if _is_nonempty_file(candidate):
                        return candidate.resolve()
        for filename in _AESTHETIC_BACKBONE_FILENAMES:
            candidate = cache_root / filename
            if _is_nonempty_file(candidate):
                return candidate.resolve()
    return None


def waifu_head_path() -> Path:
    return _get_models_dir() / WAIFU_HEAD_FILENAME


def is_waifu_installed() -> bool:
    return pinned_download.is_present(waifu_head_path())


def is_waifu_scoring() -> bool:
    """Installed and not known to be unloadable: only then do runs ask for Waifu scores.

    A file that failed to load would otherwise keep every scored picture in
    the "to score" queue forever while its Waifu score stays empty.
    """
    return is_waifu_installed() and not _waifu_head_failed


def waifu_health() -> Dict[str, Any]:
    path = waifu_head_path()
    installed = is_waifu_installed()
    if installed and _waifu_head_failed:
        key, message = (
            "models.aestheticWaifu.broken",
            "The Waifu Scorer V3 file could not be loaded. Click Prepare / Download to replace it.",
        )
    elif installed:
        key, message = (
            "models.aestheticWaifu.ready",
            "Waifu Scorer V3 is installed. The next aesthetic scoring run adds its score.",
        )
    else:
        key, message = (
            "models.aestheticWaifu.missing",
            "Not downloaded yet. Click Prepare / Download (~11 MB, plus the Aesthetic Predictor).",
        )
    return {
        "available": installed and not _waifu_head_failed,
        "head_path": str(path) if installed else None,
        "expected_path": str(path),
        "message_key": key,
        "message": message,
    }


def prepare_waifu_head(download_file: Callable[..., Path]) -> Path:
    """Download and verify the Waifu Scorer V3 head; a verified copy is kept as is."""
    global _waifu_head_failed

    path = pinned_download.fetch(
        WAIFU_HEAD_FILE, waifu_head_path(), download_file, model_name="Waifu Scorer V3"
    )
    _waifu_head_failed = False
    return path


def is_predictor_loaded() -> bool:
    """Return whether both predictor components are loaded in this process."""
    return _predictor is not None and _clip_model is not None


def is_fully_ready() -> bool:
    """Return whether dependencies, head, and CLIP backbone are all ready."""
    head_path = _get_models_dir() / _AESTHETIC_HEAD_FILENAME
    return bool(
        is_available()
        and _is_nonempty_file(head_path)
        and (is_predictor_loaded() or get_aesthetic_backbone_path() is not None)
    )


def _get_torch_module():
    import torch

    return torch


def _cuda_has_headroom(torch_module, min_free_mb: int = _MIN_AESTHETIC_CUDA_FREE_MB) -> bool:
    return cuda_has_headroom(torch_module, min_free_mb=min_free_mb)


def _select_device(*, use_gpu: bool = True) -> str:
    global _force_cpu_after_gpu_failure

    if not use_gpu or _force_cpu_after_gpu_failure:
        return "cpu"

    torch = _get_torch_module()
    if not torch.cuda.is_available():
        return "cpu"
    if not _cuda_has_headroom(torch, _MIN_AESTHETIC_CUDA_FREE_MB):
        logger.warning(
            "Aesthetic predictor skipped GPU because free VRAM is below %d MB. Using CPU.",
            _MIN_AESTHETIC_CUDA_FREE_MB,
        )
        return "cpu"
    return "cuda"


def _is_cuda_oom(exc: BaseException) -> bool:
    return looks_like_cuda_oom(exc)


def _unload_models() -> None:
    global _predictor, _clip_model, _clip_preprocess, _device, _waifu_head, _waifu_head_failed

    _predictor = None
    _clip_model = None
    _clip_preprocess = None
    _waifu_head = None
    _waifu_head_failed = False
    previous_device = _device
    _device = None
    try:
        if previous_device == "cuda":
            clear_torch_cuda_cache()
    except Exception:
        logger.debug("Aesthetic model cache clear failed", exc_info=True)


def _ensure_loaded(device: Optional[str] = None):
    """Lazy-load CLIP + aesthetic head on first call."""
    global _predictor, _clip_model, _clip_preprocess, _device

    target_device = device or _select_device(use_gpu=True)
    if _predictor is not None and _device == target_device and not _waifu_head_pending():
        return

    with _load_lock:
        if _predictor is not None and _device != target_device:
            _unload_models()
        if _predictor is None:
            _load_predictor(target_device)
        elif _waifu_head_pending():
            # Installed while CLIP was already loaded: add just the head.
            _load_waifu_head()


def _waifu_head_pending() -> bool:
    return _waifu_head is None and not _waifu_head_failed and is_waifu_installed()


def _build_waifu_head(torch, path: Path, device: str):
    """Waifu Scorer V3's MLP; the published weights use ``layers.<n>`` keys."""
    from safetensors.torch import load_file

    nn = torch.nn
    layers = nn.Sequential(
        nn.Linear(768, 2048),
        nn.ReLU(),
        nn.BatchNorm1d(2048),
        nn.Dropout(0.3),
        nn.Linear(2048, 512),
        nn.ReLU(),
        nn.BatchNorm1d(512),
        nn.Dropout(0.3),
        nn.Linear(512, 256),
        nn.ReLU(),
        nn.BatchNorm1d(256),
        nn.Dropout(0.2),
        nn.Linear(256, 128),
        nn.ReLU(),
        nn.BatchNorm1d(128),
        nn.Dropout(0.1),
        nn.Linear(128, 32),
        nn.ReLU(),
        nn.Linear(32, 1),
    )
    state = load_file(str(path), device="cpu")
    layers.load_state_dict({key.removeprefix("layers."): value for key, value in state.items()})
    return layers.to(device).eval()


def _load_waifu_head() -> None:
    """Load the optional head; a bad file only loses the Waifu score, never LAION's."""
    global _waifu_head, _waifu_head_failed

    try:
        _waifu_head = _build_waifu_head(_get_torch_module(), waifu_head_path(), _device or "cpu")
        logger.info("Waifu Scorer V3 head loaded")
    except Exception as exc:
        _waifu_head = None
        _waifu_head_failed = True
        logger.error(
            "Waifu Scorer V3 head at %s could not be loaded (%s). Aesthetic scoring continues "
            "without it; run Prepare / Download on its Model Center card to replace the file.",
            waifu_head_path(),
            exc,
        )


def _load_predictor(device: Optional[str] = None):
    """Load CLIP + aesthetic head under the singleton load lock."""
    global _predictor, _clip_model, _clip_preprocess, _device

    try:
        torch = _get_torch_module()
        import torch.nn as nn

        _device = device or _select_device(use_gpu=True)
        logger.info(f"Loading aesthetic predictor on {_device}")

        # Load CLIP
        try:
            import open_clip
            endpoint = get_hf_endpoint_order(model_name="Aesthetic CLIP")[0]
            apply_hf_endpoint(endpoint, purpose="Aesthetic CLIP / open_clip")
            logger.info("open_clip aesthetic backbone will prefer %s.", endpoint_label(endpoint))
            with warnings.catch_warnings():
                warnings.filterwarnings(
                    "ignore",
                    message="Warning: You are sending unauthenticated requests to the HF Hub.*",
                    category=UserWarning,
                )
                # The OpenAI weights (and the LAION head trained on their
                # embeddings) use QuickGELU; the "ViT-L-14" config defaults to
                # GELU. The mismatch warning used to be silenced here, which
                # put every score off by up to about a point.
                model, _, preprocess = open_clip.create_model_and_transforms(
                    "ViT-L-14", pretrained="openai", device=_device, force_quick_gelu=True
                )
            model.eval()
            _clip_model = model
            _clip_preprocess = preprocess
        except ImportError:
            import clip
            model, preprocess = clip.load("ViT-L/14", device=_device)
            model.eval()
            _clip_model = model
            _clip_preprocess = preprocess

        # Download and load aesthetic linear head
        weights_path = _get_models_dir() / _AESTHETIC_HEAD_FILENAME
        if not _is_nonempty_file(weights_path):
            logger.info("Downloading aesthetic predictor weights...")
            from services.model_service import _direct_download_file

            url = "https://github.com/LAION-AI/aesthetic-predictor/raw/main/sa_0_4_vit_l_14_linear.pth"
            _direct_download_file(url, weights_path, timeout=120)
            logger.info("Download complete")

        # LAION's published predictor is a simple linear estimator on top of
        # normalized CLIP embeddings, not a deep MLP.
        head = nn.Linear(768, 1)
        state = torch.load(str(weights_path), map_location=_device, weights_only=True)
        head.load_state_dict(state)
        head.to(_device)
        head.eval()
        _predictor = head
        if _waifu_head_pending():
            _load_waifu_head()
        logger.info("Aesthetic predictor loaded successfully")

    except Exception as e:
        logger.error(f"Failed to load aesthetic predictor: {e}")
        _unload_models()
        raise


def _predict_scores_loaded(image_path: str) -> AestheticScores:
    torch = _get_torch_module()
    from PIL import Image

    assert _clip_preprocess is not None
    assert _clip_model is not None
    assert _predictor is not None

    with Image.open(image_path) as img:
        img_tensor = _clip_preprocess(img.convert("RGB")).unsqueeze(0).to(_device)

    waifu = None
    with torch.no_grad():
        features = _clip_model.encode_image(img_tensor)
        features = (features / features.norm(dim=-1, keepdim=True)).float()
        laion = _predictor(features)
        if _waifu_head is not None:
            waifu = _waifu_head(features).clamp(WAIFU_SCORE_MIN, WAIFU_SCORE_MAX)

    result = AestheticScores(
        laion=round(float(laion.item()), 4),
        waifu=None if waifu is None else round(float(waifu.item()), 4),
    )
    del img_tensor, features, laion, waifu
    return result


def predict_scores(
    image_path: str, priority: int = PRIORITY_NORMAL
) -> Optional[AestheticScores]:
    """Score one image: LAION (~1-10) plus Waifu (0-10) when installed; None on error.

    ``priority`` is the AI-runtime admission lane and is supplied by the caller,
    because this function serves both ``POST /api/aesthetic/score/{id}`` (one
    image, user waiting) and the ``score-all`` background job, which calls it
    once per library image. Pinning the interactive lane here would give that job
    the highest priority in the app.
    """
    global _force_cpu_after_gpu_failure

    try:
        with exclusive_ai_runtime("aesthetic", priority=priority), _inference_lock:
            _ensure_loaded()
            try:
                return _predict_scores_loaded(image_path)
            except Exception as exc:
                if _device != "cuda" or not _is_cuda_oom(exc):
                    raise
                logger.warning(
                    "Aesthetic GPU inference ran out of memory. Unloading GPU model and retrying once on CPU: %s",
                    exc,
                )
                _force_cpu_after_gpu_failure = True
                _unload_models()
                _ensure_loaded("cpu")
                return _predict_scores_loaded(image_path)

    except Exception as e:
        logger.error(f"Aesthetic prediction failed for {image_path}: {e}")
        return None


def is_available() -> bool:
    """Check if the required dependencies are installed.

    Catches both ImportError (missing package) AND OSError (DLL load failure
    on Windows when torch's cudnn / cuda chain is broken). Without the
    OSError catch, ``/api/aesthetic/status`` returned 500 to the user any
    time a system had a broken torch runtime - even though the rest of the
    app still works. The frontend's "aesthetic unavailable" toast is far
    more useful than an unhandled 500.

    Result is cached at module scope so the frontend's repeated
    ``/api/aesthetic/status`` poll does not retry ``import torch`` (and
    re-log the same WARNING) on every call. Call
    :func:`reset_availability_cache` after installing the aesthetic
    dependency group so the next status check picks up the new state.
    """
    global _availability_cache, _availability_warning_logged

    cached = _availability_cache
    if cached is not None:
        return cached

    with _availability_cache_lock:
        if _availability_cache is not None:
            return _availability_cache

        try:
            import torch  # noqa: F401
            try:
                import open_clip  # noqa: F401
            except (ImportError, OSError):
                try:
                    import clip  # noqa: F401
                except (ImportError, OSError):
                    _availability_cache = False
                    return False
            _availability_cache = True
            return True
        except (ImportError, OSError) as exc:
            if not _availability_warning_logged:
                # First failure in this process: WARNING so the launcher
                # console flags the missing runtime once. Subsequent polls
                # of /api/aesthetic/status hit the cache above and stay
                # silent, so the previous "log spam every 5 seconds"
                # behaviour is gone.
                logger.warning(
                    "Aesthetic predictor torch import failed: %s. "
                    "Aesthetic Score is part of the optional AI runtime; "
                    "click Setup Now → Prepare for Aesthetic Score (or set "
                    "SD_IMAGE_SORTER_INSTALL_FULL_AI=1 before launch) to install "
                    "torch + open_clip.",
                    exc,
                )
                _availability_warning_logged = True
            _availability_cache = False
            return False


def reset_availability_cache() -> None:
    """Invalidate the cached :func:`is_available` result.

    Called by the model-service prepare flow after installing the aesthetic
    dependency group so the frontend's next ``/api/aesthetic/status`` poll
    re-runs the import check and discovers the freshly-installed runtime.
    Also resets the "warning already logged" flag so a subsequent failure
    is reported once.
    """
    global _availability_cache, _availability_warning_logged
    with _availability_cache_lock:
        _availability_cache = None
        _availability_warning_logged = False
