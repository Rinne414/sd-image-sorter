"""Preprocess + session-metadata mixin for WD14Tagger (split 2026-07).

Methods moved from tagger.py:
_refresh_session_metadata / _preprocess_paths / _preprocess. Manifested
line (the ONLY non-verbatim edit): _preprocess_paths resolves
_get_preprocess_executor through _svc() at call time -- the executor pair
(_preprocess_executor + its lock) stays DEFINED on the facade and the pin
suite snapshots/restores ``tagger._preprocess_executor`` there; a bare read
here would create a second, unpatched executor family.
"""

from typing import Any, List

import numpy as np
from PIL import Image


def _svc():
    """Resolve the facade-owned preprocess-executor family at call time.

    The pin suite snapshots/restores ``tagger._preprocess_executor`` on the
    facade module object; a from-import here would freeze an independent
    binding. The lazy import avoids a facade<->mixin load cycle.
    """
    import tagger

    return tagger


class _PreprocessMixin:
    """ONNX input-shape inference + image decode/letterbox/normalization."""

    def _refresh_session_metadata(self) -> None:
        """Cache input metadata used for preprocessing and true batched inference."""
        if self.session is None:
            self._input_name = None
            self._input_hw = (448, 448)
            self._supports_true_batch = False
            return

        if not hasattr(self.session, "get_inputs"):
            self._input_name = "input"
            self._input_hw = (448, 448)
            self._supports_true_batch = False
            return

        input_info = self.session.get_inputs()[0]
        self._input_name = input_info.name
        input_shape = list(input_info.shape or [])

        width = 448
        height = 448
        if len(input_shape) == 4:
            # Model input shape is the source of truth for layout. Built-in WD14
            # exports are usually NHWC, while newer/custom ONNX exports can be
            # NCHW. Infer it here so Custom Local Model does not feed
            # [B,H,W,3] into a [B,3,H,W] graph.
            if isinstance(input_shape[-1], int) and input_shape[-1] == 3:
                self._input_layout = "nhwc"
                height = (
                    int(input_shape[1]) if isinstance(input_shape[1], int) else height
                )
                width = (
                    int(input_shape[2]) if isinstance(input_shape[2], int) else width
                )
            elif isinstance(input_shape[1], int) and input_shape[1] == 3:
                self._input_layout = "nchw"
                height = (
                    int(input_shape[2]) if isinstance(input_shape[2], int) else height
                )
                width = (
                    int(input_shape[3]) if isinstance(input_shape[3], int) else width
                )

        batch_dim = input_shape[0] if input_shape else None
        self._input_hw = (width, height)
        self._supports_true_batch = not isinstance(batch_dim, int) or batch_dim > 1

    def _preprocess_paths(self, paths: List[str]) -> List[Any]:
        """Decode + preprocess a chunk of images, returning a list aligned with
        ``paths`` where each entry is the preprocessed array or the Exception
        that failed it (per-image isolation, order preserved). Uses a small
        thread pool so the GPU is not left waiting on single-threaded PIL
        decode/resize; falls back to serial for a single image."""

        def _one(path: str) -> np.ndarray:
            with Image.open(path) as image:
                return self._preprocess(image)

        if len(paths) <= 1:
            serial: List[Any] = []
            for path in paths:
                try:
                    serial.append(_one(path))
                except Exception as error:
                    serial.append(error)
            return serial

        futures = [_svc()._get_preprocess_executor().submit(_one, path) for path in paths]
        prepared: List[Any] = []
        for future in futures:
            try:
                prepared.append(future.result())
            except Exception as error:
                prepared.append(error)
        return prepared

    def _preprocess(self, image: Image.Image) -> np.ndarray:
        """Preprocess image for inference."""
        width, height = self._input_hw

        # P2-13a: composite transparency onto white before dropping alpha —
        # bare convert("RGB") turns transparent pixels black, which reads as
        # a black background to the tagger. Matches SmilingWolf's official
        # wd14 preprocessing (white canvas alpha_composite).
        if image.mode in ("RGBA", "LA", "PA") or (
            image.mode == "P" and "transparency" in image.info
        ):
            rgba = image.convert("RGBA")
            canvas = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
            canvas.alpha_composite(rgba)
            image = canvas.convert("RGB")
        else:
            image = image.convert("RGB")

        if self._resize_mode == "rescale_pad":
            return self._rescale_pad(image)

        if self._resize_mode == "stretch":
            processed_image = image.resize((width, height), Image.Resampling.BILINEAR)
        else:
            old_size = image.size
            ratio = min(
                float(width) / max(1, old_size[0]), float(height) / max(1, old_size[1])
            )
            new_size = (int(old_size[0] * ratio), int(old_size[1] * ratio))
            # P2-13a: BICUBIC matches the official wd14 letterbox resample
            # (LANCZOS produced slightly different tag confidences).
            resized_image = image.resize(new_size, Image.Resampling.BICUBIC)
            processed_image = Image.new("RGB", (width, height), self._pad_color)
            paste_pos = ((width - new_size[0]) // 2, (height - new_size[1]) // 2)
            processed_image.paste(resized_image, paste_pos)

        img_array = np.array(processed_image, dtype=np.float32)

        if self._input_normalization == "imagenet":
            img_array = img_array / 255.0
            mean = np.array([0.485, 0.456, 0.406], dtype=np.float32)
            std = np.array([0.229, 0.224, 0.225], dtype=np.float32)
            img_array = (img_array - mean) / std
            if self._input_layout == "nchw":
                img_array = np.transpose(img_array, (2, 0, 1))
            return img_array.astype(np.float32, copy=False)

        if self._input_normalization == "minus_one_to_one":
            img_array = img_array / 255.0
            img_array = (img_array - 0.5) / 0.5
            if self._input_layout == "nchw":
                img_array = np.transpose(img_array, (2, 0, 1))
            return img_array.astype(np.float32, copy=False)

        img_array = img_array[:, :, ::-1]  # RGB to BGR
        if self._input_layout == "nchw":
            img_array = np.transpose(img_array, (2, 0, 1))
        return img_array

    def _rescale_pad(self, image: Image.Image) -> np.ndarray:
        """PixAI v1.0's official RescalePad on an RGB image.

        The official processor resizes the float [0, 1] tensor (bilinear,
        antialiased) and pads with 0 before normalising. Resizing each channel
        as a 32-bit float image reproduces that tensor (max abs difference
        1.4e-4 on 40 real images); resizing the 8-bit image first is one
        quantisation step off everywhere. Returns [-1, 1] values, padding -1.
        """
        width, height = self._input_hw
        ratio = min(width / max(1, image.size[0]), height / max(1, image.size[1]))
        new_w = int(image.size[0] * ratio)
        new_h = int(image.size[1] * ratio)
        left = (width - new_w) // 2
        top = (height - new_h) // 2
        pixels = np.asarray(image, dtype=np.float32) / 255.0
        canvas = np.zeros((3, height, width), dtype=np.float32)
        for channel in range(3):
            plane = Image.fromarray(np.ascontiguousarray(pixels[:, :, channel]))
            if (new_w, new_h) != image.size:
                plane = plane.resize((new_w, new_h), Image.Resampling.BILINEAR)
            canvas[channel, top : top + new_h, left : left + new_w] = np.asarray(plane)
        canvas = (canvas - 0.5) / 0.5
        if self._input_layout != "nchw":
            canvas = np.transpose(canvas, (1, 2, 0))
        return np.ascontiguousarray(canvas, dtype=np.float32)
