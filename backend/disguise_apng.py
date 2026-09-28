"""Chat-disguise APNG: one PNG file that shows a cover as a still picture and
the real picture(s) as its animation.

Layout of a disguise file:

    PNG signature, IHDR, acTL
    IDAT ...            <- the cover (the "default image")
    fcTL, fdAT ...      <- real picture 1
    fcTL, fdAT ...      <- real picture 2, ... (or a 1x1 keep-alive frame)
    IEND

Because the first fcTL comes after IDAT, the cover is not part of the
animation. Decoders without APNG support - chat-list thumbnails in
particular - read only IDAT and show the cover. APNG-aware viewers play the
fcTL/fdAT frames and show the real picture.

The same test identifies a disguise made by any tool: an acTL chunk plus a
first fcTL that follows the IDAT data. No marker chunk is written or needed,
so a disguise carries nothing that ties it to this program or its user.
"""

from __future__ import annotations

import io
import logging
import os
import struct
import zlib
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO, Iterator, Optional, Sequence, Union

from PIL import Image

logger = logging.getLogger(__name__)

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
DEFAULT_FRAME_MS = 100
MAX_FRAME_MS = 65535
DATA_CHUNK_BYTES = 65536
RESTORED_SUFFIX = "_real"
WHITE = (255, 255, 255, 255)
# A frame drawn over at most this many pixels is a keep-alive frame, not a picture.
KEEPALIVE_MAX_PIXELS = 4
# PNG caps a chunk length at 2**31 - 1; anything larger means a corrupt file.
_MAX_CHUNK_LENGTH = 2**31 - 1

_DISPOSE_NONE = 0
_BLEND_SOURCE = 0
_BLEND_OVER = 1

Source = Union[str, os.PathLike, bytes]
Rgba = tuple[int, int, int, int]


class DisguiseReadError(ValueError):
    """The file looks like a disguise but its real picture cannot be decoded."""


@dataclass(frozen=True)
class DisguiseInfo:
    width: int
    height: int
    animation_frames: int
    real_frames: int


@dataclass(frozen=True)
class RealFrame:
    image: Image.Image
    duration_ms: int


@dataclass(frozen=True)
class _FrameControl:
    width: int
    height: int
    duration_ms: int


# ---------------------------------------------------------------- building


def scrub_hidden_data(image: Image.Image) -> Image.Image:
    """Return an RGBA copy with no metadata and no data hidden in pixel bits.

    NovelAI and WebUI "stealth" metadata stores the prompt in the lowest bit
    of the alpha or RGB channels, so dropping PNG text chunks is not enough.
    Clearing the RGB low bit and setting the alpha low bit on visible pixels
    destroys any such carrier while moving no channel by more than 1.
    Fully transparent pixels stay fully transparent.
    """
    red, green, blue, alpha = image.convert("RGBA").split()
    clear_low_bit = [value & 0xFE for value in range(256)]
    set_low_bit = [0] + [value | 1 for value in range(1, 256)]
    clean = Image.merge(
        "RGBA",
        (
            red.point(clear_low_bit),
            green.point(clear_low_bit),
            blue.point(clear_low_bit),
            alpha.point(set_low_bit),
        ),
    )
    clean.info = {}
    return clean


def fit_onto_canvas(
    image: Image.Image, size: tuple[int, int], background: Rgba = WHITE
) -> Image.Image:
    """Scale ``image`` to fit inside ``size`` (aspect kept) and center it on ``background``."""
    rgba = image.convert("RGBA")
    if rgba.size == size:
        return rgba
    scale = min(size[0] / rgba.width, size[1] / rgba.height)
    scaled_size = (
        max(1, round(rgba.width * scale)),
        max(1, round(rgba.height * scale)),
    )
    scaled = rgba.resize(scaled_size, Image.Resampling.LANCZOS)
    canvas = Image.new("RGBA", size, background)
    offset = ((size[0] - scaled_size[0]) // 2, (size[1] - scaled_size[1]) // 2)
    canvas.alpha_composite(scaled, offset)
    return canvas


def build_disguise(
    cover: Image.Image,
    pictures: Sequence[Image.Image],
    durations_ms: Union[int, Sequence[int]] = DEFAULT_FRAME_MS,
    background: Rgba = WHITE,
) -> bytes:
    """Return the bytes of a disguise APNG.

    Every picture is fitted onto one canvas as large as the largest picture;
    the cover is fitted onto the same canvas. Pixels are written as given:
    call :func:`scrub_hidden_data` first when the file is meant for sharing.
    """
    if not pictures:
        raise ValueError("A disguise needs at least one real picture")
    durations = _normalize_durations(durations_ms, len(pictures))
    canvas_size = (max(p.width for p in pictures), max(p.height for p in pictures))
    frames = [fit_onto_canvas(picture, canvas_size, background) for picture in pictures]
    still = fit_onto_canvas(cover, canvas_size, background)

    controls = [
        (frame, duration, _BLEND_SOURCE) for frame, duration in zip(frames, durations)
    ]
    if len(frames) == 1:
        # Some viewers treat a one-frame animation as a still image and would
        # show the cover. A transparent 1x1 frame blended over the picture
        # makes it two frames without changing what is on screen.
        controls.append(
            (Image.new("RGBA", (1, 1), (0, 0, 0, 0)), durations[0], _BLEND_OVER)
        )

    width, height = canvas_size
    parts = [
        PNG_SIGNATURE,
        _chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)),
        _chunk(b"acTL", struct.pack(">II", len(controls), 0)),
    ]
    parts.extend(_chunk(b"IDAT", piece) for piece in _pieces(_image_data_stream(still)))
    sequence = 0
    for frame, duration, blend in controls:
        parts.append(
            _chunk(
                b"fcTL",
                struct.pack(
                    ">IIIIIHHBB",
                    sequence,
                    frame.width,
                    frame.height,
                    0,
                    0,
                    duration,
                    1000,
                    _DISPOSE_NONE,
                    blend,
                ),
            )
        )
        sequence += 1
        for piece in _pieces(_image_data_stream(frame)):
            parts.append(_chunk(b"fdAT", struct.pack(">I", sequence) + piece))
            sequence += 1
    parts.append(_chunk(b"IEND", b""))
    return b"".join(parts)


def _normalize_durations(
    durations_ms: Union[int, Sequence[int]], count: int
) -> list[int]:
    values = (
        [durations_ms] * count if isinstance(durations_ms, int) else list(durations_ms)
    )
    if len(values) != count:
        raise ValueError(f"Expected {count} frame durations, got {len(values)}")
    return [min(MAX_FRAME_MS, max(1, int(value))) for value in values]


def _image_data_stream(image: Image.Image) -> bytes:
    """Compressed RGBA scanlines, as Pillow's PNG encoder writes them into IDAT."""
    buffer = io.BytesIO()
    image.convert("RGBA").save(buffer, format="PNG", compress_level=6)
    data = buffer.getvalue()
    stream = bytearray()
    for chunk_type, payload in _iter_chunks_in_bytes(data):
        if chunk_type == b"IHDR" and payload[8:13] != bytes((8, 6, 0, 0, 0)):
            raise ValueError("Pillow did not encode the frame as 8-bit RGBA")
        if chunk_type == b"IDAT":
            stream += payload
    return bytes(stream)


def _iter_chunks_in_bytes(data: bytes) -> Iterator[tuple[bytes, bytes]]:
    position = len(PNG_SIGNATURE)
    while position + 8 <= len(data):
        length, chunk_type = struct.unpack(">I4s", data[position : position + 8])
        yield chunk_type, data[position + 8 : position + 8 + length]
        position += 12 + length


def _pieces(stream: bytes) -> Iterator[bytes]:
    for start in range(0, max(len(stream), 1), DATA_CHUNK_BYTES):
        yield stream[start : start + DATA_CHUNK_BYTES]


def _chunk(chunk_type: bytes, payload: bytes) -> bytes:
    crc = zlib.crc32(chunk_type + payload) & 0xFFFFFFFF
    return (
        struct.pack(">I", len(payload)) + chunk_type + payload + struct.pack(">I", crc)
    )


# ------------------------------------------------------------- recognising


def probe_disguise(source: Source) -> Optional[DisguiseInfo]:
    """Return what the file holds if it is a disguise, else None.

    Reads chunk headers only (chunk bodies are skipped), so it is cheap enough
    to run on every new PNG during a scan. Unreadable input is not an error:
    it is simply not a disguise.
    """
    try:
        with _open_source(source) as handle:
            return _probe_handle(handle)
    except (OSError, struct.error, ValueError):
        return None


def _probe_handle(handle: BinaryIO) -> Optional[DisguiseInfo]:
    if handle.read(len(PNG_SIGNATURE)) != PNG_SIGNATURE:
        return None
    size: Optional[tuple[int, int]] = None
    has_animation_control = False
    seen_image_data = False
    controls: list[_FrameControl] = []
    for chunk_type, payload in _iter_chunk_headers(handle):
        if chunk_type == b"IHDR" and len(payload) >= 8:
            size = struct.unpack(">II", payload[:8])
        elif chunk_type == b"acTL":
            has_animation_control = True
        elif chunk_type == b"IDAT":
            if not has_animation_control:
                # acTL must precede IDAT, so this is a plain PNG: stop reading.
                return None
            seen_image_data = True
        elif chunk_type == b"fcTL":
            if not seen_image_data:
                # The still picture is the first animation frame: an ordinary APNG.
                return None
            controls.append(_parse_frame_control(payload))
    if size is None or not has_animation_control or not controls:
        return None
    real = [control for control in controls if not _is_keepalive(control, size)]
    return DisguiseInfo(size[0], size[1], len(controls), len(real))


def _iter_chunk_headers(handle: BinaryIO) -> Iterator[tuple[bytes, bytes]]:
    """Yield (type, payload) with payload read only for small control chunks."""
    while True:
        header = handle.read(8)
        if len(header) < 8:
            return
        length, chunk_type = struct.unpack(">I4s", header)
        if length > _MAX_CHUNK_LENGTH:
            return
        start = handle.tell()
        payload = (
            handle.read(length) if chunk_type in (b"IHDR", b"acTL", b"fcTL") else b""
        )
        yield chunk_type, payload
        if chunk_type == b"IEND":
            return
        handle.seek(start + length + 4)


def _parse_frame_control(payload: bytes) -> _FrameControl:
    if len(payload) < 26:
        raise ValueError("Short fcTL chunk")
    _sequence, width, height, _x, _y, delay_num, delay_den = struct.unpack(
        ">IIIIIHH", payload[:24]
    )
    # APNG spec: a zero denominator means 1/100 s.
    denominator = delay_den or 100
    return _FrameControl(width, height, round(delay_num * 1000 / denominator))


def _is_keepalive(control: _FrameControl, canvas: tuple[int, int]) -> bool:
    canvas_pixels = canvas[0] * canvas[1]
    return (
        canvas_pixels > KEEPALIVE_MAX_PIXELS
        and control.width * control.height <= KEEPALIVE_MAX_PIXELS
    )


def _open_source(source: Source) -> BinaryIO:
    if isinstance(source, (bytes, bytearray)):
        return io.BytesIO(source)
    return open(source, "rb")


# --------------------------------------------------------------- restoring


def extract_real_frames(source: Source) -> list[RealFrame]:
    """Decode the real picture(s) of a disguise, keep-alive frames left out."""
    with _open_source(source) as handle:
        info_handle = io.BytesIO(handle.read())
    if _probe_handle(info_handle) is None:
        raise ValueError("Not a disguise image")
    info_handle.seek(len(PNG_SIGNATURE))
    controls = [
        _parse_frame_control(payload)
        for chunk_type, payload in _iter_chunk_headers(info_handle)
        if chunk_type == b"fcTL"
    ]
    info_handle.seek(0)
    try:
        with Image.open(info_handle) as image:
            canvas = image.size
            frames: list[RealFrame] = []
            # Frame 0 is the still picture (the cover); frame i is fcTL i-1.
            for index, control in enumerate(controls, start=1):
                if _is_keepalive(control, canvas):
                    continue
                image.seek(index)
                picture = image.convert("RGBA")
                # convert() copies the source's info, including its
                # "default_image" flag, which the PNG writer would honour.
                picture.info = {}
                frames.append(RealFrame(picture, control.duration_ms))
    except (OSError, EOFError, SyntaxError, Image.DecompressionBombError) as exc:
        raise DisguiseReadError(f"Cannot decode the real picture: {exc}") from exc
    if not frames:
        raise DisguiseReadError("The disguise holds no real picture")
    return frames


def encode_restored(frames: Sequence[RealFrame]) -> bytes:
    """A plain PNG for one picture, an ordinary looping APNG for several."""
    buffer = io.BytesIO()
    first = frames[0].image
    if len(frames) == 1:
        first.save(buffer, format="PNG")
    else:
        first.save(
            buffer,
            format="PNG",
            save_all=True,
            append_images=[frame.image for frame in frames[1:]],
            duration=[frame.duration_ms for frame in frames],
            loop=0,
            disposal=_DISPOSE_NONE,
            blend=_BLEND_SOURCE,
            default_image=False,
        )
    return buffer.getvalue()


def restored_path_for(path: Union[str, os.PathLike]) -> Path:
    source = Path(path)
    return source.with_name(f"{source.stem}{RESTORED_SUFFIX}.png")


def restore_next_to(path: Union[str, os.PathLike]) -> Optional[Path]:
    """Write the real picture of a disguise beside it as ``<name>_real.png``.

    Returns the new path, or None when the file is not a disguise or the
    target name is already taken (an existing file is never replaced).
    Raises DisguiseReadError when the disguise cannot be decoded and OSError
    when the file cannot be written.
    """
    if probe_disguise(path) is None:
        return None
    target = restored_path_for(path)
    if target.exists():
        return None
    data = encode_restored(extract_real_frames(path))
    if not _write_new_file(target, data):
        return None
    logger.info("Restored the real picture of disguise %s", Path(path).name)
    return target


def _write_new_file(path: Path, data: bytes) -> bool:
    """Publish ``data`` at ``path`` via a temp file; False if ``path`` appeared meanwhile."""
    temp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        with open(temp, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        if path.exists():
            return False
        os.replace(temp, path)
        return True
    finally:
        if temp.exists():
            temp.unlink()
