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
