import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from services import disk_service  # noqa: E402
import config  # noqa: E402
import thumbnail_cache  # noqa: E402


def test_cache_status_includes_thumbnail_limit(monkeypatch, tmp_path):
    data_dir = tmp_path / "data"
    config_dir = data_dir / "config"
    thumb_dir = data_dir / "thumbnails"
    monkeypatch.setattr(config, "DATA_DIR", data_dir)
    monkeypatch.setattr(config, "CONFIG_DIR", config_dir)
    monkeypatch.setattr(config, "APP_SETTINGS_CONFIG_PATH", config_dir / "app-settings.json")
    monkeypatch.setattr(config, "THUMBNAIL_DIR", thumb_dir)
    monkeypatch.setattr(thumbnail_cache, "CACHE_DIR", thumb_dir)

    status = disk_service.get_cache_status()

    assert status["settings"]["thumbnail_cache_max_mb"] == 500
    assert status["thumbnail_cache"]["max_size_mb"] == 500


def test_update_cache_settings_persists_and_trims(monkeypatch, tmp_path):
    data_dir = tmp_path / "data"
    config_dir = data_dir / "config"
    thumb_dir = data_dir / "thumbnails"
    thumb_dir.mkdir(parents=True)
    (thumb_dir / "old.webp").write_bytes(b"x" * 200_000)
    monkeypatch.setattr(config, "DATA_DIR", data_dir)
    monkeypatch.setattr(config, "CONFIG_DIR", config_dir)
    monkeypatch.setattr(config, "APP_SETTINGS_CONFIG_PATH", config_dir / "app-settings.json")
    monkeypatch.setattr(config, "THUMBNAIL_DIR", thumb_dir)
    monkeypatch.setattr(thumbnail_cache, "CACHE_DIR", thumb_dir)

    result = disk_service.update_cache_settings(thumbnail_cache_max_mb=0)

    assert result["settings"]["thumbnail_cache_max_mb"] == 0
    assert result["thumbnail_cache"]["total_size_bytes"] == 0
    assert result["limit_cleanup"]["deleted_count"] == 1


def test_cache_status_includes_runtime_environment(monkeypatch, tmp_path):
    state_dir = tmp_path / "data" / "state"
    venv_dir = tmp_path / "backend" / "venv"
    venv_dir.mkdir(parents=True)
    (venv_dir / "heavy-package.bin").write_bytes(b"x" * 1234)

    monkeypatch.setattr(config, "STATE_DIR", state_dir)
    monkeypatch.setattr(disk_service, "_package_root", lambda: tmp_path)

    status = disk_service.get_cache_status()

    runtime = status["runtime_environment"]
    assert runtime["venv_exists"] is True
    assert runtime["venv_size_bytes"] == 1234
    assert runtime["venv_size_complete"] is True
    assert runtime["rebuild_core_pending"] is False


def test_request_core_runtime_rebuild_writes_marker_without_deleting_venv(monkeypatch, tmp_path):
    state_dir = tmp_path / "data" / "state"
    venv_dir = tmp_path / "backend" / "venv"
    venv_dir.mkdir(parents=True)
    (venv_dir / "heavy-package.bin").write_bytes(b"x" * 42)

    monkeypatch.setattr(config, "STATE_DIR", state_dir)
    monkeypatch.setattr(disk_service, "_package_root", lambda: tmp_path)

    result = disk_service.request_core_runtime_rebuild()

    marker = state_dir / disk_service.VENV_REBUILD_MARKER_FILENAME
    assert result["scheduled"] is True
    assert result["restart_required"] is True
    assert marker.exists()
    assert venv_dir.exists()
    assert "rebuild_core_python_runtime" in marker.read_text(encoding="utf-8")
    assert "backend_venv" in marker.read_text(encoding="utf-8")


def test_runtime_environment_size_scan_is_limited(monkeypatch, tmp_path):
    state_dir = tmp_path / "data" / "state"
    venv_dir = tmp_path / "backend" / "venv"
    venv_dir.mkdir(parents=True)
    for index in range(6):
        (venv_dir / f"file-{index}.bin").write_bytes(b"x")

    monkeypatch.setattr(config, "STATE_DIR", state_dir)
    monkeypatch.setattr(disk_service, "_package_root", lambda: tmp_path)
    monkeypatch.setattr(disk_service, "_dir_size_bytes_limited", lambda path: (None, False))

    runtime = disk_service.get_runtime_environment_status()

    assert runtime["venv_exists"] is True
    assert runtime["venv_size_bytes"] is None
    assert runtime["venv_size_complete"] is False

def test_cleanup_pip_cache_ignores_external_env_path(monkeypatch, tmp_path):
    data_dir = tmp_path / "data"
    app_pip_cache = data_dir / "pip-cache"
    external_cache = tmp_path / "external-pip-cache"
    app_pip_cache.mkdir(parents=True)
    external_cache.mkdir(parents=True)
    (app_pip_cache / "owned.whl").write_bytes(b"app")
    (external_cache / "global.whl").write_bytes(b"global")

    monkeypatch.setattr(config, "DATA_DIR", data_dir)
    monkeypatch.setenv("PIP_CACHE_DIR", str(external_cache))

    status = disk_service.get_cache_status()
    pip_entry = next(entry for entry in status["safe_to_clean"] if entry["key"] == "pip_cache")
    assert Path(pip_entry["path"]) == app_pip_cache.resolve()

    result = disk_service.clean_caches(["pip_cache"])

    assert result["errors"] == []
    assert not (app_pip_cache / "owned.whl").exists()
    assert (external_cache / "global.whl").exists()


def test_runtime_environment_detects_portable_python(monkeypatch, tmp_path):
    state_dir = tmp_path / "data" / "state"
    portable_python = tmp_path / "python"
    site_packages = portable_python / "Lib" / "site-packages"
    scripts_dir = portable_python / "Scripts"
    site_packages.mkdir(parents=True)
    scripts_dir.mkdir(parents=True)
    (site_packages / "heavy.py").write_bytes(b"x" * 100)
    (scripts_dir / "tool.exe").write_bytes(b"y" * 23)

    monkeypatch.setattr(config, "STATE_DIR", state_dir)
    monkeypatch.setattr(disk_service, "_package_root", lambda: tmp_path)
    monkeypatch.setattr(disk_service.sys, "executable", str(portable_python / "python.exe"))

    runtime = disk_service.get_runtime_environment_status()

    assert runtime["runtime_kind"] == "portable"
    assert runtime["runtime_rebuild_target"] == "embedded_python_packages"
    assert runtime["runtime_path"] == str(portable_python.resolve())
    assert runtime["venv_size_bytes"] == 123


def test_request_core_runtime_rebuild_records_portable_target(monkeypatch, tmp_path):
    state_dir = tmp_path / "data" / "state"
    portable_python = tmp_path / "python"
    (portable_python / "Lib" / "site-packages").mkdir(parents=True)

    monkeypatch.setattr(config, "STATE_DIR", state_dir)
    monkeypatch.setattr(disk_service, "_package_root", lambda: tmp_path)
    monkeypatch.setattr(disk_service.sys, "executable", str(portable_python / "python.exe"))

    result = disk_service.request_core_runtime_rebuild()

    marker = state_dir / disk_service.VENV_REBUILD_MARKER_FILENAME
    payload = marker.read_text(encoding="utf-8")
    assert result["runtime_environment"]["runtime_kind"] == "portable"
    assert '"runtime_kind": "portable"' in payload
    assert '"rebuild_target": "embedded_python_packages"' in payload
    assert '"venv_path"' not in payload



def test_cache_status_lists_only_app_owned_cache_as_safe(monkeypatch, tmp_path):
    data_dir = tmp_path / "data"
    external_cache = tmp_path / "external-cache"
    app_cache = data_dir / "cache"
    external_cache.mkdir(parents=True)
    app_cache.mkdir(parents=True)
    (external_cache / "external.bin").write_bytes(b"external")
    (app_cache / "owned.bin").write_bytes(b"owned")

    monkeypatch.setattr(config, "DATA_DIR", data_dir)
    monkeypatch.setenv("SD_IMAGE_SORTER_CACHE_DIR", str(external_cache))

    status = disk_service.get_cache_status()
    cache_entry = next(entry for entry in status["safe_to_clean"] if entry["key"] == "cache")

    assert Path(cache_entry["path"]) == app_cache.resolve()


def test_cache_size_scans_do_not_follow_symlinks(monkeypatch, tmp_path):
    if not hasattr(Path, "symlink_to"):
        return
    data_dir = tmp_path / "data"
    cache_dir = data_dir / "cache"
    external_dir = tmp_path / "external-target"
    cache_dir.mkdir(parents=True)
    external_dir.mkdir()
    (external_dir / "large.bin").write_bytes(b"x" * 4096)
    link = cache_dir / "external-link"
    try:
        link.symlink_to(external_dir, target_is_directory=True)
    except (OSError, NotImplementedError):
        return

    monkeypatch.setattr(config, "DATA_DIR", data_dir)

    assert disk_service._dir_size_bytes_limited(cache_dir) == (0, True)
    assert disk_service._dir_size_bytes(cache_dir) == 0

    root_link = data_dir / "cache-root-link"
    try:
        root_link.symlink_to(external_dir, target_is_directory=True)
    except (OSError, NotImplementedError):
        return
    assert disk_service._dir_size_bytes_limited(root_link) == (0, True)
    assert disk_service._dir_size_bytes(root_link) == 0



def test_clean_caches_refuses_symlinked_cache_directory(monkeypatch, tmp_path):
    data_dir = tmp_path / "data"
    external_dir = tmp_path / "external-target"
    data_dir.mkdir()
    external_dir.mkdir()
    (external_dir / "do-not-delete.bin").write_bytes(b"keep")
    cache_link = data_dir / "cache"
    try:
        cache_link.symlink_to(external_dir, target_is_directory=True)
    except (OSError, NotImplementedError):
        return

    monkeypatch.setattr(config, "DATA_DIR", data_dir)

    result = disk_service.clean_caches(["cache"])

    assert result["cleaned"] == []
    assert result["errors"]
    assert "symlinked cache directory" in result["errors"][0]["error"]
    assert (external_dir / "do-not-delete.bin").exists()



def test_safe_cleanup_paths_ignore_external_tmp_and_thumbnail_env(monkeypatch, tmp_path):
    data_dir = tmp_path / "data"
    external_tmp = tmp_path / "external-tmp"
    external_thumbnails = tmp_path / "external-thumbnails"
    app_tmp = data_dir / "tmp"
    app_thumbnails = data_dir / "thumbnails"
    external_tmp.mkdir(parents=True)
    external_thumbnails.mkdir(parents=True)
    app_tmp.mkdir(parents=True)
    app_thumbnails.mkdir(parents=True)
    (external_tmp / "external.tmp").write_bytes(b"external")
    (external_thumbnails / "external.webp").write_bytes(b"external")
    (app_tmp / "owned.tmp").write_bytes(b"owned")
    (app_thumbnails / "owned.webp").write_bytes(b"owned")

    monkeypatch.setattr(config, "DATA_DIR", data_dir)
    monkeypatch.setattr(config, "TEMP_DIR", external_tmp)
    monkeypatch.setattr(config, "THUMBNAIL_DIR", external_thumbnails)

    status = disk_service.get_cache_status()
    entries = {entry["key"]: entry for entry in status["safe_to_clean"]}
    preserved_entries = {entry["key"]: entry for entry in status["preserved"]}

    assert Path(entries["tmp"]["path"]) == app_tmp.resolve()
    assert Path(entries["thumbnails"]["path"]) == app_thumbnails.resolve()
    assert "external_runtime_cache" in preserved_entries
    assert str(external_tmp.resolve()) in preserved_entries["external_runtime_cache"]["path"]
    assert str(external_thumbnails.resolve()) in preserved_entries["external_runtime_cache"]["path"]

    result = disk_service.clean_caches(["tmp", "thumbnails"])

    assert result["errors"] == []
    assert not (app_tmp / "owned.tmp").exists()
    assert not (app_thumbnails / "owned.webp").exists()
    assert (external_tmp / "external.tmp").exists()
    assert (external_thumbnails / "external.webp").exists()
