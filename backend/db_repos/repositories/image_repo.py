"""
Image repository implementation.

Provides concrete implementation of ImageRepositoryBase using SQLite.
Wraps the existing database.py functions for backward compatibility.
"""

import os
import json
from datetime import datetime
from typing import Optional, List, Dict, Any

from .base import (
    ImageRepositoryBase,
    ImageFilters,
    DatabaseConnection,
)

# Import database functions for backward compatibility
import sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
import database as db_module


class ImageRepository(ImageRepositoryBase):
    """Concrete implementation of ImageRepositoryBase.

    Wraps the existing database module functions to provide a clean
    repository interface while maintaining backward compatibility.

    This implementation uses the singleton connection pattern from
    the original database module.
    """

    def __init__(self, connection: Optional[DatabaseConnection] = None):
        """Initialize the image repository.

        Args:
            connection: Optional database connection for dependency injection.
                       If None, uses the module's connection management.
        """
        self._connection = connection

    def _get_connection(self):
        """Get the database connection.

        Returns the injected connection or uses module's connection management.
        """
        if self._connection:
            return self._connection
        return db_module.get_db()

    def find_by_id(self, id: int) -> Optional[Dict[str, Any]]:
        """Find an image by its primary key.

        Args:
            id: The primary key of the image

        Returns:
            The image record if found, None otherwise
        """
        return db_module.get_image_by_id(id)

    def find_by_path(self, path: str) -> Optional[Dict[str, Any]]:
        """Find an image by its file path.

        Args:
            path: The file path of the image

        Returns:
            The image record if found, None otherwise
        """
        return db_module.get_image_by_path(path)

    def find_all(
        self,
        filters: Optional[ImageFilters] = None,
        sort_by: str = "newest",
        limit: int = 100,
        offset: int = 0,
    ) -> List[Dict[str, Any]]:
        """Find all images matching optional filters.

        Args:
            filters: Optional filter criteria (ImageFilters dataclass)
            sort_by: Sorting method
            limit: Maximum number of results
            offset: Number of results to skip

        Returns:
            List of matching image records
        """
        if filters is None:
            filters = ImageFilters()

        return db_module.get_images(
            generators=filters.generators,
            tags=filters.tags,
            ratings=filters.ratings,
            checkpoints=filters.checkpoints,
            loras=filters.loras,
            search_query=filters.search_query,
            sort_by=sort_by,
            limit=limit,
            offset=offset,
            min_width=filters.min_width,
            max_width=filters.max_width,
            min_height=filters.min_height,
            max_height=filters.max_height,
            prompt_terms=filters.prompt_terms,
            aspect_ratio=filters.aspect_ratio,
            artist=filters.artist,
            image_ids=filters.image_ids,
        )

    def find_untagged(self, limit: int = 100) -> List[Dict[str, Any]]:
        """Find images that haven't been tagged yet.

        Args:
            limit: Maximum number of results

        Returns:
            List of untagged images
        """
        return db_module.get_untagged_images(limit)

    def find_untagged_ids(self) -> List[int]:
        """Get IDs of images that haven't been tagged.

        Returns:
            List of image IDs
        """
        return db_module.get_untagged_image_ids()

    def find_all_ids(self) -> List[int]:
        """Get all image IDs.

        Returns:
            List of all image IDs
        """
        return db_module.get_all_image_ids()

    def find_filtered_ids(
        self,
        filters: Optional[ImageFilters] = None,
        sort_by: str = "newest",
    ) -> List[int]:
        """Get list of image IDs matching filters.

        Memory-efficient: Returns only IDs, not full image dictionaries.

        Args:
            filters: Optional filter criteria
            sort_by: Sorting method

        Returns:
            List of matching image IDs
        """
        if filters is None:
            filters = ImageFilters()

        return db_module.get_filtered_image_ids(
            generators=filters.generators,
            tags=filters.tags,
            ratings=filters.ratings,
            checkpoints=filters.checkpoints,
            loras=filters.loras,
            search_query=filters.search_query,
            sort_by=sort_by,
            min_width=filters.min_width,
            max_width=filters.max_width,
            min_height=filters.min_height,
            max_height=filters.max_height,
            prompt_terms=filters.prompt_terms,
            aspect_ratio=filters.aspect_ratio,
            artist=filters.artist,
            image_ids=filters.image_ids,
        )

    def find_paginated(
        self,
        filters: Optional[ImageFilters] = None,
        sort_by: str = "newest",
        limit: int = 100,
        cursor_id: Optional[int] = None,
        cursor_sort_value: Optional[str] = None,
        cursor_is_opaque: bool = False,
    ) -> Dict[str, Any]:
        """Get images with cursor-based pagination.

        Args:
            filters: Optional filter criteria
            sort_by: Sorting method
            limit: Number of images per page
            cursor_id: Last image ID from previous page
            cursor_sort_value: Stored sort boundary from the decoded cursor token
            cursor_is_opaque: Whether the caller supplied an opaque API cursor token

        Returns:
            Dictionary with images, next_cursor, has_more, total
        """
        if filters is None:
            filters = ImageFilters()

        return db_module.get_images_paginated(
            generators=filters.generators,
            tags=filters.tags,
            ratings=filters.ratings,
            checkpoints=filters.checkpoints,
            loras=filters.loras,
            search_query=filters.search_query,
            sort_by=sort_by,
            limit=limit,
            cursor_id=cursor_id,
            cursor_sort_value=cursor_sort_value,
            cursor_is_opaque=cursor_is_opaque,
            min_width=filters.min_width,
            max_width=filters.max_width,
            min_height=filters.min_height,
            max_height=filters.max_height,
            prompt_terms=filters.prompt_terms,
            aspect_ratio=filters.aspect_ratio,
            artist=filters.artist,
        )

    def create(self, entity: Dict[str, Any]) -> int:
        """Create a new image record.

        Args:
            entity: Dictionary containing image data with keys:
                   - path (required): File path
                   - filename (required): File name
                   - generator: Generator type (default 'unknown')
                   - prompt: Positive prompt
                   - negative_prompt: Negative prompt
                   - metadata_json: Raw metadata JSON
                   - width: Image width
                   - height: Image height
                   - file_size: File size in bytes
                   - checkpoint: Raw checkpoint/model name for display
                   - checkpoint_normalized: Derived filter/search key (computed on write)
                   - loras: List of LoRA names
                   - library_order_time: Stable library ordering timestamp
                   - source_file_mtime: Current source file modification timestamp
                   - created_at: Deprecated compatibility alias for library_order_time

        Returns:
            The ID of the created image
        """
        return db_module.add_image(
            path=entity.get("path"),
            filename=entity.get("filename"),
            generator=entity.get("generator", "unknown"),
            prompt=entity.get("prompt"),
            negative_prompt=entity.get("negative_prompt"),
            metadata_json=entity.get("metadata_json"),
            width=entity.get("width"),
            height=entity.get("height"),
            file_size=entity.get("file_size"),
            checkpoint=entity.get("checkpoint"),
            loras=entity.get("loras"),
            library_order_time=entity.get("library_order_time"),
            source_file_mtime=entity.get("source_file_mtime"),
            created_at=entity.get("created_at"),
        )

    def update(self, id: int, entity: Dict[str, Any]) -> bool:
        """Update an existing image.

        Note: This uses update_image_metadata for partial updates.
        For full row replacement, use create with the same path.

        Args:
            id: The primary key of the image to update
            entity: Dictionary with updated values

        Returns:
            True if the update was successful
        """
        db_module.update_image_metadata(
            image_id=id,
            generator=entity.get("generator", "unknown"),
            prompt=entity.get("prompt"),
            negative_prompt=entity.get("negative_prompt"),
            metadata_json=entity.get("metadata_json"),
            width=entity.get("width"),
            height=entity.get("height"),
            file_size=entity.get("file_size"),
            checkpoint=entity.get("checkpoint"),
            loras=entity.get("loras"),
        )
        return True

    def update_path(self, image_id: int, new_path: str) -> bool:
        """Update the path of an image after moving.

        Args:
            image_id: The image ID
            new_path: The new file path

        Returns:
            True if successful
        """
        db_module.update_image_path(image_id, new_path)
        return True

    def update_metadata(
        self,
        image_id: int,
        generator: str,
        prompt: Optional[str],
        negative_prompt: Optional[str],
        metadata_json: Optional[str],
        width: Optional[int],
        height: Optional[int],
        file_size: Optional[int],
        checkpoint: Optional[str],
        loras: Optional[List[str]],
    ) -> bool:
        """Update parsed metadata fields for an existing image.

        Args:
            image_id: The image ID
            generator: The generator type
            prompt: The positive prompt
            negative_prompt: The negative prompt
            metadata_json: Raw metadata JSON
            width: Image width
            height: Image height
            file_size: File size in bytes
            checkpoint: Checkpoint/model name
            loras: List of LoRA names

        Returns:
            True if successful
        """
        db_module.update_image_metadata(
            image_id=image_id,
            generator=generator,
            prompt=prompt,
            negative_prompt=negative_prompt,
            metadata_json=metadata_json,
            width=width,
            height=height,
            file_size=file_size,
            checkpoint=checkpoint,
            loras=loras,
        )
        return True

    def delete(self, id: int) -> bool:
        """Delete an image by its primary key.

        Args:
            id: The primary key of the image to delete

        Returns:
            True if the deletion was successful
        """
        db_module.delete_image(id)
        return True

    def count(self, filters: Optional[ImageFilters] = None) -> int:
        """Count images matching optional filters.

        Args:
            filters: Optional filter criteria

        Returns:
            Number of matching images
        """
        if filters is None:
            return db_module.get_image_count()

        return db_module.get_filtered_image_count(
            generators=filters.generators,
            tags=filters.tags,
            ratings=filters.ratings,
            checkpoints=filters.checkpoints,
            loras=filters.loras,
            search_query=filters.search_query,
            min_width=filters.min_width,
            max_width=filters.max_width,
            min_height=filters.min_height,
            max_height=filters.max_height,
            prompt_terms=filters.prompt_terms,
            aspect_ratio=filters.aspect_ratio,
            artist=filters.artist,
            image_ids=filters.image_ids,
        )

    def get_all_generators(self) -> List[Dict[str, Any]]:
        """Get all generators with their counts.

        Returns:
            List of {generator, count} dictionaries
        """
        return db_module.get_all_generators()
