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
        """What identify_with_threshold would answer for this picture."""
        name = "modare" if "img0" in image_path else "undefined"
        confidence = 0.42 if name != "undefined" else 0.01
        return {
            "artist": name,
            "confidence": confidence,
            "confidence_level": "high" if name != "undefined" else "none",
            "candidate_artist": name if name != "undefined" else None,
            "out_of_vocabulary_likely": name == "undefined",
            "vocabulary_size": 4,
            "advisory": "",
            "top_predictions": [{"artist": "modare", "confidence": confidence}][:top_k],
            "model_loaded": True,
        }

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

    def test_cancel_stops_after_current_image(self, test_db, tmp_path):
        ids = _make_images(test_db, tmp_path, 4)
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
        assert progress["processed"] == 1 and progress["written"] == 1
        assert set(_rows(test_db)) == {ids[0]}
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
