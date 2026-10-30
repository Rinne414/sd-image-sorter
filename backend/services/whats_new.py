"""What changed in the running version, for a one-time notice after an update.

Every package carries the release notes of its own version as
``release-notes.md`` at its root. They open with a title line and a short
bilingual summary (Chinese first) before the first ``---`` (the release SOP
keeps it under 200 characters for the in-app update popup). That summary is
what the page shows once after the program was updated.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Callable

from app_info import GITHUB_REPOSITORY_URL

NOTES_NAME = "release-notes.md"
STATE_NAME = "last-run-version.json"
_CJK = re.compile(r"[一-鿿]")


def _summary(text: str, version: str) -> dict[str, str] | None:
    lines = text.replace("\r\n", "\n").split("\n")
    head = lines[0].strip() if lines else ""
    # The notes belong to this version, or they say nothing about it.
    if not re.match(rf"^##\s+v{re.escape(version)}(\s|$)", head):
        return None
    title = re.split(r"\s+[—-]\s+", head, maxsplit=1)
    body: list[str] = []
    for line in lines[1:]:
        if line.strip() == "---":
            break
        body.append(line)
    paragraphs = [
        " ".join(part.split()) for part in "\n".join(body).split("\n\n") if part.strip()
    ]
    zh = next((p for p in paragraphs if _CJK.search(p)), "")
    en = next((p for p in paragraphs if not _CJK.search(p)), "")
    if not zh and not en:
        return None
    return {"title": title[1].strip() if len(title) > 1 else "", "zh": zh, "en": en}


def read_whats_new(package_root: Path, version: str) -> dict[str, Any]:
    """The summary of ``version`` from the package's release notes, or ``available: False``."""
    found = None
    path = Path(package_root) / NOTES_NAME
    try:
        found = _summary(path.read_text(encoding="utf-8"), version)
    except (OSError, UnicodeDecodeError):
        found = None
    return {
        "available": found is not None,
        "version": version,
        "title": (found or {}).get("title", ""),
        "summary_zh": (found or {}).get("zh", ""),
        "summary_en": (found or {}).get("en", ""),
        "notes_url": f"{GITHUB_REPOSITORY_URL}/releases/tag/v{version}",
    }


# One answer per process: the first call records the running version, later
# calls (page reloads, a second window) must still see "updated".
_noted: dict[tuple[str, str], dict[str, Any]] = {}


def note_running_version(
    state_dir: Path, version: str, has_older_data: Callable[[], bool]
) -> dict[str, Any]:
    """Record the version this process runs and say whether it replaced another.

    ``updated`` is true when the last recorded version differs. With no record
    yet (an install from before this file existed), a library that already
    holds pictures counts as updated: a fresh install has none.
    """
    key = (str(state_dir), version)
    if key in _noted:
        return _noted[key]
    path = Path(state_dir) / STATE_NAME
    try:
        previous = json.loads(path.read_text(encoding="utf-8")).get("version")
    except (OSError, ValueError, AttributeError):
        previous = None
    if previous:
        updated = previous != version
    else:
        try:
            updated = bool(has_older_data())
        except Exception:  # noqa: BLE001 - a notice never breaks start-up
            updated = False
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"version": version}), encoding="utf-8")
    except OSError:
        pass
    _noted[key] = {
        "updated": updated,
        "previous_version": previous if previous and previous != version else None,
    }
    return _noted[key]
