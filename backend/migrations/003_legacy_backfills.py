from __future__ import annotations

import json
import re
import sqlite3

from migrations._schema_common import table_exists


VERSION = 3
NAME = "legacy_backfills"


def _normalize_lora_name_v1(lora_name: str) -> str:
    """Migration-frozen LoRA name normalizer used by v3 backfill."""
    if ':' in lora_name:
        parts = lora_name.rsplit(':', 1)
        try:
            float(parts[1])
            lora_name = parts[0]
        except ValueError:
            pass

    lora_name = lora_name.replace('\\', '/').rsplit('/', 1)[-1]

    for extension in ('.safetensors', '.ckpt', '.pt', '.pth', '.bin'):
        if lora_name.lower().endswith(extension):
            lora_name = lora_name[:-len(extension)]
            break

    return lora_name.lower().strip()


def _extract_lora_names_v1(loras_json: str, prompt: str) -> set[str]:
    """Migration-frozen LoRA extractor used by v3 backfill."""
    loras: set[str] = set()

    if loras_json:
        try:
            loras_list = json.loads(loras_json)
        except (json.JSONDecodeError, TypeError):
            loras_list = []

        if isinstance(loras_list, list):
            for lora_name in loras_list:
                if isinstance(lora_name, str) and len(lora_name) > 2:
                    normalized = _normalize_lora_name_v1(lora_name)
                    if normalized and len(normalized) > 2:
                        loras.add(normalized)

    if prompt:
        for lora_name in re.findall(r'<lora:([^:>]+)(?::[^>]+)?>', prompt, re.IGNORECASE):
            if lora_name and len(lora_name) > 2:
                normalized = _normalize_lora_name_v1(lora_name)
                if normalized and len(normalized) > 2:
                    loras.add(normalized)

    return loras


def apply(conn: sqlite3.Connection) -> None:
    """
    Backfill legacy defaults and normalize derived lookup tables once per DB.
    """
    if not table_exists(conn, "images"):
        return

    conn.execute("UPDATE images SET is_readable = 1 WHERE is_readable IS NULL")
    conn.execute("UPDATE images SET metadata_status = 'complete' WHERE metadata_status IS NULL")

    if not table_exists(conn, "image_loras"):
        return

    rows = conn.execute(
        "SELECT id, loras, prompt FROM images WHERE loras IS NOT NULL OR prompt LIKE '%<lora:%'"
    ).fetchall()
    for row in rows:
        for lora_name in _extract_lora_names_v1(row[1] or "", row[2] or ""):
            conn.execute(
                "INSERT OR IGNORE INTO image_loras (image_id, lora_name) VALUES (?, ?)",
                (row[0], lora_name),
            )
