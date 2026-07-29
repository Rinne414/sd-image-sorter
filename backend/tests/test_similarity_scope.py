"""Regression coverage for Similarity Gallery scope handling."""


def test_search_similar_passes_current_session_ids_to_index(test_db, monkeypatch):
    import database as db
    from services.similarity_service import SimilarityService

    first_id = db.add_image(path="/gallery/session-a.png", filename="session-a.png")
    second_id = db.add_image(path="/gallery/session-b.png", filename="session-b.png")
    db.add_gallery_session_image_ids([first_id, second_id])
    calls = []

    class FakeIndex:
        def search_by_id(self, image_id, *, limit, threshold, offset, allowed_ids):
            calls.append((image_id, limit, threshold, offset, allowed_ids))
            return {
                "results": [{"id": 12, "similarity": 0.9}],
                "total": 1,
                "has_more": False,
                "offset": offset,
                "limit": limit,
            }

    monkeypatch.setattr(
        "services.similarity_service.get_similarity_index",
        lambda _db: FakeIndex(),
    )

    result = SimilarityService().search_similar(
        first_id,
        limit=4,
        threshold=0.7,
        offset=2,
        scope="current_session",
    )

    assert result["results"] == [{"id": 12, "similarity": 0.9}]
    assert calls == [(first_id, 4, 0.7, 2, {first_id, second_id})]


def test_empty_current_session_short_circuits_similarity_index(test_db, monkeypatch):
    from services.similarity_service import SimilarityService

    def unexpected_index(_db):
        raise AssertionError("empty session must not initialize the similarity index")

    monkeypatch.setattr(
        "services.similarity_service.get_similarity_index",
        unexpected_index,
    )

    result = SimilarityService().search_similar(
        11,
        limit=4,
        offset=2,
        scope="current_session",
    )

    assert result == {
        "results": [],
        "count": 0,
        "total": 0,
        "has_more": False,
        "offset": 2,
        "limit": 4,
        "query_image_id": 11,
    }


def test_current_session_and_collection_scopes_intersect(test_db):
    import database as db
    from services.similarity_service import SimilarityService

    first_id = db.add_image(path="/gallery/intersection-a.png", filename="intersection-a.png")
    second_id = db.add_image(path="/gallery/intersection-b.png", filename="intersection-b.png")
    collection = db.create_collection("Intersection")
    collection_id = int(collection["id"])
    db.set_collection_membership(collection_id, second_id, True)
    db.add_gallery_session_image_ids([first_id, second_id])

    assert SimilarityService()._resolve_scope_ids(collection_id, "current_session") == {second_id}


def test_similarity_router_forwards_explicit_scope(test_client):
    from routers import similarity as similarity_router

    class FakeService:
        def search_similar(self, image_id, limit, threshold, offset, collection_id, scope):
            assert image_id == 77
            assert limit == 2
            assert threshold == 0.6
            assert offset == 1
            assert collection_id is None
            assert scope == "current_session"
            return {"query_image_id": image_id, "results": [], "count": 0}

    similarity_router.set_similarity_service(FakeService())
    try:
        response = test_client.get(
            "/api/similarity/search/77?limit=2&offset=1&threshold=0.6&scope=current_session"
        )
    finally:
        similarity_router.set_similarity_service(None)

    assert response.status_code == 200
    assert response.json()["query_image_id"] == 77
