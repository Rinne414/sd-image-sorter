"""Tests for the auto-ping mirror selector."""

from __future__ import annotations

import asyncio
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import List, Optional, Tuple

import pytest

import mirror_selector
import model_download_sources
from mirror_selector import (
    MirrorSelection,
    PYPI_CANDIDATES,
    PYPI_OFFICIAL,
    TORCH_CUDA_CANDIDATES,
    TORCH_CUDA_OFFICIAL,
    clear_cache,
    select_pypi_index,
    select_torch_cuda_host,
)


@pytest.fixture
def data_dir(tmp_path: Path) -> Path:
    """Clean per-test data directory."""
    return tmp_path


@pytest.fixture(autouse=True)
def _isolate_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Drop the conftest-level env defaults so tests start clean."""
    monkeypatch.delenv("SD_IMAGE_SORTER_PYPI_MIRROR", raising=False)
    monkeypatch.delenv("SD_IMAGE_SORTER_TORCH_CUDA_MIRROR", raising=False)


# ---------------------------------------------------------------------------
# env overrides
# ---------------------------------------------------------------------------

def test_pypi_env_override_by_name(data_dir: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SD_IMAGE_SORTER_PYPI_MIRROR", "tuna")
    selection = select_pypi_index(data_dir=data_dir)
    assert selection.source == "env"
    assert selection.name == "tuna"
    assert selection.index_url == "https://pypi.tuna.tsinghua.edu.cn/simple"


def test_pypi_env_override_with_full_url(data_dir: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SD_IMAGE_SORTER_PYPI_MIRROR", "https://mirror.example.com/simple")
    selection = select_pypi_index(data_dir=data_dir)
    assert selection.source == "env"
    assert selection.name == "custom"
    assert selection.index_url == "https://mirror.example.com/simple"


def test_torch_cuda_env_override_by_name(data_dir: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SD_IMAGE_SORTER_TORCH_CUDA_MIRROR", "sjtu")
    selection = select_torch_cuda_host(data_dir=data_dir)
    assert selection.source == "env"
    assert selection.name == "sjtu"


def test_unknown_env_value_falls_through_to_probe(
    data_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("SD_IMAGE_SORTER_PYPI_MIRROR", "not-a-known-mirror")
    monkeypatch.setattr(mirror_selector, "_run_probe", lambda candidates, suffix: None)
    selection = select_pypi_index(data_dir=data_dir)
    assert selection.source == "default"


# ---------------------------------------------------------------------------
# cache hit / miss
# ---------------------------------------------------------------------------

def test_fresh_cache_short_circuits_probe(
    data_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cache_file = data_dir / "state" / "mirror_cache.json"
    cache_file.parent.mkdir(parents=True, exist_ok=True)
    expires_at = (datetime.now(timezone.utc) + timedelta(minutes=10)).isoformat()
    cache_file.write_text(
        json.dumps(
            {
                "pypi": {
                    "name": "tuna",
                    "index_url": "https://pypi.tuna.tsinghua.edu.cn/simple",
                    "latency_ms": 17.4,
                    "expires_at": expires_at,
                }
            }
        ),
        encoding="utf-8",
    )

    def _explode(_candidates: Tuple, _suffix: str) -> None:
        raise AssertionError("fresh cache should not trigger a probe")

    monkeypatch.setattr(mirror_selector, "_run_probe", _explode)
    selection = select_pypi_index(data_dir=data_dir)
    assert selection.source == "cache"
    assert selection.name == "tuna"


def test_expired_cache_triggers_reprobe(
    data_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cache_file = data_dir / "state" / "mirror_cache.json"
    cache_file.parent.mkdir(parents=True, exist_ok=True)
    expired = (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat()
    cache_file.write_text(
        json.dumps(
            {
                "pypi": {
                    "name": "ustc",
                    "index_url": "https://pypi.mirrors.ustc.edu.cn/simple",
                    "latency_ms": 30.0,
                    "expires_at": expired,
                }
            }
        ),
        encoding="utf-8",
    )

    probe_results: List[Tuple[str, str, Optional[float]]] = [
        ("tuna", "https://pypi.tuna.tsinghua.edu.cn/simple", 12.0),
        ("aliyun", "https://mirrors.aliyun.com/pypi/simple", 45.0),
        ("ustc", "https://pypi.mirrors.ustc.edu.cn/simple", None),
        ("official", PYPI_OFFICIAL, 880.0),
    ]
    monkeypatch.setattr(mirror_selector, "_run_probe", lambda _c, _s: probe_results)
    selection = select_pypi_index(data_dir=data_dir)
    assert selection.source == "probe"
    assert selection.name == "tuna"
    assert selection.latency_ms == 12.0


# ---------------------------------------------------------------------------
# pick-fastest behaviour
# ---------------------------------------------------------------------------

def test_pick_fastest_skips_unreachable(
    data_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    probe_results: List[Tuple[str, str, Optional[float]]] = [
        ("sjtu", "https://mirror.sjtu.edu.cn/pytorch-wheels", None),
        ("official", TORCH_CUDA_OFFICIAL, 60.0),
    ]
    monkeypatch.setattr(mirror_selector, "_run_probe", lambda _c, _s: probe_results)
    selection = select_torch_cuda_host(data_dir=data_dir)
    assert selection.source == "probe"
    assert selection.name == "official"
    assert selection.latency_ms == 60.0


def test_all_unreachable_falls_back_to_last_candidate(
    data_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    probe_results: List[Tuple[str, str, Optional[float]]] = [
        (name, url, None) for name, url in TORCH_CUDA_CANDIDATES
    ]
    monkeypatch.setattr(mirror_selector, "_run_probe", lambda _c, _s: probe_results)
    selection = select_torch_cuda_host(data_dir=data_dir)
    assert selection.source == "probe"
    assert selection.name == TORCH_CUDA_CANDIDATES[-1][0]
    assert selection.latency_ms is None


def test_probe_returns_none_falls_back_to_default(
    data_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(mirror_selector, "_run_probe", lambda _c, _s: None)
    selection = select_pypi_index(data_dir=data_dir)
    assert selection.source == "default"
    assert selection.index_url == PYPI_OFFICIAL


# ---------------------------------------------------------------------------
# cache writes
# ---------------------------------------------------------------------------

def test_probe_writes_cache(data_dir: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    probe_results: List[Tuple[str, str, Optional[float]]] = [
        ("tuna", "https://pypi.tuna.tsinghua.edu.cn/simple", 14.0),
        ("aliyun", "https://mirrors.aliyun.com/pypi/simple", 80.0),
        ("ustc", "https://pypi.mirrors.ustc.edu.cn/simple", 90.0),
        ("official", PYPI_OFFICIAL, 600.0),
    ]
    monkeypatch.setattr(mirror_selector, "_run_probe", lambda _c, _s: probe_results)
    select_pypi_index(data_dir=data_dir)

    cache_file = data_dir / "state" / "mirror_cache.json"
    assert cache_file.exists()
    cached = json.loads(cache_file.read_text(encoding="utf-8"))
    assert cached["pypi"]["name"] == "tuna"
    assert cached["pypi"]["latency_ms"] == 14.0
    assert "expires_at" in cached["pypi"]


def test_clear_cache_removes_file(data_dir: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    probe_results: List[Tuple[str, str, Optional[float]]] = [
        ("tuna", "https://pypi.tuna.tsinghua.edu.cn/simple", 20.0),
        ("aliyun", "https://mirrors.aliyun.com/pypi/simple", 50.0),
        ("ustc", "https://pypi.mirrors.ustc.edu.cn/simple", 60.0),
        ("official", PYPI_OFFICIAL, 700.0),
    ]
    monkeypatch.setattr(mirror_selector, "_run_probe", lambda _c, _s: probe_results)
    select_pypi_index(data_dir=data_dir)
    cache_file = data_dir / "state" / "mirror_cache.json"
    assert cache_file.exists()
    clear_cache(data_dir=data_dir)
    assert not cache_file.exists()


def test_clear_cache_is_idempotent_on_missing_file(data_dir: Path) -> None:
    clear_cache(data_dir=data_dir)
    clear_cache(data_dir=data_dir)


# ---------------------------------------------------------------------------
# event loop safety
# ---------------------------------------------------------------------------

def test_inside_running_event_loop_does_not_block(
    data_dir: Path,
) -> None:
    captured: dict = {}

    async def _runner() -> None:
        captured["result"] = mirror_selector._run_probe(PYPI_CANDIDATES, "/pip/")

    asyncio.run(_runner())
    assert captured["result"] is None


# ---------------------------------------------------------------------------
# fallback list shape (sanity)
# ---------------------------------------------------------------------------

def test_official_is_always_last_pypi_candidate() -> None:
    assert PYPI_CANDIDATES[-1] == ("official", PYPI_OFFICIAL)


def test_official_is_always_last_torch_candidate() -> None:
    assert TORCH_CUDA_CANDIDATES[-1] == ("official", TORCH_CUDA_OFFICIAL)


# ---------------------------------------------------------------------------
# model download source semantics
# ---------------------------------------------------------------------------


def test_model_hf_endpoint_order_honors_hf_mirror_selection() -> None:
    endpoints = model_download_sources.get_hf_endpoint_order(mirror="hf-mirror", model_name="WD14")

    assert endpoints[0] == model_download_sources.HF_MIRROR_ENDPOINT
    assert model_download_sources.HF_OFFICIAL_ENDPOINT in endpoints


def test_modelscope_selection_falls_back_to_hf_mirror_for_hf_only_models() -> None:
    endpoints = model_download_sources.get_hf_endpoint_order(mirror="modelscope", model_name="ToriiGate")

    assert endpoints[0] == model_download_sources.HF_MIRROR_ENDPOINT
    assert model_download_sources.HF_OFFICIAL_ENDPOINT in endpoints
