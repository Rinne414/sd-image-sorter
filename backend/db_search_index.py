"""Query-side helpers for the trigram search index (migration 067).

The text searches (gallery search box, "prompt contains", exact prompt terms)
and the LoRA filter used to test every picture. With the index they first ask it
which pictures can possibly match and test only those, so the result is exactly
what the original conditions give: the index only ever narrows the candidates,
the original LIKE conditions still decide.

That only holds while the index never misses a picture the condition would
match, so the lookups are built to over-match, never under-match:

* a needle of 3 or more characters goes to the trigram index (case folding there
  is wider than LIKE's, which can only add candidates);
* a needle of 1 or 2 characters cannot be looked up by trigram, so it is tested
  with the same LIKE pattern against the one text column (a single pass over
  the index text, not the whole table of columns) and, for the token index,
  against the distinct tokens;
* a needle with a backslash (the LIKE escape character) can change which text
  its pattern matches, so there is no prefilter and the query scans as before.

Depends only on ``db_helpers`` for the LIKE escaping (no cycle with the
``database`` facade).
"""

import math
import sqlite3
from typing import Iterable, List, Optional, Sequence, Tuple

from db_helpers import escape_like_pattern

TEXT_FTS = "image_text_fts"
VOCAB = "prompt_token_vocab"
VOCAB_FTS = "prompt_token_vocab_fts"

MIN_TRIGRAM_CHARS = 3

# When is a word too common for the lookup to pay off? The lookup builds the list
# of every matching picture before the query starts, which costs more than testing
# the pictures one by one once most of them match:
#
# * a page read in library order stops after 100 matches, so walking the library
#   tests about 100 * N / M pictures while the list costs about M. The two meet at
#   M = sqrt(100 * N) (about 3,200 matches in 100,000 pictures, never under 1000);
# * a count or an id list reads every picture, so the list is worth building
#   until about half of the library matches.
#
# A word over its limit keeps the plain condition, which is the old behaviour.
MIN_PAGE_LOOKUP = 1000
PAGE_PICTURES_NEEDED = 100
COUNT_LOOKUP_FRACTION = 2

_LORA_LOOKUP = "SELECT il.image_id FROM image_loras il WHERE LOWER(il.lora_name) = ?"
# The per-picture form: right for a page of a LoRA most of the library carries.
_LORA_PROBE = (
    "EXISTS (SELECT 1 FROM image_loras il WHERE il.image_id = i.id AND LOWER(il.lora_name) = ?)"
)
_LIKE = "LIKE ? ESCAPE '\\'"


def fts_phrase(needle: str) -> str:
    """Quote ``needle`` as one FTS5 phrase (a substring for the trigram index)."""
    return '"' + needle.replace('"', '""') + '"'


def _like_pattern(needle: str) -> str:
    return f"%{escape_like_pattern(needle)}%"


def usable(needle: str) -> bool:
    """True when a lookup for ``needle`` cannot miss a picture its LIKE condition finds."""
    return bool(needle) and "\\" not in needle


class SearchPlan:
    """How one query uses the search index.

    ``ordered_scan`` is True for a page read in library order (see the lookup
    limits above).
    """

    def __init__(self, conn: sqlite3.Connection, *, ordered_scan: bool = False):
        self._conn = conn
        self._ordered_scan = ordered_scan
        self._has_text_index: Optional[bool] = None
        self._library_size: Optional[int] = None

    @property
    def has_text_index(self) -> bool:
        if self._has_text_index is None:
            try:
                for table in (TEXT_FTS, VOCAB_FTS, VOCAB):
                    self._conn.execute(f"SELECT 1 FROM {table} LIMIT 0")
                self._has_text_index = True
            except sqlite3.Error:
                self._has_text_index = False
        return self._has_text_index

    def _lookup_limit(self) -> int:
        if self._library_size is None:
            row = self._conn.execute("SELECT MAX(id) FROM images").fetchone()
            self._library_size = int(row[0] or 0)
        if self._ordered_scan:
            return max(MIN_PAGE_LOOKUP, int(math.sqrt(PAGE_PICTURES_NEEDED * self._library_size)))
        return self._library_size // COUNT_LOOKUP_FRACTION

    def _is_common(self, sql: str, params: Sequence[object]) -> bool:
        """True when the lookup returns more pictures than is worth listing."""
        limit = self._lookup_limit()
        row = self._conn.execute(
            f"SELECT COUNT(*) FROM (SELECT 1 FROM ({sql}) LIMIT ?)",
            [*params, limit + 1],
        ).fetchone()
        return int(row[0]) > limit

    @staticmethod
    def _split(needles: Iterable[str]) -> Tuple[List[str], List[str]]:
        unique = list(dict.fromkeys(needles))
        return (
            [n for n in unique if len(n) >= MIN_TRIGRAM_CHARS],
            [n for n in unique if len(n) < MIN_TRIGRAM_CHARS],
        )

    def text_prefilter(
        self, doc_needles: Iterable[str], token_needles: Iterable[str] = ()
    ) -> Optional[Tuple[str, List[str]]]:
        """Condition limiting ``i`` to pictures whose text may contain a needle.

        ``doc_needles`` are looked up in the picture text (file name, checkpoint,
        prompt, sidecar caption, character text); ``token_needles`` in the prompt
        token index. Returns None when the index is missing or a needle cannot
        be looked up safely, meaning the caller keeps its plain condition.
        """
        long_docs, short_docs = self._split(doc_needles)
        long_tokens, short_tokens = self._split(token_needles)
        everything = long_docs + short_docs + long_tokens + short_tokens
        if (
            not everything
            or not self.has_text_index
            or not all(usable(n) for n in everything)
        ):
            return None

        parts: List[str] = []
        params: List[str] = []
        doc_lookup: Optional[str] = None
        doc_params: List[str] = []
        if long_docs:
            doc_lookup = f"SELECT rowid FROM {TEXT_FTS} WHERE {TEXT_FTS} MATCH ?"
            doc_params = [" OR ".join(fts_phrase(n) for n in long_docs)]
            parts.append(doc_lookup)
            params.extend(doc_params)
        if short_docs:
            likes = " OR ".join(f"body {_LIKE}" for _ in short_docs)
            parts.append(f"SELECT rowid FROM {TEXT_FTS} WHERE {likes}")
            params.extend(_like_pattern(n) for n in short_docs)
        token_words: List[str] = []
        if long_tokens:
            token_words.append(
                f"SELECT v.token FROM {VOCAB} v WHERE v.id IN "
                f"(SELECT rowid FROM {VOCAB_FTS} WHERE {VOCAB_FTS} MATCH ?)"
            )
            params.append(" OR ".join(fts_phrase(n) for n in long_tokens))
        if short_tokens:
            likes = " OR ".join(f"v.token {_LIKE}" for _ in short_tokens)
            token_words.append(f"SELECT v.token FROM {VOCAB} v WHERE {likes}")
            params.extend(_like_pattern(n) for n in short_tokens)
        if token_words:
            parts.append(
                "SELECT ipt.image_id FROM image_prompt_tokens ipt WHERE ipt.token IN ("
                + " UNION ".join(token_words)
                + ")"
            )

        # A lookup that scans the index text (short needles) is not probed: the
        # probe would be a second scan.
        if doc_lookup is not None and not short_docs and self._is_common(doc_lookup, doc_params):
            return None
        return f"i.id IN ({' UNION '.join(parts)})", params

    def lora_prefilter(self, lora_name: str) -> Tuple[str, List[str]]:
        """Condition for pictures carrying the (already normalized) LoRA name."""
        if self._ordered_scan and self._is_common(_LORA_LOOKUP, [lora_name]):
            return _LORA_PROBE, [lora_name]
        return f"i.id IN ({_LORA_LOOKUP})", [lora_name]


def lora_condition(plan: Optional[SearchPlan], lora_name: str) -> Tuple[str, List[str]]:
    """Condition for pictures carrying the (already normalized) LoRA name.

    The same set the old per-picture ``EXISTS`` probe selected; as a list of ids
    it uses the ``LOWER(lora_name)`` index (migration 067) once instead of once
    per picture.
    """
    if plan is None:
        return f"i.id IN ({_LORA_LOOKUP})", [lora_name]
    return plan.lora_prefilter(lora_name)


def drop_search_index(conn: sqlite3.Connection) -> None:
    """Remove the search index tables and triggers (everything migration 067 adds
    except the LoRA index). Pictures and tokens are untouched, and migration 067
    builds the index again; this is for rewinding a schema, e.g. in tests, where
    the triggers would otherwise block dropping a column they read.
    """
    for name in (
        "trg_image_text_fts_insert",
        "trg_image_text_fts_update",
        "trg_image_text_fts_delete",
        "trg_prompt_token_vocab_token_insert",
        "trg_prompt_token_vocab_fts_insert",
    ):
        conn.execute(f"DROP TRIGGER IF EXISTS {name}")
    for table in (TEXT_FTS, VOCAB_FTS, VOCAB):
        conn.execute(f"DROP TABLE IF EXISTS {table}")
