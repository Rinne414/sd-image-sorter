"""Repair Windows ONNX Runtime package conflicts for WD14 tagging.

Why this exists:
- `onnxruntime-gpu` is the correct Windows package for a local app that wants
  both GPU and CPU fallback.
- Some downstream packages still depend on the CPU package name
  `onnxruntime`, which can get installed afterwards and override the active
  runtime, leaving users stuck on CPU even when CUDA is available.

This script makes the launcher self-heal that state so users do not need to
understand the package split before using the app.
"""

from __future__ import annotations

import argparse
import json
import platform
import subprocess
import sys
from importlib import metadata
from typing import Any, Dict, Optional


def _version(dist_name: str) -> Optional[str]:
    try:
        return metadata.version(dist_name)
    except metadata.PackageNotFoundError:
        return None


def get_install_state() -> Dict[str, Any]:
    cpu_version = _version("onnxruntime")
    gpu_version = _version("onnxruntime-gpu")
    return {
        "platform": platform.system(),
        "python": sys.executable,
        "onnxruntime_version": cpu_version,
        "onnxruntime_gpu_version": gpu_version,
        "has_conflict": bool(cpu_version and gpu_version),
        "has_gpu_package": bool(gpu_version),
    }


def _run_pip(args: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "-m", "pip", "--disable-pip-version-check", *args],
        check=True,
        capture_output=True,
        text=True,
    )


def _probe_ort_providers() -> list[str]:
    code = "import onnxruntime as ort; print('\\n'.join(ort.get_available_providers()))"
    result = subprocess.run(
        [sys.executable, "-c", code],
        check=True,
        capture_output=True,
        text=True,
    )
    return [line.strip() for line in result.stdout.splitlines() if line.strip()]


def repair_windows_onnxruntime() -> Dict[str, Any]:
    state = get_install_state()
    actions: list[str] = []

    if state["platform"] != "Windows":
        state["actions"] = actions
        state["repaired"] = False
        return state

    cpu_version = state["onnxruntime_version"]
    gpu_version = state["onnxruntime_gpu_version"]

    if cpu_version and gpu_version:
        actions.append(f"Uninstalling conflicting onnxruntime {cpu_version}")
        _run_pip(["uninstall", "-y", "onnxruntime"])

        actions.append(f"Reinstalling onnxruntime-gpu {gpu_version} to restore overwritten files")
        _run_pip(["install", "--no-deps", "--upgrade", "--force-reinstall", f"onnxruntime-gpu=={gpu_version}"])
    elif cpu_version and not gpu_version:
        actions.append("CPU-only onnxruntime detected on Windows. Installing onnxruntime-gpu and removing onnxruntime.")
        _run_pip(["install", "--upgrade", "--force-reinstall", "onnxruntime-gpu"])
        _run_pip(["uninstall", "-y", "onnxruntime"])
    else:
        actions.append("No repair needed")

    state = get_install_state()
    state["actions"] = actions
    state["repaired"] = any(action != "No repair needed" for action in actions)
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
        elif result.get("repaired"):
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
