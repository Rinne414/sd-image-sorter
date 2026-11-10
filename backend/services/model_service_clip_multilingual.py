"""The Model Center card of the optional multilingual text search model."""

from __future__ import annotations

from typing import Any, Dict

import clip_multilingual


def clip_multilingual_card(health: Dict[str, Any]) -> Dict[str, Any]:
    """About 132 MB, CPU only, no extra Python packages, nothing indexed again."""
    ready = bool(health.get("available"))
    megabytes = health.get("download_mb") or round(
        clip_multilingual.download_bytes() / (1024 * 1024)
    )
    return {
        "id": clip_multilingual.MODEL_ID,
        "name": "Multilingual Text Search (optional)",
        "name_key": "models.clipMultilingual.name",
        "group": "Search",
        "group_key": "models.group.search",
        "available": ready,
        "status": "ready" if ready else "missing",
        "status_label": "Ready" if ready else "Missing",
        "message": health.get("message") or "Not downloaded yet.",
        "message_key": health.get("message_key") or "models.clipMultilingual.missing",
        "path": health.get("model_path") or health.get("expected_path", ""),
        "download_supported": True,
        "external_links": [
            {"label": "Model", "url": clip_multilingual.LINK},
        ],
        "note": (
            f"License {clip_multilingual.LICENSE} (Reimers & Gurevych, sentence-transformers). "
            f"Download ~{megabytes} MB, pinned to one commit and checked by SHA-256. Runs on the CPU."
        ),
        "setup_steps": [
            f"Click Prepare / Download: three files, about {megabytes} MB in total. No restart.",
            "In Find Similar, describe the picture in Chinese, Japanese, Korean or another language: "
            "the search reads it against the similarity index you already built.",
            "English descriptions keep using the CLIP text model.",
        ],
    }
