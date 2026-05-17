"""Local VLM model management via Ollama.

Provides one-click download/deploy for vision-capable models like Gemma-4, Qwen2.5-VL, etc.
Uses Ollama's REST API for model pulling, listing, and status checking.
"""
from __future__ import annotations

import asyncio
import logging
import platform
import shutil
import subprocess
from typing import Any, AsyncGenerator, Dict, List, Optional

import httpx

logger = logging.getLogger(__name__)

DEFAULT_OLLAMA_URL = "http://localhost:11434"

# Vision-capable models recommended for captioning, ordered by VRAM requirement
RECOMMENDED_MODELS: List[Dict[str, Any]] = [
    {
        "id": "openbmb/minicpm-v4.6",
        "name": "MiniCPM-V 4.6",
        "size_gb": 1.6,
        "vram_min_gb": 3,
        "description": "OpenBMB MiniCPM-V 4.6 - tiny (1.6 GB), 256K context, great quality/size ratio",
        "nsfw_ok": False,
    },
    {
        "id": "gemma3:4b",
        "name": "Gemma 3 4B",
        "size_gb": 3.0,
        "vram_min_gb": 4,
        "description": "Google Gemma 3 4B - fast, good quality, vision-capable",
        "nsfw_ok": False,
    },
    {
        "id": "qwen3-vl:8b",
        "name": "Qwen3 VL 8B",
        "size_gb": 5.0,
        "vram_min_gb": 6,
        "description": "Alibaba Qwen3-VL 8B - latest Qwen vision model, strong reasoning + perception",
        "nsfw_ok": True,
    },
    {
        "id": "openbmb/minicpm-v4.5",
        "name": "MiniCPM-V 4.5",
        "size_gb": 5.9,
        "vram_min_gb": 8,
        "description": "OpenBMB MiniCPM-V 4.5 - excellent detail, 40K context, proven captioning quality",
        "nsfw_ok": False,
    },
    {
        "id": "gemma4:27b",
        "name": "Gemma 4 27B (MoE A4B)",
        "size_gb": 16.0,
        "vram_min_gb": 12,
        "description": "Google Gemma 4 27B - native vision, MoE (only 4B active), excellent quality",
        "nsfw_ok": False,
    },
    {
        "id": "prutser/gemma-4-26B-A4B-it-ara-abliterated",
        "name": "Gemma 4 26B Uncensored (Heretic)",
        "size_gb": 16.0,
        "vram_min_gb": 12,
        "description": "Gemma 4 26B abliterated - native vision, NSFW tolerant, community uncensored",
        "nsfw_ok": True,
    },
    {
        "id": "qwen2.5-vl:7b",
        "name": "Qwen 2.5 VL 7B",
        "size_gb": 4.7,
        "vram_min_gb": 6,
        "description": "Alibaba Qwen 2.5 VL 7B - proven for anime/CJK, NSFW tolerant, stable fallback",
        "nsfw_ok": True,
    },
    {
        "id": "qwen3-vl:32b",
        "name": "Qwen3 VL 32B",
        "size_gb": 20.0,
        "vram_min_gb": 24,
        "description": "Qwen3-VL 32B - best Qwen vision quality, needs high-end GPU",
        "nsfw_ok": True,
    },
]

# Qwen3-VL is the true vision successor to Qwen2.5-VL (not Qwen3.5/3.6 which are text-only).
# MiniCPM-V 4.5/4.6 from OpenBMB are excellent compact alternatives on Ollama.
# For NSFW: Gemma 4 Heretic or Qwen-family VL models are most tolerant.


class OllamaManager:
    """Manage local Ollama instance and models."""

    def __init__(self, base_url: str = DEFAULT_OLLAMA_URL):
        self.base_url = base_url.rstrip("/")

    async def is_running(self) -> bool:
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                resp = await client.get(self.base_url)
            return resp.status_code == 200
        except Exception:
            return False

    async def list_local_models(self) -> List[Dict[str, Any]]:
        """Get models already downloaded in Ollama."""
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.get(f"{self.base_url}/api/tags")
            if resp.status_code != 200:
                return []
            data = resp.json()
            return [
                {
                    "id": m.get("name", ""),
                    "size_gb": round((m.get("size") or 0) / (1024**3), 1),
                    "modified_at": m.get("modified_at", ""),
                }
                for m in data.get("models", [])
            ]
        except Exception:
            return []

    async def pull_model(self, model_name: str) -> AsyncGenerator[Dict[str, Any], None]:
        """Pull/download a model. Yields progress dicts."""
        async with httpx.AsyncClient(timeout=None) as client:
            async with client.stream(
                "POST",
                f"{self.base_url}/api/pull",
                json={"name": model_name, "stream": True},
            ) as resp:
                if resp.status_code != 200:
                    yield {"status": "error", "error": f"HTTP {resp.status_code}"}
                    return
                async for line in resp.aiter_lines():
                    if not line.strip():
                        continue
                    import json
                    try:
                        data = json.loads(line)
                        total = data.get("total", 0)
                        completed = data.get("completed", 0)
                        yield {
                            "status": data.get("status", ""),
                            "total": total,
                            "completed": completed,
                            "percent": round(completed / total * 100, 1) if total > 0 else 0,
                        }
                    except Exception:
                        continue

    async def delete_model(self, model_name: str) -> bool:
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                resp = await client.request("DELETE", f"{self.base_url}/api/delete", json={"name": model_name})
            return resp.status_code == 200
        except Exception:
            return False

    @staticmethod
    def is_ollama_installed() -> bool:
        # Check PATH first
        if shutil.which("ollama") is not None:
            return True
        # Check common Windows install locations (Ollama installer puts it here
        # by default but doesn't always update PATH for the current session)
        if platform.system() == "Windows":
            import os
            candidates = [
                os.path.join(os.environ.get("LOCALAPPDATA", ""), "Programs", "Ollama", "ollama.exe"),
                os.path.join(os.environ.get("PROGRAMFILES", ""), "Ollama", "ollama.exe"),
            ]
            for c in candidates:
                if c and os.path.isfile(c):
                    return True
        return False

    @staticmethod
    def get_install_instructions() -> str:
        system = platform.system()
        if system == "Windows":
            return "Download from https://ollama.com/download/windows and run the installer."
        if system == "Darwin":
            return "Run: brew install ollama  OR  download from https://ollama.com/download/mac"
        return "Run: curl -fsSL https://ollama.com/install.sh | sh"

    @staticmethod
    def _resolve_ollama_exe() -> Optional[str]:
        """Find the ollama executable. Returns absolute path or None."""
        # PATH first
        path_exe = shutil.which("ollama")
        if path_exe:
            return path_exe
        # Windows-specific install locations
        if platform.system() == "Windows":
            import os as _os
            candidates = [
                _os.path.join(_os.environ.get("LOCALAPPDATA", ""), "Programs", "Ollama", "ollama.exe"),
                _os.path.join(_os.environ.get("PROGRAMFILES", ""), "Ollama", "ollama.exe"),
            ]
            for c in candidates:
                if c and _os.path.isfile(c):
                    return c
        return None

    @staticmethod
    async def start_ollama() -> Dict[str, Any]:
        """Attempt to start Ollama service."""
        ollama_exe = OllamaManager._resolve_ollama_exe()
        if not ollama_exe:
            return {"status": "error", "error": "Ollama not installed", "instructions": OllamaManager.get_install_instructions()}
        try:
            if platform.system() == "Windows":
                subprocess.Popen([ollama_exe, "serve"], creationflags=subprocess.CREATE_NO_WINDOW)
            else:
                subprocess.Popen([ollama_exe, "serve"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            await asyncio.sleep(2)
            return {"status": "ok"}
        except Exception as e:
            return {"status": "error", "error": str(e)}
