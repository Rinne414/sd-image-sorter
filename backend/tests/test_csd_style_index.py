"""The style index for the CSD space (S5): the one extraction job runs it.

A fake encoder stands in for CSD; the job, its batches, the database rows and
the per-space bookkeeping are the real ones.
"""

from __future__ import annotations

import hashlib

import numpy as np
import pytest
from fastapi import BackgroundTasks

import csd_weights
from exceptions import ValidationError
from tests.test_style_vector_service import (
    FakeIdentifier,
    _fingerprints,
    _make_images,
    _rows,
    _run_scheduled,
)

DIM = 768


def _csd_vector(path: str) -> np.ndarray:
    digest = hashlib.sha256(("csd" + path).encode("utf-8")).digest()
    rng = np.random.default_rng(int.from_bytes(digest[:8], "little"))
    return rng.normal(size=DIM).astype(np.float32)


class FakeCsd:
    """The surface of ``csd_encoder.CsdEncoder`` the job drives."""

    model_loaded = True
    vector_only_batches = True
    load_error = None

    def __init__(self, *, fail_load: str = "", answers_artist: bool = False):
        self.fail_load = fail_load
        self.answers_artist = answers_artist
        self.batches: list[list[str]] = []
        self.prepared = 0
        self.loads = 0
        self.priorities: list[int] = []

    def load(self):
        self.loads += 1
        if self.fail_load:
            raise RuntimeError(self.fail_load)

    def supports_style_vectors(self):
        return True

    def prepare_style_input(self, image):
        self.prepared += 1
        return np.zeros((3, 4, 4), dtype=np.float32)

    def extract_style_vectors_and_identifications(
        self, items, *, top_k=5, threshold=0.0, priority=0
    ):
        self.batches.append([path for path, _tensor in items])
        self.priorities.append(priority)
        answer = {"artist": "someone", "confidence": 0.9} if self.answers_artist else None
        return [(_csd_vector(path), answer) for path, _tensor in items]


class NoKaloscope:
    """The Kaloscope getter must never be asked for when the space is CSD."""

    def __call__(self, **_kwargs):
        pytest.fail("the artist model was built for a CSD job")


def _service(encoder, *, kaloscope=None):
    from services.style_vector_service import StyleVectorService

    seen = []

    def csd_getter(**kwargs):
        seen.append(kwargs)
        return encoder

    service = StyleVectorService(
        identifier_getter=kaloscope or NoKaloscope(), csd_getter=csd_getter
    )
    service.csd_getter_calls = seen
    return service


def _run(service, **kwargs):
    tasks = BackgroundTasks()
    started = service.start_extraction(tasks, **kwargs)
    _run_scheduled(tasks)
    return started


class TestCsdJob:
    def test_every_picture_gets_a_csd_row_stamped_with_the_pinned_version(
        self, test_db, tmp_path
    ):
        ids = _make_images(test_db, tmp_path, 5)
        encoder = FakeCsd()
        service = _service(encoder)

        started = _run(service, space="csd")

        assert started == {"status": "started", "total": 5, "space": "csd"}
        rows = _rows(test_db)
        assert set(rows) == set(ids)
        for row in rows.values():
            assert row["space"] == "csd"
            assert row["model_version"] == csd_weights.CSD_MODEL_VERSION
            assert (row["dim"], row["dtype"]) == (DIM, "float16")
        progress = service.get_progress()
        assert (progress["step"], progress["written"], progress["errors"]) == (
            "done",
            5,
            0,
        )

    def test_pictures_go_through_the_model_in_one_batch_with_prepared_input(
        self, test_db, tmp_path
    ):
        _make_images(test_db, tmp_path, 5)
        encoder = FakeCsd()

        _run(_service(encoder), space="csd")

        assert [len(batch) for batch in encoder.batches] == [5]
        assert encoder.prepared == 5
        from ai_runtime_guard import PRIORITY_BATCH

        assert set(encoder.priorities) == {PRIORITY_BATCH}

    def test_no_artist_prediction_is_written_even_when_asked_for(
        self, test_db, tmp_path
    ):
        _make_images(test_db, tmp_path, 3)

        _run(_service(FakeCsd(answers_artist=True)), space="csd", with_artist=True)

        with test_db.get_db() as conn:
            assert (
                conn.execute("SELECT COUNT(*) FROM artist_predictions").fetchone()[0]
                == 0
            )

    def test_the_gpu_choice_reaches_the_encoder_and_the_artist_model_is_untouched(
        self, test_db, tmp_path
    ):
        _make_images(test_db, tmp_path, 2)
        service = _service(FakeCsd())

        _run(service, space="csd", use_gpu=False, model_source="local", model_path=None)

        assert service.csd_getter_calls == [{"use_gpu": False}]

    def test_a_model_that_cannot_load_ends_the_job_with_its_message(
        self, test_db, tmp_path
    ):
        _make_images(test_db, tmp_path, 2)
        service = _service(FakeCsd(fail_load="CSD is not prepared"))

        _run(service, space="csd")

        progress = service.get_progress()
        assert progress["running"] is False and progress["step"] == "error"
        assert "CSD is not prepared" in progress["message"]
        assert _rows(test_db) == {}

    def test_a_not_loaded_model_ends_the_job_up_front(self, test_db, tmp_path):
        _make_images(test_db, tmp_path, 2)
        encoder = FakeCsd()
        encoder.model_loaded = False
        encoder.load_error = "weights missing"

        service = _service(encoder)
        _run(service, space="csd")

        assert service.get_progress()["step"] == "error"
        assert "weights missing" in service.get_progress()["message"]

    def test_a_second_run_finds_nothing_to_do(self, test_db, tmp_path):
        _make_images(test_db, tmp_path, 3)
        service = _service(FakeCsd())
        _run(service, space="csd")

        again = _run(service, space="csd")

        assert again == {"status": "idle", "total": 0, "space": "csd"}

    def test_vectors_of_other_weights_are_extracted_again(self, test_db, tmp_path):
        ids = _make_images(test_db, tmp_path, 2)
        _run(_service(FakeCsd()), space="csd")
        with test_db.get_db() as conn:
            conn.execute(
                "UPDATE image_style_vectors SET model_version = 'csd:old' WHERE image_id = ?",
                (ids[0],),
            )
        assert _service(FakeCsd()).get_stats("csd")["other_version"] == 1

        again = _run(_service(FakeCsd()), space="csd")

        assert again["total"] == 1
        assert _rows(test_db)[ids[0]]["model_version"] == csd_weights.CSD_MODEL_VERSION


class TestSpacesAreIndependent:
    def test_a_kaloscope_index_does_not_satisfy_csd_and_back(self, test_db, tmp_path):
        ids = _make_images(test_db, tmp_path, 3)
        from tests.test_style_vector_service import TensorFakeIdentifier
        from services.style_vector_service import StyleVectorService

        kaloscope = TensorFakeIdentifier()
        both = StyleVectorService(
            identifier_getter=lambda **kwargs: kaloscope,
            csd_getter=lambda **kwargs: FakeCsd(),
        )
        tasks = BackgroundTasks()
        both.start_extraction(tasks, space="kaloscope")
        _run_scheduled(tasks)

        assert both.get_stats("csd")["vectors"] == 0
        assert both.get_stats("csd")["pending"] == 3

        _run(both, space="csd")

        with test_db.get_db() as conn:
            spaces = sorted(
                row[0]
                for row in conn.execute(
                    "SELECT space FROM image_style_vectors"
                ).fetchall()
            )
        assert spaces == ["csd"] * 3 + ["kaloscope"] * 3
        assert both.get_stats("kaloscope")["vectors"] == 3
        assert both.get_stats("csd")["vectors"] == 3
        assert set(_rows(test_db)) == set(ids)

    def test_stats_name_the_pinned_version_and_ignore_a_kaloscope_model_path(
        self, test_db, tmp_path
    ):
        _make_images(test_db, tmp_path, 2)
        stats = _service(FakeCsd()).get_stats("csd", model_path="C:/my/kaloscope.pth")
        assert stats["space"] == "csd"
        assert stats["model_version"] == csd_weights.CSD_MODEL_VERSION
        assert (stats["images"], stats["vectors"], stats["pending"]) == (2, 0, 2)

    def test_an_unknown_space_is_still_refused(self, test_db):
        with pytest.raises(ValidationError):
            _service(FakeCsd()).get_stats("dino")

    def test_fingerprints_are_claimed_like_the_kaloscope_job(self, test_db, tmp_path):
        _make_images(test_db, tmp_path, 2)
        _run(_service(FakeCsd()), space="csd")
        assert all(_fingerprints(test_db))


class TestRoute:
    def test_csd_is_an_accepted_space_for_start_and_stats(self, test_client):
        from routers import style_map as style_map_router
        from tests.test_style_map_router import FakeStyleVectorService

        fake = FakeStyleVectorService()
        style_map_router.set_style_vector_service(fake)
        try:
            started = test_client.post(
                "/api/style-map/vectors/start", json={"space": "csd", "use_gpu": True}
            )
            stats = test_client.get("/api/style-map/vectors/stats?space=csd")
            unknown = test_client.post(
                "/api/style-map/vectors/start", json={"space": "dino"}
            )
        finally:
            style_map_router.set_style_vector_service(None)
        assert started.status_code == 200 and started.json()["space"] == "csd"
        assert fake.calls[0][1] == "csd" and fake.calls[0][3] is True
        assert stats.status_code == 200 and stats.json()["space"] == "csd"
        assert unknown.status_code == 400

    def test_kaloscope_start_still_builds_its_own_identifier(self, test_db, tmp_path):
        """The default getter pair: CSD never goes through the artist model."""
        from services.style_vector_service import StyleVectorService

        service = StyleVectorService(identifier_getter=lambda **k: FakeIdentifier())
        assert callable(service._csd_getter)
