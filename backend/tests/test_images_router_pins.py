"""Characterization pins for routers/images.py (decomposition step 0).

``backend/routers/images.py`` (1,863 lines, ~40 endpoints) is the first ROUTER
in the decomposition campaign. These pins lock the load-bearing, currently
UNCOVERED seams so a later split into a ``routers/images_parts/`` family — all
registering on the SAME module-level ``router`` object — can be proven
behavior-preserving. The existing reader nets (test_routers/test_images.py,
test_routers/test_images_count.py, test_repair_review.py, test_user_rating.py,
test_reconnect_missing_files.py) already cover the happy paths; this file closes
the router-boundary gaps they do not touch:

1. Route REGISTRATION ORDER — the "declared above GET /api/images/{image_id}"
   invariant. FastAPI matches in registration order, so the single-segment
   static GET routes (count / repair-candidates / selection-chunk) MUST stay
   registered before the dynamic ``{image_id}`` route or they 422-shadow. A
   split that re-imports groups in the wrong order silently breaks this.
2. The DI seam — ``get_image_service`` / ``set_image_service`` are the module
   ServiceProvider's bound methods; main.py + conftest bind through them.
3. The module import surface — ``router`` prefix, the request models, the four
   upload constants, and the module-object patch seams (``PARSE_IMAGE_UPLOAD_
   MAX_BYTES`` and ``sys`` / ``subprocess`` on the open-folder path).
4. Request-model mutual-exclusion validators (the 400/422 contracts).
5. The v3.2.2 singular-alias merge on GET /api/images and /api/images/count.
6. The 0-covered thin passthroughs a split could misroute (thumbnail-cache
   trio, cancel/reset idle endpoints, bulk-job cancel success, the sync
   selection-token delete/remove branches, the save-edited 400 mapping).
7. The source-text architecture contract (the file MUST stay a FILE and must
   not import ``database``/``metadata_parser`` — restated from
   test_router_service_boundaries.py so this file self-documents the landmine).

Machine-state isolation: unit pins touch no DB and restore the DI provider in a
finally; HTTP pins use the standard test_client (its own temp DB) and only
monkeypatch the SAFE ``move_file_to_trash`` module seam. No real data/images.db.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pydantic
import pytest
from PIL import Image

import routers.images as images_router
from routers.images import (
    DeleteSelectedImagesRequest,
    ExportSelectionRequest,
    ImageCaptionPatchRequest,
    OpenFolderRequest,
    RemoveSelectedImagesRequest,
    RepairConfirmRequest,
    SaveEditedMetadataRequest,
    SelectionIdsRequest,
    SelectionTokenRequest,
    SetUserRatingRequest,
    get_image_service,
    set_image_service,
)
from services.service_provider import ServiceProvider


# The full (verb, path) surface today. A pure decomposition MUST keep every one
# of these registered on the shared ``router``; this is the primary anti-drop
# net for the split (subset check, so unrelated later additions do not break it).
EXPECTED_ROUTES = {
    ("GET", "/api/images"),
    ("GET", "/api/folders"),
    ("GET", "/api/library-roots"),
    ("POST", "/api/images/selection-token"),
    ("GET", "/api/images/selection-chunk"),
    ("POST", "/api/images/reconnect-missing/start"),
    ("GET", "/api/images/reconnect-missing/progress"),
    ("POST", "/api/images/reconnect-missing/cancel"),
    ("GET", "/api/images/repair-candidates"),
    ("POST", "/api/images/repair-confirm"),
    ("GET", "/api/images/count"),
    ("GET", "/api/images/{image_id}"),
    ("PATCH", "/api/images/{image_id}/caption"),
    ("POST", "/api/images/export-data"),
    ("POST", "/api/images/selection-ids"),
    ("POST", "/api/images/count"),
    ("POST", "/api/images/delete-selected"),
    ("POST", "/api/images/delete-selected/start"),
    ("GET", "/api/images/delete-selected/progress"),
    ("POST", "/api/images/delete-selected/cancel"),
    ("POST", "/api/images/delete-selected/reset"),
    ("POST", "/api/images/remove-selected"),
    ("POST", "/api/images/remove-selected/start"),
    ("GET", "/api/images/remove-selected/progress"),
    ("POST", "/api/images/remove-selected/cancel"),
    ("POST", "/api/images/remove-selected/reset"),
    ("GET", "/api/bulk-jobs"),
    ("GET", "/api/bulk-jobs/{job_id}"),
    ("POST", "/api/bulk-jobs/{job_id}/cancel"),
    ("POST", "/api/images/{image_id}/reparse"),
    ("POST", "/api/images/{image_id}/rating"),
    ("POST", "/api/image-metadata/save-edited"),
    ("GET", "/api/image-file/{image_id}"),
    ("GET", "/api/image-thumbnail/{image_id}"),
    ("GET", "/api/image-preview-by-path"),
    ("GET", "/api/thumbnail-cache/stats"),
    ("POST", "/api/thumbnail-cache/clear"),
    ("POST", "/api/thumbnail-cache/cleanup"),
    ("POST", "/api/open-folder"),
    ("POST", "/api/parse-image"),
}


def _actual_routes():
    """(verb, path) pairs registered on the images router (HEAD/OPTIONS dropped)."""
    pairs = set()
    for route in images_router.router.routes:
        methods = getattr(route, "methods", None)
        if not methods:
            continue
        for method in methods:
            if method in {"HEAD", "OPTIONS"}:
                continue
            pairs.add((method, route.path))
    return pairs


def _route_index(verb: str, path: str) -> int:
    """Registration index of a (verb, path) route in the shared router."""
    for index, route in enumerate(images_router.router.routes):
        methods = getattr(route, "methods", None)
        if methods and verb in methods and route.path == path:
            return index
    raise AssertionError(f"route {verb} {path} is not registered")


# ---------------------------------------------------------------------------
# 1. Module import surface — the names external code (main.py, conftest, the
#    reader suites) binds to. A split that relocates these must keep them
#    re-exported from routers.images or these imports/reads go red.
# ---------------------------------------------------------------------------
class TestModuleImportSurface:
    def test_router_is_apirouter_with_api_prefix(self):
        from fastapi import APIRouter

        assert isinstance(images_router.router, APIRouter)
        assert images_router.router.prefix == "/api"

    def test_full_endpoint_surface_is_still_registered(self):
        # Anti-drop net: every endpoint that exists today must survive the
        # split on the SAME router object. Subset (not equality) so additive
        # work elsewhere in the campaign does not spuriously fail this pin.
        missing = EXPECTED_ROUTES - _actual_routes()
        assert not missing, f"routes dropped from the images router: {sorted(missing)}"

    def test_service_provider_is_the_module_di_holder(self):
        assert isinstance(images_router._image_service_provider, ServiceProvider)

    def test_upload_constants_exist_with_expected_types(self):
        assert isinstance(images_router.READER_UPLOAD_TEMP_DIR, Path)
        assert isinstance(images_router.READER_UPLOAD_TTL_SECONDS, int)
        assert isinstance(images_router.PARSE_IMAGE_UPLOAD_MAX_BYTES, int)
        assert isinstance(images_router.PARSE_IMAGE_UPLOAD_CHUNK_SIZE, int)

    def test_open_folder_reads_sys_and_subprocess_as_module_globals(self):
        # test_routers/test_images.py::test_open_folder_selects_existing_image
        # patches images_router.sys.platform and images_router.subprocess.Popen.
        # The open-folder read-site must resolve these module globals (whichever
        # submodule ends up owning it) — pinned here so the seam is documented.
        assert images_router.sys is sys
        assert images_router.subprocess is subprocess

    def test_prompt_match_mode_constants_are_stable(self):
        assert images_router.PROMPT_MATCH_MODE_EXACT == "exact"
        assert images_router.PROMPT_MATCH_MODE_CONTAINS == "contains"
        assert images_router.VALID_PROMPT_MATCH_MODES == {"exact", "contains"}


# ---------------------------------------------------------------------------
# 2. DI seam — get/set are the provider's bound methods. main.py and conftest
#    both call images.set_image_service(...) and the endpoints resolve the
#    instance via Depends(get_image_service).
# ---------------------------------------------------------------------------
class TestDependencyInjectionSeam:
    def test_get_and_set_are_bound_to_the_module_provider(self):
        assert get_image_service.__self__ is images_router._image_service_provider
        assert set_image_service.__self__ is images_router._image_service_provider

    def test_set_image_service_swaps_the_instance_get_returns(self):
        provider = images_router._image_service_provider
        original = provider._instance
        sentinel = object()
        try:
            set_image_service(sentinel)
            assert get_image_service() is sentinel
        finally:
            provider.set(original)


# ---------------------------------------------------------------------------
# 3. Route registration ORDER — the load-bearing "declared above
#    GET /api/images/{image_id}" invariant. Pinned structurally (registration
#    index) and behaviorally (the static routes win over the dynamic id route).
# ---------------------------------------------------------------------------
class TestStaticRoutesPrecedeDynamicImageId:
    @pytest.mark.parametrize(
        "static_path",
        [
            "/api/images/count",
            "/api/images/repair-candidates",
            "/api/images/selection-chunk",
        ],
    )
    def test_static_get_route_registered_before_dynamic_id(self, static_path):
        dynamic_index = _route_index("GET", "/api/images/{image_id}")
        assert _route_index("GET", static_path) < dynamic_index

    def test_count_route_not_shadowed_by_image_id(self, test_client):
        resp = test_client.get("/api/images/count")
        assert resp.status_code == 200
        assert "total" in resp.json()

    def test_repair_candidates_route_not_shadowed_by_image_id(
        self, test_client, test_db
    ):
        resp = test_client.get("/api/images/repair-candidates")
        assert resp.status_code == 200
        assert "total" in resp.json()

    def test_selection_chunk_route_not_shadowed_by_image_id(self, test_client):
        # A 400 (bad token) proves the selection-chunk route matched; a 422
        # would mean {image_id} captured the literal "selection-chunk".
        resp = test_client.get(
            "/api/images/selection-chunk",
            params={"selection_token": "not-a-token", "offset": 0, "limit": 10},
        )
        assert resp.status_code == 400


# ---------------------------------------------------------------------------
# 4. Request-model validators — the mutual-exclusion + normalization contracts
#    that produce the router's 400/422 responses. Unit level so a split that
#    relocates a model still proves the accept/reject surface.
# ---------------------------------------------------------------------------
class TestRequestModelValidators:
    @pytest.mark.parametrize(
        "model", [DeleteSelectedImagesRequest, RemoveSelectedImagesRequest]
    )
    def test_ids_xor_token_required(self, model):
        with pytest.raises(pydantic.ValidationError):
            model()  # neither ids nor token
        with pytest.raises(pydantic.ValidationError):
            model(image_ids=[1], selection_token="tok")  # both
        assert model(image_ids=[1]).image_ids == [1]
        assert model(selection_token="tok").selection_token == "tok"

    def test_delete_request_defaults_are_conservative(self):
        req = DeleteSelectedImagesRequest(image_ids=[1])
        assert req.confirm_delete_files is False
        assert req.background is False

    def test_export_selection_request_ids_xor_token_and_limit_bound(self):
        with pytest.raises(pydantic.ValidationError):
            ExportSelectionRequest()
        with pytest.raises(pydantic.ValidationError):
            ExportSelectionRequest(image_ids=[1], selection_token="tok")
        with pytest.raises(pydantic.ValidationError):
            ExportSelectionRequest(image_ids=[1], limit=10001)  # le=10000
        assert ExportSelectionRequest(image_ids=[1], limit=2000).limit == 2000

    def test_selection_ids_request_normalizes_prompt_match_mode(self):
        assert (
            SelectionIdsRequest(promptMatchMode="CONTAINS ").promptMatchMode
            == "contains"
        )
        assert SelectionIdsRequest().promptMatchMode == "exact"
        assert SelectionIdsRequest().tagMode == "and"
        with pytest.raises(pydantic.ValidationError):
            SelectionIdsRequest(promptMatchMode="fuzzy")

    def test_selection_token_request_extends_ids_request_with_chunk_bounds(self):
        assert issubclass(SelectionTokenRequest, SelectionIdsRequest)
        assert SelectionTokenRequest().chunkSize == 2000
        with pytest.raises(pydantic.ValidationError):
            SelectionTokenRequest(chunkSize=0)  # ge=1
        with pytest.raises(pydantic.ValidationError):
            SelectionTokenRequest(chunkSize=10001)  # le=10000

    def test_set_user_rating_request_bounds_stars_0_to_5(self):
        assert SetUserRatingRequest(stars=0).stars == 0
        assert SetUserRatingRequest(stars=5).stars == 5
        for bad in (-1, 6):
            with pytest.raises(pydantic.ValidationError):
                SetUserRatingRequest(stars=bad)

    def test_repair_confirm_request_action_is_enumerated(self):
        assert RepairConfirmRequest(review_id=1, action="pick").action == "pick"
        with pytest.raises(pydantic.ValidationError):
            RepairConfirmRequest(review_id=1, action="bogus")
        with pytest.raises(pydantic.ValidationError):
            RepairConfirmRequest(review_id=0, action="skip")  # ge=1

    def test_image_caption_patch_tracks_present_fields_for_explicit_clear(self):
        # The endpoint uses model_fields_set to write only the keys the client
        # sent (empty-string nl_caption clears NL without touching ai_caption).
        req = ImageCaptionPatchRequest(nl_caption="")
        assert req.model_fields_set & {"ai_caption", "nl_caption"} == {"nl_caption"}

    def test_save_edited_metadata_request_rejects_blank_paths_and_format(self):
        with pytest.raises(pydantic.ValidationError):
            SaveEditedMetadataRequest(source_path="", output_path="o.png", format="png")
        with pytest.raises(pydantic.ValidationError):
            SaveEditedMetadataRequest(
                source_path="s.png", output_path="o.png", format=""
            )

    def test_open_folder_request_image_id_optional(self):
        assert OpenFolderRequest().image_id is None
        assert OpenFolderRequest(image_id=7).image_id == 7


# ---------------------------------------------------------------------------
# 5. v3.2.2 singular-alias merge — ``?generator=`` / ``?tag=`` etc. are folded
#    into the plural filters (the branch the reader suites never take because
#    they always pass the plural form).
# ---------------------------------------------------------------------------
class TestSingularAliasMerge:
    def test_get_images_accepts_singular_generator_alias(self, test_client, tmp_path):
        comfy = tmp_path / "alias-comfy.png"
        nai = tmp_path / "alias-nai.png"
        Image.new("RGB", (16, 16), "white").save(comfy)
        Image.new("RGB", (16, 16), "white").save(nai)
        comfy_id = test_client.test_db.add_image(
            path=str(comfy),
            filename=comfy.name,
            generator="comfyui",
            metadata_json="{}",
        )
        test_client.test_db.add_image(
            path=str(nai), filename=nai.name, generator="nai", metadata_json="{}"
        )

        resp = test_client.get("/api/images", params={"generator": "comfyui"})

        assert resp.status_code == 200
        assert [img["id"] for img in resp.json()["images"]] == [comfy_id]

    def test_count_endpoint_accepts_singular_generator_alias(
        self, test_client, test_db_with_images
    ):
        singular = test_client.get("/api/images/count", params={"generator": "comfyui"})
        plural = test_client.get("/api/images/count", params={"generators": "comfyui"})
        assert singular.status_code == 200
        assert singular.json()["total"] == 1
        assert plural.json()["total"] == 1


# ---------------------------------------------------------------------------
# 6. Thin passthroughs the reader suites never call. Each is 0-covered today
#    and a split could drop or misroute it; these pin the wiring (200 + dict)
#    without over-asserting the service payload shape.
# ---------------------------------------------------------------------------
class TestThinWiringEndpoints:
    @pytest.mark.parametrize(
        "method,path",
        [
            ("get", "/api/thumbnail-cache/stats"),
            ("post", "/api/thumbnail-cache/clear"),
            ("post", "/api/thumbnail-cache/cleanup"),
            ("post", "/api/images/delete-selected/cancel"),
            ("post", "/api/images/delete-selected/reset"),
            ("post", "/api/images/remove-selected/cancel"),
            ("post", "/api/images/remove-selected/reset"),
            ("post", "/api/images/reconnect-missing/cancel"),
        ],
    )
    def test_endpoint_is_wired_and_returns_dict(self, test_client, method, path):
        resp = getattr(test_client, method)(path)
        assert resp.status_code == 200
        assert isinstance(resp.json(), dict)

    def test_bulk_job_cancel_returns_the_job_when_found(
        self, test_client, test_db, tmp_path
    ):
        # cancel of a known job id must not 404 (the reader suite only pins the
        # unknown-id 404). TestClient runs the BackgroundTask synchronously, so
        # the job is terminal by cancel time and cancel returns the job dict.
        image_path = tmp_path / "cancel-job.png"
        Image.new("RGB", (8, 8), "white").save(image_path)
        image_id = test_client.test_db.add_image(
            path=str(image_path), filename=image_path.name, metadata_json="{}"
        )
        start = test_client.post(
            "/api/images/remove-selected",
            json={"image_ids": [image_id], "background": True},
        )
        job_id = start.json()["id"]

        resp = test_client.post(f"/api/bulk-jobs/{job_id}/cancel")

        assert resp.status_code == 200
        assert resp.json()["id"] == job_id


# ---------------------------------------------------------------------------
# 6b. The sync selection-token branches of delete/remove — the reader suites
#     only exercise the explicit-ids branch, leaving the ``by_token`` calls
#     (routers/images.py:1341 delete, 1427 remove) uncovered.
# ---------------------------------------------------------------------------
class TestSyncSelectionTokenBranches:
    def _token_for_whole_library(self, test_client) -> str:
        resp = test_client.post("/api/images/selection-token", json={})
        assert resp.status_code == 200
        return resp.json()["selection_token"]

    def test_remove_selected_by_token_removes_rows_keeps_file(
        self, test_client, test_db, tmp_path
    ):
        image_path = tmp_path / "token-remove.png"
        Image.new("RGB", (8, 8), "white").save(image_path)
        image_id = test_client.test_db.add_image(
            path=str(image_path), filename=image_path.name, metadata_json="{}"
        )
        token = self._token_for_whole_library(test_client)

        resp = test_client.post(
            "/api/images/remove-selected", json={"selection_token": token}
        )

        assert resp.status_code == 200
        assert resp.json()["removed"] == 1
        assert image_path.exists()  # remove keeps the file
        assert test_client.test_db.get_image_by_id(image_id) is None

    def test_delete_selected_by_token_trashes_files(
        self, test_client, test_db, tmp_path, monkeypatch
    ):
        from services import image_service

        trashed = []

        def fake_trash(path):
            trashed.append(Path(path))
            Path(path).unlink()

        monkeypatch.setattr(image_service, "move_file_to_trash", fake_trash)

        image_path = tmp_path / "token-delete.png"
        Image.new("RGB", (8, 8), "white").save(image_path)
        image_id = test_client.test_db.add_image(
            path=str(image_path), filename=image_path.name, metadata_json="{}"
        )
        token = self._token_for_whole_library(test_client)

        resp = test_client.post(
            "/api/images/delete-selected",
            json={"selection_token": token, "confirm_delete_files": True},
        )

        assert resp.status_code == 200
        assert resp.json()["deleted"] == 1
        assert trashed == [image_path]
        assert test_client.test_db.get_image_by_id(image_id) is None


# ---------------------------------------------------------------------------
# 6c. The save-edited-metadata 400 mapping — the reader suite covers the 409
#     (exists / same-path) branch but not the ValueError -> 400 branch.
# ---------------------------------------------------------------------------
class TestSaveEditedMetadataErrorMapping:
    def test_format_extension_mismatch_maps_to_400(self, test_client, tmp_path):
        source = tmp_path / "mismatch.png"
        Image.new("RGB", (16, 16), "white").save(source)

        resp = test_client.post(
            "/api/image-metadata/save-edited",
            json={
                "source_path": str(source),
                "output_path": str(tmp_path / "out.webp"),
                "format": "png",  # png != .webp extension -> ValueError -> 400
                "metadata": {"prompt": "cat"},
            },
        )

        assert resp.status_code == 400


# ---------------------------------------------------------------------------
# 7. Source-text architecture contract (restated from
#    test_router_service_boundaries.py so this file self-documents the landmine):
#    the router MUST stay a FILE and must not reach past the service layer into
#    database / metadata_parser. A split into a package would break the literal
#    read_text() in the boundary test.
# ---------------------------------------------------------------------------
class TestSourceTextArchitectureContract:
    def _source(self) -> str:
        path = Path(images_router.__file__)
        assert path.name == "images.py", (
            "routers/images.py must stay a FILE, not a package"
        )
        return path.read_text(encoding="utf-8")

    def test_router_stays_a_file_and_delegates_to_the_service_layer(self):
        text = self._source()
        assert "import database as db" not in text
        assert "from metadata_parser import" not in text
