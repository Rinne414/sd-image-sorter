"""Torch/runtime probing helpers (split from model_health.py, 2026-07).

_module_available / _module_installed / _probe_loaded_torch_runtime /
_probe_torch_runtime moved here verbatim. Nothing here runs at import time: the 45s-timeout torch subprocess is
forked only when _probe_torch_runtime is CALLED (and torch is not already in
sys.modules), so importing this module stays light. _probe_torch_runtime
resolves _probe_loaded_torch_runtime back through _svc() at call time so
monkeypatches on the facade module keep affecting behavior; sys / warnings /
importlib are process-global singletons, so direct stdlib imports here
observe the same patches (e.g. model_health.sys.platform).
"""
from __future__ import annotations

import importlib
import importlib.util
import json
import subprocess
import sys
import warnings
from importlib import metadata
from typing import Any, Dict, Optional, Tuple


def _svc():
    """Resolve facade-patched seams through model_health at call time.

    Tests monkeypatch seam names on the facade module object; a ``from``
    import here would freeze an independent binding those patches silently
    miss. The lazy
    import avoids a facade<->sibling load cycle.
    """
    import model_health

    return model_health


def _module_available(module_name: str) -> bool:
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            importlib.import_module(module_name)
        return True
    except Exception:
        return False


def _module_installed(module_name: str) -> bool:
    try:
        return importlib.util.find_spec(module_name) is not None
    except Exception:
        return False


def _probe_loaded_torch_runtime() -> Dict[str, Any]:
    result: Dict[str, Any] = {
        "torch_version": None,
        "torch_cuda_build": None,
        "torch_cuda_available": False,
        "torch_probe_error": None,
        "torch_probe_source": "current-process",
    }
    try:
        torch = sys.modules.get("torch")
        if torch is None:
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                torch = importlib.import_module("torch")
        result["torch_version"] = getattr(torch, "__version__", None)
        result["torch_cuda_build"] = getattr(getattr(torch, "version", None), "cuda", None)
        result["torch_cuda_available"] = bool(torch.cuda.is_available())
    except Exception as exc:
        result["torch_probe_error"] = str(exc)
    return result


# The subprocess answer, per Python and installed torch version: importing
# torch takes about 2 s, and /api/models/status asked twice on every call
# (3.8 s each time, 7.1 s the first; the program's first page waited for it,
# measured 2026-11-08). Installing another torch changes the version and the
# next status asks again; a probe that failed or timed out is not kept.
_TORCH_PROBE_CACHE: Dict[Tuple[str, Optional[str]], Dict[str, Any]] = {}


def _installed_torch_version() -> Optional[str]:
    try:
        return metadata.version("torch")
    except Exception:
        return None


def clear_torch_probe_cache() -> None:
    _TORCH_PROBE_CACHE.clear()


def _probe_torch_runtime() -> Dict[str, Any]:
    if "torch" in sys.modules:
        return _svc()._probe_loaded_torch_runtime()
    key = (sys.executable, _installed_torch_version())
    cached = _TORCH_PROBE_CACHE.get(key)
    if cached is not None:
        return dict(cached)
    result, answered = _run_torch_probe()
    if answered:
        _TORCH_PROBE_CACHE[key] = dict(result)
    return result


def _run_torch_probe() -> Tuple[Dict[str, Any], bool]:
    """Import torch in a subprocess; the flag says whether it answered."""
    code = r'''
import json
from importlib import metadata
result = {
    "torch_version": None,
    "torch_cuda_build": None,
    "torch_cuda_available": False,
    "torch_probe_error": None,
    "torch_probe_source": "subprocess",
}
try:
    result["torch_version"] = metadata.version("torch")
except Exception:
    pass
try:
    import torch
    result["torch_version"] = getattr(torch, "__version__", result["torch_version"])
    result["torch_cuda_build"] = getattr(getattr(torch, "version", None), "cuda", None)
    result["torch_cuda_available"] = bool(torch.cuda.is_available())
except Exception as exc:
    result["torch_probe_error"] = str(exc)
# The card's name and memory are extras: torch works even when they cannot be read.
if result["torch_cuda_available"] and not result["torch_probe_error"]:
    try:
        result["gpu_name"] = torch.cuda.get_device_name(0)
        result["gpu_vram_total_mb"] = round(torch.cuda.get_device_properties(0).total_memory / (1024 ** 2))
    except Exception:
        pass
print(json.dumps(result))
'''.strip()
    try:
        completed = subprocess.run(
            [sys.executable, "-c", code],
            capture_output=True,
            text=True,
            timeout=45,
            check=False,
        )
    except Exception as exc:
        return {
            "torch_version": None,
            "torch_cuda_build": None,
            "torch_cuda_available": False,
            "torch_probe_error": str(exc),
            "torch_probe_source": "subprocess",
        }, False

    if completed.returncode != 0:
        return {
            "torch_version": None,
            "torch_cuda_build": None,
            "torch_cuda_available": False,
            "torch_probe_error": (completed.stderr or completed.stdout or f"exit {completed.returncode}").strip(),
            "torch_probe_source": "subprocess",
        }, False

    try:
        parsed = json.loads((completed.stdout or "{}").strip().splitlines()[-1])
    except Exception as exc:
        return {
            "torch_version": None,
            "torch_cuda_build": None,
            "torch_cuda_available": False,
            "torch_probe_error": f"Could not parse torch probe output: {exc}",
            "torch_probe_source": "subprocess",
        }, False

    return {
        "torch_version": parsed.get("torch_version"),
        "torch_cuda_build": parsed.get("torch_cuda_build"),
        "torch_cuda_available": bool(parsed.get("torch_cuda_available")),
        "torch_probe_error": parsed.get("torch_probe_error"),
        "torch_probe_source": parsed.get("torch_probe_source") or "subprocess",
        "gpu_name": parsed.get("gpu_name"),
        "gpu_vram_total_mb": parsed.get("gpu_vram_total_mb"),
    }, True
