"""Characterization pins for services/censor_service.py (TIER-2 step 0).

These lock the load-bearing seams, safety invariants, and coercion quirks that a
by-feature decomposition of ``CensorService`` (2,306 lines) must not fracture.
Nothing here loads a real YOLO/SAM3 model or touches data/images.db: detectors
are stubbed, the class-level mask cache is redirected at ``tmp_path``, and the
model-health / model-path seams are monkeypatched on the module object exactly
the way the existing router suites patch them.

Priority order mirrors the split risk:
  1. Safety invariants — never-fallback-to-uncensored, metadata-leak strip,
     resource-budget 413 guards, actionable detection errors.
  2. Monkeypatch seams — module constants + ``get_model_health`` /
     ``get_default_legacy_model_path`` (read as bare module globals; a submodule
     re-importing them independently would make the facade patch miss).
  3. Class-level mask-cache state + the ``backend_file=__file__`` location trap.
"""

from __future__ import annotations

import base64
import os
import sys
import types
from pathlib import Path

import pytest
from PIL import Image, ImageDraw
from fastapi import HTTPException

# The reader suites run from backend/; make the import work standalone too.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services import censor_service as cs
from services.censor_service import (
    CensorService,
    CensorDetectRequest,
    MaskRefineRequest,
    TextSegmentRequest,
    BatchMaskRefineRequest,
    CensorApplyRequest,
    CensorSaveRequest,
    CensorSaveDataRequest,
    CensorSaveOperationsRequest,
    RemoveBackgroundRequest,
)


class TestModuleImportSurface:
    """Facade contract: what routers/tests import + what monkeypatches target."""

    def test_request_models_and_service_are_importable(self):
        # routers/censor.py imports all ten of these by name from
        # services.censor_service; a split must keep them resolvable there.
        assert CensorService().__class__.__name__ == "CensorService"
        for model in (
            CensorDetectRequest,
            MaskRefineRequest,
            TextSegmentRequest,
            BatchMaskRefineRequest,
            CensorApplyRequest,
            CensorSaveRequest,
            CensorSaveDataRequest,
            CensorSaveOperationsRequest,
            RemoveBackgroundRequest,
        ):
            assert isinstance(model, type)

    @pytest.mark.parametrize(
        "name",
        [
            "MAX_SAVE_DATA_BYTES",
            "MAX_SAVE_DATA_PIXELS",
            "MASK_INLINE_DATA_PIXEL_THRESHOLD",
            "MAX_EDIT_STROKE_POINTS",
            "MAX_EDIT_GEOMETRY_POINTS",
            "MAX_EDIT_OPERATION_COUNT",
            "MAX_FULL_IMAGE_FILTER_PIXELS",
        ],
    )
    def test_patched_constants_live_on_module(self, name):
        # test_resource_safety.py patches "services.censor_service.<name>" and
        # test_prompts_censor_similarity_artists.py patches them via the module
        # object; the read-sites resolve these as bare module globals, so they
        # must stay defined on the facade module (not only inside a submodule).
        assert isinstance(getattr(cs, name), int)

    @pytest.mark.parametrize(
        "name", ["get_model_health", "get_default_legacy_model_path"]
    )
    def test_model_health_seam_names_resolve_on_module(self, name):
        # These are imported from model_health at module top and patched as
        # censor_service.<name>; detect()/SAM3 methods/_resolve_legacy_model_path
        # read them as bare globals. Any submodule owning those methods must call
        # them through this module or the module-object patch misses.
        assert callable(getattr(cs, name))

    @pytest.mark.parametrize(
        "name", ["_mask_cache_lock", "_mask_cache_index", "_mask_cache_dir"]
    )
    def test_class_level_mask_cache_attrs_exist(self, name):
        # The mask cache is CLASS state (shared across instances); tests patch
        # CensorService._mask_cache_dir and reset _mask_cache_index directly.
        assert hasattr(CensorService, name)


class TestDetectionErrorMapper:
    """`_detection_error_to_http` — actionable, categorized failures (safety UX).

    Fully uncovered by the reader suites; pure function of an exception.
    """

    def test_unidentified_image_maps_to_422(self):
        from PIL import UnidentifiedImageError

        exc = CensorService._detection_error_to_http(
            UnidentifiedImageError("cannot identify image file")
        )
        assert exc.status_code == 422

    def test_missing_dependency_keeps_pip_hint_as_503(self):
        exc = CensorService._detection_error_to_http(
            RuntimeError("nudenet not installed. Run: pip install nudenet")
        )
        assert exc.status_code == 503
        assert "pip install nudenet" in exc.detail

    def test_import_error_maps_to_503(self):
        exc = CensorService._detection_error_to_http(
            ImportError("No module named 'onnxruntime'")
        )
        assert exc.status_code == 503

    def test_missing_model_file_maps_to_503(self):
        exc = CensorService._detection_error_to_http(
            FileNotFoundError("model file not found: x.onnx")
        )
        assert exc.status_code == 503

    def test_unknown_error_stays_500_but_echoes_cause(self):
        # The fallback is no longer cause-free: the real message survives.
        exc = CensorService._detection_error_to_http(ValueError("some weird failure"))
        assert exc.status_code == 500
        assert "some weird failure" in exc.detail


class TestTargetFamilyNormalization:
    """Alias folding + the None-vs-empty target-list quirk (pure)."""

    @pytest.mark.parametrize(
        "label,family",
        [
            ("buttocks_exposed", "buttocks"),
            ("BUTT", "buttocks"),
            ("female_breast_exposed", "breasts"),
            ("tits", "breasts"),
            ("vagina", "pussy"),
            ("penis", "dick"),
            ("butthole", "anus"),
            ("semen", "cum"),
            ("face", "face"),  # unknown label passes through normalized
        ],
    )
    def test_alias_folding(self, label, family):
        assert CensorService._normalize_target_family(label) == family

    def test_none_targets_returns_all_detections(self):
        dets = [{"class": "face"}, {"class": "tree"}]
        assert CensorService._filter_detections_by_targets(dets, None) == dets

    def test_blank_targets_returns_nothing(self):
        # QUIRK: an all-blank list is NOT the same as None — it filters to [].
        dets = [{"class": "breasts"}]
        assert CensorService._filter_detections_by_targets(dets, ["", "  "]) == []

    def test_family_filter_matches_aliases(self):
        dets = [{"class": "buttocks_exposed"}, {"class": "face"}]
        out = CensorService._filter_detections_by_targets(dets, ["buttocks"])
        assert [d["class"] for d in out] == ["buttocks_exposed"]


class TestOutputSafetyHelpers:
    """Filename/format/path-traversal + base64 decode guards (safety)."""

    @pytest.mark.parametrize(
        "raw,expected",
        [
            ("", "_censored"),
            ("abc", "_abc"),
            ("_keep", "_keep"),
            ("-dash", "-dash"),
            ("a b*c", "_abc"),
            ("///", "_censored"),
        ],
    )
    def test_sanitize_suffix(self, raw, expected):
        assert CensorService._sanitize_suffix(raw) == expected

    def test_sanitize_suffix_truncates_to_64(self):
        out = CensorService._sanitize_suffix("z" * 100)
        assert len(out) == 64
        assert out.startswith("_z")

    @pytest.mark.parametrize("fmt", ["png", "PNG", " jpeg ", "webp", "jpg"])
    def test_normalize_output_format_accepts_allowlist(self, fmt):
        assert CensorService._normalize_output_format(fmt) == fmt.strip().lower()

    @pytest.mark.parametrize("fmt", ["gif", "", "bmp", "tiff"])
    def test_normalize_output_format_rejects_others(self, fmt):
        with pytest.raises(HTTPException) as exc:
            CensorService._normalize_output_format(fmt)
        assert exc.value.status_code == 400

    def test_ensure_output_path_allows_direct_child(self, tmp_path):
        out = CensorService._ensure_output_path(str(tmp_path), "ok.png")
        assert out == str((tmp_path / "ok.png").resolve())

    @pytest.mark.parametrize("name", ["../evil.png", "sub/evil.png"])
    def test_ensure_output_path_blocks_escape(self, tmp_path, name):
        with pytest.raises(HTTPException) as exc:
            CensorService._ensure_output_path(str(tmp_path), name)
        assert exc.value.status_code == 400

    def test_decode_base64_strips_data_url_prefix(self):
        raw, data = CensorService._decode_base64_image("data:image/png;base64,QUJD")
        assert raw == b"ABC"
        assert data == "QUJD"

    def test_decode_base64_rejects_garbage(self):
        with pytest.raises(HTTPException) as exc:
            CensorService._decode_base64_image("@@@@")
        assert exc.value.status_code == 400

    def test_decode_base64_rejects_empty(self):
        with pytest.raises(HTTPException) as exc:
            CensorService._decode_base64_image("")
        assert exc.value.status_code == 400

    def test_decode_base64_enforces_byte_cap(self, monkeypatch):
        monkeypatch.setattr(cs, "MAX_SAVE_DATA_BYTES", 3)
        payload = base64.b64encode(b"12345").decode("ascii")
        with pytest.raises(HTTPException) as exc:
            CensorService._decode_base64_image(payload)
        assert exc.value.status_code == 413


class TestMaskBoundsAndClamp:
    """`_normalize_mask_bounds` + `_clamp_float` coercion (pure)."""

    def test_bounds_rejects_non_quadruple(self):
        assert CensorService._normalize_mask_bounds([1, 2, 3]) is None
        assert CensorService._normalize_mask_bounds("nope") is None

    def test_bounds_rejects_non_numeric(self):
        assert CensorService._normalize_mask_bounds(["a", 0, 1, 2]) is None

    def test_bounds_rejects_degenerate(self):
        assert CensorService._normalize_mask_bounds([5, 5, 5, 5]) is None

    def test_bounds_clamps_to_image_size(self):
        assert CensorService._normalize_mask_bounds(
            [-5, -5, 100, 100], image_size=(10, 10)
        ) == (0, 0, 10, 10)

    def test_bounds_passthrough_without_image_size(self):
        assert CensorService._normalize_mask_bounds([0, 0, 8, 8]) == (0, 0, 8, 8)

    @pytest.mark.parametrize(
        "value,lo,hi,expected",
        [
            (5, 0, 10, 5.0),
            (-3, 0, 10, 0.0),
            (99, 0, 10, 10.0),
            ("x", 1, 5, 1.0),  # non-numeric -> minimum
            (None, 2, 4, 2.0),
        ],
    )
    def test_clamp_float(self, value, lo, hi, expected):
        assert CensorService._clamp_float(value, lo, hi) == expected


class TestMaskCacheClassState:
    """Class-level mask cache round-trip + inline-vs-cache routing.

    Pins that the cache lives on the CLASS (patched via CensorService) and that
    `_build_mask_payload` reads MASK_INLINE_DATA_PIXEL_THRESHOLD as a facade
    global — both are decomposition constraints.
    """

    @pytest.fixture
    def isolated_cache(self, tmp_path, monkeypatch):
        monkeypatch.setattr(CensorService, "_mask_cache_dir", tmp_path / "mc")
        with CensorService._mask_cache_lock:
            CensorService._mask_cache_index = {}
        yield
        with CensorService._mask_cache_lock:
            CensorService._mask_cache_index = {}

    @staticmethod
    def _rect_mask():
        mask = Image.new("L", (32, 32), 0)
        ImageDraw.Draw(mask).rectangle([4, 4, 20, 20], fill=255)
        return mask

    def test_cache_round_trip_writes_into_class_dir(self, isolated_cache, tmp_path):
        cached = CensorService._cache_mask_image(self._rect_mask())
        assert cached["mask_ref"]
        assert cached["mask_bounds"] == [4, 4, 21, 21]
        entry = CensorService._get_cached_mask_entry(cached["mask_ref"])
        assert Path(entry["path"]).exists()
        assert Path(entry["path"]).parent == (tmp_path / "mc")

    def test_get_entry_requires_ref(self, isolated_cache):
        with pytest.raises(HTTPException) as exc:
            CensorService._get_cached_mask_entry("")
        assert exc.value.status_code == 400

    def test_get_entry_404_for_unknown_ref(self, isolated_cache):
        with pytest.raises(HTTPException) as exc:
            CensorService._get_cached_mask_entry("deadbeef")
        assert exc.value.status_code == 404

    def test_build_payload_inlines_small_mask(self, isolated_cache):
        payload = CensorService._build_mask_payload(self._rect_mask())
        assert payload["mask"].startswith("data:image/png;base64,")
        assert payload["mask_ref"] is None
        assert payload["mask_bounds"] == [4, 4, 21, 21]

    def test_build_payload_caches_large_mask(self, isolated_cache, monkeypatch):
        monkeypatch.setattr(cs, "MASK_INLINE_DATA_PIXEL_THRESHOLD", 1)
        payload = CensorService._build_mask_payload(self._rect_mask())
        assert payload["mask"] is None
        assert payload["mask_ref"]

    def test_encode_empty_mask_returns_transparent_pixel(self):
        # An empty mask yields a 1x1 transparent PNG, never None.
        url = CensorService._encode_mask_image_as_data_url(Image.new("L", (8, 8), 0))
        assert url.startswith("data:image/png;base64,")


class TestEditOperationBudget:
    """Server-side edit resource guards — all 413 (safety / anti-DoS)."""

    def test_rejects_oversized_canvas(self):
        with pytest.raises(HTTPException) as exc:
            CensorService._validate_edit_operation_budget([], image_size=(10001, 10001))
        assert exc.value.status_code == 413

    def test_rejects_too_many_operations(self, monkeypatch):
        monkeypatch.setattr(cs, "MAX_EDIT_OPERATION_COUNT", 1)
        ops = [{"kind": "filter"}, {"kind": "filter"}]
        with pytest.raises(HTTPException) as exc:
            CensorService._validate_edit_operation_budget(ops, image_size=(10, 10))
        assert exc.value.status_code == 413

    def test_rejects_excess_geometry_points(self, monkeypatch):
        monkeypatch.setattr(cs, "MAX_EDIT_GEOMETRY_POINTS", 3)
        ops = [
            {
                "kind": "geometry_effect",
                "regions": [{"polygon": [[0, 0], [1, 1], [2, 2], [3, 3]]}],
            }
        ]
        with pytest.raises(HTTPException) as exc:
            CensorService._validate_edit_operation_budget(ops, image_size=(10, 10))
        assert exc.value.status_code == 413

    def test_rejects_full_image_filter_over_pixel_cap(self, monkeypatch):
        monkeypatch.setattr(cs, "MAX_FULL_IMAGE_FILTER_PIXELS", 1)
        ops = [{"kind": "filter"}]
        with pytest.raises(HTTPException) as exc:
            CensorService._validate_edit_operation_budget(ops, image_size=(10, 10))
        assert exc.value.status_code == 413


class TestNeverFallbackToUncensored:
    """SAFETY INVARIANT: a requested censor never resolves to raw pixels."""

    def test_unknown_edit_style_still_censors_region(self):
        # `_apply_mask_crop_style` falls through unrecognized styles to mosaic,
        # so a typo'd/future style still modifies (censors) the masked region
        # rather than leaving the original pixels exposed.
        image = Image.new("RGBA", (16, 16))
        for x in range(16):
            shade = 0 if x % 2 == 0 else 255
            for y in range(16):
                image.putpixel((x, y), (shade, shade, shade, 255))
        original = image.copy()
        full_mask = Image.new("L", (16, 16), 255)

        CensorService._apply_mask_style(
            image,
            original,
            full_mask,
            style="totally_unknown_style",
            block_size=8,
            blur_radius=4,
        )

        assert image.tobytes() != original.tobytes()

    def test_save_emits_no_file_when_censoring_raises(self, tmp_path, monkeypatch):
        # Fail-closed: if apply_censoring blows up, save() must 500 and leave the
        # output folder empty — it must never write the untouched original.
        import database

        src = tmp_path / "src.png"
        Image.new("RGB", (16, 16), "white").save(src)
        out_dir = tmp_path / "out"

        monkeypatch.setattr(
            database,
            "get_image_by_id",
            lambda _id: {"path": str(src), "filename": "src.png"},
        )
        monkeypatch.setattr(
            CensorService,
            "_resolve_source_image_path",
            staticmethod(lambda *a, **k: str(src)),
        )

        def _boom(*_args, **_kwargs):
            raise RuntimeError("apply failed")

        monkeypatch.setattr("censor.Censor.apply_censoring", _boom)

        request = CensorSaveRequest(
            image_id=1,
            regions=[[0, 0, 8, 8]],
            style="mosaic",
            output_folder=str(out_dir),
        )
        with pytest.raises(HTTPException) as exc:
            CensorService().save(request)

        assert exc.value.status_code == 500
        remaining = list(out_dir.glob("*")) if out_dir.exists() else []
        assert remaining == []


class TestMetadataHelpers:
    """Metadata strip (leak prevention) + PNG->EXIF preservation (pure-ish)."""

    def test_strip_all_metadata_drops_text_but_keeps_pixels(self):
        img = Image.new("RGB", (4, 4), (10, 20, 30))
        img.info["parameters"] = "1girl, secret prompt"
        stripped = CensorService._strip_all_metadata(img)
        assert "parameters" not in stripped.info
        assert stripped.size == (4, 4)
        assert stripped.getpixel((0, 0)) == (10, 20, 30)

    def test_png_text_to_exif_embeds_parameters(self):
        img = Image.new("RGB", (2, 2))
        img.info["parameters"] = "steps: 20"
        exif = CensorService._png_text_to_exif(img)
        assert exif is not None
        assert exif.startswith(b"Exif\x00\x00")
        assert b"steps: 20" in exif

    def test_png_text_to_exif_prefers_parameters_over_prompt(self):
        img = Image.new("RGB", (2, 2))
        img.info["prompt"] = "comfy graph"
        img.info["parameters"] = "a1111 params"
        exif = CensorService._png_text_to_exif(img)
        assert b"a1111 params" in exif

    def test_png_text_to_exif_none_without_text(self):
        assert CensorService._png_text_to_exif(Image.new("RGB", (2, 2))) is None

    def test_copy_png_text_metadata_returns_info_when_text_present(self):
        img = Image.new("RGB", (2, 2))
        img.info["prompt"] = "1girl"
        assert CensorService._copy_png_text_metadata(img) is not None

    def test_copy_png_text_metadata_none_without_text(self):
        assert CensorService._copy_png_text_metadata(Image.new("RGB", (2, 2))) is None

    def test_prepare_metadata_strip_returns_empty(self):
        svc = CensorService()
        assert (
            svc._prepare_metadata_for_save(
                Image.new("RGB", (2, 2)), None, "strip", "png"
            )
            == {}
        )

    def test_prepare_metadata_without_original_id_returns_empty(self):
        svc = CensorService()
        assert (
            svc._prepare_metadata_for_save(
                Image.new("RGB", (2, 2)), None, "keep", "png"
            )
            == {}
        )


class TestModelHealthSeam:
    """`get_model_health` / `get_default_legacy_model_path` read as module globals."""

    def test_refine_mask_surfaces_health_message_via_module_seam(self, monkeypatch):
        fake_sam3 = types.ModuleType("sam3_refiner")
        fake_sam3.get_sam3_refiner = lambda: object()
        monkeypatch.setitem(sys.modules, "sam3_refiner", fake_sam3)
        monkeypatch.setattr(
            cs,
            "get_model_health",
            lambda: {
                "censor": {"sam3": {"available": False, "message": "SAM3 disabled"}}
            },
        )

        with pytest.raises(HTTPException) as exc:
            CensorService().refine_mask(
                MaskRefineRequest(image_id=1, box=[0, 0, 10, 10])
            )
        assert exc.value.status_code == 503
        assert exc.value.detail == "SAM3 disabled"

    def test_refine_mask_reports_sam3_module_unavailable_when_import_fails(
        self, monkeypatch
    ):
        broken = types.ModuleType("sam3_refiner")  # lacks get_sam3_refiner
        monkeypatch.setitem(sys.modules, "sam3_refiner", broken)
        with pytest.raises(HTTPException) as exc:
            CensorService().refine_mask(
                MaskRefineRequest(image_id=1, box=[0, 0, 10, 10])
            )
        assert exc.value.status_code == 503
        assert "SAM3 module unavailable" in exc.value.detail

    def test_resolve_legacy_model_path_falls_back_to_default(self, monkeypatch):
        monkeypatch.setattr(
            cs, "get_default_legacy_model_path", lambda: "/models/yolo/default.onnx"
        )
        assert (
            CensorService._resolve_legacy_model_path("", allowed_base="/models")
            == "/models/yolo/default.onnx"
        )

    def test_resolve_legacy_model_path_503_when_no_local_model(self, monkeypatch):
        monkeypatch.setattr(cs, "get_default_legacy_model_path", lambda: None)
        with pytest.raises(HTTPException) as exc:
            CensorService._resolve_legacy_model_path("", allowed_base="/models")
        assert exc.value.status_code == 503

    def test_resolve_legacy_model_path_rejects_bad_extension(self, tmp_path):
        with pytest.raises(HTTPException) as exc:
            CensorService._resolve_legacy_model_path(
                "notes.txt", allowed_base=str(tmp_path)
            )
        assert exc.value.status_code == 400


class TestBackendFileLocationContract:
    """The `backend_file=__file__` trap: module must sit two levels below backend."""

    def test_module_sits_two_levels_below_backend(self):
        # resolve_existing_indexed_image_path / save_and_reconcile_checked derive
        # backend_root = dirname(dirname(abspath(backend_file))). Moving any of
        # the four backend_file=__file__ methods into a deeper submodule would
        # silently break relative/legacy-row path resolution.
        grandparent = os.path.basename(
            os.path.dirname(os.path.dirname(os.path.abspath(cs.__file__)))
        )
        assert grandparent == "backend"
