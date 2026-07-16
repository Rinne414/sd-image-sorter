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
from io import BytesIO
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
        assert payload["image_width"] == 32
        assert payload["image_height"] == 32

        encoded = payload["mask"].split(",", 1)[1]
        with Image.open(BytesIO(base64.b64decode(encoded))) as inline_mask:
            assert inline_mask.size == (17, 17)
            assert inline_mask.convert("RGBA").getchannel("A").getbbox() == (0, 0, 17, 17)

    def test_build_payload_caches_large_mask(self, isolated_cache, monkeypatch):
        monkeypatch.setattr(cs, "MASK_INLINE_DATA_PIXEL_THRESHOLD", 1)
        payload = CensorService._build_mask_payload(self._rect_mask())
        assert payload["mask"] is None
        assert payload["mask_ref"]

    def test_build_payload_returns_explicit_noop_for_empty_mask(self, isolated_cache):
        payload = CensorService._build_mask_payload(Image.new("L", (32, 24), 0))

        assert payload == {
            "mask": None,
            "mask_ref": None,
            "mask_bounds": None,
            "image_width": 32,
            "image_height": 24,
        }

    def test_encode_empty_mask_returns_transparent_pixel(self):
        # An empty mask yields a 1x1 transparent PNG, never None.
        url = CensorService._encode_mask_image_as_data_url(Image.new("L", (8, 8), 0))
        assert url.startswith("data:image/png;base64,")
        encoded = url.split(",", 1)[1]
        with Image.open(BytesIO(base64.b64decode(encoded))) as empty_mask:
            assert empty_mask.size == (1, 1)
            assert empty_mask.convert("RGBA").getpixel((0, 0))[3] == 0


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


def _encode_inline_mask_data_url(alpha: Image.Image) -> str:
    rgba = Image.new("RGBA", alpha.size, (255, 255, 255, 0))
    rgba.putalpha(alpha.convert("L"))
    buffer = BytesIO()
    rgba.save(buffer, format="PNG")
    return f"data:image/png;base64,{base64.b64encode(buffer.getvalue()).decode('ascii')}"


def _bounded_inline_mask_operation(
    alpha: Image.Image,
    bounds: list[int],
    image_size: tuple[int, int],
    style: str,
) -> dict[str, object]:
    return {
        "kind": "mask_effect",
        "style": style,
        "block_size": 7,
        "blur_radius": 4,
        "mask_data": _encode_inline_mask_data_url(alpha),
        "mask_bounds": bounds,
        "mask_image_width": image_size[0],
        "mask_image_height": image_size[1],
    }


def _patterned_rgba(size: tuple[int, int], phase: int) -> Image.Image:
    image = Image.new("RGBA", size)
    pixels = image.load()
    for y in range(size[1]):
        for x in range(size[0]):
            pixels[x, y] = (
                (x * 37 + y * 11 + phase) % 256,
                (x * 13 + y * 41 + phase * 3) % 256,
                (x * 29 + y * 17 + phase * 7) % 256,
                255,
            )
    return image


class TestCropLocalInlineMasks:
    """Inline mask crops must stay bounded without changing rendered pixels."""

    def test_bounded_inline_mask_never_resizes_to_canvas(
        self,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        image_size = (96, 64)
        original = _patterned_rgba(image_size, 19)
        working = original.copy()
        alpha = Image.new("L", (7, 5), 255)
        resize_targets: list[tuple[int, int]] = []
        real_resize = Image.Image.resize

        def tracked_resize(
            source: Image.Image,
            size: tuple[int, int],
            *args: object,
            **kwargs: object,
        ) -> Image.Image:
            resize_targets.append(size)
            return real_resize(source, size, *args, **kwargs)

        monkeypatch.setattr(Image.Image, "resize", tracked_resize)
        CensorService._apply_mask_effect_operation(
            working,
            original,
            _bounded_inline_mask_operation(alpha, [41, 27, 48, 32], image_size, "black_bar"),
        )

        assert image_size not in resize_targets
        assert working.getpixel((44, 29)) == (0, 0, 0, 255)
        assert working.getpixel((4, 4)) == original.getpixel((4, 4))

    def test_empty_legacy_inline_mask_returns_before_resize_or_effect(
        self,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        image_size = (96, 64)
        original = _patterned_rgba(image_size, 23)
        working = original.copy()
        unchanged = working.tobytes()
        empty_mask_data = CensorService._encode_mask_image_as_data_url(
            Image.new("L", (1, 1), 0)
        )

        def unexpected_resize(*_args: object, **_kwargs: object) -> Image.Image:
            raise AssertionError("empty inline mask must not resize")

        def unexpected_effect(*_args: object, **_kwargs: object) -> None:
            raise AssertionError("empty inline mask must not invoke an effect")

        monkeypatch.setattr(Image.Image, "resize", unexpected_resize)
        monkeypatch.setattr(CensorService, "_apply_mask_style", unexpected_effect)
        CensorService._apply_mask_effect_operation(
            working,
            original,
            {
                "kind": "mask_effect",
                "style": "mosaic",
                "mask_data": empty_mask_data,
            },
        )

        assert working.tobytes() == unchanged

    @pytest.mark.parametrize("style", ["mosaic", "blur", "black_bar", "white_bar"])
    def test_bounded_inline_mask_matches_full_canvas_reference(self, style: str) -> None:
        image_size = (128, 80)
        bounds = [43, 21, 68, 42]
        alpha = Image.new("L", (25, 21), 0)
        ImageDraw.Draw(alpha).ellipse([1, 2, 23, 19], fill=255)
        original = _patterned_rgba(image_size, 31)
        expected = _patterned_rgba(image_size, 79)
        actual = expected.copy()
        full_alpha = Image.new("L", image_size, 0)
        full_alpha.paste(alpha, (bounds[0], bounds[1]))

        CensorService._apply_mask_style(
            expected,
            original,
            full_alpha,
            style=style,
            block_size=7,
            blur_radius=4,
        )
        CensorService._apply_mask_effect_operation(
            actual,
            original,
            _bounded_inline_mask_operation(alpha, bounds, image_size, style),
        )

        assert actual.tobytes() == expected.tobytes()

    def test_legacy_inline_mask_without_bounds_keeps_full_canvas_scaling(self) -> None:
        image_size = (64, 48)
        alpha = Image.new("L", (4, 3), 0)
        ImageDraw.Draw(alpha).rectangle([1, 1, 3, 2], fill=255)
        original = _patterned_rgba(image_size, 37)
        expected = original.copy()
        actual = original.copy()
        scaled_alpha = alpha.resize(image_size, Image.Resampling.LANCZOS)

        CensorService._apply_mask_style(
            expected,
            original,
            scaled_alpha,
            style="black_bar",
            block_size=7,
            blur_radius=4,
        )
        CensorService._apply_mask_effect_operation(
            actual,
            original,
            {
                "kind": "mask_effect",
                "style": "black_bar",
                "block_size": 7,
                "blur_radius": 4,
                "mask_data": _encode_inline_mask_data_url(alpha),
            },
        )

        assert actual.tobytes() == expected.tobytes()

    @pytest.mark.parametrize(
        ("bounds", "alpha_size", "source_size"),
        [
            ([12, 10, 8, 15], (4, 5), (64, 48)),
            ([12, 10, 18, 16], (5, 6), (64, 48)),
            ([12, 10, 17, 16], (5, 6), (63, 48)),
        ],
    )
    def test_malformed_bounded_inline_mask_fails_without_mutation(
        self,
        bounds: list[int],
        alpha_size: tuple[int, int],
        source_size: tuple[int, int],
    ) -> None:
        image_size = (64, 48)
        original = _patterned_rgba(image_size, 41)
        working = original.copy()
        unchanged = working.tobytes()
        alpha = Image.new("L", alpha_size, 255)
        operation = _bounded_inline_mask_operation(alpha, bounds, source_size, "black_bar")

        with pytest.raises(HTTPException) as exc:
            CensorService._apply_mask_effect_operation(working, original, operation)

        assert exc.value.status_code == 400
        assert "inline mask" in str(exc.value.detail).lower()
        assert working.tobytes() == unchanged


def _apply_full_canvas_stroke_reference(
    image: Image.Image,
    original_image: Image.Image,
    operation: dict[str, object],
) -> None:
    tool = str(operation.get("tool") or "brush").strip().lower()
    points = CensorService._normalize_operation_points(operation.get("points"))
    brush_size = CensorService._clamp_float(operation.get("brush_size", 1), 1.0, 4096.0)
    mask = Image.new("L", image.size, 0)
    CensorService._draw_stroke_mask(mask, points, brush_size)
    CensorService._apply_mask_style(
        image,
        original_image,
        mask,
        style=operation.get("style") if tool == "brush" else tool,
        block_size=int(operation.get("block_size", 16) or 16),
        blur_radius=int(operation.get("blur_radius", 20) or 20),
        pen_color=str(operation.get("pen_color") or "#ff0000"),
        pen_opacity=CensorService._clamp_float(operation.get("pen_opacity", 1.0), 0.0, 1.0),
    )


def _track_l_mask_sizes(monkeypatch: pytest.MonkeyPatch) -> list[tuple[int, int]]:
    real_image_new = Image.new
    mask_sizes: list[tuple[int, int]] = []

    def tracked_image_new(mode: str, size: tuple[int, int], color: object) -> Image.Image:
        if mode == "L":
            mask_sizes.append(size)
        return real_image_new(mode, size, color)

    monkeypatch.setattr(Image, "new", tracked_image_new)
    return mask_sizes


def _track_geometry_mask_allocations(
    monkeypatch: pytest.MonkeyPatch,
) -> list[tuple[str, tuple[int, int]]]:
    real_image_new = Image.new
    allocations: list[tuple[str, tuple[int, int]]] = []

    def tracked_image_new(mode: str, size: tuple[int, int], color: object) -> Image.Image:
        if mode in {"1", "L"}:
            allocations.append((mode, size))
        return real_image_new(mode, size, color)

    monkeypatch.setattr(Image, "new", tracked_image_new)
    return allocations


class TestCropLocalStrokeMasks:
    """Localized strokes must not allocate masks at full source resolution."""

    @staticmethod
    def _operation(
        tool: str,
        style: str,
        points: list[dict[str, float]],
    ) -> dict[str, object]:
        return {
            "kind": "stroke",
            "tool": tool,
            "style": style,
            "points": points,
            "brush_size": 20,
            "block_size": 7,
            "blur_radius": 4,
            "pen_color": "#28b4d8",
            "pen_opacity": 0.65,
        }

    def test_small_stroke_allocates_only_a_crop_mask(self, monkeypatch: pytest.MonkeyPatch) -> None:
        original = Image.new("RGBA", (200, 120), (40, 80, 120, 255))
        working = original.copy()
        mask_sizes = _track_l_mask_sizes(monkeypatch)
        CensorService._apply_stroke_operation(
            working,
            original,
            self._operation(
                "brush",
                "black_bar",
                [{"x": 90.0, "y": 50.0}, {"x": 110.0, "y": 70.0}],
            ),
        )

        assert mask_sizes
        assert max(width * height for width, height in mask_sizes) < 4_096
        assert (200, 120) not in mask_sizes

    def test_fully_off_canvas_stroke_allocates_no_mask(self, monkeypatch: pytest.MonkeyPatch) -> None:
        original = Image.new("RGBA", (80, 60), (40, 80, 120, 255))
        working = original.copy()
        unchanged = working.tobytes()
        mask_sizes = _track_l_mask_sizes(monkeypatch)
        CensorService._apply_stroke_operation(
            working,
            original,
            self._operation(
                "brush",
                "mosaic",
                [{"x": -100.0, "y": -100.0}, {"x": -80.0, "y": -80.0}],
            ),
        )

        assert mask_sizes == []
        assert working.tobytes() == unchanged

    @pytest.mark.parametrize(
        ("tool", "style", "points"),
        [
            ("brush", "mosaic", [{"x": 22.0, "y": 24.0}, {"x": 58.0, "y": 42.0}]),
            ("brush", "blur", [{"x": -5.0, "y": 5.0}, {"x": 18.0, "y": 16.0}]),
            ("brush", "black_bar", [{"x": 45.0, "y": 30.0}, {"x": 90.0, "y": 55.0}]),
            ("brush", "white_bar", [{"x": 70.0, "y": 4.0}, {"x": 112.0, "y": 18.0}]),
            ("brush", "mosaic", [{"x": 127.5, "y": 79.5}]),
            ("pen", "", [{"x": 12.0, "y": 60.0}, {"x": 72.0, "y": 48.0}]),
            ("eraser", "", [{"x": 104.0, "y": 62.0}, {"x": 126.0, "y": 78.0}]),
        ],
    )
    def test_crop_local_stroke_matches_full_canvas_reference(
        self,
        tool: str,
        style: str,
        points: list[dict[str, float]],
    ) -> None:
        original = Image.new("RGBA", (128, 80), (35, 70, 105, 255))
        original_draw = ImageDraw.Draw(original)
        original_draw.rectangle([8, 6, 118, 72], fill=(180, 90, 30, 255))
        original_draw.line([(0, 79), (127, 0)], fill=(20, 210, 140, 255), width=5)

        expected = original.copy()
        actual = original.copy()
        ImageDraw.Draw(expected).rectangle([0, 0, 127, 79], fill=(80, 45, 150, 255))
        ImageDraw.Draw(actual).rectangle([0, 0, 127, 79], fill=(80, 45, 150, 255))
        operation = self._operation(tool, style, points)

        _apply_full_canvas_stroke_reference(expected, original, operation)
        CensorService._apply_stroke_operation(actual, original, operation)

        assert actual.mode == expected.mode
        assert actual.size == expected.size
        assert actual.tobytes() == expected.tobytes()


def _apply_full_canvas_geometry_reference(
    image: Image.Image,
    original_image: Image.Image,
    operation: dict[str, object],
) -> None:
    regions = operation.get("regions") or []
    assert isinstance(regions, list)
    polygon_mask = Image.new("L", image.size, 0)
    polygon_draw = ImageDraw.Draw(polygon_mask)
    box_regions: list[list[int]] = []

    for region in regions:
        if not isinstance(region, dict):
            continue
        polygon = region.get("polygon")
        if isinstance(polygon, list):
            points = [
                (float(point[0]), float(point[1]))
                for point in polygon
                if isinstance(point, (list, tuple)) and len(point) >= 2
            ]
            if len(points) >= 3:
                polygon_draw.polygon(points, fill=255)
                continue

        box = region.get("box")
        if isinstance(box, list) and len(box) == 4:
            box_regions.append([int(float(value)) for value in box])

    CensorService._apply_mask_style(
        image,
        original_image,
        polygon_mask,
        style=str(operation.get("style") or "mosaic"),
        block_size=int(operation.get("block_size", 16) or 16),
        blur_radius=int(operation.get("blur_radius", 20) or 20),
    )

    if box_regions:
        box_mask = Image.new("L", image.size, 0)
        box_draw = ImageDraw.Draw(box_mask)
        for x1, y1, x2, y2 in box_regions:
            box_draw.rectangle([x1, y1, x2, y2], fill=255)
        CensorService._apply_mask_style(
            image,
            original_image,
            box_mask,
            style=str(operation.get("style") or "mosaic"),
            block_size=int(operation.get("block_size", 16) or 16),
            blur_radius=int(operation.get("blur_radius", 20) or 20),
        )


class TestCropLocalGeometryMasks:
    """Localized polygon and box effects must not allocate full-canvas masks."""

    @staticmethod
    def _operation(regions: list[dict[str, object]], style: str) -> dict[str, object]:
        return {
            "kind": "geometry_effect",
            "regions": regions,
            "style": style,
            "block_size": 7,
            "blur_radius": 4,
        }

    def test_box_only_allocates_one_crop_mask(self, monkeypatch: pytest.MonkeyPatch) -> None:
        original = Image.new("RGBA", (200, 120), (40, 80, 120, 255))
        working = original.copy()
        mask_allocations = _track_geometry_mask_allocations(monkeypatch)

        CensorService._apply_geometry_effect_operation(
            working,
            original,
            self._operation([{"box": [90, 50, 110, 70]}], "black_bar"),
        )

        assert mask_allocations == [("L", (21, 21))]

    def test_polygon_only_allocates_one_height_local_bit_mask(
        self,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        original = Image.new("RGBA", (200, 120), (40, 80, 120, 255))
        working = original.copy()
        mask_allocations = _track_geometry_mask_allocations(monkeypatch)

        CensorService._apply_geometry_effect_operation(
            working,
            original,
            self._operation(
                [{"polygon": [[80, 40], [120, 45], [105, 80], [75, 65]]}],
                "mosaic",
            ),
        )

        assert mask_allocations == [("1", (200, 43))]
        width, height = mask_allocations[0][1]
        assert ((width + 7) // 8) * height < 2_048

    def test_fully_off_canvas_geometry_allocates_no_mask(self, monkeypatch: pytest.MonkeyPatch) -> None:
        original = Image.new("RGBA", (80, 60), (40, 80, 120, 255))
        working = original.copy()
        unchanged = working.tobytes()
        mask_allocations = _track_geometry_mask_allocations(monkeypatch)

        CensorService._apply_geometry_effect_operation(
            working,
            original,
            self._operation(
                [
                    {"polygon": [[-90, -80], [-60, -80], [-70, -50]]},
                    {"polygon": [[140, 100], [170, 100], [155, 130]]},
                    {"box": [-140, 10, -100, 40]},
                    {"box": [100, 10, 140, 40]},
                ],
                "mosaic",
            ),
        )

        assert mask_allocations == []
        assert working.tobytes() == unchanged

    def test_disjoint_polygon_with_canvas_crossing_aabb_uses_bounded_bit_mask(
        self,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        original = Image.new("RGBA", (80, 80), (40, 80, 120, 255))
        working = original.copy()
        unchanged = working.tobytes()
        mask_allocations = _track_geometry_mask_allocations(monkeypatch)

        CensorService._apply_geometry_effect_operation(
            working,
            original,
            self._operation(
                [{"polygon": [[-80, 79], [79, -80], [-80, -80]]}],
                "mosaic",
            ),
        )

        assert mask_allocations == [("1", (80, 80))]
        assert ((80 + 7) // 8) * 80 < 1_024
        assert working.tobytes() == unchanged

    def test_pillow_visible_boundary_spike_is_not_filtered(self) -> None:
        original = Image.new("RGBA", (80, 60), (40, 80, 120, 255))
        expected = original.copy()
        actual = original.copy()
        operation = self._operation(
            [
                {
                    "polygon": [
                        [79, -120],
                        [80, 180],
                        [81, 180],
                        [80, -120],
                    ]
                }
            ],
            "black_bar",
        )

        _apply_full_canvas_geometry_reference(expected, original, operation)
        CensorService._apply_geometry_effect_operation(actual, original, operation)

        assert expected.getpixel((79, 0)) == (0, 0, 0, 255)
        assert actual.tobytes() == expected.tobytes()

    @pytest.mark.parametrize(
        "coordinate",
        [float("nan"), float("inf"), float("-inf"), 10**400],
    )
    def test_non_finite_or_overflowing_polygon_coordinate_fails_with_actionable_400(
        self,
        coordinate: object,
    ) -> None:
        original = Image.new("RGBA", (80, 60), (40, 80, 120, 255))

        with pytest.raises(HTTPException) as exc:
            CensorService._apply_geometry_effect_operation(
                original.copy(),
                original,
                self._operation(
                    [{"polygon": [[coordinate, 10], [20, 20], [10, 30]]}],
                    "mosaic",
                ),
            )

        assert exc.value.status_code == 400
        assert "finite number" in str(exc.value.detail)
        assert "regions[0].polygon[0].x" in str(exc.value.detail)

    def test_polygon_coordinate_beyond_canvas_envelope_fails_with_actionable_400(self) -> None:
        original = Image.new("RGBA", (17, 13), (40, 80, 120, 255))

        with pytest.raises(HTTPException) as exc:
            CensorService._apply_geometry_effect_operation(
                original.copy(),
                original,
                self._operation(
                    [{"polygon": [[1e9, 6.5], [8.5, 0.1], [5e8, 12]]}],
                    "mosaic",
                ),
            )

        assert exc.value.status_code == 400
        assert "outside the supported range" in str(exc.value.detail)
        assert "regions[0].polygon[0].x" in str(exc.value.detail)

    @pytest.mark.parametrize(
        ("box", "expected_path"),
        [
            ([0, 0, float("inf"), 10], "regions[0].box[2]"),
            ([0, -1e9, 10, 10], "regions[0].box[1]"),
        ],
    )
    def test_invalid_box_coordinate_fails_with_actionable_400(
        self,
        box: list[float],
        expected_path: str,
    ) -> None:
        original = Image.new("RGBA", (80, 60), (40, 80, 120, 255))

        with pytest.raises(HTTPException) as exc:
            CensorService._apply_geometry_effect_operation(
                original.copy(),
                original,
                self._operation([{"box": box}], "mosaic"),
            )

        assert exc.value.status_code == 400
        assert expected_path in str(exc.value.detail)

    def test_reversed_box_remains_fail_loud(self) -> None:
        original = Image.new("RGBA", (80, 60), (40, 80, 120, 255))
        with pytest.raises(ValueError):
            CensorService._apply_geometry_effect_operation(
                original.copy(),
                original,
                self._operation([{"box": [50, 40, 20, 10]}], "mosaic"),
            )

    @pytest.mark.parametrize(
        ("style", "regions"),
        [
            ("mosaic", [{"polygon": [[20.25, 18.75], [62.5, 20.25], [44.75, 55.5]]}]),
            ("blur", [{"polygon": [[-8, 4], [25, 2], [18, 28], [-4, 24]]}]),
            ("black_bar", [{"box": [42, 26, 88, 54]}]),
            ("white_bar", [{"box": [104, 60, 140, 90]}]),
            (
                "mosaic",
                [
                    {"polygon": [[24, 20], [86, 18], [66, 62], [30, 54]]},
                    {"box": [50, 34, 104, 72]},
                ],
            ),
            ("blur", [{"polygon": [[18, 16], [64, 14], [52, 48]], "box": [0, 0, 127, 79]}]),
            ("mosaic", [{"polygon": [[20, 20], [30, 30]], "box": [12, 10, 40, 35]}]),
            (
                "black_bar",
                [{"polygon": [[-10, -10], [140, -10], [140, 90], [-10, 90]]}],
            ),
            (
                "white_bar",
                [{"polygon": [[-10, 40], [64, -10], [138, 40], [64, 90]]}],
            ),
        ],
    )
    def test_crop_local_geometry_matches_full_canvas_reference(
        self,
        style: str,
        regions: list[dict[str, object]],
    ) -> None:
        original = Image.new("RGBA", (128, 80), (35, 70, 105, 255))
        original_draw = ImageDraw.Draw(original)
        original_draw.rectangle([8, 6, 118, 72], fill=(180, 90, 30, 255))
        original_draw.line([(0, 79), (127, 0)], fill=(20, 210, 140, 255), width=5)

        expected = original.copy()
        actual = original.copy()
        ImageDraw.Draw(expected).rectangle([0, 0, 127, 79], fill=(80, 45, 150, 255))
        ImageDraw.Draw(actual).rectangle([0, 0, 127, 79], fill=(80, 45, 150, 255))
        operation = self._operation(regions, style)

        _apply_full_canvas_geometry_reference(expected, original, operation)
        CensorService._apply_geometry_effect_operation(actual, original, operation)

        assert actual.mode == expected.mode
        assert actual.size == expected.size
        assert actual.tobytes() == expected.tobytes()


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
