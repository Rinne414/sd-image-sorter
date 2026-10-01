"""MS1b: the "trusted copy is gone or changed" sentence reaches the user as written.

``formatUserError`` (frontend/js/modules/utils/errors.js) replaces a long or
path-carrying backend message with "failed, try again", and runs model-name
patterns first. This loads the real file in a Node vm realm and feeds it the
real backend messages (tagger and TIPO), in both languages.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

import model_external  # noqa: E402
from tests._external_helpers import GGUF, ExternalWorld  # noqa: E402

ERRORS_JS = (
    Path(__file__).resolve().parents[2]
    / "frontend"
    / "js"
    / "modules"
    / "utils"
    / "errors.js"
)

SCRIPT = """
const vm = require('vm');
const fs = require('fs');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const out = {};
for (const lang of ['zh-CN', 'en']) {
  const ctx = { window: { I18n: { getLang: () => lang } }, document: { addEventListener() {} }, console };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(input.file, 'utf8'), ctx);
  ctx.message = input.message;
  ctx.context = input.context;
  out[lang] = vm.runInContext('formatUserError(new Error(message), context)', ctx);
}
process.stdout.write(JSON.stringify(out));
"""

pytestmark = pytest.mark.skipif(
    shutil.which("node") is None, reason="node is not installed"
)


def shown(message: str, context: str = "") -> dict:
    run = subprocess.run(
        ["node", "-e", SCRIPT],
        input=json.dumps(
            {"file": str(ERRORS_JS), "message": message, "context": context}
        ),
        capture_output=True,
        text=True,
        check=True,
        encoding="utf-8",
    )
    return json.loads(run.stdout)


@pytest.fixture
def world(tmp_path, monkeypatch) -> ExternalWorld:
    return ExternalWorld(tmp_path, monkeypatch)


def lost_message(world, model_id, variant, name, kind) -> str:
    path = world.add_file(model_id, variant, f"m/{name}.bin", GGUF, kind=kind)
    path.unlink()
    with pytest.raises(model_external.ExternalModelUnavailable) as raised:
        model_external.require_available(model_id, variant, name)
    return str(raised.value)


def test_the_tagger_sentence_is_shown_in_each_language(world):
    message = lost_message(
        world, "wd14", "wd-eva02-large-tagger-v3", "wd-eva02-large-tagger-v3", "comfyui"
    )

    result = shown(message)

    assert result["zh-CN"] == (
        "wd-eva02-large-tagger-v3: ComfyUI里的文件已不见或已变更。"
        "请到模型中心重新扫描，或下载到程序文件夹。"
    )
    assert result["en"] == (
        "wd-eva02-large-tagger-v3: The file in ComfyUI is gone or changed. "
        "Rescan in Model Center, or download it again."
    )


def test_the_tipo_sentence_survives_a_caller_context_too(world):
    message = lost_message(world, "tipo", "v2.1", "TIPO v2.1", "hf_cache")

    result = shown(message, "Suggest failed")

    assert result["zh-CN"].startswith(
        "Suggest failed：TIPO v2.1: HF 缓存里的文件已不见或已变更"
    )
    assert result["en"].startswith(
        "Suggest failed: TIPO v2.1: The file in Hugging Face cache is gone or changed"
    )


def test_a_wrapped_sentence_that_carries_a_path_is_not_shown_as_written():
    message = (
        "Failed to load C:/Users/x/secret.onnx: The file in ComfyUI is gone or changed. "
        "Rescan in Model Center. / see C:/Users/x"
    )

    result = shown(message, "Tagging failed")

    assert "secret" not in result["en"] and "secret" not in result["zh-CN"]
    assert "C:/Users" not in result["en"] and "C:/Users" not in result["zh-CN"]


def test_other_long_messages_still_collapse_to_the_generic_text():
    result = shown("x" * 200, "Tagging failed")

    assert result["en"] == "Failed to Tagging failed. Please try again."
