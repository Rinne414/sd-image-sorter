"""Character-purity progress carries a message_key so the UI can localise it.

The English (or bilingual) ``message`` stays for API compatibility; the
counters (``current`` / ``total`` / ``extracted`` / ``failed``) and the
``result`` summary are already progress fields.
"""

from __future__ import annotations

import services.character_purity_service as purity_service
from tests.test_character_purity import (  # noqa: F401  (fixtures and helpers)
    DIFFS_3,
    BlockingCcip,
    FakeCcip,
    _install_fake,
    _reset_purity_job_state,
    _wait_for_job,
    purity_images,
)


def _start(test_client, ids, **extra):
    response = test_client.post(
        "/api/dataset/character-purity", json={"image_ids": ids, **extra}
    )
    assert response.status_code == 200
    return response.json()


def test_idle_progress_has_an_empty_key(test_client):
    body = purity_service.get_character_purity_progress()

    assert body["message_key"] == ""
    assert body["message_args"] == {}


def test_start_response_and_done_state_have_keys(
    test_client, monkeypatch, purity_images
):
    _install_fake(monkeypatch, FakeCcip(diff_matrix=DIFFS_3))

    started = _start(test_client, purity_images["image_ids"])
    assert started["message_key"] == "started"

    progress = _wait_for_job(test_client, started["job_id"])
    assert progress["status"] == "done"
    assert progress["message_key"] == "done"
    assert progress["extracted"] == 3
    assert progress["message_args"] == {"outliers": 1}


def test_too_few_images_survive_has_its_own_key(
    test_client, monkeypatch, purity_images
):
    failed_paths = {
        str(purity_images["dir"] / name) for name in ("beta.png", "gamma.png")
    }
    _install_fake(monkeypatch, FakeCcip(diff_matrix=[[0.0]], failed_paths=failed_paths))

    started = _start(test_client, purity_images["image_ids"])
    progress = _wait_for_job(test_client, started["job_id"])

    assert progress["status"] == "failed"
    assert progress["message_key"] == "too_few"


def test_unexpected_failure_has_the_failed_key_and_raw_detail(
    test_client, monkeypatch, purity_images
):
    class Exploding(FakeCcip):
        def pairwise_diff(self, features):
            raise RuntimeError("onnx session lost")

    _install_fake(monkeypatch, Exploding(diff_matrix=DIFFS_3))

    started = _start(test_client, purity_images["image_ids"])
    progress = _wait_for_job(test_client, started["job_id"])

    assert progress["status"] == "failed"
    assert progress["message_key"] == "failed"
    assert progress["message_args"] == {"detail": "onnx session lost"}


def test_cancelling_and_cancelled_states_have_keys(
    test_client, monkeypatch, purity_images
):
    fake = _install_fake(monkeypatch, BlockingCcip(diff_matrix=DIFFS_3))
    started = _start(test_client, purity_images["image_ids"])
    assert fake.started.wait(timeout=5.0)

    cancel = test_client.post(
        "/api/dataset/character-purity/cancel", json={"job_id": started["job_id"]}
    )
    assert cancel.json()["status"] == "cancelling"
    live = test_client.get(
        f"/api/dataset/character-purity/progress?job_id={started['job_id']}"
    ).json()
    assert live["message_key"] == "cancelling"

    fake.release.set()
    progress = _wait_for_job(test_client, started["job_id"])
    assert progress["message_key"] == "cancelled"


def test_progress_while_running_has_the_extracting_key(
    test_client, monkeypatch, purity_images
):
    fake = _install_fake(monkeypatch, BlockingCcip(diff_matrix=DIFFS_3))
    started = _start(test_client, purity_images["image_ids"])
    assert fake.started.wait(timeout=5.0)

    live = test_client.get(
        f"/api/dataset/character-purity/progress?job_id={started['job_id']}"
    ).json()
    assert live["message_key"] == "extracting"

    fake.release.set()
    _wait_for_job(test_client, started["job_id"])
