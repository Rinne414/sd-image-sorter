"""Model sources: detect roots, match pinned models, persist the choice (MS1a).

Backs ``GET /api/models/sources/detect``. The trusted-folder list is read
through ``model_sources.get_trusted_folders`` (its storage belongs to the
trusted-folders slice). The chosen matches are written to
``CONFIG_DIR/model_sources.json`` for the loaders (MS1b) to read back.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence

import model_matchers
import model_sources

logger = logging.getLogger(__name__)

TrustedProvider = Callable[[], Sequence[Mapping[str, Any]]]


class ModelSourcesService:
    def __init__(
        self,
        *,
        trusted_provider: Optional[TrustedProvider] = None,
        store: Optional[model_sources.ModelSourcesStore] = None,
        env: Optional[Mapping[str, str]] = None,
        home: Optional[Path] = None,
        probe_known_locations: bool = True,
        background_scan: bool = True,
    ) -> None:
        self._trusted_provider = trusted_provider
        self._store = store
        self._env = env
        self._home = home
        self._probe = probe_known_locations
        self._background_scan = background_scan

    @property
    def store(self) -> model_sources.ModelSourcesStore:
        if self._store is None:
            self._store = model_sources.ModelSourcesStore(
                model_sources.default_store_path()
            )
        return self._store

    def _trusted_folders(self) -> List[Mapping[str, Any]]:
        if self._trusted_provider is not None:
            return list(self._trusted_provider())
        return model_sources.get_trusted_folders()

    def detect(self, *, rescan: bool = False) -> Dict[str, Any]:
        """Roots, matches, rejections, bytes saved and the drive-scan state."""
        store = self.store
        if rescan:
            model_sources.rescan_now(store)
        elif self._background_scan:
            model_sources.ensure_background_scan(store)

        roots = model_sources.detect_source_roots(
            self._trusted_folders(),
            env=self._env,
            home=self._home,
            scan_cache=store.scan_roots(),
            probe=self._probe,
        )
        all_matches: List[model_matchers.ExternalMatch] = []
        rejected: List[model_matchers.RejectedCandidate] = []
        for root in roots:
            report = model_matchers.match_root(root, digest_cache=store)
            all_matches.extend(report.matches)
            rejected.extend(report.rejected)
        chosen = model_matchers.select_best(all_matches)
        store.save_matches(m.to_dict() for m in chosen)

        counts: Dict[str, int] = {}
        for match in chosen:
            key = os.path.normcase(match.source)
            counts[key] = counts.get(key, 0) + 1
        sources = []
        for root in roots:
            payload = root.to_dict()
            payload["model_count"] = counts.get(os.path.normcase(root.path), 0)
            sources.append(payload)
        scan = model_sources.scan_status(store)
        scan["roots"] = store.scan_roots()
        return {
            "sources": sources,
            "matches": [m.to_dict() for m in chosen],
            "rejected": [r.to_dict() for r in rejected],
            "reusable_bytes": sum(m.total_bytes for m in chosen),
            "scan": scan,
        }


_default_service = ModelSourcesService()


def get_model_sources_service() -> ModelSourcesService:
    return _default_service
