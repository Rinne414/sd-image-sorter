"""Where each AI model lives in this process, for ``model_residency``.

Every probe reads ``sys.modules`` only: a model module that was never imported
holds no model, and asking must not import torch or ONNX Runtime. Every
release leaves the model's next use to load it again the way it always does
(the taggers rebuild through their ``_loaded`` flag, the getters build a new
singleton when theirs is gone). Releases run inside the exclusive AI runtime
lease taken by ``ModelResidency``, so none lands in the middle of inference.
They never take a module's own load lock: several getters hold that lock
while they wait for the lease, so taking both here could deadlock. Dropping a
module reference is one assignment; a request still holding the old object
finishes with it.

Prefixes are the labels these models already give their load and inference
leases (``exclusive_ai_runtime("clip-text-inference")`` and so on).
"""

from __future__ import annotations

import sys
from typing import Any, Optional

from model_residency import ModelResidency, ModelSlot

_GPU_PROVIDERS = ("CUDAExecutionProvider", "DmlExecutionProvider")


def _module(name: str) -> Any:
    return sys.modules.get(name)


def _onnx_device(session: Any) -> str:
    try:
        providers = session.get_providers()
    except Exception:  # noqa: BLE001 - not an ONNX session
        return "cpu"
    return "gpu" if any(p in providers for p in _GPU_PROVIDERS) else "cpu"


def _torch_device(model: Any) -> Optional[str]:
    try:
        device_type = next(model.parameters()).device.type
    except Exception:  # noqa: BLE001 - not a torch module
        return None
    return "cpu" if device_type == "cpu" else "gpu"


# ONNX taggers (WD14, CL Tagger v2, OppaiOracle) ------------------------------


def _session_tagger(module_name: str, attr: str) -> Any:
    tagger = getattr(_module(module_name), attr, None)
    if tagger is None or not getattr(tagger, "_loaded", False):
        return None
    return tagger if getattr(tagger, "session", None) is not None else None


def _tagger_slot(key: str, module_name: str, attr: str, prefixes: tuple) -> ModelSlot:
    def probe() -> Optional[str]:
        tagger = _session_tagger(module_name, attr)
        return _onnx_device(tagger.session) if tagger is not None else None

    def release() -> None:
        tagger = _session_tagger(module_name, attr)
        if tagger is not None:
            tagger.release_session()

    return ModelSlot(key, prefixes, probe, release)


# CLIP similarity / semantic search --------------------------------------------


def _clip_probe() -> Optional[str]:
    similarity = _module("similarity")
    if similarity is None:
        return None
    loaded = (
        similarity._embed_model is not None or similarity._text_embed_model is not None
    )
    # FastEmbed is built without a GPU provider here, so CLIP runs on the CPU.
    return "cpu" if loaded else None


def _clip_release() -> None:
    similarity = _module("similarity")
    if similarity is None:
        return
    similarity._embed_model = None
    similarity._text_embed_model = None


# Aesthetic (CLIP-L head + the anime grade) --------------------------------------


def _aesthetic_probe() -> Optional[str]:
    aesthetic = _module("aesthetic")
    anime = _module("anime_aesthetic")
    if aesthetic is not None and aesthetic._predictor is not None:
        return "gpu" if aesthetic._device == "cuda" else "cpu"
    if anime is not None and anime._session is not None:
        return "gpu" if anime._session_uses_gpu else "cpu"
    return None


def _aesthetic_release() -> None:
    aesthetic = _module("aesthetic")
    if aesthetic is not None:
        aesthetic._unload_models()
        return
    anime = _module("anime_aesthetic")
    if anime is not None:
        anime.unload()


# Artist identification (Kaloscope) and style vectors (CSD) ---------------------


def _artist_identifier() -> Any:
    identifier = getattr(_module("artist_identifier"), "_identifier", None)
    if identifier is None or not identifier.model_loaded:
        return None
    return identifier


def _artist_probe() -> Optional[str]:
    identifier = _artist_identifier()
    if identifier is None:
        return None
    session = getattr(identifier, "_session", None)
    if session is not None:
        return _onnx_device(session)
    return _torch_device(identifier._model) or ("gpu" if identifier.use_gpu else "cpu")


def _artist_release() -> None:
    module = _module("artist_identifier")
    if module is None:
        return
    module._identifier = None


def _csd_probe() -> Optional[str]:
    encoder = getattr(_module("csd_encoder"), "_encoder", None)
    if encoder is None or not encoder.model_loaded:
        return None
    return "cpu" if str(encoder._device or "cpu").startswith("cpu") else "gpu"


def _csd_release() -> None:
    encoder = getattr(_module("csd_encoder"), "_encoder", None)
    if encoder is not None:
        encoder.release()


# Censor detection (YOLO, NudeNet) ------------------------------------------------


def _censor_probe() -> Optional[str]:
    detector = getattr(_module("censor"), "_detector", None)
    if detector is None:
        return None
    if detector.session is None and detector.runtime is None:
        return None
    if detector.runtime is None:
        return _onnx_device(detector.session)
    return _torch_device(getattr(detector.runtime, "model", None)) or "cpu"


def _censor_release() -> None:
    module = _module("censor")
    if module is None:
        return
    module._detector = None


def _nudenet_probe() -> Optional[str]:
    detector = getattr(_module("nudenet_detector"), "_detector", None)
    if detector is None:
        return None
    session = getattr(detector, "onnx_session", None)
    return _onnx_device(session) if session is not None else "cpu"


def _nudenet_release() -> None:
    module = _module("nudenet_detector")
    if module is None:
        return
    module._detector = None


# Captioning (ToriiGate, Florence-2) ----------------------------------------------


def _toriigate_probe() -> Optional[str]:
    tagger = getattr(_module("toriigate_tagger"), "_toriigate_tagger", None)
    if tagger is None or tagger.model is None:
        return None
    return "cpu" if tagger.device == "cpu" else "gpu"


def _toriigate_release() -> None:
    tagger = getattr(_module("toriigate_tagger"), "_toriigate_tagger", None)
    if tagger is not None and tagger.model is not None:
        tagger._loaded = False
        tagger._teardown_model()


def _florence2_probe() -> Optional[str]:
    module = _module("florence2_captioner")
    devices = list(getattr(module, "_runtime_by_device", None) or {})
    if not devices:
        return None
    return "gpu" if any(device != "cpu" for device in devices) else "cpu"


def _florence2_release() -> None:
    module = _module("florence2_captioner")
    if module is None:
        return
    module._runtime_by_device.clear()


def register_default_slots(residency: ModelResidency) -> None:
    """Describe every model holder this program has."""
    slots = (
        _tagger_slot("tagger", "tagger", "_tagger", ("wd14-tagger", "tagger-load:")),
        _tagger_slot(
            "cl-tagger", "cl_tagger_v2", "_tagger_singleton", ("cl-tagger-v2",)
        ),
        _tagger_slot(
            "oppai-tagger",
            "oppai_oracle_tagger",
            "_tagger_singleton",
            ("oppai-oracle",),
        ),
        ModelSlot("clip", ("clip-",), _clip_probe, _clip_release),
        ModelSlot("aesthetic", ("aesthetic",), _aesthetic_probe, _aesthetic_release),
        ModelSlot("artist", ("artist-",), _artist_probe, _artist_release),
        ModelSlot("style", ("csd-",), _csd_probe, _csd_release),
        ModelSlot("censor", ("censor-",), _censor_probe, _censor_release),
        ModelSlot("nudenet", ("nudenet",), _nudenet_probe, _nudenet_release),
        ModelSlot("toriigate", ("toriigate",), _toriigate_probe, _toriigate_release),
        ModelSlot("florence2", ("florence2",), _florence2_probe, _florence2_release),
    )
    for slot in slots:
        residency.register(slot)
