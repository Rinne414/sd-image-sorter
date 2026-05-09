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



def test_thumbnail_cache_limit_defaults_to_500mb(monkeypatch, tmp_path):
    monkeypatch.delenv("SD_IMAGE_SORTER_THUMBNAIL_CACHE_MAX_MB", raising=False)
    monkeypatch.setattr(config, "APP_SETTINGS_CONFIG_PATH", tmp_path / "app-settings.json")

    assert config.get_thumbnail_cache_max_mb() == 500


def test_thumbnail_cache_limit_persists_to_app_settings(monkeypatch, tmp_path):
    monkeypatch.delenv("SD_IMAGE_SORTER_THUMBNAIL_CACHE_MAX_MB", raising=False)
    settings_path = tmp_path / "app-settings.json"
    monkeypatch.setattr(config, "APP_SETTINGS_CONFIG_PATH", settings_path)

    saved = config.save_thumbnail_cache_max_mb(256)

    assert saved == 256
    assert config.get_thumbnail_cache_max_mb() == 256
    assert '"thumbnail_cache_max_mb": 256' in settings_path.read_text(encoding="utf-8")


def test_thumbnail_cache_limit_env_override_wins(monkeypatch, tmp_path):
    monkeypatch.setenv("SD_IMAGE_SORTER_THUMBNAIL_CACHE_MAX_MB", "128")
    settings_path = tmp_path / "app-settings.json"
    settings_path.write_text('{"thumbnail_cache_max_mb": 256}', encoding="utf-8")
    monkeypatch.setattr(config, "APP_SETTINGS_CONFIG_PATH", settings_path)

    assert config.get_thumbnail_cache_max_mb() == 128
