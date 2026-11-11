"""Read an Eagle library folder: what its items are and what the user gave them.

Eagle keeps a library as a folder ``<Name>.library``:

- ``metadata.json``: the folder tree (``folders``: ``id``, ``name``,
  ``children``), smart folders and tag groups;
- ``images/<ITEM_ID>.info/``: one folder per item holding ``metadata.json``,
  the original file and usually a ``*_thumbnail.png``.

An item's ``metadata.json`` names the file (``name`` without extension,
``ext``) and carries what the user added: ``tags``, ``folders`` (folder ids, an
item may be in several), ``star``, ``annotation``, ``url``. Only ``id`` is
always there. A bookmark item has a ``url`` and no media file; a deleted item
has ``isDeleted``.

This module only reads. It never writes into the Eagle folder and never copies
a file: the pictures are meant to be indexed where they lie.

The layout is taken from public format notes (see
``.plans/competitors-2026-11/README.md``), not from Eagle itself, so the reader
is tolerant: anything missing or of the wrong type is treated as absent, and a
folder it cannot read is counted and skipped instead of stopping the read.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional, Tuple

LIBRARY_METADATA = "metadata.json"
ITEMS_DIRNAME = "images"
ITEM_SUFFIX = ".info"
THUMBNAIL_MARK = "_thumbnail"


class NotAnEagleLibraryError(ValueError):
    """The folder does not look like an Eagle library."""


@dataclass(frozen=True)
class EagleItem:
    """One Eagle item whose media file exists."""

    item_id: str
    file_path: Path
    name: str
    tags: Tuple[str, ...] = ()
    # Each folder the item is in, as the names from the top folder down.
    folders: Tuple[Tuple[str, ...], ...] = ()
    star: int = 0
    annotation: str = ""
    url: str = ""


@dataclass
class EagleSummary:
    """What a read found, and what it passed over and why."""

    items: int = 0
    with_tags: int = 0
    with_stars: int = 0
    with_notes: int = 0
    in_folders: int = 0
    with_source: int = 0
    distinct_tags: int = 0
    folders: int = 0
    skipped_deleted: int = 0
    skipped_no_file: int = 0
    skipped_unreadable: int = 0
    unreadable_examples: List[str] = field(default_factory=list)

    def as_dict(self) -> Dict[str, Any]:
        return dict(self.__dict__)


def _load_json(path: Path) -> Optional[Dict[str, Any]]:
    try:
        data = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def _text(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def resolve_library_root(folder: str) -> Path:
    """The library folder itself, given it or its ``images`` folder."""
    root = Path(folder).expanduser()
    if root.name == ITEMS_DIRNAME and (root.parent / LIBRARY_METADATA).is_file():
        root = root.parent
    if not root.is_dir() or not (root / ITEMS_DIRNAME).is_dir():
        raise NotAnEagleLibraryError(
            "这个文件夹不像 Eagle 资源库：里面没有 images 文件夹"
            " / This folder does not look like an Eagle library: it has no 'images' folder."
        )
    return root


def read_folder_paths(root: Path) -> Dict[str, Tuple[str, ...]]:
    """Folder id -> its names from the top folder down."""
    library = _load_json(root / LIBRARY_METADATA) or {}
    paths: Dict[str, Tuple[str, ...]] = {}

    def walk(nodes: Any, above: Tuple[str, ...]) -> None:
        if not isinstance(nodes, list):
            return
        for node in nodes:
            if not isinstance(node, dict):
                continue
            folder_id = _text(node.get("id"))
            name = _text(node.get("name"))
            if not folder_id or not name:
                continue
            here = (*above, name)
            paths.setdefault(folder_id, here)
            walk(node.get("children"), here)

    walk(library.get("folders"), ())
    return paths


def _media_file(info_dir: Path, name: str, ext: str) -> Optional[Path]:
    """The item's original file: the named one, else the only non-thumbnail file."""
    if name and ext:
        named = info_dir / f"{name}.{ext}"
        if named.is_file():
            return named
    try:
        candidates = [
            entry
            for entry in info_dir.iterdir()
            if entry.is_file()
            and entry.name != LIBRARY_METADATA
            and not entry.stem.endswith(THUMBNAIL_MARK)
        ]
    except OSError:
        return None
    if ext:
        candidates = [c for c in candidates if c.suffix.lower() == f".{ext.lower()}"]
    return candidates[0] if len(candidates) == 1 else None


def _star(value: Any) -> int:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return 0
    return max(0, min(5, int(value)))


def iter_items(
    root: Path, summary: Optional[EagleSummary] = None
) -> Iterator[EagleItem]:
    """Every item with a media file, in folder-name order."""
    summary = summary if summary is not None else EagleSummary()
    folder_paths = read_folder_paths(root)
    summary.folders = len(folder_paths)
    all_tags: set = set()
    try:
        info_dirs = sorted(
            entry
            for entry in (root / ITEMS_DIRNAME).iterdir()
            if entry.is_dir() and entry.name.endswith(ITEM_SUFFIX)
        )
    except OSError as exc:
        raise NotAnEagleLibraryError(
            f"读不到 images 文件夹 / The 'images' folder cannot be read: {exc}"
        ) from exc
    for info_dir in info_dirs:
        meta = _load_json(info_dir / LIBRARY_METADATA)
        if meta is None:
            summary.skipped_unreadable += 1
            if len(summary.unreadable_examples) < 5:
                summary.unreadable_examples.append(info_dir.name)
            continue
        if meta.get("isDeleted") is True:
            summary.skipped_deleted += 1
            continue
        media = _media_file(info_dir, _text(meta.get("name")), _text(meta.get("ext")))
        if media is None:
            # A bookmark, or an item whose file is gone.
            summary.skipped_no_file += 1
            continue
        raw_tags = meta.get("tags")
        raw_folders = meta.get("folders")
        tag_names = (
            [_text(tag) for tag in raw_tags] if isinstance(raw_tags, list) else []
        )
        folder_ids = raw_folders if isinstance(raw_folders, list) else []
        tags = tuple(dict.fromkeys(name for name in tag_names if name))
        folders = tuple(
            folder_paths[folder_id]
            for folder_id in folder_ids
            if isinstance(folder_id, str) and folder_id in folder_paths
        )
        item = EagleItem(
            item_id=_text(meta.get("id")) or info_dir.name[: -len(ITEM_SUFFIX)],
            file_path=media,
            name=_text(meta.get("name")) or media.stem,
            tags=tags,
            folders=folders,
            star=_star(meta.get("star")),
            annotation=_text(meta.get("annotation")),
            url=_text(meta.get("url")),
        )
        summary.items += 1
        summary.with_tags += bool(item.tags)
        summary.with_stars += item.star > 0
        summary.with_notes += bool(item.annotation)
        summary.in_folders += bool(item.folders)
        summary.with_source += bool(item.url)
        all_tags.update(item.tags)
        summary.distinct_tags = len(all_tags)
        yield item


def summarize(folder: str) -> Dict[str, Any]:
    """Counts for the question "what would be brought over?" (reads every item once)."""
    root = resolve_library_root(folder)
    summary = EagleSummary()
    for _ in iter_items(root, summary):
        pass
    return {"library": str(root), "name": root.name, **summary.as_dict()}
