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
from dataclasses import dataclass, field
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


_ENTRY_FIELDS = (
    "id",
    "name",
    "output_format",
    "created_at",
    "updated_at",
    *PROMPT_FIELDS,
)


@dataclass
class _Store:
    """The presets file as read: what the dialog uses, and what it must keep.

    ``kept_rows`` are rows this version cannot use (hand edits, a damaged row)
    and ``top`` holds top-level keys other than ``presets``; both are written
    back unchanged, so saving one preset never loses anything else in the file.
    """

    presets: List[Dict[str, Any]] = field(default_factory=list)
    kept_rows: List[Any] = field(default_factory=list)
    top: Dict[str, Any] = field(default_factory=dict)


def _unreadable(reason: str) -> PresetFileUnreadableError:
    return PresetFileUnreadableError(
        f"Your saved prompt presets in {PRESETS_PATH.name} {reason} "
        "Fix or remove the file; nothing was changed.",
        file=str(PRESETS_PATH),
    )


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
    for prompt_field in PROMPT_FIELDS:
        entry[prompt_field] = str(raw.get(prompt_field) or "")
    extra = {key: value for key, value in raw.items() if key not in _ENTRY_FIELDS}
    if extra:
        entry["_extra"] = extra
    return entry


def _public(entry: Mapping[str, Any]) -> Dict[str, Any]:
    return {key: value for key, value in entry.items() if key != "_extra"}


def _read_store() -> _Store:
    """The presets file. Raises when it cannot be read or has an unknown layout."""
    try:
        text = PRESETS_PATH.read_text(encoding="utf-8")
    except FileNotFoundError:
        return _Store()
    except OSError as exc:
        raise _unreadable(f"could not be read ({exc}).") from exc
    try:
        payload = json.loads(text) if text.strip() else {}
    except ValueError as exc:
        raise _unreadable(
            f"are not valid JSON (line {getattr(exc, 'lineno', '?')})."
        ) from exc
    if not isinstance(payload, dict):
        raise _unreadable("have an unexpected layout.")
    version = payload.get("version", FILE_VERSION)
    if not isinstance(version, int) or version > FILE_VERSION:
        raise _unreadable("were saved by a newer version of the program.")
    rows = payload.get("presets", [])
    if not isinstance(rows, list):
        raise _unreadable("have an unexpected layout.")
    store = _Store(
        top={key: value for key, value in payload.items() if key != "presets"}
    )
    seen: set = set()
    for raw in rows:
        entry = _entry_from_file(raw)
        if entry is None or entry["id"] in seen:
            store.kept_rows.append(raw)
            continue
        seen.add(entry["id"])
        store.presets.append(entry)
    return store


def _read_custom_presets() -> List[Dict[str, Any]]:
    """Every saved preset in the user's order. Raises on a file that cannot be read."""
    return [_public(entry) for entry in _read_store().presets]


def _write_store(store: _Store) -> None:
    rows = [
        {
            **preset.get("_extra", {}),
            **{key: preset[key] for key in _ENTRY_FIELDS if key in preset},
        }
        for preset in store.presets
    ]
    payload = {**store.top, "version": FILE_VERSION, "presets": rows + store.kept_rows}
    data = json.dumps(payload, indent=2, ensure_ascii=False).encode("utf-8")
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
    for prompt_field in PROMPT_FIELDS:
        if fields.get(prompt_field) is not None:
            entry[prompt_field] = str(fields[prompt_field])
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
        store = _read_store()
        presets = store.presets
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
        for prompt_field in PROMPT_FIELDS:
            entry[prompt_field] = ""
        _apply_fields(entry, fields)
        presets.append(entry)
        _write_store(store)
        return _public(entry)


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
        store = _read_store()
        presets = store.presets
        entry = _find_custom(presets, preset_id)
        if name is not None:
            clean = _clean_name(name)
            if not clean:
                raise PresetNameRequiredError("Give the preset a name.")
            _assert_name_free(presets, clean, ignore_id=preset_id)
            entry["name"] = clean
        _apply_fields(entry, fields)
        entry["updated_at"] = _now_iso()
        _write_store(store)
        return _public(entry)


def delete_preset(preset_id: str) -> Dict[str, Any]:
    """Remove a saved preset and return it, so the dialog can offer Undo."""
    with _lock:
        store = _read_store()
        entry = _find_custom(store.presets, preset_id)
        store.presets = [preset for preset in store.presets if preset["id"] != preset_id]
        _write_store(store)
        return _public(entry)
