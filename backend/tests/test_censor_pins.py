"""Characterization pins for backend/censor.py (TIER-2 step 0).

This is the YOLOv8 detection + Pillow censoring ENGINE (`censor.py`), distinct
from `services/censor_service.py` (already split, pinned by
test_censor_service_pins.py). These pins lock the observable behavior of the
engine so a facade/sibling split can be proven byte-for-byte equivalent.

Coverage census (what already exists — NOT duplicated here):
  * test_censor_seg_decode.py     -> postprocess seg path + _decode_seg_polygon
                                     (native YOLOv8-seg polygon tracing; cv2).
                                     We deliberately AVOID the seg polygon path
                                     and the one box-only postprocess assertion
                                     it already owns; our postprocess pins target
                                     confidence filtering, NMS, and clipping.
  * test_censor_output_integrity.py -> HTTP-level preview/save RGBA/format
                                     integrity via the router (service layer).
  * test_prompts_censor_similarity_artists.py -> router/service detect flows;
                                     patches censor.CensorDetector / _detector /
                                     _detector_lock on the MODULE object.
  * fixtures/ml_fixtures.py        -> patches "censor.get_detector" (string form).
  * test_censor_service_pins.py    -> patches "censor.Censor.apply_censoring"
                                     (string form) for the never-fallback safety
                                     invariant.

MODEL SAFETY: no real YOLO/ONNX/cv2/ultralytics/torch model is loaded. Every
heavy seam (ort / _cv2 / a live InferenceSession / an ultralytics runtime) is
stubbed. The module-global rebind seams are mutated only through
``monkeypatch.setattr(censor, ...)`` so pytest restores them after each test.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import censor  # noqa: E402
from censor import Censor, CensorDetector, canonicalize_class_name  # noqa: E402


# ---------------------------------------------------------------------------
# canonicalize_class_name — single source of truth for YOLO class aliasing
# ---------------------------------------------------------------------------


class TestCanonicalizeClassName:
    @pytest.mark.parametrize(
        ("raw", "expected"),
        [
            ("breast", "breasts"),
            ("breasts", "breasts"),
            ("boob", "breasts"),
            ("boobs", "breasts"),
            ("tits", "breasts"),
            ("tit", "breasts"),
            ("vagina", "pussy"),
            ("vulva", "pussy"),
            ("pussy", "pussy"),
            ("labia", "pussy"),
            ("penis", "dick"),
            ("dick", "dick"),
            ("cock", "dick"),
            ("cum", "cum"),
            ("semen", "cum"),
            ("anus", "anus"),
            ("butthole", "anus"),
        ],
    )
    def test_alias_table_maps_to_canonical(self, raw, expected):
        assert canonicalize_class_name(raw) == expected

    def test_uppercase_and_whitespace_are_normalized(self):
        assert canonicalize_class_name("  BOOBS  ") == "breasts"

    def test_underscores_and_hyphens_collapse_before_alias_lookup(self):
        # "tit-s" -> "tit s" -> collapsed "tits" -> breasts
        assert canonicalize_class_name("tit-s") == "breasts"
        assert canonicalize_class_name("boob_s") == "breasts"

    def test_unknown_name_passes_through_normalized(self):
        # underscores become spaces; no alias -> returned as the spaced form
        assert canonicalize_class_name("female_breast") == "female breast"
        assert canonicalize_class_name("Hand") == "hand"

    def test_empty_and_none_return_empty_string(self):
        assert canonicalize_class_name("") == ""
        assert canonicalize_class_name(None) == ""

    def test_alias_table_shape_is_pinned(self):
        # Guards the aliasing dict against silent edits during a split.
        assert len(censor._CLASS_NAME_ALIASES) == 17
        assert set(censor._CLASS_NAME_ALIASES.values()) == {
            "breasts",
            "pussy",
            "dick",
            "cum",
            "anus",
        }

    def test_static_method_delegates_to_module_function(self):
        assert CensorDetector._canonicalize_class_name("cock") == "dick"


# ---------------------------------------------------------------------------
# CensorDetector construction + class handling
# ---------------------------------------------------------------------------


class TestDetectorInit:
    def test_defaults_use_config_classes_and_input_size(self):
        det = CensorDetector()
        assert det.classes == ["anus", "cum", "dick", "breasts", "pussy"]
        assert det.raw_classes == ["anus", "cum", "dick", "breasts", "pussy"]
        assert det.requested_classes is None
        assert det.input_size == (640, 640)
        assert det.session is None
        assert det.runtime is None
        assert det.runtime_backend is None
        assert det.supports_masks is False
        assert det._onnx_segmentation is False

    def test_explicit_classes_are_stored_verbatim_and_remembered(self):
        det = CensorDetector(classes=["Breasts", "Pussy"])
        # __init__ stores the raw list; canonicalization happens in _set_classes.
        assert det.classes == ["Breasts", "Pussy"]
        assert det.requested_classes == ["Breasts", "Pussy"]


class TestSetClasses:
    def test_set_classes_canonicalizes_and_keeps_raw(self):
        det = CensorDetector()
        det._set_classes(["Boobs", "vagina-lips"])
        assert det.raw_classes == ["Boobs", "vagina-lips"]
        assert det.classes == ["breasts", "vagina lips"]

    def test_empty_input_falls_back_to_requested_then_default(self):
        det = CensorDetector(classes=["custom"])
        det._set_classes(["  ", ""])
        # blank cleaned list -> falls back to requested_classes
        assert det.raw_classes == ["custom"]

    def test_empty_input_without_request_falls_back_to_default(self):
        det = CensorDetector()
        det._set_classes([])
        assert det.raw_classes == ["anus", "cum", "dick", "breasts", "pussy"]


class TestNamesFromMapping:
    def test_dict_ordered_by_numeric_key(self):
        names = CensorDetector._names_from_mapping({"1": "b", "0": "a", "2": "c"})
        assert names == ["a", "b", "c"]

    def test_list_is_stringified_in_order(self):
        assert CensorDetector._names_from_mapping(["x", 3, "y"]) == ["x", "3", "y"]

    def test_other_types_return_empty(self):
        assert CensorDetector._names_from_mapping("nope") == []
        assert CensorDetector._names_from_mapping(None) == []


class TestLookupRuntimeName:
    def test_dict_by_int_key(self):
        assert CensorDetector._lookup_runtime_name({0: "breasts"}, 0) == "breasts"

    def test_dict_by_str_key_fallback(self):
        assert CensorDetector._lookup_runtime_name({"2": "pussy"}, 2) == "pussy"

    def test_list_index(self):
        assert CensorDetector._lookup_runtime_name(["a", "b"], 1) == "b"

    def test_unknown_id_yields_class_placeholder(self):
        assert CensorDetector._lookup_runtime_name({}, 7) == "class_7"
        assert CensorDetector._lookup_runtime_name(["a"], 9) == "class_9"


# ---------------------------------------------------------------------------
# ONNX metadata / output-shape introspection (pure, no live session)
# ---------------------------------------------------------------------------


class _FakeShaped:
    def __init__(self, shape):
        self.shape = shape


class _FakeModelMeta:
    def __init__(self, meta):
        self.custom_metadata_map = meta


class _FakeSession:
    """Minimal ONNX Runtime InferenceSession stand-in."""

    def __init__(self, inputs=None, outputs=None, meta=None, run_result=None):
        self._inputs = inputs or []
        self._outputs = outputs or []
        self._meta = meta or {}
        self._run_result = run_result

    def get_inputs(self):
        return self._inputs

    def get_outputs(self):
        return self._outputs

    def get_modelmeta(self):
        return _FakeModelMeta(self._meta)

    def run(self, output_names, feed):
        return self._run_result


class TestSupportsLightweightOnnx:
    def test_no_outputs_is_false(self):
        det = CensorDetector(classes=["breasts"])
        assert det._supports_lightweight_onnx(_FakeSession(outputs=[])) is False

    def test_non_3d_output_is_false(self):
        det = CensorDetector(classes=["breasts"])
        sess = _FakeSession(outputs=[_FakeShaped([1, 5])])
        assert det._supports_lightweight_onnx(sess) is False

    def test_non_int_channel_dim_is_false(self):
        det = CensorDetector(classes=["breasts"])
        sess = _FakeSession(outputs=[_FakeShaped([1, "N", 8400])])
        assert det._supports_lightweight_onnx(sess) is False

    def test_box_channel_count_matches(self):
        det = CensorDetector(classes=["breasts"])  # 4 + 1 = 5
        sess = _FakeSession(outputs=[_FakeShaped([1, 5, 8400])])
        assert det._supports_lightweight_onnx(sess) is True

    def test_seg_channel_count_adds_32_mask_coeffs(self):
        det = CensorDetector(classes=["breasts"])  # 4 + 1 + 32 = 37
        sess = _FakeSession(
            outputs=[_FakeShaped([1, 37, 8400]), _FakeShaped([1, 32, 160, 160])]
        )
        assert det._supports_lightweight_onnx(sess) is True


class TestOnnxHasSegmentationOutputs:
    def test_two_outputs_is_segmentation(self):
        det = CensorDetector()
        sess = _FakeSession(outputs=[object(), object()])
        assert det._onnx_has_segmentation_outputs(sess) is True

    def test_single_output_is_not_segmentation(self):
        det = CensorDetector()
        sess = _FakeSession(outputs=[object()])
        assert det._onnx_has_segmentation_outputs(sess) is False

    def test_raising_session_is_swallowed_to_false(self):
        class Boom:
            def get_outputs(self):
                raise RuntimeError("no outputs")

        assert CensorDetector._onnx_has_segmentation_outputs(Boom()) is False


class TestLoadOnnxMetadata:
    def test_valid_names_json_updates_classes(self):
        det = CensorDetector(classes=["placeholder"])
        sess = _FakeSession(meta={"names": '{"0": "boobs", "1": "penis"}'})
        det._load_onnx_metadata(sess)
        assert det.raw_classes == ["boobs", "penis"]
        assert det.classes == ["breasts", "dick"]

    def test_missing_names_leaves_classes_untouched(self):
        det = CensorDetector(classes=["breasts"])
        det._load_onnx_metadata(_FakeSession(meta={}))
        assert det.classes == ["breasts"]

    def test_invalid_json_string_does_not_crash_and_keeps_classes(self):
        det = CensorDetector(classes=["breasts"])
        det._load_onnx_metadata(_FakeSession(meta={"names": "{not valid json"}))
        # parse failure -> parsed becomes None -> no names -> classes unchanged
        assert det.classes == ["breasts"]


# ---------------------------------------------------------------------------
# load() — file guard + GPU/CPU session-option decision (fake ort)
# ---------------------------------------------------------------------------


class _FakeSessionOptions:
    def __init__(self):
        self.intra_op_num_threads = None
        self.inter_op_num_threads = None
        self.execution_mode = None
        self.graph_optimization_level = None
        self.enable_cpu_mem_arena = None
        self.enable_mem_pattern = None
        self.config_entries = {}

    def add_session_config_entry(self, key, value):
        self.config_entries[key] = value


class _FakeExecutionMode:
    ORT_SEQUENTIAL = "seq"


class _FakeGraphOptLevel:
    ORT_ENABLE_ALL = "all"


class _FakeOrt:
    ExecutionMode = _FakeExecutionMode
    GraphOptimizationLevel = _FakeGraphOptLevel

    def __init__(self, providers, session):
        self._providers = providers
        self._session = session
        self.last_session_call = None

    def get_available_providers(self):
        return list(self._providers)

    def SessionOptions(self):
        return _FakeSessionOptions()

    def InferenceSession(self, path, sess_options=None, providers=None):
        self.last_session_call = {
            "path": path,
            "sess_options": sess_options,
            "providers": providers,
        }
        return self._session


def _box_model_session():
    """A single-output (box-only) ONNX session for the default 5 classes."""
    return _FakeSession(
        inputs=[type("Inp", (), {"name": "images", "shape": [1, 3, 640, 640]})()],
        outputs=[_FakeShaped([1, 9, 8400])],  # 4 + 5 classes, len==1 -> no seg
        meta={},
    )


class TestLoadFileGuard:
    def test_missing_model_path_raises_file_not_found(self, monkeypatch):
        # ort stubbed so _ensure_ort() is a no-op and never imports onnxruntime.
        monkeypatch.setattr(censor, "ort", _FakeOrt(["CPUExecutionProvider"], None))
        det = CensorDetector(model_path=str(Path("does") / "not" / "exist.onnx"))
        with pytest.raises(FileNotFoundError):
            det.load()

    def test_no_model_path_at_all_raises_file_not_found(self, monkeypatch):
        monkeypatch.setattr(censor, "ort", _FakeOrt(["CPUExecutionProvider"], None))
        det = CensorDetector()
        with pytest.raises(FileNotFoundError):
            det.load()


class TestLoadGpuCpuDecision:
    def test_cpu_only_uses_cpu_provider_and_enables_mem_arena(
        self, monkeypatch, tmp_path
    ):
        model = tmp_path / "wenaka.onnx"
        model.write_bytes(b"\x00")  # exists; never parsed (InferenceSession is fake)
        fake_ort = _FakeOrt(["CPUExecutionProvider"], _box_model_session())
        monkeypatch.setattr(censor, "ort", fake_ort)

        det = CensorDetector()
        det.load(str(model))

        assert fake_ort.last_session_call["providers"] == ["CPUExecutionProvider"]
        opts = fake_ort.last_session_call["sess_options"]
        assert opts.enable_cpu_mem_arena is True
        assert opts.enable_mem_pattern is True
        assert isinstance(opts.intra_op_num_threads, int)
        assert opts.intra_op_num_threads >= 1
        assert opts.config_entries.get("session.intra_op.allow_spinning") == "0"
        assert det.runtime_backend == "onnxruntime"
        assert det.runtime is None
        assert det.supports_masks is False
        assert det.input_name == "images"
        assert det.input_size == (640, 640)

    def test_cuda_available_stays_lean_and_disables_mem_arena(
        self, monkeypatch, tmp_path
    ):
        model = tmp_path / "wenaka.onnx"
        model.write_bytes(b"\x00")
        fake_ort = _FakeOrt(
            ["CUDAExecutionProvider", "CPUExecutionProvider"], _box_model_session()
        )
        monkeypatch.setattr(censor, "ort", fake_ort)

        det = CensorDetector()
        det.load(str(model))

        assert fake_ort.last_session_call["providers"] == [
            "CUDAExecutionProvider",
            "CPUExecutionProvider",
        ]
        opts = fake_ort.last_session_call["sess_options"]
        # GPU sessions keep exactly 2 intra-op threads and skip CPU mem arena.
        assert opts.intra_op_num_threads == 2
        assert opts.enable_cpu_mem_arena is False
        assert opts.enable_mem_pattern is False


# ---------------------------------------------------------------------------
# preprocess — letterbox geometry
# ---------------------------------------------------------------------------


class TestPreprocess:
    def test_letterbox_shape_scale_and_padding(self):
        det = CensorDetector()
        det.input_size = (640, 640)
        image = Image.new("RGB", (320, 160), (10, 20, 30))

        arr, scale_info, pad_info = det.preprocess(image)

        assert arr.shape == (1, 3, 640, 640)
        assert arr.dtype == np.float32
        # scale = min(640/320, 640/160) = 2 ; new = 640x320 ; pad_y = (640-320)/2
        assert scale_info == (2.0, 2.0)
        assert pad_info == (0, 160)
        assert 0.0 <= float(arr.min()) and float(arr.max()) <= 1.0


# ---------------------------------------------------------------------------
# postprocess — confidence filter / NMS / clipping (box path, no proto)
# ---------------------------------------------------------------------------


def _single_class_output(rows):
    """Build a [1, 5, N] output0 (4 box coords + 1 class score) from rows of
    (cx, cy, w, h, score).

    Always emits at least N=2 columns: ``np.squeeze`` in postprocess() collapses
    a size-1 detection axis into a 1-D array (the seg-decode suite uses N=2 for
    the same reason), so a single real detection is padded with one all-zero,
    zero-confidence row that every positive threshold filters out.
    """
    padded = list(rows)
    while len(padded) < 2:
        padded.append((0.0, 0.0, 0.0, 0.0, 0.0))
    n = len(padded)
    out = np.zeros((1, 5, n), dtype=np.float32)
    for i, (cx, cy, w, h, score) in enumerate(padded):
        out[0, 0, i], out[0, 1, i], out[0, 2, i], out[0, 3, i] = cx, cy, w, h
        out[0, 4, i] = score
    return out


class TestPostprocessBoxPath:
    def test_low_confidence_boxes_are_dropped(self):
        det = CensorDetector(classes=["breasts"])
        out = _single_class_output([(100, 100, 40, 40, 0.9), (400, 400, 40, 40, 0.30)])
        dets = det.postprocess(out, (640, 640), (1.0, 1.0), (0, 0), conf_threshold=0.5)
        assert len(dets) == 1
        assert dets[0]["confidence"] == pytest.approx(0.9, abs=1e-6)
        assert dets[0]["class"] == "breasts"
        assert dets[0]["class_id"] == 0

    def test_nms_suppresses_overlapping_same_class_box(self):
        det = CensorDetector(classes=["breasts"])
        out = _single_class_output([(100, 100, 50, 50, 0.90), (110, 110, 50, 50, 0.85)])
        dets = det.postprocess(
            out, (640, 640), (1.0, 1.0), (0, 0), conf_threshold=0.5, iou_threshold=0.45
        )
        assert len(dets) == 1  # higher-confidence box wins
        assert dets[0]["confidence"] == pytest.approx(0.90, abs=1e-6)

    def test_disjoint_boxes_both_survive_nms(self):
        det = CensorDetector(classes=["breasts"])
        out = _single_class_output([(100, 100, 40, 40, 0.90), (500, 500, 40, 40, 0.88)])
        dets = det.postprocess(
            out, (640, 640), (1.0, 1.0), (0, 0), conf_threshold=0.5, iou_threshold=0.45
        )
        assert len(dets) == 2

    def test_box_is_clipped_to_original_bounds(self):
        det = CensorDetector(classes=["breasts"])
        # center (600,600) w=h=200 -> corners (500,500,700,700) clipped to 640
        out = _single_class_output([(600, 600, 200, 200, 0.9)])
        dets = det.postprocess(out, (640, 640), (1.0, 1.0), (0, 0), conf_threshold=0.5)
        assert dets[0]["box"] == [500, 500, 640, 640]

    def test_empty_when_all_below_threshold(self):
        det = CensorDetector(classes=["breasts"])
        out = _single_class_output([(100, 100, 40, 40, 0.1)])
        assert (
            det.postprocess(out, (640, 640), (1.0, 1.0), (0, 0), conf_threshold=0.5)
            == []
        )


class TestNms:
    def test_overlapping_boxes_reduced_to_one(self):
        det = CensorDetector()
        boxes = np.array([[0, 0, 100, 100], [10, 10, 110, 110]], dtype=np.float32)
        scores = np.array([0.9, 0.8], dtype=np.float32)
        keep = det._nms(boxes, scores, iou_threshold=0.45)
        assert list(keep) == [0]

    def test_disjoint_boxes_all_kept(self):
        det = CensorDetector()
        boxes = np.array([[0, 0, 50, 50], [200, 200, 250, 250]], dtype=np.float32)
        scores = np.array([0.9, 0.8], dtype=np.float32)
        keep = det._nms(boxes, scores, iou_threshold=0.45)
        assert sorted(int(i) for i in keep) == [0, 1]

    def test_single_box_returns_itself(self):
        det = CensorDetector()
        boxes = np.array([[0, 0, 10, 10]], dtype=np.float32)
        scores = np.array([0.5], dtype=np.float32)
        assert list(det._nms(boxes, scores, iou_threshold=0.45)) == [0]


# ---------------------------------------------------------------------------
# detect() / detect_from_image() — guards + ONNX box pipeline + ultralytics map
# ---------------------------------------------------------------------------


class TestDetectGuards:
    def test_detect_without_session_raises(self, tmp_path):
        image = tmp_path / "x.png"
        Image.new("RGB", (8, 8)).save(image)
        det = CensorDetector()
        with pytest.raises(RuntimeError, match="Model not loaded"):
            det.detect(str(image))

    def test_detect_from_image_without_session_raises(self):
        det = CensorDetector()
        with pytest.raises(RuntimeError, match="Model not loaded"):
            det.detect_from_image(Image.new("RGB", (8, 8)))


class TestDetectFromImageOnnxBoxPipeline:
    def test_fake_onnx_session_drives_full_box_pipeline(self):
        det = CensorDetector(classes=["breasts"])
        det.input_size = (640, 640)
        det.input_name = "images"
        det.runtime_backend = "onnxruntime"
        det._onnx_segmentation = False
        out = _single_class_output([(320, 320, 100, 200, 0.9)])
        det.session = _FakeSession(run_result=[out])

        dets = det.detect_from_image(Image.new("RGB", (640, 640)), conf_threshold=0.5)

        assert len(dets) == 1
        assert dets[0]["class"] == "breasts"
        assert dets[0]["box"] == [270, 220, 370, 420]
        assert "polygon" not in dets[0]


class _FakeScalar:
    def __init__(self, value):
        self._value = value

    def item(self):
        return self._value


class _FakeXYXYRow:
    def __init__(self, row):
        self._row = row

    def tolist(self):
        return list(self._row)


class _FakePolygonRow:
    def __init__(self, points):
        self._points = points

    def tolist(self):
        return [list(p) for p in self._points]


class _FakeBoxes:
    def __init__(self, cls, conf, xyxy):
        self.cls = [_FakeScalar(c) for c in cls]
        self.conf = [_FakeScalar(c) for c in conf]
        self.xyxy = [_FakeXYXYRow(b) for b in xyxy]
        self._n = len(cls)

    def __len__(self):
        return self._n


class _FakeMasks:
    def __init__(self, polygons):
        self.xy = [_FakePolygonRow(p) for p in polygons]


class _FakeResult:
    def __init__(self, boxes, names, masks=None):
        self.boxes = boxes
        self.names = names
        self.masks = masks


class _FakeYolo:
    def __init__(self, results, names):
        self._results = results
        self.names = names

    def predict(self, source, conf, device, verbose):
        return self._results


class TestDetectUltralyticsMapping:
    def test_maps_boxes_to_canonical_detection_dicts(self):
        det = CensorDetector()
        boxes = _FakeBoxes(cls=[0], conf=[0.77], xyxy=[[10.4, 20.6, 30.4, 40.6]])
        result = _FakeResult(boxes, names={0: "boobs"})
        det.runtime = _FakeYolo([result], names={0: "boobs"})
        det.session = det.runtime  # non-None so detect() doesn't guard-raise
        det.runtime_backend = "ultralytics"

        dets = det.detect("ignored-path")

        assert len(dets) == 1
        assert dets[0]["class"] == "breasts"  # canonicalized from "boobs"
        assert dets[0]["class_id"] == 0
        assert dets[0]["confidence"] == pytest.approx(0.77, abs=1e-6)
        assert dets[0]["box"] == [10, 21, 30, 41]  # round()
        assert "polygon" not in dets[0]

    def test_masks_xy_attaches_polygon(self):
        det = CensorDetector()
        boxes = _FakeBoxes(cls=[0], conf=[0.9], xyxy=[[0, 0, 20, 20]])
        masks = _FakeMasks(polygons=[[(1.0, 2.0), (3.0, 4.0), (5.0, 6.0)]])
        result = _FakeResult(boxes, names=["breasts"], masks=masks)
        det.runtime = _FakeYolo([result], names=["breasts"])
        det.session = det.runtime
        det.runtime_backend = "ultralytics"

        dets = det.detect_from_image(Image.new("RGB", (20, 20)))

        assert dets[0]["polygon"] == [[1.0, 2.0], [3.0, 4.0], [5.0, 6.0]]

    def test_empty_results_yield_no_detections(self):
        det = CensorDetector()
        det.runtime = _FakeYolo([], names={})
        det.session = det.runtime
        det.runtime_backend = "ultralytics"
        assert det.detect("ignored") == []


# ---------------------------------------------------------------------------
# Censor static transforms — geometry + immutability
# ---------------------------------------------------------------------------


def _gradient_image(size=8):
    img = Image.new("RGB", (size, size))
    img.putdata([(x * 8, y * 8, 0) for y in range(size) for x in range(size)])
    return img


class TestCensorMosaic:
    def test_large_block_flattens_region_to_single_color(self):
        img = _gradient_image(8)
        out = Censor.apply_mosaic(img, [(0, 0, 8, 8)], block_size=8)
        # small_w = max(1, 8//8) = 1 -> whole region becomes one NEAREST sample
        assert out.getpixel((0, 0)) == out.getpixel((7, 7))

    def test_does_not_mutate_input_image(self):
        img = _gradient_image(8)
        before = img.tobytes()
        out = Censor.apply_mosaic(img, [(0, 0, 8, 8)], block_size=4)
        assert out is not img
        assert img.tobytes() == before

    def test_out_of_bounds_region_is_clamped(self):
        img = _gradient_image(8)
        # region extends past the image; must not raise
        out = Censor.apply_mosaic(img, [(-4, -4, 20, 20)], block_size=4)
        assert out.size == (8, 8)

    def test_degenerate_region_is_skipped(self):
        img = _gradient_image(8)
        before = img.tobytes()
        out = Censor.apply_mosaic(img, [(5, 5, 5, 5)], block_size=4)
        assert out.tobytes() == before


class TestCensorBar:
    def test_fills_region_with_color(self):
        img = Image.new("RGB", (16, 16), (255, 0, 0))
        out = Censor.apply_bar(img, [(4, 4, 12, 12)], color=(0, 0, 0))
        assert out.getpixel((8, 8)) == (0, 0, 0)
        assert out.getpixel((0, 0)) == (255, 0, 0)  # outside region untouched

    def test_does_not_mutate_input_image(self):
        img = Image.new("RGB", (16, 16), (255, 0, 0))
        out = Censor.apply_bar(img, [(4, 4, 12, 12)], color=(0, 0, 0))
        assert out is not img
        assert img.getpixel((8, 8)) == (255, 0, 0)


class TestCensorBlur:
    def test_blur_changes_region_but_preserves_original(self):
        img = Image.new("RGB", (16, 16), (0, 0, 0))
        img.putpixel((8, 8), (255, 255, 255))
        out = Censor.apply_blur(img, [(4, 4, 12, 12)], blur_radius=3)
        assert out is not img
        assert img.getpixel((8, 8)) == (255, 255, 255)  # original untouched
        # blurring spreads the white pixel into its neighbourhood
        assert out.getpixel((7, 8)) != (0, 0, 0)

    def test_degenerate_region_is_skipped(self):
        img = Image.new("RGB", (16, 16), (0, 0, 0))
        before = img.tobytes()
        out = Censor.apply_blur(img, [(9, 9, 9, 9)], blur_radius=3)
        assert out.tobytes() == before


class TestCensorSticker:
    def test_no_sticker_path_draws_gold_ellipse(self):
        img = Image.new("RGB", (16, 16), (0, 0, 0))
        out = Censor.apply_sticker(img, [(0, 0, 16, 16)])
        assert out.getpixel((8, 8)) == (255, 215, 0)  # gold center
        assert out is not img
        assert img.getpixel((8, 8)) == (0, 0, 0)  # original untouched


class TestApplyCensoringDispatch:
    def _red(self):
        return Image.new("RGB", (16, 16), (255, 0, 0))

    def test_mosaic_is_the_default_style(self):
        out = Censor.apply_censoring(self._red(), [(0, 0, 16, 16)])
        assert isinstance(out, Image.Image)

    @pytest.mark.parametrize("style", ["black_bar", "solid", "black"])
    def test_black_bar_aliases(self, style):
        out = Censor.apply_censoring(self._red(), [(0, 0, 16, 16)], style=style)
        assert out.getpixel((8, 8)) == (0, 0, 0)

    def test_white_bar(self):
        out = Censor.apply_censoring(self._red(), [(0, 0, 16, 16)], style="white_bar")
        assert out.getpixel((8, 8)) == (255, 255, 255)

    def test_style_is_case_insensitive(self):
        out = Censor.apply_censoring(self._red(), [(0, 0, 16, 16)], style="SOLID")
        assert out.getpixel((8, 8)) == (0, 0, 0)

    def test_none_style_defaults_to_mosaic(self):
        out = Censor.apply_censoring(self._red(), [(0, 0, 16, 16)], style=None)
        assert isinstance(out, Image.Image)

    def test_sticker_style_draws_gold(self):
        out = Censor.apply_censoring(self._red(), [(0, 0, 16, 16)], style="sticker")
        assert out.getpixel((8, 8)) == (255, 215, 0)

    def test_unknown_style_raises_value_error(self):
        with pytest.raises(ValueError, match="Unknown censor style"):
            Censor.apply_censoring(self._red(), [(0, 0, 16, 16)], style="nope")


# ---------------------------------------------------------------------------
# Detector singleton lifecycle — _detector_requires_reload + get_detector
# ---------------------------------------------------------------------------


class TestDetectorRequiresReload:
    def test_none_detector_always_reloads(self):
        assert censor._detector_requires_reload(None, "m.onnx") is True

    def test_no_requested_model_reuses_existing(self):
        det = CensorDetector(model_path="m.onnx")
        det.session = object()
        assert censor._detector_requires_reload(det, None) is False

    def test_matching_path_with_live_session_reuses(self):
        det = CensorDetector(model_path="m.onnx")
        det.session = object()
        assert censor._detector_requires_reload(det, "m.onnx") is False

    def test_different_path_reloads(self):
        det = CensorDetector(model_path="a.onnx")
        det.session = object()
        assert censor._detector_requires_reload(det, "b.onnx") is True

    def test_matching_path_without_session_reloads(self):
        det = CensorDetector(model_path="m.onnx")
        det.session = None
        assert censor._detector_requires_reload(det, "m.onnx") is True


class _RecordingDetector:
    """Stand-in for CensorDetector that records load() calls without any model."""

    instances: list = []

    def __init__(self, model_path=None, classes=None):
        self.model_path = model_path
        self.session = None
        self.loaded = False
        _RecordingDetector.instances.append(self)

    def load(self, model_path=None):
        if model_path:
            self.model_path = model_path
        self.loaded = True
        self.session = object()


class TestGetDetectorSingleton:
    def test_no_model_path_creates_without_loading(self, monkeypatch):
        _RecordingDetector.instances = []
        monkeypatch.setattr(censor, "_detector", None)
        monkeypatch.setattr(censor, "CensorDetector", _RecordingDetector)

        det = censor.get_detector()

        assert isinstance(det, _RecordingDetector)
        assert det.loaded is False  # load() only runs when a model_path is given

    def test_model_path_triggers_load(self, monkeypatch):
        _RecordingDetector.instances = []
        monkeypatch.setattr(censor, "_detector", None)
        monkeypatch.setattr(censor, "CensorDetector", _RecordingDetector)

        det = censor.get_detector("wenaka.onnx")

        assert det.loaded is True
        assert det.model_path == "wenaka.onnx"

    def test_reuses_cached_detector_when_no_reload_needed(self, monkeypatch):
        _RecordingDetector.instances = []
        cached = _RecordingDetector(model_path="wenaka.onnx")
        cached.session = object()
        monkeypatch.setattr(censor, "_detector", cached)
        monkeypatch.setattr(censor, "CensorDetector", _RecordingDetector)

        got = censor.get_detector("wenaka.onnx")

        assert got is cached
        # no new instance was constructed
        assert _RecordingDetector.instances == [cached]

    def test_path_change_constructs_and_loads_replacement(self, monkeypatch):
        _RecordingDetector.instances = []
        cached = _RecordingDetector(model_path="old.onnx")
        cached.session = object()
        monkeypatch.setattr(censor, "_detector", cached)
        monkeypatch.setattr(censor, "CensorDetector", _RecordingDetector)

        got = censor.get_detector("new.onnx")

        assert got is not cached
        assert got.model_path == "new.onnx"
        assert got.loaded is True


# ---------------------------------------------------------------------------
# Lazy-import seams — stub-and-observe (no real onnxruntime / cv2 import)
# ---------------------------------------------------------------------------


class TestLazyImportSeams:
    def test_ensure_ort_is_noop_when_already_bound(self, monkeypatch):
        sentinel = object()
        monkeypatch.setattr(censor, "ort", sentinel)
        censor._ensure_ort()
        assert censor.ort is sentinel  # no re-import attempted

    def test_try_import_cv2_returns_none_when_sentinel_false(self, monkeypatch):
        monkeypatch.setattr(censor, "_cv2", False)
        assert censor._try_import_cv2() is None

    def test_try_import_cv2_returns_cached_module(self, monkeypatch):
        fake_cv2 = object()
        monkeypatch.setattr(censor, "_cv2", fake_cv2)
        assert censor._try_import_cv2() is fake_cv2


# ---------------------------------------------------------------------------
# Module location anchor — the facade must remain importable as `censor`
# ---------------------------------------------------------------------------


class TestModuleAnchor:
    def test_module_file_basename_is_censor_py(self):
        assert Path(censor.__file__).name == "censor.py"

    def test_public_surface_is_exposed_by_name(self):
        # A split must keep these resolvable on the `censor` module object;
        # model_health imports canonicalize_class_name, routers/services reach
        # CensorDetector / get_detector / Censor by name.
        for name in (
            "CensorDetector",
            "Censor",
            "get_detector",
            "canonicalize_class_name",
            "_detector",
            "_detector_lock",
            "_ensure_ort",
            "_try_import_cv2",
        ):
            assert hasattr(censor, name), name
