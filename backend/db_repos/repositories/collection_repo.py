"""
Collection repository implementation.

Provides concrete implementation of CollectionRepositoryBase using SQLite.
Wraps the existing database.py functions for backward compatibility.
"""

import os
from datetime import datetime
from typing import Optional, List, Dict, Any

from fastapi import HTTPException

from .base import CollectionRepositoryBase, ImageFilters, DatabaseConnection

# Import database functions for backward compatibility
import sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
import database as db_module


class CollectionRepository(CollectionRepositoryBase):
    """Concrete implementation of CollectionRepositoryBase.

    Wraps the existing database module functions to provide a clean
    repository interface while maintaining backward compatibility.
    """

    def __init__(self, connection: Optional[DatabaseConnection] = None):
        """Initialize the collection repository.

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
        """Find a collection by its primary key.

        Args:
            id: The primary key of the collection

        Returns:
            The collection record if found, None otherwise
        """
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM collections WHERE id = ?", (id,))
            row = cursor.fetchone()
            return dict(row) if row else None

    def find_by_slug(self, slug: str) -> Optional[Dict[str, Any]]:
        """Find a collection by its slug.

        Args:
            slug: The collection slug

        Returns:
            The collection record if found, None otherwise
        """
        return db_module.get_collection_by_slug(slug)

    def find_all(
        self,
        filters: Optional[ImageFilters] = None,
        sort_by: str = "newest",
        limit: int = 100,
        offset: int = 0,
    ) -> List[Dict[str, Any]]:
        """Find all collections.

        Note: Filters are not applicable to collections.

        Args:
            filters: Optional filter criteria (ignored)
            sort_by: Sorting method
            limit: Maximum number of results
            offset: Number of results to skip

        Returns:
            List of collection records
        """
        with self._get_connection() as conn:
            cursor = conn.cursor()

            # Validate sort_by parameter
            valid_sort_options = ['newest', 'oldest', 'name_asc', 'name_desc']
            if sort_by not in valid_sort_options:
                raise HTTPException(
                    status_code=400,
                    detail=f"Invalid sort_by value: '{sort_by}'. Must be one of: {', '.join(valid_sort_options)}"
                )
            
            order_clause = "created_at DESC"
            if sort_by == "oldest":
                order_clause = "created_at ASC"
            elif sort_by == "name_asc":
                order_clause = "name ASC"
            elif sort_by == "name_desc":
                order_clause = "name DESC"

            cursor.execute(
                f"SELECT * FROM collections ORDER BY {order_clause} LIMIT ? OFFSET ?",
                (limit, offset),
            )
            return [dict(row) for row in cursor.fetchall()]

    def find_item(
        self, collection_id: int, source_image_id: int
    ) -> Optional[Dict[str, Any]]:
        """Find a collection item by collection and source image IDs.

        Args:
            collection_id: The collection ID
            source_image_id: The source image ID

        Returns:
            The collection item if found, None otherwise
        """
        return db_module.get_collection_item(collection_id, source_image_id)

    def create(self, entity: Dict[str, Any]) -> int:
        """Create a new collection.

        Args:
            entity: Dictionary containing:
                   - slug (required): Unique slug identifier
                   - name (required): Display name
                   - folder_path (required): Path to collection folder

        Returns:
            The ID of the created collection
        """
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "INSERT INTO collections (slug, name, folder_path) VALUES (?, ?, ?)",
                (entity.get("slug"), entity.get("name"), entity.get("folder_path")),
            )
            return cursor.lastrowid

    def add_item(
        self,
        collection_id: int,
        source_image_id: int,
        copied_path: str,
        prompt: Optional[str] = None,
        negative_prompt: Optional[str] = None,
        checkpoint: Optional[str] = None,
        loras: Optional[str] = None,
        metadata_json: Optional[str] = None,
        created_at: Optional[datetime] = None,
        width: Optional[int] = None,
        height: Optional[int] = None,
        file_size: Optional[int] = None,
    ) -> int:
        """Add an item to a collection.

        Args:
            collection_id: The collection ID
            source_image_id: The source image ID
            copied_path: Path to the copied file
            prompt: Optional prompt
            negative_prompt: Optional negative prompt
            checkpoint: Optional checkpoint name
            loras: Optional loras JSON
            metadata_json: Optional metadata JSON
            created_at: Optional creation timestamp
            width: Optional width
            height: Optional height
            file_size: Optional file size

        Returns:
            The ID of the created item
        """
        return db_module.add_collection_item(
            collection_id=collection_id,
            source_image_id=source_image_id,
            copied_path=copied_path,
            prompt=prompt,
            negative_prompt=negative_prompt,
            checkpoint=checkpoint,
            loras=loras,
            metadata_json=metadata_json,
            created_at=created_at,
            width=width,
            height=height,
            file_size=file_size,
        )

    def remove_item(self, collection_id: int, source_image_id: int) -> bool:
        """Remove an item from a collection.

        Args:
            collection_id: The collection ID
            source_image_id: The source image ID

        Returns:
            True if successful
        """
        db_module.remove_collection_item(collection_id, source_image_id)
        return True

    def update(self, id: int, entity: Dict[str, Any]) -> bool:
        """Update an existing collection.

        Args:
            id: The primary key of the collection to update
            entity: Dictionary with updated values (name, folder_path)

        Returns:
            True if the update was successful
        """
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "UPDATE collections SET name = ?, folder_path = ? WHERE id = ?",
                (entity.get("name"), entity.get("folder_path"), id),
            )
            return cursor.rowcount > 0

    def delete(self, id: int) -> bool:
        """Delete a collection by its primary key.

        Note: This will cascade delete all collection_items.

        Args:
            id: The primary key of the collection to delete

        Returns:
            True if the deletion was successful
        """
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("DELETE FROM collections WHERE id = ?", (id,))
            return cursor.rowcount > 0

    def count(self, filters: Optional[ImageFilters] = None) -> int:
        """Count collections.

        Args:
            filters: Optional filter criteria (ignored)

        Returns:
            Number of collections
        """
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT COUNT(*) FROM collections")
            return cursor.fetchone()[0]

    def count_items(self, collection_id: int) -> int:
        """Count items in a collection.

        Args:
            collection_id: The collection ID

        Returns:
            Number of items in the collection
        """
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "SELECT COUNT(*) FROM collection_items WHERE collection_id = ?",
                (collection_id,),
            )
            return cursor.fetchone()[0]

    def get_favorite_source_ids(self) -> List[int]:
        """Get all source image IDs in Favorites collection.

        Returns:
            List of source image IDs
        """
        return db_module.get_favorite_source_ids()

    def get_favorites_count(self) -> int:
        """Get the count of items in Favorites collection.

        Returns:
            Number of favorites
        """
        return db_module.get_favorites_count()

    def find_items_by_collection(
        self,
        collection_id: int,
        limit: int = 100,
        offset: int = 0,
    ) -> List[Dict[str, Any]]:
        """Get all items in a collection with pagination.

        Args:
            collection_id: The collection ID
            limit: Maximum number of results
            offset: Number of results to skip

        Returns:
            List of collection items
        """
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                SELECT * FROM collection_items
                WHERE collection_id = ?
                ORDER BY added_at DESC
                LIMIT ? OFFSET ?
                """,
                (collection_id, limit, offset),
            )
            return [dict(row) for row in cursor.fetchall()]

    def find_items_by_source(
        self,
        source_image_id: int,
    ) -> List[Dict[str, Any]]:
        """Find all collection items for a source image.

        Args:
            source_image_id: The source image ID

        Returns:
            List of collection items containing this source image
        """
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                SELECT * FROM collection_items
                WHERE source_image_id = ?
                """,
                (source_image_id,),
            )
            return [dict(row) for row in cursor.fetchall()]

    def is_favorited(self, source_image_id: int) -> bool:
        """Check if an image is in the Favorites collection.

        Args:
            source_image_id: The source image ID

        Returns:
            True if the image is favorited
        """
        favorite_ids = set(self.get_favorite_source_ids())
        return source_image_id in favorite_ids
