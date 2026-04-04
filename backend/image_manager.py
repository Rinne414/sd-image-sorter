"""
Image manager for file operations (scanning, moving, copying).
"""
import logging
import os
import shutil
from typing import List, Dict, Any, Optional, Callable
from datetime import datetime
from pathlib import Path
import json

from config import ALLOWED_IMAGE_EXTENSIONS as IMAGE_EXTENSIONS
from database import add_image, update_image_path, get_images, add_tags, update_image_metadata
from metadata_parser import parse_image
from exceptions import ScanError, FileOperationError, ImageNotFoundError

logger = logging.getLogger(__name__)


def scan_folder(
    folder_path: str,
    recursive: bool = True,
    progress_callback: Optional[Callable] = None
) -> Dict[str, Any]:
    """
    Scan a folder for images and add them to the database.
    
    Args:
        folder_path: Path to scan
        recursive: Whether to scan subdirectories
        progress_callback: Optional callback(current, total, filename)
    
    Returns:
        {
            "total": int,
            "new": int,
            "updated": int,
            "errors": int,
            "by_generator": {generator: count}
        }
    """
    result: Dict[str, Any] = {
        "total": 0,
        "new": 0,
        "updated": 0,
        "errors": 0,
        "by_generator": {}
    }
    
    # C5: Use a generator to avoid collecting all paths into memory at once.
    # Count pass first (cheap — no file open) then stream-process.
    folder = Path(folder_path)
    if folder.is_symlink():
        raise ScanError("Refusing to scan symlinked folders", path=folder_path)
    if not folder.exists():
        raise ScanError("Folder does not exist", path=folder_path)
    if not folder.is_dir():
        raise ScanError("Path is not a directory", path=folder_path)

    def _iter_images():
        if recursive:
            for root, dirnames, filenames in os.walk(folder, followlinks=False):
                dirnames[:] = [d for d in dirnames if not (Path(root) / d).is_symlink()]
                for filename in filenames:
                    file_path = Path(root) / filename
                    if file_path.is_symlink():
                        continue
                    if file_path.suffix.lower() in IMAGE_EXTENSIONS:
                        yield str(file_path)
        else:
            for fp in folder.iterdir():
                if fp.is_symlink() or not fp.is_file():
                    continue
                if fp.suffix.lower() in IMAGE_EXTENSIONS:
                    yield str(fp)

    # Two-pass: count then process.  Count is fast (stat only, no open).
    image_files = list(_iter_images())
    result["total"] = len(image_files)

    # Process each image
    for i, image_path in enumerate(image_files):
        filename = os.path.basename(image_path)
        try:
            # Parse metadata
            metadata = parse_image(image_path)
            if metadata["width"] <= 0 or metadata["height"] <= 0:
                logger.warning("Skipping unreadable image during scan: %s", image_path)
                result["errors"] += 1
                continue
            
            # Get file timestamps
            stat = os.stat(image_path)
            created_at = datetime.fromtimestamp(stat.st_mtime)
            
            # Serialize metadata safely
            try:
                metadata_json = json.dumps(metadata["metadata"])
            except (TypeError, ValueError) as e:
                logger.warning("Could not serialize metadata for %s: %s", image_path, e)
                metadata_json = "{}"
            
            # Add to database
            add_image(
                path=image_path,
                filename=os.path.basename(image_path),
                generator=metadata["generator"],
                prompt=metadata["prompt"],
                negative_prompt=metadata["negative_prompt"],
                metadata_json=metadata_json,
                width=metadata["width"],
                height=metadata["height"],
                file_size=metadata["file_size"],
                checkpoint=metadata["checkpoint"],
                loras=metadata["loras"],
                created_at=created_at
            )
            
            result["new"] += 1
            
            # Track by generator
            gen = metadata["generator"]
            result["by_generator"][gen] = result["by_generator"].get(gen, 0) + 1
            
        except PermissionError as e:
            logger.warning("Permission denied processing %s: %s", image_path, e)
            result["errors"] += 1
        except OSError as e:
            logger.warning("OS error processing %s: %s", image_path, e)
            result["errors"] += 1
        except Exception as e:
            logger.error("Unexpected error processing %s: %s", image_path, e, exc_info=True)
            result["errors"] += 1
        finally:
            if progress_callback:
                progress_callback(i + 1, result["total"], filename)
    
    return result


def move_image(image_id: int, destination_folder: str, image_path: str) -> str:
    """
    Move an image to a new folder.

    Args:
        image_id: Database ID of the image
        destination_folder: Target folder path
        image_path: Current path of the image

    Returns:
        New path of the image

    Raises:
        FileOperationError: If the move operation fails
    """
    try:
        destination_folder = os.path.abspath(destination_folder)
        image_path = os.path.abspath(image_path)
        os.makedirs(destination_folder, exist_ok=True)

        filename = os.path.basename(image_path)
        new_path = os.path.abspath(os.path.join(destination_folder, filename))

        # Handle filename conflicts
        if os.path.exists(new_path) and new_path != image_path:
            base, ext = os.path.splitext(filename)
            counter = 1
            while os.path.exists(new_path):
                new_filename = f"{base}_{counter}{ext}"
                new_path = os.path.abspath(os.path.join(destination_folder, new_filename))
                counter += 1

        # Move file
        shutil.move(image_path, new_path)

        # Update database
        update_image_path(image_id, new_path)

        return new_path
    except PermissionError as e:
        raise FileOperationError(
            f"Permission denied: {e}",
            path=image_path,
            operation="move"
        ) from e
    except OSError as e:
        raise FileOperationError(
            f"Failed to move file: {e}",
            path=image_path,
            operation="move"
        ) from e
    except Exception as e:
        raise FileOperationError(
            f"Unexpected error during move: {e}",
            path=image_path,
            operation="move"
        ) from e


def copy_image(image_path: str, destination_folder: str) -> str:
    """
    Copy an image to a new folder.

    Args:
        image_path: Path of the image to copy
        destination_folder: Target folder path

    Returns:
        Path of the copied image

    Raises:
        FileOperationError: If the copy operation fails
    """
    try:
        destination_folder = os.path.abspath(destination_folder)
        image_path = os.path.abspath(image_path)
        os.makedirs(destination_folder, exist_ok=True)

        filename = os.path.basename(image_path)
        new_path = os.path.abspath(os.path.join(destination_folder, filename))

        # Handle filename conflicts
        if os.path.exists(new_path):
            base, ext = os.path.splitext(filename)
            counter = 1
            while os.path.exists(new_path):
                new_filename = f"{base}_{counter}{ext}"
                new_path = os.path.abspath(os.path.join(destination_folder, new_filename))
                counter += 1

        shutil.copy2(image_path, new_path)
        return new_path
    except PermissionError as e:
        raise FileOperationError(
            f"Permission denied: {e}",
            path=image_path,
            operation="copy"
        ) from e
    except OSError as e:
        raise FileOperationError(
            f"Failed to copy file: {e}",
            path=image_path,
            operation="copy"
        ) from e
    except Exception as e:
        raise FileOperationError(
            f"Unexpected error during copy: {e}",
            path=image_path,
            operation="copy"
        ) from e



def reparse_image_metadata(image_id: int, image_path: str) -> Dict[str, Any]:
    """Re-parse a single image and update its stored metadata fields."""
    metadata = parse_image(image_path)

    try:
        metadata_json = json.dumps(metadata["metadata"])
    except (TypeError, ValueError):
        metadata_json = "{}"

    update_image_metadata(
        image_id=image_id,
        generator=metadata["generator"],
        prompt=metadata["prompt"],
        negative_prompt=metadata["negative_prompt"],
        metadata_json=metadata_json,
        width=metadata["width"],
        height=metadata["height"],
        file_size=metadata["file_size"],
        checkpoint=metadata["checkpoint"],
        loras=metadata["loras"],
    )

    return metadata


def batch_move(
    image_ids: List[int],
    image_paths: List[str],
    destination_folder: str,
    progress_callback: Optional[Callable] = None
) -> Dict[str, Any]:
    """
    Move multiple images to a folder.

    Returns:
        {
            "total": int,
            "moved": int,
            "errors": int,
            "new_paths": [str]
        }
    """
    result: Dict[str, Any] = {
        "total": len(image_ids),
        "moved": 0,
        "errors": 0,
        "new_paths": []
    }

    for i, (img_id, img_path) in enumerate(zip(image_ids, image_paths)):
        try:
            if progress_callback:
                progress_callback(i + 1, result["total"], os.path.basename(img_path))

            new_path = move_image(img_id, destination_folder, img_path)
            result["new_paths"].append(new_path)
            result["moved"] += 1
        except FileOperationError as e:
            logger.warning("Failed to move %s: %s", img_path, e.message)
            result["errors"] += 1
        except Exception as e:
            logger.error("Unexpected error moving %s: %s", img_path, e, exc_info=True)
            result["errors"] += 1

    return result


def get_folder_stats(folder_path: str) -> Dict[str, Any]:
    """Get statistics about a folder's images."""
    folder = Path(folder_path)
    
    stats: Dict[str, Any] = {
        "total_files": 0,
        "total_size": 0,
        "by_extension": {}
    }
    
    for file_path in folder.rglob("*"):
        if file_path.is_file():
            ext = file_path.suffix.lower()
            if ext in IMAGE_EXTENSIONS:
                stats["total_files"] += 1
                stats["total_size"] += file_path.stat().st_size
                stats["by_extension"][ext] = stats["by_extension"].get(ext, 0) + 1
    
    return stats
