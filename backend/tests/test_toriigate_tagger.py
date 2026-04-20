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

    tagger = ToriiGateTagger(use_gpu=True)
    tagger._apply_cuda_memory_guard()

    assert calls
    fraction, device = calls[0]
    assert 0.3 <= fraction <= 0.95
    assert device == 0
