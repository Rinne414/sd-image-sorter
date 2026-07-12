"""MCP server tool layer (backend/mcp_server.py).

The tools are plain functions over one HTTP seam (_request), so everything
except FastMCP registration is testable without the opt-in ``mcp`` package:
stub _request, assert the exact path/params/payload each tool produces —
that mapping IS the contract with the REST API (wrong param name = filter
silently ignored).
"""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

import mcp_server


class _Recorder:
    def __init__(self, response=None):
        self.calls = []
        self.response = response if response is not None else {}

    def __call__(self, method, path, *, params=None, json=None):
        self.calls.append(
            {"method": method, "path": path, "params": params, "json": json}
        )
        return self.response


@pytest.fixture
def recorder(monkeypatch):
    rec = _Recorder()
    monkeypatch.setattr(mcp_server, "_request", rec)
    return rec


def test_search_maps_every_filter_to_the_documented_query_params(recorder):
    recorder.response = {"images": [], "has_more": False, "total": 0}
    mcp_server.search_images(
        search="silver",
        tags=["silver_hair", "1girl"],
        exclude_tags=["blurry"],
        generators=["nai", "comfyui"],
        ratings=["general"],
        checkpoints=["noobai"],
        loras=["detailer"],
        min_aesthetic=6.5,
        max_aesthetic=9.0,
        min_user_rating=3,
        date_from="2026-01-01",
        date_to="2026-01-31",
        folder="L:/pics",
        has_metadata=True,
        sort_by="aesthetic",
        limit=50,
        offset=10,
    )
    call = recorder.calls[0]
    assert (call["method"], call["path"]) == ("GET", "/api/images")
    assert call["params"] == {
        "search": "silver",
        "tags": "silver_hair,1girl",
        "exclude_tags": "blurry",
        "generators": "nai,comfyui",
        "ratings": "general",
        "checkpoints": "noobai",
        "loras": "detailer",
        "min_aesthetic": 6.5,
        "max_aesthetic": 9.0,
        "min_user_rating": 3,
        "date_from": "2026-01-01",
        "date_to": "2026-01-31",
        "folder": "L:/pics",
        "has_metadata": True,
        "sort_by": "aesthetic",
        "limit": 50,
        "offset": 10,
    }


def test_search_omits_unset_filters_and_clamps_limit(recorder):
    recorder.response = {"images": [], "has_more": False, "total": 0}
    mcp_server.search_images(limit=9999)
    params = recorder.calls[0]["params"]
    assert params["limit"] == mcp_server.SEARCH_LIMIT_MAX
    assert "tags" not in params and "date_from" not in params
    # sort_by has a default and must still ride along
    assert params["sort_by"] == "newest"


def test_search_slims_rows_to_context_friendly_shape(recorder):
    recorder.response = {
        "images": [
            {
                "id": 7,
                "filename": "a.png",
                "path": "L:/a.png",
                "generator": "nai",
                "rating": "general",
                "width": 1024,
                "height": 1536,
                "aesthetic_score": 7.1,
                "user_rating": 4,
                "library_order_time": "2026-01-07 10:00:00",
                "prompt": "SHOULD BE DROPPED",
                "metadata_json": "{}",
            }
        ],
        "has_more": True,
        "total": 41,
    }
    out = mcp_server.search_images()
    row = out["images"][0]
    assert row["file_time"] == "2026-01-07 10:00:00"
    assert "prompt" not in row and "metadata_json" not in row
    assert out["total"] == 41 and out["has_more"] is True


def test_count_uses_count_endpoint_with_same_param_names(recorder):
    recorder.response = {"total": 3}
    mcp_server.count_images(date_from="2026-05-01", date_to="2026-05-31")
    call = recorder.calls[0]
    assert (call["method"], call["path"]) == ("GET", "/api/images/count")
    assert call["params"] == {"date_from": "2026-05-01", "date_to": "2026-05-31"}


def test_get_image_semantic_and_stats_paths(recorder):
    recorder.response = {"results": [], "total": 0}
    mcp_server.get_image(42)
    mcp_server.semantic_search("silver hair girl", limit=500)
    mcp_server.library_stats()
    paths = [(c["method"], c["path"]) for c in recorder.calls]
    assert paths == [
        ("GET", "/api/images/42"),
        ("POST", "/api/similarity/search-text"),
        ("GET", "/api/entry/summary"),
    ]
    assert recorder.calls[1]["json"] == {
        "query": "silver hair girl",
        "limit": mcp_server.SEMANTIC_LIMIT_MAX,
    }


def test_list_library_routes_facets_correctly(recorder):
    recorder.response = []
    mcp_server.list_library("tags", q="hair")
    mcp_server.list_library("loras")
    assert recorder.calls[0]["path"] == "/api/tags/library"
    assert recorder.calls[0]["params"] == {"q": "hair", "limit": 50}
    # checkpoints/loras/prompts live at the API ROOT, not under /api/tags/
    assert recorder.calls[1]["path"] == "/api/loras/library"
    with pytest.raises(RuntimeError, match="Unknown facet"):
        mcp_server.list_library("collections")


def test_bulk_tag_tools_send_image_id_scope(recorder):
    recorder.response = {"status": "ok"}
    mcp_server.add_tags([1, 2], ["silver_hair"], dry_run=True)
    mcp_server.remove_tags([3], ["blurry"])
    assert recorder.calls[0]["path"] == "/api/tags/bulk/add"
    assert recorder.calls[0]["json"] == {
        "image_ids": [1, 2],
        "tags": ["silver_hair"],
        "dry_run": True,
    }
    assert recorder.calls[1]["path"] == "/api/tags/bulk/remove"
    assert recorder.calls[1]["json"] == {
        "image_ids": [3],
        "tags": ["blurry"],
        "dry_run": False,
    }
    with pytest.raises(RuntimeError):
        mcp_server.add_tags([], ["x"])


def test_export_dataset_payload_and_required_fields(recorder):
    recorder.response = {"status": "ok"}
    mcp_server.export_dataset(
        [5, 6],
        "L:/out",
        trigger="mychar",
        trainer_config="kohya_toml",
        trainer_repeats=7,
        trainer_keep_tokens=1,
    )
    call = recorder.calls[0]
    assert call["path"] == "/api/dataset/export"
    assert call["json"] == {
        "image_ids": [5, 6],
        "output_folder": "L:/out",
        "trigger": "mychar",
        "trainer_config": "kohya_toml",
        "trainer_repeats": 7,
        "trainer_keep_tokens": 1,
    }
    with pytest.raises(RuntimeError, match="output_folder"):
        mcp_server.export_dataset([1], "  ")


def test_connection_refused_yields_bilingual_start_hint(monkeypatch):
    import httpx

    def boom(*_args, **_kwargs):
        raise httpx.ConnectError("refused")

    monkeypatch.setattr(mcp_server.httpx, "request", boom)
    with pytest.raises(RuntimeError) as excinfo:
        mcp_server.library_stats()
    message = str(excinfo.value)
    assert "not running" in message and "run.bat" in message and "启动" in message


def test_http_error_surfaces_api_error_body(monkeypatch):
    import httpx

    def fake(*_args, **_kwargs):
        request = httpx.Request("GET", "http://127.0.0.1:8487/api/images/999")
        return httpx.Response(404, json={"error": "Image not found"}, request=request)

    monkeypatch.setattr(mcp_server.httpx, "request", fake)
    with pytest.raises(RuntimeError, match="404.*Image not found"):
        mcp_server.get_image(999)


def test_registration_exposes_the_full_approved_tool_set():
    pytest.importorskip("mcp")
    server = mcp_server.build_server()
    names = {tool.__name__ for tool in mcp_server._TOOLS}
    assert names == {
        "search_images",
        "count_images",
        "get_image",
        "semantic_search",
        "list_library",
        "add_tags",
        "remove_tags",
        "export_dataset",
        "library_stats",
    }
    assert server is not None
