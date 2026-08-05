"""End-to-end coverage for every shipped SQLite schema boundary."""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest

import database as db
import migrations


CURRENT_IMAGE_PATH = "/library/alpha.png"
CURRENT_ROOT_PATH = "/library"
CURRENT_LORA_NAME = "stylepack"

_HISTORICAL_IMAGE_COLUMNS: tuple[tuple[int, tuple[str, ...]], ...] = (
    (4, ("library_order_time", "source_file_mtime")),
    (5, ("checkpoint_normalized",)),
    (
        10,
        (
            "dominant_colors",
            "avg_brightness",
            "color_temperature",
            "color_saturation",
            "brightness_histogram",
            "brightness_skew",
            "brightness_distribution",
        ),
    ),
    (15, ("user_rating",)),
    (18, ("nl_caption",)),
    (22, ("dominant_color_tags",)),
    (23, ("raw_metadata_gz",)),
    (26, ("ai_rating", "ai_rating_confidence")),
)
_HISTORICAL_TABLES: tuple[tuple[int, str], ...] = (
    (6, "image_prompt_tokens"),
    (16, "library_roots"),
    (17, "favorite_paths"),
    (20, "activity_log"),
    (21, "reconnect_reviews"),
    (25, "tag_bulk_ops"),
    (27, "tag_scores"),
    (28, "image_path_identities"),
)
_HISTORICAL_INDEXES: tuple[tuple[int, str], ...] = (
    (4, "idx_images_library_order_time"),
    (5, "idx_images_checkpoint_normalized"),
    (7, "idx_images_path_lower"),
    (10, "idx_images_avg_brightness"),
    (10, "idx_images_color_temperature"),
    (10, "idx_images_brightness_distribution"),
    (10, "idx_images_brightness_skew"),
    (14, "idx_images_aesthetic_score"),
    (14, "idx_images_color_saturation"),
    (14, "idx_tags_lower_tag"),
    (15, "idx_images_user_rating"),
    (26, "idx_images_ai_rating"),
)


def _quote_identifier(identifier: str) -> str:
    return '"' + identifier.replace('"', '""') + '"'


def _drop_indexes_for_table(conn: sqlite3.Connection, table_name: str) -> None:
    rows = conn.execute(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?",
        (table_name,),
    ).fetchall()
    for row in rows:
        index_name = str(row[0])
        if not index_name.startswith("sqlite_autoindex_"):
            conn.execute(f"DROP INDEX {_quote_identifier(index_name)}")


def _rebuild_table_without_columns(
    conn: sqlite3.Connection,
    table_name: str,
    removed_columns: set[str],
) -> None:
    if not removed_columns:
        return

    table_identifier = _quote_identifier(table_name)
    table_info = conn.execute(f"PRAGMA table_info({table_identifier})").fetchall()
    existing_columns = {str(row[1]) for row in table_info}
    actual_removed = existing_columns.intersection(removed_columns)
    if not actual_removed:
        return

    _drop_indexes_for_table(conn, table_name)
    kept_rows = [row for row in table_info if str(row[1]) not in actual_removed]
    kept_columns = [str(row[1]) for row in kept_rows]
    definitions: list[str] = []
    for _cid, name, declared_type, not_null, default_value, primary_key in kept_rows:
        definition = f"{_quote_identifier(str(name))} {declared_type or 'TEXT'}"
        if int(primary_key):
            definition += " PRIMARY KEY"
            if table_name == "images" and str(name) == "id":
                definition += " AUTOINCREMENT"
        elif int(not_null):
            definition += " NOT NULL"
        if default_value is not None:
            definition += f" DEFAULT {default_value}"
        definitions.append(definition)

    if table_name == "images" and "path" in kept_columns:
        definitions.append("UNIQUE (\"path\")")

    temporary_name = f"{table_name}_historical"
    temporary_identifier = _quote_identifier(temporary_name)
    columns_sql = ", ".join(_quote_identifier(column) for column in kept_columns)
    conn.execute(f"DROP TABLE IF EXISTS {temporary_identifier}")
    conn.execute(f"CREATE TABLE {temporary_identifier} ({', '.join(definitions)})")
    conn.execute(
        f"INSERT INTO {temporary_identifier} ({columns_sql}) "
        f"SELECT {columns_sql} FROM {table_identifier}"
    )
    conn.execute(f"DROP TABLE {table_identifier}")
    conn.execute(f"ALTER TABLE {temporary_identifier} RENAME TO {table_identifier}")


def _recreate_baseline_indexes(conn: sqlite3.Connection, source_version: int) -> None:
    statements = (
        "CREATE INDEX IF NOT EXISTS idx_images_generator ON images(generator)",
        "CREATE INDEX IF NOT EXISTS idx_images_path ON images(path)",
        "CREATE INDEX IF NOT EXISTS idx_images_embedding ON images(embedding IS NOT NULL) WHERE embedding IS NOT NULL",
        "CREATE INDEX IF NOT EXISTS idx_images_checkpoint ON images(checkpoint) WHERE checkpoint IS NOT NULL",
        "CREATE INDEX IF NOT EXISTS idx_images_tagged_at ON images(tagged_at) WHERE tagged_at IS NULL",
        "CREATE INDEX IF NOT EXISTS idx_tags_tag_image ON tags(tag, image_id)",
        "CREATE INDEX IF NOT EXISTS idx_tags_image_id_tag ON tags(image_id, tag)",
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_unique_image_tag ON tags(image_id, tag)",
        "CREATE INDEX IF NOT EXISTS idx_images_filename ON images(filename)",
        "CREATE INDEX IF NOT EXISTS idx_images_model_hash ON images(model_hash) WHERE model_hash IS NOT NULL",
        "CREATE INDEX IF NOT EXISTS idx_images_readable ON images(is_readable)",
        "CREATE INDEX IF NOT EXISTS idx_images_metadata_status ON images(metadata_status)",
        "CREATE INDEX IF NOT EXISTS idx_image_loras_lora_name ON image_loras(lora_name)",
        "CREATE INDEX IF NOT EXISTS idx_image_loras_image_id ON image_loras(image_id)",
    )
    if source_version >= 6:
        statements += (
            "CREATE INDEX IF NOT EXISTS idx_image_prompt_tokens_token ON image_prompt_tokens(token)",
            "CREATE INDEX IF NOT EXISTS idx_image_prompt_tokens_image_id ON image_prompt_tokens(image_id)",
        )
    migration_index_statements = {
        "idx_images_library_order_time": "CREATE INDEX IF NOT EXISTS idx_images_library_order_time ON images(library_order_time DESC)",
        "idx_images_checkpoint_normalized": "CREATE INDEX IF NOT EXISTS idx_images_checkpoint_normalized ON images(checkpoint_normalized COLLATE NOCASE) WHERE checkpoint_normalized IS NOT NULL",
        "idx_images_path_lower": "CREATE INDEX IF NOT EXISTS idx_images_path_lower ON images(LOWER(path))",
        "idx_images_avg_brightness": "CREATE INDEX IF NOT EXISTS idx_images_avg_brightness ON images(avg_brightness)",
        "idx_images_color_temperature": "CREATE INDEX IF NOT EXISTS idx_images_color_temperature ON images(color_temperature)",
        "idx_images_brightness_distribution": "CREATE INDEX IF NOT EXISTS idx_images_brightness_distribution ON images(brightness_distribution)",
        "idx_images_brightness_skew": "CREATE INDEX IF NOT EXISTS idx_images_brightness_skew ON images(brightness_skew)",
        "idx_images_aesthetic_score": "CREATE INDEX IF NOT EXISTS idx_images_aesthetic_score ON images(aesthetic_score) WHERE aesthetic_score IS NOT NULL",
        "idx_images_color_saturation": "CREATE INDEX IF NOT EXISTS idx_images_color_saturation ON images(color_saturation) WHERE color_saturation IS NOT NULL",
        "idx_tags_lower_tag": "CREATE INDEX IF NOT EXISTS idx_tags_lower_tag ON tags(LOWER(tag))",
        "idx_images_user_rating": "CREATE INDEX IF NOT EXISTS idx_images_user_rating ON images(user_rating)",
        "idx_images_ai_rating": "CREATE INDEX IF NOT EXISTS idx_images_ai_rating ON images(ai_rating) WHERE ai_rating IS NOT NULL",
    }
    for introduced_version, index_name in _HISTORICAL_INDEXES:
        if source_version >= introduced_version:
            statements += (migration_index_statements[index_name],)
    for statement in statements:
        conn.execute(statement)


def _shape_historical_baseline(conn: sqlite3.Connection, source_version: int) -> None:
    removed_image_columns = {
        column
        for introduced_version, columns in _HISTORICAL_IMAGE_COLUMNS
        if source_version < introduced_version
        for column in columns
    }
    _rebuild_table_without_columns(conn, "images", removed_image_columns)
    if source_version < 24:
        _rebuild_table_without_columns(conn, "tags", {"source", "category"})

    for introduced_version, table_name in _HISTORICAL_TABLES:
        if source_version < introduced_version:
            conn.execute(f"DROP TABLE IF EXISTS {_quote_identifier(table_name)}")
    _recreate_baseline_indexes(conn, source_version)

    absent_columns = {
        column
        for introduced_version, columns in _HISTORICAL_IMAGE_COLUMNS
        if source_version < introduced_version
        for column in columns
    }
    assert not absent_columns.intersection(_column_names(conn, "images"))
    if source_version < 24:
        assert {"source", "category"}.isdisjoint(_column_names(conn, "tags"))
    for introduced_version, table_name in _HISTORICAL_TABLES:
        if source_version < introduced_version:
            assert table_name not in _table_names(conn)
    index_names = {
        str(row[0])
        for row in conn.execute(
            "SELECT name FROM sqlite_master WHERE type = 'index'"
        ).fetchall()
    }
    for introduced_version, index_name in _HISTORICAL_INDEXES:
        if source_version < introduced_version:
            assert index_name not in index_names
        else:
            assert index_name in index_names


def _build_v0_snapshot(path: Path) -> None:
    """Build the smallest unversioned database supported by the legacy path."""
    conn = sqlite3.connect(path)
    try:
        conn.executescript(
            """
            CREATE TABLE images (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                path TEXT UNIQUE NOT NULL,
                filename TEXT NOT NULL,
                generator TEXT DEFAULT 'unknown',
                prompt TEXT,
                negative_prompt TEXT,
                metadata_json TEXT,
                width INTEGER,
                height INTEGER,
                file_size INTEGER,
                checkpoint TEXT,
                loras TEXT,
                created_at DATETIME
            );
            CREATE TABLE tags (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                image_id INTEGER NOT NULL,
                tag TEXT NOT NULL,
                confidence REAL DEFAULT 1.0
            );
            """
        )
        _seed_core_rows(
            conn,
            include_legacy_lora_columns=True,
            include_collection=False,
        )
        conn.commit()
    finally:
        conn.close()


def _seed_core_rows(
    conn: sqlite3.Connection,
    *,
    include_legacy_lora_columns: bool,
    include_collection: bool,
) -> None:
    """Seed data that must survive every historical upgrade boundary."""
    if include_legacy_lora_columns:
        conn.execute(
            """
            INSERT INTO images (
                path, filename, generator, prompt, loras, checkpoint,
                metadata_json, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                CURRENT_IMAGE_PATH,
                "alpha.png",
                "webui",
                "portrait, <lora:StylePack:0.8>",
                '["StylePack"]',
                "models\\checkpoint.safetensors [ABC123]",
                "{}",
                "2026-01-02 03:04:05",
            ),
        )
    else:
        conn.execute(
            """
            INSERT INTO images (
                path, filename, generator, prompt, metadata_json, created_at
            ) VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                CURRENT_IMAGE_PATH,
                "alpha.png",
                "webui",
                "portrait, <lora:StylePack:0.8>",
                "{}",
                "2026-01-02 03:04:05",
            ),
        )

    image_id = int(
        conn.execute(
            "SELECT id FROM images WHERE path = ?", (CURRENT_IMAGE_PATH,)
        ).fetchone()[0]
    )
    conn.execute(
        "INSERT INTO tags (image_id, tag, confidence) VALUES (?, ?, ?)",
        (image_id, "explicit", 0.95),
    )
    conn.execute(
        "INSERT INTO tags (image_id, tag, confidence) VALUES (?, ?, ?)",
        (image_id, "portrait", 0.8),
    )

    if include_collection:
        collection_id = conn.execute(
            "SELECT id FROM collections WHERE slug = 'favorites'"
        ).fetchone()[0]
        conn.execute(
            """
            INSERT INTO collection_items (
                collection_id, source_image_id, copied_path, prompt, metadata_json,
                created_at
            ) VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                collection_id,
                image_id,
                CURRENT_IMAGE_PATH,
                "portrait, <lora:StylePack:0.8>",
                "{}",
                "2026-01-02 03:04:05",
            ),
        )


def _build_versioned_snapshot(path: Path, source_version: int) -> None:
    migration_list = migrations.get_migrations()
    conn = sqlite3.connect(path)
    try:
        baseline = migration_list[0]
        assert baseline.version == 1
        baseline.apply(conn)
        _seed_core_rows(
            conn,
            include_legacy_lora_columns=True,
            include_collection=True,
        )
        for migration in migration_list[1:]:
            if migration.version > source_version:
                break
            migration.apply(conn)
        _shape_historical_baseline(conn, source_version)

        conn.execute(
            """
            CREATE TABLE schema_version (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                version INTEGER NOT NULL
            )
            """
        )
        conn.execute(
            "INSERT INTO schema_version (id, version) VALUES (1, ?)",
            (source_version,),
        )
        if source_version >= 16:
            conn.execute(
                """
                INSERT INTO library_roots (
                    path, path_key, label, enabled, added_at, last_scanned_at
                ) VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    CURRENT_ROOT_PATH,
                    CURRENT_ROOT_PATH,
                    "Fixture Library",
                    1,
                    "2026-01-01T00:00:00",
                    "2026-01-03T00:00:00",
                ),
            )

        conn.commit()
    finally:
        conn.close()


def _build_snapshot(path: Path, source_version: int) -> None:
    if source_version == 0:
        _build_v0_snapshot(path)
        return
    _build_versioned_snapshot(path, source_version)


def _table_names(conn: sqlite3.Connection) -> set[str]:
    return {
        str(row[0])
        for row in conn.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table'"
        ).fetchall()
    }


def _column_names(conn: sqlite3.Connection, table_name: str) -> set[str]:
    return {
        str(row[1])
        for row in conn.execute(f"PRAGMA table_info({table_name})").fetchall()
    }


def test_migration_032_preserves_ordered_library_project_items(tmp_path: Path) -> None:
    db_path = tmp_path / "images-v31-project.db"
    _build_versioned_snapshot(db_path, 31)
    migration = next(item for item in migrations.get_migrations() if item.version == 32)
    conn = sqlite3.connect(db_path)
    try:
        image_id = int(
            conn.execute(
                "SELECT id FROM images WHERE path = ?",
                (CURRENT_IMAGE_PATH,),
            ).fetchone()[0]
        )
        project_id = int(
            conn.execute(
                "INSERT INTO dataset_projects (name, name_key) VALUES (?, ?)",
                ("Migration project", "migration project"),
            ).lastrowid
        )
        conn.execute(
            """
            INSERT INTO dataset_project_items (
                project_id, position, source_image_id, image_id
            ) VALUES (?, ?, ?, ?)
            """,
            (project_id, 0, image_id, image_id),
        )

        assert migration.apply(conn) is True
        assert migration.apply(conn) is False

        row = conn.execute(
            """
            SELECT position, item_type, source_image_id, image_id, local_source_id
            FROM dataset_project_items
            WHERE project_id = ?
            """,
            (project_id,),
        ).fetchone()
        assert tuple(row) == (0, "library", image_id, image_id, None)
        local_column_types = {
            str(column[1]): str(column[2])
            for column in conn.execute(
                "PRAGMA table_info(dataset_project_local_sources)"
            ).fetchall()
        }
        assert local_column_types["mtime_ns"] == "TEXT"
        assert local_column_types["device"] == "TEXT"
        assert local_column_types["inode"] == "TEXT"
    finally:
        conn.close()


def test_migration_033_materializes_fixed_project_settings(tmp_path: Path) -> None:
    db_path = tmp_path / "images-v32-project.db"
    _build_versioned_snapshot(db_path, 32)
    migration = next(item for item in migrations.get_migrations() if item.version == 33)
    conn = sqlite3.connect(db_path)
    try:
        project_id = int(
            conn.execute(
                "INSERT INTO dataset_projects (name, name_key) VALUES (?, ?)",
                ("Legacy settings", "legacy settings"),
            ).lastrowid
        )

        assert migration.apply(conn) is True
        assert migration.apply(conn) is False

        settings_json = str(
            conn.execute(
                "SELECT settings_json FROM dataset_projects WHERE id = ?",
                (project_id,),
            ).fetchone()[0]
        )
        assert json.loads(settings_json) == {
            "settings_version": 1,
            "target_model": "",
            "caption_render": {
                "trigger": "",
                "common_tags": [],
                "blacklist": [],
                "normalize_tag_underscores": True,
                "content_mode": "template",
                "prefix": "",
                "template": {
                    "template_override": "{trigger}, {tags:filtered}, {append}",
                    "replace_rules": {},
                    "max_tags": 0,
                },
            },
            "naming": {
                "preset": "keep",
                "custom_pattern": "{trigger}_{index:03d}",
            },
            "output": {
                "mode": "folder",
                "folder": "",
                "image_op": "copy",
                "overwrite_policy": "unique",
            },
            "trainer": {
                "config": "none",
                "contract_version": None,
                "mask_export": "none",
                "repeats": 10,
                "batch": 2,
                "resolution": 1024,
                "keep_tokens": 0,
            },
            "planning": {"epochs": 10},
        }
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(
                "UPDATE dataset_projects SET settings_json = '[]' WHERE id = ?",
                (project_id,),
            )
    finally:
        conn.close()


def test_migration_034_creates_complete_annotation_ledger(tmp_path: Path) -> None:
    db_path = tmp_path / "images-v33-annotations.db"
    _build_versioned_snapshot(db_path, 33)
    migration = next(item for item in migrations.get_migrations() if item.version == 34)
    conn = sqlite3.connect(db_path)
    try:
        assert migration.apply(conn) is True
        assert migration.apply(conn) is False
        assert {
            "annotation_subjects",
            "annotation_revisions",
            "annotation_heads",
        } <= _table_names(conn)
        assert {
            "subject_kind",
            "subject_key",
            "library_source_image_id",
            "library_path_key",
            "library_size",
            "library_mtime_ns",
            "library_device",
            "library_inode",
            "local_path_key",
        } <= _column_names(conn, "annotation_subjects")
        assert {
            "content_json",
            "content_sha256",
            "parent_revision_id",
            "restored_from_revision_id",
        } <= _column_names(conn, "annotation_revisions")
        assert {
            "active_revision_id",
            "reviewed_revision_id",
            "export_revision_id",
            "generation",
        } <= _column_names(conn, "annotation_heads")
        trigger_names = {
            str(row[0])
            for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type = 'trigger'"
            ).fetchall()
        }
        assert {
            "trg_annotation_subjects_immutable",
            "trg_annotation_revisions_immutable",
            "trg_annotation_heads_identity_immutable",
        } <= trigger_names
        conn.execute("DROP INDEX idx_annotation_revisions_subject_history")
        with pytest.raises(RuntimeError, match="partially present"):
            migration.apply(conn)
    finally:
        conn.close()


def test_migration_039_materializes_neutral_subject_crop_settings(tmp_path: Path) -> None:
    db_path = tmp_path / "images-v38-subject-crop.db"
    _build_versioned_snapshot(db_path, 38)
    migration = next(item for item in migrations.get_migrations() if item.version == 39)
    conn = sqlite3.connect(db_path)
    try:
        project_id = int(
            conn.execute(
                "INSERT INTO dataset_projects (name, name_key) VALUES (?, ?)",
                ("Legacy crop settings", "legacy crop settings"),
            ).lastrowid
        )

        assert migration.apply(conn) is True
        assert migration.apply(conn) is False
        settings_json = str(
            conn.execute(
                "SELECT settings_json FROM dataset_projects WHERE id = ?",
                (project_id,),
            ).fetchone()[0]
        )
        assert json.loads(settings_json)["subject_crop"] == {
            "enabled": False,
            "alpha_threshold": 1,
            "padding_percent": 0,
            "background_mode": "keep_background",
            "solid_color": "#000000",
        }
    finally:
        conn.close()


def test_migration_040_materializes_neutral_bucket_resize_settings(tmp_path: Path) -> None:
    db_path = tmp_path / "images-v39-bucket-resize.db"
    _build_versioned_snapshot(db_path, 39)
    migration = next(item for item in migrations.get_migrations() if item.version == 40)
    conn = sqlite3.connect(db_path)
    try:
        project_id = int(
            conn.execute(
                "INSERT INTO dataset_projects (name, name_key) VALUES (?, ?)",
                ("Legacy bucket settings", "legacy bucket settings"),
            ).lastrowid
        )

        assert migration.apply(conn) is True
        assert migration.apply(conn) is False
        settings_json = str(
            conn.execute(
                "SELECT settings_json FROM dataset_projects WHERE id = ?",
                (project_id,),
            ).fetchone()[0]
        )
        assert json.loads(settings_json)["bucket_resize"] == {
            "enabled": False,
            "subject_aware": False,
            "alpha_threshold": 128,
        }
    finally:
        conn.close()


def test_migration_034_rejects_partial_annotation_schema(tmp_path: Path) -> None:
    db_path = tmp_path / "images-v33-partial-annotations.db"
    _build_versioned_snapshot(db_path, 33)
    migration = next(item for item in migrations.get_migrations() if item.version == 34)
    conn = sqlite3.connect(db_path)
    try:
        conn.execute("CREATE TABLE annotation_subjects (id INTEGER PRIMARY KEY)")
        with pytest.raises(RuntimeError, match="partially present"):
            migration.apply(conn)
        assert "annotation_revisions" not in _table_names(conn)
        assert "annotation_heads" not in _table_names(conn)
    finally:
        conn.close()


HISTORICAL_SCHEMA_BOUNDARIES = tuple(
    range(0, migrations.get_migrations()[-1].version)
)


@pytest.mark.parametrize("source_version", HISTORICAL_SCHEMA_BOUNDARIES)
def test_every_historical_schema_boundary_upgrades_to_current(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    source_version: int,
) -> None:
    """Every shipped schema boundary must reach the current schema intact."""
    db_path = tmp_path / f"images-v{source_version}.db"
    _build_snapshot(db_path, source_version)
    monkeypatch.setattr(db, "DATABASE_PATH", str(db_path))
    db._pragmas_initialized = set()

    db.init_db()

    migration_list = migrations.get_migrations()
    latest_version = migration_list[-1].version
    conn = sqlite3.connect(db_path)
    try:
        assert conn.execute(
            "SELECT version FROM schema_version WHERE id = 1"
        ).fetchone()[0] == latest_version

        image = conn.execute(
            """
            SELECT id, path, prompt, checkpoint_normalized, metadata_status,
                   is_readable, ai_rating, ai_rating_confidence, user_rating,
                   library_order_time, source_file_mtime, nl_caption
            FROM images WHERE path = ?
            """,
            (CURRENT_IMAGE_PATH,),
        ).fetchone()
        assert image is not None
        image_id = int(image[0])
        assert image[1] == CURRENT_IMAGE_PATH
        assert image[2] == "portrait, <lora:StylePack:0.8>"
        assert image[3] == "checkpoint"
        assert image[4] == "complete"
        assert int(image[5]) == 1
        assert image[6] == "explicit"
        assert image[7] == pytest.approx(0.95)
        assert int(image[8]) == 0
        assert image[9] == "2026-01-02 03:04:05"
        assert image[10] == "2026-01-02 03:04:05"
        assert image[11] is None

        tags = {
            str(row[0])
            for row in conn.execute(
                "SELECT tag FROM tags WHERE image_id = ?", (image_id,)
            ).fetchall()
        }
        assert {"explicit", "portrait"} <= tags
        provenance = conn.execute(
            "SELECT source, category FROM tags WHERE image_id = ?",
            (image_id,),
        ).fetchall()
        assert provenance
        assert all(row[0] is None and row[1] is None for row in provenance)

        loras = {
            str(row[0])
            for row in conn.execute(
                "SELECT lora_name FROM image_loras WHERE image_id = ?", (image_id,)
            ).fetchall()
        }
        assert CURRENT_LORA_NAME in loras

        tokens = {
            str(row[0])
            for row in conn.execute(
                "SELECT token FROM image_prompt_tokens WHERE image_id = ?", (image_id,)
            ).fetchall()
        }
        assert {"portrait"} <= tokens

        required_tables = {
            "images",
            "tags",
            "collections",
            "collection_items",
            "library_roots",
            "favorite_paths",
            "activity_log",
            "reconnect_reviews",
            "tag_bulk_ops",
            "tag_scores",
            "image_path_identities",
            "dataset_projects",
            "dataset_project_items",
            "dataset_project_local_sources",
            "annotation_subjects",
            "annotation_revisions",
            "annotation_heads",
        }
        assert required_tables <= _table_names(conn)
        assert {
            "raw_metadata_gz",
            "dominant_color_tags",
            "ai_rating",
            "ai_rating_confidence",
        } <= _column_names(conn, "images")
        assert {
            "item_type",
            "source_image_id",
            "image_id",
            "local_source_id",
        } <= _column_names(conn, "dataset_project_items")
        assert "settings_json" in _column_names(conn, "dataset_projects")

        if source_version >= 16:
            root = conn.execute(
                "SELECT path, path_key, label, enabled FROM library_roots WHERE path = ?",
                (CURRENT_ROOT_PATH,),
            ).fetchone()
            assert root is not None
            assert tuple(root) == (
                CURRENT_ROOT_PATH,
                CURRENT_ROOT_PATH,
                "Fixture Library",
                1,
            )

        favorite_columns = _column_names(conn, "favorite_paths")
        assert {"path_key", "match_case"} <= favorite_columns
        if source_version >= 1:
            favorite = conn.execute(
                "SELECT path_key, match_case FROM favorite_paths WHERE path_key = ?",
                (CURRENT_IMAGE_PATH,),
            ).fetchone()
            assert favorite is not None
            assert tuple(favorite) == (CURRENT_IMAGE_PATH, 1)
    finally:
        conn.close()
