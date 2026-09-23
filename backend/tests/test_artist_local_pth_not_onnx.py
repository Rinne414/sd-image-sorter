"""A local Kaloscope .pth must not be opened as ONNX."""

from __future__ import annotations

from pathlib import Path

import artist_identifier as ai


def test_resolve_mapping_looks_in_parent(tmp_path):
    checkpoint = tmp_path / "448-90.13" / "best_checkpoint.pth"
    checkpoint.parent.mkdir()
    checkpoint.write_bytes(b"ckpt")
    mapping = tmp_path / "class_mapping.csv"
    mapping.write_text("class_id,class_name\n0,wlop\n", encoding="utf-8")

    ident = ai.ArtistIdentifier()
    found = ident._resolve_local_class_mapping(str(checkpoint))
    assert found is not None
    assert Path(found).name == "class_mapping.csv"


def test_pth_does_not_open_onnx_when_torch_blob_is_not_a_module(tmp_path, monkeypatch):
    checkpoint = tmp_path / "best_checkpoint.pth"
    checkpoint.write_bytes(b"not-onnx")

    onnx_calls: list[str] = []

    class _FakeOrt:
        def InferenceSession(self, path, providers=None):
            onnx_calls.append(str(path))
            raise AssertionError("ONNX must not load a .pth")

    monkeypatch.setitem(__import__("sys").modules, "onnxruntime", _FakeOrt())

    import torch

    monkeypatch.setattr(
        torch,
        "load",
        lambda *_args, **_kwargs: {"state_dict": {}, "args": None},
    )

    ident = ai.ArtistIdentifier(model_path=str(checkpoint), model_source="local")
    ident.load()

    assert onnx_calls == []
    assert ident._session is None
    assert ident._model is None
    assert ident._backend == "unloaded"
    err = str(ident._load_error or "").lower()
    assert "onnx" in err
    assert ".pth" in err or "pytorch" in err


def test_pth_with_parent_mapping_uses_kaloscope_not_onnx(tmp_path, monkeypatch):
    checkpoint = tmp_path / "448-90.13" / "best_checkpoint.pth"
    checkpoint.parent.mkdir()
    checkpoint.write_bytes(b"ckpt")
    (tmp_path / "class_mapping.csv").write_text(
        "class_id,class_name\n0,wlop\n", encoding="utf-8"
    )

    onnx_calls: list[str] = []

    class _FakeOrt:
        def InferenceSession(self, path, providers=None):
            onnx_calls.append(str(path))
            raise AssertionError("ONNX must not load a .pth")

    monkeypatch.setitem(__import__("sys").modules, "onnxruntime", _FakeOrt())

    ident = ai.ArtistIdentifier(model_path=str(checkpoint), model_source="local")
    seen: list[tuple[str, str]] = []

    def fake_init(self, checkpoint_path, class_mapping_path):
        seen.append((checkpoint_path, class_mapping_path))
        self._model = "kaloscope"
        self._backend = "kaloscope"
        self._has_class_mapping = True

    monkeypatch.setattr(ai.ArtistIdentifier, "_initialize_kaloscope", fake_init)
    ident.load()

    assert onnx_calls == []
    assert len(seen) == 1
    assert seen[0][0] == str(checkpoint)
    assert Path(seen[0][1]).name == "class_mapping.csv"
    assert ident._backend == "kaloscope"
