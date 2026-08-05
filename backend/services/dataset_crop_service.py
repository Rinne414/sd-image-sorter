"""Pure subject-aware crop geometry and rendering for Dataset exports."""

from __future__ import annotations

from math import ceil
from typing import Literal, TypeAlias

from PIL import Image, ImageColor


CropBox: TypeAlias = tuple[int, int, int, int]
BackgroundMode: TypeAlias = Literal[
    "keep_background",
    "transparent_rgba",
    "solid_color",
]

class SubjectCropError(ValueError):
    """Raised when a requested Dataset crop cannot preserve its contract."""


def _multiply_alpha(first: Image.Image, second: Image.Image) -> Image.Image:
    combined = Image.new("L", first.size)
    combined.putdata([
        (first_alpha * second_alpha + 127) // 255
        for first_alpha, second_alpha in zip(
            first.get_flattened_data(),
            second.get_flattened_data(),
            strict=True,
        )
    ])
    return combined


def compute_subject_crop_box(
    mask: Image.Image,
    *,
    alpha_threshold: int,
    padding_percent: float,
) -> CropBox:
    """Return a clamped subject box without modifying the supplied mask."""
    if mask.width <= 0 or mask.height <= 0:
        raise SubjectCropError("Training mask dimensions must be positive")
    if not 1 <= alpha_threshold <= 255:
        raise SubjectCropError(
            f"alpha_threshold must be between 1 and 255; received={alpha_threshold}"
        )
    if not 0.0 <= padding_percent <= 100.0:
        raise SubjectCropError(
            "padding_percent must be between 0 and 100; "
            f"received={padding_percent}"
        )

    grayscale = mask.convert("L")
    thresholded = grayscale.point(
        lambda value: 255 if value >= alpha_threshold else 0,
        mode="L",
    )
    subject_box = thresholded.getbbox()
    if subject_box is None:
        raise SubjectCropError(
            "Training mask has no subject pixels at the requested alpha threshold: "
            f"alpha_threshold={alpha_threshold}"
        )

    left, top, right, bottom = subject_box
    horizontal_padding = ceil((right - left) * padding_percent / 100.0)
    vertical_padding = ceil((bottom - top) * padding_percent / 100.0)
    return (
        max(0, left - horizontal_padding),
        max(0, top - vertical_padding),
        min(mask.width, right + horizontal_padding),
        min(mask.height, bottom + vertical_padding),
    )


def _render_subject_crop(
    image: Image.Image,
    mask: Image.Image,
    *,
    crop_box: CropBox,
    background_mode: BackgroundMode,
    solid_color: str,
) -> tuple[Image.Image, Image.Image]:
    """Apply one crop box to an image and its unchanged soft-alpha mask."""
    if image.size != mask.size:
        raise SubjectCropError(
            "Stored training mask size must match the source image size: "
            f"mask size={mask.width}x{mask.height}, "
            f"source image size={image.width}x{image.height}"
        )
    left, top, right, bottom = crop_box
    if not (0 <= left < right <= image.width and 0 <= top < bottom <= image.height):
        raise SubjectCropError(
            "Subject crop box must be non-empty and inside the source image: "
            f"box={crop_box}, image={image.width}x{image.height}"
        )

    cropped_mask = mask.convert("L").crop(crop_box)
    cropped_source = image.crop(crop_box)
    if background_mode == "keep_background":
        return cropped_source.copy(), cropped_mask
    if background_mode == "transparent_rgba":
        rgba = cropped_source.convert("RGBA")
        rgba.putalpha(_multiply_alpha(rgba.getchannel("A"), cropped_mask))
        return rgba, cropped_mask
    if background_mode == "solid_color":
        try:
            red, green, blue = ImageColor.getrgb(solid_color)
        except ValueError as exc:
            raise SubjectCropError(
                f"solid_color must be a valid RGB color; received={solid_color!r}"
            ) from exc
        foreground_rgba = cropped_source.convert("RGBA")
        subject_alpha = _multiply_alpha(
            foreground_rgba.getchannel("A"),
            cropped_mask,
        )
        foreground = foreground_rgba.convert("RGB")
        background = Image.new("RGB", foreground.size, color=(red, green, blue))
        return Image.composite(foreground, background, subject_alpha), cropped_mask
    raise SubjectCropError(
        "background_mode must be keep_background, transparent_rgba, or solid_color; "
        f"received={background_mode!r}"
    )


def apply_subject_crop(
    image: Image.Image,
    mask: Image.Image,
    *,
    alpha_threshold: int,
    padding_percent: float,
    background_mode: BackgroundMode,
    solid_color: str,
) -> tuple[Image.Image, Image.Image, CropBox]:
    """Compute and apply one subject crop without mutating either input image."""
    if image.size != mask.size:
        raise SubjectCropError(
            "Stored training mask size must match the source image size: "
            f"mask size={mask.width}x{mask.height}, "
            f"source image size={image.width}x{image.height}"
        )
    crop_box = compute_subject_crop_box(
        mask,
        alpha_threshold=alpha_threshold,
        padding_percent=padding_percent,
    )
    cropped_image, cropped_mask = _render_subject_crop(
        image,
        mask,
        crop_box=crop_box,
        background_mode=background_mode,
        solid_color=solid_color,
    )
    return cropped_image, cropped_mask, crop_box
