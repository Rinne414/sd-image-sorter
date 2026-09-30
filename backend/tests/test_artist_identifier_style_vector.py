"""ArtistIdentifier.extract_style_vector: the Kaloscope feature seam (S1).

No real model: a tiny torch module stands in for LSNetArtist. The pins here
are that the vector comes from ``forward(x, return_features=True)`` passed
through ``head.bn``, that non-Kaloscope backends refuse instead of returning
something empty, that ``supports_style_vectors`` tells the truth, and that the
model-version string follows the weights (by digest), not the file name.
"""

from __future__ import annotations

import hashlib

import numpy as np
import pytest
from PIL import Image

import artist_identifier as ai


torch = pytest.importorskip("torch")


class TinyLSNet(torch.nn.Module):
    """Mimics the LSNetArtist surface the seam relies on."""

    def __init__(self, feature_dim: int = 6):
        super().__init__()
        self.linear = torch.nn.Linear(3, feature_dim)
        self.head = torch.nn.Module()
        self.head.bn = torch.nn.BatchNorm1d(feature_dim)
        self.head.l = torch.nn.Linear(feature_dim, 4)
        with torch.no_grad():
            self.head.bn.running_mean.fill_(1.0)
            self.head.bn.running_var.fill_(4.0)
            self.head.bn.weight.fill_(2.0)
            self.head.bn.bias.fill_(0.5)
        self.calls = []

    def forward(self, x, return_features=False):
        self.calls.append(return_features)
        features = torch.nn.functional.relu(self.linear(x.mean(dim=(2, 3))))
        if return_features:
            return features
        return self.head.l(self.head.bn(features))


def _kaloscope_identifier() -> ai.ArtistIdentifier:
    identifier = ai.ArtistIdentifier(artists_list=["a", "b", "c", "d"])
    model = TinyLSNet().eval()
    identifier._model = model
    identifier._backend = "kaloscope"
    identifier._transform = lambda image: torch.ones(3, 4, 4)
    identifier.load = lambda: None
    return identifier


def _png(tmp_path) -> str:
    path = tmp_path / "in.png"
    Image.new("RGB", (8, 8), "red").save(path)
    return str(path)


def test_style_vector_is_head_bn_of_features(tmp_path):
    identifier = _kaloscope_identifier()
    vector = identifier.extract_style_vector(_png(tmp_path))

    model = identifier._model
    assert model.calls == [True], "must ask the model for features, not logits"
    with torch.no_grad():
        expected = model.head.bn(model(torch.ones(1, 3, 4, 4), return_features=True))[
            0
        ].numpy()
    assert vector.dtype == np.float32
    assert vector.shape == (6,)
    assert np.allclose(vector, expected, atol=1e-6)
    assert not np.allclose(
        vector, model(torch.ones(1, 3, 4, 4), return_features=True)[0].detach().numpy()
    )


def test_supports_style_vectors_tells_the_truth():
    identifier = _kaloscope_identifier()
    assert identifier.supports_style_vectors() is True

    identifier._backend = "onnx"
    assert identifier.supports_style_vectors() is False

    identifier = _kaloscope_identifier()
    identifier._model = torch.nn.Linear(3, 3)
    assert identifier.supports_style_vectors() is False

    identifier = _kaloscope_identifier()
    identifier._transform = None
    assert identifier.supports_style_vectors() is False

    unloaded = ai.ArtistIdentifier(artists_list=["a"])
    assert unloaded.supports_style_vectors() is False


def test_non_kaloscope_backend_refuses(tmp_path):
    identifier = _kaloscope_identifier()
    identifier._backend = "onnx"
    with pytest.raises(RuntimeError, match="Kaloscope"):
        identifier.extract_style_vector(_png(tmp_path))


def test_model_without_head_bn_refuses(tmp_path):
    identifier = _kaloscope_identifier()
    identifier._model = torch.nn.Linear(3, 3)
    with pytest.raises(RuntimeError, match="Kaloscope"):
        identifier.extract_style_vector(_png(tmp_path))


def test_unloaded_model_refuses_with_load_error(tmp_path):
    identifier = ai.ArtistIdentifier(artists_list=["a"])
    identifier.load = lambda: None
    identifier._load_error = "runtime missing"
    with pytest.raises(RuntimeError, match="runtime missing"):
        identifier.extract_style_vector(_png(tmp_path))


class TestModelVersion:
    def test_default_names_pinned_checkpoint_and_layer(self):
        version = ai.kaloscope_style_vector_model_version(None)
        assert version == f"kaloscope:{ai.ARTIST_KALOSCOPE_CHECKPOINT}:head.bn"
        assert (
            ai.ArtistIdentifier(artists_list=["a"]).style_vector_model_version
            == version
        )

    def test_local_file_is_named_by_its_digest_not_its_name(self, tmp_path):
        official_name = tmp_path / "best_checkpoint.pth"
        official_name.write_bytes(b"not the official weights")
        digest = hashlib.sha256(b"not the official weights").hexdigest()

        version = ai.kaloscope_style_vector_model_version(str(official_name))
        assert version == f"kaloscope-local:{digest[:16]}:head.bn"
        assert version != ai.kaloscope_style_vector_model_version(None)

        other = tmp_path / "other.pth"
        other.write_bytes(b"different weights")
        assert ai.kaloscope_style_vector_model_version(str(other)) != version

        local = ai.ArtistIdentifier(artists_list=["a"], model_path=str(official_name))
        assert local.style_vector_model_version == version

    def test_local_copy_of_official_weights_shares_the_official_version(
        self, tmp_path, monkeypatch
    ):
        copy = tmp_path / "kalo_copy.pth"
        copy.write_bytes(b"official bytes")
        digest = hashlib.sha256(b"official bytes").hexdigest()
        monkeypatch.setattr(
            ai,
            "_EXPECTED_ARTIST_FILE_SHA256",
            {"448-90.13/best_checkpoint.pth": (digest,)},
        )
        assert ai.kaloscope_style_vector_model_version(
            str(copy)
        ) == ai.kaloscope_style_vector_model_version(None)

    def test_digest_is_cached_per_path_size_and_mtime(self, tmp_path, monkeypatch):
        weights = tmp_path / "w.pth"
        weights.write_bytes(b"abc")
        calls = {"n": 0}
        real = ai._sha256_file

        def counting(path):
            calls["n"] += 1
            return real(path)

        monkeypatch.setattr(ai, "_sha256_file", counting)
        first = ai.kaloscope_style_vector_model_version(str(weights))
        second = ai.kaloscope_style_vector_model_version(str(weights))
        assert first == second and calls["n"] == 1

        weights.write_bytes(b"abcd")
        third = ai.kaloscope_style_vector_model_version(str(weights))
        assert third != first and calls["n"] == 2

    def test_missing_local_file_is_an_error_not_a_name(self, tmp_path):
        with pytest.raises(ValueError):
            ai.kaloscope_style_vector_model_version(str(tmp_path / "gone.pth"))

    def test_non_regular_file_is_rejected_before_hashing(self, tmp_path, monkeypatch):
        calls = {"n": 0}

        def counting(path):
            calls["n"] += 1
            return "0" * 64

        monkeypatch.setattr(ai, "_sha256_file", counting)
        with pytest.raises(ValueError):
            ai.kaloscope_style_vector_model_version(str(tmp_path))  # a directory
        assert calls["n"] == 0

    def test_unreadable_local_file_is_an_error_not_a_name(self, tmp_path, monkeypatch):
        weights = tmp_path / "best_checkpoint.pth"
        weights.write_bytes(b"x")

        def broken(_path):
            raise OSError("disk read error")

        monkeypatch.setattr(ai, "_sha256_file", broken)
        with pytest.raises(ValueError):
            ai.kaloscope_style_vector_model_version(str(weights))


def test_public_load_state_properties():
    identifier = ai.ArtistIdentifier(artists_list=["a"])
    assert identifier.model_loaded is False
    assert identifier.load_error is None
    identifier._load_error = "runtime missing"
    assert identifier.load_error == "runtime missing"
    identifier._model = object()
    assert identifier.model_loaded is True
    with pytest.raises(AttributeError):
        identifier.load_error = "read only"
