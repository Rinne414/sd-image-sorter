"""MCP server: lets AI assistants (Claude Desktop/Code, etc.) drive this app.

Owner-approved scope (2026-07-13): QUERY + EXPORT + TAGGING only —
search/filter (incl. semantic + the file-time date range), read image
metadata, library stats, facet discovery, bulk tag add/remove, and dataset
export. Deliberately NO file moves, NO deletes, NO censor operations: the
assistant can curate and hand off training sets but can never touch the
user's original files.

Architecture: a thin stdio MCP server that talks HTTP to the RUNNING app on
127.0.0.1 (same SD_IMAGE_SORTER_PORT the web UI uses). Reusing the REST API
means every request goes through the app's own validation, path-traversal
guards and localhost-only middleware, and there is no second writer on the
SQLite database.

Dependencies: ``httpx`` is a core requirement already; the ``mcp`` package
(1.x stable line — the maintainers mark 2.x pre-releases "do not use in
production", pypi.org/project/mcp) is OPT-IN like rembg/tipo. Run:

    backend/venv/Scripts/python.exe -m pip install "mcp>=1.9,<2"
    backend/venv/Scripts/python.exe backend/mcp_server.py

See docs/MCP.md for the Claude Desktop / Claude Code config snippet.
"""

from __future__ import annotations

import os
from typing import Any, Dict, List, Optional

import httpx

DEFAULT_PORT = 8487
REQUEST_TIMEOUT_SECONDS = 120  # dataset export of a big selection is slow
SEARCH_LIMIT_MAX = 200
SEMANTIC_LIMIT_MAX = 100
BULK_IDS_MAX = 500

_NOT_RUNNING_HINT = (
    "SD Image Sorter is not running on {base} — start it first (run.bat / "
    "run.sh). / 应用没有在 {base} 运行，请先启动 SD 图片管理器（run.bat）。"
)

# Facet name -> library endpoint. tags lives under /api/tags/, the other
# three at the API root (routers/tags.py registers them that way).
_LIBRARY_ENDPOINTS = {
    "tags": "/api/tags/library",
    "checkpoints": "/api/checkpoints/library",
    "loras": "/api/loras/library",
    "prompts": "/api/prompts/library",
}


def _api_base() -> str:
    port = os.environ.get("SD_IMAGE_SORTER_PORT", "").strip() or str(DEFAULT_PORT)
    return f"http://127.0.0.1:{port}"


def _request(
    method: str,
    path: str,
    *,
    params: Optional[Dict[str, Any]] = None,
    json: Optional[Dict[str, Any]] = None,
) -> Any:
    """One HTTP round-trip to the running app; friendly failure modes."""
    base = _api_base()
    try:
        response = httpx.request(
            method,
            base + path,
            params=params,
            json=json,
            timeout=REQUEST_TIMEOUT_SECONDS,
        )
    except httpx.ConnectError as exc:
        raise RuntimeError(_NOT_RUNNING_HINT.format(base=base)) from exc
    if response.status_code >= 400:
        try:
            body = response.json()
        except ValueError:
            body = {"error": response.text[:500]}
        detail = body.get("error") or body.get("detail") or str(body)
        raise RuntimeError(f"API {response.status_code} on {path}: {detail}")
    return response.json()


def _csv(values: Optional[List[str]]) -> Optional[str]:
    cleaned = [str(v).strip() for v in (values or []) if str(v).strip()]
    return ",".join(cleaned) if cleaned else None


def _drop_none(params: Dict[str, Any]) -> Dict[str, Any]:
    return {k: v for k, v in params.items() if v is not None}


def _slim_image(row: Dict[str, Any]) -> Dict[str, Any]:
    """Compact row so a 100-result search does not flood the model context."""
    return {
        "id": row.get("id"),
        "filename": row.get("filename"),
        "path": row.get("path"),
        "generator": row.get("generator"),
        "rating": row.get("rating"),
        "width": row.get("width"),
        "height": row.get("height"),
        "aesthetic_score": row.get("aesthetic_score"),
        "user_rating": row.get("user_rating"),
        "file_time": row.get("library_order_time") or row.get("created_at"),
    }


def _gallery_params(
    search: Optional[str],
    tags: Optional[List[str]],
    exclude_tags: Optional[List[str]],
    generators: Optional[List[str]],
    ratings: Optional[List[str]],
    checkpoints: Optional[List[str]],
    loras: Optional[List[str]],
    min_aesthetic: Optional[float],
    max_aesthetic: Optional[float],
    min_user_rating: Optional[int],
    date_from: Optional[str],
    date_to: Optional[str],
    folder: Optional[str],
    has_metadata: Optional[bool],
    sort_by: Optional[str],
) -> Dict[str, Any]:
    return _drop_none(
        {
            "search": (search or "").strip() or None,
            "tags": _csv(tags),
            "exclude_tags": _csv(exclude_tags),
            "generators": _csv(generators),
            "ratings": _csv(ratings),
            "checkpoints": _csv(checkpoints),
            "loras": _csv(loras),
            "min_aesthetic": min_aesthetic,
            "max_aesthetic": max_aesthetic,
            "min_user_rating": min_user_rating,
            "date_from": date_from,
            "date_to": date_to,
            "folder": folder,
            "has_metadata": has_metadata,
            "sort_by": sort_by,
        }
    )


# ---------------------------------------------------------------------------
# Tool implementations (plain functions — registered on FastMCP in
# build_server(); kept import-light so tests run without the mcp package).
# ---------------------------------------------------------------------------


def search_images(
    search: Optional[str] = None,
    tags: Optional[List[str]] = None,
    exclude_tags: Optional[List[str]] = None,
    generators: Optional[List[str]] = None,
    ratings: Optional[List[str]] = None,
    checkpoints: Optional[List[str]] = None,
    loras: Optional[List[str]] = None,
    min_aesthetic: Optional[float] = None,
    max_aesthetic: Optional[float] = None,
    min_user_rating: Optional[int] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    folder: Optional[str] = None,
    has_metadata: Optional[bool] = None,
    sort_by: str = "newest",
    limit: int = 30,
    offset: int = 0,
) -> Dict[str, Any]:
    """Search the image library with the gallery's full filter set.

    tags/exclude_tags use danbooru-style names (e.g. "silver_hair").
    ratings: general/sensitive/questionable/explicit. date_from/date_to are
    inclusive YYYY-MM-DD bounds on the file's first-seen time (NOT a
    generation timestamp). sort_by: newest/oldest/aesthetic/aesthetic_asc/
    file_size/file_size_asc. Returns compact rows; use get_image for full
    metadata of one image.
    """
    limit = max(1, min(int(limit), SEARCH_LIMIT_MAX))
    params = _gallery_params(
        search,
        tags,
        exclude_tags,
        generators,
        ratings,
        checkpoints,
        loras,
        min_aesthetic,
        max_aesthetic,
        min_user_rating,
        date_from,
        date_to,
        folder,
        has_metadata,
        sort_by,
    )
    params.update({"limit": limit, "offset": max(0, int(offset))})
    body = _request("GET", "/api/images", params=params)
    return {
        "images": [_slim_image(row) for row in body.get("images", [])],
        "has_more": body.get("has_more"),
        "total": body.get("total"),
    }


def count_images(
    search: Optional[str] = None,
    tags: Optional[List[str]] = None,
    exclude_tags: Optional[List[str]] = None,
    generators: Optional[List[str]] = None,
    ratings: Optional[List[str]] = None,
    checkpoints: Optional[List[str]] = None,
    loras: Optional[List[str]] = None,
    min_aesthetic: Optional[float] = None,
    max_aesthetic: Optional[float] = None,
    min_user_rating: Optional[int] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    folder: Optional[str] = None,
    has_metadata: Optional[bool] = None,
) -> Dict[str, Any]:
    """Count library images matching the same filters as search_images."""
    params = _gallery_params(
        search,
        tags,
        exclude_tags,
        generators,
        ratings,
        checkpoints,
        loras,
        min_aesthetic,
        max_aesthetic,
        min_user_rating,
        date_from,
        date_to,
        folder,
        has_metadata,
        None,
    )
    return _request("GET", "/api/images/count", params=params)


def get_image(image_id: int) -> Dict[str, Any]:
    """Full record for one image: metadata, prompt, tags, captions, paths."""
    return _request("GET", f"/api/images/{int(image_id)}")


def semantic_search(query: str, limit: int = 20) -> Dict[str, Any]:
    """Text-to-image semantic search (CLIP). Needs embeddings built once via
    the Similar view; returns empty results (not an error) before that."""
    limit = max(1, min(int(limit), SEMANTIC_LIMIT_MAX))
    body = _request(
        "POST",
        "/api/similarity/search-text",
        json={"query": str(query), "limit": limit},
    )
    results = body.get("results", [])
    return {
        "results": [
            {**_slim_image(row), "similarity": row.get("similarity")} for row in results
        ],
        "total": body.get("total"),
    }


def list_library(facet: str = "tags", q: str = "", limit: int = 50) -> Any:
    """Discover what exists in the library: facet = tags | checkpoints |
    loras | prompts, optionally filtered by substring q."""
    endpoint = _LIBRARY_ENDPOINTS.get(str(facet).strip().lower())
    if not endpoint:
        raise RuntimeError(
            f"Unknown facet {facet!r} (expected one of "
            f"{', '.join(sorted(_LIBRARY_ENDPOINTS))})"
        )
    params = _drop_none(
        {"q": (q or "").strip() or None, "limit": max(1, min(int(limit), 500))}
    )
    return _request("GET", endpoint, params=params)


def add_tags(
    image_ids: List[int], tags: List[str], dry_run: bool = False
) -> Dict[str, Any]:
    """Add tags to images (deduped against existing; manual-tier confidence).
    Set dry_run=true first to preview how many rows would change."""
    ids = [int(i) for i in (image_ids or [])][:BULK_IDS_MAX]
    if not ids or not tags:
        raise RuntimeError("image_ids and tags are both required")
    return _request(
        "POST",
        "/api/tags/bulk/add",
        json={"image_ids": ids, "tags": list(tags), "dry_run": bool(dry_run)},
    )


def remove_tags(
    image_ids: List[int], tags: List[str], dry_run: bool = False
) -> Dict[str, Any]:
    """Remove tags from images. Set dry_run=true first to preview."""
    ids = [int(i) for i in (image_ids or [])][:BULK_IDS_MAX]
    if not ids or not tags:
        raise RuntimeError("image_ids and tags are both required")
    return _request(
        "POST",
        "/api/tags/bulk/remove",
        json={"image_ids": ids, "tags": list(tags), "dry_run": bool(dry_run)},
    )


def export_dataset(
    image_ids: List[int],
    output_folder: str,
    trigger: Optional[str] = None,
    content_mode: Optional[str] = None,
    naming_pattern: Optional[str] = None,
    trainer_config: Optional[str] = None,
    trainer_repeats: Optional[int] = None,
    trainer_batch: Optional[int] = None,
    trainer_keep_tokens: Optional[int] = None,
    mask_export: Optional[str] = None,
) -> Dict[str, Any]:
    """Export images + caption sidecars as a training dataset (COPIES files
    into output_folder; originals are never moved). trainer_config
    "kohya_toml" also writes a ready dataset_config.toml; mask_export
    "kohya"/"onetrainer" includes stored masks."""
    ids = [int(i) for i in (image_ids or [])]
    if not ids:
        raise RuntimeError("image_ids is required")
    if not str(output_folder or "").strip():
        raise RuntimeError("output_folder is required")
    payload = _drop_none(
        {
            "image_ids": ids,
            "output_folder": str(output_folder).strip(),
            "trigger": trigger,
            "content_mode": content_mode,
            "naming_pattern": naming_pattern,
            "trainer_config": trainer_config,
            "trainer_repeats": trainer_repeats,
            "trainer_batch": trainer_batch,
            "trainer_keep_tokens": trainer_keep_tokens,
            "mask_export": mask_export,
        }
    )
    return _request("POST", "/api/dataset/export", json=payload)


def library_stats() -> Dict[str, Any]:
    """Library totals and recent-activity stats (the entry-page summary)."""
    return _request("GET", "/api/entry/summary")


_TOOLS = (
    search_images,
    count_images,
    get_image,
    semantic_search,
    list_library,
    add_tags,
    remove_tags,
    export_dataset,
    library_stats,
)


def build_server():
    """Create the FastMCP server (lazy mcp import — opt-in dependency)."""
    try:
        from mcp.server.fastmcp import FastMCP
    except ImportError as exc:  # pragma: no cover - environment-dependent
        raise SystemExit(
            "The 'mcp' package is not installed. Install it into the app's "
            'venv first: pip install "mcp>=1.9,<2" / 未安装 mcp 包，请先在应用'
            ' venv 里执行: pip install "mcp>=1.9,<2"'
        ) from exc

    server = FastMCP("sd-image-sorter")
    for tool in _TOOLS:
        server.tool()(tool)
    return server


def main() -> None:  # pragma: no cover - stdio loop
    build_server().run()


if __name__ == "__main__":
    main()
