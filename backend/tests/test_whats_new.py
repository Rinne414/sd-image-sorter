"""The one-time "what's new" notice after an update.

GET /api/updates/whats-new reads the running version's summary from the
package's release-notes.md and says whether this run follows an update.
"""

from __future__ import annotations

import json


from services import whats_new
from services.whats_new import note_running_version, read_whats_new

NOTES = (
    "## v9.1.0 — 新标题 / New Title\n\n"
    "读图能直接粘贴 QQ 里的图片；导入不再生成 _real.png。\n\n"
    "Reader takes pictures from QQ. Imports write no _real.png.\n\n"
    "---\n\n## Fixed / 修复\n\n- details\n"
)


def test_the_summary_of_the_running_version_is_read(tmp_path):
    (tmp_path / "release-notes.md").write_text(
        NOTES.replace("\n", "\r\n"), encoding="utf-8"
    )
    found = read_whats_new(tmp_path, "9.1.0")
    assert found["available"] is True
    assert found["title"] == "新标题 / New Title"
    assert found["summary_zh"] == "读图能直接粘贴 QQ 里的图片；导入不再生成 _real.png。"
    assert (
        found["summary_en"]
        == "Reader takes pictures from QQ. Imports write no _real.png."
    )
    assert found["notes_url"].endswith("/releases/tag/v9.1.0")


def test_notes_of_another_version_or_none_say_nothing(tmp_path):
    (tmp_path / "release-notes.md").write_text(NOTES, encoding="utf-8")
    assert read_whats_new(tmp_path, "9.1.1")["available"] is False
    assert read_whats_new(tmp_path, "9.1")["available"] is False
    assert read_whats_new(tmp_path / "missing", "9.1.0")["available"] is False


def test_a_new_version_after_a_recorded_one_counts_as_updated(tmp_path):
    (tmp_path / whats_new.STATE_NAME).write_text(
        json.dumps({"version": "9.0.0"}), encoding="utf-8"
    )
    noted = note_running_version(tmp_path, "9.1.0", lambda: False)
    assert noted == {"updated": True, "previous_version": "9.0.0"}
    assert json.loads(
        (tmp_path / whats_new.STATE_NAME).read_text(encoding="utf-8")
    ) == {"version": "9.1.0"}
    # The same process keeps the answer for a reload or a second window.
    assert note_running_version(tmp_path, "9.1.0", lambda: False)["updated"] is True


def test_the_same_version_again_is_not_an_update(tmp_path):
    (tmp_path / whats_new.STATE_NAME).write_text(
        json.dumps({"version": "9.1.0"}), encoding="utf-8"
    )
    assert note_running_version(tmp_path, "9.1.0", lambda: True)["updated"] is False


def test_without_a_record_only_an_install_with_pictures_counts_as_updated(tmp_path):
    fresh = tmp_path / "fresh"
    older = tmp_path / "older"
    assert note_running_version(fresh, "9.1.0", lambda: False)["updated"] is False
    assert note_running_version(older, "9.1.0", lambda: True) == {
        "updated": True,
        "previous_version": None,
    }
    assert (older / whats_new.STATE_NAME).is_file()


def test_the_endpoint_answers_for_the_running_install(
    test_client, tmp_path, monkeypatch
):
    import services.update_service as update_module
    from app_info import APP_VERSION

    (tmp_path / "release-notes.md").write_text(
        NOTES.replace("9.1.0", APP_VERSION), encoding="utf-8"
    )
    monkeypatch.setattr(update_module, "PACKAGE_ROOT", tmp_path)
    body = test_client.get("/api/updates/whats-new").json()
    assert body["available"] is True
    assert body["version"] == APP_VERSION
    assert set(body) == {
        "available",
        "version",
        "title",
        "summary_zh",
        "summary_en",
        "notes_url",
        "updated",
        "previous_version",
    }
