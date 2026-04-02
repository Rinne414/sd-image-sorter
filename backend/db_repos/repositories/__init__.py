"""
Repository pattern implementations for database access.

Provides abstract and concrete repository classes for:
- Images: CRUD operations and complex filtering
- Tags: Tag management and queries
- Collections: Favorites and collection management
"""

from .base import Repository, ImageFilters
from .image_repo import ImageRepository
from .tag_repo import TagRepository
from .collection_repo import CollectionRepository

__all__ = [
    "Repository",
    "ImageFilters",
    "ImageRepository",
    "TagRepository",
    "CollectionRepository",
]
