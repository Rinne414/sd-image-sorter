"""Combined-export files belong under DATA_DIR, not backend/data."""

from __future__ import annotations

from pathlib import Path

import config
from services.tag_export import sidecars


def test_combined_export_dir_follows_data_dir(monkeypatch, tmp_path: Path):
    data_root = tmp_path / "custom-data"
    monkeypatch.setattr(config, "DATA_DIR", data_root)

    target = sidecars._get_combined_export_dir()

    assert target == data_root / "combined-exports"
    assert target.is_dir()
    backend_data = Path(sidecars.__file__).resolve().parents[2] / "data" / "combined-exports"
    assert target != backend_data
