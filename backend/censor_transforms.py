"""
SD Image Sorter - Censor Transforms
Pillow-based censoring transforms (mosaic / bar / blur / sticker), split out
of censor.py (2026-07).

Fully stateless: touches none of the censor.py rebind seams (ort / _cv2 /
_detector). The `Censor` class is re-exported by reference as
`censor.Censor`, which remains the import/patch surface production code and
tests use (services/censor/output_io.py, "censor.Censor.apply_censoring").
"""

import os
from PIL import Image, ImageFilter, ImageDraw
from typing import List, Tuple, Optional

from config import (
    CENSOR_DEFAULT_BLOCK_SIZE,
    CENSOR_DEFAULT_BLUR_RADIUS,
)


class Censor:
    """Image censoring utilities."""

    @staticmethod
    def apply_mosaic(
        image: Image.Image,
        regions: List[Tuple[int, int, int, int]],
        block_size: int = CENSOR_DEFAULT_BLOCK_SIZE
    ) -> Image.Image:
        """Apply mosaic/pixelation to regions."""
        result = image.copy()

        for x1, y1, x2, y2 in regions:
            # Ensure valid coordinates
            x1, y1 = max(0, x1), max(0, y1)
            x2, y2 = min(image.width, x2), min(image.height, y2)

            if x2 <= x1 or y2 <= y1:
                continue

            # Extract region
            region = result.crop((x1, y1, x2, y2))

            # Pixelate: resize down then up
            w, h = region.size
            small_w = max(1, w // block_size)
            small_h = max(1, h // block_size)

            small = region.resize((small_w, small_h), Image.Resampling.NEAREST)
            pixelated = small.resize((w, h), Image.Resampling.NEAREST)

            # Paste back
            result.paste(pixelated, (x1, y1))

        return result

    @staticmethod
    def apply_bar(
        image: Image.Image,
        regions: List[Tuple[int, int, int, int]],
        color: Tuple[int, int, int] = (0, 0, 0)
    ) -> Image.Image:
        """Apply solid color bar to regions."""
        result = image.copy()
        draw = ImageDraw.Draw(result)

        for x1, y1, x2, y2 in regions:
            draw.rectangle([x1, y1, x2, y2], fill=color)

        return result

    @staticmethod
    def apply_blur(
        image: Image.Image,
        regions: List[Tuple[int, int, int, int]],
        blur_radius: int = CENSOR_DEFAULT_BLUR_RADIUS
    ) -> Image.Image:
        """Apply gaussian blur to regions."""
        result = image.copy()

        for x1, y1, x2, y2 in regions:
            x1, y1 = max(0, x1), max(0, y1)
            x2, y2 = min(image.width, x2), min(image.height, y2)

            if x2 <= x1 or y2 <= y1:
                continue

            region = result.crop((x1, y1, x2, y2))
            blurred = region.filter(ImageFilter.GaussianBlur(radius=blur_radius))
            result.paste(blurred, (x1, y1))

        return result
    
    @staticmethod
    def apply_sticker(
        image: Image.Image,
        regions: List[Tuple[int, int, int, int]],
        sticker_path: Optional[str] = None,
        sticker_emoji: str = "⭐"
    ) -> Image.Image:
        """Apply sticker overlay to regions."""
        result = image.copy()
        
        if sticker_path and os.path.exists(sticker_path):
            sticker = Image.open(sticker_path).convert('RGBA')
        else:
            # Create simple emoji-style sticker
            sticker = None
        
        for x1, y1, x2, y2 in regions:
            w, h = x2 - x1, y2 - y1
            
            if sticker:
                # Resize sticker to fit region
                resized = sticker.resize((w, h), Image.Resampling.LANCZOS)
                result.paste(resized, (x1, y1), resized)
            else:
                # Draw simple star/circle overlay
                draw = ImageDraw.Draw(result)
                center_x = (x1 + x2) // 2
                center_y = (y1 + y2) // 2
                radius = min(w, h) // 2
                draw.ellipse(
                    [center_x - radius, center_y - radius, 
                     center_x + radius, center_y + radius],
                    fill=(255, 215, 0)  # Gold color
                )
        
        return result
    
    @staticmethod
    def apply_censoring(
        image: Image.Image,
        regions: List[Tuple[int, int, int, int]],
        style: str = "mosaic",
        **kwargs
    ) -> Image.Image:
        """Apply censoring with specified style."""
        normalized_style = str(style or "mosaic").lower()
        if normalized_style == "mosaic":
            block_size = kwargs.get("block_size", 16)
            return Censor.apply_mosaic(image, regions, block_size)
        elif normalized_style in {"black_bar", "solid", "black"}:
            return Censor.apply_bar(image, regions, (0, 0, 0))
        elif normalized_style == "white_bar":
            return Censor.apply_bar(image, regions, (255, 255, 255))
        elif normalized_style == "blur":
            blur_radius = kwargs.get("blur_radius", 20)
            return Censor.apply_blur(image, regions, blur_radius)
        elif normalized_style == "sticker":
            sticker_path = kwargs.get("sticker_path")
            return Censor.apply_sticker(image, regions, sticker_path)
        else:
            raise ValueError(f"Unknown censor style: {style}")
