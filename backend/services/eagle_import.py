"""Bring an Eagle library into the open library, in place.

The pictures stay where Eagle keeps them (``images/<ID>.info/``): they are
indexed there, never copied. What the user gave each item in Eagle comes over:

- ``star``       -> the user's stars, unless the picture already has some here;
- ``annotation`` -> the note, unless the picture already has one here;
- ``tags``       -> added as the user's own tags (kept when a tagger runs again);
- ``folders``    -> collections of the same names, nested the same way; a
  collection that already exists with that name in that place is reused;
- ``url``        -> the source page, unless one is already recorded.

Nothing a picture already has here is overwritten, so running the import twice
adds nothing the second time. Eagle's own thumbnails are not indexed.

``services/eagle_library.py`` does the reading; this module only writes into
this program's database.
"""

from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

from services import eagle_library

WRITE_BATCH = 500
# Brought-over tags are the user's own: they carry no model confidence.
USER_TAG_CONFIDENCE = 1.0

Progress = Callable[[str, int, int], None]


def _collection_ids_by_place() -> Dict[Tuple[Optional[int], str], int]:
    """(parent id, lower-case name) -> collection id, for the open library."""
    import database as db

    return {
        (row.get("parent_id"), str(row.get("name") or "").strip().lower()): int(
            row["id"]
        )
        for row in db.list_collections()
        if row.get("slug") != "favorites"
    }


def _collection_for(
    names: Sequence[str],
    known: Dict[Tuple[Optional[int], str], int],
    created: List[int],
) -> int:
    """The collection for a folder path, creating the levels that are missing."""
    import database as db

    parent: Optional[int] = None
    for name in names:
        key = (parent, name.strip().lower())
        if key not in known:
            row = db.create_collection(name, parent_id=parent)
            known[key] = int(row["id"])
            created.append(known[key])
        parent = known[key]
    assert (
        parent is not None
    )  # names is never empty: a folder path has at least its own name
    return parent


def _add_user_tags(image_ids_tags: Dict[int, Tuple[str, ...]]) -> int:
    """Append tags as the user's own, keeping every tag a picture already has."""
    import database as db

    added = 0
    ids = list(image_ids_tags)
    for start in range(0, len(ids), WRITE_BATCH):
        chunk = ids[start : start + WRITE_BATCH]
        existing_by_image = db.get_image_tags_map(chunk)
        for image_id in chunk:
            existing = existing_by_image.get(image_id) or []
            have = {str(row.get("tag") or "").lower() for row in existing}
            new = [tag for tag in image_ids_tags[image_id] if tag.lower() not in have]
            if not new:
                continue
            merged = [
                {
                    "tag": str(row.get("tag") or ""),
                    "confidence": row.get("confidence"),
                    "source": row.get("source"),
                    "category": row.get("category"),
                }
                for row in existing
                if row.get("tag")
            ] + [
                {
                    "tag": tag,
                    "confidence": USER_TAG_CONFIDENCE,
                    "source": "manual",
                    "category": None,
                }
                for tag in new
            ]
            db.add_tags(image_id, merged)
            added += len(new)
    return added


def run_import(
    folder: str,
    *,
    progress: Optional[Progress] = None,
) -> Dict[str, Any]:
    """Index the Eagle library's pictures in place and bring their user data over."""
    import database as db
    from db_collected_sources import get_collected_source, record_collected_source
    from image_manager import scan_folder

    def tell(step: str, current: int, total: int) -> None:
        if progress is not None:
            progress(step, current, total)

    root = eagle_library.resolve_library_root(folder)
    summary = eagle_library.EagleSummary()
    items = list(eagle_library.iter_items(root, summary))
    total = len(items)
    tell("index", 0, total)
    scan_folder(
        str(root / eagle_library.ITEMS_DIRNAME),
        recursive=True,
        quick_import=True,
        precise_total=False,
        only_paths=[str(item.file_path) for item in items],
        progress_callback=lambda current, *_rest: tell("index", int(current), total),
    )

    result = {
        "library": str(root),
        "name": root.name,
        "found": summary.as_dict(),
        "indexed": 0,
        "not_indexed": 0,
        "stars_set": 0,
        "notes_set": 0,
        "tags_added": 0,
        "sources_set": 0,
        "collections_created": 0,
        "collection_memberships": 0,
    }
    known_collections = _collection_ids_by_place()
    created_collections: List[int] = []
    members: Dict[int, List[int]] = {}
    tags_by_image: Dict[int, Tuple[str, ...]] = {}
    now = datetime.now().isoformat(timespec="seconds")

    for position, item in enumerate(items, start=1):
        row = db.get_image_by_path(str(Path(item.file_path)), current_library_only=True)
        if not row:
            # Not a picture this program reads (an unsupported type), or it vanished meanwhile.
            result["not_indexed"] += 1
            continue
        image_id = int(row["id"])
        result["indexed"] += 1
        if item.star and not int(row.get("user_rating") or 0):
            result["stars_set"] += bool(db.set_user_rating(image_id, item.star))
        if item.annotation and not str(row.get("note") or "").strip():
            result["notes_set"] += bool(db.set_image_note(image_id, item.annotation))
        if item.tags:
            tags_by_image[image_id] = item.tags
        if item.url and get_collected_source(image_id) is None:
            record_collected_source(
                image_id,
                source_url=None,
                page_url=item.url,
                page_title=None,
                collected_at=now,
                via="url",
            )
            result["sources_set"] += 1
        for folder_names in item.folders:
            collection_id = _collection_for(
                folder_names, known_collections, created_collections
            )
            members.setdefault(collection_id, []).append(image_id)
        if position % 50 == 0 or position == total:
            tell("details", position, total)

    result["tags_added"] = _add_user_tags(tags_by_image)
    for collection_id, image_ids in members.items():
        result["collection_memberships"] += int(
            db.set_collection_membership_bulk(collection_id, image_ids, True) or 0
        )
    result["collections_created"] = len(created_collections)
    tell("done", total, total)
    return result
