"""VLM Settings tell the page whether Smart Tag's captioner would start.

Walkthrough defect: with no captioner configured, the Smart Tag dialog still
had natural-language captioning on, sent the user through a 446 MB tagger
download, and only then failed at ``/api/smart-tag/start`` with "Natural-
language captioning is enabled, but VLM Settings has no endpoint configured".
The page needs the same verdict BEFORE anything downloads, from the same rule
the start route applies, so ``GET /api/vlm/settings`` now carries it.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from services.smart_tag.request import _coerce_request, vlm_captioner_problem


def _config(**overrides):
    base = dict(
        provider="openai_compat",
        endpoint="",
        api_key="",
        use_vertex=False,
        vertex_project="",
    )
    base.update(overrides)
    return SimpleNamespace(**base)


@pytest.mark.parametrize(
    ("config", "ready"),
    [
        (_config(), False),
        (_config(endpoint="https://api.example.invalid/v1"), False),
        (_config(endpoint="https://api.example.invalid/v1", api_key="sk-x"), True),
        (_config(endpoint="http://127.0.0.1:11434/v1"), True),
        (_config(provider="gemini", use_vertex=True, vertex_project=""), False),
        (_config(provider="gemini", use_vertex=True, vertex_project="proj"), True),
    ],
)
def test_settings_report_the_start_route_verdict(
    test_client, monkeypatch, config, ready
):
    monkeypatch.setattr("routers.vlm._build_config", lambda overrides=None: config)

    body = test_client.get("/api/vlm/settings").json()

    assert body["captioner_ready"] is ready
    problem = vlm_captioner_problem()
    assert body["captioner_problem"] == (problem or "")
    # One rule: the start route refuses exactly when the settings say not ready.
    payload = {"image_ids": [1], "enable_vlm": True, "natural_language_mode": "vlm"}
    if ready:
        assert _coerce_request(payload).enable_vlm is True
    else:
        with pytest.raises(ValueError, match="VLM Settings|VLM configuration"):
            _coerce_request(payload)


def test_an_unloadable_configuration_is_not_ready(test_client, monkeypatch):
    def broken(overrides=None):
        raise RuntimeError("settings file is corrupt")

    monkeypatch.setattr("routers.vlm._build_config", broken)

    body = test_client.get("/api/vlm/settings").json()

    assert body["captioner_ready"] is False
    assert "settings file is corrupt" in body["captioner_problem"]
