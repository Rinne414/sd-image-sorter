"""Errors from today's endpoints are said in the UI language.

Collect by URL, the ComfyUI address, the browser extension pairing, video
support and folder watching answer errors as ``{code, message, params}``. The
page shows ``apiError.<code>`` from its language pack (filled with ``params``)
and keeps the English ``message`` as the fallback (frontend/js/api-error-text.js).

1. Every code these endpoints can send has a sentence in en.js and zh-CN.js.
2. ``apiErrorText`` really picks the pack sentence, fills it, and falls back.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
BACKEND = REPO / "backend"
LANG = REPO / "frontend" / "js" / "lang"

SOURCES = [
    "services/collect_download.py",
    "services/collect_service.py",
    "services/collect_importer.py",
    "services/comfyui_client.py",
    "services/ext_pairing.py",
    "services/ffmpeg_install.py",
    "routers/collect.py",
    "routers/browser_extension.py",
    "routers/generator_recipe.py",
    "routers/videos.py",
    "routers/folder_watch.py",
]
# Fallback codes for errors with no fixed wording (an OS or network error
# text): the English message is shown as it is.
UNWORDED = {"collect_failed", "video_install_failed"}
ERROR_CLASSES = "CollectError|PairingError|InstallError|ComfyUIAddressError"

CODE_PATTERNS = [
    re.compile(r'\bcode\s*=\s*"([a-z][a-z0-9_]+)"'),
    re.compile(r'"code"\s*:\s*"([a-z][a-z0-9_]+)"'),
    re.compile(r'"last_error_code"\s*:\s*"([a-z][a-z0-9_]+)"'),
    # Positional code: the last string argument of an error constructor.
    re.compile(
        rf'(?:{ERROR_CLASSES})\((?:[^()]|\([^()]*\))*?,\s*"([a-z][a-z0-9_]+)",?\s*\)',
        re.S,
    ),
    # A helper called with (message, code).
    re.compile(r'_not_found\(\s*"[^"]*",\s*"([a-z][a-z0-9_]+)"\s*\)'),
]


def _codes() -> set[str]:
    codes: set[str] = set()
    for rel in SOURCES:
        text = (BACKEND / rel).read_text(encoding="utf-8")
        for pattern in CODE_PATTERNS:
            codes.update(pattern.findall(text))
    return codes - UNWORDED


def _pack_keys(name: str) -> set[str]:
    text = (LANG / name).read_text(encoding="utf-8")
    return set(re.findall(r"^\s*'(apiError\.[a-z0-9_]+)'\s*:", text, re.M))


def test_every_error_code_of_todays_endpoints_has_both_languages():
    codes = _codes()
    # The scan must really see the codes, or this test proves nothing.
    assert {
        "collect_site_refused",
        "comfyui_address_host",
        "ext_request_gone",
        "video_install_checksum_mismatch",
    } <= codes
    for pack in ("en.js", "zh-CN.js"):
        missing = sorted(
            f"apiError.{code}"
            for code in codes
            if f"apiError.{code}" not in _pack_keys(pack)
        )
        assert missing == [], pack


SCRIPT = r"""
const vm = require('vm');
const fs = require('fs');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const out = {};
for (const lang of ['zh-CN', 'en']) {
  const ctx = { window: {}, console };
  vm.createContext(ctx);
  for (const file of input.files) vm.runInContext(fs.readFileSync(file, 'utf8'), ctx);
  ctx.window.I18n.translations = { en: ctx.window.I18nLang_en, 'zh-CN': ctx.window.I18nLang_zhCN };
  ctx.window.I18n.currentLang = lang;
  out[lang] = input.bodies.map((body) => ctx.window.apiErrorText(body, 'fallback'));
}
process.stdout.write(JSON.stringify(out));
"""


@pytest.mark.skipif(shutil.which("node") is None, reason="node is not installed")
def test_api_error_text_says_a_coded_error_in_the_ui_language():
    bodies = [
        {
            "code": "collect_site_refused",
            "message": "The site answered 404 ...",
            "params": {"status": 404},
        },
        {
            "code": "comfyui_address_spaces",
            "error": "The ComfyUI address cannot contain spaces.",
        },
        {"code": "some_future_code", "message": "English only"},
        {"error": "Plain error"},
        {},
    ]
    files = [
        str(LANG / "en.js"),
        str(LANG / "zh-CN.js"),
        str(REPO / "frontend" / "js" / "i18n.js"),
        str(REPO / "frontend" / "js" / "api-error-text.js"),
    ]
    run = subprocess.run(
        ["node", "-e", SCRIPT],
        input=json.dumps({"files": files, "bodies": bodies}),
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=True,
    )
    said = json.loads(run.stdout)
    assert said["zh-CN"][0].startswith("网站返回了 404")
    assert said["en"][0].startswith("The site answered 404 instead of the picture.")
    assert said["zh-CN"][1] == "ComfyUI 地址里不能有空格。"
    # Unknown code and uncoded errors keep the server's English; nothing gives the fallback.
    assert said["zh-CN"][2] == "English only"
    assert said["zh-CN"][3] == "Plain error"
    assert said["zh-CN"][4] == "fallback"
