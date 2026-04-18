"""Repair Windows ONNX Runtime package conflicts for WD14 tagging.

Why this exists:
- `onnxruntime-gpu` is the correct Windows package for NVIDIA users (CUDA +
  CPU fallback).
- `onnxruntime-directml` is the correct Windows package for Intel / AMD
  users (DirectML + CPU fallback) so their GPU can accelerate tagging.
- Some downstream packages still depend on the CPU package name
  `onnxruntime`, which can get installed afterwards and override the active
  runtime, leaving users stuck on CPU even when GPU acceleration is
  available.

This script makes the launcher self-heal that state so users do not need to
understand the package split before using the app.

Behaviour:
- NVIDIA primary GPU: keep onnxruntime-gpu, remove conflicting onnxruntime.
- Intel / AMD only (no NVIDIA): swap onnxruntime-gpu for
  onnxruntime-directml, remove conflicting onnxruntime.
- No GPU detected: leave the installed package as-is (defaults to
  onnxruntime-gpu from requirements.txt, falls back to CPU at runtime).
- Idempotent: if the installed package already matches the detected GPU
  vendor, no action is taken, so repeated launches are fast.
"""

from __future__ import annotations

import argparse
import json
import platform
import subprocess
import sys
from importlib import metadata
from typing import Any, Dict, List, Optional


def _version(dist_name: str) -> Optional[str]:
    try:
        return metadata.version(dist_name)
    except metadata.PackageNotFoundError:
        return None


def _detect_gpu_vendor() -> Dict[str, Any]:
    """Best-effort primary GPU vendor detection on Windows via CIM.

    Returns a dict with:
    - vendors: list of vendors present ("nvidia", "intel", "amd", "unknown")
    - primary: preferred vendor for ONNX Runtime (nvidia > amd > intel > unknown)
    - devices: list of {name, vendor} for diagnostic logging
    """
    result: Dict[str, Any] = {
        "vendors": [],
        "primary": None,
        "devices": [],
    }

    if platform.system() != "Windows":
        return result

    try:
        command = [
            "powershell",
            "-NoProfile",
            "-Command",
            (
                "Get-CimInstance Win32_VideoController | "
                "Select-Object Name | ConvertTo-Json -Compress"
            ),
        ]
        raw = subprocess.check_output(command, text=True, timeout=10).strip()
        if not raw:
            return result

        parsed = json.loads(raw)
        rows = parsed if isinstance(parsed, list) else [parsed]
        vendors_seen: List[str] = []
        for row in rows:
            name = str(row.get("Name") or "").strip()
            if not name:
                continue
            lowered = name.lower()
            # Skip virtual adapters and Microsoft basic render (software fallback)
            if "virtual" in lowered and "nvidia" not in lowered:
                continue
            if "microsoft basic render" in lowered:
                continue

            if "nvidia" in lowered:
                vendor = "nvidia"
            elif "amd" in lowered or "radeon" in lowered:
                vendor = "amd"
            elif "intel" in lowered:
                vendor = "intel"
            else:
                vendor = "unknown"

            result["devices"].append({"name": name, "vendor": vendor})
            if vendor not in vendors_seen:
                vendors_seen.append(vendor)

        result["vendors"] = vendors_seen
        # Prefer NVIDIA > AMD > Intel > unknown for runtime selection.
        # NVIDIA wins for hybrid laptops (Intel iGPU + NVIDIA dGPU).
        for preferred in ("nvidia", "amd", "intel"):
            if preferred in vendors_seen:
                result["primary"] = preferred
                break
        if result["primary"] is None and vendors_seen:
            result["primary"] = vendors_seen[0]
    except Exception:
        # Best-effort only. Fall through with empty result.
        pass

    return result


def get_install_state() -> Dict[str, Any]:
    cpu_version = _version("onnxruntime")
    gpu_version = _version("onnxruntime-gpu")
    dml_version = _version("onnxruntime-directml")
    gpu_vendor = _detect_gpu_vendor() if platform.system() == "Windows" else {"vendors": [], "primary": None, "devices": []}
    return {
        "platform": platform.system(),
        "python": sys.executable,
        "onnxruntime_version": cpu_version,
        "onnxruntime_gpu_version": gpu_version,
        "onnxruntime_directml_version": dml_version,
        "has_conflict": sum(1 for v in (cpu_version, gpu_version, dml_version) if v) > 1,
        "has_gpu_package": bool(gpu_version),
        "has_dml_package": bool(dml_version),
        "gpu_vendor_primary": gpu_vendor.get("primary"),
        "gpu_vendors_detected": gpu_vendor.get("vendors", []),
        "gpu_devices": gpu_vendor.get("devices", []),
    }


def _run_pip(args: List[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "-m", "pip", "--disable-pip-version-check", *args],
        check=True,
        capture_output=True,
        text=True,
    )


def _probe_ort_providers() -> List[str]:
    code = "import onnxruntime as ort; print('\\n'.join(ort.get_available_providers()))"
    result = subprocess.run(
        [sys.executable, "-c", code],
        check=True,
        capture_output=True,
        text=True,
    )
    return [line.strip() for line in result.stdout.splitlines() if line.strip()]


def _target_runtime_for_vendor(primary_vendor: Optional[str]) -> str:
    """Pick the best Windows ONNX Runtime distribution for the detected GPU.

    Returns one of: "onnxruntime-gpu", "onnxruntime-directml".
    Defaults to onnxruntime-gpu when vendor is NVIDIA, unknown, or None so
    users without a detectable GPU keep the standard Windows install.
    """
    if primary_vendor in ("intel", "amd"):
        return "onnxruntime-directml"
    return "onnxruntime-gpu"


def repair_windows_onnxruntime() -> Dict[str, Any]:
    state = get_install_state()
    actions: List[str] = []

    if state["platform"] != "Windows":
        state["actions"] = actions
        state["repaired"] = False
        return state

    cpu_version = state["onnxruntime_version"]
    gpu_version = state["onnxruntime_gpu_version"]
    dml_version = state["onnxruntime_directml_version"]
    primary_vendor = state.get("gpu_vendor_primary")
    target_runtime = _target_runtime_for_vendor(primary_vendor)

    # Step 1: remove the CPU-only `onnxruntime` package when it coexists with
    # a GPU runtime. The CPU package's DLLs override the GPU ones and silently
    # disable acceleration.
    if cpu_version and (gpu_version or dml_version):
        actions.append(f"Uninstalling conflicting onnxruntime {cpu_version}")
        _run_pip(["uninstall", "-y", "onnxruntime"])
        # Reinstall the active GPU runtime so any overwritten files are restored.
        if gpu_version:
            actions.append(f"Reinstalling onnxruntime-gpu {gpu_version} to restore overwritten files")
            _run_pip(["install", "--no-deps", "--upgrade", "--force-reinstall", f"onnxruntime-gpu=={gpu_version}"])
        if dml_version:
            actions.append(f"Reinstalling onnxruntime-directml {dml_version} to restore overwritten files")
            _run_pip(["install", "--no-deps", "--upgrade", "--force-reinstall", f"onnxruntime-directml=={dml_version}"])

    # Step 2: if only the CPU package is installed on Windows, install the
    # appropriate GPU runtime for the detected vendor.
    elif cpu_version and not gpu_version and not dml_version:
        actions.append(
            f"CPU-only onnxruntime detected on Windows. Installing {target_runtime} "
            f"(primary GPU vendor: {primary_vendor or 'unknown'}) and removing onnxruntime."
        )
        _run_pip(["install", "--upgrade", "--force-reinstall", target_runtime])
        _run_pip(["uninstall", "-y", "onnxruntime"])

    # Step 3: if both GPU runtimes are installed, keep only the one that
    # matches the detected vendor.
    if gpu_version and dml_version:
        keep = target_runtime
        drop = "onnxruntime-directml" if keep == "onnxruntime-gpu" else "onnxruntime-gpu"
        actions.append(f"Both GPU runtimes installed. Keeping {keep}, removing {drop}.")
        _run_pip(["uninstall", "-y", drop])

    # Step 4: swap between onnxruntime-gpu and onnxruntime-directml to match
    # the detected GPU vendor. This is the Intel/AMD support path: the
    # launcher installs onnxruntime-gpu from requirements.txt, and here we
    # swap it out when the user has a non-NVIDIA primary GPU.
    # Only perform the swap when we have confident vendor information — if
    # detection returned nothing, leave the existing install alone so users
    # without a detectable GPU keep working.
    else:
        current_runtime = None
        if gpu_version:
            current_runtime = "onnxruntime-gpu"
        elif dml_version:
            current_runtime = "onnxruntime-directml"

        if (
            primary_vendor in ("intel", "amd", "nvidia")
            and current_runtime is not None
            and current_runtime != target_runtime
        ):
            actions.append(
                f"Primary GPU vendor is {primary_vendor}. Swapping {current_runtime} "
                f"for {target_runtime} to enable hardware acceleration."
            )
            _run_pip(["uninstall", "-y", current_runtime])
            _run_pip(["install", "--upgrade", "--force-reinstall", target_runtime])

    # Step 5: NVIDIA users need the CUDA 12 + cuDNN 9 runtime DLLs to
    # actually load CUDAExecutionProvider. onnxruntime-gpu 1.18+ stopped
    # bundling these (~1.4 GB total), so without them ONNX Runtime lists
    # CUDAExecutionProvider as available but silently falls back to CPU
    # with "Failed to load cublas64_12.dll" etc. The [cuda,cudnn] extras
    # (added in 1.21.0) pull in nvidia-cublas-cu12, nvidia-cudnn-cu12,
    # nvidia-cufft-cu12, nvidia-cuda-runtime-cu12, nvidia-cuda-nvrtc-cu12,
    # and nvidia-curand-cu12. We probe nvidia-cudnn-cu12 as the sentinel
    # because it transitively pulls in cublas as well.
    final_gpu_version = _version("onnxruntime-gpu")
    if (
        primary_vendor == "nvidia"
        and target_runtime == "onnxruntime-gpu"
        and final_gpu_version
        and not _version("nvidia-cudnn-cu12")
    ):
        actions.append(
            f"Installing CUDA 12 + cuDNN 9 runtime DLLs (~1.4 GB) so onnxruntime-gpu "
            f"{final_gpu_version} can use CUDAExecutionProvider"
        )
        _run_pip([
            "install",
            "--no-warn-script-location",
            f"onnxruntime-gpu[cuda,cudnn]=={final_gpu_version}",
        ])

    if not actions:
        actions.append("No repair needed")

    state = get_install_state()
    state["actions"] = actions
    state["repaired"] = any(action != "No repair needed" for action in actions)
    state["target_runtime"] = target_runtime
    try:
        state["providers_after_repair"] = _probe_ort_providers()
    except Exception as exc:  # pragma: no cover - best-effort diagnostic only
        state["providers_after_repair"] = []
        state["provider_probe_error"] = str(exc)
    return state


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--auto", action="store_true", help="Repair automatically when needed.")
    parser.add_argument("--json", action="store_true", help="Print machine-readable JSON output.")
    args = parser.parse_args()

    state = get_install_state()
    result = repair_windows_onnxruntime() if args.auto else state

    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        if result["platform"] != "Windows":
            print("[onnxruntime] Non-Windows platform detected. No repair needed.")
        else:
            vendor = result.get("gpu_vendor_primary") or "unknown"
            vendors_all = result.get("gpu_vendors_detected") or []
            if vendors_all:
                print(f"[onnxruntime] Detected GPU vendor(s): {', '.join(vendors_all)} (primary: {vendor})")
            else:
                print("[onnxruntime] No GPU detected via CIM.")

            if result.get("repaired"):
                print("[onnxruntime] Repaired Windows ONNX Runtime packages.")
                for action in result.get("actions", []):
                    print(" -", action)
            else:
                print("[onnxruntime] No repair needed.")

        providers = result.get("providers_after_repair")
        if providers:
            print("[onnxruntime] Providers:", ", ".join(providers))

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
