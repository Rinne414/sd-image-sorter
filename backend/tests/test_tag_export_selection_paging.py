"""Real-SQLite contracts for filtered tag-export ID streaming."""

from __future__ import annotations

from itertools import chain
from pathlib import Path
import re
import sqlite3
from types import ModuleType, SimpleNamespace

import pytest

import db_core
from services.tag_export import selection
from services.tag_export import sidecars


def _insert_export_rows(database: ModuleType, count: int, generator: str) -> None:
    with database.get_db() as connection:
        connection.executemany(
            """
            INSERT INTO images (path, filename, generator, prompt, created_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (
                (
                    f"/paging/image-{index:05d}.png",
                    f"image-{index:05d}.png",
                    generator,
                    f"caption-{index:05d}",
                    "2026-01-01 00:00:00",
                )
                for index in range(1, count + 1)
            ),
        )


def _trace_database_queries(
    monkeypatch: pytest.MonkeyPatch,
    database: ModuleType,
) -> list[str]:
    statements: list[str] = []
    real_get_connection = database.get_connection

    def traced_connection() -> sqlite3.Connection:
        connection = real_get_connection()
        connection.set_trace_callback(statements.append)
        return connection

    monkeypatch.setattr(db_core, "_connection_provider", traced_connection)
    return statements


def _page_offsets(statements: list[str], page_size: int) -> list[int]:
    normalized = [" ".join(statement.split()) for statement in statements]
    page_queries = [
        statement
        for statement in normalized
        if statement.upper().startswith("SELECT I.ID FROM IMAGES I")
        and f"LIMIT {page_size} OFFSET" in statement
    ]
    offsets: list[int] = []
    for statement in page_queries:
        match = re.search(r" LIMIT \d+ OFFSET (\d+);?$", statement)
        if match is None:
            raise AssertionError(f"Filtered ID query has no terminal OFFSET: {statement}")
        offsets.append(int(match.group(1)))
    return offsets


def test_database_query_pages_are_independent_from_consumer_chunks(
    test_db: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _insert_export_rows(test_db, 12, "page-contract")
    with test_db.get_db() as connection:
        image_ids = [
            int(row["id"])
            for row in connection.execute(
                "SELECT id FROM images WHERE generator = ? ORDER BY id ASC",
                ("page-contract",),
            ).fetchall()
        ]
        tag_rows: list[tuple[int, str]] = [
            (image_id, "page-a") for image_id in image_ids
        ]
        tag_rows.append((image_ids[4], "page-b"))
        connection.executemany(
            "INSERT INTO tags (image_id, tag, confidence) VALUES (?, ?, 0.9)",
            tag_rows,
        )
    statements = _trace_database_queries(monkeypatch, test_db)

    chunks = list(
        test_db.iter_filtered_image_id_chunks(
            chunk_size=3,
            query_page_size=5,
            tags=["page-a", "page-b"],
            tag_mode="or",
            sort_by="oldest",
        )
    )

    flattened = list(chain.from_iterable(chunks))
    assert [len(chunk) for chunk in chunks] == [3, 3, 3, 3]
    assert flattened == sorted(flattened)
    assert len(flattened) == len(set(flattened)) == 12
    assert _page_offsets(statements, 5) == [0, 5, 10]


def test_database_empty_filtered_page_yields_no_consumer_chunk(
    test_db: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    statements = _trace_database_queries(monkeypatch, test_db)

    chunks = list(
        test_db.iter_filtered_image_id_chunks(
            chunk_size=3,
            query_page_size=5,
            generators=["missing-generator"],
            sort_by="oldest",
        )
    )

    assert chunks == []
    assert _page_offsets(statements, 5) == [0]


def test_filtered_selection_reads_10000_rows_but_yields_at_most_500(
    test_db: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _insert_export_rows(test_db, 10_001, "selection-contract")
    statements = _trace_database_queries(monkeypatch, test_db)
    id_chunks = selection._iter_decoded_filter_id_chunks(
        {"generators": ["selection-contract"], "sortBy": "oldest"},
        selection.EXPORT_DB_CHUNK_SIZE,
    )

    first_chunk = next(id_chunks)
    assert len(first_chunk) == selection.EXPORT_DB_CHUNK_SIZE
    assert _page_offsets(statements, 10_000) == [0]

    chunks = [first_chunk, *id_chunks]
    flattened = list(chain.from_iterable(chunks))
    assert [len(chunk) for chunk in chunks] == [500] * 20 + [1]
    assert flattened == sorted(flattened)
    assert len(flattened) == len(set(flattened)) == 10_001
    assert _page_offsets(statements, 10_000) == [0, 10_000]


def test_filtered_combined_export_matches_explicit_id_output_bytes(
    test_db: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    _insert_export_rows(test_db, 1_001, "combined-contract")
    monkeypatch.setattr(sidecars, "_get_combined_export_dir", lambda: tmp_path)
    request = SimpleNamespace(blacklist=[], prefix="", content_mode="prompt")
    filtered_chunks = selection._iter_decoded_filter_id_chunks(
        {"generators": ["combined-contract"], "sortBy": "oldest"},
        selection.EXPORT_DB_CHUNK_SIZE,
    )
    filtered_result = sidecars.export_tags_combined_request(
        request,
        id_chunks=filtered_chunks,
        total=1_001,
    )

    explicit_ids = test_db.get_filtered_image_ids(
        generators=["combined-contract"],
        sort_by="oldest",
    )
    explicit_result = sidecars.export_tags_combined_request(
        request,
        id_chunks=selection._iter_id_list_chunks(
            explicit_ids,
            selection.EXPORT_DB_CHUNK_SIZE,
        ),
        total=len(explicit_ids),
    )

    filtered_bytes = sidecars.combined_export_path(filtered_result["token"]).read_bytes()
    explicit_bytes = sidecars.combined_export_path(explicit_result["token"]).read_bytes()
    expected_bytes = "\n".join(
        f"caption-{index:05d}" for index in range(1, 1_002)
    ).encode("utf-8")
    assert filtered_bytes == explicit_bytes == expected_bytes
    assert filtered_result["exported"] == explicit_result["exported"] == 1_001
