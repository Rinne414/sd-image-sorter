"""Non-destructive edit-operation engine and save_operations.

Methods moved verbatim from services/censor_service.py (decomposition 2026-07,
claude-censorsvc-pins-REPORT.md section 6) except the manifest lines:
_apply_mask_effect_operation resolves MAX_INLINE_OPERATION_MASK_PIXELS through
_svc() at call time (facade-patched constant family), and save_operations
passes the facade _BACKEND_FILE as backend_file= (this module sits one level
too deep for backend-root derivation). The resource-budget 413 gates
(_validate_edit_operation_budget + _decode_operation_mask_header) stay
byte-verbatim ON THE FACADE CLASS, where their bare MAX_* reads keep matching
the string-form monkeypatch in test_resource_safety.py. SAFETY INVARIANT kept
byte-verbatim here: _apply_mask_crop_style routes unrecognized styles to the
mosaic default, so a mistyped or future style still censors the masked region
instead of exposing raw pixels (never-fallback-to-uncensored).
"""

from __future__ import annotations

import logging
import math
import os
from io import BytesIO
from pathlib import Path
from typing import TYPE_CHECKING, Any, Dict, List, Optional

from fastapi import HTTPException
from PIL import Image, ImageChops, ImageColor, ImageDraw, ImageEnhance, ImageFilter

import database as db
from services.censor.output_io import _combine_save_warnings
from services.indexed_file_mutation_service import save_and_reconcile_checked

if TYPE_CHECKING:  # annotation-only; never imported at runtime (no facade cycle)
    from services.censor_service import CensorSaveOperationsRequest

logger = logging.getLogger("services.censor_service")


def _svc():
    """Resolve facade-owned seams/constants through services.censor_service at call time.

    Tests patch module attributes on the facade (claude-censorsvc-pins-REPORT.md
    section 3); a from-import here would freeze an independent binding those
    patches silently miss. The lazy import avoids a facade<->mixin load cycle.
    """
    import services.censor_service as censor_service

    return censor_service


class _EditOpsMixin:
    """Edit-operations slice of CensorService (assembled in services/censor_service.py)."""

    def save_operations(self, request: CensorSaveOperationsRequest) -> Dict[str, Any]:
        """Save original image with non-destructive censor operations applied server-side."""
        from utils.path_validation import validate_folder_path, sanitize_filename

        is_valid, error = validate_folder_path(request.output_folder, allow_create=True)
        if not is_valid:
            raise HTTPException(status_code=400, detail=error or "Invalid output folder")

        image_row = db.get_image_by_id(request.original_image_id)
        if not image_row:
            raise HTTPException(status_code=404, detail="Image not found")

        output_folder = self._ensure_safe_output_directory(request.output_folder)
        source_path = self._resolve_source_image_path(
            image_row["path"],
            image_id=request.original_image_id,
            action_label="Saving edited image",
        )

        try:
            os.makedirs(output_folder, exist_ok=True)

            with Image.open(source_path) as src:
                original_image = src.convert("RGBA")
            width, height = original_image.size
            if width <= 0 or height <= 0:
                raise HTTPException(status_code=400, detail="Invalid source image")
            self._validate_edit_operation_budget(request.operations, image_size=(width, height))

            working_image = original_image.copy()
            self._apply_edit_operations(working_image, original_image, request.operations)

            safe_filename = sanitize_filename(request.filename)
            base_name = os.path.splitext(safe_filename)[0]
            output_format = self._normalize_output_format(request.output_format)
            ext = f".{output_format}"
            output_filename = f"{base_name}{ext}"
            output_path = self._ensure_output_path(output_folder, output_filename)

            if request.metadata_option == "strip":
                image_to_save = self._strip_all_metadata(working_image)
                save_kwargs = {}
            else:
                image_to_save = working_image
                save_kwargs = self._prepare_metadata_for_save(
                    working_image,
                    request.original_image_id,
                    request.metadata_option,
                    output_format,
                )

            def _write_operations_save(final_output_path: str, _overwrite_requested: bool) -> List[str]:
                return self._save_image_with_format(image_to_save, final_output_path, output_format, save_kwargs)

            write_result = save_and_reconcile_checked(
                output_path,
                _write_operations_save,
                allow_overwrite=request.allow_overwrite,
                backend_file=_svc()._BACKEND_FILE,
                validation_error_factory=self._output_validation_error,
                conflict_error_factory=self._output_conflict_error,
            )

            return self._save_response(
                output_path,
                output_filename,
                warnings=_combine_save_warnings(write_result.writer_result, write_result.warnings),
                target_existed=write_result.target_existed,
            )
        except HTTPException:
            raise
        except Exception:
            logger.exception("Save operations failed")
            raise HTTPException(status_code=500, detail="Save operations failed")

    @staticmethod
    def _clamp_float(value: Any, minimum: float, maximum: float) -> float:
        try:
            return max(minimum, min(maximum, float(value)))
        except (TypeError, ValueError):
            return minimum

    @staticmethod
    def _normalize_operation_points(points: Any) -> List[tuple[float, float]]:
        normalized: List[tuple[float, float]] = []
        for point in points or []:
            if not isinstance(point, dict):
                continue
            try:
                normalized.append((float(point.get("x")), float(point.get("y"))))
            except (TypeError, ValueError):
                continue
        return normalized

    @staticmethod
    def _count_polygon_points(regions: Any) -> int:
        if not isinstance(regions, list):
            return 0
        total = 0
        for region in regions:
            if not isinstance(region, dict):
                continue
            polygon = region.get("polygon")
            if isinstance(polygon, list):
                total += len(polygon)
        return total

    @staticmethod
    def _draw_stroke_mask(mask: Image.Image, points: List[tuple[float, float]], brush_size: float) -> None:
        if not points:
            return

        width = max(1, int(round(brush_size)))
        draw = ImageDraw.Draw(mask)
        if len(points) == 1:
            x, y = points[0]
            radius = brush_size / 2.0
            draw.ellipse([x - radius, y - radius, x + radius, y + radius], fill=255)
            return

        draw.line(points, fill=255, width=width, joint="curve")
        radius = brush_size / 2.0
        for x, y in (points[0], points[-1]):
            draw.ellipse([x - radius, y - radius, x + radius, y + radius], fill=255)

    @staticmethod
    def _pixelate_image_crop(image: Image.Image, bbox: tuple[int, int, int, int], block_size: int) -> Image.Image:
        crop = image.crop(bbox)
        downscale = max(1, int(block_size))
        small_w = max(1, crop.width // downscale)
        small_h = max(1, crop.height // downscale)
        pixelated = crop.resize((small_w, small_h), Image.Resampling.BILINEAR)
        return pixelated.resize(crop.size, Image.Resampling.NEAREST)

    @staticmethod
    def _build_pen_overlay(size: tuple[int, int], color: str, opacity: float, mask: Image.Image) -> Image.Image:
        rgba = ImageColor.getrgb(color or "#ff0000")
        overlay = Image.new("RGBA", size, (*rgba, 0))
        alpha_mask = mask.point(lambda value: int(value * max(0.0, min(1.0, opacity))))
        overlay.putalpha(alpha_mask)
        return overlay

    @staticmethod
    def _composite_crop_with_mask(
        image: Image.Image,
        effect_crop: Image.Image,
        mask_crop: Image.Image,
        bbox: tuple[int, int, int, int],
    ) -> None:
        base_crop = image.crop(bbox).convert("RGBA")
        composited = Image.composite(effect_crop.convert("RGBA"), base_crop, mask_crop)
        image.paste(composited, bbox)

    @classmethod
    def _apply_mask_crop_style(
        cls,
        image: Image.Image,
        original_image: Image.Image,
        mask_crop: Image.Image,
        bbox: tuple[int, int, int, int],
        *,
        style: str,
        block_size: int,
        blur_radius: int,
        pen_color: str = "#ff0000",
        pen_opacity: float = 1.0,
    ) -> None:
        x1, y1, x2, y2 = [int(value) for value in bbox]
        if x2 <= x1 or y2 <= y1 or mask_crop.getbbox() is None:
            return

        bbox = (x1, y1, x2, y2)
        if mask_crop.size != (x2 - x1, y2 - y1):
            mask_crop = mask_crop.resize((x2 - x1, y2 - y1), Image.Resampling.LANCZOS)
        normalized_style = str(style or "").strip().lower()

        if normalized_style == "pen":
            overlay = cls._build_pen_overlay(mask_crop.size, pen_color, pen_opacity, mask_crop)
            base_crop = image.crop(bbox).convert("RGBA")
            composited = Image.alpha_composite(base_crop, overlay)
            image.paste(composited, bbox)
            return

        if normalized_style == "eraser":
            cls._composite_crop_with_mask(image, original_image.crop(bbox).convert("RGBA"), mask_crop, bbox)
            return

        if normalized_style in {"black_bar", "solid", "black"}:
            effect_crop = Image.new("RGBA", (x2 - x1, y2 - y1), (0, 0, 0, 255))
            cls._composite_crop_with_mask(image, effect_crop, mask_crop, bbox)
            return

        if normalized_style == "white_bar":
            effect_crop = Image.new("RGBA", (x2 - x1, y2 - y1), (255, 255, 255, 255))
            cls._composite_crop_with_mask(image, effect_crop, mask_crop, bbox)
            return

        if normalized_style == "blur":
            effect_crop = image.crop(bbox).filter(ImageFilter.GaussianBlur(radius=max(1, int(round(blur_radius)))))
            cls._composite_crop_with_mask(image, effect_crop.convert("RGBA"), mask_crop, bbox)
            return

        effect_crop = cls._pixelate_image_crop(image, bbox, max(1, int(round(block_size))))
        cls._composite_crop_with_mask(image, effect_crop.convert("RGBA"), mask_crop, bbox)

    @classmethod
    def _apply_mask_style(
        cls,
        image: Image.Image,
        original_image: Image.Image,
        mask: Image.Image,
        *,
        style: str,
        block_size: int,
        blur_radius: int,
        pen_color: str = "#ff0000",
        pen_opacity: float = 1.0,
    ) -> None:
        bbox = mask.getbbox()
        if not bbox:
            return

        x1, y1, x2, y2 = [int(value) for value in bbox]
        bbox = (x1, y1, x2, y2)
        mask_crop = mask.crop(bbox)
        cls._apply_mask_crop_style(
            image,
            original_image,
            mask_crop,
            bbox,
            style=style,
            block_size=block_size,
            blur_radius=blur_radius,
            pen_color=pen_color,
            pen_opacity=pen_opacity,
        )

    @classmethod
    def _apply_clone_operation(
        cls,
        image: Image.Image,
        original_image: Image.Image,
        *,
        points: List[tuple[float, float]],
        brush_size: float,
        clone_offset: Dict[str, Any],
    ) -> None:
        if not points:
            return

        diameter = max(1, int(round(brush_size)))
        mask = Image.new("L", (diameter, diameter), 0)
        ImageDraw.Draw(mask).ellipse([0, 0, diameter - 1, diameter - 1], fill=255)
        offset_x = float(clone_offset.get("x", 0))
        offset_y = float(clone_offset.get("y", 0))

        for x, y in points:
            src_x = int(round(x + offset_x))
            src_y = int(round(y + offset_y))
            dst_x = int(round(x))
            dst_y = int(round(y))
            source_patch = original_image.crop((
                src_x - diameter // 2,
                src_y - diameter // 2,
                src_x - diameter // 2 + diameter,
                src_y - diameter // 2 + diameter,
            )).convert("RGBA")
            image.paste(
                source_patch,
                (dst_x - diameter // 2, dst_y - diameter // 2),
                mask,
            )

    @staticmethod
    def _get_stroke_mask_bounds(
        points: List[tuple[float, float]],
        brush_size: float,
        image_size: tuple[int, int],
    ) -> Optional[tuple[int, int, int, int]]:
        if not points:
            return None

        image_width, image_height = image_size
        if image_width <= 0 or image_height <= 0:
            return None

        radius = max(0.5, brush_size / 2.0)
        # Keep Pillow's inclusive line/ellipse edge pixels inside the crop; the
        # rendered mask is tightened with getbbox() before applying the effect.
        padding = 2.0
        left = max(0, math.floor(min(x for x, _ in points) - radius - padding))
        top = max(0, math.floor(min(y for _, y in points) - radius - padding))
        right = min(
            image_width,
            math.ceil(max(x for x, _ in points) + radius + padding) + 1,
        )
        bottom = min(
            image_height,
            math.ceil(max(y for _, y in points) + radius + padding) + 1,
        )
        if right <= left or bottom <= top:
            return None
        return (left, top, right, bottom)

    @classmethod
    def _apply_stroke_operation(
        cls,
        image: Image.Image,
        original_image: Image.Image,
        operation: Dict[str, Any],
    ) -> None:
        tool = str(operation.get("tool") or "brush").strip().lower()
        points = cls._normalize_operation_points(operation.get("points"))
        if not points:
            return

        brush_size = cls._clamp_float(operation.get("brush_size", 1), 1.0, 4096.0)
        if tool == "clone":
            clone_offset = operation.get("clone_offset") or {}
            cls._apply_clone_operation(
                image,
                original_image,
                points=points,
                brush_size=brush_size,
                clone_offset=clone_offset,
            )
            return

        mask_bounds = cls._get_stroke_mask_bounds(points, brush_size, image.size)
        if mask_bounds is None:
            return
        x1, y1, x2, y2 = mask_bounds
        mask = Image.new("L", (x2 - x1, y2 - y1), 0)
        local_points = [(x - x1, y - y1) for x, y in points]
        cls._draw_stroke_mask(mask, local_points, brush_size)
        local_bbox = mask.getbbox()
        if local_bbox is None:
            return
        effect_bbox = (
            x1 + local_bbox[0],
            y1 + local_bbox[1],
            x1 + local_bbox[2],
            y1 + local_bbox[3],
        )
        cls._apply_mask_crop_style(
            image,
            original_image,
            mask.crop(local_bbox),
            effect_bbox,
            style=operation.get("style") if tool == "brush" else tool,
            block_size=int(operation.get("block_size", 16) or 16),
            blur_radius=int(operation.get("blur_radius", 20) or 20),
            pen_color=str(operation.get("pen_color") or "#ff0000"),
            pen_opacity=cls._clamp_float(operation.get("pen_opacity", 1.0), 0.0, 1.0),
        )

    @classmethod
    def _apply_geometry_effect_operation(
        cls,
        image: Image.Image,
        original_image: Image.Image,
        operation: Dict[str, Any],
    ) -> None:
        regions = operation.get("regions") or []
        if not isinstance(regions, list) or not regions:
            return

        polygon_mask = Image.new("L", image.size, 0)
        polygon_draw = ImageDraw.Draw(polygon_mask)
        box_regions: List[List[int]] = []

        for region in regions:
            if not isinstance(region, dict):
                continue
            polygon = region.get("polygon")
            if isinstance(polygon, list):
                points = [
                    (float(point[0]), float(point[1]))
                    for point in polygon
                    if isinstance(point, (list, tuple)) and len(point) >= 2
                ]
                if len(points) >= 3:
                    polygon_draw.polygon(points, fill=255)
                    continue

            box = region.get("box")
            if isinstance(box, list) and len(box) == 4:
                box_regions.append([int(float(value)) for value in box])

        cls._apply_mask_style(
            image,
            original_image,
            polygon_mask,
            style=str(operation.get("style") or "mosaic"),
            block_size=int(operation.get("block_size", 16) or 16),
            blur_radius=int(operation.get("blur_radius", 20) or 20),
        )

        if box_regions:
            mask = Image.new("L", image.size, 0)
            draw = ImageDraw.Draw(mask)
            for x1, y1, x2, y2 in box_regions:
                draw.rectangle([x1, y1, x2, y2], fill=255)
            cls._apply_mask_style(
                image,
                original_image,
                mask,
                style=str(operation.get("style") or "mosaic"),
                block_size=int(operation.get("block_size", 16) or 16),
                blur_radius=int(operation.get("blur_radius", 20) or 20),
            )

    @classmethod
    def _apply_mask_effect_operation(
        cls,
        image: Image.Image,
        original_image: Image.Image,
        operation: Dict[str, Any],
    ) -> None:
        mask_data = str(operation.get("mask_data") or "").strip()
        mask_ref = str(operation.get("mask_ref") or "").strip()
        alpha: Optional[Image.Image] = None

        if mask_ref:
            entry = cls._get_cached_mask_entry(mask_ref)
            bounds = cls._normalize_mask_bounds(
                operation.get("mask_bounds") or entry.get("bounds"),
                image_size=image.size,
            )
            if bounds is None:
                raise HTTPException(status_code=400, detail="Invalid cached mask bounds")

            crop_path = Path(entry["path"])
            with Image.open(crop_path) as cached_mask_src:
                crop_mask = cached_mask_src.convert("L")
            expected_size = (bounds[2] - bounds[0], bounds[3] - bounds[1])
            if crop_mask.size != expected_size:
                crop_mask = crop_mask.resize(expected_size, Image.Resampling.LANCZOS)
            cls._apply_mask_crop_style(
                image,
                original_image,
                crop_mask,
                bounds,
                style=str(operation.get("style") or "mosaic"),
                block_size=int(operation.get("block_size", 16) or 16),
                blur_radius=int(operation.get("blur_radius", 20) or 20),
            )
            return
        elif mask_data:
            mask_bytes, _ = cls._decode_operation_mask_header(mask_data)
            mask_image = Image.open(BytesIO(mask_bytes)).convert("RGBA")
            mask_pixels = mask_image.width * mask_image.height
            if mask_pixels > _svc().MAX_INLINE_OPERATION_MASK_PIXELS:
                raise HTTPException(
                    status_code=413,
                    detail="Inline edit mask is too large. Use cached mask refs for large masks.",
                )
            alpha = mask_image.getchannel("A") if "A" in mask_image.getbands() else mask_image.convert("L")
            if mask_image.size != image.size:
                alpha = alpha.resize(image.size, Image.Resampling.LANCZOS)

        if alpha is None:
            return

        cls._apply_mask_style(
            image,
            original_image,
            alpha,
            style=str(operation.get("style") or "mosaic"),
            block_size=int(operation.get("block_size", 16) or 16),
            blur_radius=int(operation.get("blur_radius", 20) or 20),
        )

    @staticmethod
    def _apply_hue_rotation(image: Image.Image, degrees: float) -> Image.Image:
        if not degrees:
            return image

        alpha = image.getchannel("A") if "A" in image.getbands() else None
        hsv = image.convert("RGB").convert("HSV")
        h, s, v = hsv.split()
        shift = int(round((degrees / 360.0) * 255)) % 256
        h = h.point(lambda value: (value + shift) % 256)
        rotated = Image.merge("HSV", (h, s, v)).convert("RGBA")
        if alpha is not None:
            rotated.putalpha(alpha)
        return rotated

    @staticmethod
    def _apply_temperature_shift(image: Image.Image, temperature: float) -> Image.Image:
        if not temperature:
            return image

        normalized = max(-100.0, min(100.0, float(temperature))) / 100.0
        overlay_color = (255, 176, 64, int(90 * abs(normalized))) if normalized > 0 else (64, 128, 255, int(90 * abs(normalized)))
        overlay = Image.new("RGBA", image.size, overlay_color)
        return Image.alpha_composite(image.convert("RGBA"), overlay)

    @classmethod
    def _apply_vignette_filter(cls, image: Image.Image, amount: float) -> Image.Image:
        if amount <= 0:
            return image

        width, height = image.size
        inner_mask = Image.new("L", (width, height), 0)
        draw = ImageDraw.Draw(inner_mask)
        inset_ratio = max(0.0, min(1.0, 1 - amount * 0.5))
        inset_x = int((width * (1 - inset_ratio)) / 2)
        inset_y = int((height * (1 - inset_ratio)) / 2)
        draw.ellipse([inset_x, inset_y, width - inset_x, height - inset_y], fill=255)
        blur_radius = max(1, int(max(width, height) * 0.08))
        soft_inner = inner_mask.filter(ImageFilter.GaussianBlur(radius=blur_radius))
        vignette_alpha = ImageChops.invert(soft_inner).point(
            lambda value: int(value * min(1.0, amount * 0.7))
        )
        overlay = Image.new("RGBA", (width, height), (0, 0, 0, 0))
        overlay.putalpha(vignette_alpha)
        return Image.alpha_composite(image.convert("RGBA"), overlay)

    @classmethod
    def _apply_filter_operation(
        cls,
        image: Image.Image,
        operation: Dict[str, Any],
    ) -> Image.Image:
        values = operation.get("values") or {}
        if not isinstance(values, dict):
            return image

        result = image.convert("RGBA")
        brightness = float(values.get("brightness", 0) or 0)
        contrast = float(values.get("contrast", 0) or 0)
        saturation = float(values.get("saturation", 0) or 0)
        hue = float(values.get("hue", 0) or 0)
        blur = float(values.get("blur", 0) or 0)
        sharpen = float(values.get("sharpen", 0) or 0)
        temperature = float(values.get("temperature", 0) or 0)
        vignette = float(values.get("vignette", 0) or 0)

        if brightness:
            result = ImageEnhance.Brightness(result).enhance(1 + brightness / 100.0)
        if contrast:
            result = ImageEnhance.Contrast(result).enhance(1 + contrast / 100.0)
        if saturation:
            result = ImageEnhance.Color(result).enhance(1 + saturation / 100.0)
        if hue:
            result = cls._apply_hue_rotation(result, hue)
        if blur > 0:
            result = result.filter(ImageFilter.GaussianBlur(radius=blur))
        if temperature:
            result = cls._apply_temperature_shift(result, temperature)
        if sharpen > 0:
            result = result.filter(ImageFilter.UnsharpMask(radius=1, percent=max(1, int(sharpen * 3)), threshold=0))
        if vignette > 0:
            result = cls._apply_vignette_filter(result, vignette / 100.0)

        return result

    @classmethod
    def _apply_edit_operations(
        cls,
        image: Image.Image,
        original_image: Image.Image,
        operations: List[Dict[str, Any]],
    ) -> None:
        for operation in operations or []:
            if not isinstance(operation, dict):
                continue

            kind = str(operation.get("kind") or "").strip().lower()
            if kind == "stroke":
                cls._apply_stroke_operation(image, original_image, operation)
            elif kind == "geometry_effect":
                cls._apply_geometry_effect_operation(image, original_image, operation)
            elif kind == "mask_effect":
                cls._apply_mask_effect_operation(image, original_image, operation)
            elif kind == "filter":
                next_image = cls._apply_filter_operation(image, operation)
                image.paste(next_image)
