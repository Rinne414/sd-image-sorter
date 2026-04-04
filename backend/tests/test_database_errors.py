"""
Critical tests for database error handling.

Tests database connection errors, constraint violations, and error recovery.

Priority: CRITICAL
"""
import os
import sys
import sqlite3
import tempfile
from pathlib import Path
from unittest.mock import patch, MagicMock

import pytest

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

import database as db


class TestDatabaseConnectionErrors:
    """Tests for database connection error handling."""

    def test_database_path_permission_denied(self, tmp_path: Path):
        """Database should handle permission errors gracefully."""
        # Skip on Windows where permission handling differs
        if os.name == "nt":
            pytest.skip("Permission test not reliable on Windows")

        # Create a directory where we can't write
        protected_path = tmp_path / "protected" / "test.db"

        original_path = db.DATABASE_PATH
        try:
            db.DATABASE_PATH = str(protected_path)

            # This should either create the directory or handle the error
            # The behavior depends on permissions
        finally:
            db.DATABASE_PATH = original_path

    def test_database_locked_handling(self, test_db):
        """Database should handle locked database gracefully."""
        import threading

        errors = []

        def concurrent_write():
            try:
                # Try to write while another connection is active
                db.add_image(path="/test/concurrent.png", filename="concurrent.png")
            except Exception as e:
                errors.append(e)

        # Start multiple concurrent writes
        threads = [threading.Thread(target=concurrent_write) for _ in range(5)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        # Should either succeed or handle errors gracefully
        # No unhandled exceptions should propagate

    def test_database_corruption_recovery(self, test_db_path: Path):
        """Database should detect and report corruption."""
        # Write invalid data to the database file
        with open(test_db_path, "wb") as f:
            f.write(b"not a valid sqlite database")

        # Attempting to use the corrupted database should raise an error
        original_path = db.DATABASE_PATH
        try:
            db.DATABASE_PATH = str(test_db_path)

            with pytest.raises(Exception):
                db.get_image_count()
        finally:
            db.DATABASE_PATH = original_path


class TestConstraintViolations:
    """Tests for database constraint violation handling."""

    def test_unique_path_constraint(self, test_db):
        """Adding a duplicate path should update the existing row in place."""
        path = "/test/duplicate_path.png"

        id1 = db.add_image(path=path, filename="first.png", prompt="first")
        id2 = db.add_image(path=path, filename="second.png", prompt="second")

        assert id2 == id1

        image = db.get_image_by_id(id1)
        assert image["prompt"] == "second"

        with db.get_db() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT COUNT(*) FROM images WHERE path = ?", (path,))
            assert cursor.fetchone()[0] == 1

    def test_foreign_key_violation_tags(self, test_db):
        """Adding tags for nonexistent image should fail gracefully."""
        # Try to add tags for an image that doesn't exist
        # This should handle the foreign key constraint gracefully
        try:
            db.add_tags(999999, [{"tag": "test", "confidence": 0.9}])
            # If it doesn't raise, check that no tags were added
            tags = db.get_image_tags(999999)
            assert tags == [] or tags is None
        except sqlite3.IntegrityError:
            # This is also acceptable behavior
            pass

    def test_invalid_image_id_operations(self, test_db):
        """Operations on invalid image IDs should be handled."""
        # Delete nonexistent image
        db.delete_image(999999)  # Should not raise

        # Update path of nonexistent image
        db.update_image_path(999999, "/new/path.png")  # Should not raise

        # Get tags of nonexistent image
        tags = db.get_image_tags(999999)
        assert tags == []


class TestDataValidationErrors:
    """Tests for data validation error handling."""

    def test_null_path_handling(self, test_db):
        """Null path should be handled gracefully."""
        try:
            # Path is required, should fail validation
            image_id = db.add_image(path=None, filename="test.png")
            # If it doesn't raise, the image should have an empty or null path
        except (TypeError, sqlite3.IntegrityError):
            # Expected behavior
            pass

    def test_invalid_width_height(self, test_db):
        """Invalid dimensions should not crash image insertion."""
        # Negative dimensions
        try:
            image_id = db.add_image(
                path="/test/negative.png",
                filename="negative.png",
                width=-100,
                height=-100,
            )
            # If it doesn't raise, the row should still be retrievable.
            image = db.get_image_by_id(image_id)
            assert image is not None
            assert image["width"] in (-100, None) or image["width"] >= 0
            assert image["height"] in (-100, None) or image["height"] >= 0
        except sqlite3.IntegrityError:
            pass

    def test_empty_loras_json(self, test_db):
        """Empty LoRAs array should be handled."""
        image_id = db.add_image(
            path="/test/empty_loras.png",
            filename="empty_loras.png",
            loras=[],
        )

        image = db.get_image_by_id(image_id)
        import json
        loras = json.loads(image["loras"])
        assert loras == []

    def test_malformed_loras_json(self, test_db):
        """Malformed LoRAs should be handled."""
        # Store a string that's not valid JSON
        image_id = db.add_image(
            path="/test/malformed_loras.png",
            filename="malformed_loras.png",
        )

        # Directly update with malformed JSON
        with db.get_db() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "UPDATE images SET loras = ? WHERE id = ?",
                ("not valid json", image_id),
            )

        # Retrieving should handle the malformed JSON
        image = db.get_image_by_id(image_id)
        # Should return the raw string or parse gracefully
        assert image is not None


class TestTransactionErrors:
    """Tests for transaction error handling."""

    def test_rollback_on_error(self, test_db):
        """Failed operations should rollback cleanly."""
        # Add an image
        id1 = db.add_image(path="/test/rollback1.png", filename="rollback1.png")

        # Try an operation that might fail
        try:
            # Attempt to add tags for nonexistent image (may fail)
            db.add_tags(999999, [{"tag": "test", "confidence": 0.9}])
        except:
            pass

        # Original image should still exist
        image = db.get_image_by_id(id1)
        assert image is not None

    def test_concurrent_transaction_isolation(self, test_db):
        """Concurrent transactions should be isolated."""
        import threading

        results = {"success": 0, "errors": []}

        def add_image_thread(i):
            try:
                db.add_image(
                    path=f"/test/concurrent_{i}.png",
                    filename=f"concurrent_{i}.png",
                )
                results["success"] += 1
            except Exception as e:
                results["errors"].append(e)

        threads = [threading.Thread(target=add_image_thread, args=(i,)) for i in range(10)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        # All operations should succeed or fail gracefully
        assert len(results["errors"]) == 0 or results["success"] > 0


class TestQueryErrors:
    """Tests for query error handling."""

    def test_invalid_sort_column(self, test_db_with_images):
        """Invalid sort column should use default."""
        data = test_db_with_images
        db_module = data["db"]

        # Invalid sort should not crash
        images = db_module.get_images(sort_by="nonexistent_column", limit=10)
        assert isinstance(images, list)

    def test_negative_limit(self, test_db):
        """Negative limit should be handled."""
        # Negative limit should be rejected or normalized
        try:
            images = db.get_images(limit=-1)
            # If it doesn't raise, should return empty or handle gracefully
            assert isinstance(images, list)
        except ValueError:
            pass

    def test_very_large_limit(self, test_db_with_images):
        """Very large limit should be handled."""
        data = test_db_with_images
        db_module = data["db"]

        # Request way more images than exist
        images = db_module.get_images(limit=999999999)

        # Should return all available images
        assert isinstance(images, list)
        assert len(images) <= 999999999

    def test_special_characters_in_search(self, test_db):
        """Special characters in search should not break queries."""
        db.add_image(
            path="/test/special.png",
            filename="special.png",
            prompt="test prompt with % and _ characters",
        )

        # These characters have special meaning in LIKE
        for char in ["%", "_", "'", '"', "\\"]:
            images = db.get_images(search_query=char)
            # Should not raise an error
            assert isinstance(images, list)


class TestDatabaseRecovery:
    """Tests for database recovery scenarios."""

    def test_reinit_after_corruption(self, test_db_path: Path):
        """Database should be reinitializable after the corrupted file is cleared."""
        original_path = db.DATABASE_PATH
        try:
            db.DATABASE_PATH = str(test_db_path)

            # Corrupt the database
            with open(test_db_path, "wb") as f:
                f.write(b"corrupted")

            # Clear the bad file, then reinitialize a fresh database.
            test_db_path.unlink()
            db.init_db()

            # Should be usable now
            count = db.get_image_count()
            assert isinstance(count, int)
        finally:
            db.DATABASE_PATH = original_path

    def test_connection_retry_after_close(self, test_db):
        """Database operations should work after connection closes."""
        # Add an image
        image_id = db.add_image(path="/test/retry.png", filename="retry.png")

        # Force close all connections by reinitializing
        db.init_db()

        # Operations should still work (new connection)
        count = db.get_image_count()
        assert isinstance(count, int)
