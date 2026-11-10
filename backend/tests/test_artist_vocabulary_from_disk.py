"""The vocabulary check answers from the class mapping file when the model is not in memory."""

from __future__ import annotations

from artist import vocabulary_file
from services.artist_service import ArtistService


class _UnloadedIdentifier:
    vocabulary_size = 0

    def knows_artist(self, name):  # pragma: no cover - must not be asked
        raise AssertionError("an unloaded model was asked for its vocabulary")


def _service():
    service = ArtistService.__new__(ArtistService)
    service._identifier_getter = lambda: _UnloadedIdentifier()
    return service


def test_answers_from_the_mapping_file_without_loading_the_model(tmp_path, monkeypatch):
    mapping = tmp_path / "class_mapping.csv"
    mapping.write_text(
        "class_id,class_name\n0,'wlop'\n1,rito_(ritoxiaying)\n2,Smewed\n", encoding="utf-8"
    )
    import artist.assets as assets

    monkeypatch.setattr(
        assets, "require_local_artist_assets", lambda: {"class_mapping_path": str(mapping)}
    )
    monkeypatch.setattr(vocabulary_file, "_cache", (None, 0.0, frozenset()))

    result = _service().lookup_vocabulary(["WLOP", "smewed", "greg_rutkowski", " "])

    assert result["vocabulary_loaded"] is True
    assert result["vocabulary_size"] == 3
    assert result["known"] == {"WLOP": True, "smewed": True, "greg_rutkowski": False}


def test_says_not_loaded_when_the_model_is_not_on_disk(monkeypatch):
    import artist.assets as assets

    def missing():
        raise RuntimeError("not prepared")

    monkeypatch.setattr(assets, "require_local_artist_assets", missing)
    monkeypatch.setattr(vocabulary_file, "_cache", (None, 0.0, frozenset()))

    result = _service().lookup_vocabulary(["wlop"])

    assert result == {"vocabulary_size": 0, "vocabulary_loaded": False, "known": {}}
