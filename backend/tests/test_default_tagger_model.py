"""The tagger the UI preselects follows the computer's GPU (2026-10-26).

PixAI v1.0 (fresh 2025 tag list with characters and series) on an NVIDIA card
of 12 GB or more, the light SwinV2 everywhere else. PixAI v1.0 states its
measured memory, so a busy card does not page into RAM, and a CPU run that
would not fit in the free memory is refused with a clear message.
"""

from types import SimpleNamespace

import numpy as np

import pytest

import tagger as tagger_module
from config import DEFAULT_TAGGER_MODEL, TAGGER_MODELS
from services.tagging import default_model
from services.tagging.default_model import pick_default_tagger_model
from services.tagging.worker import _E2ETaggingStub

# Captured at import, before conftest swaps it for the hardware-free stand-in.
REAL_DEFAULT_TAGGER_MODEL = default_model.default_tagger_model

PIXAI = "pixai-tagger-v1.0"
SWINV2 = "wd-swinv2-tagger-v3"
CUDA = ["CUDAExecutionProvider", "CPUExecutionProvider"]


def _nvidia(vram_total_mb, providers=CUDA):
    return {
        "torch_cuda_available": True,
        "gpu_name": "NVIDIA GeForce RTX 3090",
        "gpu_vram_total_mb": vram_total_mb,
        "onnx_providers": providers,
        "gpu_devices": [],
    }


@pytest.fixture(autouse=True)
def _no_default_override(monkeypatch):
    monkeypatch.delenv(default_model.DEFAULT_TAGGER_ENV, raising=False)


def test_the_light_default_stays_swinv2():
    assert DEFAULT_TAGGER_MODEL == SWINV2
    assert pick_default_tagger_model({}) == SWINV2


@pytest.mark.parametrize(
    "vram_mb, expected",
    [
        (24576, PIXAI),
        (16384, PIXAI),
        (12288, PIXAI),
        (12044, PIXAI),
        (10240, SWINV2),
        (8192, SWINV2),
    ],
)
def test_pixai_is_the_default_on_an_nvidia_card_with_room_for_it(vram_mb, expected):
    """PixAI v1.0 needs about 8.3 GB free; a 12 GB card has that beside the desktop."""
    assert pick_default_tagger_model(_nvidia(vram_mb)) == expected


def test_no_cuda_runtime_keeps_swinv2():
    """DirectML or CPU-only ONNX Runtime cannot run PixAI v1.0 at a usable speed."""
    info = _nvidia(24576, providers=["DmlExecutionProvider", "CPUExecutionProvider"])

    assert pick_default_tagger_model(info) == SWINV2


def test_a_large_amd_card_with_the_cuda_package_installed_keeps_swinv2():
    """onnxruntime-gpu lists CUDA whatever the card is; only NVIDIA counts."""
    info = {
        "torch_cuda_available": False,
        "gpu_name": "AMD Radeon RX 7900 XTX",
        "gpu_vram_total_mb": 24576,
        "onnx_providers": CUDA,
        "gpu_devices": [{"vendor": "amd", "vram_total_mb": 24576}],
    }

    assert pick_default_tagger_model(info) == SWINV2


def test_an_nvidia_card_behind_an_integrated_gpu_is_found():
    """Without torch the primary adapter can be the Intel one; the NVIDIA card still counts."""
    info = {
        "torch_cuda_available": False,
        "gpu_name": "Intel(R) UHD Graphics 770",
        "gpu_vram_total_mb": 512,
        "onnx_providers": CUDA,
        "gpu_devices": [
            {"vendor": "intel", "vram_total_mb": 512},
            {"vendor": "nvidia", "vram_total_mb": 16376},
        ],
    }

    assert pick_default_tagger_model(info) == PIXAI


def test_an_explicit_setting_always_wins(monkeypatch):
    monkeypatch.setenv(default_model.DEFAULT_TAGGER_ENV, "wd-eva02-large-tagger-v3")

    assert pick_default_tagger_model(_nvidia(24576)) == "wd-eva02-large-tagger-v3"
    assert pick_default_tagger_model({}) == "wd-eva02-large-tagger-v3"


def test_the_catalog_default_and_its_recommended_badge_follow_the_pick(monkeypatch):
    from services.tagging.catalog import CatalogMixin

    monkeypatch.setattr(default_model, "default_tagger_model", lambda: PIXAI)
    catalog = CatalogMixin().get_tagger_models()
    recommended = [m["name"] for m in catalog["models"] if m["recommended"]]

    assert catalog["default"] == PIXAI
    assert recommended == [PIXAI]

    monkeypatch.setattr(default_model, "default_tagger_model", lambda: SWINV2)
    catalog = CatalogMixin().get_tagger_models()

    assert catalog["default"] == SWINV2
    assert [m["name"] for m in catalog["models"] if m["recommended"]] == [SWINV2]


def test_pixai_v1_asks_the_gpu_for_what_it_really_uses():
    """It held about 8.2 GB on an RTX 3090 (2026-10-26); the heavy tier's 3 GB
    let it start on a busy card, where Windows pages the rest into RAM."""
    from gpu_headroom import TAGGER_GPU_NEED_MB, tagger_gpu_need_mb

    need = tagger_gpu_need_mb(PIXAI)

    assert 8000 <= need <= 9000
    assert need > TAGGER_GPU_NEED_MB["heavy"]


def test_pixai_v1_gets_the_hard_gpu_memory_limit(monkeypatch):
    import gpu_headroom

    monkeypatch.setattr(gpu_headroom, "free_vram_mb", lambda: 20000.0)
    options = gpu_headroom.tagger_cuda_options(PIXAI)

    assert options is not None
    assert options["arena_extend_strategy"] == "kSameAsRequested"
    assert int(options["gpu_mem_limit"]) >= 8000 * 1024 * 1024


def _bare(model_name, *, gpu_busy=False):
    tagger = object.__new__(tagger_module.WD14Tagger)
    tagger.model_name = model_name
    tagger._gpu_busy_fallback = gpu_busy
    return tagger


def _free_ram(monkeypatch, gb):
    import psutil

    monkeypatch.setattr(
        psutil, "virtual_memory", lambda: SimpleNamespace(available=gb * 2**30)
    )


def test_a_cpu_run_without_enough_free_memory_is_refused(monkeypatch):
    _free_ram(monkeypatch, 3.1)
    need = TAGGER_MODELS[PIXAI]["minimum_cpu_available_ram_gb"]

    with pytest.raises(RuntimeError) as refused:
        _bare(PIXAI)._ensure_cpu_memory()

    message = str(refused.value)
    assert f"about {need} GB of free memory and 3.1 GB is free" in message
    assert "wd-swinv2-tagger-v3" in message
    assert "Another program" not in message


def test_the_refusal_says_when_the_gpu_was_busy(monkeypatch):
    _free_ram(monkeypatch, 3.1)

    with pytest.raises(RuntimeError, match="Another program is using the GPU memory"):
        _bare(PIXAI, gpu_busy=True)._ensure_cpu_memory()


def test_enough_memory_or_a_light_model_runs_on_the_cpu(monkeypatch):
    _free_ram(monkeypatch, 8.0)
    _bare(PIXAI)._ensure_cpu_memory()

    _free_ram(monkeypatch, 1.0)
    _bare(SWINV2)._ensure_cpu_memory()


class _NoSessionOrt:
    """Fails the test if a session is built after the memory check refused."""

    class SessionOptions:
        def __init__(self):
            self.intra_op_num_threads = 0
            self.inter_op_num_threads = 0

    class ExecutionMode:
        ORT_SEQUENTIAL = "ORT_SEQUENTIAL"

    class GraphOptimizationLevel:
        ORT_ENABLE_ALL = "ORT_ENABLE_ALL"

    @staticmethod
    def InferenceSession(*_args, **_kwargs):
        raise AssertionError("a CPU session was built without enough free memory")

    @staticmethod
    def get_available_providers():
        return CUDA


def test_loading_on_a_busy_gpu_stops_before_the_cpu_session(monkeypatch, tmp_path):
    """The path the owner hits: ComfyUI holds the card, PixAI would fall back
    to the CPU, and only 3 GB of RAM is free."""
    monkeypatch.setattr(tagger_module, "ort", _NoSessionOrt)
    monkeypatch.setattr(tagger_module, "hf_hub", object())
    _free_ram(monkeypatch, 3.0)
    tagger = tagger_module.WD14Tagger(model_name=PIXAI, use_gpu=True)
    monkeypatch.setattr(
        tagger,
        "_get_model_paths",
        lambda: (str(tmp_path / "m.onnx"), str(tmp_path / "t.json")),
    )

    def busy():
        tagger._gpu_busy_fallback = True
        return False

    monkeypatch.setattr(tagger, "_gpu_has_room", busy)

    with pytest.raises(RuntimeError, match="Another program is using the GPU memory"):
        tagger.load()


def test_with_torch_the_card_onnx_runtime_uses_decides():
    """CUDA device 0 is the card ONNX Runtime picks; a bigger second card does not count."""
    info = _nvidia(8192)
    info["gpu_devices"] = [
        {"vendor": "nvidia", "vram_total_mb": 8192},
        {"vendor": "nvidia", "vram_total_mb": 24576},
    ]

    assert pick_default_tagger_model(info) == SWINV2


def test_the_default_is_probed_again_rather_than_kept(monkeypatch):
    """A probe that failed, or ran before the GPU runtime was installed, must
    not fix the default until a restart."""
    import hardware_monitor

    # conftest replaces the real function; this test checks the real one.
    monkeypatch.setattr(default_model, "default_tagger_model", REAL_DEFAULT_TAGGER_MODEL)
    probes = [RuntimeError("probe failed"), _nvidia(24576)]

    def probe(**_kwargs):
        result = probes.pop(0)
        if isinstance(result, Exception):
            raise result
        return result

    monkeypatch.setattr(hardware_monitor, "get_system_info", probe)

    assert default_model.default_tagger_model() == SWINV2
    assert default_model.default_tagger_model() == PIXAI


def test_an_explicit_setting_skips_the_probe(monkeypatch):
    import hardware_monitor

    monkeypatch.setattr(default_model, "default_tagger_model", REAL_DEFAULT_TAGGER_MODEL)
    monkeypatch.setenv(default_model.DEFAULT_TAGGER_ENV, SWINV2)
    monkeypatch.setattr(hardware_monitor, "get_system_info", lambda **_k: pytest.fail("probed"))

    assert default_model.default_tagger_model() == SWINV2


def test_a_gpu_failure_mid_run_does_not_continue_on_a_cpu_without_room(monkeypatch, tmp_path):
    """GPU inference fails (often another program took the memory); the CPU
    session that would follow is refused the same way, with the reason."""
    _free_ram(monkeypatch, 3.0)
    tagger = _bare(PIXAI)
    tagger._resolved_model_path = str(tmp_path / "m.onnx")
    tagger._resolved_tags_path = str(tmp_path / "t.json")
    monkeypatch.setattr(
        tagger,
        "_create_session",
        lambda *_a: pytest.fail("a CPU session was built without enough free memory"),
    )

    with pytest.raises(RuntimeError, match="The GPU stopped running it"):
        tagger._fallback_to_cpu_session(RuntimeError("CUDA failure"))


def test_one_picture_per_call_keeps_the_chunk_but_not_the_gpu_check():
    """PixAI v1.0 runs one picture per call, so its working memory does not
    multiply with the chunk; it still decides whether the GPU has room."""
    from gpu_headroom import tagger_gpu_need_mb
    from hardware_monitor import recommend_tagger_config

    roomy = {
        "gpu_name": "NVIDIA GeForce RTX 3090",
        "gpu_vram_total_mb": 24576,
        "gpu_vram_available_mb": 21617,
        "onnx_providers": CUDA,
        "total_ram_gb": 32,
        "available_ram_gb": 20,
    }

    assert TAGGER_MODELS[PIXAI]["graph_batch_size"] == 1
    assert recommend_tagger_config(roomy, model_name=PIXAI)["recommended_batch_size"] > 1
    assert tagger_gpu_need_mb(PIXAI) >= TAGGER_MODELS[PIXAI]["activation_mb_per_image"]


# --- The refusal reaches the user, in their language, and stops the run ----


def _refusal(cause="gpu_busy"):
    from ai_runtime_guard import CpuMemoryShortError

    return CpuMemoryShortError(
        "PixAI v1.0 on the CPU needs about 6 GB of free memory and 3.1 GB is free.",
        code=f"tagger_cpu_memory_short_{cause}",
        params={"model": PIXAI, "need_gb": "6", "free_gb": "3.1"},
    )


def test_the_refusal_carries_a_code_and_its_numbers(monkeypatch):
    from ai_runtime_guard import CpuMemoryShortError

    _free_ram(monkeypatch, 3.1)
    with pytest.raises(CpuMemoryShortError) as refused:
        _bare(PIXAI, gpu_busy=True)._ensure_cpu_memory()
    assert refused.value.code == "tagger_cpu_memory_short_gpu_busy"
    assert refused.value.params == {"model": PIXAI, "need_gb": "6", "free_gb": "3.1"}

    with pytest.raises(CpuMemoryShortError) as plain:
        _bare(PIXAI)._ensure_cpu_memory()
    assert plain.value.code == "tagger_cpu_memory_short"


def test_one_picture_at_a_time_stops_on_the_refusal_instead_of_failing_each(monkeypatch):
    """PixAI v1.0 runs one picture per call; each picture's error was caught,
    so a refusal became "every picture failed" with the GPU retried each time."""
    from ai_runtime_guard import CpuMemoryShortError

    tagger = _bare(PIXAI)
    tagger._loaded = True
    tagger._supports_true_batch = False
    calls = []
    monkeypatch.setattr(tagger, "_runtime_chunk_size", lambda *_a: 4, raising=False)
    monkeypatch.setattr(
        tagger,
        "_preprocess_paths",
        lambda paths: [np.zeros((448, 448, 3), dtype=np.float32) for _ in paths],
        raising=False,
    )

    def refuse(_input):
        calls.append(1)
        raise _refusal("gpu_stopped")

    monkeypatch.setattr(tagger, "_run_inference", refuse, raising=False)

    with pytest.raises(CpuMemoryShortError):
        tagger.tag_batch(["a.png", "b.png", "c.png"])
    assert len(calls) == 1


class _RefusingAfterFirstBatch(_E2ETaggingStub):
    """Tags the first batch, then is refused the way PixAI v1.0 would be."""

    def __init__(self):
        self.calls = 0

    def tag_batch(self, image_paths, **kwargs):
        self.calls += 1
        if self.calls > 1:
            raise _refusal()
        return super().tag_batch(image_paths, **kwargs)


def test_mass_tag_stops_with_the_coded_reason_and_keeps_the_tags_so_far(
    fake_tagger_env, monkeypatch, tmp_path
):
    import database as db
    import services.tagging.worker as worker
    from tests.test_tagging_pins_worker import _add_image, _payload, _run_worker

    stub = _RefusingAfterFirstBatch()
    monkeypatch.setattr(worker, "_e2e_tagger_getter", lambda **_k: stub)
    ids = [_add_image(tmp_path, f"short-{index}.png") for index in range(6)]

    messages = _run_worker(_payload(ids))

    terminal = messages[-1]
    assert terminal["status"] == "error", terminal
    assert terminal["message_key"] == "cpu_memory_short", terminal["message"]
    assert terminal["message_args"] == {
        "code": "tagger_cpu_memory_short_gpu_busy",
        "model": PIXAI,
        "need_gb": "6",
        "free_gb": "3.1",
    }
    assert stub.calls == 2
    tagged = [image_id for image_id in ids if db.get_image_tags(image_id)]
    assert tagged == ids[:4]


def test_smart_tag_does_not_turn_a_refusal_into_pictures_without_tags():
    from ai_runtime_guard import CpuMemoryShortError
    from services.smart_tag.tagging import _tag_batch_with_thresholds

    class Refusing:
        model_name = PIXAI

        def tag_batch(self, _paths, **_kwargs):
            raise _refusal()

        def tag(self, _path, **_kwargs):
            raise _refusal()

    with pytest.raises(CpuMemoryShortError):
        _tag_batch_with_thresholds(
            Refusing(),
            ["a.png", "b.png"],
            general_threshold=0.35,
            character_threshold=0.85,
            copyright_threshold=0.35,
        )


def test_single_picture_tagging_answers_the_coded_refusal(test_client, monkeypatch, tmp_path):
    from PIL import Image

    from services import single_image_tag_service

    class Refusing:
        model_name = PIXAI

        def tag(self, _path, **_kwargs):
            raise _refusal("gpu_start_failed")

    monkeypatch.setattr(single_image_tag_service, "_load_tagger", lambda **_k: Refusing())
    image = tmp_path / "one.png"
    Image.new("RGB", (32, 32), color="red").save(image)

    response = test_client.post("/api/tag/single", json={"image_path": str(image)})

    assert response.status_code == 503
    body = response.json()
    assert body["code"] == "tagger_cpu_memory_short_gpu_start_failed"
    assert body["params"] == {"model": PIXAI, "need_gb": "6", "free_gb": "3.1"}
    assert "6 GB of free memory" in body["error"]


@pytest.fixture
def fake_tagger_env(test_db, monkeypatch):
    from tests.test_tagging_pins_worker import tsvc

    monkeypatch.setenv("SD_IMAGE_SORTER_E2E_FAKE_TAGGER", "1")
    monkeypatch.setattr(tsvc, "verify_image_readable", lambda path: (True, None))
    return test_db
