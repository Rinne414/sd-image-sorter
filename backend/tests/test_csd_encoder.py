"""CSD encoder (S5): the open_clip architecture takes the checkpoint's keys, and
the batch interface the style index drives.

The real weights are 2.4 GB and never loaded here: the architecture is built
on the meta device (shapes only), and the encoder runs a tiny stand-in
backbone. Numeric agreement with the reference implementation (OpenAI ``clip``)
was measured on the owner's machine (S5 report).
"""

from __future__ import annotations

import numpy as np
import pytest
from PIL import Image

import csd_encoder
import csd_weights

torch = pytest.importorskip("torch")
pytest.importorskip("open_clip")


def _expected_backbone_keys() -> dict[str, tuple]:
    """The 295 backbone keys and shapes of the CSD-ViT-L checkpoint (listed from
    the real file: OpenAI CLIP ViT-L/14 visual tower, projection dropped)."""
    keys = {
        "class_embedding": (1024,),
        "positional_embedding": (257, 1024),
        "conv1.weight": (1024, 3, 14, 14),
        "ln_pre.weight": (1024,),
        "ln_pre.bias": (1024,),
        "ln_post.weight": (1024,),
        "ln_post.bias": (1024,),
    }
    for layer in range(24):
        block = f"transformer.resblocks.{layer}."
        keys.update(
            {
                block + "attn.in_proj_weight": (3072, 1024),
                block + "attn.in_proj_bias": (3072,),
                block + "attn.out_proj.weight": (1024, 1024),
                block + "attn.out_proj.bias": (1024,),
                block + "ln_1.weight": (1024,),
                block + "ln_1.bias": (1024,),
                block + "mlp.c_fc.weight": (4096, 1024),
                block + "mlp.c_fc.bias": (4096,),
                block + "mlp.c_proj.weight": (1024, 4096),
                block + "mlp.c_proj.bias": (1024,),
                block + "ln_2.weight": (1024,),
                block + "ln_2.bias": (1024,),
            }
        )
    return keys


class TestArchitecture:
    @pytest.fixture(scope="class")
    def backbone(self):
        return csd_encoder.build_backbone()  # meta device: no memory, no init cost

    def test_state_dict_keys_and_shapes_equal_the_checkpoints(self, backbone):
        actual = {
            key: tuple(value.shape) for key, value in backbone.state_dict().items()
        }
        assert actual == _expected_backbone_keys()
        assert len(actual) == 295

    def test_the_projection_is_dropped_so_the_output_is_the_1024_wide_feature(
        self, backbone
    ):
        assert backbone.proj is None
        assert "proj" not in backbone.state_dict()

    def test_openai_weights_need_the_quickgelu_activation(self, backbone):
        from open_clip.transformer import QuickGELU

        gelu = backbone.transformer.resblocks[0].mlp.gelu
        assert isinstance(gelu, QuickGELU)

    def test_mapped_checkpoint_keys_load_strictly(self):
        """The mapping output is exactly what the architecture takes."""
        backbone = csd_encoder.build_backbone()
        state = {
            f"module.backbone.{key}": torch.zeros(shape, device="meta")
            for key, shape in _expected_backbone_keys().items()
        }
        state["module.last_layer_style"] = torch.zeros(1024, 768, device="meta")
        state["module.last_layer_content"] = torch.zeros(1024, 768, device="meta")
        mapped, style = csd_weights.split_state_dict(state)
        result = backbone.load_state_dict(mapped, strict=True, assign=True)
        assert not result.missing_keys and not result.unexpected_keys
        assert tuple(style.shape) == (1024, 768)


class TestPreprocess:
    def test_resize_short_side_centre_crop_and_clip_normalisation(self):
        encoder = csd_encoder.CsdEncoder()
        white = Image.new("RGB", (300, 200), (255, 255, 255))
        tensor = encoder.prepare_style_input(white)
        assert tuple(tensor.shape) == (3, 224, 224) and tensor.dtype == torch.float32
        expected = [
            (1 - mean) / std
            for mean, std in zip(csd_encoder.CLIP_MEAN, csd_encoder.CLIP_STD)
        ]
        assert [float(tensor[c, 100, 100]) for c in range(3)] == pytest.approx(
            expected, abs=1e-4
        )

    def test_the_centre_is_what_is_kept(self):
        image = Image.new("RGB", (448, 224), (0, 0, 0))
        image.paste((255, 255, 255), (112, 0, 336, 224))  # the centred square
        tensor = csd_encoder.CsdEncoder().prepare_style_input(image)
        # the cropped square is entirely the white middle
        assert float(tensor.min()) > 1.0


class _TinyBackbone(torch.nn.Module):
    """1024 features from the mean of each channel: deterministic and cheap."""

    def forward(self, x):
        channels = x.mean(dim=(2, 3))  # (N, 3)
        return channels.repeat_interleave(342, dim=1)[:, :1024]  # (N, 1024)


@pytest.fixture
def encoder():
    instance = csd_encoder.CsdEncoder()
    rng = np.random.default_rng(3)
    instance._backbone = _TinyBackbone()
    instance._style = torch.tensor(
        rng.normal(size=(1024, csd_encoder.CSD_EMBED_DIM)), dtype=torch.float32
    )
    instance._device = torch.device("cpu")
    instance._dtype = torch.float32
    return instance


class TestEncoding:
    def _batch(self, count=3):
        rng = np.random.default_rng(1)
        return torch.tensor(rng.normal(size=(count, 3, 224, 224)), dtype=torch.float32)

    def test_a_batch_gives_one_unit_vector_each_of_the_style_width(self, encoder):
        vectors = encoder.embed_batch(self._batch(4))
        assert vectors.shape == (4, csd_encoder.CSD_EMBED_DIM)
        assert np.allclose(np.linalg.norm(vectors, axis=1), 1.0, atol=1e-5)

    def test_batch_equals_single_pictures(self, encoder):
        batch = self._batch(3)
        together = encoder.embed_batch(batch)
        alone = np.concatenate(
            [encoder.embed_batch(batch[i : i + 1]) for i in range(3)]
        )
        assert np.allclose(together, alone, atol=1e-5)

    def test_the_index_interface_returns_vector_and_no_artist_answer(self, encoder):
        items = [(f"p{i}.png", tensor) for i, tensor in enumerate(self._batch(3))]
        answers = encoder.extract_style_vectors_and_identifications(
            items, top_k=5, threshold=0.0, priority=100
        )
        assert len(answers) == 3
        for vector, raw in answers:
            assert vector.shape == (csd_encoder.CSD_EMBED_DIM,) and raw is None

    def test_pictures_not_yet_transformed_are_transformed(self, encoder):
        image = Image.new("RGB", (64, 48), (10, 120, 200))
        ((vector, _raw),) = encoder.extract_style_vectors_and_identifications(
            [("a.png", image)], top_k=5, threshold=0.0, priority=100
        )
        assert vector.shape == (csd_encoder.CSD_EMBED_DIM,)

    def test_the_single_picture_path_matches_the_batch_path(self, encoder, tmp_path):
        path = tmp_path / "a.png"
        Image.new("RGB", (40, 40), (200, 30, 90)).save(path)
        single = encoder.extract_style_vector(str(path))
        ((batched, _raw),) = encoder.extract_style_vectors_and_identifications(
            [(str(path), Image.open(path).convert("RGB"))],
            top_k=5,
            threshold=0.0,
            priority=100,
        )
        assert np.allclose(single, batched, atol=1e-5)

    def test_a_not_loaded_encoder_is_not_ready(self):
        instance = csd_encoder.CsdEncoder()
        assert instance.supports_style_vectors() is False
        with pytest.raises(RuntimeError):
            instance.embed_batch(torch.zeros(1, 3, 224, 224))

    def test_a_loaded_encoder_supports_style_vectors(self, encoder):
        assert encoder.supports_style_vectors() is True
        assert encoder.model_loaded is True

    def test_a_non_finite_answer_is_an_error_not_a_vector(self, encoder):
        encoder._backbone = torch.nn.Module()
        encoder._backbone.forward = lambda x: torch.full(
            (x.shape[0], 1024), float("nan")
        )
        with pytest.raises(RuntimeError, match="finite"):
            encoder.embed_batch(self._batch(1))


class TestSingleton:
    def test_the_same_encoder_is_reused_until_the_device_choice_changes(
        self, monkeypatch
    ):
        monkeypatch.setattr(csd_encoder, "_encoder", None)
        first = csd_encoder.get_csd_encoder(use_gpu=False)
        assert csd_encoder.get_csd_encoder(use_gpu=False) is first
        second = csd_encoder.get_csd_encoder(use_gpu=True)
        assert second is not first and second.use_gpu is True
        monkeypatch.setattr(csd_encoder, "_encoder", None)
