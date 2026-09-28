"""Mosaic cells follow the picture: 1/100 of the long side, at least 4 px (owner 2026-09-28).

A fixed 16 px cell is fine on a 1024 px picture and far too fine on a 4000
px one. Auto is the default; an explicit size is still honoured.
"""

from __future__ import annotations

import pytest
from PIL import Image

import censor_transforms
from censor_transforms import Censor, auto_block_size, resolve_block_size
from services import disguise_service
from services.censor_service import CensorApplyRequest, CensorSaveRequest


@pytest.mark.parametrize(
    ("size", "cell"),
    [
        ((4000, 3000), 40),
        ((3000, 4000), 40),
        ((1024, 1024), 10),
        ((1600, 900), 16),
        ((300, 200), 4),
        ((1, 1), 4),
    ],
)
def test_the_auto_cell_is_a_hundredth_of_the_long_side_and_at_least_4px(
    size, cell
) -> None:
    assert auto_block_size(size) == cell


@pytest.mark.parametrize(
    ("requested", "cell"), [(None, 40), (0, 40), (12, 12), (64, 64)]
)
def test_zero_or_missing_means_auto_and_a_number_is_kept(requested, cell) -> None:
    assert resolve_block_size(requested, (4000, 3000)) == cell


def test_the_api_defaults_to_auto() -> None:
    apply = CensorApplyRequest(image_id=1, regions=[[0, 0, 10, 10]])
    save = CensorSaveRequest(image_id=1, regions=[[0, 0, 10, 10]], output_folder="x")

    assert apply.block_size == 0
    assert save.block_size == 0


def test_a_mosaic_without_a_size_uses_the_pictures_auto_cell(monkeypatch) -> None:
    seen = []
    monkeypatch.setattr(
        Censor,
        "apply_mosaic",
        staticmethod(lambda image, regions, block: seen.append(block) or image),
    )

    Censor.apply_censoring(
        Image.new("RGB", (2000, 1000)), [(0, 0, 10, 10)], style="mosaic", block_size=0
    )
    Censor.apply_censoring(
        Image.new("RGB", (2000, 1000)), [(0, 0, 10, 10)], style="mosaic"
    )
    Censor.apply_censoring(
        Image.new("RGB", (2000, 1000)), [(0, 0, 10, 10)], style="mosaic", block_size=8
    )

    assert seen == [20, 20, 8]


def test_the_disguise_mosaic_cover_uses_the_same_rule() -> None:
    assert disguise_service.mosaic_block_size((4000, 3000)) == auto_block_size(
        (4000, 3000)
    )
    assert disguise_service.mosaic_block_size is censor_transforms.auto_block_size
