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
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple
from packaging.version import InvalidVersion, Version


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
    ("cu126", "https://download.pytorch.org/whl/cu126", (12, 6)),
)
TORCH_CUDA_PACKAGE_VERSIONS: Mapping[str, Tuple[str, str]] = {
    "cu126": ("2.13.0", "0.28.0"),
}


def _cuda_package_versions(label: str) -> Tuple[str, str]:
    try:
        return TORCH_CUDA_PACKAGE_VERSIONS[label]
    except KeyError as exc:
        raise ValueError(f"Unsupported official CUDA wheel label: {label}") from exc


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


def _version_matches_cuda_candidate(
    version: object,
    expected_base: str,
    label: str,
) -> bool:
    if not isinstance(version, str):
        return False
    try:
        parsed = Version(version.strip())
    except InvalidVersion:
        return False
    return parsed.base_version == expected_base and parsed.local == label


def _cuda_state_matches_candidate(
    state: Mapping[str, Any],
    candidate: Tuple[str, str, Tuple[int, int]],
) -> bool:
    label, _index_url, cuda_runtime = candidate
    torch_version, torchvision_version = _cuda_package_versions(label)
    expected_cuda_build = ".".join(str(part) for part in cuda_runtime)
    return (
        _version_matches_cuda_candidate(
            state.get("torch_version"),
            torch_version,
            label,
        )
        and _version_matches_cuda_candidate(
            state.get("torchvision_version"),
            torchvision_version,
            label,
        )
        and state.get("torch_cuda_build") == expected_cuda_build
        and state.get("torch_cuda_available") is True
    )


def _is_supported_cuda_torch_state(state: Mapping[str, Any]) -> bool:
    return any(
        _cuda_state_matches_candidate(state, candidate)
        for candidate in TORCH_CUDA_INDEXES
    )

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
    """Probe Torch without locking its extension modules in the repair process.

    Windows cannot replace loaded Torch extension modules. A short-lived child
    reports the current state and exits before pip starts, then the same probe
    verifies the installed wheel without reusing stale modules in the parent.
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

    # Path 2: full nvidia-smi header. Driver branches report either
    # CUDA Version: 13.1 or CUDA UMD Version: 13.3.
    # The plain ``\d+\.\d+`` regex used by ``_parse_cuda_version`` would
    # match the driver version (591.86) before the CUDA version (13.1), so
    # anchor the match on the explicit CUDA marker.
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
        match = re.search(r"CUDA(?:\s+UMD)?\s+Version\s*:\s*(\d+)\.(\d+)", line, re.IGNORECASE)
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


def _configured_cuda_index_candidate(
    configured_url: str,
) -> Tuple[str, str, Tuple[int, int]]:
    url = configured_url.strip().rstrip("/")
    if re.search(r"/cu130$", url, re.IGNORECASE):
        raise ValueError(
            "Configured cu130 PyTorch wheels are incompatible with ONNX Runtime "
            "CUDA 12.x used by SD Image Sorter. Set "
            "SD_IMAGE_SORTER_TORCH_CUDA_INDEX_URL to a mirror URL ending in "
            "cu126."
        )

    match = re.search(r"/(cu126)$", url, re.IGNORECASE)
    if match is None:
        raise ValueError(
            "SD_IMAGE_SORTER_TORCH_CUDA_INDEX_URL must end with cu126; "
            f"received {_redact_command_argument(configured_url)!r}."
        )

    label = match.group(1).lower()
    runtime_version = next(
        candidate[2]
        for candidate in TORCH_CUDA_INDEXES
        if candidate[0] == label
    )
    return label, url, runtime_version


def _cuda_index_candidates(
    max_cuda: Optional[Tuple[int, int]],
) -> List[Tuple[str, str, Tuple[int, int]]]:
    if max_cuda is None:
        return []

    configured = os.environ.get("SD_IMAGE_SORTER_TORCH_CUDA_INDEX_URL")
    if configured:
        candidate = _configured_cuda_index_candidate(configured)
        if candidate[2] > max_cuda:
            required = ".".join(str(part) for part in candidate[2])
            detected = ".".join(str(part) for part in max_cuda)
            raise ValueError(
                f"Configured CUDA index {candidate[0]} requires CUDA {required}, "
                f"but the NVIDIA driver reports CUDA {detected}. Choose a "
                "compatible index or update the NVIDIA driver."
            )
        return [candidate]

    compatible = [
        candidate
        for candidate in TORCH_CUDA_INDEXES
        if candidate[2] <= max_cuda
    ]
    selected = compatible[:1]
    host = _resolve_torch_cuda_host()
    if host == "https://download.pytorch.org/whl":
        return selected
    return [
        (label, f"{host}/{label}", runtime_version)
        for label, _original_url, runtime_version in selected
    ]

def _resolve_pypi_fallback_index() -> str:
    """Pick the primary package index for the explicit NumPy pre-install.

    CUDA Torch uses only its selected CUDA index with ``--no-deps``. NumPy
    is installed separately so its ABI constraint comes from PyPI without
    giving pip any opportunity to substitute a CPU Torch wheel. Honour the
    same mirror selection as ``launcher_pip.py`` for that NumPy request.

    Falls back to public PyPI if mirror selection itself is unavailable.
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
        display_args = " ".join(_redact_command_argument(argument) for argument in args)
        print("[torch-runtime] Running: python -m pip --disable-pip-version-check " + display_args, flush=True)
        return subprocess.run(command, check=True, text=True)
    try:
        return subprocess.run(command, check=True, capture_output=True, text=True)
    except subprocess.CalledProcessError as exc:
        if exc.stdout:
            print(
                _redact_command_argument(exc.stdout), end="", file=sys.stdout
            )
        if exc.stderr:
            print(
                _redact_command_argument(exc.stderr), end="", file=sys.stderr
            )
        raise


def _redact_command_argument(argument: object) -> str:
    return re.sub(
        r"(https?://)[^/@\s]+@",
        r"\1***@",
        str(argument),
        flags=re.IGNORECASE,
    )


def _format_subprocess_error(error: BaseException) -> str:
    if not isinstance(error, subprocess.CalledProcessError):
        return f"{type(error).__name__}: {error}"

    command = [
        _redact_command_argument(argument)
        for argument in (
            error.cmd
            if isinstance(error.cmd, (list, tuple))
            else [error.cmd]
        )
    ]
    stdout = _redact_command_argument(
        (error.stdout or error.output or "").strip()
    )
    stderr = _redact_command_argument(
        (error.stderr or "").strip()
    )
    return (
        f"command={command!r}; exit_code={error.returncode}; "
        f"stdout={stdout!r}; stderr={stderr!r}"
    )

def _record_action(actions: List[str], message: str, *, stream_pip: bool) -> None:
    actions.append(message)
    if stream_pip:
        print(f"[torch-runtime] {message}", flush=True)


def get_install_state() -> Dict[str, Any]:
    system = platform.system()
    gpu_vendor = _detect_gpu_vendor() if system == "Windows" else {"vendors": [], "primary": None, "devices": []}
    torch_state = _torch_probe_subprocess() if system == "Windows" else _torch_probe()
    cuda_version = _detect_nvidia_cuda_version() if gpu_vendor.get("primary") == "nvidia" else None
    return {
        "platform": system,
        "python": sys.executable,
        "gpu_vendor_primary": gpu_vendor.get("primary"),
        "gpu_vendors_detected": gpu_vendor.get("vendors", []),
        "gpu_devices": gpu_vendor.get("devices", []),
        "nvidia_cuda_version": ".".join(str(part) for part in cuda_version) if cuda_version else None,
        "sam3_missing_runtime_packages": _missing_sam3_runtime_packages(),
        **torch_state,
    }


def _install_cuda_torch(actions: List[str], state: Dict[str, Any], *, stream_pip: bool) -> bool:
    cuda_version = _parse_cuda_version(
        str(state.get("nvidia_cuda_version") or "")
    )
    if cuda_version is None:
        _record_action(
            actions,
            "Could not determine the NVIDIA driver CUDA capability from "
            "nvidia-smi. CUDA PyTorch was not changed. Verify or update the "
            "NVIDIA driver, then retry Prepare.",
            stream_pip=stream_pip,
        )
        return False

    candidates = _cuda_index_candidates(cuda_version)
    if not candidates:
        reported_version = state.get("nvidia_cuda_version")
        _record_action(
            actions,
            "NVIDIA driver reports CUDA "
            f"{reported_version}, but secure CUDA PyTorch requires driver "
            "support for CUDA 12.6 or newer. Update the NVIDIA driver, then "
            "retry Prepare. Keeping the existing PyTorch runtime; no packages "
            "were changed.",
            stream_pip=stream_pip,
        )
        return False

    candidate = candidates[0]
    label, index_url, runtime_version = candidate
    torch_version, torchvision_version = _cuda_package_versions(label)
    fallback_index = _resolve_pypi_fallback_index()

    # Numpy lives on PyPI, so validate its ABI constraint before changing Torch.
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
        detail = _format_subprocess_error(exc)
        message = (
            f"{numpy_constraint} pre-install failed; CUDA PyTorch was not changed. "
            f"Resolve the package-index error and retry Prepare: {detail}"
        )
        _record_action(
            actions,
            message,
            stream_pip=stream_pip,
        )
        raise RuntimeError(message) from None

    torch_pinned = f"torch=={torch_version}+{label}"
    torchvision_pinned = f"torchvision=={torchvision_version}+{label}"
    packages = [torch_pinned, torchvision_pinned]
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
    except Exception as exc:
        detail = _format_subprocess_error(exc)
        message = f"CUDA PyTorch install from {label} failed: {detail}"
        _record_action(actions, message, stream_pip=stream_pip)
        raise RuntimeError(message) from None

    fresh_probe = _torch_probe_subprocess()
    if _cuda_state_matches_candidate(fresh_probe, candidate):
        return True

    expected_cuda = ".".join(str(part) for part in runtime_version)
    message = (
        f"{label} install verification failed; expected torch "
        f"{torch_version}+{label}, torchvision {torchvision_version}+{label}, "
        f"and usable CUDA {expected_cuda}; observed "
        f"torch={fresh_probe.get('torch_version')!r}, "
        f"torchvision={fresh_probe.get('torchvision_version')!r}, "
        f"CUDA={fresh_probe.get('torch_cuda_build')!r}, "
        f"available={fresh_probe.get('torch_cuda_available')!r}, "
        f"error={fresh_probe.get('torch_probe_error')!r}."
    )
    _record_action(actions, message, stream_pip=stream_pip)
    raise RuntimeError(message)

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
    if not _is_supported_cuda_torch_state(state):
        installed_cuda_torch = _install_cuda_torch(
            actions,
            state,
            stream_pip=stream_pip,
        )
        if not installed_cuda_torch:
            state["actions"] = actions
            state["repaired"] = False
            return state
    else:
        actions.append(f"CUDA PyTorch already installed ({state.get('torch_cuda_build')})")

    if not _env_truthy("SD_IMAGE_SORTER_SKIP_SAM3_RUNTIME_REPAIR"):
        _install_sam3_runtime(actions, stream_pip=stream_pip)

    final_state = dict(state)
    final_state["sam3_missing_runtime_packages"] = (
        _missing_sam3_runtime_packages()
    )
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

    result = (
        repair_windows_torch_runtime(stream_pip=not args.json)
        if args.auto
        else get_install_state()
    )

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
