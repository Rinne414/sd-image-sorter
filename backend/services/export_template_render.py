"""Template variable resolution + rendering for the caption template engine.

Split verbatim (2026-07) out of ``services/export_template_engine.py`` (see
that facade's docstring for the decomposition map). Owns the category-bucket
split, TemplateContext, ``render_template``, and the separator-cleanup /
token-dedup passes. Pure functions only.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Dict, List, Optional


# ====================================================================
# Variable resolution
# ====================================================================

# Heuristic character tag patterns (anime character names usually contain underscores
# or are multi-word names with parentheses indicating series)
_CHARACTER_TAG_HINTS = re.compile(r"\([^)]+\)$")  # tags ending in (series_name)
# P3-14: danbooru also uses the open-ended forms ``6+girls`` / ``6+boys``.
_COUNT_TAG_PATTERN = re.compile(r"^\d+\+?(girl|boy|girls|boys|other|others|female|male)s?$", re.IGNORECASE)

# tags.category (migration 024) → template bucket. Categories outside this
# map (general/meta/rating/trigger/None) fall through to the heuristic.
_TAG_CATEGORY_BUCKETS: Dict[str, str] = {
    "character": "characters",
    "copyright": "copyright",
    "artist": "artists",
}


def _is_character_tag(tag: str) -> bool:
    """Heuristic: tag has parenthesized suffix or comes from a known list of character tags."""
    return bool(_CHARACTER_TAG_HINTS.search(tag))


def _extract_count_tag(tags: List[str]) -> str:
    """Find subject-count tag (1girl, 2boys, 6+girls, etc.) in the tag list."""
    for tag in tags:
        if _COUNT_TAG_PATTERN.match(tag):
            return tag
    return ""


def _category_norm(tag: str) -> str:
    """Category-lookup key: case-insensitive with ``_``/space folded."""
    return " ".join(str(tag or "").replace("_", " ").lower().split())


def _split_tags_by_type(
    filtered_tags: List[str],
    category_by_norm: Optional[Dict[str, str]] = None,
) -> Dict[str, List[str]]:
    """Split tags into characters / copyright / artists / general.

    The tagger-recorded ``tags.category`` decides when present (P3-11); tags
    without one — legacy rows, replace-rule renames — fall back to the
    parenthesized-suffix character heuristic, everything else is general.
    """
    buckets: Dict[str, List[str]] = {"characters": [], "copyright": [], "artists": [], "general": []}
    lookup = category_by_norm or {}
    for tag in filtered_tags:
        bucket = _TAG_CATEGORY_BUCKETS.get(str(lookup.get(_category_norm(tag)) or ""))
        if bucket is None:
            bucket = "characters" if _is_character_tag(tag) else "general"
        buckets[bucket].append(tag)
    return buckets


@dataclass
class TemplateContext:
    """All variables available to a template."""
    trigger: str = ""
    tags_all: List[str] = field(default_factory=list)
    tags_filtered: List[str] = field(default_factory=list)
    tags_top_n: Dict[int, List[str]] = field(default_factory=dict)
    nl_caption: str = ""
    prompt: str = ""
    negative: str = ""
    rating: str = ""
    quality: str = ""
    safety: str = ""
    append: str = ""
    separator: str = ", "
    # P3-11: normalized tag → tags.category, so the category sections render
    # from tagger provenance instead of guessing.
    category_by_norm: Dict[str, str] = field(default_factory=dict)

    def resolve(self) -> Dict[str, str]:
        """Build dict of variable name -> resolved string."""
        split = _split_tags_by_type(self.tags_filtered, self.category_by_norm)
        count = _extract_count_tag(self.tags_filtered)
        sep = self.separator

        return {
            "trigger": self.trigger,
            "tags": sep.join(self.tags_all),
            "tags:filtered": sep.join(self.tags_filtered),
            "nl_caption": self.nl_caption,
            "prompt": self.prompt,
            "negative": self.negative,
            "rating": self.rating,
            "characters": sep.join(split["characters"]),
            "copyright": sep.join(split["copyright"]),
            "artists": sep.join(split["artists"]),
            # Anima model-card convention: artists carry an @ prefix.
            "artists:@": sep.join(f"@{a}" for a in split["artists"]),
            "general": sep.join(split["general"]),
            "quality": self.quality,
            "safety": self.safety,
            "count": count,
            "append": self.append,
        }


# ====================================================================
# Template rendering
# ====================================================================

# Match {variable}, {tags:N} (digit N), or modifier forms like {artists:@}
_TEMPLATE_VAR_PATTERN = re.compile(r"\{([a-zA-Z_]+(?::[\w@]+)?)\}")


def render_template(template: str, context: TemplateContext) -> str:
    """Render a template by substituting variables.

    Empty variables are replaced with empty strings; consecutive separators
    and trailing/leading separators are cleaned up.
    """
    resolved = context.resolve()

    def substitute(match: re.Match) -> str:
        var = match.group(1)
        # Handle {tags:N}
        if var.startswith("tags:"):
            suffix = var.split(":", 1)[1]
            if suffix == "filtered":
                return resolved["tags:filtered"]
            try:
                n = int(suffix)
                top_n = context.tags_top_n.get(n) or context.tags_filtered[:n]
                return context.separator.join(top_n)
            except ValueError:
                return ""
        return resolved.get(var, "")

    # Render line by line so literal prose and author-written line breaks
    # survive (v3.4.3: custom templates may freely mix free text, blank
    # lines and {variables}). Blank lines written in the template are
    # preserved; lines that only became empty because every variable on
    # them resolved empty are dropped. Separator cleanup and token dedup
    # stay per-line, so single-line templates behave exactly as before.
    out_lines: List[str] = []
    for line in str(template or "").split("\n"):
        if not line.strip():
            out_lines.append("")
            continue
        rendered = _TEMPLATE_VAR_PATTERN.sub(substitute, line)
        cleaned = _cleanup_separators(rendered, context.separator)
        deduped = _dedup_tokens(cleaned, context.separator)
        if deduped:
            out_lines.append(deduped)
    while out_lines and not out_lines[0]:
        out_lines.pop(0)
    while out_lines and not out_lines[-1]:
        out_lines.pop()
    return "\n".join(out_lines)


def _dedup_tokens(text: str, separator: str) -> str:
    """Drop duplicate tokens while preserving first-occurrence order.

    Two tokens are duplicates when their normalised forms match — case
    is ignored, leading/trailing whitespace is stripped, and
    underscores are folded with spaces. This is the same equivalence
    the rest of the engine uses (``_normalize_blacklist_item``).

    Concretely it fixes the LoRA-training regression where ``{trigger}``
    and an item in ``{append}`` could both produce the trigger word
    once with an underscore (``my_oc``) and once after underscore
    normalisation (``my oc``); a real trainer would treat those as
    two distinct BPE tokens.

    P3-14: the first ``". "`` marks the tag→sentence boundary (anima-style
    ``{general}. {nl_caption}``). The sentence is prose, so it is no longer
    token-deduped (which could delete commas mid-sentence) — but a leading
    run of already-seen tag tokens is stripped, because an ``ai_caption``
    fallback (fused tags+sentence) echoes the whole tag list there.
    """
    if not text:
        return ""
    sep = separator if separator else ", "

    boundary = text.find(". ")
    sentence = ""
    tag_zone = text
    if boundary != -1:
        tag_zone = text[:boundary]
        sentence = text[boundary + 2:]

    parts = [p.strip() for p in tag_zone.split(sep)]
    seen: set = set()
    kept: list = []
    for p in parts:
        if not p:
            continue
        # Treat ``_`` and `` `` as equivalent so ``my_oc`` and ``my oc``
        # collapse to one entry. Case-insensitive.
        norm = " ".join(p.replace("_", " ").lower().split())
        if norm in seen:
            continue
        seen.add(norm)
        kept.append(p)
    result = sep.join(kept)

    if sentence:
        stokens = [s.strip() for s in sentence.split(sep)]
        index = 0
        while index < len(stokens):
            norm = " ".join(stokens[index].replace("_", " ").lower().split())
            if norm and norm in seen:
                index += 1
            else:
                break
        sentence_clean = sep.join(s for s in stokens[index:] if s).strip()
        if sentence_clean:
            result = f"{result}. {sentence_clean}" if result else sentence_clean
    return result


def _cleanup_separators(text: str, separator: str) -> str:
    """Remove duplicate separators and leading/trailing separator artifacts.

    Examples (sep=', '):
      ', , tag1, tag2, ' -> 'tag1, tag2'
      'tag1, , , tag2'   -> 'tag1, tag2'
    """
    if not text:
        return ""
    # Split on separator, strip, drop empties
    sep_stripped = separator.strip()
    if not sep_stripped:
        return text.strip()
    parts = [p.strip() for p in text.split(sep_stripped)]
    parts = [p for p in parts if p]
    result = separator.join(parts).strip()
    # Remove trailing ". " or "." left when template variables after a period
    # separator (e.g., "{tags}. {nl_caption}") resolve to empty.
    while result.endswith('.') or result.endswith('. '):
        candidate = result.rstrip('. ').rstrip('.')
        if candidate == result:
            break
        # Only strip if what remains looks like it ended with a comma-separated
        # tag (not a proper NL sentence that naturally ends with a period).
        # Heuristic: if the last character before the period is a letter and
        # the segment after the last comma has spaces, it's a sentence — keep it.
        last_comma = candidate.rfind(sep_stripped)
        tail = candidate[last_comma + len(sep_stripped):].strip() if last_comma >= 0 else candidate
        if ' ' in tail and len(tail) > 20:
            # Looks like a sentence — don't strip
            break
        result = candidate
    return result
