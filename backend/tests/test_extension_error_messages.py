"""The browser extension says the program's errors in its own language (2026-10-26).

The program answers a refused save with ``{code, params, error}``; the
extension showed the English ``error`` sentence even in a Chinese browser.
Every ``collect_*`` / ``ext_*`` code the backend can send now has an
``apiError_<code>`` message in both extension locales, and
``SdisProgram.errorText`` picks it, filling the code's parameters.
"""

import json
import re
import shutil
import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
BACKEND = REPO / "backend"
LOCALES = REPO / "browser-extension" / "src" / "_locales"
PROGRAM_JS = REPO / "browser-extension" / "src" / "program.js"

# Answered by the extension's own messages instead of a coded one.
HANDLED_ELSEWHERE = {"ext_not_paired"}


def _backend_codes():
    codes = set()
    for path in [*BACKEND.glob("routers/*.py"), *BACKEND.glob("services/*.py")]:
        codes.update(
            re.findall(r'"((?:collect|ext)_[a-z_]+)"', path.read_text(encoding="utf-8"))
        )
    return codes - HANDLED_ELSEWHERE


def _messages(locale):
    return json.loads((LOCALES / locale / "messages.json").read_text(encoding="utf-8"))


@pytest.mark.parametrize("locale", ["en", "zh_CN"])
def test_every_error_code_has_an_extension_message(locale):
    codes = _backend_codes()
    assert {"collect_site_refused", "ext_bad_meta"} <= codes
    missing = sorted(
        code for code in codes if f"apiError_{code}" not in _messages(locale)
    )
    assert missing == []


def _error_text(locale, result):
    messages = _messages(locale)
    script = f"""
const messages = {json.dumps(messages, ensure_ascii=False)};
globalThis.chrome = {{
  i18n: {{
    getMessage(key, values) {{
      const entry = messages[key];
      if (!entry) return '';
      return entry.message.replace(/\\$(\\d)/g, (_m, n) => (values || [])[Number(n) - 1] ?? '');
    }},
  }},
}};
require({json.dumps(str(PROGRAM_JS))});
process.stdout.write(globalThis.SdisProgram.errorText({json.dumps(result)}));
"""
    output = subprocess.run(
        [shutil.which("node") or "node", "-e", script],
        capture_output=True,
        check=True,
        encoding="utf-8",
    )
    return output.stdout


@pytest.mark.skipif(shutil.which("node") is None, reason="needs Node.js")
def test_a_coded_error_is_said_in_the_browser_language():
    refused = {
        "status": 415,
        "data": {
            "code": "collect_site_refused",
            "params": {"status": 403},
            "error": "The site answered 403 instead of the picture.",
        },
    }

    assert _error_text("zh_CN", refused) == "网站返回了 403，没有给出图片。"
    assert _error_text("en", refused) == "The site answered 403 instead of the picture."


@pytest.mark.skipif(shutil.which("node") is None, reason="needs Node.js")
def test_an_unknown_code_falls_back_to_the_program_sentence():
    assert (
        _error_text(
            "zh_CN",
            {
                "status": 500,
                "data": {"code": "collect_new_thing", "error": "Something new."},
            },
        )
        == "Something new."
    )
    assert _error_text("zh_CN", {"status": 502, "data": {}}) == "HTTP 502"
