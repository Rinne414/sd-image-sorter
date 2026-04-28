"""
Tests for repository-layer image path lookup behavior.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

import migrations  # noqa: E402
from db_repos.repositories.image_repo import ImageRepository  # noqa: E402
import database as db  # noqa: E402


def test_image_repository_find_by_path_matches_equivalent_windows_wsl_forms(test_db):
    """Repository path lookups should reuse the shared indexed-path equivalence rules."""
    windows_path = r"L:\datasets\repo\lookup.png"
    image_id = db.add_image(path=windows_path, filename="lookup.png")

    repo = ImageRepository()
    image = repo.find_by_path("/mnt/l/datasets/repo/lookup.png")

    assert image is not None
    assert image["id"] == image_id
    assert image["path"] == windows_path


def test_migrations_are_unique_and_strictly_increasing():
    """Migration versions should stay deterministic and monotonic."""
    migration_list = migrations.get_migrations()
    versions = [migration.version for migration in migration_list]

    assert versions
    assert versions == sorted(versions)
    assert len(versions) == len(set(versions))


def test_new_database_schema_version_matches_latest_migration(test_db):
    """Fresh databases should finish at the latest known migration version."""
    latest_version = migrations.get_migrations()[-1].version

    with db.get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT version FROM schema_version WHERE id = 1")
        row = cursor.fetchone()

    assert row is not None
    assert int(row["version"]) == latest_version
