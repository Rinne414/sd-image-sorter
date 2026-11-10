"""Descriptions in languages other than English for the similarity search.

CLIP ViT-B/32's own text model reads English only: a Chinese query returned
the same unrelated pictures whatever it said. The optional multilingual text
model reads it against the vectors the library already has.
"""

from __future__ import annotations

import json
import struct

import numpy as np
import pytest

import clip_multilingual


@pytest.mark.parametrize(
    "text",
    [
        "绿色头发的女孩",
        "綠色頭髮的女孩",
        "猫耳",
        "雨の街",
        "비 오는 도시",
        "дождь в городе",
        "a girl 女孩",
    ],
)
def test_other_scripts_ask_for_the_multilingual_model(text):
    assert clip_multilingual.needs_multilingual(text) is True


@pytest.mark.parametrize(
    "text", ["a girl with green hair", "café at night", "1girl, solo", "", "  ", "？！"]
)
def test_english_and_latin_text_stays_with_the_english_model(text):
    assert clip_multilingual.needs_multilingual(text) is False


def _write_dense(path, shape=(512, 768), dtype="F32"):
    data = np.arange(shape[0] * shape[1], dtype=np.float32).reshape(shape)
    header = json.dumps(
        {
            "linear.weight": {
                "dtype": dtype,
                "shape": list(shape),
                "data_offsets": [0, data.nbytes],
            }
        }
    ).encode()
    path.write_bytes(struct.pack("<Q", len(header)) + header + data.tobytes())
    return data


def test_the_projection_is_read_from_its_safetensors_file(tmp_path):
    expected = _write_dense(tmp_path / "dense.safetensors")

    matrix = clip_multilingual.read_dense_matrix(tmp_path / "dense.safetensors")

    assert matrix.shape == (512, 768)
    assert np.array_equal(matrix, expected)


def test_a_projection_of_another_shape_is_refused(tmp_path):
    _write_dense(tmp_path / "dense.safetensors", shape=(256, 768))

    with pytest.raises(RuntimeError):
        clip_multilingual.read_dense_matrix(tmp_path / "dense.safetensors")


def test_installed_means_every_file_at_its_pinned_size(tmp_path, monkeypatch):
    monkeypatch.setattr(clip_multilingual, "models_dir", lambda: tmp_path)
    assert clip_multilingual.is_installed() is False
    assert clip_multilingual.health()["available"] is False
    assert (
        clip_multilingual.health()["message_key"] == "models.clipMultilingual.missing"
    )

    pinned = clip_multilingual._pinned()
    for name, path in clip_multilingual._paths().items():
        with open(path, "wb") as handle:
            handle.truncate(pinned[name].size_bytes)
    assert clip_multilingual.is_installed() is True
    assert clip_multilingual.health()["message_key"] == "models.clipMultilingual.ready"

    # A download that was cut off is not used.
    with open(clip_multilingual._paths()["onnx"], "wb") as handle:
        handle.truncate(1024)
    assert clip_multilingual.is_installed() is False


def test_prepare_fetches_the_three_pinned_files(tmp_path, monkeypatch):
    monkeypatch.setattr(clip_multilingual, "models_dir", lambda: tmp_path)
    asked = []

    def fake_fetch(pinned, target, download_file, *, model_name):
        asked.append((pinned.remote_path, target.name))
        return target

    monkeypatch.setattr(clip_multilingual.pinned_download, "fetch", fake_fetch)

    result = clip_multilingual.prepare(lambda *args, **kwargs: None)

    assert result == {"clip_multilingual_path": str(tmp_path)}
    assert sorted(name for _remote, name in asked) == [
        "dense.safetensors",
        "model.onnx",
        "tokenizer.json",
    ]
    assert {remote for remote, _name in asked} >= {
        "2_Dense/model.safetensors",
        "tokenizer.json",
    }


def test_a_chinese_query_is_read_by_the_multilingual_model_when_it_is_installed(
    monkeypatch,
):
    import similarity

    vector = np.ones(512, dtype=np.float32)
    monkeypatch.setattr(clip_multilingual, "is_installed", lambda: True)
    monkeypatch.setattr(clip_multilingual, "encode", lambda text: vector)

    def english_must_not_load():
        raise AssertionError("the English text model was asked to read Chinese")

    monkeypatch.setattr(similarity, "_get_text_embed_model", english_must_not_load)

    assert similarity.embed_text("绿色头发的女孩") is vector


def test_english_and_missing_model_keep_the_english_text_model(monkeypatch):
    import similarity

    class _English:
        def embed(self, texts):
            return [np.zeros(512, dtype=np.float32) for _ in texts]

    monkeypatch.setattr(similarity, "_get_text_embed_model", lambda: _English())
    monkeypatch.setattr(
        clip_multilingual,
        "encode",
        lambda text: (_ for _ in ()).throw(AssertionError("not installed")),
    )

    monkeypatch.setattr(clip_multilingual, "is_installed", lambda: False)
    assert similarity.embed_text("绿色头发的女孩").shape == (512,)

    monkeypatch.setattr(clip_multilingual, "is_installed", lambda: True)
    assert similarity.embed_text("a girl with green hair").shape == (512,)
