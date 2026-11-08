"""Run keys: pictures from one generation run share one, and the listing sends no prompt for it."""

from __future__ import annotations

import database as db
import db_images_paginate
from run_keys import attach_run_keys, run_key


def test_a_run_shares_prompt_negative_checkpoint_and_size():
    key = run_key("1girl, solo", "lowres", "animagine", 832, 1216)
    assert key == run_key("1girl, solo", "lowres", "Animagine", 832, 1216)
    assert key != run_key("1girl, solo", "lowres", "animagine", 1216, 832)
    assert key != run_key("1girl, solo, smile", "lowres", "animagine", 832, 1216)
    assert key != run_key("1girl, solo", "lowres, bad hands", "animagine", 832, 1216)
    assert key != run_key("1girl, solo", "lowres", "pony", 832, 1216)


def test_a_picture_without_a_prompt_is_never_grouped():
    assert run_key("", "lowres", "animagine", 512, 512) is None
    assert run_key(None, None, None, None, None) is None


def test_attaching_keys_drops_the_prompt_fields_read_for_them():
    rows = [
        {
            "_run_prompt": "cat",
            "_run_negative": "",
            "checkpoint": "m",
            "width": 64,
            "height": 64,
        }
    ]
    attach_run_keys(rows)
    assert rows[0]["run_key"] == run_key("cat", "", "m", 64, 64)
    assert "_run_prompt" not in rows[0] and "_run_negative" not in rows[0]


def test_the_gallery_listing_gives_each_picture_its_run_key(test_db, tmp_path):
    for index in range(3):
        db.add_image(
            path=str(tmp_path / f"p{index}.png"),
            filename=f"p{index}.png",
            prompt="1girl, solo" if index < 2 else "landscape",
            negative_prompt="lowres",
            checkpoint="animagine",
            width=512,
            height=512,
        )
    page = db_images_paginate.get_images_paginated(limit=10, skip_count=True)
    keys = {image["filename"]: image["run_key"] for image in page["images"]}
    assert (
        keys["p0.png"]
        == keys["p1.png"]
        == run_key("1girl, solo", "lowres", "animagine", 512, 512)
    )
    assert keys["p2.png"] != keys["p0.png"]
    assert all(
        "_run_prompt" not in image and "prompt" not in image for image in page["images"]
    )
