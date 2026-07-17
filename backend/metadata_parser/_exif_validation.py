# =============================================================================
# metadata_parser._exif_validation - _runtime regrowth split (2026-07-18).
# Extracted VERBATIM from metadata_parser/_runtime.py @ d4a1b50 (914 lines),
# source lines 46-170: the pure TIFF/EXIF structural validator
# _validate_webp_exif_payload plus its private _TIFF_* / _MAX_TIFF_* lookup
# tables. AST-verified seam-free: it reads NONE of the four monkeypatched
# package globals (Image / open / _MAX_DECOMPRESSED_BYTES /
# _MAX_SIDECAR_DIRECTORY_CACHE_FILENAMES); its only module-global reads are
# the co-moved tables plus struct and typing names. _runtime.py re-imports
# _validate_webp_exif_payload, so the package proxy's GET fallthrough and
# SET/DEL routing for that name keep resolving in _runtime, where its sole
# reader (_parse_webp_exif_chunk) lives.
import struct
from typing import Optional, Set


_TIFF_FIELD_UNIT_BYTES = {
    1: 1,   # BYTE
    2: 1,   # ASCII
    3: 2,   # SHORT
    4: 4,   # LONG
    5: 8,   # RATIONAL
    6: 1,   # SBYTE
    7: 1,   # UNDEFINED
    8: 2,   # SSHORT
    9: 4,   # SLONG
    10: 8,  # SRATIONAL
    11: 4,  # FLOAT
    12: 8,  # DOUBLE
    13: 4,  # IFD
}
_TIFF_IFD_POINTER_TAGS = {0x014A, 0x8769, 0x8825, 0xA005}
_MAX_TIFF_IFD_DEPTH = 8
_MAX_TIFF_POINTER_COUNT = 1024


def _validate_webp_exif_payload(exif_bytes: bytes) -> Optional[str]:
    """Return a structural EXIF error without mutating global warning state."""
    payload = exif_bytes
    while payload.startswith(b"Exif\x00\x00"):
        payload = payload[6:]

    if len(payload) < 8:
        return f"not a TIFF file (payload is only {len(payload)} bytes)"
    if payload[:2] == b"II":
        byte_order = "<"
    elif payload[:2] == b"MM":
        byte_order = ">"
    else:
        return f"not a TIFF file (invalid byte-order marker {payload[:2]!r})"
    if struct.unpack_from(f"{byte_order}H", payload, 2)[0] != 42:
        return "not a TIFF file (invalid TIFF magic)"

    def read_u16(offset: int) -> int:
        return struct.unpack_from(f"{byte_order}H", payload, offset)[0]

    def read_u32(offset: int) -> int:
        return struct.unpack_from(f"{byte_order}I", payload, offset)[0]

    active_offsets: Set[int] = set()
    validated_offsets: Set[int] = set()

    def validate_ifd(offset: int, label: str, depth: int) -> Optional[str]:
        if offset in validated_offsets:
            return None
        if offset in active_offsets:
            return f"{label} contains a cyclic IFD reference at offset {offset}"
        if depth > _MAX_TIFF_IFD_DEPTH:
            return f"{label} exceeds the {_MAX_TIFF_IFD_DEPTH}-level IFD depth limit"
        if offset < 8 or offset + 2 > len(payload):
            return f"{label} offset {offset} is outside the {len(payload)}-byte payload"

        entry_count = read_u16(offset)
        table_bytes = 2 + (entry_count * 12) + 4
        if table_bytes > len(payload) - offset:
            return (
                f"{label} table needs {table_bytes} bytes at offset {offset}, "
                f"but only {len(payload) - offset} remain"
            )

        active_offsets.add(offset)
        for index in range(entry_count):
            entry_offset = offset + 2 + (index * 12)
            tag = read_u16(entry_offset)
            field_type = read_u16(entry_offset + 2)
            value_count = read_u32(entry_offset + 4)
            unit_bytes = _TIFF_FIELD_UNIT_BYTES.get(field_type)
            value_offset = entry_offset + 8

            if unit_bytes is not None:
                value_bytes = value_count * unit_bytes
                if value_bytes > 4:
                    value_offset = read_u32(entry_offset + 8)
                    if value_offset < 8 or value_bytes > len(payload) - value_offset:
                        active_offsets.remove(offset)
                        return (
                            f"{label} tag 0x{tag:04x} data range "
                            f"{value_offset}:{value_offset + value_bytes} is outside "
                            f"the {len(payload)}-byte payload"
                        )

            if tag not in _TIFF_IFD_POINTER_TAGS or value_count == 0:
                continue
            if field_type not in {4, 13}:
                active_offsets.remove(offset)
                return f"{label} tag 0x{tag:04x} has invalid IFD pointer type {field_type}"
            if value_count > _MAX_TIFF_POINTER_COUNT:
                active_offsets.remove(offset)
                return (
                    f"{label} tag 0x{tag:04x} has {value_count} IFD pointers; "
                    f"limit is {_MAX_TIFF_POINTER_COUNT}"
                )

            for pointer_index in range(value_count):
                child_offset = read_u32(value_offset + (pointer_index * 4))
                if child_offset == 0:
                    continue
                child_error = validate_ifd(
                    child_offset,
                    f"EXIF IFD 0x{tag:04x}",
                    depth + 1,
                )
                if child_error is not None:
                    active_offsets.remove(offset)
                    return child_error

        next_ifd_offset = read_u32(offset + 2 + (entry_count * 12))
        if next_ifd_offset != 0:
            next_error = validate_ifd(next_ifd_offset, "EXIF next IFD", depth + 1)
            if next_error is not None:
                active_offsets.remove(offset)
                return next_error

        active_offsets.remove(offset)
        validated_offsets.add(offset)
        return None

    first_ifd_offset = read_u32(4)
    if first_ifd_offset == 0:
        return "EXIF IFD0 offset is zero"
    return validate_ifd(first_ifd_offset, "EXIF IFD0", 0)
