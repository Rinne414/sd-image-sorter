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
- No supported GPU detected: leave the installed package as-is (CPU runtime in
  lightweight mode, existing GPU runtime in full-AI mode).
- Idempotent: if the installed package already matches the detected GPU
  vendor, no action is taken, so repeated launches are fast.
"""

from __future__ import annotations

import argparse
import json
import platform
import re
import subprocess
import sys
import tempfile
from importlib import metadata
from pathlib import Path
from typing import Any, Dict, List, Optional

# Embedded Python (used by the portable Windows launcher) ships a
# ``python312._pth`` file that fully controls ``sys.path`` and does NOT
# auto-prepend the running script's directory. We add it ourselves so
# any future sibling imports (e.g. ``from repair_torch_runtime import``)
# behave the same way they do in a developer venv. This script currently
# has no sibling imports, but keeping the bootstrap in place is cheap
# insurance against future regressions.
_THIS_DIR = str(Path(__file__).resolve().parent)
if _THIS_DIR not in sys.path:
    sys.path.insert(0, _THIS_DIR)


def _version(dist_name: str) -> Optional[str]:
    try:
        return metadata.version(dist_name)
    except metadata.PackageNotFoundError:
        return None


DEFAULT_RUNTIME_VERSION_BY_DIST = {
    # `onnxruntime-directml` is selected dynamically for AMD/Intel Windows
    # machines, so it cannot live in requirements.txt without conflicting
    # with NVIDIA users. Keep it pinned here to avoid resolver drift.
    "onnxruntime-directml": "1.21.0",
}


def _locked_runtime_version(dist_name: str) -> Optional[str]:
    requirements_path = Path(__file__).resolve().parent / "requirements.txt"
    if not requirements_path.exists():
        return None

    prefix = f"{dist_name}=="
    try:
        for raw_line in requirements_path.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if not line.startswith(prefix):
                continue
            return line[len(prefix):].split(";", 1)[0].strip() or None
    except OSError:
        return None
    return None


def _release_runtime_version(dist_name: str, installed_version: Optional[str] = None) -> Optional[str]:
    return _locked_runtime_version(dist_name) or DEFAULT_RUNTIME_VERSION_BY_DIST.get(dist_name) or installed_version


def _runtime_install_spec(dist_name: str, *, extras: Optional[str] = None, installed_version: Optional[str] = None) -> str:
    package_name = f"{dist_name}[{extras}]" if extras else dist_name
    version = _release_runtime_version(dist_name, installed_version)
    return f"{package_name}=={version}" if version else package_name


_PINNED_REQUIREMENT_RE = re.compile(
    r"^([A-Za-z0-9_.-]+)(?:\[[^\]]+\])?(==[^\s;]+)(\s*;.*)?$"
)


def _sanitize_constraint_line(raw_line: str) -> Optional[str]:
    stripped = raw_line.strip()
    if not stripped or stripped.startswith("#") or stripped.startswith("-"):
        return None

    match = _PINNED_REQUIREMENT_RE.match(stripped)
    if not match:
        return None

    name, version_spec, marker = match.groups()
    return f"{name}{version_spec}{marker or ''}"


def _write_sanitized_constraints(requirements_path: Path) -> Optional[Path]:
    try:
        lines = requirements_path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return None

    sanitized_lines = [
        constraint
        for line in lines
        if (constraint := _sanitize_constraint_line(line))
    ]
    if not sanitized_lines:
        return None

    constraints_file = tempfile.NamedTemporaryFile(
        "w",
        encoding="utf-8",
        delete=False,
        prefix="sd-image-sorter-constraints-",
        suffix=".txt",
    )
    with constraints_file:
        constraints_file.write("\n".join(sanitized_lines))
        constraints_file.write("\n")
    return Path(constraints_file.name)


def _core_requirements_constraint_args() -> List[str]:
    requirements_path = Path(__file__).resolve().parent / "requirements-core.txt"
    if not requirements_path.exists():
        return []

    constraints_path = _write_sanitized_constraints(requirements_path)
    if constraints_path is None:
        return []
    return ["--constraint", str(constraints_path)]


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


def _run_pip(args: List[str], *, stream: bool = False) -> subprocess.CompletedProcess[str]:
    command = [sys.executable, "-m", "pip", "--disable-pip-version-check", *args]
    if stream:
        print(
            "[onnxruntime] Running: python -m pip --disable-pip-version-check "
            + " ".join(args),
            flush=True,
        )
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
        print(f"[onnxruntime] {message}", flush=True)


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


def repair_windows_onnxruntime(*, stream_pip: bool = False) -> Dict[str, Any]:
    state = get_install_state()
    actions: List[str] = []
    did_repair = False

    if state["platform"] != "Windows":
        state["actions"] = actions
        state["repaired"] = False
        return state

    cpu_version = state["onnxruntime_version"]
    gpu_version = state["onnxruntime_gpu_version"]
    dml_version = state["onnxruntime_directml_version"]
    primary_vendor = state.get("gpu_vendor_primary")
    target_runtime = _target_runtime_for_vendor(primary_vendor)
    target_runtime_spec = _runtime_install_spec(target_runtime)
    pinned_gpu_version = _release_runtime_version("onnxruntime-gpu")
    pinned_dml_version = _release_runtime_version("onnxruntime-directml")
    cuda_runtime_needs_refresh = False

    # Step 1: remove the CPU-only `onnxruntime` package when it coexists with
    # a GPU runtime. The CPU package's DLLs override the GPU ones and silently
    # disable acceleration.
    if cpu_version and (gpu_version or dml_version):
        _record_action(
            actions,
            f"Uninstalling conflicting onnxruntime {cpu_version}",
            stream_pip=stream_pip,
        )
        _run_pip(["uninstall", "-y", "onnxruntime"], stream=stream_pip)
        did_repair = True
        cpu_version = None
        # Reinstall the active GPU runtime so any overwritten files are restored.
        if gpu_version:
            reinstall_spec = _runtime_install_spec("onnxruntime-gpu", installed_version=gpu_version)
            _record_action(
                actions,
                f"Reinstalling {reinstall_spec} to restore overwritten files",
                stream_pip=stream_pip,
            )
            _run_pip(
                ["install", "--no-deps", "--upgrade", "--force-reinstall", reinstall_spec],
                stream=stream_pip,
            )
            did_repair = True
            gpu_version = pinned_gpu_version or gpu_version
            cuda_runtime_needs_refresh = True
        if dml_version:
            reinstall_spec = _runtime_install_spec("onnxruntime-directml", installed_version=dml_version)
            _record_action(
                actions,
                f"Reinstalling {reinstall_spec} to restore overwritten files",
                stream_pip=stream_pip,
            )
            _run_pip(
                ["install", "--no-deps", "--upgrade", "--force-reinstall", reinstall_spec],
                stream=stream_pip,
            )
            did_repair = True

    # Step 2: if only the CPU package is installed on Windows, install the
    # appropriate GPU runtime only when vendor detection is confident. If CIM
    # sees no hardware (VM/RDP/driver issue/CPU-only machine), keep the small
    # CPU runtime instead of forcing a large GPU wheel on unsupported hardware.
    elif cpu_version and not gpu_version and not dml_version:
        if primary_vendor in ("nvidia", "amd", "intel"):
            _record_action(
                actions,
                f"CPU-only onnxruntime detected on Windows. Installing {target_runtime_spec} "
                f"(primary GPU vendor: {primary_vendor}) and removing onnxruntime.",
                stream_pip=stream_pip,
            )
            _run_pip(["uninstall", "-y", "onnxruntime"], stream=stream_pip)
            _run_pip(
                ["install", "--no-deps", "--upgrade", "--force-reinstall", target_runtime_spec],
                stream=stream_pip,
            )
            did_repair = True
            cpu_version = None
            if target_runtime == "onnxruntime-gpu":
                gpu_version = pinned_gpu_version or _version("onnxruntime-gpu")
                cuda_runtime_needs_refresh = True
            elif target_runtime == "onnxruntime-directml":
                dml_version = pinned_dml_version or _version("onnxruntime-directml")
        else:
            _record_action(
                actions,
                "CPU-only onnxruntime detected on Windows, but no supported GPU vendor was detected. Keeping CPU runtime.",
                stream_pip=stream_pip,
            )

    # Step 3: if both GPU runtimes are installed, keep only the one that
    # matches the detected vendor.
    if gpu_version and dml_version:
        keep = target_runtime
        drop = "onnxruntime-directml" if keep == "onnxruntime-gpu" else "onnxruntime-gpu"
        _record_action(
            actions,
            f"Both GPU runtimes installed. Keeping {keep}, removing {drop}.",
            stream_pip=stream_pip,
        )
        _run_pip(["uninstall", "-y", drop], stream=stream_pip)
        did_repair = True
        if drop == "onnxruntime-gpu":
            gpu_version = None
        else:
            dml_version = None

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
            _record_action(
                actions,
                f"Primary GPU vendor is {primary_vendor}. Swapping {current_runtime} "
                f"for {target_runtime_spec} to enable hardware acceleration.",
                stream_pip=stream_pip,
            )
            _run_pip(["uninstall", "-y", current_runtime], stream=stream_pip)
            _run_pip(
                ["install", "--no-deps", "--upgrade", "--force-reinstall", target_runtime_spec],
                stream=stream_pip,
            )
            did_repair = True
            if current_runtime == "onnxruntime-gpu":
                gpu_version = None
            if target_runtime == "onnxruntime-gpu":
                gpu_version = pinned_gpu_version or _version("onnxruntime-gpu")
                cuda_runtime_needs_refresh = True
            elif target_runtime == "onnxruntime-directml":
                dml_version = pinned_dml_version or _version("onnxruntime-directml")

    if (
        target_runtime == "onnxruntime-gpu"
        and gpu_version
        and pinned_gpu_version
        and gpu_version != pinned_gpu_version
    ):
        reinstall_spec = _runtime_install_spec("onnxruntime-gpu", installed_version=gpu_version)
        _record_action(
            actions,
            f"Installed onnxruntime-gpu {gpu_version} does not match release pin {pinned_gpu_version}. Reinstalling {reinstall_spec}.",
            stream_pip=stream_pip,
        )
        _run_pip(
            ["install", "--no-deps", "--upgrade", "--force-reinstall", reinstall_spec],
            stream=stream_pip,
        )
        did_repair = True
        gpu_version = pinned_gpu_version
        cuda_runtime_needs_refresh = True

    if (
        target_runtime == "onnxruntime-directml"
        and dml_version
        and pinned_dml_version
        and dml_version != pinned_dml_version
    ):
        reinstall_spec = _runtime_install_spec("onnxruntime-directml", installed_version=dml_version)
        _record_action(
            actions,
            f"Installed onnxruntime-directml {dml_version} does not match release pin {pinned_dml_version}. Reinstalling {reinstall_spec}.",
            stream_pip=stream_pip,
        )
        _run_pip(
            ["install", "--no-deps", "--upgrade", "--force-reinstall", reinstall_spec],
            stream=stream_pip,
        )
        did_repair = True
        dml_version = pinned_dml_version

    # Step 5: version metadata can be present even when the actual
    # `onnxruntime` package directory is broken (for example a namespace
    # package with no `get_available_providers`). Probe the import before
    # declaring the runtime healthy, and force-reinstall the selected runtime
    # when the import surface is corrupt even if the version already matches.
    try:
        _probe_ort_providers()
        provider_probe_error = ""
    except Exception as exc:
        provider_probe_error = str(exc)

    target_runtime_installed = (
        (target_runtime == "onnxruntime-gpu" and bool(gpu_version))
        or (target_runtime == "onnxruntime-directml" and bool(dml_version))
    )
    if provider_probe_error and target_runtime_installed:
        installed_target_version = gpu_version if target_runtime == "onnxruntime-gpu" else dml_version
        reinstall_spec = _runtime_install_spec(target_runtime, installed_version=installed_target_version)
        _record_action(
            actions,
            f"ONNX Runtime import is broken ({provider_probe_error}). Reinstalling {reinstall_spec}.",
            stream_pip=stream_pip,
        )
        _run_pip(
            ["install", "--no-deps", "--upgrade", "--force-reinstall", reinstall_spec],
            stream=stream_pip,
        )
        did_repair = True
        if target_runtime == "onnxruntime-gpu":
            gpu_version = _release_runtime_version("onnxruntime-gpu", _version("onnxruntime-gpu"))
            cuda_runtime_needs_refresh = True
        elif target_runtime == "onnxruntime-directml":
            dml_version = _release_runtime_version("onnxruntime-directml", _version("onnxruntime-directml"))

    # Step 6: NVIDIA users need the CUDA 12 + cuDNN 9 runtime DLLs to
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
        and (cuda_runtime_needs_refresh or not _version("nvidia-cudnn-cu12"))
    ):
        _record_action(
            actions,
            f"Installing CUDA 12 + cuDNN 9 runtime DLLs (~1.4 GB) so onnxruntime-gpu "
            f"{final_gpu_version} can use CUDAExecutionProvider",
            stream_pip=stream_pip,
        )
        _run_pip(
            [
                "install",
                "--no-warn-script-location",
                *_core_requirements_constraint_args(),
                _runtime_install_spec("onnxruntime-gpu", extras="cuda,cudnn", installed_version=final_gpu_version),
            ],
            stream=stream_pip,
        )
        did_repair = True

    if not actions:
        actions.append("No repair needed")

    state = get_install_state()
    state["actions"] = actions
    state["repaired"] = did_repair
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
    result = repair_windows_onnxruntime(stream_pip=not args.json) if args.auto else state

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
