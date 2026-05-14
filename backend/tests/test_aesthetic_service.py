from __future__ import annotations

import sys
from pathlib import Path


sys.path.insert(0, str(Path(__file__).parent.parent))

from services.aesthetic_service import AestheticService


def test_score_batch_uses_stable_snapshot_when_filtering_unscored_rows(test_db, tmp_path, monkeypatch):
    """Scoring all unscored images must not skip rows as scores are written."""
    for index in range(600):
        image_path = tmp_path / f"aesthetic-snapshot-{index}.png"
        image_path.write_bytes(b"placeholder")
        test_db.add_image(
            path=str(image_path),
            filename=image_path.name,
            metadata_json="{}",
        )

    service = AestheticService()
    monkeypatch.setattr(service, "_compute_content_fingerprint", lambda _path: None)
    monkeypatch.setattr(service, "_gpu_cleanup", lambda: None)

    scored_paths = []

    def fake_predict(path: str) -> float:
        scored_paths.append(path)
        return 7.0

    service.score_batch(force=False, predict_score=fake_predict)

    with test_db.get_db() as conn:
        row = conn.execute("SELECT COUNT(*) FROM images WHERE aesthetic_score IS NOT NULL").fetchone()

    assert row[0] == 600
    assert len(scored_paths) == 600


def test_score_batch_streams_target_rows_without_fetchall(test_db, tmp_path, monkeypatch):
    """Batch scoring should fetch target rows in bounded cursor chunks."""
    image_path = tmp_path / "aesthetic-stream.png"
    image_path.write_bytes(b"placeholder")
    test_db.add_image(path=str(image_path), filename=image_path.name, metadata_json="{}")

    service = AestheticService()
    monkeypatch.setattr(service, "_compute_content_fingerprint", lambda _path: None)
    monkeypatch.setattr(service, "_gpu_cleanup", lambda: None)

    original_get_db = test_db.get_db

    class CursorProxy:
        def __init__(self, cursor):
            self._cursor = cursor

        def fetchall(self):
            raise AssertionError("score_batch must stream with fetchmany, not fetchall")

        def __getattr__(self, name):
            return getattr(self._cursor, name)

    class ConnectionProxy:
        def __init__(self, connection):
            self._connection = connection

        def __enter__(self):
            self._entered = self._connection.__enter__()
            return self

        def __exit__(self, *args):
            return self._connection.__exit__(*args)

        def execute(self, *args, **kwargs):
            return CursorProxy(self._entered.execute(*args, **kwargs))

        def __getattr__(self, name):
            return getattr(self._entered, name)

    monkeypatch.setattr(test_db, "get_db", lambda: ConnectionProxy(original_get_db()))
    service.score_batch(force=False, predict_score=lambda _path: 6.0)
