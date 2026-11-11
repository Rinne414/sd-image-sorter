"""The pose and camera-angle tags a library has: the list behind "find by pose or angle".

People ask every image tool for a search by pose or by camera angle, and no
model does that well on drawn pictures. The tagger already says it in words,
though: ``from_above``, ``cowboy_shot``, ``sitting``, ``arms_up``. So the
chooser is the library's own tags of those two kinds, most used first, each
with how many pictures carry it.

Its honesty has two parts, both returned here for the page to say: it only
knows pictures that were tagged (``untagged`` are invisible to it), and it is
as right as the tagger was.
"""

from __future__ import annotations

import re
from typing import Any, Dict, List

import database as db
import library_context
from services import tag_suggest_service
from tag_rules import categorize_tag

# Where the camera is and what the frame cuts, beyond the tags the categoriser
# files under "angle": the direction of the gaze and what is left out of frame.
_EXTRA_VIEW = frozenset(
    {
        "looking_at_viewer",
        "looking_back",
        "looking_away",
        "looking_up",
        "looking_down",
        "looking_to_the_side",
        "head_out_of_frame",
        "feet_out_of_frame",
        "multiple_views",
        "sideways",
    }
)


def _group_of(tag: str) -> str:
    name = tag.strip().lower().replace(" ", "_")
    if name in _EXTRA_VIEW:
        return "view"
    category = categorize_tag(name)
    return {"angle": "view", "pose": "pose"}.get(category, "")


def _untagged_pictures() -> int:
    lib_sql, lib_params = library_context.current_library_sql()
    conn = db.get_connection()
    try:
        row = conn.execute(
            "SELECT COUNT(*) FROM images WHERE tagged_at IS NULL AND COALESCE(is_readable, 1) = 1 "
            f"AND media_type = 'image' AND {lib_sql}",
            lib_params,
        ).fetchone()
    finally:
        conn.close()
    return int(row[0] or 0)


_KANA = re.compile("[぀-ヿ]")


def _chinese_names() -> Dict[str, str]:
    """Tag -> a name to show: the first of its names written without kana, else the first."""
    tag_suggest_service._ensure_loaded()
    names: Dict[str, str] = {}
    for all_names, tag, _count, _code in tag_suggest_service._ZH_BLOBS or []:
        options = [name.strip() for name in all_names.split(",") if name.strip()]
        if tag in names or not options:
            continue
        names[tag] = next(
            (name for name in options if not _KANA.search(name)), options[0]
        )
    return names


def library_pose_and_view() -> Dict[str, Any]:
    """``{view, pose, untagged}``: each tag with its picture count and its Chinese name when known."""
    names = _chinese_names()
    groups: Dict[str, List[Dict[str, Any]]] = {"view": [], "pose": []}
    for row in db.search_tags(None, sort_by="frequency", limit=None).get("tags", []):
        tag = str(row.get("tag") or "")
        group = _group_of(tag)
        if not group:
            continue
        key = tag.strip().lower().replace(" ", "_")
        groups[group].append(
            {"tag": tag, "count": int(row.get("count") or 0), "name": names.get(key)}
        )
    return {**groups, "untagged": _untagged_pictures()}
