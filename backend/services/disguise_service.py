"""Make chat-disguise images: choose a cover, prepare the pictures, write the APNG.

Cover kinds:

- ``upload``  a picture supplied with the request
- ``default`` the saved default cover (``<data>/disguise/default_cover.png``)
- ``text``    a plain card carrying the user's text
- ``blur``    the first real picture, blurred beyond recognition
- ``mosaic``  the first real picture with detected private parts mosaicked.
  When nothing is detected, or no detector is installed, the cover is
  unavailable and the caller asks the user to pick one; the real picture is
  never used as its own cover.

Every disguise written here is remembered by its SHA-256 (no marker goes into
the file), so a later library scan does not "restore" our own output back
into a duplicate of the original picture.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterable, Optional, Sequence

from fastapi import HTTPException
from PIL import Image, ImageColor, ImageDraw, ImageFilter, ImageFont

import database as db
import disguise_apng
from censor_transforms import auto_block_size, censor_under_mask
from disguise_registry import disguise_dir, remember_made
from utils.source_paths import resolve_existing_indexed_image_path

logger = logging.getLogger(__name__)

COVER_KINDS = ("upload", "default", "text", "blur", "mosaic")
DEFAULT_FRAME_MS = 1000
DEFAULT_MAX_SIDE = 1600
BLUR_WORKING_SIDE = 96
BLUR_RADIUS = 6
TEXT_CARD_BACKGROUND = "#26272b"
TEXT_CARD_FOREGROUND = "#f2f2f2"

# Fonts that can draw Chinese, Japanese and Latin text, checked in order.
_CJK_FONT_CANDIDATES = (
    r"C:\Windows\Fonts\msyh.ttc",
    r"C:\Windows\Fonts\msyhbd.ttc",
    r"C:\Windows\Fonts\simhei.ttf",
    r"C:\Windows\Fonts\YuGothM.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/google-noto-cjk/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
    "/System/Library/Fonts/PingFang.ttc",
)


class CoverUnavailable(Exception):
    """No cover could be made for this item; the user has to choose one."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


@dataclass(frozen=True)
class CoverSpec:
    kind: str
    upload: Optional[Image.Image] = None
    text: str = ""
    background: str = TEXT_CARD_BACKGROUND
    foreground: str = TEXT_CARD_FOREGROUND


@dataclass(frozen=True)
class MakeOptions:
    frame_ms: int = DEFAULT_FRAME_MS
    max_side: int = DEFAULT_MAX_SIDE  # 0 keeps the original size
    scrub: bool = True
    canvas_background: str = "#ffffff"


@dataclass(frozen=True)
class MadeDisguise:
    data: bytes
    cover: Image.Image
    width: int
    height: int
    real_frames: int


# ------------------------------------------------------------------ covers


# Same cell rule as the Censor page's Auto mosaic.
mosaic_block_size = auto_block_size


def regions_mask(size: tuple[int, int], detections: Iterable[dict]) -> Image.Image:
    """A mask of every detected region: its polygon when it has one, else its box."""
    mask = Image.new("L", size, 0)
    draw = ImageDraw.Draw(mask)
    for detection in detections:
        polygon = [
            (float(point[0]), float(point[1]))
            for point in detection.get("polygon") or []
            if isinstance(point, (list, tuple)) and len(point) >= 2
        ]
        if len(polygon) >= 3:
            draw.polygon(polygon, fill=255)
            continue
        box = detection.get("box")
        if isinstance(box, (list, tuple)) and len(box) == 4:
            x1, y1, x2, y2 = (float(value) for value in box)
            if x2 > x1 and y2 > y1:
                draw.rectangle((x1, y1, x2, y2), fill=255)
    return mask


def mosaic_cover(picture: Image.Image, mask: Image.Image) -> Image.Image:
    if mask.getbbox() is None:
        raise CoverUnavailable("nothing_detected")
    return censor_under_mask(picture, mask, "mosaic")


def blurred_cover(picture: Image.Image) -> Image.Image:
    """Shrink hard, blur, and scale back: only colour blobs remain."""
    small = picture.convert("RGBA")
    small.thumbnail((BLUR_WORKING_SIDE, BLUR_WORKING_SIDE), Image.Resampling.BILINEAR)
    blurred = small.filter(ImageFilter.GaussianBlur(BLUR_RADIUS))
    return blurred.resize(picture.size, Image.Resampling.BICUBIC)


def text_card(
    size: tuple[int, int], text: str, background: str, foreground: str
) -> Image.Image:
    card = Image.new("RGBA", size, _color(background, TEXT_CARD_BACKGROUND))
    lines = [line.strip() for line in str(text or "").splitlines() if line.strip()]
    if not lines:
        return card
    font = _cjk_font(max(14, min(size) // 12))
    draw = ImageDraw.Draw(card)
    spacing = font.size // 3 if hasattr(font, "size") else 4
    box = draw.multiline_textbbox(
        (0, 0), "\n".join(lines), font=font, spacing=spacing, align="center"
    )
    width, height = box[2] - box[0], box[3] - box[1]
    origin = ((size[0] - width) / 2 - box[0], (size[1] - height) / 2 - box[1])
    draw.multiline_text(
        origin,
        "\n".join(lines),
        font=font,
        fill=_color(foreground, TEXT_CARD_FOREGROUND),
        spacing=spacing,
        align="center",
    )
    return card


def _cjk_font(size: int) -> ImageFont.ImageFont:
    for candidate in _CJK_FONT_CANDIDATES:
        if os.path.isfile(candidate):
            try:
                return ImageFont.truetype(candidate, size)
            except OSError:
                continue
    logger.warning("No CJK font found; the text cover can show Latin text only")
    return ImageFont.load_default(size)


def _color(value: str, fallback: str) -> tuple[int, int, int, int]:
    try:
        rgb = ImageColor.getrgb(str(value or fallback))
    except ValueError:
        rgb = ImageColor.getrgb(fallback)
    return (*rgb[:3], 255)


def resolve_cover(
    spec: CoverSpec,
    first_picture: Image.Image,
    detect_regions: Optional[Callable[[], Sequence[dict]]] = None,
) -> Image.Image:
    kind = spec.kind
    if kind == "upload":
        if spec.upload is None:
            raise CoverUnavailable("no_upload")
        return spec.upload.convert("RGBA")
    if kind == "default":
        cover = load_default_cover()
        if cover is None:
            raise CoverUnavailable("no_default_cover")
        return cover
    if kind == "text":
        return text_card(
            first_picture.size, spec.text, spec.background, spec.foreground
        )
    if kind == "blur":
        return blurred_cover(first_picture)
    if kind == "mosaic":
        if detect_regions is None:
            raise CoverUnavailable("not_in_library")
        return mosaic_cover(
            first_picture, regions_mask(first_picture.size, detect_regions())
        )
    raise ValueError(
        f"Unknown cover kind {kind!r}; use one of {', '.join(COVER_KINDS)}"
    )


# ------------------------------------------------------------ default cover


def default_cover_path() -> Path:
    return disguise_dir() / "default_cover.png"


def load_default_cover() -> Optional[Image.Image]:
    path = default_cover_path()
    if not path.is_file():
        return None
    with Image.open(path) as image:
        return image.convert("RGBA")


def save_default_cover(image: Image.Image) -> Path:
    path = default_cover_path()
    temp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    disguise_apng.scrub_hidden_data(image).save(temp, format="PNG")
    os.replace(temp, path)
    return path


def clear_default_cover() -> bool:
    path = default_cover_path()
    if not path.is_file():
        return False
    path.unlink()
    return True


# ------------------------------------------------------------------ making


def limit_side(image: Image.Image, max_side: int) -> Image.Image:
    if max_side <= 0 or max(image.size) <= max_side:
        return image
    scale = max_side / max(image.size)
    size = (max(1, round(image.width * scale)), max(1, round(image.height * scale)))
    return image.resize(size, Image.Resampling.LANCZOS)


def make_disguise(
    pictures: Sequence[Image.Image],
    cover: CoverSpec,
    options: MakeOptions = MakeOptions(),
    detect_regions: Optional[Callable[[], Sequence[dict]]] = None,
) -> MadeDisguise:
    """Build one disguise from ``pictures`` (several pictures = one animation).

    ``detect_regions`` returns the censor detections of the first picture, in
    its original pixel frame; it is only called for the ``mosaic`` cover.
    Raises CoverUnavailable when the requested cover cannot be made.
    """
    if not pictures:
        raise ValueError("A disguise needs at least one picture")
    first_original = pictures[0].convert("RGBA")
    still = resolve_cover(cover, first_original, detect_regions)
    prepared = [
        limit_side(picture.convert("RGBA"), options.max_side) for picture in pictures
    ]
    if options.scrub:
        prepared = [disguise_apng.scrub_hidden_data(picture) for picture in prepared]
        still = disguise_apng.scrub_hidden_data(still)
    background = _color(options.canvas_background, "#ffffff")
    data = disguise_apng.build_disguise(still, prepared, options.frame_ms, background)
    canvas = (max(p.width for p in prepared), max(p.height for p in prepared))
    remember_made(data)
    return MadeDisguise(
        data=data,
        cover=disguise_apng.fit_onto_canvas(still, canvas, background),
        width=canvas[0],
        height=canvas[1],
        real_frames=len(prepared),
    )


# --------------------------------------------------------- library sources


class LibraryPictureMissing(LookupError):
    """The library image, or its file, cannot be found."""


def load_library_picture(image_id: int) -> tuple[Image.Image, str]:
    """The library image's pixels as stored (no EXIF rotation) and its file stem.

    The raw pixel frame matches the frame the censor detectors report boxes
    in, so a mosaic cover lines up with what was detected.
    """
    row = db.get_image_by_id(image_id)
    if not row:
        raise LibraryPictureMissing(f"Image {image_id} is not in the library.")
    path = resolve_existing_indexed_image_path(row["path"], backend_file=__file__)
    if not path:
        raise LibraryPictureMissing(f"The file of image {image_id} is missing.")
    with Image.open(path) as image:
        image.load()
        return image.convert("RGBA"), Path(path).stem


def censor_detector(
    censor_service,
    image_id: int,
    model_type: str,
    model_path: str,
    confidence: float,
    targets: Sequence[str],
) -> Callable[[], Sequence[dict]]:
    """Detections of a library image from the detectors the Censor page uses.

    A detector that is not installed or cannot run makes the cover
    unavailable (the user picks one) rather than failing the whole request.
    """
    from services.censor_service import CensorDetectRequest

    def detect() -> Sequence[dict]:
        request = CensorDetectRequest(
            image_id=image_id,
            model_type=model_type,
            model_path=model_path,
            confidence_threshold=confidence,
            target_classes=[str(target) for target in targets] or None,
        )
        try:
            return censor_service.detect(request).get("detections") or []
        except HTTPException as exc:
            level = logging.WARNING if exc.status_code >= 500 else logging.INFO
            logger.log(
                level,
                "Mosaic cover detection unavailable for image %s: %s",
                image_id,
                exc.detail,
            )
            raise CoverUnavailable("detector_unavailable") from exc

    return detect
