"""Tests for console logging defaults."""

import importlib
import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))


def test_console_logging_config_suppresses_uvicorn_access_when_disabled(monkeypatch):
    monkeypatch.setenv("SD_IMAGE_SORTER_ACCESS_LOG", "false")
    monkeypatch.setenv("SD_IMAGE_SORTER_LOG_FILE", "false")
    import config
    config = importlib.reload(config)
    import main
    main = importlib.reload(main)

    main.configure_console_logging()

    assert config.LOG_ACCESS_ENABLED is False
    assert logging.getLogger("uvicorn.access").level == logging.WARNING


def test_console_logging_config_allows_uvicorn_access_when_enabled(monkeypatch):
    monkeypatch.setenv("SD_IMAGE_SORTER_ACCESS_LOG", "true")
    monkeypatch.setenv("SD_IMAGE_SORTER_LOG_FILE", "false")
    import config
    config = importlib.reload(config)
    import main
    main = importlib.reload(main)

    main.configure_console_logging()

    assert config.LOG_ACCESS_ENABLED is True
    assert logging.getLogger("uvicorn.access").level == logging.INFO


def test_console_logging_writes_rotating_file_log(monkeypatch, tmp_path):
    log_path = tmp_path / "backend.log"
    monkeypatch.setenv("SD_IMAGE_SORTER_LOG_FILE", "true")
    monkeypatch.setenv("SD_IMAGE_SORTER_LOG_FILE_PATH", str(log_path))
    monkeypatch.setenv("SD_IMAGE_SORTER_LOG_FILE_MAX_BYTES", "65536")
    monkeypatch.setenv("SD_IMAGE_SORTER_LOG_FILE_BACKUP_COUNT", "2")

    import config
    config = importlib.reload(config)
    import main
    main = importlib.reload(main)

    main.configure_console_logging()
    logging.getLogger("sd-image-sorter.test").info("file log smoke")
    for handler in logging.getLogger().handlers:
        handler.flush()

    assert config.LOG_FILE_PATH == str(log_path)
    assert log_path.exists()
    assert "file log smoke" in log_path.read_text(encoding="utf-8")


def test_read_bool_env_accepts_common_values(monkeypatch):
    monkeypatch.setenv("SD_IMAGE_SORTER_TEST_BOOL", "yes")
    import config
    assert config.read_bool_env("SD_IMAGE_SORTER_TEST_BOOL", False) is True

    monkeypatch.setenv("SD_IMAGE_SORTER_TEST_BOOL", "off")
    assert config.read_bool_env("SD_IMAGE_SORTER_TEST_BOOL", True) is False


def test_read_bool_env_reports_invalid_value(monkeypatch):
    monkeypatch.setenv("SD_IMAGE_SORTER_TEST_BOOL", "maybe")
    import pytest
    import config

    with pytest.raises(ValueError, match="Invalid SD_IMAGE_SORTER_TEST_BOOL: expected boolean"):
        config.read_bool_env("SD_IMAGE_SORTER_TEST_BOOL", False)


def test_log_file_defaults_are_bounded():
    import config
    assert config.LOG_FILE_ENABLED is True
    assert config.LOG_FILE_MAX_BYTES >= 64 * 1024
    assert config.LOG_FILE_BACKUP_COUNT >= 1
    assert config.LOG_FILE_PATH.endswith("backend.log")


def test_support_diagnostics_redacts_log_paths_and_tails_existing_log(tmp_path, monkeypatch):
    import importlib
    import config
    import main

    log_path = tmp_path / "backend.log"
    secret_root = tmp_path / "Secret User"
    image_path = secret_root / "outputs" / "private.png"
    log_path.write_text(
        "old line\n"
        f"Scan heartbeat: folder={secret_root} current={image_path} idle_for=20.0s\n"
        f"Metadata extraction timed out after 1 seconds: {image_path}\n",
        encoding="utf-8",
    )

    monkeypatch.setattr(config, "LOG_FILE_PATH", str(log_path))
    monkeypatch.setattr(main, "LOG_FILE_PATH", str(log_path))
    payload = main.build_support_diagnostics(max_lines=5)

    assert payload["log_file_enabled"] is True
    assert payload["log_file_path"] == str(log_path)
    assert payload["log_file_path_redacted"] == "<PATH>"
    assert payload["log_file_exists"] is True
    assert payload["log_line_count"] == 3
    assert "<PATH>" in payload["recent_log_text"]
    assert str(secret_root) not in payload["recent_log_text"]
    assert str(image_path) not in payload["recent_log_text"]
    assert all(str(secret_root) not in line for line in payload["recent_log_lines"])
    assert all(str(image_path) not in line for line in payload["recent_log_lines"])
    assert "Secret User" not in payload["recent_log_text"]
    assert "current=<PATH> idle_for=20.0s" in payload["recent_log_text"]


def test_support_diagnostics_api_returns_payload(test_client, tmp_path, monkeypatch):
    import config
    import main

    log_path = tmp_path / "backend.log"
    log_path.write_text("Scan started\nScan heartbeat: current=demo.png\n", encoding="utf-8")
    monkeypatch.setattr(config, "LOG_FILE_PATH", str(log_path))
    monkeypatch.setattr(main, "LOG_FILE_PATH", str(log_path))

    response = test_client.get("/api/support/diagnostics")

    assert response.status_code == 200
    data = response.json()
    assert data["log_file_exists"] is True
    assert "Scan heartbeat" in data["recent_log_text"]

def test_support_open_log_uses_configured_log_path(tmp_path, monkeypatch):
    import main

    log_path = tmp_path / "backend.log"
    calls = []
    monkeypatch.setattr(main, "LOG_FILE_ENABLED", True)
    monkeypatch.setattr(main, "LOG_FILE_PATH", str(log_path))
    monkeypatch.setattr(main.sys, "platform", "win32")
    monkeypatch.setattr(main.subprocess, "Popen", lambda args: calls.append(args))

    result = main.open_support_log_file()

    assert result["success"] is True
    assert result["opened"] is True
    assert result["path"] == str(log_path)
    assert result["path_redacted"] == "<PATH>"
    assert log_path.exists()
    assert calls == [["explorer", "/select,", str(log_path.resolve())]]


def test_support_open_log_endpoint_returns_success(test_client, tmp_path, monkeypatch):
    import main

    log_path = tmp_path / "backend.log"
    calls = []
    monkeypatch.setattr(main, "LOG_FILE_ENABLED", True)
    monkeypatch.setattr(main, "LOG_FILE_PATH", str(log_path))
    monkeypatch.setattr(main.sys, "platform", "linux")
    monkeypatch.setattr(main.shutil, "which", lambda name: "/usr/bin/xdg-open" if name == "xdg-open" else None)
    monkeypatch.setattr(main.subprocess, "Popen", lambda args: calls.append(args))

    response = test_client.post("/api/support/open-log")

    assert response.status_code == 200
    data = response.json()
    assert data["success"] is True
    assert data["opened"] is True
    assert data["exists"] is True
    assert data["path_redacted"] == "<PATH>"
    assert calls == [["/usr/bin/xdg-open", str(log_path.parent.resolve())]]


def test_support_open_log_returns_path_when_file_manager_is_unavailable(test_client, tmp_path, monkeypatch):
    import main

    log_path = tmp_path / "backend.log"
    calls = []
    monkeypatch.setattr(main, "LOG_FILE_ENABLED", True)
    monkeypatch.setattr(main, "LOG_FILE_PATH", str(log_path))
    monkeypatch.setattr(main.sys, "platform", "linux")
    monkeypatch.setattr(main.shutil, "which", lambda name: None)
    monkeypatch.setattr(main.subprocess, "Popen", lambda args: calls.append(args))

    response = test_client.post("/api/support/open-log")

    assert response.status_code == 200
    data = response.json()
    assert data["success"] is False
    assert data["opened"] is False
    assert data["exists"] is True
    assert data["path"] == str(log_path)
    assert data["path_redacted"] == "<PATH>"
    assert "No OS file manager" in data["message"]
    assert calls == []
