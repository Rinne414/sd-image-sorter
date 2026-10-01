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
from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence, Tuple

import model_matchers
import model_roots
import model_source_paths
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
        self,
        pending: Sequence[model_sources.PendingRoot],
        *,
        force: bool,
        uncached: bool,
    ) -> None:
        """Start the drive scan + network pass: once per process, on
        ``rescan``, or whenever a pending root has no cached result and no
        job is running (a NAS trusted after the first job)."""
        if not model_sources.discovery_enabled(self._env):
            return  # no automatic finding: no drive scan either
        if not (force or self._background_scan):
            return
        if uncached and not model_sources_store.is_scan_running():
            force = True
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
    ) -> Tuple[List[Dict[str, Any]], bool]:
        """Source rows for network roots from the background cache, and whether
        any of them still has no usable result. A malformed cached entry is
        logged and treated as pending; it never takes the request down."""
        sources: List[Dict[str, Any]] = []
        uncached = False
        for item in pending:
            row = {
                "path": item.path,
                "kind": item.kind,
                "origin": item.origin,
                "is_network": True,
                "version": None,
                "trusted": item.trusted_rank < model_sources.UNTRUSTED_RANK,
                "network_pending": True,
                "network_scanned_at": None,
            }
            try:
                cached = self.store.network_result(item.key)
                if cached is not None:
                    _apply_cached_network(cached, item, row, report)
            except Exception as exc:  # the cache is a file anyone can edit
                logger.warning(
                    "Cached network result for %s unusable (%s); scanning again",
                    item.path,
                    exc,
                )
                row["network_pending"] = True
                row["network_scanned_at"] = None
            uncached = uncached or row["network_pending"]
            sources.append(row)
        return sources, uncached

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
        report = self._match_local(roots)
        network_sources, uncached = self._cached_network(pending, report)
        self._start_background(pending, force=rescan, uncached=uncached)

        chosen = model_matchers.select_best(m for m in report.matches if m.trusted)
        chosen_rows = [m.to_dict() for m in chosen]
        store.save_matches(
            chosen_rows + self._carried_network_matches(network_sources, chosen_rows)
        )
        suggested = self._suggestion_candidates(report.matches, chosen)
        suggestions = _suggestions(suggested, roots)
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
        sources.extend(self._unread_network_rows())
        scan = model_sources_store.scan_status(store)
        scan["roots"] = store.scan_roots()
        return {
            "sources": sources,
            "matches": [m.to_dict() for m in chosen],
            "suggestions": suggestions,
            "suggested_reusable_bytes": sum(m.total_bytes for m in suggested),
            "rejected": [r.to_dict() for r in report.rejected],
            "reusable_bytes": sum(m.total_bytes for m in chosen),
            "scan": scan,
        }

    def _carried_network_matches(
        self,
        network_sources: Sequence[Mapping[str, Any]],
        chosen_rows: Sequence[Mapping[str, Any]],
    ) -> List[Dict[str, Any]]:
        """Recorded matches of a network root whose background result is not in
        yet: they are kept as they were, not written off as lost."""
        pending = {
            model_sources.source_key(row["path"])
            for row in network_sources
            if row["network_pending"]
        }
        if not pending:
            return []
        found = {(m.get("model_id"), m.get("variant") or None) for m in chosen_rows}
        return [
            m
            for m in self.store.matches()
            if model_sources.source_key(m.get("source") or "") in pending
            and (m.get("model_id"), m.get("variant") or None) not in found
        ]

    def _unread_network_rows(self) -> List[Dict[str, Any]]:
        """A ComfyUI folder the user pointed ``COMFYUI_PATH`` at on the network
        that is not trusted: never read, but listed so Model Center can offer
        to trust it (a pure string check; nothing touches the network)."""
        env = os.environ if self._env is None else self._env
        if not model_sources.discovery_enabled(env):
            return []
        text = str(env.get("COMFYUI_PATH") or "").strip()
        if not text or not model_source_paths.is_network_path(text):
            return []
        if self._trust_check(text):
            return []
        return [
            {
                "path": text,
                "kind": model_sources.KIND_COMFYUI,
                "origin": model_sources.ORIGIN_ENV,
                "is_network": True,
                "version": None,
                "trusted": False,
                "network_pending": False,
                "network_scanned_at": None,
                "network_not_trusted": True,
                "model_count": 0,
            }
        ]

    def _suggestion_candidates(
        self,
        matches: Sequence[model_matchers.ExternalMatch],
        chosen: Sequence[model_matchers.ExternalMatch],
    ) -> List[model_matchers.ExternalMatch]:
        """Untrusted matches worth offering: not already adopted from a trusted
        place, one copy per model across all folders, and never from the
        program's own Hugging Face cache (``DATA_DIR/hf``)."""
        adopted = {(m.model_id, m.variant) for m in chosen}
        own_hf = _program_hf_cache()
        candidates = [
            m
            for m in matches
            if not m.trusted
            and (m.model_id, m.variant) not in adopted
            and not (own_hf and _under(m.folder, own_hf))
        ]
        return model_matchers.select_best(candidates)


def _program_hf_cache() -> Optional[str]:
    """``DATA_DIR/hf``, the cache the launcher points ``HF_HOME`` at."""
    try:
        import config

        kind, real = model_source_paths.resolve_local_chain(
            os.path.join(str(config.DATA_DIR), "hf")
        )
    except Exception as exc:  # config is import-time state; never fail detect over it
        logger.warning("Program HF cache location unknown: %s", exc)
        return None
    return real if kind == model_source_paths.KIND_LOCAL else None


def _under(path: str, base: str) -> bool:
    key = os.path.normcase(os.path.normpath(path))
    base_key = os.path.normcase(os.path.normpath(base))
    return key == base_key or key.startswith(base_key.rstrip(os.sep) + os.sep)


def _apply_cached_network(
    cached: Mapping[str, Any],
    item: model_sources.PendingRoot,
    row: Dict[str, Any],
    report: model_matchers.MatchReport,
) -> None:
    """Fill a source row from one cached background result; raises on bad shapes."""
    if not isinstance(cached, Mapping):
        raise ValueError(f"cached result is a {type(cached).__name__}, not an object")
    root = cached.get("root")
    if root is not None and not isinstance(root, dict):
        raise ValueError("root is not an object")
    matches = [
        model_matchers.ExternalMatch.from_dict(m) for m in cached.get("matches") or ()
    ]
    rejected = [
        model_matchers.RejectedCandidate(**r) for r in cached.get("rejected") or ()
    ]
    row["network_pending"] = False
    row["network_scanned_at"] = cached.get("scanned_at")
    if root:
        row["kind"] = root.get("kind") or item.kind
        row["version"] = root.get("version")
    report.matches.extend(matches)
    report.rejected.extend(rejected)


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
    suggested: Sequence[model_matchers.ExternalMatch],
    roots: Sequence[model_sources.SourceRoot],
) -> List[Dict[str, Any]]:
    """One row per folder that would have to be trusted, with what it holds
    (``suggested`` is already one copy per model)."""
    by_path = {os.path.normcase(r.path): r for r in roots}
    groups: Dict[str, List[model_matchers.ExternalMatch]] = {}
    for match in suggested:
        groups.setdefault(match.folder, []).append(match)
    rows: List[Dict[str, Any]] = []
    for folder, best in groups.items():
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
