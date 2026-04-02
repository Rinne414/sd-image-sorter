"""
Tag repository implementation.

Provides concrete implementation of TagRepositoryBase using SQLite.
Wraps the existing database.py functions for backward compatibility.
"""

import os
from typing import Optional, List, Dict, Any

from .base import TagRepositoryBase, ImageFilters, DatabaseConnection

# Import database functions for backward compatibility
import sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
import database as db_module


class TagRepository(TagRepositoryBase):
    """Concrete implementation of TagRepositoryBase.

    Wraps the existing database module functions to provide a clean
    repository interface while maintaining backward compatibility.
    """

    def __init__(self, connection: Optional[DatabaseConnection] = None):
        """Initialize the tag repository.

        Args:
            connection: Optional database connection for dependency injection.
                       If None, uses the module's connection management.
        """
        self._connection = connection

    def _get_connection(self):
        """Get the database connection."""
        if self._connection:
            return self._connection
        return db_module.get_db()

    def find_by_id(self, id: int) -> Optional[Dict[str, Any]]:
        """Find a tag by its primary key.

        Note: Tags are typically queried by image_id, not by their own ID.
        This method is provided for interface completeness.

        Args:
            id: The primary key of the tag

        Returns:
            The tag record if found, None otherwise
        """
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM tags WHERE id = ?", (id,))
            row = cursor.fetchone()
            return dict(row) if row else None

    def find_all(
        self,
        filters: Optional[ImageFilters] = None,
        sort_by: str = "newest",
        limit: int = 100,
        offset: int = 0,
    ) -> List[Dict[str, Any]]:
        """Find all tags matching optional filters.

        Note: This returns all unique tags with counts, not individual tag rows.
        The filters are ignored for tags as they apply to images.

        Args:
            filters: Optional filter criteria (ignored for tags)
            sort_by: Sorting method (ignored for tags)
            limit: Maximum number of results
            offset: Number of results to skip

        Returns:
            List of {tag, count} dictionaries
        """
        all_tags = self.get_all_tags_with_counts()
        return all_tags[offset : offset + limit]

    def find_by_image_id(self, image_id: int) -> List[Dict[str, Any]]:
        """Get all tags for an image.

        Args:
            image_id: The image ID

        Returns:
            List of {tag, confidence} dictionaries sorted by confidence
        """
        return db_module.get_image_tags(image_id)

    def create(self, entity: Dict[str, Any]) -> int:
        """Create a new tag.

        Note: Tags are typically created via add_tags_for_image.
        This method creates a single tag row.

        Args:
            entity: Dictionary containing:
                   - image_id (required): The image ID
                   - tag (required): The tag string
                   - confidence: Confidence score (default 1.0)

        Returns:
            The ID of the created tag
        """
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "INSERT INTO tags (image_id, tag, confidence) VALUES (?, ?, ?)",
                (
                    entity.get("image_id"),
                    entity.get("tag"),
                    entity.get("confidence", 1.0),
                ),
            )
            return cursor.lastrowid

    def add_tags_for_image(
        self, image_id: int, tags: List[Dict[str, Any]]
    ) -> bool:
        """Add tags for an image (replaces existing tags).

        Args:
            image_id: The image ID
            tags: List of {tag, confidence} dictionaries

        Returns:
            True if successful
        """
        db_module.add_tags(image_id, tags)
        return True

    def update(self, id: int, entity: Dict[str, Any]) -> bool:
        """Update an existing tag.

        Args:
            id: The primary key of the tag to update
            entity: Dictionary with updated values (tag, confidence)

        Returns:
            True if the update was successful
        """
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "UPDATE tags SET tag = ?, confidence = ? WHERE id = ?",
                (entity.get("tag"), entity.get("confidence", 1.0), id),
            )
            return cursor.rowcount > 0

    def delete(self, id: int) -> bool:
        """Delete a tag by its primary key.

        Args:
            id: The primary key of the tag to delete

        Returns:
            True if the deletion was successful
        """
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("DELETE FROM tags WHERE id = ?", (id,))
            return cursor.rowcount > 0

    def delete_by_image_id(self, image_id: int) -> bool:
        """Delete all tags for an image.

        Args:
            image_id: The image ID

        Returns:
            True if successful
        """
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("DELETE FROM tags WHERE image_id = ?", (image_id,))
            return True

    def count(self, filters: Optional[ImageFilters] = None) -> int:
        """Count tags.

        Note: This returns the count of unique tags, not total tag rows.

        Args:
            filters: Optional filter criteria (ignored)

        Returns:
            Number of unique tags
        """
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT COUNT(DISTINCT tag) FROM tags")
            return cursor.fetchone()[0]

    def count_for_image(self, image_id: int) -> int:
        """Count tags for a specific image.

        Args:
            image_id: The image ID

        Returns:
            Number of tags for the image
        """
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "SELECT COUNT(*) FROM tags WHERE image_id = ?", (image_id,)
            )
            return cursor.fetchone()[0]

    def get_all_tags_with_counts(self) -> List[Dict[str, Any]]:
        """Get all unique tags with their counts.

        Returns:
            List of {tag, count} dictionaries sorted by count descending
        """
        return db_module.get_all_tags()

    def find_images_by_tags(
        self,
        tags: List[str],
        limit: int = 100,
        offset: int = 0,
    ) -> List[int]:
        """Find image IDs that have all specified tags.

        Uses AND logic: images must have ALL tags.

        Args:
            tags: List of tags to filter by
            limit: Maximum number of results
            offset: Number of results to skip

        Returns:
            List of image IDs
        """
        if not tags:
            return []

        filters = ImageFilters(tags=tags)
        from .image_repo import ImageRepository

        image_repo = ImageRepository()
        return image_repo.find_filtered_ids(filters=filters)
