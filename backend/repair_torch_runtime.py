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
from typing import Any, Dict, List, Optional, Sequence, Tuple

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


TORCH_CUDA_INDEXES: Sequence[Tuple[str, str, Tuple[int, int]]] = (
    ("cu128", "https://download.pytorch.org/whl/cu128", (12, 8)),
    ("cu126", "https://download.pytorch.org/whl/cu126", (12, 6)),
    ("cu124", "https://download.pytorch.org/whl/cu124", (12, 4)),
    ("cu121", "https://download.pytorch.org/whl/cu121", (12, 1)),
)
PYTORCH_FALLBACK_INDEX = "https://pypi.org/simple"
SAM3_RUNTIME_IMPORTS: Sequence[Tuple[str, str]] = (
    ("sam3", "sam3==0.1.3"),
    ("einops", "einops"),
    ("hydra", "hydra-core"),
    ("omegaconf", "omegaconf"),
    ("pycocotools", "pycocotools"),
    ("decord", "decord"),
    ("iopath", "iopath"),
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
    commands = [
        ["nvidia-smi", "--query-gpu=cuda_version", "--format=csv,noheader"],
        ["nvidia-smi"],
    ]
    for command in commands:
        try:
            raw = subprocess.check_output(command, text=True, timeout=10, stderr=subprocess.DEVNULL)
        except (subprocess.SubprocessError, OSError, FileNotFoundError) as exc:
            # Log at DEBUG so an empty/missing nvidia-smi (legitimate on AMD machines) is
            # not noisy, but the trail is still discoverable when debugging detection.
            logger.debug("nvidia-smi probe %r failed: %s", command, exc)
            continue
        versions = [parsed for line in raw.splitlines() if (parsed := _parse_cuda_version(line))]
        if versions:
            return max(versions)
    return None


def _cuda_index_candidates(max_cuda: Optional[Tuple[int, int]]) -> List[Tuple[str, str, Tuple[int, int]]]:
    configured = os.environ.get("SD_IMAGE_SORTER_TORCH_CUDA_INDEX_URL")
    if configured:
        return [("custom", configured.strip(), (99, 99))]
    if not max_cuda:
        return list(TORCH_CUDA_INDEXES)
    compatible = [candidate for candidate in TORCH_CUDA_INDEXES if candidate[2] <= max_cuda]
    return compatible or [TORCH_CUDA_INDEXES[-1]]


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
    packages = [f"torch=={torch_version}"]
    if torchvision_version:
        packages.append(f"torchvision=={torchvision_version}")

    cuda_version = _parse_cuda_version(str(state.get("nvidia_cuda_version") or ""))
    last_error: Optional[BaseException] = None
    for label, index_url, _runtime_version in _cuda_index_candidates(cuda_version):
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
                    "--no-warn-script-location",
                    "--index-url",
                    index_url,
                    "--extra-index-url",
                    PYTORCH_FALLBACK_INDEX,
                    *packages,
                ],
                stream=stream_pip,
            )
            if _torch_probe().get("torch_cuda_build"):
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

    if not state.get("torch_cuda_build"):
        _install_cuda_torch(actions, state, stream_pip=stream_pip)
    else:
        actions.append(f"CUDA PyTorch already installed ({state.get('torch_cuda_build')})")

    if not _env_truthy("SD_IMAGE_SORTER_SKIP_SAM3_RUNTIME_REPAIR"):
        _install_sam3_runtime(actions, stream_pip=stream_pip)

    final_state = get_install_state()
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
