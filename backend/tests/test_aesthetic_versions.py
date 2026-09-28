"""LAION scores computed with the wrong CLIP activation are marked outdated and re-scored.

open_clip's "ViT-L-14" config uses GELU while the OpenAI weights (and the
LAION head trained on their embeddings) expect QuickGELU. The app silenced
that warning, so every stored score was off (mean 0.37, max 1.05 on a
150-picture sample). Scores now carry a version: old ones count as "to
score" again, and only the user's own "Score all" re-scores them.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

import aesthetic
from services.aesthetic_service import AestheticService
from services.derived_state_service import write_image_aesthetic_score

NEW_COLUMNS = {
    "aesthetic_version",
    "aesthetic_waifu",
    "aesthetic_anime",
    "aesthetic_anime_pct",
    "aesthetic_anime_grade",
}


def _add(test_db, tmp_path: Path, name: str) -> int:
    path = tmp_path / name
    path.write_bytes(b"x")
    return test_db.add_image(path=str(path), filename=name, metadata_json="{}")


def test_the_images_table_has_the_new_score_columns(test_db) -> None:
    with test_db.get_db() as conn:
        columns = {
            row[1] for row in conn.execute("PRAGMA table_info(images)").fetchall()
        }

    assert NEW_COLUMNS <= columns


def test_the_migration_adds_the_columns_to_an_old_database_once(tmp_path: Path) -> None:
    import importlib

    migration = importlib.import_module("migrations.049_aesthetic_versions")
    conn = sqlite3.connect(tmp_path / "old.db")
    conn.execute("CREATE TABLE images (id INTEGER PRIMARY KEY, aesthetic_score REAL)")
    conn.execute("INSERT INTO images (aesthetic_score) VALUES (6.5)")

    migration.apply(conn)
    migration.apply(conn)

    columns = {row[1] for row in conn.execute("PRAGMA table_info(images)").fetchall()}
    assert NEW_COLUMNS <= columns
    assert conn.execute(
        "SELECT aesthetic_score, aesthetic_version FROM images"
    ).fetchone() == (6.5, None)


def test_a_new_score_is_stored_as_the_current_version(test_db, tmp_path: Path) -> None:
    image_id = _add(test_db, tmp_path, "a.png")
    with test_db.get_db() as conn:
        conn.execute(
            "UPDATE images SET content_fingerprint = 'fp' WHERE id = ?", (image_id,)
        )
        write_image_aesthetic_score(
            conn.cursor(),
            image_id=image_id,
            scores=aesthetic.AestheticScores(laion=6.0),
            content_fingerprint="fp",
        )
        conn.commit()
        row = conn.execute(
            "SELECT aesthetic_score, aesthetic_version FROM images WHERE id = ?",
            (image_id,),
        ).fetchone()

    assert tuple(row) == (6.0, aesthetic.AESTHETIC_SCORE_VERSION)


def test_outdated_scores_count_as_to_score_and_are_reported(
    test_db, tmp_path: Path
) -> None:
    fresh = _add(test_db, tmp_path, "fresh.png")
    old = _add(test_db, tmp_path, "old.png")
    _add(test_db, tmp_path, "never.png")
    with test_db.get_db() as conn:
        conn.execute(
            "UPDATE images SET aesthetic_score = 6, aesthetic_version = ? WHERE id = ?",
            (aesthetic.AESTHETIC_SCORE_VERSION, fresh),
        )
        conn.execute(
            "UPDATE images SET aesthetic_score = 5, aesthetic_version = NULL WHERE id = ?",
            (old,),
        )
        conn.commit()

    service = AestheticService()
    status = service.get_status(lambda: True)

    assert status["scored_count"] == 2
    assert status["outdated_count"] == 1
    assert status["to_score_count"] == 2
    assert service.count_images_to_score(force=True) == 3


def test_score_all_re_scores_outdated_rows_and_leaves_current_ones(
    test_db, tmp_path: Path, monkeypatch
) -> None:
    fresh = _add(test_db, tmp_path, "fresh.png")
    old = _add(test_db, tmp_path, "old.png")
    with test_db.get_db() as conn:
        conn.execute(
            "UPDATE images SET aesthetic_score = 6, aesthetic_version = ? WHERE id = ?",
            (aesthetic.AESTHETIC_SCORE_VERSION, fresh),
        )
        conn.execute("UPDATE images SET aesthetic_score = 5 WHERE id = ?", (old,))
        conn.commit()
    service = AestheticService()
    monkeypatch.setattr(service, "_compute_content_fingerprint", lambda _path: "fp")
    monkeypatch.setattr(service, "_gpu_cleanup", lambda: None)
    scored = []

    service.score_batch(
        force=False,
        predict_scores=lambda path: scored.append(Path(path).name)
        or aesthetic.AestheticScores(laion=7.5),
    )

    with test_db.get_db() as conn:
        rows = dict(
            conn.execute("SELECT filename, aesthetic_score FROM images").fetchall()
        )
    assert scored == ["old.png"]
    assert rows == {"fresh.png": 6, "old.png": 7.5}


def test_clip_is_built_with_quick_gelu(monkeypatch) -> None:
    open_clip = pytest.importorskip("open_clip")
    seen = {}

    def fake_create(*args, **kwargs):
        seen.update(kwargs)
        raise RuntimeError("stop after recording the arguments")

    monkeypatch.setattr(open_clip, "create_model_and_transforms", fake_create)
    monkeypatch.setattr(aesthetic, "apply_hf_endpoint", lambda *a, **k: "")

    with pytest.raises(RuntimeError):
        aesthetic._load_predictor("cpu")

    assert seen.get("force_quick_gelu") is True
