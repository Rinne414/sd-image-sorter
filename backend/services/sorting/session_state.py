"""Sort-session state coercion + persisted-session restore.

Moved verbatim from services/sorting_service.py (decomposition 2026-07).
The session-FILE path constants (SESSION_FILE / LEGACY_SESSION_FILE) are
patched seams, so their reader (_get_session_file_candidates) and the
sorting_session_store delegators stay on the facade (contract #2); this
module reaches them via ``self``.
"""

import json
import logging
from typing import Any, Dict, List, Optional

from fastapi import HTTPException
from pydantic import ValidationError

import database as db
from services.sorting_models import (
    FOLDER_KEY_MAX_LENGTH,
    FolderConfig,
    SORT_MODE_DEFAULT,
    VALID_SORT_MODES,
)
from services.sorting_session_store import (
    SORT_SESSION_SCHEMA_VERSION,
    read_persisted_session,
)
from utils.path_validation import normalize_user_path, validate_folder_path

# NOTE(decomposition): keep the historical logger channel — tests attach
# handlers / caplog filters to "services.sorting_service" (heartbeat pins),
# and log routing/output must stay byte-identical after the package split.
logger = logging.getLogger("services.sorting_service")


class SessionStateMixin:
    """Session-coercion slice of SortingService (assembled in services/sorting_service.py)."""

    def _get_sort_history_counts(self, history: Optional[List[Dict[str, Any]]] = None) -> Dict[str, int]:
        """Summarize move/skip counts from the current manual-sort history."""
        active_history = history if history is not None else self._sort_session.get("history", [])
        sorted_count = sum(1 for item in active_history if item.get("action") == "move")
        skipped_count = sum(1 for item in active_history if item.get("action") == "skip")
        collected_count = sum(1 for item in active_history if item.get("action") == "collect")
        return {
            "sorted_count": sorted_count,
            "skipped_count": skipped_count,
            "collected_count": collected_count,
        }

    def _get_sort_session_flags(
        self,
        history: Optional[List[Dict[str, Any]]] = None,
        redo_stack: Optional[List[Dict[str, Any]]] = None,
    ) -> Dict[str, Any]:
        """Expose undo/redo availability alongside move/skip counters."""
        active_history = history if history is not None else self._sort_session.get("history", [])
        active_redo = redo_stack if redo_stack is not None else self._sort_session.get("redo_stack", [])
        return {
            **self._get_sort_history_counts(active_history),
            "undo_available": bool(active_history),
            "redo_available": bool(active_redo),
        }

    def _filter_sort_actions(
        self,
        actions: Optional[List[Dict[str, Any]]],
        valid_image_ids: set[int],
    ) -> List[Dict[str, Any]]:
        """Drop persisted sort actions that point at images no longer in the database."""
        filtered: List[Dict[str, Any]] = []
        for entry in actions or []:
            image_id = entry.get("image_id")
            if image_id in valid_image_ids:
                filtered.append(entry)
        return filtered

    @staticmethod
    def _coerce_sort_filter_values(values: Optional[Any]) -> Optional[List[str]]:
        if values is None:
            return None
        if isinstance(values, str):
            raw_values = values.split(",")
        elif isinstance(values, (list, tuple, set)):
            raw_values = values
        else:
            raw_values = [values]
        normalized = [str(value).strip() for value in raw_values if str(value).strip()]
        return normalized or None

    def _parse_sort_folders(self, folders: Optional[Any]) -> Dict[str, str]:
        """Parse and validate manual-sort folder config from JSON body or legacy query params."""
        if not folders:
            return {}

        if isinstance(folders, dict):
            raw_config = folders
        else:
            try:
                raw_config = json.loads(folders)
            except (TypeError, ValueError) as exc:
                raise HTTPException(status_code=400, detail="Invalid folders payload") from exc

        if not isinstance(raw_config, dict):
            raise HTTPException(status_code=400, detail="Invalid folders payload")

        try:
            config = FolderConfig(folders=raw_config)
        except ValidationError as exc:
            raise HTTPException(status_code=400, detail="Invalid folders payload") from exc

        validated_folders = {}
        for key, path in config.folders.items():
            if not path:
                continue
            normalized_path = normalize_user_path(path)
            is_valid, error = validate_folder_path(normalized_path, allow_create=True)
            if not is_valid:
                raise HTTPException(status_code=400, detail=error or f"Invalid folder path for key '{key}'")
            validated_folders[key] = normalized_path

        return validated_folders

    def _coerce_scan_progress_state(self, state: Optional[Dict[str, Any]]) -> Dict[str, Any]:
        """Normalize externally injected scan-progress state onto the canonical shape."""
        coerced = self._build_default_scan_progress_state()
        if state:
            coerced.update(state)
        return coerced

    @staticmethod
    def _coerce_collection_slots(slots: Optional[Any]) -> Dict[str, Optional[int]]:
        """Normalize a per-slot collection mapping to ``{key: int|None}``.

        v3.3.1: accepts the JSON/dict form the frontend sends. Non-int / blank
        / 0 / negative values collapse to ``None`` (a normal folder slot). Slot
        keys are bounded by ``FOLDER_KEY_MAX_LENGTH`` to match folder configs.
        """
        if not isinstance(slots, dict):
            return {}
        normalized: Dict[str, Optional[int]] = {}
        for key, value in slots.items():
            key_str = str(key)
            if not key_str or len(key_str) > FOLDER_KEY_MAX_LENGTH:
                continue
            if value is None or value == "":
                normalized[key_str] = None
                continue
            try:
                collection_id = int(value)
            except (TypeError, ValueError):
                normalized[key_str] = None
                continue
            normalized[key_str] = collection_id if collection_id > 0 else None
        return normalized

    def _coerce_sort_session_state(self, session: Optional[Dict[str, Any]]) -> Dict[str, Any]:
        """Normalize externally injected sort-session state onto the canonical shape."""
        coerced = self._build_default_sort_session_state()
        session = session or {}
        coerced["active"] = bool(session.get("active", False))
        # Unknown / missing mode (e.g. a session persisted before v3.3.2) falls
        # back to "slot" so old files load without a schema-version bump.
        requested_mode = session.get("mode", SORT_MODE_DEFAULT)
        coerced["mode"] = requested_mode if requested_mode in VALID_SORT_MODES else SORT_MODE_DEFAULT
        coerced["image_ids"] = list(session.get("image_ids", []))
        coerced["folders"] = dict(session.get("folders", {}))
        coerced["collection_slots"] = self._coerce_collection_slots(session.get("collection_slots"))
        coerced["history"] = list(session.get("history", []))
        coerced["redo_stack"] = list(session.get("redo_stack", []))
        coerced["operation_mode"] = self._validate_file_operation(session.get("operation_mode", "move"))

        try:
            current_index = int(session.get("current_index", 0) or 0)
        except (TypeError, ValueError):
            current_index = 0
        coerced["current_index"] = max(0, min(current_index, len(coerced["image_ids"])))

        # WB-S2 bracket champion pointer: clamp into the candidate range.
        try:
            champion_index = int(session.get("champion_index", 0) or 0)
        except (TypeError, ValueError):
            champion_index = 0
        coerced["champion_index"] = max(0, min(champion_index, max(0, len(coerced["image_ids"]) - 1)))
        return coerced

    def load_session_from_disk(self) -> None:
        """Load persisted session from disk on startup."""
        try:
            for session_file in self._get_session_file_candidates():
                if not session_file.exists():
                    continue
                try:
                    data = read_persisted_session(session_file)

                    try:
                        session_version = self._parse_persisted_session_version(data)
                    except ValueError as exc:
                        self._discard_persisted_session_file(str(exc), paths=[session_file])
                        continue

                    if session_version not in {0, SORT_SESSION_SCHEMA_VERSION}:
                        self._discard_persisted_session_file(
                            f"unsupported session_schema_version={session_version} (current={SORT_SESSION_SCHEMA_VERSION})",
                            paths=[session_file],
                        )
                        continue

                    if not data.get('active'):
                        return

                    # Batch validate image IDs in a single query (N+1 fix)
                    image_ids = data.get('image_ids', [])
                    if image_ids:
                        with db.get_db() as conn:
                            cursor = conn.cursor()
                            placeholders = ','.join(['?' for _ in image_ids])
                            cursor.execute(f"SELECT id FROM images WHERE id IN ({placeholders})", image_ids)
                            valid_set = {row[0] for row in cursor.fetchall()}
                        valid_ids = [iid for iid in image_ids if iid in valid_set]
                    else:
                        valid_ids = []

                    if not valid_ids:
                        try:
                            session_file.unlink()
                        except OSError:
                            pass
                        return

                    original_index = data.get('current_index', 0)
                    try:
                        original_index = int(original_index)
                    except (TypeError, ValueError):
                        original_index = 0
                    original_index = max(0, min(original_index, len(image_ids)))

                    original_positions = {image_id: index for index, image_id in enumerate(image_ids)}
                    restored_history = self._filter_sort_actions(data.get('history', []), valid_set)
                    restored_redo_stack = self._filter_sort_actions(data.get('redo_stack', []), valid_set)
                    history_image_ids = {entry.get('image_id') for entry in restored_history}
                    restored_redo_stack = [
                        entry for entry in restored_redo_stack
                        if entry.get('image_id') not in history_image_ids
                    ]
                    restored_index = sum(1 for iid in image_ids[:original_index] if iid in valid_set)
                    restored_history = [
                        entry for entry in restored_history
                        if original_positions.get(entry.get('image_id'), len(image_ids)) < original_index
                    ]
                    restored_redo_stack = [
                        entry for entry in restored_redo_stack
                        if original_positions.get(entry.get('image_id'), -1) >= original_index
                    ]
                    restored_index = min(len(valid_ids), restored_index)
                    operation_mode = self._validate_file_operation(data.get('operation_mode', 'move'))

                    # Validate all folder paths loaded from JSON
                    validated_folders = {}
                    for key, path in data.get('folders', {}).items():
                        try:
                            normalized_path = normalize_user_path(path)
                            is_valid, _error = validate_folder_path(normalized_path, allow_create=True)
                            if is_valid:
                                validated_folders[key] = normalized_path
                            else:
                                logger.warning("Skipping invalid folder path for key %s", key)
                        except Exception:
                            logger.warning("Skipping invalid folder path for key %s", key)

                    with self._sort_session_lock:
                        self._sort_session = self._coerce_sort_session_state({
                            'active': True,
                            'image_ids': valid_ids,
                            'current_index': restored_index,
                            'folders': validated_folders,
                            # v3.3.1: restore per-slot collection mapping.
                            # Missing in legacy v0 files -> coerces to {}.
                            'collection_slots': data.get('collection_slots'),
                            'operation_mode': operation_mode,
                            'history': restored_history,
                            'redo_stack': restored_redo_stack,
                        })
                        self._save_session_to_disk()
                        preferred_session_file = self._get_session_file_candidates()[0]
                        if session_file != preferred_session_file and session_file.exists():
                            try:
                                session_file.unlink()
                            except OSError as exc:
                                logger.warning("Failed to remove legacy sort session file %s: %s", session_file, exc)
                    logger.info("Restored session: %d images", len(valid_ids))
                    return
                except Exception as e:
                    logger.warning("Failed to restore session from %s: %s", session_file, e)
        except Exception as e:
            logger.warning("Failed to restore session: %s", e)
