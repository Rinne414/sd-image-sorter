"""Send to generator: WebUI / NovelAI text, ComfyUI workflow, Run again in ComfyUI.

Format builders are checked against the program's own WebUI parser (round
trip). The endpoints run on real PNGs scanned through the normal pipeline;
ComfyUI is a tiny fake HTTP server on a free local port.
"""

from __future__ import annotations

import gzip
import json
import random
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest
from PIL import Image
from PIL.PngImagePlugin import PngInfo

import config
from database import get_db
from image_manager import scan_folder
from metadata_parser import get_parser
from services import generator_formats as formats

API_PROMPT = {
    "3": {
        "class_type": "KSampler",
        "inputs": {
            "seed": 123456,
            "steps": 28,
            "cfg": 6.5,
            "sampler_name": "euler_ancestral",
            "scheduler": "karras",
            "denoise": 1.0,
            "model": ["4", 0],
            "positive": ["6", 0],
            "negative": ["7", 0],
            "latent_image": ["5", 0],
        },
    },
    "4": {
        "class_type": "CheckpointLoaderSimple",
        "inputs": {"ckpt_name": "sdxl/anima.safetensors"},
    },
    "5": {
        "class_type": "EmptyLatentImage",
        "inputs": {"width": 832, "height": 1216, "batch_size": 1},
    },
    "6": {
        "class_type": "CLIPTextEncode",
        "inputs": {"text": "1girl, solo, sunset", "clip": ["4", 1]},
    },
    "7": {
        "class_type": "CLIPTextEncode",
        "inputs": {"text": "lowres, bad anatomy", "clip": ["4", 1]},
    },
    "8": {"class_type": "SamplerCustom", "inputs": {"noise_seed": ["9", 0], "cfg": 5}},
    "9": {"class_type": "Seed (rgthree)", "inputs": {"seed": -1}},
    "10": {"class_type": "KSamplerAdvanced", "inputs": {"noise_seed": 42, "steps": 20}},
}
UI_WORKFLOW = {
    "last_node_id": 10,
    "nodes": [{"id": 3, "type": "KSampler"}],
    "links": [],
}


def _png(path: Path, chunks: dict) -> Path:
    info = PngInfo()
    for key, value in chunks.items():
        info.add_text(key, value)
    Image.new("RGB", (16, 16), (90, 40, 120)).save(path, pnginfo=info)
    return path


def _scan(folder: Path) -> dict:
    scan_folder(str(folder), quick_import=True, precise_total=False)
    with get_db() as conn:
        rows = conn.execute("SELECT id, filename FROM images").fetchall()
    return {row["filename"]: int(row["id"]) for row in rows}


@pytest.fixture
def library(test_db, tmp_path):
    folder = tmp_path / "pics"
    folder.mkdir()
    _png(
        folder / "comfy.png",
        {"prompt": json.dumps(API_PROMPT), "workflow": json.dumps(UI_WORKFLOW)},
    )
    _png(
        folder / "webui.png",
        {
            "parameters": "1girl, solo\nNegative prompt: lowres\n"
            "Steps: 30, Sampler: DPM++ 2M, Schedule type: Karras, CFG scale: 7, "
            "Seed: 77, Size: 16x16, Model: anima, Hires upscale: 2"
        },
    )
    _png(folder / "plain.png", {})
    return _scan(folder)


class _FakeComfy(BaseHTTPRequestHandler):
    received: list = []
    reply_status = 200
    reply_body: dict = {"prompt_id": "abc-123", "number": 5, "node_errors": {}}
    reply_headers: dict = {}

    def do_POST(self):  # noqa: N802 - http.server API
        length = int(self.headers.get("Content-Length") or 0)
        type(self).received.append((self.path, json.loads(self.rfile.read(length))))
        body = json.dumps(type(self).reply_body).encode()
        self.send_response(type(self).reply_status)
        for key, value in type(self).reply_headers.items():
            self.send_header(key, value)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


@pytest.fixture
def fake_comfy():
    _FakeComfy.received = []
    _FakeComfy.reply_status = 200
    _FakeComfy.reply_body = {"prompt_id": "abc-123", "number": 5, "node_errors": {}}
    _FakeComfy.reply_headers = {}
    server = HTTPServer(("127.0.0.1", 0), _FakeComfy)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    config.save_comfyui_url_setting(f"http://127.0.0.1:{server.server_port}")
    yield _FakeComfy
    server.shutdown()
    server.server_close()


def _free_port() -> int:
    server = HTTPServer(("127.0.0.1", 0), BaseHTTPRequestHandler)
    port = server.server_port
    server.server_close()
    return port


# ---------------------------------------------------------------- builders


def test_webui_text_round_trips_through_the_programs_own_parser():
    params = {
        "steps": 28,
        "sampler": "euler_ancestral",
        "scheduler": "karras",
        "cfg_scale": 6.5,
        "seed": 123456,
        "size": "832x1216",
    }
    line = formats.build_webui_settings_line(
        params, checkpoint="models\\sdxl\\anima, v2.safetensors"
    )
    text = formats.build_webui_text(
        "1girl, solo,\n(sunset:1.2)", "lowres, bad anatomy", line
    )

    prompt, negative, checkpoint, _loras, parsed = get_parser()._parse_webui_parameters(
        text
    )

    assert prompt == "1girl, solo,\n(sunset:1.2)"
    assert negative == "lowres, bad anatomy"
    assert parsed["steps"] == 28
    assert parsed["sampler"] == "Euler a"
    assert parsed["schedule_type"] == "Karras"
    assert parsed["cfg_scale"] == 6.5
    assert parsed["seed"] == 123456
    assert parsed["size"] == "832x1216"
    assert parsed["model"].strip('"') == "anima, v2"
    assert checkpoint


def test_webui_text_without_negative_or_settings_stays_parseable():
    text = formats.build_webui_text(
        "a cat", "", formats.build_webui_settings_line({}, width=512, height=768)
    )
    prompt, negative, _ckpt, _loras, parsed = get_parser()._parse_webui_parameters(text)
    # A lone "Size:" line would land in WebUI's prompt, so it is left out.
    assert (prompt, negative, parsed) == ("a cat", None, None)
    assert text == "a cat"


def test_full_denoise_is_left_out_and_partial_denoise_kept():
    base = {"steps": 20, "sampler": "euler", "seed": 1}
    full = formats.build_webui_settings_line({**base, "denoising_strength": 1.0})
    partial = formats.build_webui_settings_line({**base, "denoising_strength": 0.45})
    assert "Denoising" not in full
    assert partial.endswith("Denoising strength: 0.45")


def test_nai_sampler_names_map_to_webui_names():
    assert formats.webui_sampler_name("k_euler_ancestral") == "Euler a"
    assert formats.webui_sampler_name("dpmpp_2m_sde_gpu") == "DPM++ 2M SDE"
    assert formats.webui_sampler_name("my_custom") == "my_custom"


def test_nai_text_has_prompt_characters_and_undesired_content():
    text = formats.build_nai_text(
        "2girls, garden",
        "lowres",
        [
            {"prompt": "girl, red hair", "negative_prompt": "hat"},
            {"prompt": "girl, blue hair"},
        ],
    )
    assert text == (
        "2girls, garden\n\nCharacter 1: girl, red hair\n\n"
        "Character 1 Undesired Content: hat\n\nCharacter 2: girl, blue hair\n\n"
        "Undesired Content: lowres"
    )


def test_workflow_extraction_and_paste_shape():
    chunks = {"prompt": json.dumps(API_PROMPT), "workflow": json.dumps(UI_WORKFLOW)}
    assert formats.comfy_api_prompt(chunks) == API_PROMPT
    workflow = formats.comfy_workflow(chunks)
    pasted = formats.pasteable_workflow(workflow)
    # ComfyUI's canvas loads pasted text only with version, nodes and extra.
    assert isinstance(pasted["extra"], dict) and pasted["version"] == 0.4
    assert pasted["nodes"] == UI_WORKFLOW["nodes"]
    assert "extra" not in workflow
    assert formats.comfy_api_prompt({"prompt": "1girl, solo"}) is None
    assert formats.comfy_workflow({"workflow": '{"nodes": {}}'}) is None


def test_new_seeds_leave_linked_and_special_inputs_alone():
    new_prompt, changed = formats.randomize_seeds(API_PROMPT, random.Random(7))

    assert changed == 2 == formats.count_seed_inputs(API_PROMPT)
    assert new_prompt["3"]["inputs"]["seed"] != 123456
    assert new_prompt["10"]["inputs"]["noise_seed"] != 42
    assert new_prompt["8"]["inputs"]["noise_seed"] == ["9", 0]
    assert new_prompt["9"]["inputs"]["seed"] == -1
    assert API_PROMPT["3"]["inputs"]["seed"] == 123456


# ---------------------------------------------------------------- endpoints


def test_recipe_for_a_comfyui_picture(test_client, library):
    body = test_client.get(
        f"/api/images/{library['comfy.png']}/generator-recipe"
    ).json()

    assert body["comfyui"]["has_api_prompt"] and body["comfyui"]["has_workflow"]
    assert body["comfyui"]["seed_inputs"] == 2
    assert body["comfyui"]["workflow"]["extra"] == {}
    assert body["metadata_source"] == "file"
    assert body["comfyui_url"] == "http://127.0.0.1:8188"
    parsed = get_parser()._parse_webui_parameters(body["webui_text"])
    assert parsed[0] == "1girl, solo, sunset"
    assert parsed[4]["seed"] == 123456 and parsed[4]["sampler"] == "Euler a"


def test_recipe_for_a_webui_picture_keeps_its_own_text(test_client, library):
    body = test_client.get(
        f"/api/images/{library['webui.png']}/generator-recipe"
    ).json()

    assert body["webui_is_original"] is True
    assert "Hires upscale: 2" in body["webui_text"]
    assert body["comfyui"]["has_api_prompt"] is False


def test_recipe_falls_back_to_the_stored_copy_when_the_file_is_gone(
    test_client, library, tmp_path
):
    image_id = library["plain.png"]
    envelope = gzip.compress(json.dumps({"prompt": json.dumps(API_PROMPT)}).encode())
    with get_db() as conn:
        conn.execute(
            "UPDATE images SET raw_metadata_gz = ?, path = ? WHERE id = ?",
            (envelope, str(tmp_path / "gone.png"), image_id),
        )
        conn.commit()

    body = test_client.get(f"/api/images/{image_id}/generator-recipe").json()

    assert body["metadata_source"] == "stored"
    assert body["comfyui"]["has_api_prompt"] is True


def test_unknown_picture_is_404(test_client, library):
    assert test_client.get("/api/images/999999/generator-recipe").status_code == 404


def test_queue_without_a_comfyui_recipe_says_so(test_client, library):
    response = test_client.post(
        f"/api/images/{library['webui.png']}/comfyui/queue", json={}
    )
    assert response.status_code == 422
    assert response.json()["code"] == "no_comfyui_recipe"


def test_queue_when_comfyui_is_down_names_the_address(test_client, library):
    address = f"http://127.0.0.1:{_free_port()}"
    config.save_comfyui_url_setting(address)

    response = test_client.post(
        f"/api/images/{library['comfy.png']}/comfyui/queue", json={}
    )

    assert response.status_code == 502
    detail = response.json()
    assert detail["code"] == "unreachable"
    assert f"ComfyUI is not reachable at {address}" in detail["message"]


def test_queue_with_a_new_seed(test_client, library, fake_comfy):
    response = test_client.post(
        f"/api/images/{library['comfy.png']}/comfyui/queue", json={"seed_mode": "new"}
    )

    assert response.status_code == 200, response.text
    assert response.json()["prompt_id"] == "abc-123"
    assert response.json()["seeds_changed"] == 2
    path, sent = fake_comfy.received[-1]
    assert path == "/prompt"
    assert sent["prompt"]["3"]["inputs"]["seed"] != 123456
    assert sent["prompt"]["8"]["inputs"]["noise_seed"] == ["9", 0]
    assert (
        sent["extra_data"]["extra_pnginfo"]["workflow"]["nodes"] == UI_WORKFLOW["nodes"]
    )


def test_queue_with_the_same_seed(test_client, library, fake_comfy):
    response = test_client.post(
        f"/api/images/{library['comfy.png']}/comfyui/queue", json={"seed_mode": "same"}
    )

    assert response.status_code == 200, response.text
    assert fake_comfy.received[-1][1]["prompt"] == API_PROMPT


def test_queue_reports_comfyui_refusal_and_never_follows_a_redirect(
    test_client, library, fake_comfy
):
    fake_comfy.reply_status = 400
    fake_comfy.reply_body = {
        "error": {"message": "Prompt outputs failed validation"},
        "node_errors": {
            "4": {
                "class_type": "CheckpointLoaderSimple",
                "errors": [{"details": "ckpt_name not in list"}],
            }
        },
    }
    refused = test_client.post(
        f"/api/images/{library['comfy.png']}/comfyui/queue", json={}
    )
    assert refused.status_code == 422
    assert "Prompt outputs failed validation" in refused.json()["message"]
    assert refused.json()["details"] == [
        "CheckpointLoaderSimple #4: ckpt_name not in list"
    ]

    fake_comfy.reply_status = 307
    fake_comfy.reply_headers = {"Location": "http://example.com/prompt"}
    redirected = test_client.post(
        f"/api/images/{library['comfy.png']}/comfyui/queue", json={}
    )
    assert redirected.status_code == 502
    assert redirected.json()["code"] == "redirect"
    assert len(fake_comfy.received) == 2


def test_save_workflow_file_numbers_a_second_copy(test_client, library):
    url = f"/api/images/{library['comfy.png']}/comfyui/workflow-file"
    first = test_client.post(url).json()
    second = test_client.post(url).json()

    folder = config.default_output_folder("workflows")
    assert Path(first["path"]) == folder / "comfy.json"
    assert Path(second["path"]) == folder / "comfy_2.json"
    saved = json.loads(Path(first["path"]).read_text(encoding="utf-8"))
    assert saved["nodes"] == UI_WORKFLOW["nodes"] and first["kind"] == "workflow"

    missing = test_client.post(
        f"/api/images/{library['webui.png']}/comfyui/workflow-file"
    )
    assert missing.status_code == 422


def test_comfyui_address_setting(test_client):
    assert (
        test_client.get("/api/settings/comfyui").json()["url"]
        == "http://127.0.0.1:8188"
    )

    saved = test_client.patch(
        "/api/settings/comfyui", json={"url": "192.168.1.20:8188/"}
    )
    assert saved.json()["url"] == "http://192.168.1.20:8188"

    for bad in ("ftp://host:21", "http://user:pw@host:8188", "http://host:99999"):
        assert (
            test_client.patch("/api/settings/comfyui", json={"url": bad}).status_code
            == 400
        )

    cleared = test_client.patch("/api/settings/comfyui", json={"url": ""})
    assert cleared.json()["custom_url"] == ""
