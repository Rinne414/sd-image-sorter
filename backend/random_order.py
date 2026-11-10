"""The gallery's random order, with a seed the user can re-roll.

"Random" used to be one fixed shuffle of the picture ids: the same order on
every visit, so it stopped being random the second time. A seed picks one of
many shuffles; the same seed gives the same order again, so paging through a
shuffled gallery stays stable, and a new seed reshuffles.

The seed travels in a context variable set by the listing request, because the
ORDER BY builder is called deep inside query code that takes no such argument.
Seed 0 (no seed sent) keeps the historical order.
"""

from __future__ import annotations

from contextvars import ContextVar
from typing import Optional

# The largest 31-bit prime: products of two values below it fit SQLite's 64-bit integers.
_PRIME = 2147483647
MAX_SEED = _PRIME - 1
_LEGACY_SQL = "((i.id * 1103515245 + 12345) & 2147483647)"

_seed: ContextVar[int] = ContextVar("gallery_random_seed", default=0)


def use_seed(seed: Optional[int]) -> None:
    """Set the seed for the rest of this request (None or 0: the historical order)."""
    value = int(seed or 0)
    _seed.set(value if 0 <= value <= MAX_SEED else value % _PRIME)


def current_seed() -> int:
    return _seed.get()


def _xor_shift(expression: str, bits: int) -> str:
    """``x XOR (x >> bits)`` in SQLite, which has no XOR operator."""
    shifted = f"(({expression}) >> {bits})"
    return f"((({expression}) | {shifted}) - (({expression}) & {shifted}))"


def order_sql(seed: Optional[int] = None) -> str:
    """An integer SQL expression over ``i.id`` whose ascending order is the shuffle."""
    value = current_seed() if seed is None else int(seed)
    if value <= 0:
        return _LEGACY_SQL
    # Multiply, fold the high bits down, multiply again, fold again. One
    # multiplication alone is a straight line over the ids: the pictures came
    # out at a fixed stride (133, 100, 67, 34, ...), so neighbours in the
    # library kept a visible pattern. The folds break the line. The seed picks
    # the first multiplier and is added before the first fold, so two seeds
    # give unrelated orders.
    multiplier = 2 + (value * 2654435761) % (_PRIME - 3)
    first = f"((((i.id % {_PRIME}) * {multiplier}) + {value}) % {_PRIME})"
    second = f"(({_xor_shift(first, 15)} * 48271) % {_PRIME})"
    third = f"(({_xor_shift(second, 13)} * 69621) % {_PRIME})"
    return _xor_shift(third, 16)
