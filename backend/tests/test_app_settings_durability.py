"""SEC1e: app-settings.json on a machine that loses power, and what the page
hears when a settings write fails.

F2: the temp file is flushed and fsync'ed before os.replace; a file that is
empty, not JSON or not an object is set aside as
``app-settings.json.corrupt-<stamp>`` (warning logged) and the write goes on
from ``{}``; a file that cannot be read (locked) still aborts the write.
F1: the trusted-folder POST/DELETE and the disk settings POST answer 503
with the bilingual reason when the write fails.
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path

import pytest

import config
import config_settings


@pytest.fixture
def settings_file(tmp_path, monkeypatch):
    """The settings file under pytest's tmp dir, never the owner's data/config."""
    config_dir = tmp_path / "config"
    config_dir.mkdir()
    path = config_dir / "app-settings.json"
    project_data = (Path(__file__).resolve().parents[2] / "data").resolve()
    assert not path.resolve().is_relative_to(project_data), path
    assert path.is_relative_to(tmp_path)
    monkeypatch.setattr(config, "CONFIG_DIR", config_dir)
    monkeypatch.setattr(config, "APP_SETTINGS_CONFIG_PATH", path)
    return path


class TestWriteDurability:
    def test_the_temp_file_is_flushed_and_fsynced_before_the_replace(
        self, settings_file, monkeypatch
    ):
        order = []
        real_fsync, real_replace = os.fsync, os.replace
        monkeypatch.setattr(
            config_settings.os,
            "fsync",
            lambda fd: (order.append("fsync"), real_fsync(fd)),
        )
        monkeypatch.setattr(
            config_settings.os,
            "replace",
            lambda src, dst: (order.append("replace"), real_replace(src, dst)),
        )
        assert config.save_thumbnail_cache_max_mb(5) == 5
        assert order == ["fsync", "replace"]
        assert (
            json.loads(settings_file.read_text(encoding="utf-8"))[
                "thumbnail_cache_max_mb"
            ]
            == 5
        )

    @pytest.mark.parametrize(
        "content", ["", "   \n", "{not json", "[1, 2]", '"just a string"']
    )
    def test_a_corrupt_file_is_set_aside_and_the_write_goes_on(
        self, settings_file, content, caplog
    ):
        settings_file.write_text(content, encoding="utf-8")
        with caplog.at_level(logging.WARNING, logger="config"):
            assert config.save_thumbnail_cache_max_mb(5) == 5
        assert json.loads(settings_file.read_text(encoding="utf-8")) == {
            "thumbnail_cache_max_mb": 5
        }
        set_aside = [
            p
            for p in settings_file.parent.iterdir()
            if p.name.startswith("app-settings.json.corrupt-")
        ]
        assert len(set_aside) == 1
        assert set_aside[0].read_text(encoding="utf-8") == content
        assert [
            p.name for p in settings_file.parent.iterdir() if p.name.endswith(".tmp")
        ] == []
        assert any("corrupt" in record.getMessage() for record in caplog.records)

    def test_two_corrupt_files_in_a_row_keep_both_copies(self, settings_file):
        settings_file.write_text("{bad one", encoding="utf-8")
        config.save_thumbnail_cache_max_mb(1)
        settings_file.write_text("{bad two", encoding="utf-8")
        config.save_thumbnail_cache_max_mb(2)
        copies = sorted(
            p.read_text(encoding="utf-8")
            for p in settings_file.parent.glob("app-settings.json.corrupt-*")
        )
        assert copies == ["{bad one", "{bad two"]

    def test_a_locked_file_still_aborts_the_write(self, settings_file, monkeypatch):
        settings_file.write_text('{"thumbnail_cache_max_mb": 42}', encoding="utf-8")
        real_read_text = Path.read_text

        def locked_read_text(self, *args, **kwargs):
            if self.name == "app-settings.json":
                raise PermissionError("locked by a sync client")
            return real_read_text(self, *args, **kwargs)

        monkeypatch.setattr(Path, "read_text", locked_read_text)
        with pytest.raises(OSError) as exc:
            config.save_thumbnail_cache_max_mb(5)
        monkeypatch.undo()
        assert "设置文件" in str(exc.value)
        assert json.loads(settings_file.read_text(encoding="utf-8")) == {
            "thumbnail_cache_max_mb": 42
        }
        assert list(settings_file.parent.glob("app-settings.json.corrupt-*")) == []


class TestEndpointsReportWriteFailures:
    """F1: the page shows `error` from the JSON body, so a 503 carries the
    bilingual reason there."""

    MESSAGE = "Could not update app settings X: the file is in use by another program. / 无法更新设置文件 X：文件正被其他程序占用。"

    def test_trusted_folder_add_and_remove_answer_503(self, test_client, monkeypatch):
        import model_roots

        def fail(*_args, **_kwargs):
            raise OSError(self.MESSAGE)

        monkeypatch.setattr(model_roots, "add_trusted_model_folder", fail)
        monkeypatch.setattr(model_roots, "remove_trusted_model_folder", fail)
        added = test_client.post(
            "/api/models/trusted-folders", json={"path": r"\\nas\share\models"}
        )
        assert added.status_code == 503, added.text
        assert added.json()["error"] == self.MESSAGE
        removed = test_client.request(
            "DELETE",
            "/api/models/trusted-folders",
            json={"path": r"\\nas\share\models"},
        )
        assert removed.status_code == 503, removed.text
        assert removed.json()["error"] == self.MESSAGE

    def test_disk_settings_answer_503(self, test_client, monkeypatch):
        from services import disk_service

        def fail(**_kwargs):
            raise OSError(self.MESSAGE)

        monkeypatch.setattr(disk_service, "update_cache_settings", fail)
        response = test_client.post(
            "/api/disk/settings", json={"thumbnail_cache_max_mb": 5}
        )
        assert response.status_code == 503, response.text
        assert response.json()["error"] == self.MESSAGE


DRIVE_PATH = __import__("re").compile(r"[A-Za-z]:\\")


def _is_user_visible(message: str) -> bool:
    """What errors.js keeps instead of collapsing to a generic line: short,
    no drive path, no errno words."""
    jargon = __import__("re").compile(
        r"(?:\b(?:ENOENT|EACCES|EPERM|ENOSPC|Errno)\b|https?://|/api/|[A-Za-z]:\\| at .+\(|stack trace)",
        __import__("re").IGNORECASE,
    )
    return len(message) < 180 and not jargon.search(message)


class TestUserVisibleMessages:
    """Review C1: the HTTP detail is a short bilingual sentence the page can
    show; the path and errno go to the server log only."""

    @pytest.mark.skipif(
        os.name != "nt", reason="an open handle blocks os.replace on Windows only"
    )
    def test_a_file_held_open_by_another_program(
        self, settings_file, monkeypatch, caplog
    ):
        settings_file.write_text('{"thumbnail_cache_max_mb": 42}', encoding="utf-8")
        monkeypatch.setattr(config_settings, "_REPLACE_RETRY_SECONDS", 0.0)
        with settings_file.open(
            "r", encoding="utf-8"
        ):  # a real handle without delete sharing
            with caplog.at_level(logging.WARNING, logger="config"):
                with pytest.raises(OSError) as exc:
                    config.save_thumbnail_cache_max_mb(5)
        message = str(exc.value)
        assert message == config_settings.SETTINGS_FILE_BUSY_ERROR
        assert "占用" in message and "in use" in message
        assert _is_user_visible(message)
        assert not DRIVE_PATH.search(message)
        # the server log carries what the page must not: path and errno
        assert any(
            str(settings_file) in r.getMessage() and "errno" in r.getMessage().lower()
            for r in caplog.records
        )
        assert json.loads(settings_file.read_text(encoding="utf-8")) == {
            "thumbnail_cache_max_mb": 42
        }

    @pytest.mark.skipif(os.name != "nt", reason="byte-range locks via msvcrt")
    def test_a_file_locked_for_reading(self, settings_file, caplog):
        import msvcrt

        settings_file.write_text('{"thumbnail_cache_max_mb": 42}', encoding="utf-8")
        with settings_file.open("r+b") as handle:
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 64)
            try:
                with caplog.at_level(logging.WARNING, logger="config"):
                    with pytest.raises(OSError) as exc:
                        config.save_thumbnail_cache_max_mb(5)
            finally:
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 64)
        message = str(exc.value)
        assert message == config_settings.SETTINGS_FILE_UNREADABLE_ERROR
        assert _is_user_visible(message) and "设置文件" in message
        assert any(str(settings_file) in r.getMessage() for r in caplog.records)
        assert json.loads(settings_file.read_text(encoding="utf-8")) == {
            "thumbnail_cache_max_mb": 42
        }

    def test_the_endpoint_messages_are_the_short_sentences(
        self, settings_file, test_client, monkeypatch
    ):
        import model_roots

        def busy(*_args, **_kwargs):
            raise OSError(config_settings.SETTINGS_FILE_BUSY_ERROR)

        monkeypatch.setattr(model_roots, "add_trusted_model_folder", busy)
        response = test_client.post(
            "/api/models/trusted-folders", json={"path": r"\\nas\share\models"}
        )
        assert response.status_code == 503
        assert _is_user_visible(response.json()["error"])


class TestNonUtf8SettingsFiles:
    """Review C2: a GBK or UTF-16 file is damage, not a crash; a UTF-8 BOM
    on valid JSON is fine."""

    @pytest.mark.parametrize(
        "raw",
        [
            '{"thumbnail_cache_max_mb": 5, "note": "中文"}'.encode("gbk"),
            '{"thumbnail_cache_max_mb": 5}'.encode("utf-16"),
        ],
        ids=["gbk", "utf-16"],
    )
    def test_undecodable_files_are_damage(self, settings_file, raw, caplog):
        import model_roots

        settings_file.write_bytes(raw)
        with caplog.at_level(logging.WARNING, logger="config"):
            # the display read falls back to the defaults, with a warning
            assert (
                config.get_thumbnail_cache_max_mb()
                == config.DEFAULT_THUMBNAIL_CACHE_MAX_MB
            )
            assert config.get_trusted_model_folders() == []
            assert model_roots.list_trusted_model_folders() == []
            # the update read sets the file aside and the write goes on
            assert config.save_thumbnail_cache_max_mb(7) == 7
        assert json.loads(settings_file.read_text(encoding="utf-8")) == {
            "thumbnail_cache_max_mb": 7
        }
        kept = list(settings_file.parent.glob("app-settings.json.corrupt-*"))
        assert len(kept) == 1 and kept[0].read_bytes() == raw
        assert sum("corrupt" in r.getMessage() for r in caplog.records) >= 1

    def test_a_utf8_bom_on_valid_json_reads_fine(self, settings_file):
        settings_file.write_bytes(
            b"\xef\xbb\xbf"
            + json.dumps(
                {"thumbnail_cache_max_mb": 9, "trusted_model_folders": ["C:\\m"]}
            ).encode("utf-8")
        )
        assert config.get_thumbnail_cache_max_mb() == 9
        assert config.get_trusted_model_folders() == ["C:\\m"]
        assert config.save_thumbnail_cache_max_mb(11) == 11
        assert json.loads(settings_file.read_text(encoding="utf-8")) == {
            "thumbnail_cache_max_mb": 11,
            "trusted_model_folders": ["C:\\m"],
        }
        assert list(settings_file.parent.glob("app-settings.json.corrupt-*")) == []


class TestDiskSettingsCleanupFailure:
    """Review INFO: once the limit is saved, a cleanup that fails must not
    look like a failed save."""

    def test_saved_limit_answers_200_with_a_warning_when_cleanup_fails(
        self, settings_file, test_client, monkeypatch, caplog
    ):
        import thumbnail_cache

        def failing_cleanup(**_kwargs):
            raise OSError("[Errno 13] Permission denied: 'C:\\\\thumbs\\\\x.jpg'")

        monkeypatch.setattr(
            thumbnail_cache, "enforce_cache_size_limit", failing_cleanup
        )
        with caplog.at_level(logging.WARNING):
            response = test_client.post(
                "/api/disk/settings", json={"thumbnail_cache_max_mb": 5}
            )
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["settings"]["thumbnail_cache_max_mb"] == 5
        assert body["limit_cleanup_warning"] and _is_user_visible(
            body["limit_cleanup_warning"]
        )
        assert (
            json.loads(settings_file.read_text(encoding="utf-8"))[
                "thumbnail_cache_max_mb"
            ]
            == 5
        )
        assert any("Errno 13" in r.getMessage() for r in caplog.records)
