"""The user's own VLM prompt presets (GitHub issue #21).

The built-in presets in ``vlm_providers.registry.PROMPT_PRESETS`` ship with the
program and never change at run time. Presets the user saves from the VLM
settings dialog are kept in ``CONFIG_DIR/vlm-prompt-presets.json``: they
survive updates and are shared by every library, like the VLM settings.

A file that cannot be read is never overwritten. Listing reports the problem
and every change is refused until the user repairs or removes the file, so a
damaged file never silently turns into lost presets.
"""

from __future__ import annotations

import json
import os
import re
import secrets
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Tuple

from config import CONFIG_DIR
from utils.atomic_staging import (
    create_staging_sibling,
    discard_staging_file,
    publish_staging_file,
)
from vlm_providers.registry import PROMPT_PRESETS

PRESETS_PATH: Path = Path(CONFIG_DIR) / "vlm-prompt-presets.json"

CUSTOM_ID_PREFIX = "custom-"
CUSTOM_ID_PATTERN = re.compile(r"^custom-[0-9a-f]{8,32}$")
OUTPUT_FORMATS = ("nl_caption", "danbooru_tags", "both")
PROMPT_FIELDS = ("system_prompt", "user_prompt", "user_prompt_with_tags")
FILE_VERSION = 1

_lock = threading.Lock()


class PresetError(Exception):
    """A change the store refused; carries what the API answers with."""

    status_code = 400
    code = "vlm_preset_invalid"

    def __init__(self, message: str, **params: Any) -> None:
        super().__init__(message)
        self.params = params

    def as_detail(self) -> Dict[str, Any]:
        return {"code": self.code, "message": str(self), "params": self.params}


class PresetNotFoundError(PresetError):
    status_code = 404
    code = "vlm_preset_not_found"


class PresetBuiltinError(PresetError):
    status_code = 403
    code = "vlm_preset_builtin"


class PresetNameTakenError(PresetError):
    status_code = 409
    code = "vlm_preset_name_taken"


class PresetNameRequiredError(PresetError):
    code = "vlm_preset_name_required"


class PresetFileUnreadableError(PresetError):
    status_code = 409
    code = "vlm_preset_file_unreadable"


class PresetFileBusyError(PresetError):
    status_code = 503
    code = "vlm_preset_file_busy"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _clean_name(value: Any) -> str:
    return " ".join(str(value or "").split())


def _name_key(value: str) -> str:
    return _clean_name(value).casefold()


def _clean_output_format(value: Any) -> str:
    text = str(value or "").strip()
    if text not in OUTPUT_FORMATS:
        raise PresetError(
            f"Unknown output format {text!r}; use one of {', '.join(OUTPUT_FORMATS)}.",
            output_format=text,
        )
    return text


def builtin_presets() -> Dict[str, Dict[str, Any]]:
    """The shipped presets, marked ``builtin``; copies, so callers may not edit them."""
    return {
        preset_id: {**preset, "id": preset_id, "builtin": True}
        for preset_id, preset in PROMPT_PRESETS.items()
    }


def _entry_from_file(raw: Any) -> Optional[Dict[str, Any]]:
    """One saved preset, or None when the row is not a usable preset."""
    if not isinstance(raw, Mapping):
        return None
    preset_id = str(raw.get("id") or "")
    name = _clean_name(raw.get("name"))
    if not CUSTOM_ID_PATTERN.match(preset_id) or not name:
        return None
    output_format = str(raw.get("output_format") or "nl_caption")
    if output_format not in OUTPUT_FORMATS:
        output_format = "nl_caption"
    entry: Dict[str, Any] = {
        "id": preset_id,
        "name": name,
        "output_format": output_format,
        "builtin": False,
        "created_at": str(raw.get("created_at") or ""),
        "updated_at": str(raw.get("updated_at") or ""),
    }
    for field in PROMPT_FIELDS:
        entry[field] = str(raw.get(field) or "")
    return entry


def _read_custom_presets() -> List[Dict[str, Any]]:
    """Every saved preset in the user's order. Raises on a file that cannot be read."""
    try:
        text = PRESETS_PATH.read_text(encoding="utf-8")
    except FileNotFoundError:
        return []
    except OSError as exc:
        raise PresetFileUnreadableError(
            f"Your saved prompt presets in {PRESETS_PATH.name} could not be read ({exc}).",
            file=str(PRESETS_PATH),
        ) from exc
    try:
        payload = json.loads(text) if text.strip() else {}
    except ValueError as exc:
        raise PresetFileUnreadableError(
            f"Your saved prompt presets in {PRESETS_PATH.name} are not valid JSON "
            f"(line {getattr(exc, 'lineno', '?')}). Fix or remove the file; "
            "nothing was changed.",
            file=str(PRESETS_PATH),
        ) from exc
    rows = payload.get("presets") if isinstance(payload, Mapping) else None
    if rows is None:
        return []
    if not isinstance(rows, list):
        raise PresetFileUnreadableError(
            f"Your saved prompt presets in {PRESETS_PATH.name} have an unexpected layout. "
            "Fix or remove the file; nothing was changed.",
            file=str(PRESETS_PATH),
        )
    presets: List[Dict[str, Any]] = []
    seen: set = set()
    for raw in rows:
        entry = _entry_from_file(raw)
        if entry is None or entry["id"] in seen:
            continue
        seen.add(entry["id"])
        presets.append(entry)
    return presets


def _write_custom_presets(presets: List[Dict[str, Any]]) -> None:
    rows = [
        {key: value for key, value in preset.items() if key != "builtin"}
        for preset in presets
    ]
    data = json.dumps(
        {"version": FILE_VERSION, "presets": rows}, indent=2, ensure_ascii=False
    ).encode("utf-8")
    PRESETS_PATH.parent.mkdir(parents=True, exist_ok=True)
    staging, descriptor = create_staging_sibling(PRESETS_PATH)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        publish_staging_file(staging, PRESETS_PATH)
    except PermissionError as exc:
        discard_staging_file(staging)
        raise PresetFileBusyError(
            "The prompt presets file is in use by another program, so it was not saved. "
            "Try again.",
            file=str(PRESETS_PATH),
        ) from exc
    except BaseException:
        discard_staging_file(staging)
        raise


def list_all_presets() -> Tuple[Dict[str, Dict[str, Any]], str]:
    """Built-in presets first, then the user's, plus a problem message ("" when fine).

    An unreadable file still lists the built-in presets, so captioning keeps
    working while the problem is shown.
    """
    presets = builtin_presets()
    try:
        custom = _read_custom_presets()
    except PresetFileUnreadableError as exc:
        return presets, str(exc)
    for entry in custom:
        presets[entry["id"]] = entry
    return presets, ""


def _assert_name_free(
    presets: List[Dict[str, Any]], name: str, *, ignore_id: str = ""
) -> None:
    key = _name_key(name)
    for preset in presets:
        if preset["id"] != ignore_id and _name_key(preset["name"]) == key:
            raise PresetNameTakenError(
                f"You already have a preset called {preset['name']!r}.",
                name=preset["name"],
                existing_id=preset["id"],
            )


def _new_id(taken: set) -> str:
    while True:
        candidate = f"{CUSTOM_ID_PREFIX}{secrets.token_hex(4)}"
        if candidate not in taken:
            return candidate


def _apply_fields(entry: Dict[str, Any], fields: Mapping[str, Any]) -> None:
    for field in PROMPT_FIELDS:
        if fields.get(field) is not None:
            entry[field] = str(fields[field])
    if fields.get("output_format") is not None:
        entry["output_format"] = _clean_output_format(fields["output_format"])


def create_preset(
    name: str, fields: Mapping[str, Any], *, preset_id: Optional[str] = None
) -> Dict[str, Any]:
    """Save a new preset at the end of the list.

    ``preset_id`` brings back a preset that was just deleted (the dialog's
    Undo), keeping its id; an id already in use is refused.
    """
    clean = _clean_name(name)
    if not clean:
        raise PresetNameRequiredError("Give the preset a name.")
    if preset_id in PROMPT_PRESETS:
        raise PresetBuiltinError(
            "That is the id of a built-in preset.", preset_id=preset_id
        )
    if preset_id is not None and not CUSTOM_ID_PATTERN.match(preset_id):
        raise PresetError("That is not a preset id.", preset_id=preset_id)
    with _lock:
        presets = _read_custom_presets()
        _assert_name_free(presets, clean)
        taken = {preset["id"] for preset in presets}
        if preset_id in taken:
            raise PresetError(
                "A preset with that id already exists.", preset_id=preset_id
            )
        now = _now_iso()
        entry: Dict[str, Any] = {
            "id": preset_id or _new_id(taken),
            "name": clean,
            "output_format": "nl_caption",
            "builtin": False,
            "created_at": now,
            "updated_at": now,
        }
        for field in PROMPT_FIELDS:
            entry[field] = ""
        _apply_fields(entry, fields)
        presets.append(entry)
        _write_custom_presets(presets)
        return dict(entry)


def _find_custom(presets: List[Dict[str, Any]], preset_id: str) -> Dict[str, Any]:
    if preset_id in PROMPT_PRESETS:
        raise PresetBuiltinError(
            "Built-in presets cannot be changed. Save your prompts as a new preset instead.",
            preset_id=preset_id,
        )
    for preset in presets:
        if preset["id"] == preset_id:
            return preset
    raise PresetNotFoundError("That preset no longer exists.", preset_id=preset_id)


def update_preset(
    preset_id: str, *, name: Optional[str] = None, fields: Mapping[str, Any]
) -> Dict[str, Any]:
    """Rename a saved preset and/or replace its prompts; omitted values stay."""
    with _lock:
        presets = _read_custom_presets()
        entry = _find_custom(presets, preset_id)
        if name is not None:
            clean = _clean_name(name)
            if not clean:
                raise PresetNameRequiredError("Give the preset a name.")
            _assert_name_free(presets, clean, ignore_id=preset_id)
            entry["name"] = clean
        _apply_fields(entry, fields)
        entry["updated_at"] = _now_iso()
        _write_custom_presets(presets)
        return dict(entry)


def delete_preset(preset_id: str) -> Dict[str, Any]:
    """Remove a saved preset and return it, so the dialog can offer Undo."""
    with _lock:
        presets = _read_custom_presets()
        entry = _find_custom(presets, preset_id)
        remaining = [preset for preset in presets if preset["id"] != preset_id]
        _write_custom_presets(remaining)
        return dict(entry)
