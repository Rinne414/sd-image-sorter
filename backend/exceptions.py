"""
Custom exception classes for SD Image Sorter.

Provides specific exception types for better error handling and user-friendly messages.
"""
from typing import Optional, Any


class SDImageSorterError(Exception):
    """Base exception for all SD Image Sorter errors."""

    def __init__(self, message: str, details: Optional[Any] = None):
        self.message = message
        self.details = details
        super().__init__(self.message)

    def to_dict(self) -> dict:
        """Convert exception to dictionary for API responses."""
        result = {"error": self.message, "type": self.__class__.__name__}
        if self.details:
            result["details"] = self.details
        return result


class ImageNotFoundError(SDImageSorterError):
    """Raised when an image is not found in the database or on disk."""

    def __init__(self, image_id: Optional[int] = None, path: Optional[str] = None, details: Optional[Any] = None):
        if image_id is not None:
            message = f"Image with ID {image_id} not found"
        elif path:
            message = f"Image file not found: {path}"
        else:
            message = "Image not found"
        super().__init__(message, details)
        self.image_id = image_id
        self.path = path


class TaggingError(SDImageSorterError):
    """Raised when an error occurs during AI tagging."""

    def __init__(self, message: str = "Tagging operation failed", details: Optional[Any] = None):
        super().__init__(message, details)


class ScanError(SDImageSorterError):
    """Raised when a folder scan operation fails."""

    def __init__(self, message: str = "Scan operation failed", path: Optional[str] = None, details: Optional[Any] = None):
        if path:
            message = f"{message}: {path}"
        super().__init__(message, details)
        self.path = path


class ConfigurationError(SDImageSorterError):
    """Raised when there is a configuration or initialization error."""

    def __init__(self, message: str = "Configuration error", details: Optional[Any] = None):
        super().__init__(message, details)


class ValidationError(SDImageSorterError):
    """Raised when input validation fails."""

    def __init__(self, message: str, field: Optional[str] = None, details: Optional[Any] = None):
        if field:
            message = f"Validation error for '{field}': {message}"
        super().__init__(message, details)
        self.field = field


class FileOperationError(SDImageSorterError):
    """Raised when a file operation (move, copy, delete) fails."""

    def __init__(self, message: str, path: Optional[str] = None, operation: Optional[str] = None, details: Optional[Any] = None):
        if operation and path:
            message = f"Failed to {operation} '{path}': {message}"
        elif path:
            message = f"File operation failed for '{path}': {message}"
        super().__init__(message, details)
        self.path = path
        self.operation = operation


class DatabaseError(SDImageSorterError):
    """Raised when a database operation fails."""

    def __init__(self, message: str = "Database operation failed", details: Optional[Any] = None):
        super().__init__(message, details)


class ModelLoadError(SDImageSorterError):
    """Raised when an AI model fails to load."""

    def __init__(self, model_name: str, reason: Optional[str] = None, details: Optional[Any] = None):
        message = f"Failed to load model '{model_name}'"
        if reason:
            message = f"{message}: {reason}"
        super().__init__(message, details)
        self.model_name = model_name


class OperationInProgressError(SDImageSorterError):
    """Raised when trying to start an operation that is already running."""

    def __init__(self, operation: str = "Operation"):
        super().__init__(f"{operation} is already in progress")
        self.operation = operation


class PathSecurityError(SDImageSorterError):
    """Raised when a path validation fails due to security concerns."""

    def __init__(self, message: str = "Invalid or unsafe path", path: Optional[str] = None, details: Optional[Any] = None):
        super().__init__(message, details)
        self.path = path
