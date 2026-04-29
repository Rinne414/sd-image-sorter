"""Tests for environment variable parsing helpers."""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

import config  # noqa: E402


def test_read_int_env_returns_default_when_unset(monkeypatch):
    monkeypatch.delenv("SD_IMAGE_SORTER_TEST_INT", raising=False)

    assert config.read_int_env("SD_IMAGE_SORTER_TEST_INT", 42) == 42


def test_read_int_env_reports_invalid_value(monkeypatch):
    monkeypatch.setenv("SD_IMAGE_SORTER_TEST_INT", "abc")

    with pytest.raises(ValueError, match="Invalid SD_IMAGE_SORTER_TEST_INT: expected integer"):
        config.read_int_env("SD_IMAGE_SORTER_TEST_INT", 42)


def test_read_float_env_reports_invalid_value(monkeypatch):
    monkeypatch.setenv("SD_IMAGE_SORTER_TEST_FLOAT", "abc")

    with pytest.raises(ValueError, match="Invalid SD_IMAGE_SORTER_TEST_FLOAT: expected number"):
        config.read_float_env("SD_IMAGE_SORTER_TEST_FLOAT", 0.5)
