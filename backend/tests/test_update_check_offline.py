"""Browser test runs switch update checks off, so the automatic check never reaches GitHub."""

from __future__ import annotations

import urllib.request

from services.update_service import UpdateService


def test_offline_switch_answers_with_an_error_and_never_opens_a_connection(monkeypatch):
    monkeypatch.setenv("SD_IMAGE_SORTER_UPDATE_CHECK_OFFLINE", "1")

    def no_network(*_args, **_kwargs):
        raise AssertionError("the update check must not open a connection")

    monkeypatch.setattr(urllib.request, "urlopen", no_network)

    status = UpdateService().get_status(force=True)

    assert status["has_update"] is False
    assert status["error"]
