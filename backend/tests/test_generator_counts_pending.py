"""Generator chip counts leave out pictures whose metadata is still being read.

During a big import a picture is indexed first (``metadata_status =
'pending'``, no generator yet) and parsed a moment later. Counting those rows
as "unknown" made the Unknown chip jump to hundreds for a few seconds. They
are now left out until read; the page shows them as "reading" from
``metadata_pending``. A pending row that already has a generator still counts.
"""

from __future__ import annotations

import database as db


def test_pending_rows_without_a_generator_are_not_counted_as_unknown(test_db):
    db.add_image(path="/gen/a.png", filename="a.png", generator="webui")
    db.add_image(path="/gen/b.png", filename="b.png", generator="unknown")
    for index in range(3):
        db.add_image(
            path=f"/gen/pending{index}.png",
            filename=f"pending{index}.png",
            metadata_json="{}",
            is_readable=True,
            metadata_status="pending",
        )
    db.add_image(
        path="/gen/pending-known.png",
        filename="pending-known.png",
        generator="comfyui",
        metadata_json="{}",
        is_readable=True,
        metadata_status="pending",
    )

    counts = {row["generator"]: row["count"] for row in db.get_all_generators()}

    assert counts.get("unknown") == 1
    assert counts.get("webui") == 1
    assert counts.get("comfyui") == 1
