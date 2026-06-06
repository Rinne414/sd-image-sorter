"""Unit tests for native YOLOv8-seg mask -> polygon decoding in CensorDetector.

These cover the lightweight ONNX path that lets the privacy model emit
pixel-accurate polygons (instead of only boxes) WITHOUT requiring the
AGPL-licensed ultralytics runtime. The model itself is not loaded; we drive
``postprocess`` / ``_decode_seg_polygon`` with synthetic prototype masks.
"""
from __future__ import annotations

import numpy as np
import pytest

import censor
from censor import CensorDetector

_CV2 = censor._try_import_cv2()
requires_cv2 = pytest.mark.skipif(_CV2 is None, reason="OpenCV not installed in this environment")


def _detector(input_size=(640, 640), classes=("breasts",)) -> CensorDetector:
    det = CensorDetector(classes=list(classes))
    det.input_size = input_size
    return det


def _bbox(poly):
    xs = [p[0] for p in poly]
    ys = [p[1] for p in poly]
    return min(xs), min(ys), max(xs), max(ys)


# ---------- postprocess: box-only path is unchanged when proto is absent ------


def test_postprocess_without_proto_emits_box_only():
    det = _detector(classes=("breasts",), input_size=(640, 640))
    # output0 layout [1, 4+num_classes, N]; N=2 so squeeze keeps it 2-D (real
    # models have N in the thousands). Column 1 stays zero -> filtered by conf.
    out = np.zeros((1, 5, 2), dtype=np.float32)
    out[0, 0, 0], out[0, 1, 0], out[0, 2, 0], out[0, 3, 0] = 320, 320, 100, 200
    out[0, 4, 0] = 0.9

    dets = det.postprocess(out, (640, 640), (1.0, 1.0), (0, 0), conf_threshold=0.5)

    assert len(dets) == 1
    assert dets[0]["box"] == [270, 220, 370, 420]
    assert "polygon" not in dets[0]


# ---------- _decode_seg_polygon: traces the actual mask shape ------------------


@requires_cv2
def test_decode_seg_polygon_traces_rectangle_to_original_coords():
    det = _detector(input_size=(640, 640))
    ph = pw = 64  # proto resolution; proto->input scale = 640/64 = 10
    proto = np.full((1, 1, ph, pw), -10.0, dtype=np.float32)
    proto[0, 0, 16:48, 8:40] = 10.0  # high inside rows16..48 (y), cols8..40 (x)
    coeff = np.array([1.0], dtype=np.float32)
    box_input = (0.0, 0.0, 640.0, 640.0)  # whole image -> no crop clipping

    poly = det._decode_seg_polygon(coeff, proto, box_input, (1.0, 1.0), (0, 0), (640, 640))

    assert poly is not None and len(poly) >= 3
    minx, miny, maxx, maxy = _bbox(poly)
    # rect cols 8..40 -> x 80..400, rows 16..48 -> y 160..480 (scale 1, no pad)
    assert 60 <= minx <= 100 and 380 <= maxx <= 420
    assert 140 <= miny <= 180 and 460 <= maxy <= 500


@requires_cv2
def test_decode_seg_polygon_reverses_letterbox_padding():
    det = _detector(input_size=(640, 640))
    ph = pw = 64
    proto = np.full((1, 1, ph, pw), -10.0, dtype=np.float32)
    proto[0, 0, 10:50, 10:50] = 10.0  # input space x/y 100..500
    coeff = np.array([1.0], dtype=np.float32)
    # original 1280x640 letterboxed into 640x640: scale 0.5, vertical pad 160
    poly = det._decode_seg_polygon(
        coeff, proto, (0.0, 0.0, 640.0, 640.0),
        scale_info=(0.5, 0.5), pad_info=(0, 160), original_size=(1280, 640),
    )
    assert poly is not None
    minx, miny, maxx, maxy = _bbox(poly)
    # x: (100..500)/0.5 = 200..1000 ; y: (100..500 - 160)/0.5 = -120..680 -> clipped 0..640
    assert 180 <= minx <= 220 and 980 <= maxx <= 1020
    assert 0 <= miny <= 40 and 600 <= maxy <= 640


@requires_cv2
def test_decode_seg_polygon_none_when_mask_empty():
    det = _detector(input_size=(640, 640))
    proto = np.full((1, 1, 64, 64), -10.0, dtype=np.float32)  # sigmoid ~ 0 everywhere
    coeff = np.array([1.0], dtype=np.float32)
    poly = det._decode_seg_polygon(coeff, proto, (0.0, 0.0, 640.0, 640.0), (1.0, 1.0), (0, 0), (640, 640))
    assert poly is None


# ---------- postprocess: seg layout threads coeffs+proto into a polygon --------


@requires_cv2
def test_postprocess_with_proto_emits_localized_polygon():
    det = _detector(classes=("breasts",), input_size=(640, 640))
    # output0 layout [1, 4 + num_classes(1) + 32, N]; N=2 (col 1 filtered by conf)
    out = np.zeros((1, 37, 2), dtype=np.float32)
    out[0, 0, 0], out[0, 1, 0], out[0, 2, 0], out[0, 3, 0] = 320, 320, 640, 640
    out[0, 4, 0] = 0.9            # class score
    out[0, 5, 0] = 1.0            # mask coeff for proto channel 0; others 0

    proto = np.full((1, 32, 64, 64), -10.0, dtype=np.float32)
    proto[0, 0, 16:48, 8:40] = 10.0

    dets = det.postprocess(out, (640, 640), (1.0, 1.0), (0, 0), conf_threshold=0.5, proto=proto)

    assert len(dets) == 1
    poly = dets[0].get("polygon")
    assert poly is not None and len(poly) >= 3
    minx, miny, maxx, maxy = _bbox(poly)
    # localized to the high-mask rectangle, not the whole 640x640 box
    assert 60 <= minx and maxx <= 440
    assert 140 <= miny and maxy <= 500
