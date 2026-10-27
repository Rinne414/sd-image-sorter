"""Route handlers whose work grows with the library run in the threadpool.

An ``async def`` handler that never awaits runs on the event loop: while it
walks the thumbnail cache, snapshots 80,000 selected ids, renders 500 export
previews or stats a sleeping network drive, every other request waits
(thumbnails, progress polls, the page itself). These are plain ``def``, so
FastAPI runs them in its threadpool. Quick lookups stay ``async``.
"""

from __future__ import annotations

import importlib
import inspect

import pytest

OFF_LOOP = {
    "routers.images_parts.serving": [
        "save_edited_image_metadata",
        "get_thumbnail_cache_statistics",
        "clear_thumbnail_cache",
        "cleanup_thumbnail_cache",
    ],
    "routers.images_parts.export": [
        "export_selection_data",
        "get_selection_ids",
        "count_filtered_images_by_generator",
        "count_filtered_images",
    ],
    "routers.images_parts.counting": ["count_images"],
    "routers.images_parts.selection": ["create_selection_token", "get_selection_chunk"],
    "routers.images_parts.jobs": ["remove_selected_images", "delete_selected_images"],
    "routers.images_parts.repair": [
        "get_missing_images_summary",
        "clear_missing_images",
        "confirm_repair",
    ],
    "routers.images_parts.item_ops": ["reparse_image"],
    "routers.images_parts.listing": ["get_images"],
    "routers.sorting": [
        "validate_path",
        "resolve_drop",
        "browse_folder",
        "start_sort_session",
        "remove_library_root",
    ],
    "routers.tags": [
        "export_tags",
        "import_tags",
        "export_tags_batch",
        "fix_rating_tags",
        "export_preview",
        "consistency_report",
    ],
    "routers.collections": ["set_membership_bulk", "list_collection_images"],
    "routers.prompts": ["categorize_tags", "prompt_stats", "compare_prompts"],
    "routers.artists": [
        "get_artist_images",
        "list_artists",
        "get_stats",
        "clear_predictions",
    ],
    "routers.obfuscation": ["encode_single", "decode_single", "batch"],
}

CASES = [(module, name) for module, names in OFF_LOOP.items() for name in names]


@pytest.mark.parametrize(("module", "name"), CASES, ids=[f"{m}.{n}" for m, n in CASES])
def test_the_handler_runs_in_the_threadpool(module, name):
    handler = getattr(importlib.import_module(module), name)

    assert not inspect.iscoroutinefunction(handler), (
        f"{module}.{name} is async but never awaits: it would hold up every other request"
    )
