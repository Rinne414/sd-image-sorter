"""The Model Center card of the optional CSD style model (S5)."""

from __future__ import annotations

from typing import Any, Dict

import csd_weights


def csd_card(health: Dict[str, Any]) -> Dict[str, Any]:
    """CSD needs torch (the Aesthetic runtime group) and its own 2.44 GB file."""
    ready = bool(health.get("available"))
    return {
        "id": "csd",
        "name": "CSD Style Descriptors (optional)",
        "name_key": "models.csd.name",
        "group": "Artist ID",
        "group_key": "models.group.artistId",
        "available": ready,
        "status": "ready" if ready else "missing",
        "status_label": "Ready" if ready else "Missing",
        "message": health.get("message") or "Not downloaded yet.",
        "message_key": health.get("message_key") or "models.csd.missing",
        "path": health.get("model_path") or health.get("expected_path", ""),
        "download_supported": True,
        "external_links": [
            {"label": "Model", "url": csd_weights.CSD_LINK},
        ],
        "note": (
            f"License {csd_weights.CSD_LICENSE} (Somepalli et al., University of Maryland). "
            "Download ~2.44 GB, pinned to one commit and checked by SHA-256. Needs torch."
        ),
        "setup_steps": [
            "Click Prepare / Download: it installs torch and open_clip if needed (restart once), then fetches the 2.44 GB pinned file.",
            "On the Style Map choose the CSD space and build the CSD index: pictures are placed by how they are drawn, which suits unusual art styles best.",
            f"License {csd_weights.CSD_LICENSE}; weights from {csd_weights.CSD_FILE.repo}.",
        ],
    }
