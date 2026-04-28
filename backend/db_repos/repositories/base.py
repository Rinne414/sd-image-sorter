"""
Abstract base repository interface following the Repository Pattern.

Provides a generic interface for data access with type safety and
dependency injection support for FastAPI.
"""

from abc import ABC, abstractmethod
from typing import (
    Generic,
    TypeVar,
    Optional,
    List,
    Dict,
    Any,
    Protocol,
    dataclass_transform,
)
from dataclasses import dataclass, field
from datetime import datetime
import sqlite3


# Type variable for entity types
T = TypeVar("T")


class DatabaseConnection(Protocol):
    """Protocol for database connection abstraction.

    Allows different connection implementations to be injected,
    enabling easier testing and potential future database backends.
    """

    def cursor(self) -> sqlite3.Cursor:
        """Get a database cursor."""
        ...

    def commit(self) -> None:
        """Commit the current transaction."""
        ...

    def rollback(self) -> None:
        """Rollback the current transaction."""
        ...

    def close(self) -> None:
        """Close the connection."""
        ...


@dataclass
class ImageFilters:
    """Filter parameters for image queries.

    Encapsulates all possible filter combinations for image retrieval.
    Used by ImageRepository.find_all() and related methods.

    Attributes:
        generators: Filter by generator type (OR logic)
        tags: Filter by tags (AND logic - image must have ALL tags)
        ratings: Filter by rating tags (OR logic)
        checkpoints: Filter by checkpoint names (OR logic)
        loras: Filter by lora names (OR logic)
        search_query: Search in prompt text
        prompt_terms: Multi-prompt filter (AND logic)
        min_width: Minimum width constraint
        max_width: Maximum width constraint
        min_height: Minimum height constraint
        max_height: Maximum height constraint
        aspect_ratio: Filter by aspect ratio ('square', 'landscape', 'portrait')
        artist: Filter by artist name
        image_ids: Filter by specific image IDs
    """

    generators: Optional[List[str]] = None
    tags: Optional[List[str]] = None
    ratings: Optional[List[str]] = None
    checkpoints: Optional[List[str]] = None
    loras: Optional[List[str]] = None
    search_query: Optional[str] = None
    prompt_terms: Optional[List[str]] = None
    min_width: Optional[int] = None
    max_width: Optional[int] = None
    min_height: Optional[int] = None
    max_height: Optional[int] = None
    aspect_ratio: Optional[str] = None
    artist: Optional[str] = None
    image_ids: Optional[List[int]] = None


class Repository(ABC, Generic[T]):
    """Abstract base repository interface.

    Provides the standard CRUD operations that all repositories must implement.
    Follows the Repository Pattern for clean separation of data access logic.

    Type Parameters:
        T: The entity type this repository manages
    """

    @abstractmethod
    def find_by_id(self, id: int) -> Optional[T]:
        """Find an entity by its primary key.

        Args:
            id: The primary key of the entity

        Returns:
            The entity if found, None otherwise
        """
        ...

    @abstractmethod
    def find_all(
        self,
        filters: Optional[ImageFilters] = None,
        sort_by: str = "newest",
        limit: int = 100,
        offset: int = 0,
    ) -> List[T]:
        """Find all entities matching optional filters.

        Args:
            filters: Optional filter criteria
            sort_by: Sorting method
            limit: Maximum number of results
            offset: Number of results to skip

        Returns:
            List of matching entities
        """
        ...

    @abstractmethod
    def create(self, entity: T) -> int:
        """Create a new entity.

        Args:
            entity: The entity to create

        Returns:
            The ID of the created entity
        """
        ...

    @abstractmethod
    def update(self, id: int, entity: T) -> bool:
        """Update an existing entity.

        Args:
            id: The primary key of the entity to update
            entity: The entity with updated values

        Returns:
            True if the update was successful, False otherwise
        """
        ...

    @abstractmethod
    def delete(self, id: int) -> bool:
        """Delete an entity by its primary key.

        Args:
            id: The primary key of the entity to delete

        Returns:
            True if the deletion was successful, False otherwise
        """
        ...

    @abstractmethod
    def count(self, filters: Optional[ImageFilters] = None) -> int:
        """Count entities matching optional filters.

        Args:
            filters: Optional filter criteria

        Returns:
            Number of matching entities
        """
        ...


class ImageRepositoryBase(Repository[Dict[str, Any]], ABC):
    """Abstract base for image-specific repository operations.

    Extends the base Repository interface with image-specific methods
    that don't fit the standard CRUD pattern.
    """

    @abstractmethod
    def find_by_path(self, path: str) -> Optional[Dict[str, Any]]:
        """Find an image by its file path.

        Args:
            path: The file path of the image

        Returns:
            The image record if found, None otherwise
        """
        ...

    @abstractmethod
    def find_untagged(self, limit: int = 100) -> List[Dict[str, Any]]:
        """Find images that haven't been tagged yet.

        Args:
            limit: Maximum number of results

        Returns:
            List of untagged images
        """
        ...

    @abstractmethod
    def find_untagged_ids(self) -> List[int]:
        """Get IDs of images that haven't been tagged.

        Returns:
            List of image IDs
        """
        ...

    @abstractmethod
    def find_all_ids(self) -> List[int]:
        """Get all image IDs.

        Returns:
            List of all image IDs
        """
        ...

    @abstractmethod
    def update_path(self, image_id: int, new_path: str) -> bool:
        """Update the path of an image after moving.

        Args:
            image_id: The image ID
            new_path: The new file path

        Returns:
            True if successful
        """
        ...

    @abstractmethod
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
        ...

    @abstractmethod
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
        ...

    @abstractmethod
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
        ...

    @abstractmethod
    def get_all_generators(self) -> List[Dict[str, Any]]:
        """Get all generators with their counts.

        Returns:
            List of {generator, count} dictionaries
        """
        ...


class TagRepositoryBase(Repository[Dict[str, Any]], ABC):
    """Abstract base for tag-specific repository operations.

    Extends the base Repository interface with tag-specific methods.
    """

    @abstractmethod
    def find_by_image_id(self, image_id: int) -> List[Dict[str, Any]]:
        """Get all tags for an image.

        Args:
            image_id: The image ID

        Returns:
            List of {tag, confidence} dictionaries
        """
        ...

    @abstractmethod
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
        ...

    @abstractmethod
    def get_all_tags_with_counts(self) -> List[Dict[str, Any]]:
        """Get all unique tags with their counts.

        Returns:
            List of {tag, count} dictionaries sorted by count descending
        """
        ...


class CollectionRepositoryBase(Repository[Dict[str, Any]], ABC):
    """Abstract base for collection-specific repository operations.

    Handles favorites and other collection management.
    """

    @abstractmethod
    def find_by_slug(self, slug: str) -> Optional[Dict[str, Any]]:
        """Find a collection by its slug.

        Args:
            slug: The collection slug

        Returns:
            The collection record if found, None otherwise
        """
        ...

    @abstractmethod
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
        ...

    @abstractmethod
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
        ...

    @abstractmethod
    def remove_item(
        self, collection_id: int, source_image_id: int
    ) -> bool:
        """Remove an item from a collection.

        Args:
            collection_id: The collection ID
            source_image_id: The source image ID

        Returns:
            True if successful
        """
        ...

    @abstractmethod
    def get_favorite_source_ids(self) -> List[int]:
        """Get all source image IDs in Favorites collection.

        Returns:
            List of source image IDs
        """
        ...

    @abstractmethod
    def get_favorites_count(self) -> int:
        """Get the count of items in Favorites collection.

        Returns:
            Number of favorites
        """
        ...
