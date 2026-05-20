"""Tests for the stdlib-only PyPI mirror probe used by run.bat / run.sh."""

from __future__ import annotations

from typing import Optional, Tuple

import pytest

import mirror_probe_stdlib
from mirror_probe_stdlib import (
    PYPI_CANDIDATES,
    PYPI_OFFICIAL,
    select_pypi_index_url,
)


@pytest.fixture(autouse=True)
def _isolate_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Drop the conftest-level env default so probe path is reachable."""
    monkeypatch.delenv("SD_IMAGE_SORTER_PYPI_MIRROR", raising=False)


def test_env_override_by_name(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SD_IMAGE_SORTER_PYPI_MIRROR", "tuna")
    assert select_pypi_index_url() == "https://pypi.tuna.tsinghua.edu.cn/simple"


def test_env_override_aliyun(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SD_IMAGE_SORTER_PYPI_MIRROR", "aliyun")
    assert select_pypi_index_url() == "https://mirrors.aliyun.com/pypi/simple"


def test_env_override_full_url(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SD_IMAGE_SORTER_PYPI_MIRROR", "https://mirror.example.com/simple")
    assert select_pypi_index_url() == "https://mirror.example.com/simple"


def test_unknown_env_value_falls_through_to_probe(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SD_IMAGE_SORTER_PYPI_MIRROR", "not-a-known-mirror")
    monkeypatch.setattr(
        mirror_probe_stdlib,
        "_probe_one",
        lambda name, base: (name, base, None),
    )
    assert select_pypi_index_url() == PYPI_OFFICIAL


def _make_fake_probe(latencies: dict):
    def _probe(name: str, base: str) -> Tuple[str, str, Optional[float]]:
        return (name, base, latencies.get(name))
    return _probe


def test_pick_fastest_reachable(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        mirror_probe_stdlib,
        "_probe_one",
        _make_fake_probe({"tuna": 12.0, "aliyun": 80.0, "ustc": 60.0, "official": 200.0}),
    )
    assert select_pypi_index_url() == "https://pypi.tuna.tsinghua.edu.cn/simple"


def test_pick_fastest_skips_unreachable(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        mirror_probe_stdlib,
        "_probe_one",
        _make_fake_probe({"tuna": None, "aliyun": 50.0, "ustc": None, "official": 200.0}),
    )
    assert select_pypi_index_url() == "https://mirrors.aliyun.com/pypi/simple"


def test_all_unreachable_returns_official(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        mirror_probe_stdlib,
        "_probe_one",
        _make_fake_probe({"tuna": None, "aliyun": None, "ustc": None, "official": None}),
    )
    assert select_pypi_index_url() == PYPI_OFFICIAL


def test_main_prints_picked_url_to_stdout(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture,
) -> None:
    monkeypatch.setattr(
        mirror_probe_stdlib,
        "_probe_one",
        _make_fake_probe({"tuna": 15.0, "aliyun": 50.0, "ustc": 60.0, "official": 200.0}),
    )
    rc = mirror_probe_stdlib.main()
    captured = capsys.readouterr()
    assert rc == 0
    # Bare URL, no trailing newline — run.bat uses `set /p <` which would
    # otherwise capture the newline as part of the value.
    assert captured.out == "https://pypi.tuna.tsinghua.edu.cn/simple"


def test_official_is_always_last_candidate() -> None:
    assert PYPI_CANDIDATES[-1] == ("official", PYPI_OFFICIAL)


def test_candidates_match_httpx_selector() -> None:
    """Both probes must agree on the candidate list so users do not see
    different mirrors picked by run.bat vs the in-app repair flow.
    """
    import mirror_selector
    assert PYPI_CANDIDATES == mirror_selector.PYPI_CANDIDATES
