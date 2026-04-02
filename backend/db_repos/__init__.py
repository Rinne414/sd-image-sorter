"""
Database repositories package for SD Image Sorter.

Provides repository pattern implementations for cleaner architecture.
This package provides the Repository Pattern abstraction layer over
the existing database.py module.

Usage:
    # Repository pattern (recommended for new code)
    from db_repos import ImageRepository, TagRepository, CollectionRepository
    from db_repos import ImageFilters

    # Example usage:
    image_repo = ImageRepository()
    images = image_repo.find_all(filters=ImageFilters(tags=["portrait"]), limit=50)
    image = image_repo.find_by_id(123)

    # Dependency injection with FastAPI:
    def get_image_repo() -> ImageRepository:
        return ImageRepository()
"""

# Import repositories for clean access
from .repositories import (
    Repository,
    ImageFilters,
    ImageRepository,
    TagRepository,
    CollectionRepository,
)

__all__ = [
    "Repository",
    "ImageFilters",
    "ImageRepository",
    "TagRepository",
    "CollectionRepository",
]
