"""The assistant's tools: one table, one class per tool.

Every tool has a class, and what the program does with a call follows from the
class alone:

* ``read``    looks something up; runs at once
* ``show``    changes what is on screen (filters, selection, page); runs at
              once, the user sees it happen and can change it back
* ``change``  writes to the library (tags, stars, collections); waits for the
              user's confirmation unless they chose to skip it

No tool moves, renames, overwrites or deletes a file: the same line the MCP
server holds. A tool without a class cannot be registered (``_register``
raises), so a new tool cannot skip that decision.

The tools go through the program's own REST API (the functions of
``mcp_server``), so every call passes the same validation as a click.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional

import httpx

import library_context
import mcp_server

READ = "read"
SHOW = "show"
CHANGE = "change"
_CLASSES = (READ, SHOW, CHANGE)

RESULT_CHAR_LIMIT = 12000
SEARCH_PAGE = 200
PAGES = (
    "gallery",
    "reader",
    "organize",
    "censor",
    "similar",
    "style-map",
    "dataset",
    "prompt-helper",
    "models",
)


@dataclass(frozen=True)
class Tool:
    name: str
    kind: str
    description: str
    parameters: Dict[str, Any]
    run: Callable[..., Any]


@dataclass(frozen=True)
class Plan:
    """A change that is ready to run: what it will do, bound to exact pictures."""

    tool: str
    summary: Dict[str, Any]
    apply: Callable[[], Any]


_LIST = {"type": "array", "items": {"type": "string"}}
# Filter name -> its JSON schema. The names are the gallery API's own
# parameters, so one mapping serves search, count, "show" and change scopes.
_FILTER_PROPERTIES: Dict[str, Any] = {
    "search": {
        "type": "string",
        "description": "Free text: file name, prompt, caption, model name. lora:name and model:name also work.",
    },
    "tags": {
        **_LIST,
        "description": "Danbooru-style tags, e.g. silver_hair. All must be present unless tag_mode is or.",
    },
    "tag_mode": {"type": "string", "enum": ["and", "or"]},
    "exclude_tags": _LIST,
    "untagged": {
        "type": "boolean",
        "description": "True: only pictures that have no tags yet.",
    },
    "no_caption": {
        "type": "boolean",
        "description": "True: only pictures with no AI caption.",
    },
    "generators": {**_LIST, "description": "comfyui, nai, webui, forge, unknown."},
    "ratings": {
        **_LIST,
        "description": "Content rating from the tagger: general, sensitive, questionable, explicit.",
    },
    "checkpoints": {
        **_LIST,
        "description": "Model names as list_library(checkpoints) spells them.",
    },
    "exclude_checkpoints": _LIST,
    "loras": _LIST,
    "exclude_loras": _LIST,
    "prompts": {
        **_LIST,
        "description": "Exact prompt terms the picture was generated with.",
    },
    "artist": {"type": "string"},
    "seed": {"type": "integer"},
    "collection_id": {
        "type": "integer",
        "description": "Only pictures in this collection (see list_collections).",
    },
    "folder": {
        "type": "string",
        "description": "Only pictures under this folder path.",
    },
    "has_metadata": {
        "type": "boolean",
        "description": "True: only pictures that carry generation data; false: only those without.",
    },
    "min_user_rating": {
        "type": "integer",
        "description": "The user's own stars, 1 to 5.",
    },
    "min_aesthetic": {"type": "number", "description": "AI aesthetic score, 0 to 10."},
    "max_aesthetic": {"type": "number"},
    "aesthetic_unscored": {"type": "boolean"},
    "min_width": {"type": "integer"},
    "max_width": {"type": "integer"},
    "min_height": {"type": "integer"},
    "max_height": {"type": "integer"},
    "aspect_ratio": {"type": "string", "enum": ["square", "landscape", "portrait"]},
    "media_type": {"type": "string", "enum": ["image", "video"]},
    "date_from": {
        "type": "string",
        "description": "YYYY-MM-DD, inclusive (when the file was first seen).",
    },
    "date_to": {"type": "string", "description": "YYYY-MM-DD, inclusive."},
}
_FILTER_KEYS = tuple(_FILTER_PROPERTIES)

_SCOPE_PROPERTIES: Dict[str, Any] = {
    "image_ids": {
        "type": "array",
        "items": {"type": "integer"},
        "description": "Exact pictures. Use this or filters, not both.",
    },
    "filters": {
        "type": "object",
        "properties": _FILTER_PROPERTIES,
        "description": "Every picture matching these filters (same fields as search_images).",
    },
}


def _object(
    properties: Dict[str, Any], required: Optional[List[str]] = None
) -> Dict[str, Any]:
    return {"type": "object", "properties": properties, "required": required or []}


def _request(
    method: str,
    path: str,
    *,
    params: Optional[Dict[str, Any]] = None,
    json: Optional[Dict[str, Any]] = None,
) -> Any:
    """One call to the program's own API, in the library the user has open.

    The library travels in a context variable that the run inherits from the
    request that started it (and worker threads inherit from the run), so a
    tool reads and writes the library on screen, not always the main one.
    Every failure comes back as a RuntimeError the model can read.
    """
    headers = {library_context.LIBRARY_HEADER: library_context.get_current_library_id()}
    try:
        response = httpx.request(
            method,
            mcp_server._api_base() + path,
            params=params,
            json=json,
            headers=headers,
            timeout=mcp_server.REQUEST_TIMEOUT_SECONDS,
        )
    except httpx.HTTPError as exc:
        raise RuntimeError(
            f"The program did not answer ({type(exc).__name__})."
        ) from exc
    if response.status_code >= 400:
        try:
            body = response.json()
        except ValueError:
            body = {"error": response.text[:300]}
        detail = body.get("error") or body.get("detail") or str(body)
        raise RuntimeError(f"{response.status_code}: {str(detail)[:400]}")
    return response.json()


def _filters(args: Dict[str, Any]) -> Dict[str, Any]:
    return {
        key: args[key] for key in _FILTER_KEYS if args.get(key) not in (None, "", [])
    }


def _params(filters: Dict[str, Any]) -> Dict[str, Any]:
    """Filters as the gallery API takes them (lists joined with commas)."""
    return {
        key: ",".join(str(item).strip() for item in value if str(item).strip())
        if isinstance(value, list)
        else value
        for key, value in _filters(filters).items()
    }


def _slim(row: Dict[str, Any]) -> Dict[str, Any]:
    """One picture in a list: enough to choose by, no folder paths."""
    keys = (
        "id",
        "filename",
        "generator",
        "width",
        "height",
        "aesthetic_score",
        "user_rating",
    )
    return {key: row.get(key) for key in keys if row.get(key) is not None}


def _list_page(
    filters: Dict[str, Any], sort_by: str, limit: int, offset: int
) -> Dict[str, Any]:
    params = {
        **_params(filters),
        "sort_by": sort_by,
        "limit": max(1, min(int(limit), SEARCH_PAGE)),
        "offset": max(0, int(offset)),
    }
    return _request("GET", "/api/images", params=params)


def _search(**args: Any) -> Dict[str, Any]:
    body = _list_page(
        args,
        str(args.get("sort_by") or "newest"),
        int(args.get("limit") or 20),
        int(args.get("offset") or 0),
    )
    return {
        "images": [_slim(row) for row in body.get("images", [])],
        "total": body.get("total"),
        "has_more": body.get("has_more"),
    }


def _count(**args: Any) -> Dict[str, Any]:
    return _request("GET", "/api/images/count", params=_params(args))


def _describe(query: str, limit: int = 20) -> Dict[str, Any]:
    limit = max(1, min(int(limit), mcp_server.SEMANTIC_LIMIT_MAX))
    body = _request(
        "POST",
        "/api/similarity/search-text",
        json={"query": str(query), "limit": limit},
    )
    return {
        "results": [
            {**_slim(row), "similarity": row.get("similarity")}
            for row in body.get("results", [])
        ],
        "total": body.get("total"),
    }


def _get_image(image_id: int) -> Dict[str, Any]:
    body = _request("GET", f"/api/images/{int(image_id)}")
    image = dict(body.get("image") or {})
    # The raw workflow can be megabytes; the parsed fields say the same in less.
    image.pop("metadata_json", None)
    return {"image": image, "tags": body.get("tags")}


def _collections() -> Dict[str, Any]:
    body = _request("GET", "/api/collections")
    return {
        "collections": [
            {
                "id": row.get("id"),
                "name": row.get("name"),
                "pictures": row.get("item_count"),
                "inside": row.get("parent_id"),
            }
            for row in body.get("collections", [])
        ]
    }


def resolve_ids(args: Dict[str, Any]) -> List[int]:
    """The exact pictures a change is about: given ids, or everything the filters match."""
    ids = [int(value) for value in (args.get("image_ids") or [])]
    if ids:
        return list(dict.fromkeys(ids))
    filters = _filters(dict(args.get("filters") or {}))
    if not filters:
        raise RuntimeError("Give image_ids, or filters that say which pictures.")
    found: List[int] = []
    offset = 0
    while True:
        page = _list_page(filters, "newest", SEARCH_PAGE, offset)
        rows = page.get("images") or []
        found.extend(int(row["id"]) for row in rows)
        if not rows or not page.get("has_more"):
            break
        offset += len(rows)
    if not found:
        raise RuntimeError("No picture matches those filters.")
    return list(dict.fromkeys(found))


def _chunks(ids: List[int], size: int = mcp_server.BULK_IDS_MAX):
    for start in range(0, len(ids), size):
        yield ids[start : start + size]


def _clean_tags(args: Dict[str, Any]) -> List[str]:
    tags = [str(tag).strip() for tag in (args.get("tags") or []) if str(tag).strip()]
    if not tags:
        raise RuntimeError("tags is required")
    return tags


def _list_library(facet: str, q: str = "", limit: int = 50) -> Any:
    endpoint = mcp_server._LIBRARY_ENDPOINTS.get(str(facet).strip().lower())
    if not endpoint:
        raise RuntimeError(
            f"Unknown facet {facet!r}: use tags, checkpoints, loras or prompts."
        )
    params = {"limit": max(1, min(int(limit), 500))}
    if str(q or "").strip():
        params["q"] = str(q).strip()
    return _request("GET", endpoint, params=params)


def _outcome(
    done: int, total: int, error: Optional[str], **extra: Any
) -> Dict[str, Any]:
    """What a change really did: how many of the pictures were handled, and why it stopped."""
    result: Dict[str, Any] = {"pictures_done": done, "pictures_asked": total, **extra}
    if error:
        result["stopped_early"] = error
    return result


def _plan_tags(args: Dict[str, Any], adding: bool) -> Plan:
    ids = resolve_ids(args)
    tags = _clean_tags(args)
    path = "/api/tags/bulk/add" if adding else "/api/tags/bulk/remove"

    def apply() -> Dict[str, Any]:
        done = 0
        for chunk in _chunks(ids):
            try:
                _request(
                    "POST",
                    path,
                    json={"image_ids": chunk, "tags": tags, "dry_run": False},
                )
            except RuntimeError as exc:
                return _outcome(done, len(ids), str(exc), tags=tags)
            done += len(chunk)
        return _outcome(done, len(ids), None, tags=tags)

    tool = "add_tags" if adding else "remove_tags"
    return Plan(
        tool,
        {"action": tool, "pictures": len(ids), "tags": tags, "sample": ids[:6]},
        apply,
    )


def _plan_rating(args: Dict[str, Any]) -> Plan:
    ids = resolve_ids(args)
    stars = int(args.get("stars", -1))
    if not 0 <= stars <= 5:
        raise RuntimeError("stars must be 0 to 5 (0 clears the rating)")

    def apply() -> Dict[str, Any]:
        done = 0
        gone = 0
        for image_id in ids:
            try:
                _request(
                    "POST", f"/api/images/{image_id}/rating", json={"stars": stars}
                )
                done += 1
            except RuntimeError as exc:
                # A picture removed since the plan was made is skipped, not a reason to stop.
                if str(exc).startswith("404"):
                    gone += 1
                    continue
                return _outcome(
                    done, len(ids), str(exc), stars=stars, no_longer_in_library=gone
                )
        return _outcome(done, len(ids), None, stars=stars, no_longer_in_library=gone)

    return Plan(
        "set_rating",
        {
            "action": "set_rating",
            "pictures": len(ids),
            "stars": stars,
            "sample": ids[:6],
        },
        apply,
    )


def _plan_collection(args: Dict[str, Any]) -> Plan:
    ids = resolve_ids(args)
    collection_id = args.get("collection_id")
    new_name = str(args.get("new_collection_name") or "").strip()
    if not collection_id and not new_name:
        raise RuntimeError("Give collection_id, or new_collection_name to make one.")
    name = new_name
    if collection_id:
        known = {row["id"]: row["name"] for row in _collections()["collections"]}
        if int(collection_id) not in known:
            raise RuntimeError(
                f"There is no collection {collection_id}. Use list_collections."
            )
        name = known[int(collection_id)]

    def apply() -> Dict[str, Any]:
        target = int(collection_id) if collection_id else None
        if target is None:
            created = _request("POST", "/api/collections", json={"name": new_name})
            target = int((created.get("collection") or created).get("id"))
        added = 0
        done = 0
        for chunk in _chunks(ids):
            try:
                body = _request(
                    "POST",
                    f"/api/collections/{target}/items/bulk",
                    json={"image_ids": chunk, "member": True},
                )
            except RuntimeError as exc:
                return _outcome(
                    done,
                    len(ids),
                    str(exc),
                    collection_id=target,
                    name=name,
                    added=added,
                )
            done += len(chunk)
            added += int(body.get("added") or 0)
        return _outcome(
            done,
            len(ids),
            None,
            collection_id=target,
            name=name,
            added=added,
            already_there=done - added,
        )

    summary = {
        "action": "add_to_collection",
        "pictures": len(ids),
        "collection": name,
        "new": not collection_id,
        "sample": ids[:6],
    }
    return Plan("add_to_collection", summary, apply)


_TABLE: Dict[str, Tool] = {}


def _register(
    name: str,
    kind: str,
    description: str,
    parameters: Dict[str, Any],
    run: Callable[..., Any],
) -> None:
    if kind not in _CLASSES:
        raise RuntimeError(f"Tool {name} has no class (read / show / change).")
    _TABLE[name] = Tool(name, kind, description, parameters, run)


_PAGING = {
    "sort_by": {
        "type": "string",
        "description": "newest, oldest, aesthetic, aesthetic_asc, file_size, file_size_asc, random.",
    },
    "limit": {"type": "integer", "description": "1 to 200, default 20."},
    "offset": {"type": "integer"},
}

_register(
    "search_images",
    READ,
    "Search the library with the gallery's filters. Returns compact rows (id, file name, size, scores).",
    _object({**_FILTER_PROPERTIES, **_PAGING}),
    _search,
)
_register(
    "count_images",
    READ,
    "How many pictures match the filters.",
    _object(_FILTER_PROPERTIES),
    _count,
)
_register(
    "get_image",
    READ,
    "Everything about one picture: prompt, model, LoRAs, sampler settings, tags, captions.",
    _object({"image_id": {"type": "integer"}}, ["image_id"]),
    _get_image,
)
_register(
    "find_by_description",
    READ,
    "Find pictures by what they show, described in words (needs the similarity index from the Similar page; empty before it is built).",
    _object({"query": {"type": "string"}, "limit": {"type": "integer"}}, ["query"]),
    _describe,
)
_register(
    "list_library",
    READ,
    "What exists in the library: facet is tags, checkpoints, loras or prompts; q narrows by a part of the name.",
    _object(
        {
            "facet": {"type": "string"},
            "q": {"type": "string"},
            "limit": {"type": "integer"},
        },
        ["facet"],
    ),
    _list_library,
)
_register(
    "library_stats",
    READ,
    "Totals of the library and recent activity.",
    _object({}),
    lambda: _request("GET", "/api/entry/summary"),
)
_register(
    "list_collections",
    READ,
    "The user's collections with their ids and sizes.",
    _object({}),
    _collections,
)
_register(
    "get_current_view",
    READ,
    "What the user is looking at now: page, filters in force, how many pictures are selected and their ids.",
    _object({}),
    lambda: {},
)
_register(
    "show_in_gallery",
    SHOW,
    "Show the pictures matching these filters in the Gallery (replaces the filters on screen). Use it to hand a result to the user.",
    _object({**_FILTER_PROPERTIES, "sort_by": _PAGING["sort_by"]}),
    _count,
)
_register(
    "select_images",
    SHOW,
    "Select exactly these pictures in the Gallery so the user can act on them.",
    _object(
        {"image_ids": {"type": "array", "items": {"type": "integer"}}}, ["image_ids"]
    ),
    lambda image_ids: {"selected": len(image_ids or [])},
)
_register(
    "open_image",
    SHOW,
    "Open one picture in the viewer.",
    _object({"image_id": {"type": "integer"}}, ["image_id"]),
    lambda image_id: {"opened": int(image_id)},
)
_register(
    "open_page",
    SHOW,
    "Go to a page of the program: " + ", ".join(PAGES) + ".",
    _object({"page": {"type": "string", "enum": list(PAGES)}}, ["page"]),
    lambda page: {"page": page},
)
_register(
    "add_tags",
    CHANGE,
    "Add tags to pictures.",
    _object(
        {**_SCOPE_PROPERTIES, "tags": {"type": "array", "items": {"type": "string"}}},
        ["tags"],
    ),
    lambda **args: _plan_tags(args, True),
)
_register(
    "remove_tags",
    CHANGE,
    "Remove tags from pictures.",
    _object(
        {**_SCOPE_PROPERTIES, "tags": {"type": "array", "items": {"type": "string"}}},
        ["tags"],
    ),
    lambda **args: _plan_tags(args, False),
)
_register(
    "set_rating",
    CHANGE,
    "Set the user's star rating (0 clears it).",
    _object({**_SCOPE_PROPERTIES, "stars": {"type": "integer"}}, ["stars"]),
    lambda **args: _plan_rating(args),
)
_register(
    "add_to_collection",
    CHANGE,
    "Put pictures into a collection (a reference; no file is copied). Give collection_id, or new_collection_name to make one.",
    _object(
        {
            **_SCOPE_PROPERTIES,
            "collection_id": {"type": "integer"},
            "new_collection_name": {"type": "string"},
        }
    ),
    lambda **args: _plan_collection(args),
)


def get(name: str) -> Optional[Tool]:
    return _TABLE.get(name)


def offered(read_only: bool) -> List[Tool]:
    """The tools the model is told about; in read-only mode the change tools do not exist for it."""
    return [tool for tool in _TABLE.values() if not (read_only and tool.kind == CHANGE)]


def schemas(read_only: bool) -> List[Dict[str, Any]]:
    return [
        {
            "type": "function",
            "function": {
                "name": tool.name,
                "description": tool.description,
                "parameters": tool.parameters,
            },
        }
        for tool in offered(read_only)
    ]
