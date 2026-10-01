"""Model sources: detect roots, match pinned models, persist the choice (MS1a).

Backs ``GET /api/models/sources/detect``. The trusted-folder list is the one
``model_roots`` keeps (SEC1b); a match counts as trusted only when
``model_roots.is_under_allowed_model_root`` accepts it, exactly like the
loaders. Trusted matches are written to ``CONFIG_DIR/model_sources.json`` for
the loaders (MS1b); everything found in untrusted roots is returned as
suggestions for the Model Center to offer.

The request thread never touches a network path. Network roots (a trusted
NAS, an ``HF_HUB_CACHE`` on a share) are judged by the background job that
also runs the drive scan; ``detect`` serves their cached result and marks
the rest ``network_pending``. ``rescan=1`` only starts that job again.
"""

from __future__ import annotations

import logging
import os
import threading
import time
from pathlib import Path
from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence

import model_matchers
import model_roots
import model_sources
import model_sources_store

logger = logging.getLogger(__name__)

TrustedProvider = Callable[[], Sequence[Mapping[str, Any]]]
TrustCheck = Callable[[str], bool]


def default_trusted_folders() -> List[Dict[str, Any]]:
    """The Model Center's trusted folders, kind decided by looking at them."""
    return [
        {"path": path, "kind": "auto"}
        for path in model_roots.list_trusted_model_folders()
    ]


class ModelSourcesService:
    def __init__(
        self,
        *,
        trusted_provider: Optional[TrustedProvider] = None,
        store: Optional[model_sources_store.ModelSourcesStore] = None,
        env: Optional[Mapping[str, str]] = None,
        home: Optional[Path] = None,
        probe_known_locations: bool = True,
        background_scan: bool = True,
        trust_check: Optional[TrustCheck] = None,
    ) -> None:
        self._trusted_provider = trusted_provider or default_trusted_folders
        self._store = store
        self._store_lock = threading.Lock()
        self._env = env
        self._home = home
        self._probe = probe_known_locations
        self._background_scan = background_scan
        self._trust_check = trust_check or model_roots.is_under_allowed_model_root

    @property
    def store(self) -> model_sources_store.ModelSourcesStore:
        with self._store_lock:
            if self._store is None:
                self._store = model_sources_store.ModelSourcesStore(
                    model_sources_store.default_store_path()
                )
            return self._store

    def _trusted_folders(self) -> List[Mapping[str, Any]]:
        try:
            return list(self._trusted_provider())
        except Exception as exc:  # user data; a broken list must not hide detection
            logger.warning("Trusted folder list unavailable: %s", exc)
            return []

    # background job --------------------------------------------------------

    def _scan_network_roots(
        self, pending: Sequence[model_sources.PendingRoot], generation: int
    ) -> None:
        """Judge and match network roots; only ever called on the scan thread."""
        store = self.store
        for item in pending:
            root = model_sources.build_source_root(
                item.path,
                kind=item.kind,
                origin=item.origin,
                trusted_rank=item.trusted_rank,
                network_allowed=True,
            )
            payload: Dict[str, Any] = {
                "path": item.path,
                "scanned_at": time.time(),
                "root": None,
                "matches": [],
                "rejected": [],
            }
            if root is not None:
                report = model_matchers.match_root(
                    root,
                    digest_cache=store,
                    trust_check=self._trust_check,
                    network_allowed=True,
                )
                payload["root"] = root.to_dict()
                payload["matches"] = [m.to_dict() for m in report.matches]
                payload["rejected"] = [r.to_dict() for r in report.rejected]
            store.save_network_result(item.key, payload, generation=generation)

    def _start_background(
        self, pending: Sequence[model_sources.PendingRoot], *, force: bool
    ) -> None:
        if not (force or self._background_scan):
            return
        model_sources_store.start_background_scan(
            self.store,
            work=lambda generation: self._scan_network_roots(pending, generation),
            force=force,
        )

    # request thread --------------------------------------------------------

    def _cached_network(
        self,
        pending: Sequence[model_sources.PendingRoot],
        report: model_matchers.MatchReport,
    ) -> List[Dict[str, Any]]:
        """Source rows for network roots from the background cache; pending when there is none yet."""
        sources: List[Dict[str, Any]] = []
        for item in pending:
            cached = self.store.network_result(item.key)
            row = {
                "path": item.path,
                "kind": item.kind,
                "origin": item.origin,
                "is_network": True,
                "version": None,
                "trusted": item.trusted_rank < model_sources.UNTRUSTED_RANK,
                "network_pending": cached is None,
                "network_scanned_at": None
                if cached is None
                else cached.get("scanned_at"),
            }
            if cached is not None:
                root = cached.get("root") or {}
                row["kind"] = root.get("kind") or item.kind
                row["version"] = root.get("version")
                report.matches.extend(
                    model_matchers.ExternalMatch.from_dict(m)
                    for m in cached.get("matches") or []
                )
                report.rejected.extend(
                    model_matchers.RejectedCandidate(**r)
                    for r in cached.get("rejected") or []
                )
            sources.append(row)
        return sources

    def _match_local(
        self, roots: Sequence[model_sources.SourceRoot]
    ) -> model_matchers.MatchReport:
        report = model_matchers.MatchReport()
        for root in roots:
            report.extend(
                model_matchers.match_root(
                    root, digest_cache=self.store, trust_check=self._trust_check
                )
            )
        return report

    def detect(self, *, rescan: bool = False) -> Dict[str, Any]:
        """Roots, trusted matches, suggestions, rejections, bytes saved and the scan state."""
        store = self.store
        roots, pending = model_sources.detect_source_roots(
            self._trusted_folders(),
            env=self._env,
            home=self._home,
            scan_cache=store.scan_roots(),
            probe=self._probe,
        )
        self._start_background(pending, force=rescan)
        report = self._match_local(roots)
        network_sources = self._cached_network(pending, report)

        chosen = model_matchers.select_best(m for m in report.matches if m.trusted)
        store.save_matches(m.to_dict() for m in chosen)
        suggestions = _suggestions([m for m in report.matches if not m.trusted], roots)
        counts = _counts_by_source(report.matches)
        sources = []
        for root in roots:
            row = root.to_dict()
            row["network_pending"] = False
            row["network_scanned_at"] = None
            row["model_count"] = counts.get(model_sources.source_key(root.path), 0)
            sources.append(row)
        for row in network_sources:
            row["model_count"] = counts.get(model_sources.source_key(row["path"]), 0)
            sources.append(row)
        scan = model_sources_store.scan_status(store)
        scan["roots"] = store.scan_roots()
        return {
            "sources": sources,
            "matches": [m.to_dict() for m in chosen],
            "suggestions": suggestions,
            "rejected": [r.to_dict() for r in report.rejected],
            "reusable_bytes": sum(m.total_bytes for m in chosen),
            "scan": scan,
        }


def _counts_by_source(
    matches: Sequence[model_matchers.ExternalMatch],
) -> Dict[str, int]:
    """Distinct (model, variant) per source root, trusted or not."""
    seen: Dict[str, set] = {}
    for match in matches:
        key = model_sources.source_key(match.source)
        seen.setdefault(key, set()).add((match.model_id, match.variant))
    return {key: len(items) for key, items in seen.items()}


def _suggestions(
    untrusted: Sequence[model_matchers.ExternalMatch],
    roots: Sequence[model_sources.SourceRoot],
) -> List[Dict[str, Any]]:
    """One row per folder that would have to be trusted, with what it holds."""
    by_path = {os.path.normcase(r.path): r for r in roots}
    groups: Dict[str, List[model_matchers.ExternalMatch]] = {}
    for match in untrusted:
        groups.setdefault(match.folder, []).append(match)
    rows: List[Dict[str, Any]] = []
    for folder, matches in groups.items():
        best = model_matchers.select_best(matches)
        root = by_path.get(os.path.normcase(folder))
        rows.append(
            {
                "root": folder,
                "kind": root.kind if root is not None else model_sources.KIND_FOLDER,
                "origin": best[0].origin,
                "version": root.version if root is not None else None,
                "models": [
                    {
                        "model_id": m.model_id,
                        "variant": m.variant,
                        "verify": m.verify,
                        "size_bytes": m.size_bytes,
                    }
                    for m in best
                ],
                "reusable_bytes": sum(m.total_bytes for m in best),
            }
        )
    return rows


_default_service = ModelSourcesService()


def get_model_sources_service() -> ModelSourcesService:
    return _default_service
