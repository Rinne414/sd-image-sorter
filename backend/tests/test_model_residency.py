"""Resident-friendly behaviour (S7): idle model release, GPU-busy fallback, priority.

The idle mechanism is driven by a fake clock and fake lease labels; the GPU
check by a fake free-memory probe; the priority helpers by a fake psutil. No
model is ever loaded on the GPU here.
"""

from __future__ import annotations

import contextlib
import sys
import types
from typing import List, Optional
from unittest.mock import patch

import pytest

import ai_runtime_guard
import gpu_headroom
import model_residency_slots
import process_priority
from model_residency import ModelResidency, ModelSlot


class FakeClock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


class FakeModel:
    """A loaded model that a slot can probe and release."""

    def __init__(self, device: str = "cpu", fail: bool = False) -> None:
        self.device: Optional[str] = device
        self.fail = fail
        self.releases = 0

    def probe(self) -> Optional[str]:
        return self.device

    def release(self) -> None:
        if self.fail:
            raise RuntimeError("cannot release")
        self.releases += 1
        self.device = None


def _residency(clock, *, minutes: float = 10.0, active: Optional[List[str]] = None):
    freed: List[int] = []
    residency = ModelResidency(
        idle_seconds=lambda: minutes * 60.0,
        clock=clock,
        active_labels=lambda: list(active or []),
        release_guard=lambda _key: contextlib.nullcontext(),
        free_cache=lambda: freed.append(1),
    )
    return residency, freed


def _slot(key: str, model: FakeModel, *prefixes: str) -> ModelSlot:
    return ModelSlot(key, prefixes or (f"{key}-",), model.probe, model.release)


def test_idle_model_is_released_after_the_setting_and_not_before():
    clock = FakeClock()
    residency, freed = _residency(clock, minutes=10)
    model = FakeModel("cpu")
    residency.register(_slot("tagger", model, "wd14-tagger"))
    residency.note_activity("wd14-tagger")

    clock.now += 9 * 60
    assert residency.sweep() == []
    assert model.releases == 0

    clock.now += 61
    assert residency.sweep() == ["tagger"]
    assert model.releases == 1
    assert freed == [1]
    assert residency.snapshot()["models"] == []


def test_use_resets_the_idle_time():
    clock = FakeClock()
    residency, _ = _residency(clock, minutes=5)
    model = FakeModel()
    residency.register(_slot("clip", model, "clip-"))
    residency.note_activity("clip-similarity-load")
    clock.now += 4 * 60
    residency.note_activity("clip-text-inference")
    clock.now += 4 * 60
    assert residency.sweep() == []
    clock.now += 61
    assert residency.sweep() == ["clip"]


def test_running_job_keeps_its_model_however_long_it_runs():
    clock = FakeClock()
    active = ["wd14-tagger"]
    residency, _ = _residency(clock, minutes=5, active=active)
    tagger, clip = FakeModel("gpu"), FakeModel("cpu")
    residency.register(_slot("tagger", tagger, "wd14-tagger"))
    residency.register(_slot("clip", clip, "clip-"))
    residency.note_activity("wd14-tagger")
    residency.note_activity("clip-text-inference")

    clock.now += 60 * 60
    assert residency.sweep() == ["clip"]
    assert tagger.releases == 0
    snapshot = residency.snapshot()["models"]
    assert snapshot == [
        {"key": "tagger", "device": "gpu", "in_use": True, "idle_seconds": 3600.0}
    ]


def test_never_setting_keeps_models():
    clock = FakeClock()
    residency, _ = _residency(clock, minutes=0)
    model = FakeModel()
    residency.register(_slot("artist", model))
    clock.now += 10**6
    assert residency.sweep() == []
    assert model.releases == 0


def test_model_loaded_without_a_recorded_use_starts_its_idle_time_when_seen():
    clock = FakeClock()
    residency, _ = _residency(clock, minutes=10)
    model = FakeModel()
    residency.register(_slot("censor", model))
    assert residency.sweep() == []  # first seen now
    clock.now += 10 * 60
    assert residency.sweep() == ["censor"]


def test_unload_now_releases_idle_models_and_reports_busy_ones():
    clock = FakeClock()
    residency, _ = _residency(clock, active=["censor-onnx-inference"])
    censor, clip, broken = FakeModel(), FakeModel(), FakeModel(fail=True)
    residency.register(_slot("censor", censor, "censor-"))
    residency.register(_slot("clip", clip, "clip-"))
    residency.register(_slot("artist", broken, "artist-"))

    result = residency.release_now()

    assert result["released"] == ["clip"]
    assert sorted(result["busy"]) == ["artist", "censor"]
    assert censor.releases == 0 and clip.releases == 1
    last = residency.snapshot()["last_release"]
    assert last["keys"] == ["clip"] and last["reason"] == "manual"


def test_release_lease_activity_does_not_count_as_use():
    clock = FakeClock()
    residency, _ = _residency(clock, minutes=1)
    model = FakeModel()
    residency.register(ModelSlot("x", ("",), model.probe, model.release))
    residency.note_activity("model-idle-release:x")
    assert residency.snapshot()["models"][0]["idle_seconds"] == 0.0
    clock.now += 61
    assert residency.sweep() == ["x"]


def test_real_lease_notifies_activity_listeners():
    labels: List[str] = []
    ai_runtime_guard.add_activity_listener(labels.append)
    try:
        with ai_runtime_guard.exclusive_ai_runtime("clip-text-inference", tier="cpu"):
            pass
    finally:
        ai_runtime_guard._activity_listeners.remove(labels.append)
    assert labels == ["clip-text-inference", "clip-text-inference"]


# Slots read real module globals ---------------------------------------------------


class _FakeSession:
    def __init__(self, providers):
        self._providers = providers

    def get_providers(self):
        return self._providers


class _FakeTagger:
    def __init__(self, providers):
        self.session = _FakeSession(providers)
        self._loaded = True
        self.released = 0

    def release_session(self):
        self.released += 1
        self.session = None
        self._loaded = False


def test_tagger_slot_reports_device_and_releases_the_session(monkeypatch):
    fake = types.ModuleType("tagger")
    fake._tagger = _FakeTagger(["CUDAExecutionProvider", "CPUExecutionProvider"])
    monkeypatch.setitem(sys.modules, "tagger", fake)
    slot = model_residency_slots._tagger_slot(
        "tagger", "tagger", "_tagger", ("wd14-tagger",)
    )
    assert slot.probe() == "gpu"
    slot.release()
    assert fake._tagger.released == 1
    assert slot.probe() is None


def test_clip_slot_drops_both_towers(monkeypatch):
    fake = types.ModuleType("similarity")
    fake._embed_model = object()
    fake._text_embed_model = object()
    monkeypatch.setitem(sys.modules, "similarity", fake)
    assert model_residency_slots._clip_probe() == "cpu"
    model_residency_slots._clip_release()
    assert fake._embed_model is None and fake._text_embed_model is None
    assert model_residency_slots._clip_probe() is None


def test_slots_never_import_a_model_module(monkeypatch):
    for name in ("tagger", "similarity", "censor", "toriigate_tagger"):
        monkeypatch.delitem(sys.modules, name, raising=False)
    residency, _ = _residency(FakeClock())
    model_residency_slots.register_default_slots(residency)
    assert residency.snapshot()["models"] == []
    for name in ("tagger", "similarity", "censor", "toriigate_tagger"):
        assert name not in sys.modules


# GPU busy -> CPU --------------------------------------------------------------------


def test_gpu_busy_decision_falls_back_to_cpu_and_says_why(monkeypatch):
    monkeypatch.setattr(gpu_headroom, "_probe_free_vram_mb", lambda: 600.0)
    decision = gpu_headroom.decide_gpu("tagger:wd-swinv2-tagger-v3", 1500)
    assert decision.use_gpu is False
    assert decision.message().startswith("GPU busy, used CPU")
    assert "600 MB" in decision.message() and "1500 MB" in decision.message()
    assert gpu_headroom.recent_fallbacks()[0]["label"] == "tagger:wd-swinv2-tagger-v3"


@pytest.mark.parametrize("free_mb", [None, 1500.0, 20000.0])
def test_gpu_used_when_room_or_unknown(monkeypatch, free_mb):
    monkeypatch.setattr(gpu_headroom, "_probe_free_vram_mb", lambda: free_mb)
    decision = gpu_headroom.decide_gpu("x", 1500)
    assert decision.use_gpu is True and decision.message() == ""
    assert gpu_headroom.recent_fallbacks() == []


def test_failing_probe_reads_as_unknown(monkeypatch):
    def boom():
        raise OSError("no driver")

    monkeypatch.setattr(gpu_headroom, "_probe_free_vram_mb", boom)
    assert gpu_headroom.decide_gpu("x", 1500).use_gpu is True


def test_tagger_need_follows_the_safety_tier():
    assert gpu_headroom.tagger_gpu_need_mb("wd-vit-tagger-v3") == 1200.0
    assert gpu_headroom.tagger_gpu_need_mb("wd-swinv2-tagger-v3") == 1500.0
    assert gpu_headroom.tagger_gpu_need_mb("wd-eva02-large-tagger-v3") == 3000.0
    assert gpu_headroom.tagger_gpu_need_mb("custom") == 2000.0


def test_mass_tag_plan_runs_on_cpu_when_the_gpu_is_busy(monkeypatch):
    from services.tagging_service import TagRequest, TaggingService

    monkeypatch.setattr(gpu_headroom, "_probe_free_vram_mb", lambda: 300.0)
    request = TagRequest(model_name="wd-swinv2-tagger-v3", use_gpu=True)
    with (
        patch("hardware_monitor.get_system_info", return_value={}),
        patch(
            "hardware_monitor.recommend_tagger_config",
            return_value={
                "recommended_batch_size": 64,
                "recommended_cpu_chunk_size": 24,
                "recommended_session_refresh_interval": 0,
            },
        ) as recommend,
    ):
        plan = TaggingService()._build_runtime_plan(request)

    assert plan["effective_use_gpu"] is False
    assert plan["request"]["use_gpu"] is False
    assert plan["startup_notice"].startswith("GPU busy, used CPU")
    assert recommend.call_args.kwargs["use_gpu"] is False


def test_mass_tag_plan_keeps_gpu_when_there_is_room(monkeypatch):
    from services.tagging_service import TagRequest, TaggingService

    monkeypatch.setattr(gpu_headroom, "_probe_free_vram_mb", lambda: 20000.0)
    request = TagRequest(model_name="wd-swinv2-tagger-v3", use_gpu=True)
    with (
        patch("hardware_monitor.get_system_info", return_value={}),
        patch(
            "hardware_monitor.recommend_tagger_config",
            return_value={
                "recommended_batch_size": 64,
                "recommended_cpu_chunk_size": 24,
                "recommended_session_refresh_interval": 0,
            },
        ),
    ):
        plan = TaggingService()._build_runtime_plan(request)
    assert plan["effective_use_gpu"] is True
    assert "GPU busy" not in plan["startup_notice"]


# Priority -------------------------------------------------------------------------


class _FakeProcess:
    def __init__(self, current: int = 0):
        self.current = current
        self.set_to: List[int] = []

    def nice(self, value=None):
        if value is None:
            return self.current
        self.set_to.append(value)
        return None


def _fake_psutil(process):
    return types.SimpleNamespace(
        Process=lambda pid=None: process, BELOW_NORMAL_PRIORITY_CLASS=16384
    )


def test_worker_process_goes_below_normal_on_windows(monkeypatch):
    process = _FakeProcess()
    monkeypatch.setattr(process_priority, "_psutil", lambda: _fake_psutil(process))
    monkeypatch.setattr(process_priority.sys, "platform", "win32")
    assert process_priority.lower_process_priority() is True
    assert process.set_to == [16384]


def test_worker_process_is_niced_on_linux_without_raising_priority(monkeypatch):
    process = _FakeProcess(current=15)
    monkeypatch.setattr(process_priority, "_psutil", lambda: _fake_psutil(process))
    monkeypatch.setattr(process_priority.sys, "platform", "linux")
    assert process_priority.lower_process_priority() is True
    assert process.set_to == [15]


def test_priority_failure_is_never_an_error(monkeypatch):
    def broken():
        raise ImportError("no psutil")

    monkeypatch.setattr(process_priority, "_psutil", broken)
    assert process_priority.lower_process_priority() is False


def test_metadata_workers_start_below_normal(monkeypatch):
    import image_manager
    import image_manager_executor

    calls = []

    class Recorder:
        def __init__(self, **kwargs):
            calls.append(kwargs)

    monkeypatch.setattr(image_manager, "ProcessPoolExecutor", Recorder)
    monkeypatch.setattr(image_manager, "ThreadPoolExecutor", Recorder)
    monkeypatch.setattr(image_manager, "SCAN_METADATA_EXECUTOR_MODE", "process")
    image_manager_executor._create_metadata_executor(2)
    monkeypatch.setattr(image_manager, "SCAN_METADATA_EXECUTOR_MODE", "thread")
    image_manager_executor._create_metadata_executor(2)
    assert calls[0]["initializer"] is process_priority.lower_process_priority
    assert calls[1]["initializer"] is process_priority.lower_current_thread_priority


# API ----------------------------------------------------------------------------------


def test_background_models_api(test_client, monkeypatch):
    import model_residency

    clock = FakeClock()
    residency, _ = _residency(clock)
    model = FakeModel("cpu")
    residency.register(_slot("tagger", model, "wd14-tagger"))
    monkeypatch.setattr(model_residency, "_residency", residency)

    body = test_client.get("/api/background-models").json()
    assert body["idle_unload_minutes"] == 10.0
    assert body["models"][0]["key"] == "tagger"

    saved = test_client.patch("/api/background-models", json={"minutes": 30})
    assert saved.status_code == 200 and saved.json()["idle_unload_minutes"] == 30.0
    assert (
        test_client.patch("/api/background-models", json={"minutes": -1}).status_code
        == 400
    )

    unloaded = test_client.post("/api/background-models/unload").json()
    assert unloaded["released"] == ["tagger"] and unloaded["models"] == []
