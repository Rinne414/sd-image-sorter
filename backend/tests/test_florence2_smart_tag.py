"""Florence-2 Smart Tag routing with fake local-caption collaborators."""
from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).parent.parent))

from services.smart_tag import caption_phase, pipeline, tagging
from services.smart_tag.jobs import SmartTagJobState
from services.smart_tag.request import SmartTagRequest
from services.smart_tag.results import _booru_partial_from_tag_result


class _FakeFlorenceCaptioner:
    def __init__(self, *, caption: str, error: Exception | None) -> None:
        self._caption = caption
        self._error = error
        self.paths: list[str] = []
        self.loaded = False

    def load(self) -> None:
        self.loaded = True

    def caption(self, image_path: str) -> str:
        self.paths.append(image_path)
        if self._error is not None:
            raise self._error
        return self._caption


def test_phase2_loader_uses_explicit_gpu_policy_without_cpu_fallback(monkeypatch):
    captured: dict[str, object] = {}
    captioner = _FakeFlorenceCaptioner(caption="caption", error=None)

    def get_captioner(*, use_gpu, force_reload):
        captured.update(use_gpu=use_gpu, force_reload=force_reload)
        return captioner

    monkeypatch.setitem(
        sys.modules,
        "model_health",
        SimpleNamespace(
            get_torch_onnx_runtime_health=lambda: {
                "torch_cuda_available": True,
                "runtime_compatible": True,
                "runtime_compatibility_error": None,
            }
        ),
    )
    monkeypatch.setitem(
        sys.modules,
        "florence2_captioner",
        SimpleNamespace(get_florence2_captioner=get_captioner),
    )
    job = SmartTagJobState(job_id="florence2-load")
    request = SmartTagRequest(
        image_ids=[1],
        enable_vlm=True,
        natural_language_mode="florence2",
        use_gpu=True,
    )

    loaded = tagging._load_florence2_for_phase2(job, request)

    assert loaded is captioner
    assert captured == {"use_gpu": True, "force_reload": False}
    assert captioner.loaded is True
    assert "Loading Florence-2" in job.message


def test_caption_phase_persists_required_florence2_prose(monkeypatch):
    persisted: list[tuple[str, str, str]] = []
    monkeypatch.setattr(
        caption_phase,
        "_append_caption_result",
        lambda job, path, caption, booru_text, nl_text: persisted.append(
            (path, caption, nl_text)
        ),
    )
    request = SmartTagRequest(
        image_paths=["C:/fixtures/image.png"],
        enable_wd14=False,
        enable_vlm=True,
        natural_language_mode="florence2",
    )
    partial = _booru_partial_from_tag_result({}, request)
    job = SmartTagJobState(job_id="florence2-caption", total=1)
    captioner = _FakeFlorenceCaptioner(
        caption="A character stands beside a bright window.",
        error=None,
    )
    context = caption_phase._build_caption_phase(request, None, captioner)

    caption_phase._run_caption_phase(
        job,
        request,
        [("path:0", 0, "C:/fixtures/image.png", partial)],
        context,
    )

    assert context.use_florence2 is True
    assert captioner.paths == ["C:/fixtures/image.png"]
    assert persisted == [
        (
            "C:/fixtures/image.png",
            "A character stands beside a bright window.",
            "A character stands beside a bright window.",
        )
    ]
    assert job.succeeded == 1
    assert job.failed == 0


def test_caption_phase_records_florence2_failure_without_tag_only_persistence(
    monkeypatch,
):
    persisted: list[str] = []
    monkeypatch.setattr(
        caption_phase,
        "_append_caption_result",
        lambda job, path, caption, booru_text, nl_text: persisted.append(path),
    )
    request = SmartTagRequest(
        image_paths=["C:/fixtures/image.png"],
        enable_wd14=False,
        enable_vlm=True,
        natural_language_mode="florence2",
    )
    partial = _booru_partial_from_tag_result({}, request)
    job = SmartTagJobState(job_id="florence2-failure", total=1)
    captioner = _FakeFlorenceCaptioner(
        caption="",
        error=RuntimeError("processor returned invalid output"),
    )
    context = caption_phase._build_caption_phase(request, None, captioner)

    caption_phase._run_caption_phase(
        job,
        request,
        [("path:0", 0, "C:/fixtures/image.png", partial)],
        context,
    )

    assert persisted == []
    assert job.succeeded == 0
    assert job.failed == 1
    assert job.errors[-1]["error"] == "processor returned invalid output"


def test_pipeline_routes_florence2_to_local_two_phase_path(monkeypatch):
    routed: dict[str, object] = {}

    class FakeTagger:
        def load(self) -> None:
            routed["tagger_loaded"] = True

    def run_local(job, request, *, tagger):
        routed["mode"] = request.natural_language_mode
        routed["tagger"] = tagger
        job.status = "completed"

    monkeypatch.setattr(pipeline, "_request_total", lambda request: 1)
    monkeypatch.setattr(pipeline, "_resolve_tagger", lambda request: FakeTagger())
    monkeypatch.setattr(
        pipeline,
        "_run_two_phase_local_captioner_pipeline",
        run_local,
    )
    request = SmartTagRequest(
        image_paths=["C:/fixtures/image.png"],
        enable_wd14=True,
        enable_vlm=True,
        natural_language_mode="florence2",
    )
    job = SmartTagJobState(job_id="florence2-route")

    pipeline._run_pipeline(job, request)

    assert routed["tagger_loaded"] is True
    assert routed["mode"] == "florence2"
    assert isinstance(routed["tagger"], FakeTagger)
    assert job.status == "completed"
