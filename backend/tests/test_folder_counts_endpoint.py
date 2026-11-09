"""GET /api/folders carries each folder's picture count for the sidebar tree.

The tree showed counts on collections and Quick views but none on folders
(blind judges, round 19, 2026-11-09). The endpoint now sends the pictures
directly inside each folder; js/folder-tree.js adds sub-folders up, the same
subtree the recursive folder filter shows.
"""

from __future__ import annotations


def test_folders_endpoint_sends_direct_counts(test_client):
    db = test_client.test_db
    for path in ("/lib/a/x.png", "/lib/a/y.png", "/lib/a/sub/z.png"):
        db.add_image(path=path, filename=path.rsplit("/", 1)[1], metadata_json="{}")

    response = test_client.get("/api/folders")

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["folders"] == ["/lib/a", "/lib/a/sub"]
    assert body["counts"] == {"/lib/a": 2, "/lib/a/sub": 1}
