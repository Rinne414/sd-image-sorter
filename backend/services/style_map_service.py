"""Style map points (slice S2a): a 3-D PCA layout of the filtered library.

``points()`` turns the current Gallery filter (a selection token, the same
contract every "act on the matches" path reads) into one point per picture:

1. the filtered image ids come from ``database.iter_filtered_image_id_chunks``
   with ``selection_contract_db_filters`` -- no second filter parser;
2. the vectors are read for those ids only (``image_style_vectors`` for
   ``kaloscope``, ``images.embedding`` for ``clip``) and unit-normalised;
3. pictures whose unit vector is dominated by one component (> 0.5) are
   reported as ``unlocatable`` and kept out of the fit (Kaloscope answers a
   few broken pictures with one activation of ~1e8);
4. pictures connected by cosine > 0.95 links form one group (single linkage)
   represented by the smallest id -- the candidate search runs in a PCA
   projection with an exact bound, so no true pair is missed, and every
   candidate is confirmed in full dimension without gathering a row per pair;
5. PCA to three axes (fitted on every placeable picture, shared with the
   candidate search), scaled to [-1, 1].

Results are cached as JSON bytes per (library, space, model version, filter,
member ids, vector version); one layout is computed at a time and a
concurrent request for the same key waits for it instead of recomputing.

UMAP (slice S2b.1) is an optional install group (Model Center card
``style-map-umap``). When umap-learn is importable and the map has enough
representatives, the PCA answer is returned at once and a background job
fits UMAP on the representatives' projection onto the first
``UMAP_INPUT_DIM`` principal axes; once ready, ``points`` carry the UMAP
coordinates (``method: "umap"``) and the layout is kept in memory and on
disk (``state/style-map/``) so a restart does not refit. The ``umap`` field
of every response and ``GET /api/style-map/layout-status`` report the job.
"""

from __future__ import annotations

import hashlib
import json
import logging
import threading
import time
from collections import OrderedDict, deque
from dataclasses import replace
from typing import Any, Deque, Dict, List, Optional

import numpy as np

import database as db
from config import CLIP_MODEL_NAME
from db_style_vectors import unpack_style_vector, vector_signature
from exceptions import ValidationError
from library_context import get_current_library_id
from optional_dependencies import OPTIONAL_DEPENDENCY_GROUPS
from services import style_map_umap
from services.image.selection import selection_contract_db_filters
from services.style_map_math import (
    _CANDIDATE_DIM,
    STYLE_MAP_BLAS_THREADS,
    _top_components,
    blas_budget,
    find_unlocatable,
    merge_near_duplicates,
    pca_layout,
)
from services.style_map_colors import StyleMapColorsMixin, map_handle
from services.style_map_query import StyleMapQueryMixin
from services.style_map_regions import RegionsCache, regions_body
from services.style_vector_service import style_vector_model_version
from services.style_map_umap import (
    _LayoutJob,
    _MapInputs,
    UMAP_INPUT_DIM,
    UMAP_INSTALL_MODEL_ID,
    UMAP_MIN_POINTS,
    fit_umap_layout,
    map_rules,
    umap_params,
)

__all__ = ["STYLE_MAP_BLAS_THREADS", "StyleMapService"]
from similarity_math import bytes_to_embedding

logger = logging.getLogger(__name__)

STYLE_MAP_SPACES = ("kaloscope", "clip")
STYLE_MAP_METHOD = "pca"
POINT_DECIMALS = 3
POINTS_LAYOUT = ["id", "x", "y", "z", "members"]
_ID_CHUNK = 500
_ID_PAGE = 5000
_CACHE_ENTRIES = 8
STYLE_MAP_METHODS = ("pca", "umap")
_LAYOUT_MEMORY_ENTRIES = 8
# Finished job records kept for status answers (queued ones are never dropped).
_JOB_HISTORY = 32
# Maps waiting behind the running fit. A user flicking through filters must
# not line up ten fits nobody is looking at: older queued maps are forgotten
# and come back only when asked for again.
_QUEUE_LIMIT = 2


# ------------------------------------------------------------------- service
class StyleMapService(StyleMapColorsMixin, StyleMapQueryMixin):
    """Computes and caches the 3-D layout of the filtered library (point
    colours of a cached map: ``colors_json`` from the mixin)."""

    def __init__(self) -> None:
        self._cache: "OrderedDict[tuple, tuple[bytes, int]]" = OrderedDict()
        # Same keys as _cache, evicted together: the UMAP inputs of each map.
        self._inputs: Dict[tuple, _MapInputs] = {}
        self._handles: Dict[str, tuple] = {}  # map_id (in points answers) -> key
        self._stamp = 0
        self._cache_lock = threading.Lock()
        self._compute_lock = threading.Lock()
        self.last_stats: Dict[str, Any] = {}
        # UMAP: ready layouts (memory), job records, one worker at a time.
        self._umap_lock = threading.Lock()
        # layout key -> (rep_ids, xyz, source, elapsed_s)
        self._layouts: "OrderedDict[tuple, tuple[np.ndarray, np.ndarray, str, float]]" = OrderedDict()
        # layout key -> the ready response body (without the cached flag)
        self._rendered: Dict[tuple, bytes] = {}
        self._regions = RegionsCache(_LAYOUT_MEMORY_ENTRIES)
        self._umap_jobs: "OrderedDict[tuple, _LayoutJob]" = OrderedDict()
        self._umap_queue: Deque[tuple] = deque()
        self._umap_thread: Optional[threading.Thread] = None
        self._umap_running = False

    # ---------------------------------------------------------------- inputs
    @staticmethod
    def _require_space(space: str) -> str:
        normalized = str(space or "").strip().lower()
        if normalized not in STYLE_MAP_SPACES:
            raise ValidationError(
                f"Unknown style space {space!r}; expected one of {', '.join(STYLE_MAP_SPACES)}",
                field="space",
            )
        return normalized

    @staticmethod
    def _contract(selection_token: Optional[str]) -> Dict[str, Any]:
        """The Gallery filter contract; the whole library when no token is given."""
        if not selection_token:
            return {}
        from services.image_service import ImageService

        return ImageService()._decode_selection_token(selection_token)

    @staticmethod
    def _model_version(space: str, model_path: Optional[str] = None) -> str:
        """The vector version this map reads: the user's Style Finder weights
        (a local checkpoint names its own version), else the official ones."""
        if space == "clip":
            return f"clip:{CLIP_MODEL_NAME}"
        return style_vector_model_version(model_path)

    @staticmethod
    def _vector_version(space: str, model_version: str) -> tuple:
        """Changes whenever a vector of this space is added, removed or rewritten
        (``db_style_vectors.vector_signature``)."""
        with db.get_db() as conn:
            return vector_signature(
                conn.cursor(), space=space, model_version=model_version
            )

    @staticmethod
    def _member_hash(ids: List[int]) -> str:
        """The filtered picture set itself (sorted ids), not just its size."""
        digest = hashlib.sha256()
        digest.update(np.asarray(sorted(ids), dtype=np.int64).tobytes())
        return digest.hexdigest()

    # ----------------------------------------------------------------- cache
    def _cache_get(self, key: tuple) -> Optional[tuple[bytes, int]]:
        """(payload, stamp); the stamp orders cache writes for refresh de-duplication."""
        with self._cache_lock:
            entry = self._cache.get(key)
            if entry is not None:
                self._cache.move_to_end(key)
            return entry

    def _cache_put(self, key: tuple, value: bytes, inputs: _MapInputs) -> None:
        with self._cache_lock:
            self._stamp += 1
            self._cache[key] = (value, self._stamp)
            self._cache.move_to_end(key)
            self._inputs[key] = inputs
            self._handles[map_handle(key)] = key
            while len(self._cache) > _CACHE_ENTRIES:
                evicted, _entry = self._cache.popitem(last=False)
                self._inputs.pop(evicted, None)
                self._handles.pop(map_handle(evicted), None)

    def clear_cache(self) -> None:
        with self._cache_lock:
            self._cache.clear()
            self._inputs.clear()
            self._handles.clear()
        with self._umap_lock:
            self._layouts.clear()
            self._rendered.clear()
            self._regions.clear()

    # ------------------------------------------------------------------ main
    def _map_key(
        self,
        space: str,
        selection_token: Optional[str],
        model_path: Optional[str] = None,
    ) -> tuple[str, str, List[int], tuple]:
        normalized = self._require_space(space)
        contract = self._contract(selection_token)
        model_version = self._model_version(normalized, model_path)
        ids = self._filtered_ids(contract)
        key = (
            get_current_library_id(),
            normalized,
            model_version,
            self._member_hash(ids),
            self._vector_version(normalized, model_version),
        )
        return normalized, model_version, ids, key

    def points_json(
        self,
        space: str,
        selection_token: Optional[str] = None,
        *,
        refresh: bool = False,
        model_path: Optional[str] = None,
    ) -> bytes:
        """JSON bytes (what the route returns). ``refresh`` skips the cache read;
        ``model_path`` = the user's local checkpoint (None: official weights)."""
        normalized, model_version, ids, key = self._map_key(
            space, selection_token, model_path
        )
        entry = None if refresh else self._cache_get(key)
        cached = entry is not None
        if entry is None:
            with self._cache_lock:
                waited_since = self._stamp
            with self._compute_lock:
                entry = self._cache_get(key)
                # A refresh that queued behind another computation of the same
                # map takes that fresh result instead of recomputing it again.
                if entry is not None and (not refresh or entry[1] > waited_since):
                    cached = True
                else:
                    with blas_budget():
                        result, inputs = self._compute(normalized, model_version, ids)
                    payload = json.dumps(result, separators=(",", ":")).encode("utf-8")
                    self._cache_put(key, payload, replace(inputs, filter_ids=np.asarray(sorted(ids), dtype=np.int64)))
                    entry = (payload, 0)
        with self._cache_lock:
            inputs = self._inputs.get(key)
        umap_state = self._umap_state(key, inputs, retry=refresh)
        return self._render(entry[0], umap_state, cached, map_handle(key))

    def points(self, space: str, selection_token=None, **kwargs) -> Dict[str, Any]:
        """Dict form of :meth:`points_json` (tests and in-process callers)."""
        return json.loads(self.points_json(space, selection_token, **kwargs))

    def layout_status(
        self,
        space: str,
        selection_token: Optional[str] = None,
        *,
        model_path: Optional[str] = None,
    ) -> Dict[str, Any]:
        """The UMAP job state of this map without computing the PCA map.

        Before ``points`` ran for the map (in this process or an earlier one
        whose layout is on disk) the state is ``not_started``.
        """
        normalized, _model_version, _ids, key = self._map_key(
            space, selection_token, model_path
        )
        with self._cache_lock:
            inputs = self._inputs.get(key)
        state = self._umap_state(key, inputs, retry=False)
        state.pop("_layout", None)
        state.pop("_layout_key", None)
        return {
            "space": normalized,
            "method": "umap" if state["status"] == "ready" else STYLE_MAP_METHOD,
            "umap": state,
        }

    # --------------------------------------------------------------- regions
    def regions_json(
        self,
        space: str,
        selection_token: Optional[str] = None,
        *,
        refresh: bool = False,
        model_path: Optional[str] = None,
        map_id: Optional[str] = None,
    ) -> bytes:
        """Regions of the map ``points`` last computed for this space and filter
        (or named by ``map_id``, the handle that points answer carried),
        on the coordinates the page shows (UMAP once ready, PCA before). Cached
        per layout key, method and label version (tags / artist predictions
        written later invalidate it), dropped with the layout; one computation
        per map at a time; ``not_started`` until points ran for this map."""
        normalized, key = self._resolve_map(space, selection_token, model_path, map_id)
        entry = self._cache_get(key) if key is not None else None
        with self._cache_lock:
            inputs = self._inputs.get(key)
        if entry is None or inputs is None:
            idle = {"status": "not_started", "space": normalized, "regions": []}
            return json.dumps(idle, separators=(",", ":")).encode("utf-8")
        layout_key = self._layout_key(key)
        ready = None
        if style_map_umap.umap_available():
            ready = self._ready_layout(layout_key, inputs.rep_ids)
        method = "umap" if ready is not None else STYLE_MAP_METHOD
        body, cached = self._regions.get_or_build(
            layout_key,
            method,
            lambda: regions_body(
                entry[0],
                space=normalized,
                method=method,
                xyz=ready[1] if ready is not None else None,
                features=inputs.features,
            ),
            refresh=refresh,
        )
        return body + (b',"cached":true}' if cached else b',"cached":false}')

    def regions(self, space: str, **kwargs) -> Dict:
        """Dict form of :meth:`regions_json` (tests and in-process callers)."""
        return json.loads(self.regions_json(space, **kwargs))

    @staticmethod
    def _with_umap(payload: bytes, umap_state: Dict[str, Any], tail: bytes) -> bytes:
        umap_json = json.dumps(umap_state, separators=(",", ":")).encode("utf-8")
        return payload[:-1] + b',"umap":' + umap_json + tail

    def _render(
        self, payload: bytes, umap_state: Dict[str, Any], cached: bool, map_id: str
    ) -> bytes:
        """The PCA JSON plus the ``umap``, ``map_id`` (the handle colors and
        regions name this map by) and ``cached`` fields; with a ready
        layout the points carry the UMAP coordinates instead.

        The ready body is built once per layout and kept (a 50k map is
        ~1.4 MB of JSON; parsing and dumping it per request is wasted work).
        A layout whose ids do not match the points is never drawn: the map
        falls back to PCA and the layout is forgotten.
        """
        layout = umap_state.pop("_layout", None)
        layout_key = umap_state.pop("_layout_key", None)
        tail = (
            f',"map_id":"{map_id}","cached":{"true" if cached else "false"}}}'.encode()
        )
        if layout is None:
            return self._with_umap(payload, umap_state, tail)
        with self._umap_lock:
            body = self._rendered.get(layout_key)
        if body is not None:
            return body + tail
        ids, xyz = layout
        result = json.loads(payload)
        if len(ids) != len(result["points"]) or any(
            point[0] != image_id
            for point, image_id in zip(result["points"], ids.tolist())
        ):
            logger.warning(
                "Style map: UMAP layout (%d ids) does not match the map (%d points); using PCA",
                len(ids),
                len(result["points"]),
            )
            self._forget_layout(layout_key)
            fallback = {
                name: value
                for name, value in umap_state.items()
                if name not in ("source", "elapsed_s")
            }
            fallback["status"] = "not_started"
            return self._with_umap(payload, fallback, tail)
        rounded = np.round(xyz.astype(np.float64), POINT_DECIMALS).tolist()
        result["method"] = "umap"
        result["points"] = [
            [point[0], x, y, z, point[4]]
            for point, (x, y, z) in zip(result["points"], rounded)
        ]
        result["umap"] = umap_state
        body = json.dumps(result, separators=(",", ":")).encode("utf-8")[:-1]
        with self._umap_lock:
            self._rendered[layout_key] = body
        return body + tail

    # ------------------------------------------------------------------ umap
    @staticmethod
    def _layout_key(key: tuple) -> tuple:
        """The map's cache key plus the fit parameters and the rules that
        picked the representatives (so a rule change never reuses a layout)."""
        params = umap_params()
        rules = map_rules()
        return key + (
            ("umap",) + tuple(params[name] for name in sorted(params)),
            ("map",) + tuple(rules[name] for name in sorted(rules)),
        )

    def _umap_state(
        self, key: tuple, inputs: Optional[_MapInputs], *, retry: bool
    ) -> Dict[str, Any]:
        """The ``umap`` field of a response; queues a fit when one is due.

        ``_layout`` (ids and xyz in point order) and ``_layout_key``, both
        stripped by the callers, carry a ready layout so ``_render`` does
        not look it up twice.
        """
        n_reps = int(len(inputs.rep_ids)) if inputs is not None else 0
        state: Dict[str, Any] = {
            "status": "not_started",
            "points": n_reps,
            "min_points": UMAP_MIN_POINTS,
            "params": umap_params(),
        }
        # Through the module so the probe can be swapped (tests, Prepare).
        if not style_map_umap.umap_available():
            state["status"] = "unavailable"
            state["install"] = {
                "model_id": UMAP_INSTALL_MODEL_ID,
                "packages": list(OPTIONAL_DEPENDENCY_GROUPS["umap"]),
            }
            return state
        layout_key = self._layout_key(key)
        ready = self._ready_layout(
            layout_key, inputs.rep_ids if inputs is not None else None
        )
        if ready is not None:
            ids, xyz, source, elapsed = ready
            state.update(
                status="ready",
                source=source,
                elapsed_s=round(elapsed, 3),
                _layout=(ids, xyz),
                _layout_key=layout_key,
            )
            return state
        with self._umap_lock:
            job = self._umap_jobs.get(layout_key)
            if job is not None and job.status in ("queued", "computing"):
                if not self._umap_running:
                    self._ensure_worker()  # self-heal: a worker died with work left
                state["status"] = job.status
                state["queued_at"] = job.queued_at
                if job.started_at:
                    state["started_at"] = job.started_at
                return state
            if job is not None and job.status == "failed" and not retry:
                state.update(status="failed", error=job.error)
                return state
            if inputs is None:
                return state  # not_started: no PCA map of this filter yet
            if n_reps < UMAP_MIN_POINTS:
                state["status"] = "too_few_points"
                return state
            job = _LayoutJob(layout_key, inputs.rep_ids, inputs.features)
            self._umap_jobs[layout_key] = job
            self._umap_jobs.move_to_end(layout_key)  # a retried key is newest again
            self._umap_queue.append(layout_key)
            self._trim_jobs()
            self._ensure_worker()
            state["status"] = "queued"
            state["queued_at"] = job.queued_at
        return state

    def _trim_jobs(self) -> None:
        """Forget the oldest queued maps beyond the queue limit and the
        oldest finished records beyond the history (caller holds ``_umap_lock``).

        A queued or computing job is never evicted from the records: the
        worker looks its record up by key when it starts on it.
        """
        while len(self._umap_queue) > _QUEUE_LIMIT:
            dropped = self._umap_queue.popleft()
            self._umap_jobs.pop(dropped, None)  # back to not_started
        finished = [
            key
            for key, job in self._umap_jobs.items()
            if job.status in ("ready", "failed")
        ]
        for key in finished[: max(0, len(self._umap_jobs) - _JOB_HISTORY)]:
            self._umap_jobs.pop(key, None)

    def _ready_layout(
        self, layout_key: tuple, rep_ids: Optional[np.ndarray]
    ) -> Optional[tuple[np.ndarray, np.ndarray, str, float]]:
        """(ids, xyz, source, elapsed_s) from memory or disk; None when there
        is none. With ``rep_ids`` (the map's representatives) the layout must
        cover exactly those ids, wherever it came from; a mismatch is
        forgotten, memory and disk, so it cannot be drawn later either."""
        with self._umap_lock:
            hit = self._layouts.get(layout_key)
            if hit is not None:
                self._layouts.move_to_end(layout_key)
        if hit is None:
            loaded = style_map_umap.load_layout(layout_key)
            if loaded is None:
                return None
            ids, xyz, elapsed = loaded
            hit = self._remember_layout(layout_key, ids, xyz, "disk", elapsed)
        if rep_ids is not None and not np.array_equal(hit[0], rep_ids):
            logger.warning(
                "Style map: cached UMAP layout (%d ids) does not match the map (%d); dropping it",
                len(hit[0]),
                len(rep_ids),
            )
            self._forget_layout(layout_key)
            return None
        return hit

    def _remember_layout(
        self,
        layout_key: tuple,
        ids: np.ndarray,
        xyz: np.ndarray,
        source: str,
        elapsed: float,
    ) -> tuple[np.ndarray, np.ndarray, str, float]:
        with self._umap_lock:
            self._layouts[layout_key] = (ids, xyz, source, elapsed)
            self._layouts.move_to_end(layout_key)
            self._rendered.pop(layout_key, None)
            self._regions.drop(layout_key)
            while len(self._layouts) > _LAYOUT_MEMORY_ENTRIES:
                evicted, _layout = self._layouts.popitem(last=False)
                self._rendered.pop(evicted, None)
                self._regions.drop(evicted)
            return self._layouts[layout_key]

    def _forget_layout(self, layout_key: tuple) -> None:
        with self._umap_lock:
            self._layouts.pop(layout_key, None)
            self._rendered.pop(layout_key, None)
            self._regions.drop(layout_key)
        style_map_umap.discard_layout(layout_key)

    def _ensure_worker(self) -> None:
        """Start the single worker unless one is draining the queue (caller holds ``_umap_lock``)."""
        if self._umap_running:
            return
        self._umap_running = True
        self._umap_thread = threading.Thread(
            target=self._umap_worker, name="style-map-umap", daemon=True
        )
        self._umap_thread.start()

    def _umap_worker(self) -> None:
        """Drain the queue one fit at a time. Whatever happens, the running
        flag is cleared on exit so the next request can start a worker."""
        exited_cleanly = False
        try:
            while True:
                with self._umap_lock:
                    if not self._umap_queue:
                        # Cleared in the same locked section that saw the
                        # empty queue: a map queued between "queue empty"
                        # and the flag going down would find running still
                        # True, start no worker and wait forever.
                        self._umap_running = False
                        exited_cleanly = True
                        return
                    layout_key = self._umap_queue.popleft()
                    job = self._umap_jobs.get(layout_key)
                    if job is None:
                        continue  # forgotten meanwhile
                    job.status = "computing"
                    job.started_at = time.time()
                self._run_job(layout_key, job)
        finally:
            # After a clean return the flag may already belong to a newer
            # worker started in the gap, so only an exception exit touches
            # it: lower it and hand any waiting maps to a fresh worker.
            if not exited_cleanly:
                with self._umap_lock:
                    self._umap_running = False
                    if self._umap_queue:
                        self._ensure_worker()

    def _run_job(self, layout_key: tuple, job: _LayoutJob) -> None:
        started = time.perf_counter()
        try:
            if job.features is None:
                raise RuntimeError("layout inputs were dropped")
            xyz = fit_umap_layout(job.features)
            elapsed = time.perf_counter() - started
            style_map_umap.store_layout(layout_key, job.rep_ids, xyz, elapsed)
            self._remember_layout(layout_key, job.rep_ids, xyz, "memory", elapsed)
            with self._umap_lock:
                job.status = "ready"
                job.finished_at = time.time()
            logger.info(
                "Style map: UMAP layout of %d points ready in %.1f s",
                len(job.rep_ids),
                elapsed,
            )
        except Exception as exc:  # the job must report, not die silently
            logger.exception("Style map: UMAP layout failed")
            with self._umap_lock:
                job.status = "failed"
                job.error = f"{type(exc).__name__}: {exc}"
                job.finished_at = time.time()
        finally:
            job.features = None

    # --------------------------------------------------------------- compute
    def _filtered_ids(self, contract: Dict[str, Any]) -> List[int]:
        ids: List[int] = []
        for chunk in db.iter_filtered_image_id_chunks(
            chunk_size=_ID_PAGE,
            sort_by="newest",
            **selection_contract_db_filters(contract),
        ):
            ids.extend(int(value) for value in chunk)
        return ids

    def _load_vectors(
        self, space: str, model_version: str, ids: List[int]
    ) -> tuple[np.ndarray, np.ndarray]:
        """(vector_ids, matrix) for the ids that have a usable vector, id order.

        The raw blobs are collected first (about 4 KB each), sorted by id and
        decoded straight into one preallocated float32 matrix, so a 50k
        library costs one 400 MB matrix plus the transient blobs, not a list
        of arrays plus stack, normalise and sort copies.
        """
        blobs: List[tuple[int, Any]] = []
        with db.get_db() as conn:
            for start in range(0, len(ids), _ID_CHUNK):
                chunk = ids[start : start + _ID_CHUNK]
                placeholders = ",".join("?" * len(chunk))
                if space == "clip":
                    cursor = conn.execute(
                        f"SELECT id, embedding FROM images "
                        f"WHERE embedding IS NOT NULL AND id IN ({placeholders})",
                        chunk,
                    )
                    blobs.extend((int(row[0]), (row[1], None, None)) for row in cursor)
                else:
                    cursor = conn.execute(
                        f"SELECT image_id, dim, dtype, vector FROM image_style_vectors "
                        f"WHERE space = 'kaloscope' AND model_version = ? AND image_id IN ({placeholders})",
                        [model_version, *chunk],
                    )
                    blobs.extend(
                        (int(row[0]), (row[3], int(row[1]), str(row[2])))
                        for row in cursor
                    )
        if not blobs:
            return np.zeros(0, dtype=np.int64), np.zeros((0, 0), dtype=np.float32)
        blobs.sort(key=lambda item: item[0])

        def decode(payload) -> np.ndarray:
            raw, dim, dtype = payload
            if dim is None:
                return bytes_to_embedding(raw)
            return unpack_style_vector(raw, dim, dtype)

        width = int(decode(blobs[0][1]).size)
        matrix = np.empty((len(blobs), width), dtype=np.float32)
        found_ids: List[int] = []
        filled = 0
        for image_id, payload in blobs:
            vector = np.asarray(decode(payload), dtype=np.float32).reshape(-1)
            if vector.size != width or not np.all(np.isfinite(vector)):
                logger.warning(
                    "Style map: image %s vector unusable (%d dims, expected %d)",
                    image_id,
                    vector.size,
                    width,
                )
                continue
            matrix[filled] = vector
            found_ids.append(image_id)
            filled += 1
        del blobs
        matrix = matrix[:filled]
        norms = np.linalg.norm(matrix, axis=1, keepdims=True)
        matrix /= np.maximum(norms, 1e-8)
        # blobs were sorted by id, so matrix rows are already in id order.
        return np.asarray(found_ids, dtype=np.int64), matrix

    @staticmethod
    def _empty_inputs() -> _MapInputs:
        return _MapInputs(
            np.zeros(0, dtype=np.int64), np.zeros((0, UMAP_INPUT_DIM), dtype=np.float16)
        )

    def _compute(
        self, space: str, model_version: str, ids: List[int]
    ) -> tuple[Dict[str, Any], _MapInputs]:
        """The PCA response and the UMAP inputs (representatives' projection)."""
        timings: Dict[str, Any] = {}
        t0 = time.perf_counter()
        base = {
            "space": space,
            "method": STYLE_MAP_METHOD,
            "model_version": model_version,
            "total_images": len(ids),
            "missing_vectors": len(ids),
            "unlocatable": [],
            "merged_away": 0,
            "explained_variance": [0.0, 0.0, 0.0],
            "points_layout": list(POINTS_LAYOUT),
            "points": [],
        }
        if not ids:
            return {**base, "status": "empty"}, self._empty_inputs()
        vector_ids, matrix = self._load_vectors(space, model_version, ids)
        timings["read_s"] = round(time.perf_counter() - t0, 3)
        base["missing_vectors"] = len(ids) - len(vector_ids)
        if len(vector_ids) == 0:
            return {**base, "status": "no_vectors"}, self._empty_inputs()

        unlocatable = find_unlocatable(matrix)
        base["unlocatable"] = [int(value) for value in vector_ids[unlocatable]]
        if unlocatable.any():
            keep_ids = vector_ids[~unlocatable]
            keep = matrix[~unlocatable]
        else:
            keep_ids, keep = vector_ids, matrix  # nothing to drop: no copy
        del matrix
        if len(keep_ids) == 0:
            return {**base, "status": "no_vectors"}, self._empty_inputs()

        # One covariance + eigh for both the candidate search and the layout.
        t1 = time.perf_counter()
        n, d = keep.shape
        comps, eig, total = _top_components(keep, min(max(_CANDIDATE_DIM, 3), d, n))
        timings["pca_fit_s"] = round(time.perf_counter() - t1, 3)

        t2 = time.perf_counter()
        merge_stats: Dict[str, Any] = {}
        rep_ids, rep_rows, members = merge_near_duplicates(
            keep_ids, keep, components=comps, stats=merge_stats
        )
        timings["merge_s"] = round(time.perf_counter() - t2, 3)
        timings.update(merge_stats)

        t3 = time.perf_counter()
        reps = keep[rep_rows]
        mean = keep.mean(axis=0)
        del keep
        xyz, explained = pca_layout(
            reps, components=comps, eigenvalues=eig, total_variance=total
        )
        # UMAP's input: the representatives on the first UMAP_INPUT_DIM axes
        # (no centred copy of reps; the mean is subtracted after projecting).
        axes = comps[: min(UMAP_INPUT_DIM, len(comps))]
        features = (reps @ axes.T - mean @ axes.T).astype(np.float16)
        del reps
        timings["layout_s"] = round(time.perf_counter() - t3, 3)
        xyz = np.round(xyz.astype(np.float64), POINT_DECIMALS)
        points = [
            [int(image_id), float(x), float(y), float(z), int(count)]
            for image_id, (x, y, z), count in zip(
                rep_ids.tolist(), xyz.tolist(), members.tolist()
            )
        ]
        timings["total_s"] = round(time.perf_counter() - t0, 3)
        timings["points"] = len(points)
        self.last_stats = timings
        logger.info(
            "Style map (%s): %d ids, %d points, %s",
            space,
            len(ids),
            len(points),
            timings,
        )
        result = {
            **base,
            "status": "ok",
            "merged_away": int(len(keep_ids) - len(rep_ids)),
            "explained_variance": explained,
            "points": points,
        }
        return result, _MapInputs(np.asarray(rep_ids, dtype=np.int64), features)
