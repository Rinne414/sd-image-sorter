"""Every path that acts on "what the Gallery filter shows" must use the whole filter.

``SelectionIdsRequest`` is the complete Gallery filter contract: "select all
matches" is built on it. Auto-Separate (preview and move), Manual Sort, bulk tag
edits by filter and VLM batch captions by filter each keep their own copy of
that key list. When a filter reaches the Gallery but not one of the copies,
that path acts on MORE pictures than the Gallery showed. Found 2026-09-30: the
file date, saturation, no-caption, seed and "unscored" filters were dropped by
all four, so "last 7 days + ComfyUI" in the Gallery moved every ComfyUI picture.

The key list here is derived from ``SelectionIdsRequest``, so a new Gallery
filter fails these tests until every copy carries it. The tests call the real
functions (backend) or execute the shipped scripts in node (frontend); none of
them assert on source text alone.
"""

from __future__ import annotations

import asyncio
import json
import re
import shutil
import subprocess
from pathlib import Path

import pytest
from fastapi import BackgroundTasks

import database
import services.sorting_service as ss
from services.sorting_models import SortFilterRequest
from routers.images import SelectionIdsRequest

REPO_ROOT = Path(__file__).resolve().parents[2]

# Ordering, not scope: it never changes which pictures match.
NON_SCOPE_FIELDS = {"sortBy"}

# One valid value per Gallery filter key. A new key must get a value here
# (test_sample_values_cover_the_gallery_contract enforces it).
SAMPLE_VALUES = {
    "generators": ["comfyui"],
    "tags": ["1girl"],
    "tagMode": "or",
    "ratings": ["general"],
    "checkpoints": ["ckpt_a"],
    "loras": ["lora_a"],
    "prompts": ["smile"],
    "promptMatchMode": "contains",
    "artist": "someone",
    "search": "hat",
    "folder": "L:/library/sub",
    "hasMetadata": True,
    "minWidth": 100,
    "maxWidth": 4000,
    "minHeight": 100,
    "maxHeight": 4000,
    "aspectRatio": "portrait",
    "minAesthetic": 5.0,
    "maxAesthetic": 9.0,
    "minUserRating": 3,
    "brightnessMin": 10.0,
    "brightnessMax": 200.0,
    "colorTemperature": "warm",
    "brightnessDistribution": "balanced",
    "excludeTags": ["bad_hands"],
    "excludeGenerators": ["nai"],
    "excludeRatings": ["explicit"],
    "excludeCheckpoints": ["ckpt_b"],
    "excludeLoras": ["lora_b"],
    "excludePrompts": ["blurry"],
    "excludeColors": ["red"],
    "colorHues": ["blue"],
    "excludeColorHues": ["green"],
    "collectionId": 7,
    "scope": "current_session",
    "noCaption": True,
    "aestheticUnscored": True,
    "minSaturation": 20.0,
    "maxSaturation": 120.0,
    "seed": 12345,
    "dateFrom": "2026-01-01",
    "dateTo": "2026-09-30",
    "animeGrades": ["best"],
    "minWaifu": 5.0,
    "maxWaifu": 9.0,
}

# The database layer names two filters differently from the request layer.
DB_NAMES = {"search": "search_query", "prompts": "prompt_terms"}

# Modifiers of other filters: on their own they do not narrow the picture set.
MODIFIER_FIELDS = {"tagMode", "promptMatchMode", "scope"}

# Keys API.batchMove / API.startSortSession take as positional arguments; every
# other Gallery key rides the scope-filter bundle.
POSITIONAL_SORT_KEYS = {
    "generators",
    "tags",
    "ratings",
    "checkpoints",
    "loras",
    "prompts",
    "minWidth",
    "maxWidth",
    "minHeight",
    "maxHeight",
    "aspectRatio",
    "search",
    "minAesthetic",
    "maxAesthetic",
    "artist",
    "promptMatchMode",
    "tagMode",
    "excludeTags",
    "excludeGenerators",
    "excludeRatings",
    "excludeCheckpoints",
    "excludeLoras",
}


def _canonical_keys():
    return sorted(set(SelectionIdsRequest.model_fields) - NON_SCOPE_FIELDS)


def _snake(name: str) -> str:
    return re.sub(r"(?<!^)(?=[A-Z])", "_", name).lower()


def _snake_sample(keys=None):
    return {_snake(key): SAMPLE_VALUES[key] for key in (keys or _canonical_keys())}


def _missing(kwargs: dict, names) -> list:
    return [name for name in names if kwargs.get(name) in (None, [], "")]


@pytest.fixture
def svc(tmp_path, monkeypatch):
    """A fresh SortingService with its persisted-session files redirected."""
    monkeypatch.setattr(
        ss, "SESSION_FILE", str(tmp_path / "session.json"), raising=False
    )
    monkeypatch.setattr(
        ss, "LEGACY_SESSION_FILE", str(tmp_path / "legacy.json"), raising=False
    )
    return ss.SortingService()


def test_sample_values_cover_the_gallery_contract():
    missing = [key for key in _canonical_keys() if key not in SAMPLE_VALUES]
    assert not missing, f"give these new Gallery filters a sample value: {missing}"
    SelectionIdsRequest(**{key: SAMPLE_VALUES[key] for key in _canonical_keys()})


def test_sort_filter_request_accepts_every_gallery_filter():
    missing = [
        _snake(key)
        for key in _canonical_keys()
        if _snake(key) not in SortFilterRequest.model_fields
    ]
    assert not missing, f"Auto-Separate / Manual Sort requests drop: {missing}"


@pytest.mark.parametrize(
    "key", [key for key in sorted(SAMPLE_VALUES) if key not in MODIFIER_FIELDS]
)
def test_batch_move_accepts_any_single_gallery_filter(key, tmp_path):
    """A move scoped by one Gallery filter alone is a real filter, not "move everything"."""
    ss.BatchMoveRequest(destination_folder=str(tmp_path), **_snake_sample([key]))


def test_batch_move_counts_and_moves_with_every_gallery_filter(
    test_db, svc, tmp_path, monkeypatch
):
    seen = {}

    def fake_count(**kwargs):
        seen["count"] = kwargs
        return 1

    def fake_chunks(**kwargs):
        seen["ids"] = kwargs
        return iter(())

    monkeypatch.setattr(database, "get_filtered_image_count", fake_count)
    monkeypatch.setattr(database, "iter_filtered_image_id_chunks", fake_chunks)

    background_tasks = BackgroundTasks()
    svc.batch_move_images(
        ss.BatchMoveRequest(
            destination_folder=str(tmp_path / "out"), **_snake_sample()
        ),
        background_tasks,
    )
    background_tasks.tasks[0].func()

    names = [DB_NAMES.get(key, _snake(key)) for key in _canonical_keys()]
    assert not _missing(seen["count"], names), "the move count drops filters"
    assert not _missing(seen["ids"], names), "the moved id set drops filters"


def test_manual_sort_start_selects_with_every_gallery_filter(svc, monkeypatch):
    seen = {}

    def fake_ids(**kwargs):
        seen.update(kwargs)
        return []

    monkeypatch.setattr(database, "get_filtered_image_ids", fake_ids)

    svc.start_sort_session(**_snake_sample())

    names = [DB_NAMES.get(key, _snake(key)) for key in _canonical_keys()]
    assert not _missing(seen, names)


def test_sort_start_route_forwards_every_gallery_filter():
    from routers.sorting import start_sort_session

    seen = {}

    class FakeService:
        def start_sort_session(self, **kwargs):
            seen.update(kwargs)
            return {"total_images": 0}

    request = ss.ManualSortStartRequest(**_snake_sample())
    asyncio.run(start_sort_session(request=request, service=FakeService()))

    assert not _missing(seen, [_snake(key) for key in _canonical_keys()])


def test_bulk_tag_filter_contract_reaches_the_query_with_every_gallery_filter():
    from routers.tags_bulk import _filter_contract_db_kwargs
    from routers.tags_bulk_models import BulkTagFilterContract

    contract = BulkTagFilterContract(
        **{key: SAMPLE_VALUES[key] for key in _canonical_keys()}
    )
    kwargs = _filter_contract_db_kwargs(contract)

    names = [DB_NAMES.get(key, _snake(key)) for key in _canonical_keys()]
    assert not _missing(kwargs, names)


def test_vlm_batch_filters_reach_the_selection_with_every_gallery_filter():
    from routers.vlm_batch_source import _filters_to_selection_kwargs

    kwargs = _filters_to_selection_kwargs(
        {key: SAMPLE_VALUES[key] for key in _canonical_keys()}
    )

    assert not _missing(kwargs, [_snake(key) for key in _canonical_keys()])


@pytest.mark.parametrize("route_name", ["create_selection_token", "get_selection_ids", "count_filtered_images"])
def test_select_all_routes_forward_every_gallery_filter(route_name):
    """The POST routes behind "select all matches", its fallback and its count."""
    from routers.images_parts import export, selection
    from routers.images_parts.models import SelectionTokenRequest

    route = getattr(selection, route_name, None) or getattr(export, route_name)
    seen = {}

    class FakeService:
        def __getattr__(self, _name):
            def capture(**kwargs):
                seen.update(kwargs)
                return {}

            return capture

    request = SelectionTokenRequest(**{key: SAMPLE_VALUES[key] for key in _canonical_keys()})
    asyncio.run(route(request=request, service=FakeService()))

    assert not _missing(seen, [_snake(key) for key in _canonical_keys()])


# ---------------------------------------------------------------------------
# Selection tokens: "select all matches" encodes the filter into a token that
# delete, move, remove, tag edits, Smart Tag, VLM and exports read back.
# ---------------------------------------------------------------------------

UNTICKED_ID = 424242


def _sample_token(test_db) -> str:
    from services.image_service import ImageService

    return ImageService().create_selection_token(
        **_snake_sample(), excluded_image_ids=[UNTICKED_ID]
    )["selection_token"]


def test_selection_token_keeps_every_gallery_filter_through_decoding(test_db):
    from services.image_service import ImageService

    contract = ImageService()._decode_selection_token(_sample_token(test_db))

    missing = [key for key in _canonical_keys() if contract.get(key) in (None, [], "")]
    assert not missing, f"a decoded selection token drops: {missing}"
    assert contract["excludedImageIds"] == [UNTICKED_ID]


def test_every_token_reader_selects_with_every_gallery_filter(test_db, monkeypatch):
    from services.image_service import ImageService
    from services.tag_export_service import (
        count_selection_token_ids,
        iter_selection_token_id_chunks,
    )

    token = _sample_token(test_db)
    seen = {}

    def capture(name, result):
        def fake(**kwargs):
            seen.setdefault(name, []).append(kwargs)
            return result() if callable(result) else result

        return fake

    monkeypatch.setattr(
        database, "iter_filtered_image_id_chunks", capture("chunks", lambda: iter(()))
    )
    monkeypatch.setattr(database, "get_filtered_image_ids", capture("ids", []))
    monkeypatch.setattr(database, "get_filtered_image_count", capture("count", 0))

    service = ImageService()
    list(service._iter_selection_token_snapshot_chunks(token))  # delete / move / remove
    service.get_selection_chunk(token)  # the ids the Gallery selection shows
    list(iter_selection_token_id_chunks(token))  # tag edits, Smart Tag, VLM, exports
    count_selection_token_ids(token)

    names = [DB_NAMES.get(key, _snake(key)) for key in _canonical_keys()]
    names.append("excluded_image_ids")
    readers = [kwargs for calls in seen.values() for kwargs in calls]
    assert len(readers) == 4, seen.keys()
    for kwargs in readers:
        assert not _missing(kwargs, names), (
            f"a token reader drops: {_missing(kwargs, names)}"
        )


def test_delete_and_move_snapshot_spares_pictures_unticked_after_select_all(test_db):
    """Select all matches, untick one picture, Delete: the unticked one must stay."""
    from services.image_service import ImageService

    ids = [
        test_db.add_image(
            path=f"/lib/pick{index}.png",
            filename=f"pick{index}.png",
            generator="comfyui",
            metadata_json="{}",
        )
        for index in range(3)
    ]
    service = ImageService()
    token = service.create_selection_token(
        generators=["comfyui"], excluded_image_ids=[ids[1]]
    )["selection_token"]

    snapshot = [
        image_id
        for chunk in service._iter_selection_token_snapshot_chunks(token)
        for image_id in chunk
    ]

    assert sorted(snapshot) == sorted([ids[0], ids[2]])


def test_token_snapshot_keeps_the_date_range(test_db):
    from services.image_service import ImageService

    ids = {}
    for name, first_seen in (
        ("old.png", "2026-01-15 10:00:00"),
        ("new.png", "2026-07-02 10:00:00"),
    ):
        ids[name] = test_db.add_image(
            path=f"/lib/{name}", filename=name, generator="comfyui", metadata_json="{}"
        )
        with test_db.get_db() as conn:
            conn.execute(
                "UPDATE images SET library_order_time = ? WHERE id = ?",
                (first_seen, ids[name]),
            )
            conn.commit()
    service = ImageService()
    token = service.create_selection_token(date_from="2026-06-01")["selection_token"]

    snapshot = [
        image_id
        for chunk in service._iter_selection_token_snapshot_chunks(token)
        for image_id in chunk
    ]

    assert snapshot == [ids["new.png"]]


def test_vlm_batch_by_filters_captions_only_what_the_confirm_dialog_counted(test_db):
    """Nothing selected: VLM captions "every picture the Gallery filter shows"."""
    from routers.vlm_batch_source import _build_batch_image_source
    from routers.vlm_models import BatchCaptionRequest

    ids = {}
    for name, first_seen in (
        ("old.png", "2026-01-15 10:00:00"),
        ("new.png", "2026-07-02 10:00:00"),
    ):
        ids[name] = test_db.add_image(
            path=f"/lib/{name}", filename=name, generator="comfyui", metadata_json="{}"
        )
        with test_db.get_db() as conn:
            conn.execute(
                "UPDATE images SET library_order_time = ? WHERE id = ?",
                (first_seen, ids[name]),
            )
            conn.commit()

    source = _build_batch_image_source(
        BatchCaptionRequest(
            filters={"generators": ["comfyui"], "dateFrom": "2026-06-01"}
        )
    )
    captioned = [image_id for chunk in source.iter_chunks() for image_id in chunk]

    assert source.total == 1
    assert captioned == [ids["new.png"]]


def _write_png(path: Path) -> Path:
    from PIL import Image

    Image.new("RGB", (16, 16), color="white").save(path)
    return path


def test_auto_separate_moves_only_the_pictures_inside_the_date_range(
    test_db, svc, tmp_path
):
    """The reported shape: Gallery shows "ComfyUI, since June"; the move must match it."""
    library = tmp_path / "library"
    library.mkdir()
    destination = tmp_path / "picked"
    ids = {}
    for name, first_seen in (
        ("old.png", "2026-01-15 10:00:00"),
        ("new.png", "2026-07-02 10:00:00"),
    ):
        path = _write_png(library / name)
        ids[name] = test_db.add_image(
            path=str(path), filename=name, generator="comfyui", metadata_json="{}"
        )
        with test_db.get_db() as conn:
            conn.execute(
                "UPDATE images SET library_order_time = ? WHERE id = ?",
                (first_seen, ids[name]),
            )
            conn.commit()

    background_tasks = BackgroundTasks()
    started = svc.batch_move_images(
        ss.BatchMoveRequest(
            destination_folder=str(destination),
            operation="move",
            generators=["comfyui"],
            date_from="2026-06-01",
        ),
        background_tasks,
    )
    assert started.get("count") == 1 or started.get("total") == 1, started
    background_tasks.tasks[0].func()

    assert {p.name for p in destination.iterdir()} == {"new.png"}
    assert (library / "old.png").exists()


# ---------------------------------------------------------------------------
# Frontend: execute the shipped scripts in node.
# ---------------------------------------------------------------------------


def _run_node(script: str) -> dict:
    if shutil.which("node") is None:
        raise AssertionError("node is required to execute the shipped filter builders")
    result = subprocess.run(
        ["node", "-e", script],
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    if result.returncode != 0:
        raise AssertionError("node failed:\n" + result.stderr[-2000:])
    return json.loads(result.stdout)


def _js_path(*parts: str) -> str:
    return json.dumps(str(REPO_ROOT.joinpath("frontend", "js", *parts)))


def _frontend_builders_output() -> dict:
    sample = json.dumps({key: SAMPLE_VALUES[key] for key in _canonical_keys()})
    script = f"""
const fs = require('fs');
global.window = {{}};
global.localStorage = {{ getItem() {{ return null; }}, setItem() {{}} }};
const posted = [];
global.API = {{ post(url, body) {{ posted.push({{ url, body }}); return body; }} }};
global.normalizePromptMatchMode = (value) => value;
global.normalizeAspectRatioFilter = (value) => value;
const read = (p) => fs.readFileSync(p, 'utf8');
const load = new Function(
  read({_js_path("autosep", "state-constants.js")}) + '\\n' +
  read({_js_path("manual-sort", "state-constants.js")}) + '\\n' +
  read({_js_path("autosep", "operation-mode.js")}) + '\\n' +
  read({_js_path("autosep", "serialize.js")}) + '\\n' +
  read({_js_path("autosep", "preview.js")}) + '\\n' +
  read({_js_path("manual-sort", "i18n-helpers.js")}) + '\\n' +
  read({_js_path("manual-sort", "filters-scope.js")}) + '\\n' +
  read({_js_path("app", "api-features.js")}) + '\\n' +
  'return {{ serializeAutoSepFilters, buildAutoSepFilterContract, buildAutoSepScopeFilters, ' +
  '_buildAutoSepImageQuery, buildManualSortScopeFilters }};'
);
const fns = load();
const sample = {sample};
const contract = fns.buildAutoSepFilterContract(sample);
API.batchMove(null, null, null, 'out', null, null, null, null, null, null, 'move', null,
  'exact', 'and', null, fns.buildAutoSepScopeFilters(contract), null);
API.startSortSession(null, null, null, {{}}, null, null, null, null, null, null, 'copy', null,
  false, 'exact', 'and', null, null, 'slot', fns.buildManualSortScopeFilters(sample));
process.stdout.write(JSON.stringify({{
  serialized: fns.serializeAutoSepFilters(sample),
  previewQuery: fns._buildAutoSepImageQuery(sample),
  batchMoveWire: posted[0].body,
  sortStartWire: posted[1].body,
}}));
"""
    return _run_node(script)


@pytest.fixture(scope="module")
def frontend_output():
    return _frontend_builders_output()


def test_auto_separate_keeps_every_gallery_filter_when_copying(frontend_output):
    serialized = frontend_output["serialized"]
    missing = [
        key
        for key in _canonical_keys()
        if key != "scope" and serialized.get(key) in (None, [], "")
    ]
    assert not missing, f"serializeAutoSepFilters drops: {missing}"
    assert serialized["scope"] == "library"


def test_auto_separate_preview_counts_with_every_gallery_filter(frontend_output):
    query = frontend_output["previewQuery"]
    missing = [key for key in _canonical_keys() if query.get(key) in (None, [], "")]
    assert not missing, f"the Auto-Separate preview query drops: {missing}"


@pytest.mark.parametrize("wire", ["batchMoveWire", "sortStartWire"])
def test_sort_wire_carries_every_scope_bundle_filter(frontend_output, wire):
    body = frontend_output[wire]
    bundle_keys = [key for key in _canonical_keys() if key not in POSITIONAL_SORT_KEYS]
    missing = [
        _snake(key) for key in bundle_keys if body.get(_snake(key)) in (None, [], "")
    ]
    assert not missing, f"{wire} drops: {missing}"
