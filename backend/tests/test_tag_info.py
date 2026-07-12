"""GET /api/tags/info — the learn-while-tagging popover data."""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

import database as db
from services import tag_suggest_service


def test_known_vocab_tag_resolves_category_and_counts(test_client, test_db):
    image_id = db.add_image(path="/test/info/a.png", filename="a.png", metadata_json="{}")
    db.add_tags(image_id, [{"tag": "1girl", "confidence": 0.9}])
    response = test_client.get("/api/tags/info", params={"tag": "1girl"})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["found_in_vocab"] is True
    assert body["canonical"] == "1girl"
    assert body["danbooru_count"] > 0
    assert body["library_count"] == 1
    assert body["category"]


def test_alias_resolves_to_canonical(test_client, test_db):
    # The bundled vocab is alias-aware; find one alias deterministically.
    tag_suggest_service._ensure_loaded()
    vocab = tag_suggest_service._VOCAB or []
    alias = None
    canonical = None
    for tag, _count, _code, blob in vocab:
        parts = blob.split(",")
        if len(parts) > 1 and parts[1]:
            canonical, alias = tag, parts[1]
            break
    if alias is None:
        pytest.skip("bundled vocab carries no aliases in this checkout")
    response = test_client.get("/api/tags/info", params={"tag": alias})
    body = response.json()
    assert body["found_in_vocab"] is True
    assert body["canonical"] == canonical
    assert alias in body["aliases"]


def test_unknown_tag_still_returns_heuristic(test_client, test_db):
    response = test_client.get("/api/tags/info", params={"tag": "my_totally_custom_oc_tag"})
    assert response.status_code == 200
    body = response.json()
    assert body["found_in_vocab"] is False
    assert body["category"], "heuristic category must still be present"
    assert body["library_count"] == 0


def test_implication_edges_present_for_bundled_pair(test_client, test_db):
    # cat_ears -> animal_ears ships in the bundled implication CSV.
    response = test_client.get("/api/tags/info", params={"tag": "cat_ears"})
    body = response.json()
    assert "animal_ears" in body["implies"]
    reverse = test_client.get("/api/tags/info", params={"tag": "animal_ears"}).json()
    assert "cat_ears" in reverse["implied_by"]
