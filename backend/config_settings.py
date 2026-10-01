"""Settings-file IO for SD Image Sorter (split from config.py, 2026-07).

Bodies moved VERBATIM from config.py lines 169-280
(split leaf #2):
DEFAULT_THUMBNAIL_CACHE_MAX_MB / MAX_THUMBNAIL_CACHE_MAX_MB, VALID_MIRRORS,
get_download_mirror / save_download_mirror, _read_app_settings /
_write_app_settings, _normalize_thumbnail_cache_max_mb,
get_thumbnail_cache_max_mb / save_thumbnail_cache_max_mb. config.py
re-exports every moved name BY REFERENCE so ``config.<name>`` stays a live
module attribute for the historical consumers (thumbnail_cache.py,
services/disk_service.py, routers/models.py, artist/assets.py,
model_download_sources.py) and the patch seams.

Manifested lines (the ONLY non-verbatim edits): the moved bodies resolve
``DOWNLOAD_MIRROR_CONFIG_PATH`` / ``APP_SETTINGS_CONFIG_PATH`` /
``CONFIG_DIR`` through ``_cfg()`` at CALL time (12 substitutions) because
tests/test_config_env.py, tests/test_disk_service.py and
tests/test_config_pins.py patch those paths on the ``config`` module object
(report hazard H3); a module-top ``from config import <path>`` would freeze
the import-time value, missing those patches, and is the circular shape the
report forbids (config imports this module mid-file).
``DEFAULT_THUMBNAIL_CACHE_MAX_MB`` / ``MAX_THUMBNAIL_CACHE_MAX_MB`` are
OWNED here (not facade-resolved) because
``_normalize_thumbnail_cache_max_mb``'s def-time default argument cannot be
resolved lazily; a full patch-surface census showed nothing patches them
and nothing in config.py's remaining body reads them.
"""
import json
import logging
import os
import tempfile
import threading
import time

# NOTE(decomposition): keep the historical logger channel ("config") so log
# routing and output stay identical to the pre-split single-file module.
logger = logging.getLogger("config")


def _cfg():
    """Resolve the patched path constants through the config facade at call
    time.

    tests/test_config_env.py, tests/test_disk_service.py and
    tests/test_config_pins.py monkeypatch APP_SETTINGS_CONFIG_PATH /
    DOWNLOAD_MIRROR_CONFIG_PATH / CONFIG_DIR on the ``config`` module object;
    an import-time ``from config import <path>`` here would miss those
    patches (similarity_vector_cache._svc() precedent). The lazy import also
    avoids the config <-> config_settings cycle (config imports this module
    mid-file).
    """
    import config

    return config


DEFAULT_THUMBNAIL_CACHE_MAX_MB: int = 500
MAX_THUMBNAIL_CACHE_MAX_MB: int = 102400


VALID_MIRRORS = ("auto", "hf-mirror", "modelscope")


def get_download_mirror() -> str:
    """Return the persisted download mirror, defaulting to "auto".

    Reads CONFIG_DIR/download-mirror.json. Logs (rather than swallows) any
    read error so config corruption is surfaced and not silently masked.
    """
    if not _cfg().DOWNLOAD_MIRROR_CONFIG_PATH.exists():
        return "auto"
    import json as _json
    try:
        raw = _cfg().DOWNLOAD_MIRROR_CONFIG_PATH.read_text(encoding="utf-8")
    except OSError as exc:
        logger.warning(
            "Could not read download mirror config %s: %s; defaulting to 'auto'",
            _cfg().DOWNLOAD_MIRROR_CONFIG_PATH,
            exc,
        )
        return "auto"
    try:
        data = _json.loads(raw)
    except _json.JSONDecodeError as exc:
        logger.warning(
            "Download mirror config %s is corrupt (%s); defaulting to 'auto'",
            _cfg().DOWNLOAD_MIRROR_CONFIG_PATH,
            exc,
        )
        return "auto"
    mirror = str(data.get("mirror", "auto")).strip().lower()
    if mirror not in VALID_MIRRORS:
        logger.warning(
            "Download mirror config has unknown value %r; defaulting to 'auto'",
            mirror,
        )
        return "auto"
    return mirror


def save_download_mirror(mirror: str) -> None:
    mirror = str(mirror).strip().lower()
    if mirror not in VALID_MIRRORS:
        mirror = "auto"
    _cfg().CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    _cfg().DOWNLOAD_MIRROR_CONFIG_PATH.write_text(
        json.dumps({"mirror": mirror}, indent=2),
        encoding="utf-8",
    )


def _read_app_settings() -> dict:
    if not _cfg().APP_SETTINGS_CONFIG_PATH.exists():
        return {}
    try:
        raw = _cfg().APP_SETTINGS_CONFIG_PATH.read_text(encoding="utf-8-sig")
    except (OSError, UnicodeDecodeError) as exc:
        logger.warning("Could not read app settings %s (corrupt or unreadable): %s", _cfg().APP_SETTINGS_CONFIG_PATH, exc)
        return {}
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        logger.warning("App settings file %s is corrupt (%s); using defaults", _cfg().APP_SETTINGS_CONFIG_PATH, exc)
        return {}
    return data if isinstance(data, dict) else {}


# What the page shows. errors.js keeps a short sentence that carries no
# drive path and no errno word; anything longer or more technical collapses
# to a generic "Failed to save" line. The path and the errno go to the log.
SETTINGS_FILE_BUSY_ERROR = (
    "The settings file is in use by another program. Close it and try again. / "
    "设置文件正被其他程序占用，请关闭占用它的程序后重试。"
)
SETTINGS_FILE_UNREADABLE_ERROR = (
    "The settings file could not be read, so this change was not saved. / "
    "设置文件无法读取，这次修改没有保存。"
)


def _set_aside_corrupt_settings(path, why: str) -> None:
    """Rename a settings file that is not a JSON object (a power cut mid-write
    leaves an empty or truncated file) to ``<name>.corrupt-<stamp>`` so the
    data is kept for a look, and the write can go on from the defaults."""
    stamp = time.strftime("%Y%m%d-%H%M%S")
    aside = path.with_name(f"{path.name}.corrupt-{stamp}")
    counter = 1
    while aside.exists():
        counter += 1
        aside = path.with_name(f"{path.name}.corrupt-{stamp}-{counter}")
    try:
        os.replace(path, aside)
    except OSError as exc:
        logger.warning("Could not set aside the corrupt app settings %s (%s): %s", path, why, exc)
        raise OSError(SETTINGS_FILE_UNREADABLE_ERROR) from exc
    logger.warning(
        "App settings file %s is corrupt (%s); kept as %s and starting from the defaults",
        path,
        why,
        aside.name,
    )


def _read_app_settings_for_update() -> dict:
    """The settings to modify and write back. A file that cannot be read
    (locked) is an error here: writing the defaults back would silently drop
    every other key. A file that is not a JSON object is set aside (kept)
    and the update continues from the defaults, so a damaged file never
    wedges the app."""
    path = _cfg().APP_SETTINGS_CONFIG_PATH
    if not path.exists():
        return {}
    try:
        raw = path.read_text(encoding="utf-8-sig")
    except UnicodeDecodeError as exc:
        _set_aside_corrupt_settings(path, f"not UTF-8 text ({exc.reason})")
        return {}
    except OSError as exc:
        logger.warning("Could not read app settings %s for an update (errno %s): %s", path, exc.errno, exc)
        raise OSError(SETTINGS_FILE_UNREADABLE_ERROR) from exc
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        _set_aside_corrupt_settings(path, f"invalid JSON: {exc}")
        return {}
    if not isinstance(data, dict):
        _set_aside_corrupt_settings(path, "not a JSON object")
        return {}
    return data


# Every save_* below is a read-modify-write of the same file; the routes run
# on threadpool workers, so two of them interleaving would write a stale
# copy of the other's key back (a removed trusted folder reappearing).
_app_settings_lock = threading.RLock()
# Windows refuses to replace a file another program holds open (an editor,
# a sync client); a short retry covers the usual momentary hold.
_REPLACE_ATTEMPTS = 5
_REPLACE_RETRY_SECONDS = 0.1


def _write_app_settings(settings: dict) -> None:
    """Write the whole file atomically: a temp file beside it, then
    os.replace, so a crash or a concurrent reader never sees a half file."""
    path = _cfg().APP_SETTINGS_CONFIG_PATH
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(settings, indent=2, sort_keys=True)
    fd, tmp_name = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(payload)
            # A power cut right after the replace must not leave an empty
            # file: the bytes reach the disk before the name does.
            handle.flush()
            os.fsync(handle.fileno())
        for attempt in range(_REPLACE_ATTEMPTS):
            try:
                os.replace(tmp_name, path)
                return
            except PermissionError as exc:
                if attempt == _REPLACE_ATTEMPTS - 1:
                    logger.warning(
                        "Could not replace app settings %s after %d attempts (errno %s): %s",
                        path,
                        _REPLACE_ATTEMPTS,
                        exc.errno,
                        exc,
                    )
                    raise OSError(SETTINGS_FILE_BUSY_ERROR) from exc
                time.sleep(_REPLACE_RETRY_SECONDS)
    finally:
        try:
            os.unlink(tmp_name)
        except FileNotFoundError:
            pass


def _normalize_thumbnail_cache_max_mb(value: object, *, default: int = DEFAULT_THUMBNAIL_CACHE_MAX_MB) -> int:
    try:
        max_mb = int(value)
    except (TypeError, ValueError):
        return default
    if max_mb < 0:
        return default
    return min(max_mb, MAX_THUMBNAIL_CACHE_MAX_MB)


def get_thumbnail_cache_max_mb() -> int:
    raw_env = os.environ.get("SD_IMAGE_SORTER_THUMBNAIL_CACHE_MAX_MB")
    if raw_env is not None:
        try:
            env_value = int(raw_env)
        except ValueError as exc:
            raise ValueError(
                f"Invalid SD_IMAGE_SORTER_THUMBNAIL_CACHE_MAX_MB: expected integer, got {raw_env!r}"
            ) from exc
        if env_value < 0:
            raise ValueError("Invalid SD_IMAGE_SORTER_THUMBNAIL_CACHE_MAX_MB: expected integer >= 0")
        return min(env_value, MAX_THUMBNAIL_CACHE_MAX_MB)

    settings = _read_app_settings()
    return _normalize_thumbnail_cache_max_mb(settings.get("thumbnail_cache_max_mb"))


def save_thumbnail_cache_max_mb(max_mb: int) -> int:
    normalized = _normalize_thumbnail_cache_max_mb(max_mb)
    with _app_settings_lock:
        settings = _read_app_settings_for_update()
        settings["thumbnail_cache_max_mb"] = normalized
        _write_app_settings(settings)
    return normalized


def _normalize_trusted_model_folders(value: object) -> list[str]:
    if not isinstance(value, list):
        return []
    folders: list[str] = []
    for item in value:
        text = str(item or "").strip()
        if text and text not in folders:
            folders.append(text)
    return folders


def get_trusted_model_folders() -> list[str]:
    """Folders the user added in Model Center whose model files load like the
    program's own models folder (model_roots.py); stored as entered."""
    return _normalize_trusted_model_folders(_read_app_settings().get("trusted_model_folders"))


def save_trusted_model_folders(folders: list[str]) -> list[str]:
    return update_trusted_model_folders(lambda _current: list(folders))


def update_trusted_model_folders(update) -> list[str]:
    """Read the list, apply ``update(current) -> new``, save: all under the
    settings lock, so two changes running together never undo each other.
    Returns the stored list."""
    with _app_settings_lock:
        settings = _read_app_settings_for_update()
        current = _normalize_trusted_model_folders(settings.get("trusted_model_folders"))
        new = _normalize_trusted_model_folders(list(update(list(current))))
        if new != current:
            settings["trusted_model_folders"] = new
            _write_app_settings(settings)
    return new
