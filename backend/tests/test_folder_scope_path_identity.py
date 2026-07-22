from __future__ import annotations

import pytest

import database as db
from db_helpers import _folder_scope_query_match_clause
from utils.source_paths import indexed_image_path_casefold


@pytest.mark.parametrize(
    ("managed_path", "raw_path", "sibling_path", "folder_path"),
    [
        (
            r"C:\Library\Ä\Managed.png",
            r"C:\LIBRARY\Ä\Raw.png",
            r"C:\Library\Ä-other\Sibling.png",
            "/mnt/c/library/ä",
        ),
        (
            "/mnt/c/Library/Ä/Managed.png",
            "/mnt/c/LIBRARY/Ä/Raw.png",
            "/mnt/c/Library/Ä-other/Sibling.png",
            r"C:\library\ä",
        ),
        (
            r"\\Server\Share\Ä\Managed.png",
            r"\\SERVER\SHARE\Ä\Raw.png",
            r"\\Server\Share\Ä-other\Sibling.png",
            "//server/share/ä",
        ),
    ],
)
def test_unicode_folder_scope_uses_materialized_identity(
    test_db,
    managed_path: str,
    raw_path: str,
    sibling_path: str,
    folder_path: str,
):
    managed_id = db.add_image(path=managed_path, filename="Managed.png")
    sibling_id = db.add_image(path=sibling_path, filename="Sibling.png")
    with db.get_db() as conn:
        cursor = conn.execute(
            "INSERT INTO images (path, filename) VALUES (?, ?)",
            (raw_path, "Raw.png"),
        )
        raw_id = int(cursor.lastrowid)
        assert conn.execute(
            "SELECT 1 FROM image_path_identities WHERE image_id = ?",
            (raw_id,),
        ).fetchone() is None

    rows = db.get_images_in_folder_scope(folder_path, recursive=True)

    assert {int(row["id"]) for row in rows} == {managed_id}
    assert sibling_id not in {int(row["id"]) for row in rows}


def test_unicode_non_recursive_folder_scope_keeps_only_direct_children(test_db):
    direct_id = db.add_image(
        path=r"C:\Library\Ä\Direct.png",
        filename="Direct.png",
    )
    nested_id = db.add_image(
        path=r"C:\Library\Ä\Nested\Deep.png",
        filename="Deep.png",
    )

    rows = db.get_images_in_folder_scope(
        "/mnt/c/library/ä",
        recursive=False,
    )

    assert {int(row["id"]) for row in rows} == {direct_id}
    assert nested_id not in {int(row["id"]) for row in rows}


@pytest.mark.parametrize(
    ("folder_path", "inside_path", "outside_path"),
    [
        ("/library/Case", "/library/Case/inside.png", "/library/case/outside.png"),
        ("/library/100%", "/library/100%/inside.png", "/library/100x/outside.png"),
        ("/library/a_b", "/library/a_b/inside.png", "/library/axb/outside.png"),
    ],
)
def test_posix_folder_scope_is_case_sensitive_and_literal(
    test_db,
    folder_path: str,
    inside_path: str,
    outside_path: str,
):
    inside_id = db.add_image(path=inside_path, filename="inside.png")
    outside_id = db.add_image(path=outside_path, filename="outside.png")

    rows = db.get_images_in_folder_scope(folder_path, recursive=True)

    assert {int(row["id"]) for row in rows} == {inside_id}
    assert outside_id not in {int(row["id"]) for row in rows}


def test_unicode_folder_scope_does_not_scan_or_casefold_unrelated_images(test_db):
    managed_id = db.add_image(
        path=r"C:\Library\Ä\Managed.png",
        filename="Managed.png",
    )
    with db.get_db() as conn:
        conn.executemany(
            "INSERT INTO images (path, filename) VALUES (?, ?)",
            (
                (f"/unrelated/image-{index:05d}.png", f"image-{index:05d}.png")
                for index in range(5000)
            ),
        )
        raw_cursor = conn.execute(
            "INSERT INTO images (path, filename) VALUES (?, ?)",
            (r"C:\LIBRARY\Ä\Raw.png", "Raw.png"),
        )
        raw_id = int(raw_cursor.lastrowid)
        casefold_calls = 0

        def count_casefold_calls(path: str) -> str:
            nonlocal casefold_calls
            casefold_calls += 1
            return indexed_image_path_casefold(path)

        conn.create_function(
            "indexed_path_casefold",
            1,
            count_casefold_calls,
            deterministic=True,
        )
        clause, params = _folder_scope_query_match_clause(
            r"C:\library\ä",
            column="i.path",
        )
        plan = "\n".join(
            str(row[3])
            for row in conn.execute(
                f"EXPLAIN QUERY PLAN SELECT i.id FROM images i WHERE {clause}",
                params,
            )
        )
        result_ids = {
            int(row[0])
            for row in conn.execute(
                f"SELECT i.id FROM images i WHERE {clause}",
                params,
            )
        }

    assert result_ids == {managed_id}
    assert raw_id not in result_ids
    assert casefold_calls == 0
    assert "idx_image_path_identities_path_key" in plan
    assert "SCAN i" not in plan
    assert "SCAN identity_images" not in plan
