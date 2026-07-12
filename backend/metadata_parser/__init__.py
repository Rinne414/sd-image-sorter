"""
Metadata parser for Stable Diffusion generated images.
Detects generator type and extracts prompt information.

Supports:
- ComfyUI (JSON workflow in PNG prompt/workflow chunks, complex node graphs)
- NovelAI (Comment JSON, EXIF UserComment for V4+, WebP EXIF)
- WebUI/A1111 (parameters text chunk)
- Forge (WebUI variant with Forge identifier)
- JPEG EXIF/UserComment
- WebP EXIF + XMP
"""
# =============================================================================
# metadata_parser (package top module) - metadata_parser decomposition stages 1+2 (2026-07-13).
# Extracted VERBATIM from backend/metadata_parser.py @ c06d374 (4,912 lines).
# Source line ranges (original file): 1-12, 46-47, 207-964, 1917-1969, 2045-2396, 4591-4600, 4647-4655, 4696-4705, 4797-4843, 4844-4884, 4885-4912.
# Owns parse()/dispatch, ALL loader/sidecar/verify seam methods, the singleton.
# self.* calls and class-constant lookups resolve via MRO exactly as before.
# Patched seams (Image / open / _MAX_* / _sidecar_directory_cache) live ONLY
# in metadata_parser/__init__.py; see tests/test_metadata_parser_pins.py.
import json
import logging
import struct
import os
import zlib
from typing import Optional, Dict, Any, Tuple, Set
from PIL import Image
from pathlib import Path
from .constants import (
    PARSED_METADATA_VERSION,
    PNG_SIGNATURE,
    _MAX_PNG_CHUNK_BYTES,
    _MAX_DECOMPRESSED_BYTES,
    JPEG_SIGNATURE,
    _MAX_JPEG_SEGMENT_BYTES,
    _MAX_XMP_CHUNK_BYTES,
    _MAX_SIDECAR_BYTES,
    _MAX_SIDECAR_DIRECTORY_CACHE_ENTRIES,
    _MAX_SIDECAR_DIRECTORY_CACHE_FILENAMES,
    SIDECAR_EXTENSIONS,
    _sidecar_directory_cache,
    WEBP_SIGNATURE,
    WEBP_FOURCC,
    _MAX_WEBP_CHUNK_BYTES,
)

from .alt_generators import AltGeneratorsMixin
from .comfyui import (
    ComfyUIAssetsMixin,
    ComfyUIExtractMixin,
    ComfyUIGraphMixin,
    ComfyUITextTraceMixin,
)
from .constants import ParserVocabularyMixin
from .exif_xmp import ExifXmpMixin
from .model_assets import ModelAssetsMixin
from .novelai import NovelAIMixin
from .webui import WebUIMixin

logger = logging.getLogger(__name__)


class MetadataParser(
    ParserVocabularyMixin,
    ExifXmpMixin,
    ModelAssetsMixin,
    WebUIMixin,
    AltGeneratorsMixin,
    NovelAIMixin,
    ComfyUIExtractMixin,
    ComfyUIAssetsMixin,
    ComfyUIGraphMixin,
    ComfyUITextTraceMixin,
):
    """Parse metadata from SD-generated images to detect source and extract prompts."""

    def parse(self, image_path: str, validate_image_data: bool = False) -> Dict[str, Any]:
        """
        Parse image metadata and return structured data.

        Returns:
            {
                "generator": str,  # comfyui, nai, webui, forge, others, unknown
                "prompt": str or None,
                "negative_prompt": str or None,
                "checkpoint": str or None,
                "loras": list of str,
                "metadata": dict,  # Full raw metadata (includes _parsed key)
                "width": int,
                "height": int,
                "file_size": int
            }
        """
        result: Dict[str, Any] = {
            "generator": "unknown",
            "prompt": None,
            "negative_prompt": None,
            "checkpoint": None,
            "loras": [],
            "metadata": {},
            "width": 0,
            "height": 0,
            "file_size": 0,
            "parse_error": None,
        }

        try:
            result["file_size"] = os.path.getsize(image_path)
            metadata = self._load_image_metadata(image_path)
            result["width"] = metadata["width"]
            result["height"] = metadata["height"]

            if validate_image_data:
                # Full decode is much slower on large PNG/WebP files and is not
                # required for scan-time metadata ingestion. Re-open + verify()
                # still catches common corruption/truncation without paying the
                # full pixel decode cost. Workflows that need deep decode already
                # use verify_image_readable() separately.
                with Image.open(image_path) as verify_img:
                    verify_img.verify()

            result["metadata"] = self._serialize_metadata(metadata["metadata"])

            # Detect generator and extract prompts, checkpoint, loras + extras
            parsed = self._detect_and_parse(metadata["metadata"], image_path=image_path, file_size=result["file_size"])
            if parsed["generator"] == "unknown" and not any((parsed.get("prompt"), parsed.get("negative_prompt"), parsed.get("checkpoint"), parsed.get("loras"))):
                sidecar_metadata = self._load_sidecar_metadata(image_path)
                if sidecar_metadata:
                    combined_metadata = {**metadata["metadata"], **sidecar_metadata}
                    sidecar_parsed = self._detect_and_parse(combined_metadata, image_path=image_path, file_size=result["file_size"])
                    if sidecar_parsed["generator"] != "unknown" or any((
                        sidecar_parsed.get("prompt"),
                        sidecar_parsed.get("negative_prompt"),
                        sidecar_parsed.get("checkpoint"),
                        sidecar_parsed.get("loras"),
                    )):
                        metadata["metadata"] = combined_metadata
                        result["metadata"] = self._serialize_metadata(combined_metadata)
                        parsed = sidecar_parsed
            result["generator"] = parsed["generator"]
            result["prompt"] = parsed["prompt"]
            result["negative_prompt"] = parsed["negative_prompt"]
            result["checkpoint"] = parsed["checkpoint"]
            result["loras"] = parsed["loras"]

            # Add civitai_resources to top-level result if present
            if "civitai_resources" in parsed:
                result["civitai_resources"] = parsed["civitai_resources"]

            # Store structured parsed data in metadata for frontend access
            result["metadata"]["_parsed"] = {
                "version": PARSED_METADATA_VERSION,
                "generation_params": parsed.get("generation_params"),
                "is_img2img": parsed.get("is_img2img", False),
                "img2img_info": parsed.get("img2img_info"),
                "character_prompts": parsed.get("character_prompts"),
                "prompt_nodes": parsed.get("prompt_nodes"),
                "model_assets": parsed.get("model_assets"),
                "civitai_resources": parsed.get("civitai_resources"),
            }

            # Metadata L3: parsing produced no positive prompt but the file
            # DOES carry metadata chunks — keep the originals so "Re-parse
            # failed images" can replay them through a future, better parser
            # even if the file is later moved or deleted. metadata_json is not
            # enough for that: it truncates large chunks during compaction.
            if not (result["prompt"] and str(result["prompt"]).strip()):
                raw_text = self._capture_raw_metadata_text(metadata["metadata"])
                if raw_text:
                    result["raw_metadata_text"] = raw_text

        except Exception as e:
            result["parse_error"] = str(e)
            logger.debug("Failed to parse metadata for %s: %s", image_path, e, exc_info=True)

        return result

    def _capture_raw_metadata_text(self, metadata: Dict[str, Any]) -> Optional[str]:
        """Serialize the original string metadata chunks for L3 retention.

        Returns a JSON envelope of every string chunk (``{"prompt": "...",
        "workflow": "...", ...}``) — the same shape ``_detect_and_parse``
        consumes, so the re-parse job can replay it directly. Returns None
        when there is nothing worth keeping or the caps are exceeded.
        """
        try:
            envelope: Dict[str, str] = {}
            total = 0
            for key, value in metadata.items():
                if not isinstance(key, str) or not isinstance(value, str):
                    continue
                if not value.strip():
                    continue
                if len(value) > self.RAW_METADATA_CHUNK_CAP:
                    continue
                envelope[key] = value
                total += len(value)
                if total > self.RAW_METADATA_TOTAL_CAP:
                    return None
            if not envelope:
                return None
            return json.dumps(envelope, ensure_ascii=False)
        except Exception as exc:
            logger.debug("raw metadata capture failed: %s", exc)
            return None

    def _load_image_metadata(self, image_path: str) -> Dict[str, Any]:
        """Load dimensions and raw metadata with format-specific fast paths.

        The PNG fast-path is byte-strict: it checks the PNG magic
        signature (89 50 4E 47 0D 0A 1A 0A) and rejects anything else.
        That is correct for genuinely corrupt PNGs, but in practice a
        sizable chunk of SD libraries contain JPEG (or WEBP / GIF)
        files that were renamed to ``.png`` by content-management tools
        — Civitai, Discord, browsers, etc. Browsers and Windows
        Explorer render them fine because they sniff format from
        content; our previous behaviour rejected them as
        ``Invalid PNG signature`` and reported them as unreadable
        files in the scan summary, even though Pillow can parse them
        without issue.

        Strategy: if the PNG fast-path raises ``Invalid PNG
        signature``, fall through to the Pillow path. Pillow detects
        format from content magic bytes regardless of file extension,
        so a .png-extension JPEG is parsed as JPEG. Other PNG-shape
        errors (truncated chunks, bad IEND, …) still bubble up as
        legitimate parse failures.
        """
        ext = os.path.splitext(image_path)[1].lower()

        if ext == ".png":
            try:
                return self._load_png_metadata_fast(image_path)
            except ValueError as exc:
                if "Invalid PNG signature" not in str(exc):
                    raise
                # File extension said PNG, content sniff says otherwise.
                # Pillow handles JPEG/WEBP/GIF content with .png extension.

        if ext == ".webp":
            try:
                return self._load_webp_metadata_fast(image_path)
            except ValueError as exc:
                logger.debug("WEBP fast path failed for %s: %s, falling back to Pillow", image_path, exc)
                # Fall through to Pillow on any fast-path failure

        return self._load_image_metadata_via_pillow(image_path)

    def _load_image_metadata_via_pillow(self, image_path: str) -> Dict[str, Any]:
        """Load metadata through Pillow for formats without a custom fast path."""
        with Image.open(image_path) as img:
            metadata = {}
            if hasattr(img, 'info'):
                metadata = dict(img.info)

            metadata.update(self._extract_gif_comment_metadata(img))

            metadata.update(self._extract_exif(img))
            metadata.update(self._extract_exif_ifd(img))

            if img.format == 'WEBP':
                metadata.update(self._extract_webp_xmp(image_path))

            if img.format in ('JPEG', 'JPG'):
                metadata.update(self._extract_jpeg_xmp(image_path))

            if img.format in ('TIFF', 'MPO'):
                metadata.update(self._extract_tiff_xmp(img))

            if img.format in ('JPEG', 'JPG', 'WEBP'):
                metadata.update(self._extract_jpeg_sd_metadata(img))

            return {
                "width": img.width,
                "height": img.height,
                "metadata": metadata,
            }

    def _load_png_metadata_fast(self, image_path: str) -> Dict[str, Any]:
        """Read PNG dimensions + text metadata without a full Pillow open."""
        metadata: Dict[str, Any] = {}
        width = 0
        height = 0
        seen_iend = False

        file_size = os.path.getsize(image_path)

        with open(image_path, "rb") as png_file:
            offset = 0

            signature = png_file.read(len(PNG_SIGNATURE))
            offset += len(signature)
            if signature != PNG_SIGNATURE:
                raise ValueError("Invalid PNG signature")

            while True:
                chunk_length_raw = png_file.read(4)
                offset += len(chunk_length_raw)
                if not chunk_length_raw:
                    break
                if len(chunk_length_raw) != 4:
                    raise ValueError("Truncated PNG chunk length")

                chunk_length = struct.unpack(">I", chunk_length_raw)[0]
                chunk_type = png_file.read(4)
                offset += len(chunk_type)
                if len(chunk_type) != 4:
                    raise ValueError("Truncated PNG chunk type")

                chunk_end = offset + chunk_length + 4
                if chunk_end > file_size:
                    raise ValueError("Truncated PNG chunk data")

                if chunk_type == b"IEND":
                    if chunk_length != 0:
                        raise ValueError("Invalid PNG IEND chunk")
                    png_file.seek(4, os.SEEK_CUR)
                    offset += 4
                    seen_iend = True
                    break

                should_read_chunk = chunk_type in {b"IHDR", b"tEXt", b"zTXt", b"iTXt", b"eXIf"}
                if not should_read_chunk:
                    png_file.seek(chunk_length + 4, os.SEEK_CUR)
                    offset += chunk_length + 4
                    continue

                if chunk_length > _MAX_PNG_CHUNK_BYTES:
                    break  # abort: metadata chunk too large, likely malformed

                chunk_data = png_file.read(chunk_length)
                offset += len(chunk_data)
                if len(chunk_data) != chunk_length:
                    raise ValueError("Truncated PNG chunk data")

                chunk_crc = png_file.read(4)
                offset += len(chunk_crc)
                if len(chunk_crc) != 4:
                    raise ValueError("Truncated PNG chunk CRC")

                if chunk_type == b"IHDR":
                    if chunk_length < 8:
                        raise ValueError("Invalid PNG IHDR chunk")
                    width, height = struct.unpack(">II", chunk_data[:8])
                elif chunk_type == b"tEXt":
                    text_item = self._decode_png_text_chunk(chunk_data)
                    if text_item:
                        metadata[text_item[0]] = text_item[1]
                elif chunk_type == b"zTXt":
                    text_item = self._decode_png_ztxt_chunk(chunk_data)
                    if text_item:
                        metadata[text_item[0]] = text_item[1]
                elif chunk_type == b"iTXt":
                    text_item = self._decode_png_itxt_chunk(chunk_data)
                    if text_item:
                        metadata[text_item[0]] = text_item[1]
                elif chunk_type == b"eXIf":
                    metadata.update(self._extract_exif_from_bytes(chunk_data))
                    metadata.update(self._extract_exif_ifd_from_bytes(chunk_data))
                    metadata.update(self._extract_sd_metadata_from_exif_bytes(chunk_data))

        if width <= 0 or height <= 0:
            raise ValueError("PNG dimensions missing")
        if not seen_iend:
            raise ValueError("Truncated PNG missing IEND chunk")

        return {
            "width": width,
            "height": height,
            "metadata": metadata,
        }

    def _decode_png_text_chunk(self, chunk_data: bytes) -> Optional[Tuple[str, str]]:
        """Decode a PNG tEXt chunk into a key/value pair."""
        if b"\x00" not in chunk_data:
            return None
        keyword, text = chunk_data.split(b"\x00", 1)
        return (
            keyword.decode("latin-1", errors="replace"),
            text.decode("utf-8", errors="replace"),
        )

    def _safe_zlib_decompress_limited(self, compressed_data: bytes, max_output_bytes: int) -> Optional[bytes]:
        """
        Safely decompress zlib data with a hard output cap.

        Returns None on malformed streams or when decompressed bytes exceed
        the configured limit.
        """
        try:
            decompressor = zlib.decompressobj()
            max_probe = max_output_bytes + 1
            decompressed = decompressor.decompress(compressed_data, max_probe)

            if len(decompressed) > max_output_bytes:
                return None

            if decompressor.unconsumed_tail:
                return None

            remaining_budget = max_probe - len(decompressed)
            if remaining_budget > 0:
                decompressed += decompressor.flush(remaining_budget)

            if len(decompressed) > max_output_bytes:
                return None

            if not decompressor.eof:
                return None

            return decompressed
        except zlib.error:
            return None

    def _decode_png_ztxt_chunk(self, chunk_data: bytes) -> Optional[Tuple[str, str]]:
        """Decode a PNG zTXt chunk into a key/value pair."""
        if b"\x00" not in chunk_data:
            return None
        keyword, remainder = chunk_data.split(b"\x00", 1)
        if len(remainder) < 2:
            return None
        compression_method = remainder[0]
        if compression_method != 0:
            return None
        text = self._safe_zlib_decompress_limited(remainder[1:], _MAX_DECOMPRESSED_BYTES)
        if text is None:
            return None
        return (
            keyword.decode("latin-1", errors="replace"),
            text.decode("utf-8", errors="replace"),
        )

    def _decode_png_itxt_chunk(self, chunk_data: bytes) -> Optional[Tuple[str, str]]:
        """Decode a PNG iTXt chunk into a key/value pair."""
        if b"\x00" not in chunk_data:
            return None
        keyword, remainder = chunk_data.split(b"\x00", 1)
        if len(remainder) < 2:
            return None

        compression_flag = remainder[0]
        compression_method = remainder[1]
        remainder = remainder[2:]

        if b"\x00" not in remainder:
            return None
        _language_tag, remainder = remainder.split(b"\x00", 1)
        if b"\x00" not in remainder:
            return None
        _translated_keyword, text_bytes = remainder.split(b"\x00", 1)

        if compression_flag == 1:
            if compression_method != 0:
                return None
            text_bytes = self._safe_zlib_decompress_limited(text_bytes, _MAX_DECOMPRESSED_BYTES)
            if text_bytes is None:
                return None

        return (
            keyword.decode("latin-1", errors="replace"),
            text_bytes.decode("utf-8", errors="replace"),
        )

    def _load_webp_metadata_fast(self, image_path: str) -> Dict[str, Any]:
        """Read WEBP dimensions + EXIF/XMP metadata without a full Pillow open.

        WEBP uses RIFF container format:
        - RIFF header (12 bytes): "RIFF" + file_size + "WEBP"
        - Chunks: fourcc (4 bytes) + chunk_size (4 bytes, little-endian) + data + optional padding

        This fast path parses EXIF and XMP chunks directly, avoiding the overhead
        of full image decoding. Falls back to Pillow on any parsing error.
        """
        metadata: Dict[str, Any] = {}
        width = 0
        height = 0

        file_size = os.path.getsize(image_path)
        if file_size < 12:
            raise ValueError("File too small to be valid WEBP")

        with open(image_path, "rb") as webp_file:
            # Read RIFF header
            riff_header = webp_file.read(4)
            if riff_header != WEBP_SIGNATURE:
                raise ValueError("Invalid WEBP signature")

            # Skip file size field (4 bytes)
            webp_file.read(4)
            webp_fourcc = webp_file.read(4)
            if webp_fourcc != WEBP_FOURCC:
                raise ValueError("Invalid WEBP FOURCC")

            offset = 12

            # Parse chunks
            while offset + 8 <= file_size:
                fourcc = webp_file.read(4)
                if len(fourcc) != 4:
                    break

                chunk_size_bytes = webp_file.read(4)
                if len(chunk_size_bytes) != 4:
                    break

                chunk_size = struct.unpack("<I", chunk_size_bytes)[0]
                offset += 8

                # Check bounds
                chunk_end = offset + chunk_size
                if chunk_end > file_size:
                    raise ValueError(f"WEBP chunk {fourcc!r} exceeds file size")

                # Limit individual chunk size
                if chunk_size > _MAX_WEBP_CHUNK_BYTES:
                    logger.debug("Skipping oversized WEBP chunk %s (%d bytes)", fourcc, chunk_size)
                    webp_file.seek(chunk_size + (chunk_size % 2), os.SEEK_CUR)
                    offset = chunk_end + (chunk_size % 2)
                    continue

                should_read_chunk = fourcc in {b"EXIF", b"XMP ", b"VP8 ", b"VP8L", b"VP8X"}
                if not should_read_chunk:
                    # Skip chunk + padding
                    webp_file.seek(chunk_size + (chunk_size % 2), os.SEEK_CUR)
                    offset = chunk_end + (chunk_size % 2)
                    continue

                chunk_data = webp_file.read(chunk_size)
                if len(chunk_data) != chunk_size:
                    raise ValueError(f"Truncated WEBP chunk {fourcc!r}")

                # Parse chunk based on type
                if fourcc == b"EXIF":
                    # EXIF chunk contains TIFF-format EXIF data
                    metadata.update(self._extract_exif_from_bytes(chunk_data))
                    metadata.update(self._extract_exif_ifd_from_bytes(chunk_data))
                    metadata.update(self._extract_sd_metadata_from_exif_bytes(chunk_data))

                elif fourcc == b"XMP ":
                    # XMP chunk contains UTF-8 XMP metadata
                    try:
                        xmp_text = chunk_data.decode("utf-8", errors="replace")
                        metadata.update(self._extract_xmp_sd_metadata(xmp_text))
                    except Exception as e:
                        logger.debug("Failed to decode WEBP XMP chunk: %s", e)

                elif fourcc == b"VP8 " and width == 0:
                    # VP8 bitstream: extract dimensions from frame header
                    # Skip frame tag (3 bytes) and start code (3 bytes)
                    if chunk_size >= 10:
                        try:
                            # Dimensions are in bytes 6-9 (14 bits each)
                            dim_bytes = struct.unpack("<HH", chunk_data[6:10])
                            width = (dim_bytes[0] & 0x3FFF)
                            height = (dim_bytes[1] & 0x3FFF)
                        except Exception:
                            pass

                elif fourcc == b"VP8L" and width == 0:
                    # VP8L (lossless) bitstream: dimensions in first 5 bytes after signature
                    if chunk_size >= 5:
                        try:
                            # Signature byte (0x2f) + 4 bytes for dimensions
                            if chunk_data[0] == 0x2f:
                                bits = struct.unpack("<I", chunk_data[1:5])[0]
                                width = (bits & 0x3FFF) + 1
                                height = ((bits >> 14) & 0x3FFF) + 1
                        except Exception:
                            pass

                elif fourcc == b"VP8X" and width == 0:
                    # VP8X (extended format): dimensions in bytes 4-9
                    if chunk_size >= 10:
                        try:
                            # Canvas width (24 bits) + height (24 bits)
                            width = struct.unpack("<I", chunk_data[4:7] + b"\x00")[0] + 1
                            height = struct.unpack("<I", chunk_data[7:10] + b"\x00")[0] + 1
                        except Exception:
                            pass

                # Account for padding (chunks are padded to even byte boundaries)
                padding = chunk_size % 2
                if padding:
                    webp_file.seek(1, os.SEEK_CUR)
                offset = chunk_end + padding

        if width <= 0 or height <= 0:
            raise ValueError("WEBP dimensions not found or invalid")

        return {
            "width": width,
            "height": height,
            "metadata": metadata,
        }

    def _serialize_metadata(self, metadata: dict) -> dict:
        """Serialize metadata to JSON-safe format."""
        result = {}
        for key, value in metadata.items():
            try:
                # Try to serialize, skip if not possible
                json.dumps({key: value})
                result[key] = value
            except (TypeError, ValueError):
                # Convert bytes to string - serialization failed
                if isinstance(value, bytes):
                    try:
                        result[key] = value.decode('utf-8', errors='replace')
                    except Exception:
                        result[key] = str(value)
                else:
                    result[key] = str(value)
        return result

    def _decode_exif_user_comment(self, value: Any) -> Optional[str]:
        """Decode EXIF UserComment bytes written by SD tools for JPEG/WebP."""
        if value is None:
            return None
        if isinstance(value, str):
            text = value
            if text.startswith("ASCII") or text.startswith("UNICODE"):
                text = text[7:].strip("\0 ")
            return text.strip() or None
        if not isinstance(value, bytes):
            text = str(value).strip()
            return text or None

        if value.startswith(b"ASCII\x00\x00\x00"):
            text = value[8:].decode("utf-8", errors="replace")
        elif value.startswith(b"UNICODE\x00"):
            payload = value[8:]
            text = self._decode_exif_unicode_payload(payload)
        elif value.startswith(b"\x00" * 8):
            text = value[8:].decode("utf-8", errors="replace")
        else:
            text = self._decode_exif_text_bytes(value)

        text = text.strip("\0 ")
        return text or None

    def _decode_exif_unicode_payload(self, payload: bytes) -> str:
        """Decode the non-standard-but-common UNICODE UserComment payload."""
        if payload.startswith(b"\xff\xfe") or payload.startswith(b"\xfe\xff"):
            return payload.decode("utf-16", errors="replace")
        if len(payload) >= 2 and payload[1:2] == b"\x00":
            return payload.decode("utf-16-le", errors="replace")
        return payload.decode("utf-16-be", errors="replace")

    def _decode_exif_text_bytes(self, value: bytes) -> str:
        """Decode generic EXIF text bytes, including Windows XP* UTF-16LE tags."""
        if value.startswith(b"\xff\xfe") or value.startswith(b"\xfe\xff"):
            return value.decode("utf-16", errors="replace")
        if len(value) >= 4 and value[1::2].count(0) >= max(1, len(value) // 4):
            return value.decode("utf-16-le", errors="replace")
        return value.decode("utf-8", errors="replace")

    def _load_sidecar_metadata(self, image_path: str) -> Dict[str, Any]:
        """Load small same-name sidecar metadata only after embedded parsing fails."""
        metadata: Dict[str, Any] = {}
        base_path = Path(image_path)
        candidates = []
        for extension in SIDECAR_EXTENSIONS:
            candidates.append(Path(f"{image_path}{extension}"))
            candidates.append(base_path.with_suffix(extension))

        seen: Set[str] = set()
        for candidate in candidates:
            candidate_key = os.path.abspath(os.fspath(candidate))
            if candidate_key in seen:
                continue
            seen.add(candidate_key)
            if not self._sidecar_candidate_exists(candidate):
                continue
            loaded = self._load_one_sidecar(candidate)
            if loaded:
                metadata.update(loaded)

        return metadata

    def _sidecar_candidate_exists(self, sidecar_path: Path) -> bool:
        """Check sidecar existence with a lightweight per-directory listing cache."""
        try:
            directory = sidecar_path.parent
            stat_result = directory.stat()
            cache_key = os.path.abspath(os.fspath(directory))
            fingerprint = (int(stat_result.st_mtime_ns), int(stat_result.st_size))
            cached = _sidecar_directory_cache.get(cache_key)
            if cached is None or cached[0] != fingerprint:
                sidecar_names: Set[str] = set()
                candidate_name = sidecar_path.name
                candidate_found = False
                too_many_sidecars = False
                for entry in os.scandir(directory):
                    if not entry.is_file(follow_symlinks=False) or Path(entry.name).suffix.lower() not in SIDECAR_EXTENSIONS:
                        continue
                    if entry.name == candidate_name:
                        candidate_found = True
                    if not too_many_sidecars:
                        sidecar_names.add(entry.name)
                        if len(sidecar_names) >= _MAX_SIDECAR_DIRECTORY_CACHE_FILENAMES:
                            too_many_sidecars = True
                if len(_sidecar_directory_cache) >= _MAX_SIDECAR_DIRECTORY_CACHE_ENTRIES:
                    _sidecar_directory_cache.clear()
                if too_many_sidecars:
                    _sidecar_directory_cache[cache_key] = (fingerprint, None)
                    return candidate_found
                _sidecar_directory_cache[cache_key] = (fingerprint, sidecar_names)
            else:
                sidecar_names = cached[1]
            if sidecar_names is None:
                return sidecar_path.is_file() and not sidecar_path.is_symlink()
            return sidecar_path.name in sidecar_names
        except OSError:
            return False

    def _load_one_sidecar(self, sidecar_path: Path) -> Dict[str, Any]:
        """Load a supported sidecar if it is small and local to the image."""
        try:
            if not sidecar_path.is_file() or sidecar_path.is_symlink():
                return {}
            if sidecar_path.stat().st_size > _MAX_SIDECAR_BYTES:
                return {}
            text = sidecar_path.read_text(encoding="utf-8-sig", errors="replace")
        except OSError:
            return {}

        text = text.strip()
        if not text:
            return {}

        suffix = sidecar_path.suffix.lower()
        if suffix == ".xmp":
            metadata = self._extract_xmp_sd_metadata(text)
            metadata["sidecar_path"] = os.fspath(sidecar_path)
            return metadata
        if suffix == ".json":
            return self._parse_json_sidecar(text, sidecar_path)
        if suffix == ".txt":
            return self._parse_text_sidecar(text, sidecar_path)
        return {}

    def _parse_json_sidecar(self, text: str, sidecar_path: Path) -> Dict[str, Any]:
        """Parse a JSON sidecar into known SD metadata fields."""
        try:
            payload = json.loads(text)
        except json.JSONDecodeError:
            return self._parse_text_sidecar(text, sidecar_path)

        metadata: Dict[str, Any] = {"sidecar_path": os.fspath(sidecar_path)}
        if isinstance(payload, dict):
            if self._looks_like_comfyui_prompt_dict(payload):
                metadata["prompt"] = json.dumps(payload, ensure_ascii=False)
                return metadata
            if "workflow" in payload:
                metadata["workflow"] = json.dumps(payload.get("workflow"), ensure_ascii=False)
            if "prompt" in payload and isinstance(payload.get("prompt"), dict) and self._looks_like_comfyui_prompt_dict(payload["prompt"]):
                metadata["prompt"] = json.dumps(payload["prompt"], ensure_ascii=False)
                return metadata

            key_aliases = {
                "prompt": "prompt",
                "positive_prompt": "prompt",
                "caption": "prompt",
                "text": "prompt",
                "negative_prompt": "negative_prompt",
                "negative prompt": "negative_prompt",
                "uc": "negative_prompt",
                "model": "model",
                "checkpoint": "checkpoint",
                "ckpt": "checkpoint",
                "loras": "loras",
                "lora": "loras",
                "steps": "steps",
                "sampler": "sampler",
                "seed": "seed",
                "cfg_scale": "cfg_scale",
                "cfg scale": "cfg_scale",
                "size": "size",
            }
            for key, value in payload.items():
                canonical_key = key_aliases.get(str(key).strip().lower(), str(key).strip())
                if canonical_key:
                    metadata[canonical_key] = value
            return metadata

        if isinstance(payload, list):
            metadata["prompt"] = self._flatten_text_value(payload)
            return {key: value for key, value in metadata.items() if value}

        return self._parse_text_sidecar(str(payload), sidecar_path)

    def _parse_text_sidecar(self, text: str, sidecar_path: Path) -> Dict[str, Any]:
        """Parse a plain text sidecar as WebUI params or a caption prompt."""
        metadata: Dict[str, Any] = {"sidecar_path": os.fspath(sidecar_path)}
        if "Steps:" in text and "Sampler:" in text:
            metadata["parameters"] = text
        else:
            metadata["prompt"] = text
        return metadata

    def _looks_like_comfyui_prompt_dict(self, payload: Any) -> bool:
        """Return True for ComfyUI API prompt dictionaries."""
        return isinstance(payload, dict) and any(
            isinstance(value, dict) and "class_type" in value
            for value in payload.values()
        )

    def _flatten_text_value(self, value: Any) -> Optional[str]:
        """Flatten nested metadata values to a readable text string."""
        if value is None:
            return None
        if isinstance(value, str):
            text = value.strip()
            return text or None
        if isinstance(value, (list, tuple)):
            parts = []
            for item in value:
                part = self._flatten_text_value(item)
                if part:
                    parts.append(part)
            if not parts:
                return None
            return "\n".join(parts)
        if isinstance(value, dict):
            for key in ("base_caption", "caption", "text", "prompt", "value", "content", "description"):
                nested = self._flatten_text_value(value.get(key))
                if nested:
                    return nested
            for nested in value.values():
                flattened = self._flatten_text_value(nested)
                if flattened:
                    return flattened
        return None

    # ------------------------------------------------------------------
    # Everything below stays in the top module because it READS the
    # module globals tests monkeypatch (open / Image / _MAX_* caps /
    # _sidecar_directory_cache) -- see the pins file, Group A.
    # ------------------------------------------------------------------

    # Soft cap for the C2PA byte-signature fallback. The C2PA / JUMBF
    # manifest is typically front-loaded near the file header; we only
    # scan the first chunk to keep scan-time IO bounded. 512 KiB is
    # enough for both PNG `caBX` and JPEG `APP11` segments.
    _C2PA_SCAN_BYTES = 512 * 1024
    # Skip files smaller than this — they cannot realistically carry a
    # C2PA manifest with cryptographic signatures.
    _C2PA_MIN_FILE_BYTES = 32 * 1024

    # Distinct byte signatures we look for inside the front of the file.
    # Lowercased haystack is matched. Each tuple is (generator_id, marker
    # bytes that must appear). When matched, we still require the
    # marker to live near a "c2pa", "jumbf", or "claim_generator" anchor
    # to reduce false positives (e.g. an unrelated PNG that happens to
    # mention "openai" inside a tag).
    _C2PA_SIGNATURES = (
        ("gpt-image", (b"gpt-image", b"chatgpt", b"openai")),
        ("gemini",    (b"gemini", b"imagen", b"google ai", b"nano-banana", b"deepmind")),
    )
    _C2PA_ANCHORS = (b"c2pa", b"jumbf", b"claim_generator", b"contentcredentials", b"content credentials")

    def _scan_c2pa_byte_signatures(self, image_path: str, file_size: int) -> Optional[str]:
        """Best-effort C2PA / "Content Credentials" byte scan.

        Many AI providers (OpenAI ChatGPT image, Google Gemini / Imagen)
        cryptographically sign their output with C2PA manifests stored
        in PNG `caBX` chunks or JPEG `APP11` segments. We don't validate
        the signature — that would need the c2pa-python dependency — we
        just look for the provider's name near a manifest anchor (e.g.
        `c2pa`, `jumbf`, `claim_generator`). Bounded to 512 KiB of IO so
        this stays cheap during library scans.
        """
        if file_size < self._C2PA_MIN_FILE_BYTES:
            return None
        try:
            with open(image_path, "rb") as fh:
                blob = fh.read(self._C2PA_SCAN_BYTES)
        except (OSError, IOError) as exc:
            logger.debug("C2PA byte scan failed for %s: %s", image_path, exc)
            return None
        if not blob:
            return None
        haystack = blob.lower()
        # Anchor first — bail early if no manifest-shaped marker is in
        # the file. This keeps detection narrow on regular SD images
        # that happen to contain a tag like "openai" in their prompt.
        if not any(anchor in haystack for anchor in self._C2PA_ANCHORS):
            return None
        for generator_id, markers in self._C2PA_SIGNATURES:
            if any(marker in haystack for marker in markers):
                return generator_id
        return None

    def _detect_and_parse(self, metadata: dict, image_path: Optional[str] = None, file_size: int = 0) -> Dict[str, Any]:
        """
        Detect generator type and extract prompts, checkpoint, loras, and extended info.
        Returns a dict with keys: generator, prompt, negative_prompt, checkpoint, loras,
        generation_params, is_img2img, img2img_info, character_prompts, prompt_nodes.
        """
        base: Dict[str, Any] = {
            "generator": "unknown",
            "prompt": None,
            "negative_prompt": None,
            "checkpoint": None,
            "loras": [],
            "generation_params": None,
            "is_img2img": False,
            "img2img_info": None,
            "character_prompts": None,
            "prompt_nodes": None,
            "model_assets": None,
        }

        # === Check for WebUI/Forge 'parameters' text chunk first ===
        if "parameters" in metadata:
            params = metadata["parameters"]
            if isinstance(params, str) and ("Steps:" in params and "Sampler:" in params):
                prompt, neg, cp, lr, gen_params = self._parse_webui_parameters(params)
                generator = self._detect_webui_family_generator(params, metadata, gen_params)
                base.update({
                    "generator": generator, "prompt": prompt, "negative_prompt": neg,
                    "checkpoint": cp, "loras": lr, "generation_params": gen_params,
                })
                if not base["checkpoint"]:
                    base["checkpoint"] = self._extract_metadata_model_identifier(metadata)
                base["model_assets"] = self._build_explicit_model_assets(
                    source=f"{generator}_parameters",
                    checkpoint=base["checkpoint"],
                    loras=base["loras"],
                    yolo_models=self._extract_webui_yolo_models(params, gen_params),
                )
                self._merge_workflow_widget_assets_into_result(base, metadata)
                # img2img detection for WebUI/Forge
                if gen_params:
                    ds = gen_params.get("denoising_strength")
                    if ds is not None:
                        base["is_img2img"] = True
                        source = "img2img"
                        if gen_params.get("mask_hash"):
                            source = "inpaint"
                        elif gen_params.get("hires_upscaler"):
                            source = "hires fix"
                            base["is_img2img"] = False  # hires fix isn't true img2img
                        base["img2img_info"] = {"denoising_strength": ds, "source": source}
                return base

        # === Check for NovelAI EXIF UserComment (V4+ format) ===
        if "UserComment" in metadata:
            nai_result = self._parse_nai_usercomment_extended(metadata["UserComment"], metadata)
            if nai_result:
                if not nai_result.get("model_assets"):
                    nai_result["model_assets"] = self._build_explicit_model_assets(
                        source="nai_usercomment",
                        checkpoint=nai_result.get("checkpoint"),
                    )
                base.update(nai_result)
                return base

        # === Check for NovelAI 'Comment' PNG text chunk ===
        if "Comment" in metadata:
            try:
                comment = metadata["Comment"]
                if isinstance(comment, str):
                    comment_data = json.loads(comment)
                    # ---- Fooocus disambiguation ---------------------
                    # Fooocus uses lowercase `prompt`/`negative_prompt`
                    # in the same `Comment` chunk, which would otherwise
                    # be classified as NovelAI here. Detect Fooocus by
                    # its distinctive sibling keys (`base_model`,
                    # `performance`, `metadata_scheme`, `version`
                    # containing "Fooocus") OR the presence of
                    # `negative_prompt` instead of NovelAI's `uc`.
                    if isinstance(comment_data, dict):
                        looks_like_fooocus = (
                            metadata.get("fooocus_scheme") is not None
                            or comment_data.get("metadata_scheme") in {"fooocus", "a1111"}
                            or "base_model" in comment_data
                            or "performance" in comment_data
                            or "Performance" in comment_data
                            or "Base Model" in comment_data
                            or "negative_prompt" in comment_data and "uc" not in comment_data
                            or (
                                isinstance(comment_data.get("version"), str)
                                and "fooocus" in comment_data["version"].lower()
                            )
                        )
                        if looks_like_fooocus:
                            fooocus_result = self._maybe_parse_fooocus(metadata)
                            if fooocus_result:
                                base.update({k: v for k, v in fooocus_result.items() if v is not None or k in ("prompt", "negative_prompt", "checkpoint")})
                                base.setdefault("loras", fooocus_result.get("loras") or [])
                                if not base.get("model_assets"):
                                    base["model_assets"] = fooocus_result.get("model_assets")
                                return base

                    if isinstance(comment_data, dict) and (
                        "prompt" in comment_data
                        or "uc" in comment_data
                        or "v4_prompt" in comment_data
                        or "v4_negative_prompt" in comment_data
                    ):
                        prompt = self._flatten_text_value(comment_data.get("prompt"))
                        neg = self._flatten_text_value(comment_data.get("uc"))

                        v4_prompt = comment_data.get("v4_prompt")
                        if not prompt and isinstance(v4_prompt, dict):
                            prompt = self._flatten_text_value(
                                v4_prompt.get("prompt")
                                or v4_prompt.get("caption")
                                or v4_prompt
                            )

                        v4_negative = comment_data.get("v4_negative_prompt")
                        if not neg:
                            neg = self._flatten_text_value(
                                v4_negative.get("prompt") if isinstance(v4_negative, dict) else v4_negative
                            )
                            if not neg and isinstance(v4_negative, dict):
                                neg = self._flatten_text_value(v4_negative.get("caption") or v4_negative)

                        base.update({"generator": "nai", "prompt": prompt, "negative_prompt": neg})
                        base["checkpoint"] = self._extract_metadata_model_identifier(metadata)
                        base["model_assets"] = self._build_explicit_model_assets(
                            source="nai_comment",
                            checkpoint=base["checkpoint"],
                        )
                        # Extract NAI generation params
                        base["generation_params"] = self._extract_nai_gen_params(comment_data)
                        # Extract character prompts if present
                        char_prompts = self._extract_nai_character_prompts(comment_data)
                        if char_prompts:
                            base["character_prompts"] = char_prompts
                        # NAI img2img detection
                        if comment_data.get("strength") is not None and comment_data.get("strength", 1.0) < 1.0:
                            base["is_img2img"] = True
                            base["img2img_info"] = {
                                "denoising_strength": comment_data["strength"],
                                "source": "img2img",
                            }
                        return base
            except (json.JSONDecodeError, TypeError, ValueError) as e:
                logger.debug("Failed to parse JSON: %s", e)

        # === Check for NovelAI Description field ===
        if "Description" in metadata:
            desc = metadata["Description"]
            software = str(metadata.get("Software", "")).lower()
            if "novelai" in software:
                neg = None
                if "Comment" in metadata:
                    try:
                        comment_data = json.loads(metadata["Comment"])
                        if isinstance(comment_data, dict):
                            neg = comment_data.get("uc", None)
                            base["generation_params"] = self._extract_nai_gen_params(comment_data)
                            char_prompts = self._extract_nai_character_prompts(comment_data)
                            if char_prompts:
                                base["character_prompts"] = char_prompts
                    except (json.JSONDecodeError, TypeError, ValueError) as e:
                        logger.debug("Failed to parse Comment in Description path: %s", e)
                base.update({"generator": "nai", "prompt": str(desc), "negative_prompt": neg})
                base["checkpoint"] = self._extract_metadata_model_identifier(metadata)
                base["model_assets"] = self._build_explicit_model_assets(
                    source="nai_description",
                    checkpoint=base["checkpoint"],
                )
                return base

        # === Check for ComfyUI 'prompt' key with JSON workflow ===
        if "prompt" in metadata:
            try:
                prompt_data = metadata["prompt"]
                workflow_data = metadata.get("workflow")
                if isinstance(workflow_data, str):
                    try:
                        workflow_data = json.loads(workflow_data)
                    except (json.JSONDecodeError, TypeError, ValueError):
                        workflow_data = None
                if isinstance(prompt_data, str):
                    prompt_data = json.loads(prompt_data)
                if isinstance(prompt_data, dict):
                    has_nodes = any(
                        isinstance(v, dict) and "class_type" in v
                        for v in prompt_data.values()
                    )
                    if has_nodes:
                        pos, neg, cp, lr, gen_params, prompt_nodes, img2img, model_assets, civitai_resources = self._extract_comfyui_data_extended(prompt_data, workflow_data)
                        base.update({
                            "generator": "comfyui", "prompt": pos, "negative_prompt": neg,
                            "checkpoint": cp, "loras": lr, "generation_params": gen_params,
                            "prompt_nodes": prompt_nodes,
                            "model_assets": model_assets,
                        })
                        if civitai_resources:
                            base["civitai_resources"] = civitai_resources
                        if img2img:
                            base["is_img2img"] = True
                            base["img2img_info"] = img2img
                        return base
            except (json.JSONDecodeError, TypeError, ValueError) as e:
                logger.debug("Failed to parse JSON: %s", e)

        # === Check for ComfyUI workflow key without prompt data ===
        if "workflow" in metadata:
            try:
                workflow = metadata["workflow"]
                if isinstance(workflow, str):
                    workflow = json.loads(workflow)
                prompt_raw = metadata.get("prompt", {})
                if isinstance(prompt_raw, str):
                    try:
                        prompt_raw = json.loads(prompt_raw)
                    except (json.JSONDecodeError, TypeError, ValueError) as e:
                        logger.debug('Failed to parse prompt in workflow path: %s', e)
                        prompt_raw = {}
                pos, neg, cp, lr, gen_params, prompt_nodes, img2img, model_assets, civitai_resources = self._extract_comfyui_data_extended(prompt_raw, workflow)
                if not pos and isinstance(workflow, dict):
                    pos, neg = self._extract_from_workflow(workflow)
                base.update({
                    "generator": "comfyui", "prompt": pos, "negative_prompt": neg,
                    "checkpoint": cp, "loras": lr, "generation_params": gen_params,
                    "prompt_nodes": prompt_nodes,
                    "model_assets": model_assets,
                })
                if civitai_resources:
                    base["civitai_resources"] = civitai_resources
                if not base["checkpoint"]:
                    workflow_assets = self._extract_comfyui_model_assets_from_workflow_widgets(workflow)
                    if workflow_assets:
                        base["model_assets"] = self._merge_model_assets(base.get("model_assets"), workflow_assets)
                        base["checkpoint"] = workflow_assets.get("primary_model_name")
                        base["loras"] = self._normalize_lora_names([
                            *(base.get("loras") or []),
                            *(workflow_assets.get("loras") or []),
                        ])
                if img2img:
                    base["is_img2img"] = True
                    base["img2img_info"] = img2img
                return base
            except Exception as e:
                logger.debug("Failed to parse ComfyUI workflow: %s", e)
                base["generator"] = "comfyui"
                return base

        # === Check for A1111 format in other EXIF fields ===
        for key in ["Parameters", "UserComment", "ImageDescription"]:
            if key in metadata:
                params = str(metadata[key])
                if params.startswith("UNICODE") or params.startswith("ASCII"):
                    params = params[7:].strip("\0 ")

                if "Steps:" in params and "Sampler:" in params:
                    prompt, neg, cp, lr, gen_params = self._parse_webui_parameters(params)
                    generator = self._detect_webui_family_generator(params, metadata, gen_params)
                    base.update({
                        "generator": generator, "prompt": prompt, "negative_prompt": neg,
                        "checkpoint": cp, "loras": lr, "generation_params": gen_params,
                    })
                    if not base["checkpoint"]:
                        base["checkpoint"] = self._extract_metadata_model_identifier(metadata)
                    base["model_assets"] = self._build_explicit_model_assets(
                        source=f"{generator}_parameters",
                        checkpoint=base["checkpoint"],
                        loras=base["loras"],
                        yolo_models=self._extract_webui_yolo_models(params, gen_params),
                    )
                    self._merge_workflow_widget_assets_into_result(base, metadata)
                    if gen_params and gen_params.get("denoising_strength") is not None:
                        base["is_img2img"] = True
                        base["img2img_info"] = {
                            "denoising_strength": gen_params["denoising_strength"],
                            "source": "img2img",
                        }
                    return base

        # === Alternate generators (Fooocus / Easy Diffusion / InvokeAI /
        # === SwarmUI / Draw Things). These run before the generic
        # === `_parse_explicit_saved_metadata` fallback so they can claim
        # === metadata that the generic path would otherwise label as
        # === "others".
        for detector in (
            self._maybe_parse_fooocus,
            self._maybe_parse_swarmui,
            self._maybe_parse_invokeai,
            self._maybe_parse_drawthings,
            self._maybe_parse_easy_diffusion,
        ):
            try:
                alt = detector(metadata)
            except Exception as exc:  # pragma: no cover — defensive
                logger.debug("alt-generator detector %s failed: %s", detector.__name__, exc)
                continue
            if alt:
                base.update({k: v for k, v in alt.items() if v is not None or k in ("prompt", "negative_prompt", "checkpoint")})
                base.setdefault("loras", alt.get("loras") or [])
                if not base.get("model_assets"):
                    base["model_assets"] = alt.get("model_assets")
                return base

        explicit_saved = self._parse_explicit_saved_metadata(metadata)
        if explicit_saved:
            base.update(explicit_saved)
            base["model_assets"] = self._build_explicit_model_assets(
                source="explicit_metadata",
                checkpoint=base["checkpoint"],
                loras=base["loras"],
            )
            if base["generator"] == "unknown":
                base["generator"] = "others"
            return base

        # === Check Software tag for generator identification ===
        if "Software" in metadata:
            software = str(metadata["Software"]).lower()
            if "novelai" in software:
                prompt = metadata.get("Description", metadata.get("ImageDescription", None))
                if prompt:
                    prompt = str(prompt)
                base.update({
                    "generator": "nai",
                    "prompt": prompt,
                    "checkpoint": self._extract_metadata_model_identifier(metadata),
                })
                base["model_assets"] = self._build_explicit_model_assets(
                    source="nai_software_tag",
                    checkpoint=base["checkpoint"],
                )
                return base
            if "comfyui" in software:
                base["generator"] = "comfyui"
                return base

        # === Closed-source AI providers (Gemini / gpt-image / DALL-E).
        ai_provider = self._maybe_detect_ai_provider(metadata, image_path=image_path, file_size=file_size)
        if ai_provider:
            base.update({k: v for k, v in ai_provider.items() if v is not None or k in ("prompt", "negative_prompt", "checkpoint")})
            base.setdefault("loras", ai_provider.get("loras") or [])
            return base

        # Has metadata but unrecognized generator → "others"
        if base["generator"] == "unknown" and any((base.get("prompt"), base.get("negative_prompt"), base.get("checkpoint"), base.get("loras"))):
            base["generator"] = "others"

        return base

    def _extract_exif_from_bytes(self, exif_bytes: bytes) -> dict:
        """Extract top-level EXIF tags from raw EXIF bytes."""
        try:
            exif = Image.Exif()
            exif.load(exif_bytes)
            return self._extract_exif_mapping(exif)
        except Exception as e:
            logger.debug("Error extracting EXIF bytes: %s", e)
            return {}

    def _extract_exif_ifd_from_bytes(self, exif_bytes: bytes) -> dict:
        """Extract EXIF IFD tags from raw EXIF bytes."""
        try:
            exif = Image.Exif()
            exif.load(exif_bytes)
            return self._extract_exif_ifd_mapping(exif)
        except Exception:
            return {}

    def _extract_sd_metadata_from_exif_bytes(self, exif_bytes: bytes) -> dict:
        """Extract SD-style metadata from raw EXIF bytes."""
        try:
            exif = Image.Exif()
            exif.load(exif_bytes)
            return self._extract_sd_metadata_from_exif(exif)
        except Exception as e:
            logger.debug("Error extracting SD metadata from EXIF bytes: %s", e)
            return {}

    def _extract_jpeg_xmp(self, image_path: str) -> dict:
        """Extract XMP metadata from JPEG APP1 segments."""
        try:
            with open(image_path, "rb") as jpeg_file:
                if jpeg_file.read(2) != JPEG_SIGNATURE:
                    return {}

                while True:
                    marker_prefix = jpeg_file.read(1)
                    if not marker_prefix:
                        break
                    if marker_prefix != b"\xff":
                        continue

                    marker = jpeg_file.read(1)
                    while marker == b"\xff":
                        marker = jpeg_file.read(1)
                    if not marker:
                        break

                    marker_code = marker[0]
                    if marker_code in {0xD8, 0xD9} or 0xD0 <= marker_code <= 0xD7:
                        continue
                    if marker_code == 0xDA:
                        break

                    length_bytes = jpeg_file.read(2)
                    if len(length_bytes) != 2:
                        break
                    segment_length = int.from_bytes(length_bytes, "big")
                    payload_length = segment_length - 2
                    if payload_length < 0 or payload_length > _MAX_JPEG_SEGMENT_BYTES:
                        break

                    payload = jpeg_file.read(payload_length)
                    if len(payload) != payload_length:
                        break
                    if not payload.startswith(b"http://ns.adobe.com/xap/1.0/\x00"):
                        continue

                    xmp_content = payload[len(b"http://ns.adobe.com/xap/1.0/\x00"):]
                    decoded_xmp = xmp_content.decode("utf-8", errors="replace")
                    return self._extract_xmp_sd_metadata(decoded_xmp)
        except Exception as e:
            logger.debug("Error extracting JPEG XMP from %s: %s", image_path, e, exc_info=True)
        return {}

    def _extract_webp_xmp(self, image_path: str) -> dict:
        """
        Extract XMP metadata from a WebP file manually by parsing chunks.
        WebP is a RIFF container, so we look for the 'XMP ' chunk.
        """
        metadata = {}
        try:
            with open(image_path, 'rb') as f:
                if f.read(4) != b"RIFF":
                    return metadata
                f.seek(4, os.SEEK_CUR)
                if f.read(4) != b"WEBP":
                    return metadata

                while True:
                    chunk_type = f.read(4)
                    if len(chunk_type) != 4:
                        break
                    size_bytes = f.read(4)
                    if len(size_bytes) != 4:
                        break
                    chunk_size = int.from_bytes(size_bytes, "little")
                    padded_size = chunk_size + (chunk_size % 2)
                    if chunk_type != b"XMP ":
                        f.seek(padded_size, os.SEEK_CUR)
                        continue
                    if chunk_size > _MAX_XMP_CHUNK_BYTES:
                        break

                    xmp_content = f.read(chunk_size)
                    try:
                        decoded_xmp = xmp_content.decode('utf-8', errors='replace')
                        metadata.update(self._extract_xmp_sd_metadata(decoded_xmp))
                    except Exception as e:
                        logger.debug("Failed to decode WebP XMP: %s", e)
                    break

        except Exception as e:
            logger.debug("Error extracting WebP XMP from %s: %s", image_path, e, exc_info=True)

        return metadata


# Singleton instance
_parser = None

def get_parser() -> MetadataParser:
    """Get the singleton parser instance."""
    global _parser
    if _parser is None:
        _parser = MetadataParser()
    return _parser


def parse_image(image_path: str, validate_image_data: bool = False) -> Dict[str, Any]:
    """Convenience function to parse a single image."""
    return get_parser().parse(image_path, validate_image_data=validate_image_data)


def verify_image_readable(image_path: str) -> Tuple[bool, Optional[str]]:
    """Confirm an image can be fully decoded, not just opened for metadata."""
    try:
        with Image.open(image_path) as img:
            img.verify()
        with Image.open(image_path) as img:
            img.load()
        return True, None
    except Exception as exc:
        return False, str(exc)
