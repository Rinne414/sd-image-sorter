"""Aesthetic scoring must return 503 when torch/open_clip is missing, not 500."""

from __future__ import annotations

from pathlib import Path

from PIL import Image


def _add_png(db, tmp_path: Path) -> int:
    path = tmp_path / "score-me.png"
    Image.new("RGB", (32, 32), "white").save(path)
    return db.add_image(path=str(path), filename=path.name, metadata_json="{}")


def test_score_single_returns_503_when_torch_missing(test_client, test_db, tmp_path, monkeypatch):
    import aesthetic
    import database as db

    image_id = _add_png(db, tmp_path)
    monkeypatch.setattr(aesthetic, "is_available", lambda: False)

    def should_not_run(_path: str, **_kwargs):
        raise AssertionError("predict_score must not run when torch is unavailable")

    monkeypatch.setattr(aesthetic, "predict_score", should_not_run)

    response = test_client.post(f"/api/aesthetic/score/{image_id}")

    assert response.status_code == 503
    assert "not installed" in str(response.json()).lower()


def test_score_all_returns_503_when_torch_missing(test_client, monkeypatch):
    import aesthetic

    monkeypatch.setattr(aesthetic, "is_available", lambda: False)

    response = test_client.post("/api/aesthetic/score-all")

    assert response.status_code == 503
    assert "not installed" in str(response.json()).lower()
