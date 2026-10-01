"""Style map: drop a picture, find the nearest ones (slice S4c).

``POST /api/style-map/query`` ranks the library against one uploaded picture
and answers in the coordinates of the map the page shows:

- ``kaloscope`` space: the Kaloscope style vector of the picture (same model,
  singleton and runtime lane as the style index, interactive priority) is
  compared by cosine with every stored style vector of the library.
- ``csd`` space: the CSD style vector of the picture (the style index's shared
  encoder, interactive priority), compared the same way.
- ``clip`` space: the Similar page's own upload search
  (``SimilarityIndex.search_by_upload``), so both pages rank the same way.

The layout is never recomputed (UMAP keeps no reducer and the PCA components
are not cached): the query point sits at the similarity-weighted centre of its
three nearest neighbours that are on the map. A neighbour outside the current
Gallery filter is still listed, flagged ``in_filter: false`` and without
coordinates. The upload is read into memory, size-capped and decoded as a
picture; it is never written to disk or to the library.
"""

from __future__ import annotations

import json
import logging
import threading
from collections import OrderedDict
from typing import Any, Dict, List, Optional, Sequence, Tuple

import numpy as np
from fastapi import HTTPException
from PIL import Image, UnidentifiedImageError

import database as db
from exceptions import ServiceError, ValidationError
from library_context import get_current_library_id
from services.style_map_members import owners

logger = logging.getLogger(__name__)

MAX_UPLOAD_BYTES = 50 * 1024 * 1024  # same ceiling as the Similar page upload
DEFAULT_K = 20
MAX_K = 100
CENTRE_NEIGHBOURS = 3
SCORE_DECIMALS = 4
COORD_DECIMALS = 3
# Below this cosine a neighbour is "far away": drawn grey and dashed. The
# Kaloscope value is empirical, from ONE 529 picture library: re-check it on
# a large (about 27k) library before trusting it there. CLIP uses
# the Similar page's 0.5. Kaloscope cosines run lower (random pairs of a 529
# picture library: median 0.11, 95th percentile 0.318; the best other picture
# of a library picture: 5th percentile 0.311), so 0.32 is "no better than
# chance"; measured with the real model, a screenshot, a photo or a CG query
# tops out at 0.34 while the second-best match of a library picture was
# 0.43-0.71.
# CSD (S5, real model, 300 random pictures of the owner's reference library):
# random pairs have median 0.64 (the library is full of same-series batches;
# an earlier stratified 500-picture sample had mean 0.46), the best other
# picture of a library picture has 5th percentile 0.69, and 30 photos and
# wallpapers (out-of-distribution queries) top out at 0.42, so 0.65 marks
# "no closer than an average pair" and flags 3% of true neighbours.
WEAK_THRESHOLDS = {"clip": 0.5, "kaloscope": 0.32, "csd": 0.65}
_MATRIX_ENTRIES = 2
_MATRIX_CHUNK = 4096
_PLACED = Tuple[float, Tuple[float, float, float]]


# ------------------------------------------------------------------ pure
def rank_by_cosine(
    query: np.ndarray, ids: np.ndarray, matrix: np.ndarray, k: int
) -> List[Tuple[int, float]]:
    """The ``k`` best (id, cosine) pairs, best first, equal scores by id.

    ``matrix`` rows are unit vectors (any float dtype; converted in chunks, so
    a float16 library matrix never needs a float32 copy); the query is
    normalised here."""
    if len(ids) == 0 or matrix.size == 0:
        return []
    vector = np.asarray(query, dtype=np.float32).reshape(-1)
    norm = float(np.linalg.norm(vector))
    if not np.isfinite(norm) or norm <= 0.0:
        raise ValidationError("The picture has no usable style vector", field="file")
    vector = vector / norm
    scores = np.empty(len(ids), dtype=np.float32)
    for start in range(0, len(ids), _MATRIX_CHUNK):
        block = matrix[start : start + _MATRIX_CHUNK].astype(np.float32, copy=False)
        scores[start : start + _MATRIX_CHUNK] = block @ vector
    rounded = np.round(scores, SCORE_DECIMALS)
    order = np.lexsort((ids, -rounded))[: max(1, int(k))]
    return [(int(ids[i]), float(rounded[i])) for i in order]


def weighted_centre(
    placed: Sequence[_PLACED],
) -> Optional[Tuple[float, float, float]]:
    """Similarity-weighted mean position of the first ``CENTRE_NEIGHBOURS``
    (score, (x, y, z)) pairs (best first). No weight above zero: plain mean;
    nothing placed: None."""
    chosen = list(placed)[:CENTRE_NEIGHBOURS]
    if not chosen:
        return None
    weights = np.array([max(float(score), 0.0) for score, _xyz in chosen])
    if weights.sum() <= 0.0:
        weights = np.ones(len(chosen))
    positions = np.array([xyz for _score, xyz in chosen], dtype=np.float64)
    centre = (weights[:, None] * positions).sum(axis=0) / weights.sum()
    return float(centre[0]), float(centre[1]), float(centre[2])


def build_answer(
    ranked: Sequence[Tuple[int, float]],
    coords: Dict[int, Tuple[float, float, float]],
    *,
    filenames: Dict[int, str],
    weak_threshold: float,
    model_version: Optional[str],
    merged: Optional[set] = None,
    unlocated: Optional[set] = None,
) -> Dict[str, Any]:
    """The response body for ranked (id, score) pairs on a map whose point
    coordinates are ``coords`` (ids missing from it are not in the filter).
    ``merged`` are the ids that are not points themselves but were merged into
    one: ``coords`` holds their representative's position. ``unlocated`` are
    pictures in the filter that have no dot (``in_filter`` true, ``located``
    false, no coordinates)."""
    merged = merged or set()
    unlocated = unlocated or set()
    neighbours: List[Dict[str, Any]] = []
    placed: List[_PLACED] = []
    for image_id, score in ranked:
        xyz = coords.get(image_id)
        if xyz is not None:
            placed.append((score, xyz))
        neighbours.append(
            {
                "id": int(image_id),
                "score": float(score),
                "x": xyz[0] if xyz else None,
                "y": xyz[1] if xyz else None,
                "z": xyz[2] if xyz else None,
                "weak": bool(score < weak_threshold),
                "in_filter": xyz is not None or image_id in unlocated,
                "located": xyz is not None,
                "merged": image_id in merged,
                "filename": filenames.get(image_id, ""),
            }
        )
    centre = weighted_centre(placed)
    query = (
        None
        if centre is None
        else {axis: round(value, COORD_DECIMALS) for axis, value in zip("xyz", centre)}
    )
    return {
        "status": "ok",
        "query": query,
        "neighbors": neighbours,
        "weak_threshold": weak_threshold,
        "model_version": model_version,
    }


def not_started_answer(space: str) -> Dict[str, Any]:
    """The map is not in this process (evicted, restarted, other library):
    nothing was computed and no model was run."""
    return {
        "status": "not_started",
        "space": space,
        "query": None,
        "neighbors": [],
        "weak_threshold": WEAK_THRESHOLDS.get(space),
        "model_version": None,
    }


def decode_upload_image(data: bytes) -> Image.Image:
    """The upload as an RGB picture; anything PIL cannot decode is a 400."""
    import io

    try:
        with Image.open(io.BytesIO(data)) as source:
            return source.convert("RGB")
    except (
        UnidentifiedImageError,
        OSError,
        ValueError,
        Image.DecompressionBombError,
    ) as exc:
        raise ValidationError("The file is not a readable image", field="file") from exc


async def read_capped_upload(file: Any, limit: Optional[int] = None) -> bytes:
    """The upload's bytes, refused with 413 past the cap and 400 when empty."""
    cap = MAX_UPLOAD_BYTES if limit is None else limit
    data = bytearray()
    try:
        while True:
            chunk = await file.read(1024 * 1024)
            if not chunk:
                break
            data.extend(chunk)
            if len(data) > cap:
                raise HTTPException(
                    status_code=413,
                    detail=f"File too large (max {cap // (1024 * 1024) or 1} MB)",
                )
    finally:
        await file.close()
    if not data:
        raise HTTPException(status_code=400, detail="Empty file uploaded")
    return bytes(data)


# ----------------------------------------------------------------- models
def kaloscope_query_vector(
    image: Image.Image,
    *,
    model_source: str = "huggingface",
    model_path: Optional[str] = None,
    use_gpu: Optional[bool] = None,
) -> np.ndarray:
    """The Kaloscope style vector of one picture, through the style index's own
    model load (singleton, capability check) at interactive priority. A busy
    runtime raises AiRuntimeBusyError (409 for the page)."""
    from ai_runtime_guard import PRIORITY_INTERACTIVE
    from services.style_vector_service import StyleVectorService

    try:
        identifier = StyleVectorService()._load_identifier(
            use_gpu=use_gpu, model_source=model_source, model_path=model_path
        )
    except ServiceError as exc:
        # Not prepared / not Kaloscope: the user can fix it in Model Setup,
        # which is a precondition (503 with the explaining sentence), not a
        # server fault.
        raise HTTPException(status_code=503, detail=exc.message) from exc
    vector = np.asarray(
        identifier._run_kaloscope_style_vector(image, PRIORITY_INTERACTIVE),
        dtype=np.float32,
    ).reshape(-1)
    if vector.size == 0 or not np.all(np.isfinite(vector)):
        raise ServiceError("The model returned no usable style vector")
    return vector


def csd_query_vector(
    image: Image.Image, *, use_gpu: Optional[bool] = None, **_unused: Any
) -> np.ndarray:
    """The CSD style vector of one picture, through the style index's own model
    load (shared encoder) at interactive priority. A model that is not
    prepared is a precondition the user can fix in the Model Center (503); a
    busy runtime raises AiRuntimeBusyError (409 for the page)."""
    from ai_runtime_guard import PRIORITY_INTERACTIVE
    from services.style_vector_service import StyleVectorService

    try:
        encoder = StyleVectorService()._load_identifier(
            use_gpu=use_gpu, model_source="huggingface", model_path=None, space="csd"
        )
    except ServiceError as exc:
        raise HTTPException(status_code=503, detail=exc.message) from exc
    ((vector, _none),) = encoder.extract_style_vectors_and_identifications(
        [("query", image)], priority=PRIORITY_INTERACTIVE
    )
    return np.asarray(vector, dtype=np.float32).reshape(-1)


def clip_ranked(image_bytes: bytes, k: int) -> List[Tuple[int, float]]:
    """Whole-library ranking by the Similar page's upload search (no
    threshold: weakness is flagged, not filtered)."""
    from similarity import get_similarity_index
    from similarity_errors import SimilarityInvalidImageError

    try:
        found = get_similarity_index(db).search_by_upload(image_bytes, k, 0.0, 0, None)
    except SimilarityInvalidImageError as exc:
        raise ValidationError("The file is not a readable image", field="file") from exc
    return [(int(item["id"]), float(item["similarity"])) for item in found["results"]]


# ------------------------------------------------------------------ service
def _filenames(ids: Sequence[int]) -> Dict[int, str]:
    if not ids:
        return {}
    marks = ",".join("?" * len(ids))
    with db.get_db() as conn:
        rows = conn.execute(
            f"SELECT id, filename FROM images WHERE id IN ({marks})",
            [int(value) for value in ids],
        ).fetchall()
    return {int(row[0]): str(row[1] or "") for row in rows}


class _MatrixCache:
    """Normalised library style vectors per (library, space, weights, data
    version) as float16, newest ``_MATRIX_ENTRIES`` kept (a 50k library is
    about 200 MB each)."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.entries: "OrderedDict[tuple, Tuple[np.ndarray, np.ndarray]]" = (
            OrderedDict()
        )


_CACHE_INIT_LOCK = threading.Lock()


class StyleMapQueryMixin:
    """``query_neighbors_json`` of StyleMapService. Uses the service's map
    handle registry, points cache, layout memory and vector loader, so the
    answer is in the coordinates of the exact map the page shows."""

    def _matrix_cache(self) -> _MatrixCache:
        cache = self.__dict__.get("_query_matrices")
        if cache is None:
            with _CACHE_INIT_LOCK:
                cache = self.__dict__.setdefault("_query_matrices", _MatrixCache())
        return cache

    def _library_matrix(
        self, space: str, model_version: str
    ) -> Tuple[np.ndarray, np.ndarray]:
        """(ids, float16 unit-vector matrix) of the whole current library."""
        cache = self._matrix_cache()
        key = (
            get_current_library_id(),
            space,
            model_version,
            self._vector_version(space, model_version),
        )
        with cache.lock:
            hit = cache.entries.get(key)
            if hit is not None:
                cache.entries.move_to_end(key)
                return hit
            ids, matrix = self._load_vectors(
                space, model_version, self._filtered_ids({})
            )
            built = (ids, matrix.astype(np.float16))
            del matrix
            cache.entries[key] = built
            while len(cache.entries) > _MATRIX_ENTRIES:
                cache.entries.popitem(last=False)
            return built

    def _displayed_coords(
        self, key: tuple, payload: bytes
    ) -> Dict[int, Tuple[float, float, float]]:
        """id -> (x, y, z) of the map's points on the coordinates the page
        shows: the ready UMAP layout, else the cached PCA ones."""
        from services import style_map_umap

        with self._cache_lock:
            inputs = self._inputs.get(key)
        points = json.loads(payload).get("points") or []
        if inputs is not None and style_map_umap.umap_available():
            ready = self._ready_layout(self._layout_key(key), inputs.rep_ids)
            if ready is not None:
                rounded = np.round(ready[1].astype(np.float64), 3).tolist()
                return {
                    int(image_id): (x, y, z)
                    for image_id, (x, y, z) in zip(ready[0].tolist(), rounded)
                }
        return {int(p[0]): (float(p[1]), float(p[2]), float(p[3])) for p in points}

    def _place_members(
        self,
        key: tuple,
        ranked: Sequence[Tuple[int, float]],
        coords: Dict[int, Tuple[float, float, float]],
    ) -> Tuple[Dict[int, Tuple[float, float, float]], set, set]:
        """``coords`` plus the neighbours that were merged into a
        representative (placed at its dot, from the map's group table), their
        ids, and the ids that are in the filter but have no dot at all (no
        usable vector). A picture outside the filter is none of these."""
        with self._cache_lock:
            inputs = self._inputs.get(key)
        loose = [i for i, _score in ranked if i not in coords]
        if inputs is None or inputs.member_ids is None or not loose or not coords:
            return coords, set(), set()
        owner = owners(inputs.rep_ids, inputs.member_ids, inputs.member_offsets, loose)
        placed = {**coords, **{m: coords[rep] for m, rep in owner.items() if rep in coords}}
        rest = [i for i in loose if i not in placed]
        unlocated = set()
        if rest and inputs.filter_ids is not None:
            inside = np.isin(np.asarray(rest, dtype=np.int64), inputs.filter_ids)
            unlocated = {int(i) for i, flag in zip(rest, inside.tolist()) if flag}
        return placed, set(owner), unlocated

    def _rank_for(
        self,
        space: str,
        image_bytes: bytes,
        model_version: str,
        k: int,
        model_settings: Dict[str, Any],
    ) -> List[Tuple[int, float]]:
        if space == "clip":
            return clip_ranked(image_bytes, k)
        image = decode_upload_image(image_bytes)
        query_vector = (
            csd_query_vector if space == "csd" else kaloscope_query_vector
        )
        vector = query_vector(image, **model_settings)
        ids, matrix = self._library_matrix(space, model_version)
        return rank_by_cosine(vector, ids, matrix, k)

    def query_neighbors_json(
        self,
        space: str,
        image_bytes: bytes,
        *,
        selection_token: Optional[str] = None,
        map_id: Optional[str] = None,
        k: int = DEFAULT_K,
        model_path: Optional[str] = None,
        model_source: str = "huggingface",
        use_gpu: Optional[bool] = None,
    ) -> bytes:
        """The ``k`` library pictures nearest to the uploaded one, placed on
        the map ``points`` last computed for this space and filter (or named
        by ``map_id``). ``not_started`` (and no model run) when that map is
        not cached in this process or belongs to another library."""
        normalized, key = self._resolve_map(space, selection_token, model_path, map_id)
        entry = self._cache_get(key) if key is not None else None
        if entry is None:
            return json.dumps(not_started_answer(normalized)).encode("utf-8")
        ranked = self._rank_for(
            normalized,
            image_bytes,
            key[2],
            k,
            {
                "model_source": model_source,
                "model_path": model_path,
                "use_gpu": use_gpu,
            },
        )
        coords, merged, unlocated = self._place_members(
            key, ranked, self._displayed_coords(key, entry[0])
        )
        body = build_answer(
            ranked,
            coords,
            filenames=_filenames([image_id for image_id, _ in ranked]),
            weak_threshold=WEAK_THRESHOLDS[normalized],
            model_version=key[2],
            merged=merged,
            unlocated=unlocated,
        )
        return json.dumps(body, separators=(",", ":")).encode("utf-8")
