"""
Runtime environment preparation shared by the API process and spawned workers.
"""

import logging
import os
import site
import sys
import threading

logger = logging.getLogger(__name__)

_prepare_lock = threading.Lock()
_prepared = False


def prepare_onnxruntime_environment() -> None:
    """Make NVIDIA CUDA/cuDNN wheel DLLs visible on Windows in every process."""
    global _prepared
    if _prepared:
        return

    if sys.platform != "win32":
        _prepared = True
        return

    with _prepare_lock:
        if _prepared:
            return

        candidate_roots = set()
        try:
            for entry in site.getsitepackages():
                candidate_roots.add(os.path.join(entry, "nvidia"))
        except Exception as exc:
            logger.debug("Failed to inspect global site-packages for NVIDIA DLLs: %s", exc)

        try:
            user_site = site.getusersitepackages()
            if user_site:
                candidate_roots.add(os.path.join(user_site, "nvidia"))
        except Exception as exc:
            logger.debug("Failed to inspect user site-packages for NVIDIA DLLs: %s", exc)

        path_entries = set(filter(None, os.environ.get("PATH", "").split(os.pathsep)))
        for nvidia_root in candidate_roots:
            if not os.path.isdir(nvidia_root):
                continue
            try:
                package_names = os.listdir(nvidia_root)
            except OSError as exc:
                logger.debug("Failed to list %s: %s", nvidia_root, exc)
                continue

            for package_name in package_names:
                bin_dir = os.path.join(nvidia_root, package_name, "bin")
                if not os.path.isdir(bin_dir):
                    continue
                if bin_dir not in path_entries:
                    os.environ["PATH"] = bin_dir + os.pathsep + os.environ.get("PATH", "")
                    path_entries.add(bin_dir)
                try:
                    os.add_dll_directory(bin_dir)
                except (AttributeError, OSError):
                    pass

        _prepared = True
