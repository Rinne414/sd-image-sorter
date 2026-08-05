from __future__ import annotations

import logging
import sys
from types import SimpleNamespace

from model_console_logging import StarterConsoleFilter, StarterConsoleFormatter
import runtime_env


def _record(message: str, **fields: object) -> logging.LogRecord:
    record = logging.LogRecord(
        name="model-test",
        level=logging.INFO,
        pathname=__file__,
        lineno=1,
        msg=message,
        args=(),
        exc_info=None,
    )
    for key, value in fields.items():
        setattr(record, key, value)
    return record


def test_console_formatter_surfaces_model_artifact_fields() -> None:
    formatter = StarterConsoleFormatter()

    rendered = formatter.format(
        _record(
            "Model artifact validation",
            model_id="florence-community/Florence-2-base",
            revision="0" * 40,
            endpoint="huggingface.co",
            artifact_file="tokenizer.json",
            status="file_ready",
            size_bytes=2048,
        )
    )

    assert rendered == (
        "[MODEL] file_ready model_id=florence-community/Florence-2-base "
        "file=tokenizer.json size=2.0 KiB revision=" + "0" * 40
        + " endpoint=huggingface.co"
    )


def test_console_formatter_keeps_prepare_and_normal_messages_readable() -> None:
    formatter = StarterConsoleFormatter()

    assert formatter.format(_record("[MODEL] prepare_start model_id=clip")) == (
        "[MODEL] prepare_start model_id=clip"
    )
    assert formatter.format(_record("Services initialized successfully")) == (
        "Services initialized successfully"
    )


def test_console_formatter_uses_compact_model_failure_message() -> None:
    formatter = StarterConsoleFormatter()
    record = _record(
        "[MODEL] prepare_failed model_id=cl-tagger-v2 message=line one\nline two",
        starter_console_message=(
            "[MODEL] prepare_failed model_id=cl-tagger-v2 "
            "action=accept Hugging Face terms, configure a token, then retry"
        ),
    )

    assert formatter.format(record) == (
        "[MODEL] prepare_failed model_id=cl-tagger-v2 "
        "action=accept Hugging Face terms, configure a token, then retry"
    )


def test_console_filter_hides_support_only_third_party_noise() -> None:
    console_filter = StarterConsoleFilter()
    http_record = _record("HTTP Request: HEAD https://huggingface.co/model")
    http_record.name = "httpx"
    warning_record = _record(
        "Warning: You are sending unauthenticated requests to the HF Hub."
    )
    warning_record.levelno = logging.WARNING
    open_clip_record = _record("Instantiating model architecture: CLIP")
    open_clip_record.name = "root"
    directory_record = _record("Created model directory: C:/models/wd14")
    directory_record.name = "config"
    suppressed_record = _record(
        "Model preparation failed",
        starter_console_suppress=True,
    )
    app_record = _record("Services initialized successfully")

    assert console_filter.filter(http_record) is False
    assert console_filter.filter(warning_record) is False
    assert console_filter.filter(open_clip_record) is False
    assert console_filter.filter(directory_record) is False
    assert console_filter.filter(suppressed_record) is False
    assert console_filter.filter(app_record) is True


def test_runtime_environment_hides_native_onnx_warnings_but_keeps_errors(monkeypatch) -> None:
    severities = []
    monkeypatch.setitem(
        sys.modules,
        "onnxruntime",
        SimpleNamespace(set_default_logger_severity=lambda value: severities.append(value)),
    )
    monkeypatch.setattr(runtime_env.sys, "platform", "linux")
    monkeypatch.setattr(runtime_env, "_prepared", False)

    runtime_env.prepare_onnxruntime_environment()

    assert severities == [3]
