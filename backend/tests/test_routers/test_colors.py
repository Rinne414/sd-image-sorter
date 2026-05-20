from __future__ import annotations

from pathlib import Path

from PIL import Image


def test_colors_analyze_rejects_invalid_limit(test_client):
    response = test_client.post("/api/colors/analyze", json={"limit": 0})

    assert response.status_code == 400
    assert "limit" in response.text


def test_colors_analyze_single_resolves_indexed_path(monkeypatch, test_client, tmp_path: Path):
    import database as db
    import routers.colors as colors_router

    runtime_path = tmp_path / "resolved-color.png"
    Image.new("RGB", (16, 16), color="white").save(runtime_path)
    image_id = db.add_image(path="I:\\missing\\resolved-color.png", filename=runtime_path.name)

    monkeypatch.setattr(
        colors_router,
        "resolve_existing_indexed_image_path",
        lambda primary_path, *, backend_file, allow_symlink=False: str(runtime_path),
    )
    seen_paths = []

    def fake_analyze(path):
        seen_paths.append(path)
        return {
            "avg_brightness": 250,
            "color_temperature": "neutral",
            "brightness_distribution": "right_heavy",
        }

    monkeypatch.setattr(colors_router, "analyze_image_colors", fake_analyze)

    response = test_client.post(f"/api/colors/analyze-single/{image_id}")

    assert response.status_code == 200
    assert response.json()["color_data"]["avg_brightness"] == 250
    assert seen_paths == [str(runtime_path)]
