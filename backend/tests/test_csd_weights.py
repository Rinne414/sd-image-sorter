"""CSD weights (S5): the pinned download, the checkpoint loader and its key mapping.

No real 2.4 GB checkpoint is read here: tiny checkpoints written with
``torch.save`` stand in for it, and the download goes through a fake that
writes bytes. The key set and the numbers of the real file are covered by
``test_csd_encoder`` (architecture) and the owner-machine parity run.
"""

from __future__ import annotations

import argparse
import dataclasses
import hashlib

import numpy as np
import pytest

import csd_weights
import pinned_download

torch = pytest.importorskip("torch")


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class TestPin:
    def test_the_pin_names_one_commit_one_file_and_its_checksum(self):
        pin = csd_weights.CSD_FILE
        assert pin.repo == "tomg-group-umd/CSD-ViT-L"
        assert pin.remote_path == "pytorch_model.bin"
        assert len(pin.revision) == 40 and set(pin.revision) <= set("0123456789abcdef")
        assert len(pin.sha256) == 64 and set(pin.sha256) <= set("0123456789abcdef")
        assert pin.size_bytes == 2_438_228_893

    def test_the_vector_version_follows_the_pinned_file(self):
        assert csd_weights.CSD_MODEL_VERSION.startswith("csd:")
        assert csd_weights.CSD_FILE.sha256[:12] in csd_weights.CSD_MODEL_VERSION

    def test_license_and_source_are_stated(self):
        assert csd_weights.CSD_LICENSE == "CC-BY-4.0"
        assert csd_weights.CSD_LINK == "https://huggingface.co/tomg-group-umd/CSD-ViT-L"


class TestKeyMapping:
    @staticmethod
    def _state(prefix="module."):
        return {
            f"{prefix}last_layer_style": torch.ones(4, 3),
            f"{prefix}last_layer_content": torch.zeros(4, 3),
            f"{prefix}backbone.conv1.weight": torch.ones(2),
            f"{prefix}backbone.transformer.resblocks.0.ln_1.weight": torch.ones(2),
        }

    @pytest.mark.parametrize("prefix", ["module.", ""])
    def test_backbone_keys_lose_the_wrapper_prefixes(self, prefix):
        backbone, style = csd_weights.split_state_dict(self._state(prefix))
        assert set(backbone) == {
            "conv1.weight",
            "transformer.resblocks.0.ln_1.weight",
        }
        assert tuple(style.shape) == (4, 3)

    def test_the_content_head_is_dropped(self):
        backbone, style = csd_weights.split_state_dict(self._state())
        assert not any("content" in key for key in backbone)
        assert float(style.sum()) == 12.0  # the style head, not the content one

    def test_a_missing_style_head_is_refused(self):
        state = self._state()
        del state["module.last_layer_style"]
        with pytest.raises(csd_weights.CsdWeightsError, match="style"):
            csd_weights.split_state_dict(state)

    def test_an_unknown_key_is_refused_rather_than_ignored(self):
        state = self._state()
        state["module.something_else"] = torch.ones(1)
        with pytest.raises(csd_weights.CsdWeightsError, match="something_else"):
            csd_weights.split_state_dict(state)

    def test_no_backbone_is_refused(self):
        with pytest.raises(csd_weights.CsdWeightsError, match="backbone"):
            csd_weights.split_state_dict({"module.last_layer_style": torch.ones(2, 2)})


class _Evil:
    """A pickle that would run code when loaded."""

    ran = False

    def __reduce__(self):
        return (_Evil._run, ())

    @staticmethod
    def _run():
        _Evil.ran = True
        return 1


class TestSafeLoad:
    def test_a_training_checkpoint_loads_with_its_numpy_scalars_and_args(
        self, tmp_path
    ):
        path = tmp_path / "ckpt.bin"
        torch.save(
            {
                "model_state_dict": self._tiny_state(),
                "args": argparse.Namespace(lr=np.float64(0.001), seed=42),
                "iter": 15000,
                "fp16_scaler": {"scale": 32768.0},
            },
            path,
        )
        state = csd_weights.load_state_dict_file(path)
        assert "module.last_layer_style" in state

    @staticmethod
    def _tiny_state():
        return {"module.last_layer_style": torch.ones(2, 2)}

    def test_a_pickle_that_runs_code_is_refused_and_never_runs(self, tmp_path):
        path = tmp_path / "evil.bin"
        _Evil.ran = False
        torch.save({"model_state_dict": self._tiny_state(), "args": _Evil()}, path)
        _Evil.ran = False
        with pytest.raises(csd_weights.CsdWeightsError):
            csd_weights.load_state_dict_file(path)
        assert _Evil.ran is False

    def test_a_file_without_a_state_dict_is_refused(self, tmp_path):
        path = tmp_path / "other.bin"
        torch.save({"weights": 1}, path)
        with pytest.raises(csd_weights.CsdWeightsError, match="model_state_dict"):
            csd_weights.load_state_dict_file(path)

    def test_a_file_that_is_not_a_checkpoint_is_refused(self, tmp_path):
        path = tmp_path / "junk.bin"
        path.write_bytes(b"this is not a torch file")
        with pytest.raises(csd_weights.CsdWeightsError):
            csd_weights.load_state_dict_file(path)


class TestFiles:
    @pytest.fixture
    def own(self, tmp_path, monkeypatch):
        monkeypatch.setattr(csd_weights, "models_dir", lambda: tmp_path / "csd")
        monkeypatch.setattr(
            csd_weights.model_external, "prefer_own", lambda own, _id: own
        )
        return tmp_path / "csd"

    def test_prepare_installs_a_verified_copy_and_names_it(self, own, monkeypatch):
        payload = b"csd bytes"
        pin = dataclasses.replace(
            csd_weights.CSD_FILE, sha256=_sha(payload), size_bytes=len(payload)
        )
        monkeypatch.setattr(csd_weights, "CSD_FILE", pin)
        calls = []

        def download(url, target, timeout=0):
            calls.append(url)
            target.write_bytes(payload)
            return target

        paths = csd_weights.prepare(download)

        assert (own / csd_weights.CSD_FILENAME).read_bytes() == payload
        assert paths == {"csd_weights_path": str(own / csd_weights.CSD_FILENAME)}
        assert f"/{pin.repo}/resolve/{pin.revision}/{pin.remote_path}" in calls[0]
        # a verified copy is never downloaded again
        csd_weights.prepare(lambda *a, **k: pytest.fail("downloaded twice"))

    def test_a_wrong_checksum_is_never_installed(self, own, monkeypatch):
        pin = dataclasses.replace(
            csd_weights.CSD_FILE, sha256=_sha(b"expected"), size_bytes=8
        )
        monkeypatch.setattr(csd_weights, "CSD_FILE", pin)

        def download(url, target, timeout=0):
            target.write_bytes(b"tampered")
            return target

        with pytest.raises(RuntimeError, match="checksum"):
            csd_weights.prepare(download)
        assert not (own / csd_weights.CSD_FILENAME).exists()
        assert not list(own.glob("*.download"))

    def test_a_trusted_copy_is_used_and_not_downloaded_over(
        self, own, monkeypatch, tmp_path
    ):
        trusted = tmp_path / "elsewhere" / "pytorch_model.bin"
        trusted.parent.mkdir()
        trusted.write_bytes(b"trusted")
        monkeypatch.setattr(
            csd_weights.model_external, "prefer_own", lambda _own, _id: trusted
        )
        assert csd_weights.weights_in_use() == trusted
        assert csd_weights.is_installed() is True
        assert csd_weights.prepare(lambda *a, **k: pytest.fail("downloaded")) == {
            "csd_weights_path": str(trusted)
        }

    def test_health_tells_missing_needs_runtime_and_ready(self, own, monkeypatch):
        monkeypatch.setattr(csd_weights, "runtime_available", lambda: True)
        missing = csd_weights.health()
        assert missing["available"] is False
        assert missing["message_key"] == "models.csd.missing"
        assert missing["expected_path"] == str(own / csd_weights.CSD_FILENAME)

        own.mkdir()
        (own / csd_weights.CSD_FILENAME).write_bytes(b"x")
        ready = csd_weights.health()
        assert ready["available"] is True
        assert ready["message_key"] == "models.csd.ready"
        assert ready["model_path"] == str(own / csd_weights.CSD_FILENAME)

        monkeypatch.setattr(csd_weights, "runtime_available", lambda: False)
        needs = csd_weights.health()
        assert needs["available"] is False
        assert needs["message_key"] == "models.csd.needsRuntime"

    def test_pinned_download_is_the_module_used(self):
        assert csd_weights.pinned_download is pinned_download
