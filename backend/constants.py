"""Shared constants for SD Image Sorter backend."""

from typing import Iterable, List, Optional, Union

VALID_ASPECT_RATIOS = ("square", "landscape", "portrait")

# The deepghs anime aesthetic grades, best first (the order of anime_aesthetic.LABELS).
ANIME_AESTHETIC_GRADES = ("masterpiece", "best", "great", "good", "normal", "low", "worst")


def normalize_anime_grades(values: Optional[Union[str, Iterable[str]]]) -> List[str]:
    """Grade names from a list or a comma string: trimmed, lower-case, deduplicated.

    Raises ValueError naming any value that is not a grade, so a typo cannot
    silently match nothing (or everything) in a filter.
    """
    if values is None:
        return []
    items = values.split(",") if isinstance(values, str) else list(values)
    grades: List[str] = []
    for item in items:
        grade = str(item or "").strip().lower()
        if grade and grade not in grades:
            grades.append(grade)
    unknown = [grade for grade in grades if grade not in ANIME_AESTHETIC_GRADES]
    if unknown:
        raise ValueError(
            f"Unknown anime grade: {', '.join(unknown)}. Use {', '.join(ANIME_AESTHETIC_GRADES)}."
        )
    return grades
