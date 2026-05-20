"""Auto-select the fastest reachable PyPI / PyTorch CUDA mirror.

The default ``pypi.org`` and ``download.pytorch.org`` Fastly CDN can drop to
500 KB/s from mainland China, while ``mirrors.tuna.tsinghua.edu.cn`` and
``mirror.sjtu.edu.cn`` typically sustain 20–80 MB/s. CUDA torch wheels are
~2.5 GB, so the round-trip difference is an hour vs a minute.

This module probes a small candidate list with concurrent HEAD requests,
caches the winner under ``data/state/mirror_cache.json`` with a 30-minute
TTL, and lets ``repair_torch_runtime.py`` consume the selected URL for
both PyPI deps (numpy, sympy, …) and the CUDA torch wheel itself.

Env overrides bypass the probe entirely:

- ``SD_IMAGE_SORTER_PYPI_MIRROR`` — name (``tuna|aliyun|ustc|official``) or full URL
- ``SD_IMAGE_SORTER_TORCH_CUDA_MIRROR`` — name (``tuna|sjtu|official``) or full URL
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import List, Optional, Tuple

import httpx

logger = logging.getLogger(__name__)

PYPI_OFFICIAL: str = "https://pypi.org/simple"
TORCH_CUDA_OFFICIAL: str = "https://download.pytorch.org/whl"

_CACHE_FILENAME: str = "mirror_cache.json"
_CACHE_TTL: timedelta = timedelta(minutes=30)
_PROBE_TIMEOUT_SEC: float = 1.5

# Probe suffix appended to each candidate base URL so we test the path pip
# will actually fetch, not just the host. Catches portal/landing pages that
# return 200 on `/` but 404 on the real PEP 503 package index (Aliyun's
# pytorch-wheels portal is the canonical example).
_PYPI_PROBE_SUFFIX: str = "/pip/"
_TORCH_CUDA_PROBE_SUFFIX: str = "/cu128/torch/"

PYPI_CANDIDATES: Tuple[Tuple[str, str], ...] = (
    ("tuna", "https://pypi.tuna.tsinghua.edu.cn/simple"),
    ("aliyun", "https://mirrors.aliyun.com/pypi/simple"),
    ("ustc", "https://pypi.mirrors.ustc.edu.cn/simple"),
    ("official", PYPI_OFFICIAL),
)
# Only SJTU + official have been verified as PEP 503-compatible CUDA wheel
# indexes (see Debt-24 in docs/TECHNICAL_DEBT_NOTES.md). Tuna does not host
# pytorch-wheels at all (returns 404). Aliyun's /pytorch-wheels/cuXXX/ returns
# 200 but only as a JS-rendered portal page — pip cannot parse it, and
# /pytorch-wheels/cuXXX/torch/ returns 404. Adding a mirror here without
# verifying `<base>/cu128/torch/` returns a real wheel index will route every
# user's CUDA install into a 404 dead-end.
TORCH_CUDA_CANDIDATES: Tuple[Tuple[str, str], ...] = (
    ("sjtu", "https://mirror.sjtu.edu.cn/pytorch-wheels"),
    ("official", TORCH_CUDA_OFFICIAL),
)


@dataclass(frozen=True)
class MirrorSelection:
    """Resolved mirror choice. ``source`` records how we arrived at it."""

    name: str
    index_url: str
    latency_ms: Optional[float]
    source: str


def _cache_path(data_dir: Path) -> Path:
    state_dir = data_dir / "state"
    state_dir.mkdir(parents=True, exist_ok=True)
    return state_dir / _CACHE_FILENAME


def _read_cache(data_dir: Path) -> dict:
    try:
        with _cache_path(data_dir).open("r", encoding="utf-8") as fh:
            data = json.load(fh)
            return data if isinstance(data, dict) else {}
    except (FileNotFoundError, json.JSONDecodeError, OSError) as exc:
        logger.debug("mirror cache read miss: %s", exc)
        return {}


def _write_cache(data_dir: Path, cache: dict) -> None:
    try:
        with _cache_path(data_dir).open("w", encoding="utf-8") as fh:
            json.dump(cache, fh, indent=2)
    except OSError as exc:
        logger.debug("mirror cache write failed: %s", exc)


def _entry_fresh(entry: dict) -> bool:
    try:
        expires_at = datetime.fromisoformat(entry["expires_at"])
    except (KeyError, ValueError, TypeError):
        return False
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    return expires_at > datetime.now(timezone.utc)


def _resolve_env_override(
    env_name: str,
    candidates: Tuple[Tuple[str, str], ...],
) -> Optional[MirrorSelection]:
    value = os.environ.get(env_name, "").strip()
    if not value:
        return None
    by_name = {name: url for name, url in candidates}
    if value in by_name:
        return MirrorSelection(name=value, index_url=by_name[value], latency_ms=None, source="env")
    if value.startswith("http://") or value.startswith("https://"):
        return MirrorSelection(name="custom", index_url=value, latency_ms=None, source="env")
    logger.warning("Ignoring %s=%r — not a known name or absolute URL", env_name, value)
    return None


async def _probe_one(
    client: httpx.AsyncClient,
    name: str,
    probe_url: str,
    base_url: str,
) -> Tuple[str, str, Optional[float]]:
    """Probe ``probe_url`` but report ``base_url`` as the result.

    pip uses the base URL as ``--index-url`` and appends ``<package>/`` itself,
    so we test a real PEP 503 path (``<base>/cu128/torch/`` for CUDA wheels)
    to catch mirrors that 200 on the host root but 404 on the actual index.
    """
    start = time.monotonic()
    try:
        resp = await client.head(probe_url, follow_redirects=True, timeout=_PROBE_TIMEOUT_SEC)
        if resp.status_code < 400:
            return (name, base_url, (time.monotonic() - start) * 1000.0)
        logger.debug("mirror probe %s -> HTTP %s for %s", name, resp.status_code, probe_url)
    except (httpx.HTTPError, httpx.TimeoutException) as exc:
        logger.debug("mirror probe failed for %s (%s): %s", name, probe_url, exc)
    return (name, base_url, None)


async def _probe_all(
    candidates: Tuple[Tuple[str, str], ...],
    probe_suffix: str,
) -> List[Tuple[str, str, Optional[float]]]:
    async with httpx.AsyncClient(timeout=_PROBE_TIMEOUT_SEC) as client:
        tasks = [
            _probe_one(client, name, f"{base}{probe_suffix}", base)
            for name, base in candidates
        ]
        return await asyncio.gather(*tasks)


def _pick_fastest(
    results: List[Tuple[str, str, Optional[float]]],
    candidates: Tuple[Tuple[str, str], ...],
) -> Tuple[str, str, Optional[float]]:
    reachable = [r for r in results if r[2] is not None]
    if reachable:
        reachable.sort(key=lambda r: r[2] or 0.0)
        return reachable[0]
    name, url = candidates[-1]
    return (name, url, None)


def _run_probe(
    candidates: Tuple[Tuple[str, str], ...],
    probe_suffix: str,
) -> Optional[List[Tuple[str, str, Optional[float]]]]:
    """Run the probe synchronously, returning None when we cannot block."""
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        try:
            return asyncio.run(_probe_all(candidates, probe_suffix))
        except Exception as exc:  # noqa: BLE001 — probe is best-effort
            logger.warning("mirror probe raised %s; falling back to default", exc)
            return None
    logger.debug("mirror probe skipped — already inside an event loop")
    return None


def _select_with_cache(
    cache_key: str,
    env_name: str,
    candidates: Tuple[Tuple[str, str], ...],
    probe_suffix: str,
    data_dir: Path,
    refresh: bool,
) -> MirrorSelection:
    override = _resolve_env_override(env_name, candidates)
    if override is not None:
        return override

    cache = _read_cache(data_dir)
    entry = cache.get(cache_key)
    if not refresh and isinstance(entry, dict) and _entry_fresh(entry):
        return MirrorSelection(
            name=str(entry.get("name") or "unknown"),
            index_url=str(entry.get("index_url") or candidates[-1][1]),
            latency_ms=entry.get("latency_ms"),
            source="cache",
        )

    results = _run_probe(candidates, probe_suffix)
    if results is None:
        name, url = candidates[-1]
        return MirrorSelection(name=name, index_url=url, latency_ms=None, source="default")

    pick = _pick_fastest(results, candidates)
    selection = MirrorSelection(
        name=pick[0],
        index_url=pick[1],
        latency_ms=pick[2],
        source="probe",
    )

    cache[cache_key] = {
        "name": selection.name,
        "index_url": selection.index_url,
        "latency_ms": selection.latency_ms,
        "expires_at": (datetime.now(timezone.utc) + _CACHE_TTL).isoformat(),
        "probed_results": [
            {"name": r[0], "url": r[1], "latency_ms": r[2]} for r in results
        ],
    }
    _write_cache(data_dir, cache)
    return selection


def select_pypi_index(data_dir: Path, refresh: bool = False) -> MirrorSelection:
    """Pick the fastest PyPI index. Cached for 30 minutes."""
    return _select_with_cache(
        cache_key="pypi",
        env_name="SD_IMAGE_SORTER_PYPI_MIRROR",
        candidates=PYPI_CANDIDATES,
        probe_suffix=_PYPI_PROBE_SUFFIX,
        data_dir=data_dir,
        refresh=refresh,
    )


def select_torch_cuda_host(data_dir: Path, refresh: bool = False) -> MirrorSelection:
    """Pick the fastest PyTorch CUDA wheel host (cuXXX tag appended later)."""
    return _select_with_cache(
        cache_key="torch_cuda",
        env_name="SD_IMAGE_SORTER_TORCH_CUDA_MIRROR",
        candidates=TORCH_CUDA_CANDIDATES,
        probe_suffix=_TORCH_CUDA_PROBE_SUFFIX,
        data_dir=data_dir,
        refresh=refresh,
    )


def clear_cache(data_dir: Path) -> None:
    """Drop the on-disk cache. Useful for tests and 'refresh mirrors' UI."""
    path = _cache_path(data_dir)
    try:
        path.unlink()
    except FileNotFoundError:
        pass
    except OSError as exc:
        logger.debug("mirror cache clear failed: %s", exc)
