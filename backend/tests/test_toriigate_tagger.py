"""
Unit tests for the ToriiGate multimodal tagger adapter.
"""

import sys
from pathlib import Path
from types import SimpleNamespace

from PIL import Image

sys.path.insert(0, str(Path(__file__).parent.parent))

import toriigate_tagger as toriigate_module  # noqa: E402
from toriigate_tagger import ToriiGateTagger  # noqa: E402


def test_toriigate_revision_is_pinned_to_commit_hash():
    assert toriigate_module.TORIIGATE_COMMIT_HASH != "main"
    assert len(toriigate_module.TORIIGATE_COMMIT_HASH) == 40


def test_extract_tags_normalizes_reasoning_and_booru_style_output():
    text = """
    <think>hidden reasoning</think>
    Tags: Explicit, 1girl, Hu Tao (Genshin Impact), long hair, red eyes, pussy
    """

    tags = ToriiGateTagger._extract_tags(text)

    assert tags[0] == "explicit"
    assert "1girl" in tags
    assert "hu_tao_(genshin_impact)" in tags
    assert "long_hair" in tags
    assert "red_eyes" in tags
    assert "pussy" in tags


def test_build_result_splits_rating_and_character_tags():
    result = ToriiGateTagger._build_result(
        "general, hu_tao_(genshin_impact), 1girl, long_hair"
    )

    assert result["rating"] == "general"
    assert any(tag["tag"] == "hu_tao_(genshin_impact)" for tag in result["character_tags"])
    assert any(tag["tag"] == "1girl" for tag in result["general_tags"])
    assert result["all_tags"][0]["tag"] == "general"


def test_build_result_derives_explicit_rating_from_nsfw_hint_tags():
    result = ToriiGateTagger._build_result(
        "1girl, nude, pussy, long_hair"
    )

    assert result["rating"] == "explicit"
    assert result["rating_confidences"]["explicit"] == 1.0


def test_extract_tags_from_short_caption_returns_useful_nsfw_tags():
    text = (
        "A girl with shoulder-length brown hair and red eyes is shown in a small monitor, "
        "wearing a dark blue blazer, white shirt, and red bow tie. She appears distressed, "
        "crying with her mouth open. Below, a girl's lower body is visible, restrained by "
        "black cuffs, with her legs spread wide, exposing her vulva and anus."
    )

    tags = ToriiGateTagger._extract_tags(text)

    assert "1girl" in tags
    assert "brown_hair" in tags
    assert "red_eyes" in tags
    assert "blue_blazer" in tags
    assert "white_shirt" in tags
    assert "red_bowtie" in tags
    assert "monitor" in tags
    assert "crying" in tags
    assert "restrained" in tags
    assert "spread_legs" in tags
    assert "pussy" in tags
    assert "anus" in tags


def test_extract_tags_from_structured_json_caption_avoids_giant_sentence_fragments():
    text = """
    {
      "General": "The image is framed like a security camera recording.",
      "Character 1": "A young girl with brown hair, red eyes, tears, a blue blazer, a white shirt, and a red bow tie.",
      "Character 2": "Her nude lower body is restrained against the wall with her legs spread wide, exposing her vulva and anus."
    }
    """

    tags = ToriiGateTagger._extract_tags(text)

    assert "security_camera" in tags
    assert "recording" in tags or "screen" in tags or "monitor" in tags
    assert "1girl" in tags
    assert "brown_hair" in tags
    assert "blue_blazer" in tags
    assert "white_shirt" in tags
    assert "pussy" in tags
    assert "anus" in tags
    assert not any(len(tag) > 40 for tag in tags)


def test_extract_tags_from_long_caption_does_not_treat_sentence_as_single_tag():
    text = (
        "The picture shows a girl with white hair and blue eyes wearing a white shirt. "
        "She is crying with her mouth open while looking at a screen."
    )

    tags = ToriiGateTagger._extract_tags(text)

    assert "1girl" in tags
    assert "white_hair" in tags
    assert "blue_eyes" in tags
    assert "white_shirt" in tags
    assert "crying" in tags
    assert "open_mouth" in tags
    assert not any("the_picture_shows" in tag for tag in tags)
    assert not any(len(tag) > 40 for tag in tags)


def test_resize_for_inference_caps_large_images():
    image = Image.new("RGB", (4096, 4096), color="white")

    resized = ToriiGateTagger._resize_for_inference(image)

    assert resized.size[0] * resized.size[1] <= 1024 * 1024
    assert resized.size[0] < image.size[0]
    assert resized.size[1] < image.size[1]


def test_build_result_marks_breasts_and_nipples_caption_as_explicit():
    result = ToriiGateTagger._build_result(
        "Girl with long white hair wearing a sheer dress, her large breasts and nipples visible through the fabric."
    )

    assert result["rating"] == "explicit"
    assert any(tag["tag"] == "1girl" for tag in result["general_tags"])
    assert any(tag["tag"] == "breasts" for tag in result["general_tags"])
    assert any(tag["tag"] == "nipples" for tag in result["general_tags"])


def test_apply_cuda_memory_guard_caps_toriigate_gpu_fraction(monkeypatch):
    calls = []

    fake_cuda = SimpleNamespace(
        is_available=lambda: True,
        set_per_process_memory_fraction=lambda fraction, device=0: calls.append((fraction, device)),
    )
    monkeypatch.setattr(
        toriigate_module,
        "torch",
        SimpleNamespace(cuda=fake_cuda),
    )
    monkeypatch.setattr(toriigate_module, "hf_hub", SimpleNamespace())
    monkeypatch.setattr(toriigate_module, "AutoProcessor", object())
    monkeypatch.setattr(toriigate_module, "Qwen3_5ForConditionalGeneration", object())

    tagger = ToriiGateTagger(use_gpu=True)
    tagger._apply_cuda_memory_guard()

    assert calls
    fraction, device = calls[0]
    assert 0.3 <= fraction <= 0.95
    assert device == 0


def test_decide_kv_cache_is_on_for_cpu():
    """On CPU the KV cache is free speed (no VRAM cost), so always enable it."""
    tagger = ToriiGateTagger.__new__(ToriiGateTagger)
    tagger.use_gpu = False
    assert tagger._decide_kv_cache() is True


def test_decide_kv_cache_gpu_gated_on_free_vram(monkeypatch):
    """On GPU the KV cache (≈2-4x faster) is only enabled when free VRAM is
    comfortable; a tight card stays cache-off to avoid an OOM mid-generation."""
    tagger = ToriiGateTagger.__new__(ToriiGateTagger)
    tagger.use_gpu = True

    class _FakeCuda:
        def __init__(self, free_mb):
            self._free = int(free_mb * 1024 * 1024)

        def is_available(self):
            return True

        def mem_get_info(self, _index=0):
            return (self._free, 24 * 1024 * 1024 * 1024)

    # Comfortable free VRAM -> KV cache ON.
    monkeypatch.setattr(toriigate_module, "torch", SimpleNamespace(cuda=_FakeCuda(8000)))
    assert tagger._decide_kv_cache() is True

    # Tight free VRAM (below threshold) -> KV cache OFF.
    monkeypatch.setattr(toriigate_module, "torch", SimpleNamespace(cuda=_FakeCuda(1000)))
    assert tagger._decide_kv_cache() is False

    # torch unavailable on a GPU request -> conservative OFF.
    monkeypatch.setattr(toriigate_module, "torch", None)
    assert tagger._decide_kv_cache() is False


# ---------------------------------------------------------------------------
# _sanitize_nl_text: the model often answers with (truncated) JSON even when
# asked for prose; the sanitized nl_text must never leak raw JSON downstream.
# ---------------------------------------------------------------------------


def test_sanitize_nl_text_extracts_description_from_full_json():
    raw = (
        '{"description": "A close-up shot focuses on the torso and thighs of a '
        'woman standing against a plain background.", "tags": "1girl, solo, skirt"}'
    )
    cleaned = ToriiGateTagger._sanitize_nl_text(raw)
    assert cleaned.startswith("A close-up shot focuses")
    assert "{" not in cleaned
    assert '"tags"' not in cleaned


def test_sanitize_nl_text_recovers_truncated_json():
    # The exact reported shape: max_new_tokens cut the JSON mid-string.
    raw = (
        '{"description": "A close-up shot focuses on the torso and thighs of a '
        'woman standing against a plain, light grey background, with her head '
        'cropped out of the frame.", "tags": "1girl, solo, head_out_of_frame, cropped_head,'
    )
    cleaned = ToriiGateTagger._sanitize_nl_text(raw)
    assert cleaned.startswith("A close-up shot focuses")
    assert cleaned.endswith("cropped out of the frame.")
    assert "{" not in cleaned
    assert "1girl" not in cleaned


def test_sanitize_nl_text_handles_truncation_inside_description_value():
    raw = '{"description": "A woman wearing a white collared shirt and a black neck'
    cleaned = ToriiGateTagger._sanitize_nl_text(raw)
    assert cleaned == "A woman wearing a white collared shirt and a black neck"


def test_sanitize_nl_text_unescapes_json_string_escapes():
    raw = '{"description": "She says \\"hello\\" softly.", "tags": "1girl"}'
    cleaned = ToriiGateTagger._sanitize_nl_text(raw)
    assert cleaned == 'She says "hello" softly.'


def test_sanitize_nl_text_returns_empty_for_tags_only_json():
    # Booru tags come from the booru tagger; a tags-only JSON answer must not
    # turn into a fake "caption" duplicating them.
    raw = '{"tags": "1girl, solo, long_hair"}'
    assert ToriiGateTagger._sanitize_nl_text(raw) == ""


def test_sanitize_nl_text_keeps_plain_prose_untouched():
    raw = "A girl with long hair stands in a sunny field. She is smiling."
    assert ToriiGateTagger._sanitize_nl_text(raw) == raw


def test_sanitize_nl_text_keeps_prose_with_inline_key_value_untouched():
    raw = 'A monitor overlay reads "status": "recording" while the subject stands still.'
    assert ToriiGateTagger._sanitize_nl_text(raw) == raw


def test_sanitize_nl_text_keeps_bracketed_prose_untouched():
    raw = "[wide shot] A girl with long hair stands in a sunny field."
    assert ToriiGateTagger._sanitize_nl_text(raw) == raw


def test_sanitize_nl_text_keeps_braced_shot_label_prose_untouched():
    raw = "{close-up} A girl with long hair stands in a sunny field."
    assert ToriiGateTagger._sanitize_nl_text(raw) == raw


def test_sanitize_nl_text_extracts_top_level_caption_key_without_braces():
    raw = '"caption": "A girl stands in a field.", "tags": "1girl, solo"'
    assert ToriiGateTagger._sanitize_nl_text(raw) == "A girl stands in a field."


def test_sanitize_nl_text_extracts_fenced_json():
    raw = '```json\n{"description": "A cat sleeps on a sofa.", "tags": "cat, sofa"}\n```'
    assert ToriiGateTagger._sanitize_nl_text(raw) == "A cat sleeps on a sofa."


def test_sanitize_nl_text_strips_reasoning_before_parsing():
    raw = '<think>internal</think>{"description": "A cat sleeps on a sofa."}'
    assert ToriiGateTagger._sanitize_nl_text(raw) == "A cat sleeps on a sofa."


def test_build_result_exposes_sanitized_nl_text_alongside_raw_text():
    raw = '{"description": "A dog runs across a beach.", "tags": "dog, beach"}'
    result = ToriiGateTagger._build_result(raw)
    assert result["raw_text"] == raw, "raw_text stays untouched for debugging"
    assert result["nl_text"] == "A dog runs across a beach."


# ---------------------------------------------------------------------------
# Generation parameters (caption_length / max_new_tokens) + tag grounding.
# ---------------------------------------------------------------------------


def _bare_tagger(caption_length="detailed", max_new_tokens=0):
    """Instance without _ensure_imports (no torch/transformers needed)."""
    tagger = ToriiGateTagger.__new__(ToriiGateTagger)
    tagger.caption_length = "brief"
    tagger.max_new_tokens = toriigate_module.TORIIGATE_BRIEF_MAX_NEW_TOKENS
    tagger.allow_cpu_fallback = False
    tagger.set_generation_params(
        caption_length=caption_length, max_new_tokens=max_new_tokens
    )
    return tagger


def test_set_generation_params_derives_tokens_from_length():
    assert _bare_tagger("brief").max_new_tokens == 160
    assert _bare_tagger("detailed").max_new_tokens == 512


def test_set_generation_params_clamps_explicit_tokens():
    assert _bare_tagger("detailed", 5000).max_new_tokens == 1024
    assert _bare_tagger("brief", 5).max_new_tokens == 32
    assert _bare_tagger("brief", 300).max_new_tokens == 300


def test_set_generation_params_normalizes_unknown_length_to_detailed():
    tagger = _bare_tagger("weird-mode")
    assert tagger.caption_length == "detailed"
    assert tagger.max_new_tokens == 512


def test_make_prompt_detailed_mode_uses_detailed_query():
    prompt = _bare_tagger("detailed")._make_prompt()
    assert "long and detailed" in prompt.lower()
    assert "do not output json" in prompt.lower()


def test_make_prompt_brief_mode_uses_short_query():
    prompt = _bare_tagger("brief")._make_prompt()
    assert "quite short" in prompt.lower()
    assert "do not output json" in prompt.lower()


def test_make_prompt_grounds_tags_in_official_format():
    """P2-13c: grounding uses the exact ToriiGate model-card format — a
    '# Booru tags' block ahead of the query, tags in brackets."""
    prompt = _bare_tagger("detailed")._make_prompt(["1girl", "solo", "long_hair"])
    assert prompt.startswith("# Booru tags for the image\n[1girl, solo, long_hair]\n\n")
    assert "long and detailed" in prompt.lower()  # the query follows the block


def test_make_prompt_without_tags_has_no_grounding_section():
    prompt = _bare_tagger("detailed")._make_prompt()
    assert "Booru tags" not in prompt
    assert _bare_tagger("detailed")._make_prompt([]) == prompt


# ---------------------------------------------------------------------------
# Load guards (v3.4.3 black-screen fix): GPU pre-flight + CPU RAM-aware dtype.
# ---------------------------------------------------------------------------


def _fake_torch(available_vram_mb=24_000):
    free_bytes = int(available_vram_mb * 1024 * 1024)
    return SimpleNamespace(
        float32="float32",
        bfloat16="bfloat16",
        float16="float16",
        cuda=SimpleNamespace(
            is_available=lambda: True,
            is_bf16_supported=lambda: True,
            mem_get_info=lambda _i=0: (free_bytes, 24 * 1024 ** 3),
            empty_cache=lambda: None,
        ),
    )


def _patch_available_ram(monkeypatch, available_gb):
    import psutil

    monkeypatch.setattr(
        psutil,
        "virtual_memory",
        lambda: SimpleNamespace(available=int(available_gb * 1024 ** 3)),
    )


def test_cpu_dtype_uses_fp32_when_ram_is_plentiful(monkeypatch):
    monkeypatch.setattr(toriigate_module, "torch", _fake_torch())
    _patch_available_ram(monkeypatch, 32.0)
    tagger = _bare_tagger()
    assert tagger._cpu_dtype_for_available_ram() == "float32"


def test_cpu_dtype_downgrades_to_bf16_when_ram_is_tight(monkeypatch):
    monkeypatch.setattr(toriigate_module, "torch", _fake_torch())
    _patch_available_ram(monkeypatch, 15.0)
    tagger = _bare_tagger()
    assert tagger._cpu_dtype_for_available_ram() == "bfloat16"


def test_cpu_dtype_raises_clear_error_when_even_bf16_cannot_fit(monkeypatch):
    """A 16 GB machine with ~8 GB free must get an error message — not an
    OS-crushing 20+ GB fp32 load (the reported whole-machine black screen)."""
    import pytest

    monkeypatch.setattr(toriigate_module, "torch", _fake_torch())
    _patch_available_ram(monkeypatch, 8.0)
    tagger = _bare_tagger()
    with pytest.raises(RuntimeError, match="available RAM"):
        tagger._cpu_dtype_for_available_ram()


class _FakeQwenModel:
    def __init__(self):
        self.devices = []

    def to(self, device):
        self.devices.append(device)
        return self

    def eval(self):
        return self


def test_load_preflight_routes_to_cpu_when_fallback_explicitly_allowed(monkeypatch):
    """With less free VRAM than the ToriiGate floor, load() must decide CPU
    BEFORE touching the GPU (a doomed GPU load ends in a driver reset, not a
    clean exception)."""
    import contextlib

    fake_model = _FakeQwenModel()
    captured = {}

    def _fake_from_pretrained(_dir, **kwargs):
        captured.update(kwargs)
        return fake_model

    monkeypatch.setattr(toriigate_module, "torch", _fake_torch())
    monkeypatch.setattr(
        toriigate_module, "cuda_has_headroom", lambda _t, *, min_free_mb: False
    )
    monkeypatch.setattr(
        toriigate_module,
        "AutoProcessor",
        SimpleNamespace(from_pretrained=lambda _dir, **_k: SimpleNamespace()),
    )
    monkeypatch.setattr(
        toriigate_module,
        "Qwen3_5ForConditionalGeneration",
        SimpleNamespace(from_pretrained=_fake_from_pretrained),
    )
    monkeypatch.setattr(
        toriigate_module, "exclusive_ai_runtime", lambda _name: contextlib.nullcontext()
    )
    _patch_available_ram(monkeypatch, 32.0)

    tagger = _bare_tagger()
    tagger.model_name = "toriigate-0.5"
    tagger.use_gpu = True
    tagger.allow_cpu_fallback = True
    tagger.device = "cuda"
    tagger.model = None
    tagger.processor = None
    tagger._loaded = False
    tagger._resolved_model_dir = None
    tagger._session_refresh_interval = 0
    tagger._use_kv_cache = None
    monkeypatch.setattr(tagger, "_download_model", lambda: "/fake/model/dir")

    tagger.load()

    assert tagger.use_gpu is False
    assert tagger.device == "cpu"
    assert fake_model.devices == ["cpu"], "weights must never be moved to cuda"
    assert captured.get("torch_dtype") == "float32"
    assert tagger._loaded is True


def test_load_preflight_rejects_cpu_fallback_by_default(monkeypatch):
    import pytest

    monkeypatch.setattr(toriigate_module, "torch", _fake_torch())
    monkeypatch.setattr(
        toriigate_module,
        "cuda_has_headroom",
        lambda _t, *, min_free_mb: False,
    )
    monkeypatch.setattr(
        toriigate_module,
        "AutoProcessor",
        SimpleNamespace(from_pretrained=lambda *_a, **_k: SimpleNamespace()),
    )
    monkeypatch.setattr(
        toriigate_module,
        "Qwen3_5ForConditionalGeneration",
        SimpleNamespace(
            from_pretrained=lambda *_a, **_k: (_ for _ in ()).throw(
                AssertionError("model load must not run")
            )
        ),
    )

    tagger = _bare_tagger()
    tagger.model_name = "toriigate-0.5"
    tagger.use_gpu = True
    tagger.allow_cpu_fallback = False
    tagger.device = "cuda"
    tagger.model = None
    tagger.processor = None
    tagger._loaded = False
    tagger._resolved_model_dir = None
    tagger._session_refresh_interval = 0
    tagger._use_kv_cache = None
    monkeypatch.setattr(tagger, "_download_model", lambda: "/fake/model/dir")
    monkeypatch.setattr(
        tagger,
        "_cpu_dtype_for_available_ram",
        lambda: (_ for _ in ()).throw(AssertionError("CPU dtype must not run")),
    )

    with pytest.raises(RuntimeError, match="Refusing automatic CPU fallback"):
        tagger.load()

    assert tagger.use_gpu is True
    assert tagger.device == "cuda"
    assert tagger._loaded is False


def test_load_gpu_failure_does_not_retry_cpu_by_default(monkeypatch):
    """A Smart Tag GPU run must fail clearly instead of silently retrying a
    large CPU load. Users can still opt into CPU explicitly or via the env
    fallback switch."""
    import contextlib
    import pytest

    monkeypatch.setattr(toriigate_module, "torch", _fake_torch())
    monkeypatch.setattr(
        toriigate_module,
        "cuda_has_headroom",
        lambda _t, *, min_free_mb: True,
    )
    monkeypatch.setattr(
        toriigate_module,
        "AutoProcessor",
        SimpleNamespace(from_pretrained=lambda _dir, **_k: SimpleNamespace()),
    )

    calls = {"from_pretrained": 0, "cpu_dtype": 0}

    def _boom(_dir, **_kwargs):
        calls["from_pretrained"] += 1
        raise RuntimeError("cuda out of memory")

    monkeypatch.setattr(
        toriigate_module,
        "Qwen3_5ForConditionalGeneration",
        SimpleNamespace(from_pretrained=_boom),
    )
    monkeypatch.setattr(
        toriigate_module, "exclusive_ai_runtime", lambda _name: contextlib.nullcontext()
    )

    tagger = _bare_tagger()
    tagger.model_name = "toriigate-0.5"
    tagger.model_dir = "/fake"
    tagger.use_gpu = True
    tagger.allow_cpu_fallback = False
    tagger.device = "cuda"
    tagger.model = None
    tagger.processor = None
    tagger._loaded = False
    tagger._resolved_model_dir = None
    tagger._session_refresh_interval = 0
    tagger._use_kv_cache = None
    monkeypatch.setattr(tagger, "_download_model", lambda: "/fake/model/dir")

    def _no_cpu_dtype():
        calls["cpu_dtype"] += 1
        return "float32"

    monkeypatch.setattr(tagger, "_cpu_dtype_for_available_ram", _no_cpu_dtype)

    with pytest.raises(RuntimeError, match="cuda out of memory"):
        tagger.load()

    assert calls == {"from_pretrained": 1, "cpu_dtype": 0}
    assert tagger.use_gpu is True
    assert tagger._loaded is False


def test_tag_gpu_failure_does_not_recreate_cpu_session_by_default(monkeypatch):
    tagger = _bare_tagger()
    tagger.use_gpu = True
    tagger.allow_cpu_fallback = False
    tagger.device = "cuda"

    monkeypatch.setattr(
        tagger,
        "_generate_text",
        lambda _path, _tags=None: (_ for _ in ()).throw(RuntimeError("cuda oom")),
    )
    monkeypatch.setattr(
        tagger,
        "_recreate_session",
        lambda: (_ for _ in ()).throw(AssertionError("CPU retry must not run")),
    )

    result = tagger.tag("/tmp/img.png")

    assert result["error"] == "cuda oom"
    assert tagger.use_gpu is True
