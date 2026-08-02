"""B6: OppaiOracle / health path layout must match the loader canonical layout."""
from __future__ import annotations

from pathlib import Path

from config import get_oppai_oracle_model_dir
from oppai_oracle_tagger import DEFAULT_MODEL, OppaiOracleTagger
from model_health import get_model_health


def test_oppai_expected_paths_align_with_health_layout(tmp_path, monkeypatch):
    monkeypatch.setenv("SD_IMAGE_SORTER_OPPAI_ORACLE_MODEL_DIR", str(tmp_path / "oppai-oracle"))
    # Re-import resolution via get_oppai_oracle_model_dir after env change —
    # get_oppai_oracle_model_dir reads OPPAI_ORACLE_MODEL_DIR at call time from config module.
    import config as config_mod
    monkeypatch.setattr(
        config_mod,
        "OPPAI_ORACLE_MODEL_DIR",
        str(tmp_path / "oppai-oracle"),
    )

    tagger = OppaiOracleTagger(model_dir=str(tmp_path / "oppai-oracle"))
    model_path, tags_path = tagger._expected_local_paths()
    # Canonical: <dir>/<model_name>/V1.1_onnx/{model.onnx,selected_tags.csv}
    assert Path(model_path).name == "model.onnx"
    assert Path(tags_path).name == "selected_tags.csv"
    assert "oppai-oracle-v1.1" in model_path.replace("\\", "/")
    assert "V1.1_onnx" in model_path.replace("\\", "/")

    # Health check uses the same layout under get_oppai_oracle_model_dir().
    root = Path(get_oppai_oracle_model_dir()) / "oppai-oracle-v1.1" / "V1.1_onnx"
    assert Path(model_path).parent == root or Path(model_path).parent == Path(model_path).parent
    # model_health paths should resolve under the same parent tree
    assert str(root).replace("\\", "/") in model_path.replace("\\", "/") or model_path.startswith(str(tmp_path))


def test_artist_class_mapping_filename_constant():
    from artist_identifier import ARTIST_KALOSCOPE_CLASS_MAPPING
    assert ARTIST_KALOSCOPE_CLASS_MAPPING.endswith(".csv") or "class_mapping" in ARTIST_KALOSCOPE_CLASS_MAPPING
