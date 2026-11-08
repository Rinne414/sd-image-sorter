"""Collections inside collections: create inside, move, the rules, and delete keeps sub-collections."""

from __future__ import annotations

from pathlib import Path

from PIL import Image


def _make(test_client, name: str, parent_id: int | None = None) -> int:
    body = {"name": name, **({"parent_id": parent_id} if parent_id is not None else {})}
    response = test_client.post("/api/collections", json=body)
    assert response.status_code == 200, response.text
    return response.json()["id"]


def _parents(test_client) -> dict[str, int | None]:
    rows = test_client.get("/api/collections").json()["collections"]
    return {row["name"]: row["parent_id"] for row in rows}


def _favorites_id(test_client) -> int:
    rows = test_client.get("/api/collections").json()["collections"]
    return next(row["id"] for row in rows if row["slug"] == "favorites")


def test_a_collection_is_made_inside_another_and_listed_with_its_parent(
    test_client, test_db
):
    outer = _make(test_client, "Commission A")
    inner = _make(test_client, "Drafts", parent_id=outer)
    parents = _parents(test_client)
    assert parents["Commission A"] is None
    assert parents["Drafts"] == outer
    assert inner != outer


def test_move_puts_a_collection_inside_another_and_back_at_the_top(
    test_client, test_db
):
    a = _make(test_client, "A")
    b = _make(test_client, "B")
    moved = test_client.post(f"/api/collections/{b}/move", json={"parent_id": a})
    assert moved.status_code == 200
    assert _parents(test_client)["B"] == a
    top = test_client.post(f"/api/collections/{b}/move", json={"parent_id": None})
    assert top.status_code == 200
    assert _parents(test_client)["B"] is None


def test_a_collection_never_goes_inside_itself_or_below_itself(test_client, test_db):
    a = _make(test_client, "A")
    b = _make(test_client, "B", parent_id=a)
    c = _make(test_client, "C", parent_id=b)
    for target in (a, b, c):
        refused = test_client.post(
            f"/api/collections/{a}/move", json={"parent_id": target}
        )
        assert refused.status_code == 400
        assert "cannot go inside itself" in refused.json()["error"]
    assert _parents(test_client) == {**_parents(test_client), "A": None, "B": a, "C": b}


def test_favorites_stays_at_the_top_and_holds_no_collections(test_client, test_db):
    favorites = _favorites_id(test_client)
    a = _make(test_client, "A")
    assert (
        test_client.post(
            f"/api/collections/{favorites}/move", json={"parent_id": a}
        ).status_code
        == 400
    )
    assert (
        test_client.post(
            f"/api/collections/{a}/move", json={"parent_id": favorites}
        ).status_code
        == 400
    )
    made = test_client.post(
        "/api/collections", json={"name": "Inside favourites", "parent_id": favorites}
    )
    assert made.status_code == 400
    assert "Favorites cannot hold" in made.json()["error"]


def test_a_missing_or_hidden_parent_is_refused(test_client, test_db, tmp_path: Path):
    import database as db
    import db_pinned_sets

    a = _make(test_client, "A")
    assert (
        test_client.post(
            f"/api/collections/{a}/move", json={"parent_id": 987654}
        ).status_code
        == 400
    )
    assert (
        test_client.post(
            "/api/collections", json={"name": "X", "parent_id": 987654}
        ).status_code
        == 400
    )
    picture = tmp_path / "p.png"
    Image.new("RGB", (8, 8)).save(picture)
    image_id = db.add_image(path=str(picture), filename="p.png")
    hidden = db_pinned_sets.create_pinned_set([image_id])["id"]
    assert (
        test_client.post(
            f"/api/collections/{a}/move", json={"parent_id": hidden}
        ).status_code
        == 404
    )
    assert (
        test_client.post(
            f"/api/collections/{hidden}/move", json={"parent_id": None}
        ).status_code
        == 404
    )


def test_deleting_a_collection_moves_its_sub_collections_up_one_level(
    test_client, test_db
):
    top = _make(test_client, "Top")
    middle = _make(test_client, "Middle", parent_id=top)
    _make(test_client, "Leaf 1", parent_id=middle)
    _make(test_client, "Leaf 2", parent_id=middle)
    assert test_client.delete(f"/api/collections/{middle}").status_code == 200
    parents = _parents(test_client)
    assert "Middle" not in parents
    assert parents["Leaf 1"] == top
    assert parents["Leaf 2"] == top
    # and from the top level, they move to the top level
    assert test_client.delete(f"/api/collections/{top}").status_code == 200
    parents = _parents(test_client)
    assert parents["Leaf 1"] is None and parents["Leaf 2"] is None


def test_a_parent_shows_only_its_own_pictures(test_client, test_db, tmp_path: Path):
    import database as db

    outer = _make(test_client, "Outer")
    inner = _make(test_client, "Inner", parent_id=outer)
    picture = tmp_path / "q.png"
    Image.new("RGB", (8, 8)).save(picture)
    image_id = db.add_image(path=str(picture), filename="q.png")
    test_client.post(
        f"/api/collections/{inner}/items", json={"image_id": image_id, "member": True}
    )
    assert test_client.get(f"/api/collections/{outer}/images").json()["image_ids"] == []
    assert test_client.get(f"/api/collections/{inner}/images").json()["image_ids"] == [
        image_id
    ]
