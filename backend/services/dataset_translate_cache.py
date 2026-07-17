"""Translation-cache family for the Dataset Maker translation service.

Split out of ``services/dataset_translate_service.py`` (2026-07) VERBATIM.
This module is the HOME of the ONE rebind seam ``_TRANSLATION_CACHE``
(``None``-lazy, ``global``-rebound once in ``_load_translation_cache``,
mutated in place afterwards) and it deliberately co-homes the whole family:
the lock, the 50k eviction cap, the disk path/load/save helpers and the
cache-key builder. Tests patch ``_TRANSLATION_CACHE`` / ``DEFAULT_CACHE_DIR``
/ ``_TRANSLATION_CACHE_MAX_ITEMS`` on the FACADE
(``services.dataset_translate_service``), which live-forwards those three
names to THIS module via module properties — so the seam stays
module-attribute-addressable in exactly one place. Keep the family together
and keep reads/writes going through module globals here.
"""
from __future__ import annotations

import json
import threading
from pathlib import Path
from typing import Dict, Optional

from config import DEFAULT_CACHE_DIR


_TRANSLATION_CACHE_LOCK = threading.Lock()
_TRANSLATION_CACHE: Optional[Dict[str, str]] = None
_TRANSLATION_CACHE_MAX_ITEMS = 50_000


def _translation_cache_path() -> Path:
    path = Path(DEFAULT_CACHE_DIR) / "dataset-translation-cache.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def _load_translation_cache() -> Dict[str, str]:
    global _TRANSLATION_CACHE
    with _TRANSLATION_CACHE_LOCK:
        if _TRANSLATION_CACHE is not None:
            return _TRANSLATION_CACHE
        path = _translation_cache_path()
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
            _TRANSLATION_CACHE = {
                str(k): str(v)
                for k, v in (raw.items() if isinstance(raw, dict) else [])
                if str(k) and str(v)
            }
        except Exception:
            _TRANSLATION_CACHE = {}
        return _TRANSLATION_CACHE


def _save_translation_cache() -> None:
    with _TRANSLATION_CACHE_LOCK:
        cache = _TRANSLATION_CACHE or {}
        # v3.4.5 fix: the previous LRU truncation kept the LAST N entries
        # by insertion order, which evicted frequently-used early entries
        # (the most common trigger words) in favour of rarely-used late
        # ones. Keep the most-recently-WRITTEN entries instead — for a
        # translation cache that approximates "most useful" far better
        # than insertion order did.
        if len(cache) > _TRANSLATION_CACHE_MAX_ITEMS:
            keep = list(cache.items())[-_TRANSLATION_CACHE_MAX_ITEMS:]
            cache.clear()
            cache.update(keep)
        path = _translation_cache_path()
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(cache, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        tmp.replace(path)


def _translation_cache_key(
    provider: str,
    *,
    source_lang: str,
    target_lang: str,
    mode: str,
    text: str,
) -> str:
    normalized = " ".join(str(text or "").strip().split())
    return json.dumps(
        [
            "dataset-translate-v1",
            str(provider or "auto").lower(),
            str(source_lang or "en").lower(),
            str(target_lang or "zh-CN").lower(),
            str(mode or "caption").lower(),
            normalized,
        ],
        ensure_ascii=False,
        separators=(",", ":"),
    )
