"""Unit tests for services.style_vector_service (style map slice S1).

No real Kaloscope is loaded: a fake identifier returns deterministic 2048-d
vectors, and the refusal paths use a real ArtistIdentifier whose model slot is
stubbed. The service is driven synchronously by running the FastAPI
BackgroundTasks it schedules.
"""

from __future__ import annotations

import hashlib
import threading
import time

import numpy as np
import pytest
from fastapi import BackgroundTasks
from PIL import Image

import artist_identifier as ai
from exceptions import OperationInProgressError, ValidationError
from image_fingerprint import compute_image_content_fingerprint


DIM = 2048
CANONICAL_VERSION = ai.kaloscope_style_vector_model_version(None)


def _vector_for(path: str, seed: str = "") -> np.ndarray:
    digest = hashlib.sha256((path + seed).encode("utf-8")).digest()
    rng = np.random.default_rng(int.from_bytes(digest[:8], "little"))
    vector = rng.normal(size=DIM).astype(np.float32)
    # A few Kaloscope BN dims explode far beyond float16 range; the store must cope.
    vector[5] = 2.4e8
    vector[6] = -6.0e7
    return vector


class FakeIdentifier:
    """Stand-in for a loaded Kaloscope ArtistIdentifier: the style-vector surface only."""

    def __init__(self, *, fail_on: str = "", on_call=None):
        self.fail_on = fail_on
        self.on_call = on_call
        self.calls: list[str] = []
        self.batches: list[list[str]] = []
        self.thresholds: list[float] = []
        self.loads = 0

    def load(self):
        self.loads += 1

    model_loaded = True
    load_error = None

    def supports_style_vectors(self):
        return True

    def extract_style_vector(self, image_path: str, priority: int = 0) -> np.ndarray:
        self.calls.append(image_path)
        if self.on_call is not None:
            self.on_call(self, image_path)
        if self.fail_on and self.fail_on in image_path:
            raise RuntimeError("cannot read this one")
        return _vector_for(image_path, "v")

    def identification_for(self, image_path: str, top_k: int, threshold: float) -> dict:
        """What identify_with_threshold would answer for this picture: the
        top-1 score tiered by the real classify_artist_confidence with the
        caller's floor, exactly as ArtistIdentifier._result_from_probs does."""
        self.thresholds.append(float(threshold))
        confidence = 0.42 if "img0" in image_path else 0.01
        level = ai.classify_artist_confidence(confidence, threshold=threshold)
        name = "modare" if level == ai.ARTIST_CONFIDENCE_HIGH else "undefined"
        candidate = "modare" if level != ai.ARTIST_CONFIDENCE_NONE else None
        return {
            "artist": name,
            "confidence": confidence,
            "confidence_level": level,
            "candidate_artist": candidate,
            "out_of_vocabulary_likely": level != ai.ARTIST_CONFIDENCE_HIGH,
            "vocabulary_size": 4,
            "advisory": "",
            "top_predictions": [{"artist": "modare", "confidence": confidence}][:top_k],
            "model_loaded": True,
        }

    def identify_with_threshold(
        self, image_path: str, top_k: int, threshold: float, priority: int = 0
    ) -> dict:
        """The Style Finder's own entrance (ArtistService.run_batch_identification)."""
        return self.identification_for(image_path, top_k, threshold)

    def extract_style_vector_and_identification(
        self,
        image_path: str,
        *,
        top_k: int = 5,
        threshold: float = 0.03,
        priority: int = 0,
    ):
        return self.extract_style_vector(image_path, priority), self.identification_for(
            image_path, top_k, threshold
        )

    def extract_style_vectors_and_identifications(
        self, items, *, top_k: int = 5, threshold: float = 0.03, priority: int = 0
    ):
        """One forward for a batch of (path, decoded image) pairs; a bad
        picture fails the whole batch, exactly like a real forward would."""
        self.batches.append([path for path, _image in items])
        return [
            self.extract_style_vector_and_identification(
                path, top_k=top_k, threshold=threshold, priority=priority
            )
            for path, _image in items
        ]


class NanOnce(FakeIdentifier):
    """One picture gets a non-finite vector (what pack_style_vector refuses)."""

    def _poison(self, path, vector):
        if path.endswith("img2.png"):
            vector = np.array(vector, dtype=np.float32, copy=True)
            vector[0] = np.nan
        return vector

    def extract_style_vectors_and_identifications(self, items, **kwargs):
        answers = super().extract_style_vectors_and_identifications(items, **kwargs)
        return [
            (self._poison(path, vector), raw)
            for (path, _input), (vector, raw) in zip(items, answers)
        ]

    def extract_style_vector_and_identification(self, image_path, **kwargs):
        vector, raw = super().extract_style_vector_and_identification(
            image_path, **kwargs
        )
        return self._poison(image_path, vector), raw


class TensorFakeIdentifier(FakeIdentifier):
    """A Kaloscope-like identifier: the worker transforms pictures for it."""

    def __init__(self):
        super().__init__()
        self.prepared = 0
        self.input_kinds: list[str] = []

    def prepare_style_input(self, image):
        self.prepared += 1
        return np.zeros((3, 4, 4), dtype=np.float32)

    def extract_style_vectors_and_identifications(self, items, **kwargs):
        self.input_kinds.extend(
            type(model_input).__name__ for _path, model_input in items
        )
        return super().extract_style_vectors_and_identifications(items, **kwargs)


def _make_images(test_db, tmp_path, count: int, prefix: str = "img") -> list[int]:
    ids = []
    for index in range(count):
        path = tmp_path / f"{prefix}{index}.png"
        Image.new("RGB", (16, 16), (index * 40 % 255, 20, 200)).save(path)
        ids.append(test_db.add_image(path=str(path), filename=path.name))
    return ids


def _run_scheduled(tasks: BackgroundTasks) -> None:
    for task in tasks.tasks:
        task.func(*task.args, **task.kwargs)


def _service(identifier):
    from services.style_vector_service import StyleVectorService

    return StyleVectorService(identifier_getter=lambda **kwargs: identifier)


def _rows(test_db):
    with test_db.get_db() as conn:
        return {
            int(row["image_id"]): dict(row)
            for row in conn.execute(
                "SELECT image_id, space, model_version, content_fingerprint, dim, dtype, vector "
                "FROM image_style_vectors"
            ).fetchall()
        }


def _fingerprints(test_db) -> list:
    with test_db.get_db() as conn:
        return [
            row[0]
            for row in conn.execute(
                "SELECT content_fingerprint FROM images ORDER BY id"
            )
        ]


class TestPacking:
    def test_float16_round_trip_keeps_cosine(self):
        from db_style_vectors import pack_style_vector, unpack_style_vector

        rng = np.random.default_rng(0)
        worst = 0.0
        for _ in range(50):
            vector = rng.normal(size=DIM).astype(np.float32) * rng.uniform(1e-3, 1e5)
            blob, dim, dtype = pack_style_vector(vector)
            assert (dim, dtype, len(blob)) == (DIM, "float16", DIM * 2)
            unit = vector / np.linalg.norm(vector)
            back = unpack_style_vector(blob, dim, dtype)
            worst = max(worst, abs(1.0 - float(unit @ back / np.linalg.norm(back))))
        assert worst < 1e-3

    def test_exploding_dims_do_not_overflow(self):
        from db_style_vectors import pack_style_vector, unpack_style_vector

        vector = _vector_for("x")
        blob, dim, dtype = pack_style_vector(vector)
        back = unpack_style_vector(blob, dim, dtype)
        assert np.all(np.isfinite(back))
        unit = vector / np.linalg.norm(vector)
        assert float(unit @ back) > 0.999

    @pytest.mark.parametrize(
        "bad", [np.zeros(DIM, np.float32), np.array([1.0, np.nan]), np.array([])]
    )
    def test_rejects_degenerate_vectors(self, bad):
        from db_style_vectors import pack_style_vector

        with pytest.raises(ValueError):
            pack_style_vector(bad)


class TestUpdatedAt:
    def test_upsert_stamps_milliseconds(self, test_db, tmp_path):
        """Second precision let a rewrite inside the same second look unchanged
        to the style map cache; the upsert stamps milliseconds itself."""
        import re

        from db_style_vectors import upsert_style_vector

        (image_id,) = _make_images(test_db, tmp_path, 1)
        with test_db.get_db() as conn:
            conn.execute(
                "UPDATE images SET content_fingerprint = 'A' WHERE id = ?", (image_id,)
            )
        stamps = []
        for seed in ("x", "y"):
            with test_db.get_db() as conn:
                assert upsert_style_vector(
                    conn.cursor(),
                    image_id=image_id,
                    space="kaloscope",
                    model_version="v",
                    content_fingerprint="A",
                    vector=_vector_for(seed),
                )
                stamps.append(
                    conn.execute(
                        "SELECT updated_at FROM image_style_vectors WHERE image_id = ?",
                        (image_id,),
                    ).fetchone()[0]
                )
        for stamp in stamps:
            assert re.fullmatch(r"\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}", stamp), (
                stamp
            )
        assert stamps[1] >= stamps[0]


class TestFingerprintGate:
    def test_upsert_refuses_a_fingerprint_the_scan_does_not_know(
        self, test_db, tmp_path
    ):
        from db_style_vectors import upsert_style_vector

        (image_id,) = _make_images(test_db, tmp_path, 1)
        with test_db.get_db() as conn:
            conn.execute(
                "UPDATE images SET content_fingerprint = 'A' WHERE id = ?", (image_id,)
            )
        with test_db.get_db() as conn:
            stored = upsert_style_vector(
                conn.cursor(),
                image_id=image_id,
                space="kaloscope",
                model_version="v",
                content_fingerprint="B",
                vector=_vector_for("x"),
            )
        assert stored is False
        assert _rows(test_db) == {}

        with test_db.get_db() as conn:
            stored = upsert_style_vector(
                conn.cursor(),
                image_id=image_id,
                space="kaloscope",
                model_version="v",
                content_fingerprint="A",
                vector=_vector_for("x"),
            )
        assert stored is True
        assert _rows(test_db)[image_id]["content_fingerprint"] == "A"

    def test_file_changed_on_disk_before_rescan_is_an_error_not_a_vector(
        self, test_db, tmp_path
    ):
        (image_id,) = _make_images(test_db, tmp_path, 1)
        path = tmp_path / "img0.png"
        scanned = compute_image_content_fingerprint(str(path))
        with test_db.get_db() as conn:
            conn.execute(
                "UPDATE images SET content_fingerprint = ? WHERE id = ?",
                (scanned, image_id),
            )
        # The user edits the picture; no rescan has happened yet.
        Image.new("RGB", (16, 16), (7, 200, 90)).save(path)

        identifier = FakeIdentifier()
        service = _service(identifier)
        tasks = BackgroundTasks()
        assert service.start_extraction(tasks, space="kaloscope")["total"] == 1
        _run_scheduled(tasks)

        progress = service.get_progress()
        assert (progress["processed"], progress["written"], progress["errors"]) == (
            1,
            0,
            1,
        )
        assert identifier.calls == [], (
            "the model must not run on pixels the scan does not know"
        )
        assert _rows(test_db) == {}
        assert _fingerprints(test_db) == [scanned], (
            "the scanned fingerprint is not overwritten"
        )


class TestExtraction:
    def test_writes_one_vector_per_pending_image(self, test_db, tmp_path):
        ids = _make_images(test_db, tmp_path, 3)
        identifier = FakeIdentifier()
        service = _service(identifier)
        tasks = BackgroundTasks()

        started = service.start_extraction(tasks, space="kaloscope")
        assert started["status"] == "started" and started["total"] == 3
        assert service.get_progress()["running"] is True
        _run_scheduled(tasks)

        progress = service.get_progress()
        assert progress["running"] is False
        assert progress["step"] == "done"
        assert (
            progress["processed"],
            progress["written"],
            progress["kept"],
            progress["errors"],
        ) == (3, 3, 0, 0)
        assert identifier.loads == 1
        rows = _rows(test_db)
        assert set(rows) == set(ids)
        from db_style_vectors import unpack_style_vector

        for image_id, row in rows.items():
            assert (row["space"], row["model_version"], row["dim"], row["dtype"]) == (
                "kaloscope",
                CANONICAL_VERSION,
                DIM,
                "float16",
            )
            assert row["content_fingerprint"]
            stored = unpack_style_vector(row["vector"], row["dim"], row["dtype"])
            expected = _vector_for(identifier.calls[ids.index(image_id)], "v")
            expected = expected / np.linalg.norm(expected)
            assert float(stored @ expected) > 0.999
        assert all(_fingerprints(test_db)), "extraction claims the image fingerprint"

    def test_nothing_pending_on_second_run(self, test_db, tmp_path):
        _make_images(test_db, tmp_path, 2)
        service = _service(FakeIdentifier())
        tasks = BackgroundTasks()
        service.start_extraction(tasks, space="kaloscope")
        _run_scheduled(tasks)

        again = service.start_extraction(BackgroundTasks(), space="kaloscope")
        assert again["status"] == "idle" and again["total"] == 0
        assert service.get_progress()["running"] is False

    def test_changed_fingerprint_is_extracted_again(self, test_db, tmp_path):
        ids = _make_images(test_db, tmp_path, 2)
        service = _service(FakeIdentifier())
        tasks = BackgroundTasks()
        service.start_extraction(tasks, space="kaloscope")
        _run_scheduled(tasks)
        old = _rows(test_db)[ids[0]]["content_fingerprint"]

        # New pixels at the same path, then the scan records the new fingerprint.
        changed = tmp_path / "img0.png"
        Image.new("RGB", (16, 16), (250, 250, 5)).save(changed)
        with test_db.get_db() as conn:
            conn.execute(
                "UPDATE images SET content_fingerprint = ? WHERE id = ?",
                (compute_image_content_fingerprint(str(changed)), ids[0]),
            )
        assert service.get_stats("kaloscope")["stale"] == 1

        tasks = BackgroundTasks()
        started = service.start_extraction(tasks, space="kaloscope")
        assert started["total"] == 1
        _run_scheduled(tasks)
        rows = _rows(test_db)
        assert rows[ids[0]]["content_fingerprint"] != old
        assert service.get_progress()["written"] == 1

    def test_forgotten_fingerprint_with_same_pixels_keeps_vector_without_model(
        self, test_db, tmp_path
    ):
        ids = _make_images(test_db, tmp_path, 2)
        identifier = FakeIdentifier()
        service = _service(identifier)
        tasks = BackgroundTasks()
        service.start_extraction(tasks, space="kaloscope")
        _run_scheduled(tasks)
        before = _rows(test_db)[ids[0]]
        identifier.calls.clear()

        # A rescan that could not hash the pixels leaves the fingerprint empty.
        with test_db.get_db() as conn:
            conn.execute(
                "UPDATE images SET content_fingerprint = NULL WHERE id = ?", (ids[0],)
            )
        assert service.get_stats("kaloscope")["stale"] == 1

        tasks = BackgroundTasks()
        started = service.start_extraction(tasks, space="kaloscope")
        assert started["total"] == 1
        _run_scheduled(tasks)

        assert identifier.calls == [], "same pixels: the model is not run again"
        progress = service.get_progress()
        assert (progress["written"], progress["kept"], progress["errors"]) == (0, 1, 0)
        assert progress["step"] == "done"
        assert _rows(test_db)[ids[0]] == before
        assert _fingerprints(test_db)[0] == before["content_fingerprint"]

    def test_other_weights_make_every_image_pending(self, test_db, tmp_path):
        _make_images(test_db, tmp_path, 2)
        weights_a = tmp_path / "a.pth"
        weights_b = tmp_path / "b.pth"
        weights_a.write_bytes(b"weights-a")
        weights_b.write_bytes(b"weights-b")
        service = _service(FakeIdentifier())
        tasks = BackgroundTasks()
        service.start_extraction(
            tasks, space="kaloscope", model_source="local", model_path=str(weights_a)
        )
        _run_scheduled(tasks)
        versions = {row["model_version"] for row in _rows(test_db).values()}
        assert versions == {ai.kaloscope_style_vector_model_version(str(weights_a))}

        started = service.start_extraction(
            BackgroundTasks(),
            space="kaloscope",
            model_source="local",
            model_path=str(weights_b),
        )
        assert started["total"] == 2
        assert service.get_stats("kaloscope", model_path=str(weights_a))["pending"] == 0

    def test_cancel_stops_after_current_batch(self, test_db, tmp_path, monkeypatch):
        """A cancel lands within one batch: the batch in flight finishes,
        the next one never starts (and its prepared pictures are dropped)."""
        from services import style_vector_service as svc_mod

        monkeypatch.setattr(svc_mod, "EXTRACTION_BATCH_SIZE", 4)
        ids = _make_images(test_db, tmp_path, 12)
        holder = {}

        def cancel_on_first(_identifier, _path):
            holder["service"].request_cancel()

        service = _service(FakeIdentifier(on_call=cancel_on_first))
        holder["service"] = service
        tasks = BackgroundTasks()
        service.start_extraction(tasks, space="kaloscope")
        _run_scheduled(tasks)

        progress = service.get_progress()
        assert progress["running"] is False
        assert progress["step"] == "cancelled"
        assert progress["processed"] == 4 and progress["written"] == 4
        assert set(_rows(test_db)) == set(ids[:4])
        assert service.request_cancel() is False, "nothing left to cancel"

    def test_pause_waits_and_resume_continues(self, test_db, tmp_path):
        _make_images(test_db, tmp_path, 3)
        service = _service(FakeIdentifier())
        tasks = BackgroundTasks()
        service.start_extraction(tasks, space="kaloscope")
        assert service.request_pause() is True
        assert service.get_progress()["paused"] is True

        def resume_later():
            time.sleep(0.3)
            assert service.request_resume() is True

        threading.Thread(target=resume_later, daemon=True).start()
        started = time.time()
        _run_scheduled(tasks)
        assert time.time() - started >= 0.25, "the worker must wait while paused"
        progress = service.get_progress()
        assert progress["step"] == "done" and progress["written"] == 3
        assert progress["paused"] is False
        assert service.request_pause() is False

    def test_cancel_while_paused_ends_the_run(self, test_db, tmp_path):
        _make_images(test_db, tmp_path, 2)
        service = _service(FakeIdentifier())
        tasks = BackgroundTasks()
        service.start_extraction(tasks, space="kaloscope")
        service.request_pause()
        threading.Timer(0.2, service.request_cancel).start()
        _run_scheduled(tasks)
        progress = service.get_progress()
        assert progress["step"] == "cancelled" and progress["written"] == 0
        assert _rows(test_db) == {}

    def test_one_bad_image_does_not_stop_the_batch(self, test_db, tmp_path):
        ids = _make_images(test_db, tmp_path, 3)
        service = _service(FakeIdentifier(fail_on="img1.png"))
        tasks = BackgroundTasks()
        service.start_extraction(tasks, space="kaloscope")
        _run_scheduled(tasks)

        progress = service.get_progress()
        assert progress["step"] == "done"
        assert (progress["processed"], progress["written"], progress["errors"]) == (
            3,
            2,
            1,
        )
        assert set(_rows(test_db)) == {ids[0], ids[2]}
        assert any("img1.png" in issue for issue in progress["recent_issues"])

    def test_every_image_failing_is_not_success(self, test_db, tmp_path):
        _make_images(test_db, tmp_path, 3)
        service = _service(FakeIdentifier(fail_on=".png"))
        tasks = BackgroundTasks()
        service.start_extraction(tasks, space="kaloscope")
        _run_scheduled(tasks)

        progress = service.get_progress()
        assert progress["running"] is False
        assert progress["step"] == "error"
        assert (
            progress["processed"],
            progress["written"],
            progress["kept"],
            progress["errors"],
        ) == (3, 0, 0, 3)
        assert _rows(test_db) == {}

    def test_missing_file_counts_as_error_not_crash(self, test_db, tmp_path):
        ids = _make_images(test_db, tmp_path, 2)
        (tmp_path / "img1.png").unlink()
        service = _service(FakeIdentifier())
        tasks = BackgroundTasks()
        service.start_extraction(tasks, space="kaloscope")
        _run_scheduled(tasks)
        progress = service.get_progress()
        assert (progress["written"], progress["errors"]) == (1, 1)
        assert set(_rows(test_db)) == {ids[0]}

    def test_explicit_image_ids_limit_the_run(self, test_db, tmp_path):
        ids = _make_images(test_db, tmp_path, 3)
        service = _service(FakeIdentifier())
        tasks = BackgroundTasks()
        started = service.start_extraction(
            tasks, space="kaloscope", image_ids=[ids[2], 999999]
        )
        assert started["total"] == 1
        _run_scheduled(tasks)
        assert set(_rows(test_db)) == {ids[2]}

    def test_selection_token_limits_the_run_to_the_gallery_filter(
        self, test_db, tmp_path
    ):
        """One token, the same decode path as every other filtered action:
        no id list travels from the browser."""
        from services.image_service import ImageService

        ids = _make_images(test_db, tmp_path, 4)
        with test_db.get_db() as conn:
            conn.execute(
                "UPDATE images SET generator = 'nai' WHERE id IN (?, ?)",
                (ids[1], ids[3]),
            )
        token = ImageService().create_selection_token(generators=["nai"])[
            "selection_token"
        ]
        service = _service(FakeIdentifier())
        tasks = BackgroundTasks()
        started = service.start_extraction(
            tasks, space="kaloscope", selection_token=token
        )
        assert started["total"] == 2
        _run_scheduled(tasks)
        assert set(_rows(test_db)) == {ids[1], ids[3]}

    def test_index_writes_the_artist_prediction_exactly_like_the_finder(
        self, test_db, tmp_path
    ):
        """One forward, two rows: the vector and the same artist_predictions
        row the Style Finder page writes (normalize_identification ->
        write_artist_predictions), so the two entrances never disagree."""
        from services.artist_service import normalize_identification
        from services.derived_state_service import write_artist_predictions

        ids = _make_images(test_db, tmp_path, 2)
        identifier = FakeIdentifier()
        service = _service(identifier)
        tasks = BackgroundTasks()
        service.start_extraction(tasks, space="kaloscope")
        _run_scheduled(tasks)
        with test_db.get_db() as conn:
            rows = {
                int(row[0]): (row[1], row[2], row[3])
                for row in conn.execute(
                    "SELECT image_id, artist, confidence, top_predictions FROM artist_predictions"
                )
            }
        assert set(rows) == set(ids)
        assert rows[ids[0]][0] == "modare" and rows[ids[1]][0] == "undefined"

        # The Finder's own write for the same picture produces the same row.
        raw = identifier.identification_for(str(tmp_path / "img0.png"), 5, 0.03)
        normalized = normalize_identification(raw)
        with test_db.get_db() as conn:
            fingerprint = conn.execute(
                "SELECT content_fingerprint FROM images WHERE id = ?", (ids[0],)
            ).fetchone()[0]
            write_artist_predictions(
                conn.cursor(),
                [
                    {
                        "image_id": ids[0],
                        "artist": normalized["artist"],
                        "confidence": normalized["confidence"],
                        "top_predictions": normalized["top_predictions"],
                        "content_fingerprint": fingerprint,
                    }
                ],
            )
            finder_row = conn.execute(
                "SELECT artist, confidence, top_predictions FROM artist_predictions WHERE image_id = ?",
                (ids[0],),
            ).fetchone()
        assert tuple(finder_row) == rows[ids[0]]

    def test_threshold_reaches_every_prediction(self, test_db, tmp_path, monkeypatch):
        """S1d: the Style Finder page's slider value, not the default floor,
        is what the index tiers each picture with (batched and one-by-one)."""
        from services import style_vector_service as svc_mod

        monkeypatch.setattr(svc_mod, "EXTRACTION_BATCH_SIZE", 2)
        _make_images(test_db, tmp_path, 3)
        identifier = FakeIdentifier()
        service = _service(identifier)
        tasks = BackgroundTasks()
        service.start_extraction(tasks, space="kaloscope", threshold=0.12)
        _run_scheduled(tasks)
        assert service.get_progress()["step"] == "done"
        assert identifier.thresholds == [0.12, 0.12, 0.12]

    def test_default_threshold_is_the_finders_default(self, test_db, tmp_path):
        _make_images(test_db, tmp_path, 1)
        identifier = FakeIdentifier()
        service = _service(identifier)
        tasks = BackgroundTasks()
        service.start_extraction(tasks, space="kaloscope")
        _run_scheduled(tasks)
        assert identifier.thresholds == [ai.ARTIST_THRESHOLD_DEFAULT]

    def test_a_higher_threshold_writes_a_different_row(self, test_db, tmp_path):
        """Above the confident floor the slider decides whether a 0.42 match
        is asserted or stored as undefined: the row must follow the slider,
        or the index silently overwrites what the Finder page would write."""
        ids = _make_images(test_db, tmp_path, 1)
        service = _service(FakeIdentifier())
        tasks = BackgroundTasks()
        service.start_extraction(tasks, space="kaloscope", threshold=0.5)
        _run_scheduled(tasks)
        strict = _prediction_rows(test_db)
        assert strict[ids[0]][0] == "undefined"

        with test_db.get_db() as conn:
            conn.execute("DELETE FROM image_style_vectors")
            conn.execute("DELETE FROM artist_predictions")
        service = _service(FakeIdentifier())
        tasks = BackgroundTasks()
        service.start_extraction(tasks, space="kaloscope")
        _run_scheduled(tasks)
        lenient = _prediction_rows(test_db)
        assert lenient[ids[0]][0] == "modare"
        assert lenient[ids[0]][1:] == strict[ids[0]][1:]

    @pytest.mark.parametrize("threshold", [0.03, 0.12, 0.5])
    def test_index_and_identify_batch_write_the_same_rows_at_one_threshold(
        self, test_db, tmp_path, threshold
    ):
        """The map's index and POST /api/artists/identify-batch, given the
        same threshold, store byte-identical artist_predictions rows."""
        from services.artist_service import ArtistService

        ids = _make_images(test_db, tmp_path, 2)
        index_identifier = FakeIdentifier()
        service = _service(index_identifier)
        tasks = BackgroundTasks()
        service.start_extraction(tasks, space="kaloscope", threshold=threshold)
        _run_scheduled(tasks)
        from_index = _prediction_rows(test_db)
        assert set(from_index) == set(ids)

        with test_db.get_db() as conn:
            conn.execute("DELETE FROM artist_predictions")
        finder_identifier = FakeIdentifier()
        finder = ArtistService(identifier_getter=lambda **kwargs: finder_identifier)
        result = finder.run_batch_identification(
            image_ids=ids, threshold=threshold, top_k=5
        )
        assert result.get("errors", 0) == 0, result
        assert finder_identifier.thresholds == index_identifier.thresholds
        assert _prediction_rows(test_db) == from_index

    def test_with_artist_off_writes_vectors_only(self, test_db, tmp_path):
        ids = _make_images(test_db, tmp_path, 2)
        service = _service(FakeIdentifier())
        tasks = BackgroundTasks()
        service.start_extraction(tasks, space="kaloscope", with_artist=False)
        _run_scheduled(tasks)
        assert set(_rows(test_db)) == set(ids)
        with test_db.get_db() as conn:
            assert (
                conn.execute("SELECT COUNT(*) FROM artist_predictions").fetchone()[0]
                == 0
            )

    def test_identifier_without_the_combined_method_still_indexes(
        self, test_db, tmp_path
    ):
        ids = _make_images(test_db, tmp_path, 1)
        identifier = FakeIdentifier()
        identifier.extract_style_vector_and_identification = None
        identifier.extract_style_vectors_and_identifications = None
        service = _service(identifier)
        tasks = BackgroundTasks()
        service.start_extraction(tasks, space="kaloscope")
        _run_scheduled(tasks)
        assert set(_rows(test_db)) == set(ids)

    def test_selection_token_and_image_ids_are_exclusive(self, test_db, tmp_path):
        ids = _make_images(test_db, tmp_path, 1)
        service = _service(FakeIdentifier())
        with pytest.raises(ValidationError):
            service.start_extraction(
                BackgroundTasks(),
                space="kaloscope",
                image_ids=ids,
                selection_token="tok.abc",
            )
        assert service.get_progress()["running"] is False

    def test_invalid_selection_token_is_a_validation_error(self, test_db):
        service = _service(FakeIdentifier())
        with pytest.raises(ValidationError):
            service.start_extraction(
                BackgroundTasks(), space="kaloscope", selection_token="bad!"
            )
        assert service.get_progress()["running"] is False

    def test_rejects_unknown_space(self, test_db):
        service = _service(FakeIdentifier())
        with pytest.raises(ValidationError):
            service.start_extraction(BackgroundTasks(), space="clip")

    def test_refuses_to_start_twice(self, test_db, tmp_path):
        _make_images(test_db, tmp_path, 1)
        service = _service(FakeIdentifier())
        tasks = BackgroundTasks()
        service.start_extraction(tasks, space="kaloscope")
        with pytest.raises(OperationInProgressError):
            service.start_extraction(BackgroundTasks(), space="kaloscope")
        _run_scheduled(tasks)

    def test_stats_report_coverage(self, test_db, tmp_path):
        _make_images(test_db, tmp_path, 3)
        service = _service(FakeIdentifier())
        before = service.get_stats("kaloscope")
        assert (before["images"], before["vectors"], before["pending"]) == (3, 0, 3)
        tasks = BackgroundTasks()
        service.start_extraction(tasks, space="kaloscope", image_ids=None)
        _run_scheduled(tasks)
        after = service.get_stats("kaloscope")
        assert (
            after["images"],
            after["vectors"],
            after["pending"],
            after["stale"],
        ) == (3, 3, 0, 0)
        assert after["model_version"] == CANONICAL_VERSION


def _prediction_rows(test_db):
    with test_db.get_db() as conn:
        return {
            int(row["image_id"]): (
                row["artist"],
                row["confidence"],
                row["top_predictions"],
            )
            for row in conn.execute(
                "SELECT image_id, artist, confidence, top_predictions FROM artist_predictions"
            )
        }


def _vector_rows(test_db):
    return {
        image_id: (
            row["model_version"],
            row["content_fingerprint"],
            bytes(row["vector"]),
        )
        for image_id, row in _rows(test_db).items()
    }


class TestBatching:
    """S1b: the worker feeds the model whole batches, prepares the next
    batch while the GPU works, and still answers picture by picture."""

    def test_pictures_reach_the_model_in_batches(self, test_db, tmp_path, monkeypatch):
        from services import style_vector_service as svc_mod

        monkeypatch.setattr(svc_mod, "EXTRACTION_BATCH_SIZE", 4)
        ids = _make_images(test_db, tmp_path, 10)
        identifier = FakeIdentifier()
        service = _service(identifier)
        tasks = BackgroundTasks()
        service.start_extraction(tasks, space="kaloscope")
        _run_scheduled(tasks)

        progress = service.get_progress()
        assert progress["step"] == "done"
        assert (progress["processed"], progress["written"], progress["errors"]) == (
            10,
            10,
            0,
        )
        assert [len(batch) for batch in identifier.batches] == [4, 4, 2]
        assert set(_rows(test_db)) == set(ids)
        assert set(_prediction_rows(test_db)) == set(ids)

    def test_batch_and_single_runs_store_identical_rows(
        self, test_db, tmp_path, monkeypatch
    ):
        from services import style_vector_service as svc_mod

        ids = _make_images(test_db, tmp_path, 9)
        monkeypatch.setattr(svc_mod, "EXTRACTION_BATCH_SIZE", 1)
        single = _service(FakeIdentifier())
        tasks = BackgroundTasks()
        single.start_extraction(tasks, space="kaloscope")
        _run_scheduled(tasks)
        single_vectors = _vector_rows(test_db)
        single_predictions = _prediction_rows(test_db)
        assert set(single_vectors) == set(ids)

        with test_db.get_db() as conn:
            conn.execute("DELETE FROM image_style_vectors")
            conn.execute("DELETE FROM artist_predictions")
        monkeypatch.setattr(svc_mod, "EXTRACTION_BATCH_SIZE", 4)
        batched = _service(FakeIdentifier())
        tasks = BackgroundTasks()
        batched.start_extraction(tasks, space="kaloscope")
        _run_scheduled(tasks)
        assert _vector_rows(test_db) == single_vectors
        assert _prediction_rows(test_db) == single_predictions

    def test_one_bad_picture_in_a_batch_costs_one_error_only(
        self, test_db, tmp_path, monkeypatch
    ):
        """The batch forward fails as a whole; the worker retries the
        batch picture by picture, so the good ones are stored and the bad
        one is reported once."""
        from services import style_vector_service as svc_mod

        monkeypatch.setattr(svc_mod, "EXTRACTION_BATCH_SIZE", 4)
        ids = _make_images(test_db, tmp_path, 6)
        identifier = FakeIdentifier(fail_on="img2.png")
        service = _service(identifier)
        tasks = BackgroundTasks()
        service.start_extraction(tasks, space="kaloscope")
        _run_scheduled(tasks)

        progress = service.get_progress()
        assert progress["step"] == "done"
        assert (progress["processed"], progress["written"], progress["errors"]) == (
            6,
            5,
            1,
        )
        assert set(_rows(test_db)) == set(ids) - {ids[2]}
        issues = [issue for issue in progress["recent_issues"] if "img2.png" in issue]
        assert len(issues) == 1
        # the first batch was attempted whole, then retried one by one through
        # the same batch interface (size 1, the already decoded picture): the
        # bad picture was seen twice (in the batch, then alone), no more.
        first_batch = identifier.batches[0]
        assert [path.endswith(f"img{i}.png") for i, path in enumerate(first_batch)] == [
            True
        ] * 4
        assert identifier.calls.count(first_batch[2]) == 2
        assert [len(batch) for batch in identifier.batches] == [4, 1, 1, 1, 1, 2]

    def test_one_non_finite_vector_costs_one_error_and_no_rollback(
        self, test_db, tmp_path, monkeypatch
    ):
        """Reviewer probe: a vector the store refuses (NaN) is one error;
        the other pictures of its batch are still written."""
        from services import style_vector_service as svc_mod

        monkeypatch.setattr(svc_mod, "EXTRACTION_BATCH_SIZE", 4)
        ids = _make_images(test_db, tmp_path, 10)
        service = _service(NanOnce())
        tasks = BackgroundTasks()
        service.start_extraction(tasks, space="kaloscope")
        _run_scheduled(tasks)
        progress = service.get_progress()
        assert progress["step"] == "done"
        assert (progress["processed"], progress["written"], progress["errors"]) == (
            10,
            9,
            1,
        )
        assert set(_rows(test_db)) == set(ids) - {ids[2]}
        assert sum("img2.png" in issue for issue in progress["recent_issues"]) == 1
        # refused before the store saw it: the worker's own message, not the packer's
        assert any(
            svc_mod.STYLE_VECTOR_BAD_VECTOR_ERROR in issue
            for issue in progress["recent_issues"]
        )

    def test_a_failing_prediction_write_costs_one_error_only(
        self, test_db, tmp_path, monkeypatch
    ):
        """An exception while writing one picture's prediction rolls back
        that picture only (its vector included); the batch goes on."""
        from services import style_vector_service as svc_mod

        monkeypatch.setattr(svc_mod, "EXTRACTION_BATCH_SIZE", 4)
        ids = _make_images(test_db, tmp_path, 10)
        real = svc_mod.write_artist_predictions

        def flaky(cursor, predictions):
            if any(p["image_id"] == ids[2] for p in predictions):
                raise RuntimeError("disk full")
            return real(cursor, predictions)

        monkeypatch.setattr(svc_mod, "write_artist_predictions", flaky)
        service = _service(FakeIdentifier())
        tasks = BackgroundTasks()
        service.start_extraction(tasks, space="kaloscope")
        _run_scheduled(tasks)
        progress = service.get_progress()
        assert progress["step"] == "done"
        assert (progress["processed"], progress["written"], progress["errors"]) == (
            10,
            9,
            1,
        )
        assert set(_rows(test_db)) == set(ids) - {ids[2]}
        assert set(_prediction_rows(test_db)) == set(ids) - {ids[2]}

    def test_prepared_tensors_reach_the_model_instead_of_pictures(
        self, test_db, tmp_path, monkeypatch
    ):
        """An identifier that offers prepare_style_input gets its own
        transformed inputs (made on the helper threads), not PIL images."""
        from services import style_vector_service as svc_mod

        monkeypatch.setattr(svc_mod, "EXTRACTION_BATCH_SIZE", 4)
        ids = _make_images(test_db, tmp_path, 5)
        identifier = TensorFakeIdentifier()
        service = _service(identifier)
        tasks = BackgroundTasks()
        service.start_extraction(tasks, space="kaloscope")
        _run_scheduled(tasks)
        assert service.get_progress()["written"] == 5
        assert identifier.prepared == 5
        assert identifier.input_kinds and all(
            kind == "ndarray" for kind in identifier.input_kinds
        )
        assert set(_rows(test_db)) == set(ids)

    def test_pause_takes_effect_between_batches(self, test_db, tmp_path, monkeypatch):
        from services import style_vector_service as svc_mod

        monkeypatch.setattr(svc_mod, "EXTRACTION_BATCH_SIZE", 4)
        _make_images(test_db, tmp_path, 8)
        holder = {}
        seen = []

        def pause_on_first(_identifier, path):
            seen.append(path)
            if len(seen) == 1:
                holder["service"].request_pause()
                threading.Timer(0.3, holder["service"].request_resume).start()

        service = _service(FakeIdentifier(on_call=pause_on_first))
        holder["service"] = service
        tasks = BackgroundTasks()
        service.start_extraction(tasks, space="kaloscope")
        started = time.time()
        _run_scheduled(tasks)
        assert time.time() - started >= 0.25
        progress = service.get_progress()
        assert progress["step"] == "done" and progress["written"] == 8

    def test_unchanged_file_skips_the_pixel_hash(self, test_db, tmp_path, monkeypatch):
        """A row whose stored mtime/size still match the file keeps the
        scanner's fingerprint without re-hashing the pixels (the scanner's
        own unchanged rule, image_manager_gates._source_fingerprint_matches);
        a file that changed on disk is hashed again."""
        import os

        ids = _make_images(test_db, tmp_path, 3)
        hashed = []
        from services import style_vector_prepare as prepare_mod

        real = prepare_mod.compute_image_content_fingerprint

        def counting(path):
            hashed.append(path)
            return real(path)

        monkeypatch.setattr(prepare_mod, "compute_image_content_fingerprint", counting)
        # rows 0 and 1 were scanned with a fingerprint and a source stat;
        # row 2 has a fingerprint but its file was rewritten since.
        with test_db.get_db() as conn:
            for index, image_id in enumerate(ids):
                path = tmp_path / f"img{index}.png"
                stat = os.stat(path)
                conn.execute(
                    "UPDATE images SET content_fingerprint = ?, source_mtime_ns = ?, source_size = ? WHERE id = ?",
                    (real(str(path)), stat.st_mtime_ns, stat.st_size, image_id),
                )
        Image.new("RGB", (24, 24), (1, 2, 3)).save(tmp_path / "img2.png")

        service = _service(FakeIdentifier())
        tasks = BackgroundTasks()
        service.start_extraction(tasks, space="kaloscope")
        _run_scheduled(tasks)
        progress = service.get_progress()
        assert (progress["written"], progress["errors"]) == (2, 1)
        assert [os.path.basename(path) for path in hashed] == ["img2.png"]
        assert set(_rows(test_db)) == {ids[0], ids[1]}

    def test_stats_follow_the_users_model_settings(self, test_db, tmp_path):
        """A local checkpoint names its own version: vectors made with it are
        not "other_version" for the user who runs it."""
        ids = _make_images(test_db, tmp_path, 2)
        local = tmp_path / "my-kaloscope.pth"
        local.write_bytes(b"local weights")
        local_version = ai.kaloscope_style_vector_model_version(str(local))
        assert local_version != CANONICAL_VERSION
        with test_db.get_db() as conn:
            from db_style_vectors import upsert_style_vector

            for image_id in ids:
                conn.execute(
                    "UPDATE images SET content_fingerprint = 'fp' WHERE id = ?",
                    (image_id,),
                )
                upsert_style_vector(
                    conn.cursor(),
                    image_id=image_id,
                    space="kaloscope",
                    model_version=local_version,
                    content_fingerprint="fp",
                    vector=_vector_for("x"),
                )
        service = _service(FakeIdentifier())
        default = service.get_stats("kaloscope")
        assert (default["vectors"], default["other_version"], default["pending"]) == (
            2,
            2,
            2,
        )
        mine = service.get_stats("kaloscope", model_path=str(local))
        assert (mine["vectors"], mine["other_version"], mine["pending"]) == (2, 0, 0)
        assert mine["model_version"] == local_version


class TestModelSettings:
    """S1c: the index runs the model the Style Finder page is set to, so a
    local-weights user's predictions are never overwritten by the official
    model's answers (and the vectors are stamped with that model's version)."""

    def test_start_builds_the_identifier_from_the_users_settings(
        self, test_db, tmp_path
    ):
        from services.style_vector_service import StyleVectorService

        ids = _make_images(test_db, tmp_path, 2)
        local = tmp_path / "my-kaloscope.pth"
        local.write_bytes(b"local weights")
        seen = []
        identifier = FakeIdentifier()

        def getter(**kwargs):
            seen.append(kwargs)
            return identifier

        service = StyleVectorService(identifier_getter=getter)
        tasks = BackgroundTasks()
        service.start_extraction(
            tasks,
            space="kaloscope",
            model_source="local",
            model_path=str(local),
            use_gpu=False,
        )
        _run_scheduled(tasks)
        assert seen == [
            {
                "model_path": str(local),
                "model_source": "local",
                "threshold": ai.ARTIST_THRESHOLD_DEFAULT,
                "use_gpu": False,
            }
        ]
        local_version = ai.kaloscope_style_vector_model_version(str(local))
        rows = _rows(test_db)
        assert set(rows) == set(ids)
        assert {row["model_version"] for row in rows.values()} == {local_version}
        assert set(_prediction_rows(test_db)) == set(ids)

    def test_default_settings_build_the_official_identifier(self, test_db, tmp_path):
        from services.style_vector_service import StyleVectorService

        _make_images(test_db, tmp_path, 1)
        seen = []
        service = StyleVectorService(
            identifier_getter=lambda **kw: seen.append(kw) or FakeIdentifier()
        )
        tasks = BackgroundTasks()
        service.start_extraction(tasks, space="kaloscope")
        _run_scheduled(tasks)
        assert seen == [
            {
                "model_path": None,
                "model_source": "huggingface",
                "threshold": ai.ARTIST_THRESHOLD_DEFAULT,
                "use_gpu": None,
            }
        ]
        assert {row["model_version"] for row in _rows(test_db).values()} == {
            CANONICAL_VERSION
        }


class TestModelRefusals:
    """Real ArtistIdentifier objects with the model slot stubbed: the job must
    fail before touching any image, and must try to load only once."""

    @staticmethod
    def _counting_load(identifier, error: Exception | None = None):
        calls = {"n": 0}

        def load():
            calls["n"] += 1
            if error is not None:
                raise error

        identifier.load = load
        return calls

    def _assert_refused(self, test_db, service, needle: str):
        tasks = BackgroundTasks()
        assert service.start_extraction(tasks, space="kaloscope")["total"] == 2
        _run_scheduled(tasks)
        progress = service.get_progress()
        assert progress["running"] is False and progress["step"] == "error"
        assert needle in progress["message"]
        assert (progress["processed"], progress["written"], progress["errors"]) == (
            0,
            0,
            0,
        )
        assert _rows(test_db) == {}
        assert _fingerprints(test_db) == [None, None], "no fingerprint is claimed"

    def test_non_kaloscope_backend_is_refused_before_any_image(self, test_db, tmp_path):
        _make_images(test_db, tmp_path, 2)
        identifier = ai.ArtistIdentifier(artists_list=["a"])
        identifier._model = object()
        identifier._backend = "onnx"
        identifier._transform = lambda image: image
        loads = self._counting_load(identifier)
        service = _service(identifier)

        self._assert_refused(test_db, service, "Kaloscope")
        assert loads["n"] == 1

    def test_load_failure_is_refused_once(self, test_db, tmp_path):
        _make_images(test_db, tmp_path, 2)
        identifier = ai.ArtistIdentifier(artists_list=["a"])
        loads = self._counting_load(identifier, RuntimeError("runtime missing: timm"))
        service = _service(identifier)

        self._assert_refused(test_db, service, "runtime missing: timm")
        assert loads["n"] == 1

    def test_unprepared_model_reports_its_load_error(self, test_db, tmp_path):
        _make_images(test_db, tmp_path, 2)
        identifier = ai.ArtistIdentifier(artists_list=["a"])
        identifier._load_error = "Kaloscope not prepared yet"
        loads = self._counting_load(identifier)
        service = _service(identifier)

        self._assert_refused(test_db, service, "Kaloscope not prepared yet")
        assert loads["n"] == 1

    def test_e2e_stub_without_feature_layer_is_refused(self, test_db, tmp_path):
        from services.artist_service import _E2EArtistIdentifierStub

        _make_images(test_db, tmp_path, 2)
        service = _service(_E2EArtistIdentifierStub(threshold=0.03))
        self._assert_refused(test_db, service, "Kaloscope")


class TestSingletonSafety:
    """Looking things up must never rebuild (and drop) the loaded artist model."""

    @pytest.fixture
    def loaded_singleton(self, monkeypatch):
        identifier = ai.ArtistIdentifier(artists_list=["a"], use_gpu=False)
        identifier._model = object()
        identifier._backend = "kaloscope"
        monkeypatch.setattr(ai, "_identifier", identifier)
        return identifier

    def test_stats_and_start_keep_the_loaded_identifier(
        self, test_db, tmp_path, loaded_singleton
    ):
        from services.style_vector_service import StyleVectorService

        _make_images(test_db, tmp_path, 2)
        service = StyleVectorService()  # default getter = get_artist_identifier

        service.get_stats("kaloscope")
        assert ai._identifier is loaded_singleton

        tasks = BackgroundTasks()
        started = service.start_extraction(tasks, space="kaloscope", use_gpu=None)
        assert started["status"] == "started"
        assert ai._identifier is loaded_singleton

        with pytest.raises(OperationInProgressError):
            service.start_extraction(BackgroundTasks(), space="kaloscope", use_gpu=True)
        assert ai._identifier is loaded_singleton

        # Never run the real worker here: it would load the real Kaloscope.
        fake = FakeIdentifier()
        service._identifier_getter = lambda **kwargs: fake
        _run_scheduled(tasks)
        assert service.get_progress()["step"] == "done"
        assert ai._identifier is loaded_singleton

    def test_cancel_before_the_worker_starts_never_builds_a_model(
        self, test_db, tmp_path
    ):
        from services.style_vector_service import StyleVectorService

        _make_images(test_db, tmp_path, 2)
        getter_calls = {"n": 0}

        def getter(**kwargs):
            getter_calls["n"] += 1
            return FakeIdentifier()

        service = StyleVectorService(identifier_getter=getter)
        tasks = BackgroundTasks()
        assert service.start_extraction(tasks, space="kaloscope")["status"] == "started"
        assert service.request_cancel() is True
        _run_scheduled(tasks)

        progress = service.get_progress()
        assert progress["running"] is False and progress["step"] == "cancelled"
        assert progress["processed"] == 0
        assert getter_calls["n"] == 0, "a cancelled job must not build or load a model"
        assert _rows(test_db) == {}


class TestLocalModelVersion:
    """Which weights the version string names must match what load() would use."""

    def test_unhashable_local_file_is_rejected_at_start(
        self, test_db, tmp_path, monkeypatch
    ):
        _make_images(test_db, tmp_path, 1)
        weights = tmp_path / "w.pth"
        weights.write_bytes(b"weights")

        def broken(_path):
            raise OSError("disk read error")

        monkeypatch.setattr(ai, "_sha256_file", broken)
        service = _service(FakeIdentifier())
        with pytest.raises(ValidationError):
            service.start_extraction(
                BackgroundTasks(),
                space="kaloscope",
                model_source="local",
                model_path=str(weights),
            )
        assert service.get_progress()["running"] is False
        assert _rows(test_db) == {}

    def test_version_names_the_weights_load_would_pick(self, test_db, tmp_path):
        _make_images(test_db, tmp_path, 1)
        official = ai.kaloscope_style_vector_model_version(None)
        weights = tmp_path / "w.pth"
        weights.write_bytes(b"weights")
        local = ai.kaloscope_style_vector_model_version(str(weights))
        assert local != official

        def stored_version(**kwargs):
            service = _service(FakeIdentifier())
            tasks = BackgroundTasks()
            service.start_extraction(tasks, space="kaloscope", **kwargs)
            _run_scheduled(tasks)
            versions = {row["model_version"] for row in _rows(test_db).values()}
            with test_db.get_db() as conn:
                conn.execute("DELETE FROM image_style_vectors")
            return versions

        # No path: the official weights.
        assert stored_version(model_source="huggingface") == {official}
        # "local" but the file is gone: load() falls back to the official weights.
        assert stored_version(
            model_source="local", model_path=str(tmp_path / "gone.pth")
        ) == {official}
        # An existing file is what load() opens, whatever the source says.
        assert stored_version(model_source="local", model_path=str(weights)) == {local}
        assert stored_version(model_source="huggingface", model_path=str(weights)) == {
            local
        }
