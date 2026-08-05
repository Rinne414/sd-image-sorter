"""Pure aspect-ratio bucket geometry and rendering for Dataset exports."""

from __future__ import annotations

from fractions import Fraction
from typing import Sequence, TypeAlias

from PIL import Image


BucketSize: TypeAlias = tuple[int, int]
CropBox: TypeAlias = tuple[int, int, int, int]

CANONICAL_SDXL_BUCKETS: tuple[BucketSize, ...] = (
    (640, 1536),
    (768, 1344),
    (832, 1216),
    (896, 1152),
    (1024, 1024),
    (1152, 896),
    (1216, 832),
    (1344, 768),
    (1536, 640),
)

_CANONICAL_RESOLUTION = 1024
_BUCKET_STEP = 64


class BucketTransformError(ValueError):
    """Raised when a requested bucket transform cannot preserve its contract."""


def _validate_size(size: BucketSize, *, label: str) -> None:
    width, height = size
    if type(width) is not int or type(height) is not int or width <= 0 or height <= 0:
        raise BucketTransformError(
            f"{label} dimensions must be positive integers; received={size!r}"
        )


def _round_scaled_dimension(dimension: int, trainer_resolution: int) -> int:
    numerator = dimension * trainer_resolution
    denominator = _CANONICAL_RESOLUTION * _BUCKET_STEP
    units = (numerator + denominator // 2) // denominator
    return max(_BUCKET_STEP, units * _BUCKET_STEP)


def generate_sdxl_buckets(trainer_resolution: int) -> tuple[BucketSize, ...]:
    """Scale the canonical SDXL table and keep every side on a 64px grid."""
    if type(trainer_resolution) is not int:
        raise BucketTransformError(
            "trainer_resolution must be an integer; "
            f"received={trainer_resolution!r}"
        )
    if not 256 <= trainer_resolution <= 4096:
        raise BucketTransformError(
            "trainer_resolution must be between 256 and 4096; "
            f"received={trainer_resolution}"
        )
    if trainer_resolution % _BUCKET_STEP != 0:
        raise BucketTransformError(
            "trainer_resolution must be a multiple of 64 for bucket preprocessing; "
            f"received={trainer_resolution}"
        )

    scaled = (
        (
            _round_scaled_dimension(width, trainer_resolution),
            _round_scaled_dimension(height, trainer_resolution),
        )
        for width, height in CANONICAL_SDXL_BUCKETS
    )
    return tuple(dict.fromkeys(scaled))


def _aspect_distance(source_size: BucketSize, bucket: BucketSize) -> Fraction:
    source_width, source_height = source_size
    bucket_width, bucket_height = bucket
    return abs(
        Fraction(source_width, source_height)
        - Fraction(bucket_width, bucket_height)
    )


def select_center_bucket(
    source_size: BucketSize,
    buckets: Sequence[BucketSize],
) -> BucketSize:
    """Select the nearest source aspect, preserving input order for exact ties."""
    _validate_size(source_size, label="Source image")
    if not buckets:
        raise BucketTransformError("At least one bucket size is required")
    for bucket in buckets:
        _validate_size(bucket, label="Bucket")
    return min(buckets, key=lambda bucket: _aspect_distance(source_size, bucket))


def _crop_size_for_bucket(
    source_size: BucketSize,
    bucket: BucketSize,
) -> BucketSize:
    source_width, source_height = source_size
    bucket_width, bucket_height = bucket
    if source_width * bucket_height > source_height * bucket_width:
        return max(1, source_height * bucket_width // bucket_height), source_height
    return source_width, max(1, source_width * bucket_height // bucket_width)


def _center_crop_box(
    source_size: BucketSize,
    bucket: BucketSize,
) -> CropBox:
    crop_width, crop_height = _crop_size_for_bucket(source_size, bucket)
    source_width, source_height = source_size
    left = (source_width - crop_width) // 2
    top = (source_height - crop_height) // 2
    return left, top, left + crop_width, top + crop_height


def _subject_crop_box(
    source_size: BucketSize,
    bucket: BucketSize,
    subject_box: CropBox,
) -> CropBox:
    crop_width, crop_height = _crop_size_for_bucket(source_size, bucket)
    source_width, source_height = source_size
    subject_left, subject_top, subject_right, subject_bottom = subject_box
    if subject_right - subject_left > crop_width or subject_bottom - subject_top > crop_height:
        raise BucketTransformError(
            f"Bucket {bucket[0]}x{bucket[1]} cannot contain subject box {subject_box!r}"
        )

    centered_left = (source_width - crop_width) // 2
    minimum_left = max(0, subject_right - crop_width)
    maximum_left = min(subject_left, source_width - crop_width)
    left = min(max(centered_left, minimum_left), maximum_left)

    centered_top = (source_height - crop_height) // 2
    minimum_top = max(0, subject_bottom - crop_height)
    maximum_top = min(subject_top, source_height - crop_height)
    top = min(max(centered_top, minimum_top), maximum_top)
    return left, top, left + crop_width, top + crop_height


def _resize_pair(
    image: Image.Image,
    mask: Image.Image | None,
    *,
    bucket: BucketSize,
    crop_box: CropBox,
) -> tuple[Image.Image, Image.Image | None]:
    if mask is not None and image.size != mask.size:
        raise BucketTransformError(
            "Stored training mask size must match the source image size: "
            f"mask size={mask.width}x{mask.height}, "
            f"source image size={image.width}x{image.height}"
        )
    resized_image = image.crop(crop_box).resize(bucket, Image.Resampling.LANCZOS)
    resized_mask = (
        mask.convert("L").crop(crop_box).resize(bucket, Image.Resampling.LANCZOS)
        if mask is not None
        else None
    )
    return resized_image, resized_mask


def plan_center_bucket_resize(
    source_size: BucketSize,
    *,
    trainer_resolution: int,
) -> tuple[BucketSize, CropBox]:
    """Plan the nearest center-crop bucket without reading or writing pixels."""
    _validate_size(source_size, label="Source image")
    buckets = generate_sdxl_buckets(trainer_resolution)
    bucket = select_center_bucket(source_size, buckets)
    return bucket, _center_crop_box(source_size, bucket)


def plan_subject_aware_bucket_resize(
    source_size: BucketSize,
    mask: Image.Image,
    *,
    alpha_threshold: int,
    trainer_resolution: int,
) -> tuple[BucketSize, CropBox]:
    """Plan a legal bucket crop containing every thresholded subject pixel."""
    _validate_size(source_size, label="Source image")
    if source_size != mask.size:
        raise BucketTransformError(
            "Stored training mask size must match the source image size: "
            f"mask size={mask.width}x{mask.height}, "
            f"source image size={source_size[0]}x{source_size[1]}"
        )
    if not 1 <= alpha_threshold <= 255:
        raise BucketTransformError(
            "alpha_threshold must be between 1 and 255; "
            f"received={alpha_threshold}"
        )
    thresholded = mask.convert("L").point(
        lambda value: 255 if value >= alpha_threshold else 0,
        mode="L",
    )
    subject_box = thresholded.getbbox()
    if subject_box is None:
        raise BucketTransformError(
            "Stored training mask has no subject pixels at the requested alpha threshold: "
            f"alpha_threshold={alpha_threshold}"
        )

    buckets = generate_sdxl_buckets(trainer_resolution)
    feasible = tuple(
        bucket
        for bucket in buckets
        if (
            subject_box[2] - subject_box[0] <= _crop_size_for_bucket(source_size, bucket)[0]
            and subject_box[3] - subject_box[1] <= _crop_size_for_bucket(source_size, bucket)[1]
        )
    )
    if not feasible:
        raise BucketTransformError(
            "No legal SDXL bucket can crop this image without clipping the subject: "
            f"image={source_size[0]}x{source_size[1]}, subject_box={subject_box!r}, "
            f"trainer_resolution={trainer_resolution}"
        )
    bucket = select_center_bucket(source_size, feasible)
    return bucket, _subject_crop_box(source_size, bucket, subject_box)


def apply_center_bucket_resize(
    image: Image.Image,
    mask: Image.Image | None,
    *,
    trainer_resolution: int,
) -> tuple[Image.Image, Image.Image | None, BucketSize, CropBox]:
    """Center-crop and resize an image/mask pair without mutating either input."""
    bucket, crop_box = plan_center_bucket_resize(
        image.size,
        trainer_resolution=trainer_resolution,
    )
    resized_image, resized_mask = _resize_pair(
        image,
        mask,
        bucket=bucket,
        crop_box=crop_box,
    )
    return resized_image, resized_mask, bucket, crop_box


def apply_subject_aware_bucket_resize(
    image: Image.Image,
    mask: Image.Image,
    *,
    alpha_threshold: int,
    trainer_resolution: int,
) -> tuple[Image.Image, Image.Image, BucketSize, CropBox]:
    """Choose and position a bucket crop that preserves thresholded subject pixels."""
    bucket, crop_box = plan_subject_aware_bucket_resize(
        image.size,
        mask,
        alpha_threshold=alpha_threshold,
        trainer_resolution=trainer_resolution,
    )
    resized_image, resized_mask = _resize_pair(
        image,
        mask,
        bucket=bucket,
        crop_box=crop_box,
    )
    if resized_mask is None:
        raise BucketTransformError("Subject-aware bucket resize lost its training mask")
    return resized_image, resized_mask, bucket, crop_box
