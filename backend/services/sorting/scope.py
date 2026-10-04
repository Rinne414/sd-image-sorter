"""Which pictures a Manual Sort session queues, and which were already sorted.

``_select_sort_scope_ids`` is the one filter -> id path behind both
``start_sort_session`` and the setup page's ``count_sort_scope``, so the
number the user sees before starting is the number the session queues.

Auto-Separate and Manual Sort record every picture they copy or move
(``db_sorted_marks``, migration 051). With ``exclude_sorted`` a session leaves
those pictures out ("auto-sort first, hand-sort the rest").
"""

import logging
from typing import Any, Dict, List, Optional, Tuple

from fastapi import HTTPException

import database as db
import db_sorted_marks
from constants import VALID_ASPECT_RATIOS
from services.sorting_models import VALID_PROMPT_MATCH_MODES

# NOTE(decomposition): keep the historical logger channel shared by the
# services/sorting package (tests filter on "services.sorting_service").
logger = logging.getLogger("services.sorting_service")


class SortScopeMixin:
    """Scope + already-sorted slice of SortingService (see sorting_service.py)."""

    def _select_sort_scope_ids(
        self,
        generators: Optional[Any] = None,
        tags: Optional[Any] = None,
        tag_mode: str = "and",
        ratings: Optional[Any] = None,
        checkpoints: Optional[Any] = None,
        loras: Optional[Any] = None,
        prompts: Optional[Any] = None,
        prompt_match_mode: str = "exact",
        artist: Optional[str] = None,
        search: Optional[str] = None,
        min_width: Optional[int] = None,
        max_width: Optional[int] = None,
        min_height: Optional[int] = None,
        max_height: Optional[int] = None,
        aspect_ratio: Optional[str] = None,
        min_aesthetic: Optional[float] = None,
        max_aesthetic: Optional[float] = None,
        exclude_tags: Optional[Any] = None,
        exclude_generators: Optional[Any] = None,
        exclude_ratings: Optional[Any] = None,
        exclude_checkpoints: Optional[Any] = None,
        exclude_loras: Optional[Any] = None,
        min_user_rating: Optional[int] = None,
        brightness_min: Optional[float] = None,
        brightness_max: Optional[float] = None,
        color_temperature: Optional[str] = None,
        brightness_distribution: Optional[str] = None,
        exclude_prompts: Optional[Any] = None,
        exclude_colors: Optional[Any] = None,
        color_hues: Optional[Any] = None,
        exclude_color_hues: Optional[Any] = None,
        collection_id: Optional[int] = None,
        scope: Optional[str] = None,
        folder: Optional[str] = None,
        has_metadata: Optional[bool] = None,
        no_caption: Optional[bool] = None,
        aesthetic_unscored: Optional[bool] = None,
        min_saturation: Optional[float] = None,
        max_saturation: Optional[float] = None,
        seed: Optional[int] = None,
        date_from: Optional[str] = None,
        date_to: Optional[str] = None,
        anime_grades: Optional[Any] = None,
        min_waifu: Optional[float] = None,
        max_waifu: Optional[float] = None,
    ) -> List[int]:
        """Validate the Manual Sort filters and return the matching image ids."""
        if aspect_ratio is not None and aspect_ratio not in VALID_ASPECT_RATIOS:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid aspect_ratio. Must be one of: {', '.join(VALID_ASPECT_RATIOS)}",
            )
        if min_width is not None and max_width is not None and min_width > max_width:
            raise HTTPException(
                status_code=400, detail="min_width cannot be greater than max_width"
            )
        if (
            min_height is not None
            and max_height is not None
            and min_height > max_height
        ):
            raise HTTPException(
                status_code=400, detail="min_height cannot be greater than max_height"
            )
        if (
            min_aesthetic is not None
            and max_aesthetic is not None
            and min_aesthetic > max_aesthetic
        ):
            raise HTTPException(
                status_code=400,
                detail="min_aesthetic cannot be greater than max_aesthetic",
            )
        normalized_prompt_match_mode = str(prompt_match_mode or "exact").strip().lower()
        if normalized_prompt_match_mode not in VALID_PROMPT_MATCH_MODES:
            raise HTTPException(
                status_code=400, detail="prompt_match_mode must be exact or contains"
            )
        normalized_tag_mode = str(tag_mode or "and").strip().lower()
        if normalized_tag_mode not in {"and", "or"}:
            raise HTTPException(status_code=400, detail="tag_mode must be and or or")

        coerce = self._coerce_sort_filter_values
        # DB-level filter already excludes images marked unreadable.
        # Per-image verification runs lazily in get_current_sort_image so
        # starting a session doesn't stall on thousands of PIL decodes.
        return db.get_filtered_image_ids(
            generators=coerce(generators),
            tags=coerce(tags),
            tag_mode=normalized_tag_mode,
            ratings=coerce(ratings),
            checkpoints=coerce(checkpoints),
            loras=coerce(loras),
            search_query=search.strip() if search else None,
            prompt_terms=coerce(prompts),
            prompt_match_mode=normalized_prompt_match_mode,
            artist=artist.strip() if artist else None,
            min_width=min_width,
            max_width=max_width,
            min_height=min_height,
            max_height=max_height,
            aspect_ratio=aspect_ratio,
            min_aesthetic=min_aesthetic,
            max_aesthetic=max_aesthetic,
            exclude_tags=coerce(exclude_tags),
            exclude_generators=coerce(exclude_generators),
            exclude_ratings=coerce(exclude_ratings),
            exclude_checkpoints=coerce(exclude_checkpoints),
            exclude_loras=coerce(exclude_loras),
            exclude_prompts=coerce(exclude_prompts),
            exclude_colors=coerce(exclude_colors),
            color_hues=coerce(color_hues),
            exclude_color_hues=coerce(exclude_color_hues),
            min_user_rating=min_user_rating,
            brightness_min=brightness_min,
            brightness_max=brightness_max,
            color_temperature=color_temperature.strip() if color_temperature else None,
            brightness_distribution=brightness_distribution.strip()
            if brightness_distribution
            else None,
            collection_id=collection_id,
            scope=scope,
            folder=folder.strip() if folder else None,
            has_metadata=has_metadata,
            no_caption=no_caption,
            aesthetic_unscored=aesthetic_unscored,
            min_saturation=min_saturation,
            max_saturation=max_saturation,
            seed=seed,
            date_from=date_from,
            date_to=date_to,
            anime_grades=coerce(anime_grades),
            min_waifu=min_waifu,
            max_waifu=max_waifu,
        )

    def count_sort_scope(self, **filters: Any) -> Dict[str, int]:
        """Count what a session with these filters would queue.

        ``total`` matches the filters; ``sorted`` of them were already copied
        or moved by Auto-Separate or Manual Sort; ``remaining`` is what a
        session that leaves sorted pictures out queues.
        """
        image_ids = self._select_sort_scope_ids(**filters)
        sorted_count = len(db_sorted_marks.sorted_ids_among(image_ids))
        return {
            "total": len(image_ids),
            "sorted": sorted_count,
            "remaining": len(image_ids) - sorted_count,
        }

    @staticmethod
    def _drop_sorted_ids(image_ids: List[int]) -> Tuple[List[int], int]:
        """Leave out pictures a sort already put somewhere; keep the order."""
        already_sorted = db_sorted_marks.sorted_ids_among(image_ids)
        kept = [image_id for image_id in image_ids if image_id not in already_sorted]
        return kept, len(image_ids) - len(kept)

    @staticmethod
    def _mark_sorted_by_hand(image_id: int, operation: str) -> Optional[Dict[str, Any]]:
        """Record a Manual Sort copy/move and return the mark it replaced.

        The file operation already succeeded, so a failed record write is
        logged and the sort goes on; the picture then simply shows up in a
        later queue again. The returned mark goes into the history entry so an
        undo can give it back.
        """
        prior = None
        try:
            prior = db_sorted_marks.get_sorted_mark(image_id)
            db_sorted_marks.mark_image_sorted(
                image_id, db_sorted_marks.SOURCE_MANUAL_SORT, operation
            )
        except Exception as exc:
            logger.error(
                "Could not record the hand sort of image %s: %s", image_id, exc
            )
        return prior

    @staticmethod
    def _restore_prior_sorted_mark(entry: Dict[str, Any]) -> None:
        """Undo half of ``_mark_sorted_by_hand`` for one history entry.

        Entries saved before migration 051 never wrote a mark, so they have
        nothing to give back and are left alone.
        """
        if "prior_sorted_mark" not in entry:
            return
        try:
            db_sorted_marks.restore_sorted_mark(
                entry["image_id"], entry.get("prior_sorted_mark")
            )
        except Exception as exc:
            logger.error(
                "Could not take back the sort record of image %s: %s",
                entry.get("image_id"),
                exc,
            )

    @staticmethod
    def _mark_sorted_by_auto_separate(image_id: int, operation: str) -> None:
        """Record one Auto-Separate copy/move (logged, never fails the batch)."""
        try:
            db_sorted_marks.mark_image_sorted(
                image_id, db_sorted_marks.SOURCE_AUTO_SEPARATE, operation
            )
        except Exception as exc:
            logger.error(
                "Could not record the Auto-Separate %s of image %s: %s",
                operation,
                image_id,
                exc,
            )
