"""SEC1d follow-ups to the trusted model folders.

L1: a mapped network drive (``Z:\\models`` -> ``\\\\nas\\share\\models``) added
by the user is trusted, and a candidate on that drive is matched after it
resolves to the UNC, without any stat on the network. L2: the media censor
jobs singleton is built once under concurrent first use. L3: app-settings
read-modify-write is serialised and written atomically. L5: a subfolder of
a system folder needs a confirmation too.
"""

from __future__ import annotations

import json
import os
import threading
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

import model_roots

NAS = r"\\nas\share\models"
DRIVE = r"Z:\models"


@pytest.fixture
def roots(tmp_path, monkeypatch):
    import config

    project = tmp_path / "project"
    data = tmp_path / "data"
    config_dir = data / "config"
    (project / "models").mkdir(parents=True)
    (data / "models").mkdir(parents=True)
    config_dir.mkdir(parents=True)
    monkeypatch.setattr(config, "PROJECT_ROOT", project)
    monkeypatch.setattr(config, "DATA_DIR", data)
    monkeypatch.setattr(config, "CONFIG_DIR", config_dir)
    monkeypatch.setattr(
        config, "APP_SETTINGS_CONFIG_PATH", config_dir / "app-settings.json"
    )
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    return SimpleNamespace(
        project_models=project / "models",
        data_models=data / "models",
        settings=config_dir / "app-settings.json",
        config_dir=config_dir,
        elsewhere=elsewhere,
    )


def _is_network(value) -> bool:
    text = str(value)
    return text.startswith("\\\\") or text.startswith("//") or "nas" in text.lower()


def _map_drive_z(monkeypatch):
    """``Z:`` is a mapped network drive: realpath (what Path.resolve uses)
    answers the UNC the drive points at, and the folder exists there."""
    real_realpath = os.path.realpath

    def fake_realpath(path, *args, **kwargs):
        text = str(path)
        if text[:9].upper() == DRIVE.upper():
            return NAS + text[len(DRIVE) :]
        return real_realpath(path, *args, **kwargs)

    monkeypatch.setattr(os.path, "realpath", fake_realpath)


def _record_network_access(monkeypatch, *modules):
    """Every stat/exists/is_dir/is_file on a network path, through `Path` in
    the given modules or os.stat / os.path, lands in the returned list and
    fails; `is_dir` on the mapped folder answers True (it exists) but is
    still recorded, so a test can assert it was never asked."""
    touched = []

    def _wrap(real, *, answer=None):
        def method(self, *args, **kwargs):
            if _is_network(self):
                touched.append(str(self))
                if answer is not None:
                    return answer
                # Path.resolve() stats its result (3.12, non-strict) and
                # swallows an OSError: a candidate on the mapped drive is
                # always probed once; what must never be probed is the root.
                raise FileNotFoundError(f"network touched: {self}")
            return real(self, *args, **kwargs)

        return method

    class _GuardedPath(Path):
        stat = _wrap(Path.stat)
        exists = _wrap(Path.exists)
        is_dir = _wrap(Path.is_dir, answer=True)
        is_file = _wrap(Path.is_file)

    for module in modules:
        monkeypatch.setattr(module, "Path", _GuardedPath)

    def _wrap_os(real):
        def fn(path, *args, **kwargs):
            if _is_network(path):
                touched.append(str(path))
                raise RuntimeError(f"network touched: {path}")
            return real(path, *args, **kwargs)

        return fn

    monkeypatch.setattr(os, "stat", _wrap_os(os.stat))
    monkeypatch.setattr(os.path, "isdir", _wrap_os(os.path.isdir))
    monkeypatch.setattr(os.path, "isfile", _wrap_os(os.path.isfile))
    monkeypatch.setattr(os.path, "exists", _wrap_os(os.path.exists))
    return touched


class TestMappedNetworkDrive:
    """L1: the owner's NAS mapped to a drive letter."""

    def test_adding_the_mapped_folder_stores_the_share_it_points_at(
        self, roots, monkeypatch
    ):
        _map_drive_z(monkeypatch)
        touched = _record_network_access(monkeypatch, model_roots)
        stored = model_roots.add_trusted_model_folder(DRIVE)
        assert stored == [NAS]
        # the add itself may probe the folder (resolve + is_dir: the user's
        # own action), and nothing else
        assert touched and set(touched) == {NAS}
        probes_during_add = len(touched)
        assert model_roots.describe_trusted_model_folders() == [
            {"path": NAS, "kind": "network", "exists": None}
        ]
        assert len(touched) == probes_during_add  # the listing never asked again

    def test_a_file_on_the_mapped_drive_is_inside_the_trusted_share(
        self, roots, monkeypatch
    ):
        model_roots.add_trusted_model_folder(NAS)
        _map_drive_z(monkeypatch)
        touched = _record_network_access(monkeypatch, model_roots)
        assert model_roots.is_under_allowed_model_root(DRIVE + r"\yolo\seg.pt")
        assert not model_roots.is_under_allowed_model_root(r"Z:\models2\seg.pt")
        # resolving a mapped-drive candidate stats that candidate (inherent);
        # the trusted root itself is never resolved or stat'ed
        assert NAS not in touched
        assert all(path.startswith(NAS[: len(NAS) - len("models")]) for path in touched)

    def test_without_the_trust_the_mapped_drive_is_outside(self, roots, monkeypatch):
        _map_drive_z(monkeypatch)
        touched = _record_network_access(monkeypatch, model_roots)
        assert not model_roots.is_under_allowed_model_root(DRIVE + r"\yolo\seg.pt")
        assert NAS not in touched


class TestSystemSubfolders:
    """L5: C:\\Windows\\System32 and Program Files\\X need a confirmation too."""

    @pytest.mark.skipif(os.name != "nt", reason="Windows system folders")
    def test_subfolders_of_system_folders_need_confirmation(self, roots):
        system_root = Path(os.environ["SystemRoot"]).resolve()
        assert model_roots._wide_folder_reason(system_root / "System32") == "system"
        program_files = Path(os.environ["ProgramFiles"]).resolve()
        assert (
            model_roots._wide_folder_reason(program_files / "SomeVendor" / "models")
            == "system"
        )
        with pytest.raises(model_roots.NeedsConfirmation) as exc:
            model_roots.add_trusted_model_folder(str(system_root / "System32"))
        assert exc.value.reason == "system"
        assert model_roots.list_trusted_model_folders() == []

    def test_an_ordinary_folder_still_needs_none(self, roots):
        assert model_roots._wide_folder_reason(roots.elsewhere.resolve()) is None


class TestMediaCensorJobsSingleton:
    """L2: get_jobs() builds the jobs object once, even when the first
    requests arrive together on threadpool workers."""

    def test_concurrent_first_use_builds_one_instance(self, monkeypatch):
        from routers import censor_media

        built = []

        class _SlowJobs:
            def __init__(self, *, video_censor):
                built.append(self)
                time.sleep(0.05)  # widen the window two callers could fall into

        monkeypatch.setattr(censor_media, "MediaCensorJobs", _SlowJobs)
        monkeypatch.setattr(censor_media, "_jobs", None)
        results = []
        barrier = threading.Barrier(8)

        def worker():
            barrier.wait()
            results.append(censor_media.get_jobs())

        threads = [threading.Thread(target=worker) for _ in range(8)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        assert len(built) == 1
        assert all(result is built[0] for result in results)


class TestAppSettingsWrites:
    """L3: read-modify-write of app-settings.json is serialised and atomic."""

    def test_interleaved_writers_keep_each_others_changes(self, roots, monkeypatch):
        import config
        import config_settings

        config.save_trusted_model_folders([NAS])
        config.save_thumbnail_cache_max_mb(100)
        real_write = config_settings._write_app_settings

        def slow_write(settings):
            time.sleep(0.2)
            real_write(settings)

        monkeypatch.setattr(config_settings, "_write_app_settings", slow_write)

        def remove():
            model_roots.remove_trusted_model_folder(NAS)

        def change_cache():
            time.sleep(0.05)  # starts while the removal is mid-write
            config.save_thumbnail_cache_max_mb(5)

        threads = [
            threading.Thread(target=remove),
            threading.Thread(target=change_cache),
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        settings = json.loads(roots.settings.read_text(encoding="utf-8"))
        assert settings["trusted_model_folders"] == []
        assert settings["thumbnail_cache_max_mb"] == 5

    def test_the_file_is_replaced_atomically_and_no_temp_file_remains(self, roots):
        import config

        config.save_thumbnail_cache_max_mb(7)
        assert (
            json.loads(roots.settings.read_text(encoding="utf-8"))[
                "thumbnail_cache_max_mb"
            ]
            == 7
        )
        assert [p.name for p in roots.config_dir.iterdir()] == ["app-settings.json"]

    def test_a_busy_file_on_windows_is_retried_then_reported(self, roots, monkeypatch):
        import config
        import config_settings

        attempts = []
        real_replace = os.replace

        def flaky_replace(src, dst):
            attempts.append(dst)
            if len(attempts) < 3:
                raise PermissionError("in use")
            return real_replace(src, dst)

        monkeypatch.setattr(config_settings.os, "replace", flaky_replace)
        monkeypatch.setattr(config_settings, "_REPLACE_RETRY_SECONDS", 0.0)
        config.save_thumbnail_cache_max_mb(9)
        assert len(attempts) == 3
        assert (
            json.loads(roots.settings.read_text(encoding="utf-8"))[
                "thumbnail_cache_max_mb"
            ]
            == 9
        )

        def always_busy(src, dst):
            raise PermissionError("in use")

        monkeypatch.setattr(config_settings.os, "replace", always_busy)
        with pytest.raises(OSError) as exc:
            config.save_thumbnail_cache_max_mb(11)
        assert "in use by another program" in str(exc.value) and "占用" in str(
            exc.value
        )
        assert [p.name for p in roots.config_dir.iterdir()] == ["app-settings.json"]
        assert (
            json.loads(roots.settings.read_text(encoding="utf-8"))[
                "thumbnail_cache_max_mb"
            ]
            == 9
        )


OTHER = r"\\nas2\share\models"


class TestTrustedListOwnReadModifySave:
    """Review M1: add and remove read the list, compute and save under the
    settings lock, so a removal is never undone by an add running beside it."""

    def test_remove_and_add_running_together_keep_both_changes(
        self, roots, monkeypatch
    ):
        import config_settings

        model_roots.add_trusted_model_folder(NAS)
        real_write = config_settings._write_app_settings

        def slow_write(settings):
            time.sleep(0.2)
            real_write(settings)

        monkeypatch.setattr(config_settings, "_write_app_settings", slow_write)

        def remove():
            model_roots.remove_trusted_model_folder(NAS)

        def add():
            time.sleep(0.05)  # the removal has read the list and is writing
            model_roots.add_trusted_model_folder(OTHER)

        threads = [threading.Thread(target=remove), threading.Thread(target=add)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        assert model_roots.list_trusted_model_folders() == [OTHER]

    def test_the_folder_checks_run_outside_the_lock(self, roots, monkeypatch):
        """A NAS that hangs while a folder is being added must not hold the
        settings lock: a concurrent thumbnail-limit save still goes through."""
        import config
        import config_settings

        released = threading.Event()

        class _HangingPath(Path):
            def stat(self, *args, **kwargs):
                if "slownas" in str(self):
                    raise FileNotFoundError(str(self))  # resolve() swallows it
                return super().stat(*args, **kwargs)

            def is_dir(self):
                if "slownas" in str(self):
                    released.wait(timeout=5)
                    return True
                return super().is_dir()

        monkeypatch.setattr(model_roots, "Path", _HangingPath)
        real_realpath = os.path.realpath
        monkeypatch.setattr(
            os.path,
            "realpath",
            lambda p, *a, **k: (
                r"\\slownas\share\models"
                if str(p)[:2].upper() == "Y:"
                else real_realpath(p, *a, **k)
            ),
        )
        adder = threading.Thread(
            target=lambda: model_roots.add_trusted_model_folder(r"Y:\models")
        )
        adder.start()
        time.sleep(0.05)
        acquired = config_settings._app_settings_lock.acquire(timeout=1)
        if acquired:
            config_settings._app_settings_lock.release()
        released.set()
        adder.join()
        assert acquired, "the settings lock was held while the folder was probed"
        assert config.save_thumbnail_cache_max_mb(3) == 3


class TestRemoveByMappedSpelling:
    """Review (a): the user deletes `Z:\\models`; the list holds the share."""

    def test_removing_with_the_drive_spelling_finds_the_stored_share(
        self, roots, monkeypatch
    ):
        _map_drive_z(monkeypatch)
        _record_network_access(monkeypatch, model_roots)
        assert model_roots.add_trusted_model_folder(DRIVE) == [NAS]
        assert model_roots.remove_trusted_model_folder(DRIVE) == []
        with pytest.raises(KeyError):
            model_roots.remove_trusted_model_folder(DRIVE)


class TestUnreadableSettingsFile:
    """Review (c): a settings file that exists but cannot be read must never
    be overwritten with a fresh one (every other key would be lost)."""

    @pytest.mark.parametrize("content", ["{not json", "[1, 2]"])
    def test_a_corrupt_file_is_kept_aside_and_the_write_goes_on(self, roots, content):
        """SEC1e (F2): a damaged file (a power cut mid-write) is renamed to
        app-settings.json.corrupt-<stamp>, never overwritten in place, and
        the change is saved into a fresh file."""
        import config

        roots.settings.write_text(content, encoding="utf-8")
        assert config.save_thumbnail_cache_max_mb(5) == 5
        assert model_roots.add_trusted_model_folder(NAS) == [NAS]
        kept = list(roots.settings.parent.glob("app-settings.json.corrupt-*"))
        assert len(kept) == 1 and kept[0].read_text(encoding="utf-8") == content
        assert json.loads(roots.settings.read_text(encoding="utf-8")) == {
            "thumbnail_cache_max_mb": 5,
            "trusted_model_folders": [NAS],
        }

    def test_an_unreadable_file_is_not_overwritten(self, roots, monkeypatch):
        import config

        roots.settings.write_text('{"thumbnail_cache_max_mb": 42}', encoding="utf-8")
        real_read_text = Path.read_text

        def failing_read_text(self, *args, **kwargs):
            if self.name == "app-settings.json":
                raise PermissionError("locked by a sync client")
            return real_read_text(self, *args, **kwargs)

        monkeypatch.setattr(Path, "read_text", failing_read_text)
        with pytest.raises(OSError):
            config.save_thumbnail_cache_max_mb(5)
        monkeypatch.undo()
        assert json.loads(roots.settings.read_text(encoding="utf-8")) == {
            "thumbnail_cache_max_mb": 42
        }


class TestMappedDriveAddPins:
    """Review 4: what the UNC branch of the add really does."""

    def test_a_malformed_resolve_result_is_refused(self, roots, monkeypatch):
        real_realpath = os.path.realpath
        monkeypatch.setattr(
            os.path,
            "realpath",
            lambda p, *a, **k: (
                "\\\\?\\UNC\\nas\\share\\models"
                if str(p)[:2].upper() == "Z:"
                else real_realpath(p, *a, **k)
            ),
        )
        _record_network_access(monkeypatch, model_roots)
        with pytest.raises(ValueError) as exc:
            model_roots.add_trusted_model_folder(DRIVE)
        assert str(exc.value) == model_roots.MALFORMED_NETWORK_FOLDER_ERROR
        assert model_roots.list_trusted_model_folders() == []

    def test_a_drive_mapped_to_a_whole_share_needs_confirmation(
        self, roots, monkeypatch
    ):
        real_realpath = os.path.realpath
        monkeypatch.setattr(
            os.path,
            "realpath",
            lambda p, *a, **k: (
                "\\\\nas\\share" + str(p)[2:]
                if str(p)[:2].upper() == "Z:"
                else real_realpath(p, *a, **k)
            ),
        )
        _record_network_access(monkeypatch, model_roots)
        with pytest.raises(model_roots.NeedsConfirmation) as exc:
            model_roots.add_trusted_model_folder("Z:\\")
        assert exc.value.reason == "share_root"
        assert "share" in str(exc.value) and "共享" in str(exc.value)
        # the share root keeps its root form (`\\nas\share\`): the only
        # spelling is_relative_to matches a file on the share against
        assert model_roots.add_trusted_model_folder("Z:\\", confirm=True) == [
            "\\\\nas\\share\\"
        ]
        assert model_roots.is_under_allowed_model_root("Z:\\lsnet\\best.pth")


class TestPosixSystemFolders:
    """Review 5: /usr, /etc and friends guard their subfolders; /opt and
    /srv, where programs live, only guard themselves."""

    def test_the_rule(self):
        from pathlib import PurePosixPath

        deep = [PurePosixPath(p) for p in model_roots._POSIX_DEEP_SYSTEM_DIRS]
        shallow = [PurePosixPath(p) for p in model_roots._POSIX_SHALLOW_SYSTEM_DIRS]
        reason = model_roots._system_folder_reason
        assert reason(PurePosixPath("/opt/ComfyUI/models"), deep, shallow) is None
        assert reason(PurePosixPath("/srv/models"), deep, shallow) is None
        assert reason(PurePosixPath("/opt"), deep, shallow) == "system"
        assert reason(PurePosixPath("/srv"), deep, shallow) == "system"
        assert reason(PurePosixPath("/usr/share/models"), deep, shallow) == "system"
        assert reason(PurePosixPath("/etc"), deep, shallow) == "system"
        assert reason(PurePosixPath("/home/u/ComfyUI/models"), deep, shallow) is None
