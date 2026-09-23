"""Sidecar tag lists must appear in the gallery tag index.

Scan stores Danbooru-style ``.txt`` text in ``sidecar_caption`` and leaves
``prompt`` empty. The gallery tag cloud / filter reads the ``tags`` table,
so those sidecars were invisible until indexed with source='sidecar'.
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image

import database as db
import image_manager


DANBOORU = "1girl, silver_hair, red_eyes, looking at viewer, masterpiece"
PROSE = "A silver-haired girl looks at the viewer in a quiet room."


def _png(path: Path) -> Path:
    Image.new("RGB", (64, 64), color="white").save(path)
    return path


def test_scan_indexes_tag_list_sidecar(test_db, tmp_path: Path):
    image_path = _png(tmp_path / "tagged.png")
    (tmp_path / "tagged.txt").write_text(DANBOORU, encoding="utf-8")

    image_manager.scan_folder(str(tmp_path), recursive=False)

    row = db.get_image_by_path(str(image_path))
    assert row is not None
    stored = {t["tag"].lower(): t for t in db.get_image_tags(row["id"])}
    assert "1girl" in stored
    assert "silver_hair" in stored
    assert "looking at viewer" in stored
    assert stored["1girl"]["source"] == "sidecar"

    cloud = {t["tag"].lower(): t["count"] for t in db.get_all_tags()}
    assert cloud.get("1girl", 0) >= 1
    assert cloud.get("masterpiece", 0) >= 1


def test_prose_sidecar_is_not_cut_into_tags(test_db, tmp_path: Path):
    image_path = _png(tmp_path / "prose.png")
    (tmp_path / "prose.txt").write_text(PROSE, encoding="utf-8")

    image_manager.scan_folder(str(tmp_path), recursive=False)

    row = db.get_image_by_path(str(image_path))
    assert row is not None
    assert db.get_image_tags(row["id"]) == []


def test_sidecar_index_does_not_clobber_manual_or_tagger(test_db, tmp_path: Path):
    image_path = _png(tmp_path / "owned.png")
    image_id = db.add_image(path=str(image_path), filename=image_path.name)
    db.add_tags(image_id, [{"tag": "my_oc", "confidence": 1.0}], default_source="manual")
    db.add_tags(
        image_id,
        [{"tag": "solo", "confidence": 0.9}],
        default_source="tagger",
        replace_scope="pipeline",
    )
    (tmp_path / "owned.txt").write_text("1girl, solo, smile", encoding="utf-8")

    image_manager.scan_folder(str(tmp_path), recursive=False, force_reparse=True)

    by_tag = {t["tag"]: t for t in db.get_image_tags(image_id)}
    assert by_tag["my_oc"]["source"] == "manual"
    assert by_tag["solo"]["source"] == "tagger"
    assert by_tag["1girl"]["source"] == "sidecar"
    assert by_tag["smile"]["source"] == "sidecar"


def test_pipeline_retag_keeps_sidecar_rows(test_db, tmp_path: Path):
    image_path = _png(tmp_path / "keep-sc.png")
    (tmp_path / "keep-sc.txt").write_text("1girl, smile", encoding="utf-8")
    image_manager.scan_folder(str(tmp_path), recursive=False)
    image_id = db.get_image_by_path(str(image_path))["id"]

    db.add_tags(
        image_id,
        [{"tag": "from_tagger", "confidence": 0.8}],
        default_source="tagger",
        replace_scope="pipeline",
    )

    by_tag = {t["tag"]: t for t in db.get_image_tags(image_id)}
    assert by_tag["1girl"]["source"] == "sidecar"
    assert by_tag["from_tagger"]["source"] == "tagger"


def test_removed_sidecar_drops_only_sidecar_rows(test_db, tmp_path: Path):
    image_path = _png(tmp_path / "gone.png")
    sidecar = tmp_path / "gone.txt"
    sidecar.write_text("1girl, smile", encoding="utf-8")
    image_manager.scan_folder(str(tmp_path), recursive=False)
    image_id = db.get_image_by_path(str(image_path))["id"]
    db.add_tags(
        image_id,
        [{"tag": "keep_me", "confidence": 1.0}],
        default_source="manual",
        replace_scope="pipeline",
    )

    sidecar.unlink()
    image_manager.scan_folder(str(tmp_path), recursive=False, force_reparse=True)

    tags = {t["tag"]: t["source"] for t in db.get_image_tags(image_id)}
    assert tags == {"keep_me": "manual"}


def test_rescan_with_unchanged_sidecar_rewrites_nothing(test_db, tmp_path: Path):
    """Sync runs on every upsert; an unchanged sidecar must not churn its rows."""
    image_path = _png(tmp_path / "same.png")
    (tmp_path / "same.txt").write_text("1girl, smile", encoding="utf-8")
    image_manager.scan_folder(str(tmp_path), recursive=False)
    image_id = db.get_image_by_path(str(image_path))["id"]
    with db.get_db() as conn:
        before = conn.execute(
            "SELECT id, tag FROM tags WHERE image_id = ? ORDER BY id", (image_id,)
        ).fetchall()

    image_manager.scan_folder(str(tmp_path), recursive=False, force_reparse=True)

    with db.get_db() as conn:
        after = conn.execute(
            "SELECT id, tag FROM tags WHERE image_id = ? ORDER BY id", (image_id,)
        ).fetchall()
    assert [tuple(row) for row in after] == [tuple(row) for row in before]
    assert {row[1] for row in after} == {"1girl", "smile"}
