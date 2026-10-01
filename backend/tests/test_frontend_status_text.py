"""The localised failure sentences are concrete and actionable, in zh and en.

Runs the real frontend builders (and the real ``formatUserError``) under node.
``formatUserError`` is meant for raw exception text: it replaces anything with
a path by "an unexpected error occurred" and anything mentioning ONNX / CUDA
by unrelated setup advice. Our own sentences must therefore never go through it.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

HARNESS = Path(__file__).with_name("frontend_status_text_harness.cjs")

pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="node is required")

PATH = "L:\\Pics"
GENERIC_ZH = ("发生了未预期的错误", "还没准备好")
GENERIC_EN = ("unexpected error", "not ready yet")


def _run(lang: str, cases: list[dict]) -> list[dict]:
    done = subprocess.run(
        ["node", str(HARNESS), lang, json.dumps(cases)],
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=60,
    )
    assert done.returncode == 0, done.stderr
    return json.loads(done.stdout)


def _scan(code: str, **args) -> dict:
    return {
        "fn": "scanStatusText",
        "progress": {
            "message_key": "error",
            "message_detail": "English text of the error",
            "message_detail_code": code,
            "message_detail_args": args,
        },
    }


def _gpu(key: str, reason_key: str) -> dict:
    return {
        "fn": "tagStatusText",
        "progress": {"message_key": key, "message_args": {"reason_key": reason_key}},
    }


@pytest.mark.parametrize(
    "lang, must_contain, generic",
    [
        ("zh-CN", ["导入失败", PATH, "数据库", "重新扫描"], GENERIC_ZH),
        (
            "en",
            ["Import failed", PATH, "database", "scan this folder again"],
            GENERIC_EN,
        ),
    ],
)
def test_library_root_write_failure_says_what_to_do(lang, must_contain, generic):
    [result] = _run(lang, [_scan("library_root_persist_failed", path=PATH)])

    for part in must_contain:
        assert part in result["text"], result["text"]
    assert not any(word in result["text"] for word in generic)


@pytest.mark.parametrize(
    "lang, must_contain",
    [
        ("zh-CN", ["无法打开文件夹", PATH, "Access is denied", "权限"]),
        ("en", ["Cannot open the folder", PATH, "Access is denied", "permission"]),
    ],
)
def test_inaccessible_root_names_the_folder_and_the_reason(lang, must_contain):
    [result] = _run(
        lang, [_scan("scan_root_inaccessible", path=PATH, reason="Access is denied")]
    )

    for part in must_contain:
        assert part in result["text"], result["text"]


def test_a_scan_error_without_a_code_shows_the_backend_sentence_as_written():
    [result] = _run("zh-CN", [_scan("")])

    assert result["text"].endswith("English text of the error")


def test_an_unexpected_error_shows_only_the_generic_failure():
    [result] = _run(
        "zh-CN",
        [{"fn": "scanStatusText", "progress": {"message_key": "error"}}],
    )

    assert result["text"] == "导入失败"


@pytest.mark.parametrize(
    "lang, reason_key, must_contain",
    [
        (
            "zh-CN",
            "no_gpu_provider",
            ["GPU 载入失败，改用 CPU 继续", "没有可用的 GPU 提供方"],
        ),
        ("zh-CN", "cuda_unavailable", ["CUDA", "CPU 版 PyTorch"]),
        ("en", "no_gpu_provider", ["Continuing on CPU", "no GPU provider"]),
        ("en", "cuda_unavailable", ["CUDA is unavailable"]),
    ],
)
def test_gpu_fallback_gives_the_concrete_reason(lang, reason_key, must_contain):
    [result] = _run(lang, [_gpu("gpu_load_failed", reason_key)])

    for part in must_contain:
        assert part in result["text"], result["text"]
    assert not any(word in result["text"] for word in GENERIC_ZH + GENERIC_EN)


def test_gpu_inference_fallback_names_its_reason_in_both_languages():
    zh, en = (
        _run(lang, [_gpu("gpu_inference_failed", "inference_failed")])[0]["text"]
        for lang in ("zh-CN", "en")
    )

    assert "GPU 推理失败，改用 CPU 继续：GPU 推理失败。" == zh
    assert en.startswith("GPU inference failed. Continuing on CPU: ")


def test_the_raw_formatter_would_have_hidden_these_causes():
    """Documents why the builders must not call it (the reviewer's probe)."""
    [probe] = _run(
        "zh-CN",
        [
            {
                "fn": "scanStatusText",
                "progress": {"message_key": "error"},
                "raw": "The ONNX runtime has no GPU provider on this machine.",
            }
        ],
    )

    assert "GPU provider" not in probe["formatted"]


def test_an_unknown_reason_key_falls_back_to_the_plain_sentence():
    [result] = _run("zh-CN", [_gpu("gpu_load_failed", "something_new")])

    assert result["text"] == "GPU 载入失败，改用 CPU 继续。"
