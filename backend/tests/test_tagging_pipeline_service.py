"""Contracts for the unified tagging pipeline boundary."""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import HTTPException


class _FakeLegacyTaggingService:
    def __init__(self, progress=None):
        self.progress = progress or {"status": "idle"}
        self.started = False
        self.cancelled = False

    def get_progress(self):
        return dict(self.progress)

    def start_tagging(self, request, background_tasks):
        self.started = True
        return {"status": "started", "message": "legacy started"}

    def cancel_tagging(self):
        self.cancelled = True
        self.progress = {"status": "cancelled"}
        return {"status": "cancelled", "message": "legacy cancelled"}


def test_unified_pipeline_blocks_gallery_tagging_while_smart_tag_is_active(monkeypatch):
    from services import tagging_pipeline_service
    from services.tagging_pipeline_service import TaggingPipelineService
    from services.tagging_service import TagRequest

    service = TaggingPipelineService()
    legacy = _FakeLegacyTaggingService()
    monkeypatch.setattr(
        tagging_pipeline_service.smart_tag_service,
        "get_active_job",
        lambda: SimpleNamespace(job_id="smart-active", status="running"),
    )

    with pytest.raises(HTTPException) as exc:
        service.start_gallery_tagging(TagRequest(image_ids=[1]), background_tasks=None, legacy_service=legacy)

    assert exc.value.status_code == 409
    assert "Smart Tag" in str(exc.value.detail)
    assert legacy.started is False


def test_unified_pipeline_blocks_smart_tagging_while_gallery_tag_is_active(monkeypatch):
    from services import tagging_pipeline_service
    from services.tagging_pipeline_service import TaggingPipelineService

    service = TaggingPipelineService()
    legacy = _FakeLegacyTaggingService(progress={"status": "running", "message": "Tagging 1/10"})
    monkeypatch.setattr(
        tagging_pipeline_service.smart_tag_service,
        "start_smart_tag_job",
        lambda _payload: pytest.fail("smart tag should not start while gallery tagging is active"),
    )

    with pytest.raises(RuntimeError) as exc:
        service.start_smart_tagging({"image_ids": [1]}, legacy_service=legacy)

    assert "AI Tag" in str(exc.value)


def test_unified_pipeline_adds_owner_metadata_to_both_start_paths(monkeypatch):
    from services import tagging_pipeline_service
    from services.tagging_pipeline_service import TaggingPipelineService
    from services.tagging_service import TagRequest

    service = TaggingPipelineService()
    legacy = _FakeLegacyTaggingService()
    monkeypatch.setattr(tagging_pipeline_service.smart_tag_service, "get_active_job", lambda: None)
    monkeypatch.setattr(
        tagging_pipeline_service.smart_tag_service,
        "start_smart_tag_job",
        lambda _payload: {"job_id": "smart-1", "status": "queued"},
    )

    gallery = service.start_gallery_tagging(TagRequest(image_ids=[1]), background_tasks=None, legacy_service=legacy)
    smart = service.start_smart_tagging({"image_ids": [1]}, legacy_service=legacy)

    assert gallery["pipeline_owner"] == "unified-tagging"
    assert gallery["pipeline_mode"] == "gallery-tag"
    assert smart["pipeline_owner"] == "unified-tagging"
    assert smart["pipeline_mode"] == "smart-tag"
