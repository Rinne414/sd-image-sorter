"""The pictures behind a dataset's folder scans, for checks that work on paths.

A folder import too large to list in the page reaches the backend as its scan
(``dataset_scan_tokens``: ``[{scan_token, exclude_paths}]``) instead of its
paths. The audit, the blur / flat check and character purity all take it this
way and need the same list.
"""

from __future__ import annotations

from typing import Any, Dict, Iterable, List


def scan_source_paths(sources: Iterable[Dict[str, Any]]) -> List[str]:
    """Every picture of the listed folder scans, minus the ones taken out of the dataset.

    Raises ValueError for a scan token that is unknown or expired. The paths are
    also trusted for the local-thumbnail endpoint, since the results show them.
    """
    from services.dataset_session.allowlist import (
        register_scan_manifest_paths_for_session,
    )
    from services.dataset_session.manifest_store import iter_scan_manifest_paths

    out: List[str] = []
    for source in sources or []:
        token = str(
            (source or {}).get("scan_token") or (source or {}).get("token") or ""
        )
        if not token:
            continue
        excluded = {
            str(path)
            for path in ((source or {}).get("exclude_paths") or [])
            if str(path)
        }
        out.extend(
            path
            for path in iter_scan_manifest_paths(token)
            if str(path) not in excluded
        )
        register_scan_manifest_paths_for_session(token)
    return out
