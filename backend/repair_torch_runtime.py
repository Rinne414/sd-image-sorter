"""Repair Windows PyTorch runtime selection for portable installs.

The normal requirements file intentionally uses PyPI's cross-machine Torch
package. On Windows that resolves to CPU-only Torch, so the launcher has to
switch NVIDIA users to the matching PyTorch CUDA wheel after hardware detection.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import platform
import re
import subprocess
import sys
from importlib import metadata
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

# Embedded Python (used by the portable Windows launcher) ships a
# ``python312._pth`` file that fully controls ``sys.path``. Unlike a normal
# Python install, the embedded distribution does NOT auto-prepend the running
# script's directory, so sibling imports such as ``from repair_onnxruntime
# import ...`` fail with ``ModuleNotFoundError`` even though the file lives
# right next to this script. We re-add the script directory ourselves so the
# module resolution behaves the same as a developer venv. Tests for this
# bootstrap live in ``tests/test_repair_torch_runtime.py``.
_THIS_DIR = str(Path(__file__).resolve().parent)
if _THIS_DIR not in sys.path:
    sys.path.insert(0, _THIS_DIR)

logger = logging.getLogger(__name__)

try:
    from repair_onnxruntime import _detect_gpu_vendor
except ImportError as _exc:  # pragma: no cover - defensive fallback for direct reuse
    logger.warning(
        "repair_onnxruntime not importable (%s); GPU vendor detection will report 'no GPU'. "
        "This is expected when running standalone tests but should not happen in production.",
        _exc,
    )

    def _detect_gpu_vendor() -> Dict[str, Any]:
        return {"vendors": [], "primary": None, "devices": []}


# Must match the torch pin in backend/requirements.txt. If you bump torch there,
# bump this too. We keep it as a single named constant so it is easy to grep.
_FALLBACK_TORCH_VERSION = "2.11.0"


# requirements.txt locks numpy per Python: 1.26.4 for Python <3.13 (matches the
# numpy-1 C ABI of the existing onnxruntime/SAM3/opencv/scipy wheels for that
# Python), 2.x for Python >=3.13 (numpy 1.26.4 has no cp313 wheel). The CUDA
# torch reinstall uses ``--no-deps`` to stop torch's resolver from cascading
# transitive deps (sympy, jinja2, markupsafe, setuptools, …), which would
# otherwise be uninstalled-and-reinstalled in place — pure noise during first
# launch. The numpy constraint stays in the explicit install list as a
# tripwire so that if ``--no-deps`` is ever dropped, pip still cannot upgrade
# numpy across the 2.0 ABI break (on 3.12) and silently break every
# numpy-1-ABI consumer.
def _numpy_sam3_constraint() -> str:
    """Return the Python-version-appropriate numpy floor/ceiling for SAM3."""
    if sys.version_info >= (3, 13):
        return "numpy>=2.1.0,<3.0"
    return "numpy<2.0"


TORCH_CUDA_INDEXES: Sequence[Tuple[str, str, Tuple[int, int]]] = (
    ("cu128", "https://download.pytorch.org/whl/cu128", (12, 8)),
    ("cu126", "https://download.pytorch.org/whl/cu126", (12, 6)),
    ("cu124", "https://download.pytorch.org/whl/cu124", (12, 4)),
    ("cu121", "https://download.pytorch.org/whl/cu121", (12, 1)),
)
PYTORCH_FALLBACK_INDEX = "https://pypi.org/simple"
SAM3_RUNTIME_IMPORTS: Sequence[Tuple[str, str]] = (
    ("transformers", "transformers>=5.6.0"),
    ("safetensors", "safetensors"),
    ("cv2", "opencv-python"),
)


def _env_truthy(name: str) -> bool:
    return str(os.environ.get(name, "")).strip().lower() in {"1", "true", "yes", "on"}


def _version(dist_name: str) -> Optional[str]:
    try:
        return metadata.version(dist_name)
    except metadata.PackageNotFoundError:
        return None


def _base_version(version: Optional[str]) -> Optional[str]:
    if not version:
        return None
    return str(version).split("+", 1)[0]


def _module_available(module_name: str) -> bool:
    try:
        __import__(module_name)
        return True
    except ImportError:
        return False
    except Exception as exc:  # noqa: BLE001 — module load can raise anything; log it
        logger.warning("Importing %s raised non-ImportError: %s", module_name, exc)
        return False


def _torch_probe() -> Dict[str, Any]:
    result: Dict[str, Any] = {
        "torch_version": _version("torch"),
        "torchvision_version": _version("torchvision"),
        "torch_cuda_build": None,
        "torch_cuda_available": False,
        "torch_probe_error": None,
    }
    try:
        import torch  # type: ignore

        result["torch_version"] = getattr(torch, "__version__", result["torch_version"])
        result["torch_cuda_build"] = getattr(getattr(torch, "version", None), "cuda", None)
        result["torch_cuda_available"] = bool(torch.cuda.is_available())
    except Exception as exc:  # noqa: BLE001 — capture whatever torch raised
        logger.warning("torch probe failed: %s", exc)
        result["torch_probe_error"] = str(exc)
    return result


def _torch_probe_subprocess() -> Dict[str, Any]:
    """Probe Torch in a fresh interpreter after pip may have replaced it.

    The launcher process imports ``torch`` while checking the current install
    state. If we then use pip to replace CPU Torch with a CUDA wheel, the old
    already-imported module remains in ``sys.modules`` for this process. A fresh
    interpreter is the only reliable way to verify the newly installed wheel
    without making users download every CUDA wheel in sequence.
    """

    code = (
        "import json\n"
        "result = {"
        "'torch_version': None, "
        "'torchvision_version': None, "
        "'torch_cuda_build': None, "
        "'torch_cuda_available': False, "
        "'torch_probe_error': None"
        "}\n"
        "try:\n"
        "    import torch\n"
        "    result['torch_version'] = getattr(torch, '__version__', None)\n"
        "    result['torch_cuda_build'] = getattr(getattr(torch, 'version', None), 'cuda', None)\n"
        "    result['torch_cuda_available'] = bool(torch.cuda.is_available())\n"
        "    try:\n"
        "        import torchvision\n"
        "        result['torchvision_version'] = getattr(torchvision, '__version__', None)\n"
        "    except Exception:\n"
        "        pass\n"
        "except Exception as exc:\n"
        "    result['torch_probe_error'] = str(exc)\n"
        "print(json.dumps(result))\n"
    )
    try:
        completed = subprocess.run(
            [sys.executable, "-c", code],
            check=True,
            capture_output=True,
            text=True,
            timeout=60,
        )
        parsed = json.loads(completed.stdout.strip().splitlines()[-1])
    except Exception as exc:  # noqa: BLE001 — keep launcher repair best-effort
        logger.warning("fresh torch probe failed: %s", exc)
        return {
            "torch_version": None,
            "torchvision_version": None,
            "torch_cuda_build": None,
            "torch_cuda_available": False,
            "torch_probe_error": str(exc),
        }
    return {
        "torch_version": parsed.get("torch_version"),
        "torchvision_version": parsed.get("torchvision_version"),
        "torch_cuda_build": parsed.get("torch_cuda_build"),
        "torch_cuda_available": bool(parsed.get("torch_cuda_available")),
        "torch_probe_error": parsed.get("torch_probe_error"),
    }


def _missing_sam3_runtime_packages() -> List[str]:
    missing: List[str] = []
    for module_name, package_spec in SAM3_RUNTIME_IMPORTS:
        if not _module_available(module_name):
            missing.append(package_spec)
    return missing


def _parse_cuda_version(text: str) -> Optional[Tuple[int, int]]:
    match = re.search(r"(\d+)\.(\d+)", text or "")
    if not match:
        return None
    return int(match.group(1)), int(match.group(2))


def _detect_nvidia_cuda_version() -> Optional[Tuple[int, int]]:
    if platform.system() != "Windows":
        return None

    # Path 1: explicit per-GPU query. Newer ``nvidia-smi`` builds support
    # ``--query-gpu=cuda_version`` and return just the version (e.g. "13.1\n")
    # which is safe to feed to the plain numeric parser. Older builds reject
    # the field with ``Field "cuda_version" is not a valid field to query.``
    # so we filter that error string out before parsing.
    try:
        raw = subprocess.check_output(
            ["nvidia-smi", "--query-gpu=cuda_version", "--format=csv,noheader"],
            text=True,
            timeout=10,
            stderr=subprocess.DEVNULL,
        )
    except (subprocess.SubprocessError, OSError, FileNotFoundError) as exc:
        logger.debug("nvidia-smi --query-gpu=cuda_version probe failed: %s", exc)
    else:
        for line in raw.splitlines():
            stripped = line.strip()
            if not stripped:
                continue
            if "not a valid field" in stripped.lower():
                break
            parsed = _parse_cuda_version(stripped)
            if parsed:
                return parsed

    # Path 2: full ``nvidia-smi`` header. The header line looks like:
    #   ``NVIDIA-SMI 591.86   Driver Version: 591.86   CUDA Version: 13.1``
    # The plain ``\d+\.\d+`` regex used by ``_parse_cuda_version`` would
    # match the driver version (591.86) before the CUDA version (13.1), so
    # we must anchor the match on the explicit ``CUDA Version:`` marker.
    try:
        raw = subprocess.check_output(
            ["nvidia-smi"],
            text=True,
            timeout=10,
            stderr=subprocess.DEVNULL,
        )
    except (subprocess.SubprocessError, OSError, FileNotFoundError) as exc:
        logger.debug("nvidia-smi header probe failed: %s", exc)
        return None

    for line in raw.splitlines():
        match = re.search(r"CUDA[\s:]*Version[\s:]*(\d+)\.(\d+)", line, re.IGNORECASE)
        if match:
            return int(match.group(1)), int(match.group(2))

    return None


def _resolve_torch_cuda_host() -> str:
    """Return the base URL for PyTorch CUDA wheels.

    Calls ``mirror_selector`` to pick the fastest of tuna / sjtu / official.
    A Chinese user typically sees tuna or sjtu sustain 20–80 MB/s while
    Fastly's ``download.pytorch.org`` drops to ~1 MB/s, so over a 2.5 GB
    CUDA wheel the difference is an hour vs a minute. The selector caches
    its answer for 30 minutes; on any failure we fall through to the
    official host so a broken cache cannot block the repair.
    """
    try:
        import mirror_selector
        data_dir = Path(__file__).resolve().parent.parent / "data"
        selection = mirror_selector.select_torch_cuda_host(data_dir=data_dir)
        if selection.index_url:
            return selection.index_url.rstrip("/")
    except Exception as exc:  # noqa: BLE001 — best-effort
        logger.debug("torch cuda mirror selection skipped: %s", exc)
    return "https://download.pytorch.org/whl"


def _cuda_index_candidates(max_cuda: Optional[Tuple[int, int]]) -> List[Tuple[str, str, Tuple[int, int]]]:
    configured = os.environ.get("SD_IMAGE_SORTER_TORCH_CUDA_INDEX_URL")
    if configured:
        return [("custom", configured.strip(), (99, 99))]

    if not max_cuda:
        base = list(TORCH_CUDA_INDEXES)
    else:
        compatible = [candidate for candidate in TORCH_CUDA_INDEXES if candidate[2] <= max_cuda]
        base = compatible or [TORCH_CUDA_INDEXES[-1]]

    host = _resolve_torch_cuda_host()
    if host == "https://download.pytorch.org/whl":
        return base
    return [(label, f"{host}/{label}", runtime_version) for label, _orig_url, runtime_version in base]


def _resolve_pypi_fallback_index() -> str:
    """Pick the ``--extra-index-url`` value for the CUDA torch reinstall.

    The CUDA torch wheel itself comes from ``download.pytorch.org``, but
    the install cascades to deps (numpy, sympy, networkx, …) which live
    on PyPI. Honouring the same mirror selection as ``launcher_pip.py``
    means a Chinese user does not have to wait on Fastly for those deps
    just because torch's own wheel host is fast.

    Falls back to the existing constant on any selector failure so a
    broken or offline mirror cannot block the repair.
    """

    try:
        import mirror_selector  # local import — only reached on the NVIDIA repair path
        data_dir = Path(__file__).resolve().parent.parent / "data"
        selection = mirror_selector.select_pypi_index(data_dir=data_dir)
        return selection.index_url or PYTORCH_FALLBACK_INDEX
    except Exception as exc:  # noqa: BLE001 — best-effort
        logger.debug("mirror selection skipped for torch repair: %s", exc)
        return PYTORCH_FALLBACK_INDEX


def _run_pip(args: List[str], *, stream: bool = False) -> subprocess.CompletedProcess[str]:
    command = [sys.executable, "-m", "pip", "--disable-pip-version-check", *args]
    if stream:
        print("[torch-runtime] Running: python -m pip --disable-pip-version-check " + " ".join(args), flush=True)
        return subprocess.run(command, check=True, text=True)
    try:
        return subprocess.run(command, check=True, capture_output=True, text=True)
    except subprocess.CalledProcessError as exc:
        if exc.stdout:
            print(exc.stdout, end="", file=sys.stdout)
        if exc.stderr:
            print(exc.stderr, end="", file=sys.stderr)
        raise


def _record_action(actions: List[str], message: str, *, stream_pip: bool) -> None:
    actions.append(message)
    if stream_pip:
        print(f"[torch-runtime] {message}", flush=True)


def get_install_state() -> Dict[str, Any]:
    gpu_vendor = _detect_gpu_vendor() if platform.system() == "Windows" else {"vendors": [], "primary": None, "devices": []}
    torch_state = _torch_probe()
    cuda_version = _detect_nvidia_cuda_version() if gpu_vendor.get("primary") == "nvidia" else None
    return {
        "platform": platform.system(),
        "python": sys.executable,
        "gpu_vendor_primary": gpu_vendor.get("primary"),
        "gpu_vendors_detected": gpu_vendor.get("vendors", []),
        "gpu_devices": gpu_vendor.get("devices", []),
        "nvidia_cuda_version": ".".join(str(part) for part in cuda_version) if cuda_version else None,
        "sam3_missing_runtime_packages": _missing_sam3_runtime_packages(),
        **torch_state,
    }


def _install_cuda_torch(actions: List[str], state: Dict[str, Any], *, stream_pip: bool) -> bool:
    torch_version = _base_version(state.get("torch_version"))
    torchvision_version = _base_version(state.get("torchvision_version"))
    if not torch_version:
        logger.info(
            "torch is not currently installed; falling back to %s for the CUDA install.",
            _FALLBACK_TORCH_VERSION,
        )
        torch_version = _FALLBACK_TORCH_VERSION

    cuda_version = _parse_cuda_version(str(state.get("nvidia_cuda_version") or ""))
    fallback_index = _resolve_pypi_fallback_index()

    # numpy lives on PyPI (not on download.pytorch.org). Install it once, up
    # front, with the SAM3-friendly upper bound. Doing this OUTSIDE the
    # CUDA-index pip call lets us drop --extra-index-url from the torch step,
    # which previously let pip silently fall back to PyPI's CPU torch wheel
    # whenever the CUDA index hit a transient network error (IncompleteRead,
    # DNS failure, etc.). With +cuXXX local versions plus a single index, a
    # broken CUDA host now produces a clean "could not find" error instead of
    # leaving the user with CPU torch and no diagnostic.
    numpy_constraint = _numpy_sam3_constraint()
    try:
        _run_pip(
            [
                "install",
                "--no-warn-script-location",
                "--index-url",
                fallback_index,
                numpy_constraint,
            ],
            stream=stream_pip,
        )
    except Exception as exc:
        _record_action(
            actions,
            f"{numpy_constraint} pre-install failed (continuing): {exc}",
            stream_pip=stream_pip,
        )

    last_error: Optional[BaseException] = None
    for label, index_url, _runtime_version in _cuda_index_candidates(cuda_version):
        # Pin the explicit local-version label (e.g. ``2.12.0+cu126``) so pip
        # cannot silently fall back to a CPU wheel from PyPI when the CUDA
        # index is briefly unreachable. The CPU wheel on PyPI is published as
        # plain ``2.12.0`` with no local-version suffix and does not match.
        torch_pinned = f"torch=={torch_version}+{label}"
        torchvision_pinned: Optional[str] = None
        if torchvision_version:
            torchvision_pinned = f"torchvision=={torchvision_version}+{label}"
        packages = [torch_pinned]
        if torchvision_pinned:
            packages.append(torchvision_pinned)
        _record_action(
            actions,
            f"Installing CUDA PyTorch from {label} for NVIDIA GPU: {', '.join(packages)}",
            stream_pip=stream_pip,
        )
        try:
            _run_pip(
                [
                    "install",
                    "--upgrade",
                    "--force-reinstall",
                    "--no-deps",
                    "--no-warn-script-location",
                    "--index-url",
                    index_url,
                    *packages,
                ],
                stream=stream_pip,
            )
            if _torch_probe_subprocess().get("torch_cuda_build"):
                return True
            last_error = RuntimeError(f"{label} install completed, but torch.version.cuda is still empty")
        except Exception as exc:
            last_error = exc
            _record_action(actions, f"CUDA PyTorch install from {label} failed: {exc}", stream_pip=stream_pip)
    if last_error:
        raise RuntimeError(f"Could not install a CUDA-enabled PyTorch build: {last_error}")
    return False


def _install_sam3_runtime(actions: List[str], *, stream_pip: bool) -> None:
    missing = _missing_sam3_runtime_packages()
    if not missing:
        return
    _record_action(actions, "Installing SAM3 Python runtime packages: " + ", ".join(missing), stream_pip=stream_pip)
    _run_pip(
        [
            "install",
            "--upgrade-strategy",
            "only-if-needed",
            "--no-warn-script-location",
            *missing,
        ],
        stream=stream_pip,
    )


def repair_windows_torch_runtime(*, stream_pip: bool = False) -> Dict[str, Any]:
    state = get_install_state()
    actions: List[str] = []

    if state["platform"] != "Windows":
        state["actions"] = actions
        state["repaired"] = False
        return state

    if _env_truthy("SD_IMAGE_SORTER_SKIP_TORCH_REPAIR"):
        actions.append("Skipped by SD_IMAGE_SORTER_SKIP_TORCH_REPAIR")
        state["actions"] = actions
        state["repaired"] = False
        return state

    primary_vendor = state.get("gpu_vendor_primary")
    if primary_vendor != "nvidia":
        actions.append(
            "No NVIDIA GPU detected; leaving PyTorch on the standard CPU build. "
            "ONNX Runtime still uses DirectML for AMD/Intel when available."
        )
        state["actions"] = actions
        state["repaired"] = False
        return state

    installed_cuda_torch = False
    if not state.get("torch_cuda_build"):
        _install_cuda_torch(actions, state, stream_pip=stream_pip)
        installed_cuda_torch = True
    else:
        actions.append(f"CUDA PyTorch already installed ({state.get('torch_cuda_build')})")

    if not _env_truthy("SD_IMAGE_SORTER_SKIP_SAM3_RUNTIME_REPAIR"):
        _install_sam3_runtime(actions, stream_pip=stream_pip)

    final_state = get_install_state()
    if installed_cuda_torch:
        final_state.update(_torch_probe_subprocess())
    final_state["actions"] = actions or ["No repair needed"]
    final_state["repaired"] = any(action != "No repair needed" and not action.startswith("CUDA PyTorch already") for action in final_state["actions"])
    return final_state


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--auto", action="store_true", help="Repair automatically when needed.")
    parser.add_argument("--json", action="store_true", help="Print machine-readable JSON output.")
    args = parser.parse_args()

    state = get_install_state()
    result = repair_windows_torch_runtime(stream_pip=not args.json) if args.auto else state

    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0

    if result["platform"] != "Windows":
        print("[torch-runtime] Non-Windows platform detected. No repair needed.")
        return 0

    print(f"[torch-runtime] Primary GPU vendor: {result.get('gpu_vendor_primary') or 'unknown'}")
    print(f"[torch-runtime] Torch: {result.get('torch_version') or 'not installed'}")
    print(f"[torch-runtime] Torch CUDA build: {result.get('torch_cuda_build') or 'none'}")
    print(f"[torch-runtime] Torch CUDA available: {bool(result.get('torch_cuda_available'))}")
    if result.get("sam3_missing_runtime_packages"):
        print("[torch-runtime] SAM3 missing packages: " + ", ".join(result["sam3_missing_runtime_packages"]))
    for action in result.get("actions", []):
        print(f"[torch-runtime] {action}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
