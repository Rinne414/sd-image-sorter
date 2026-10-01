"""Where model weights may be loaded from (SEC1b / SEC1c).

A YOLO ``.pt`` or a generic torch ``.pth`` can only be opened with the full
unpickler, which runs code from the file. Such files are accepted from the
program's own models folders (``PROJECT_ROOT/models``, ``DATA_DIR/models`` and
the ``*_MODEL_DIR`` settings) and from the folders the user added as *trusted
model folders* in Model Center (a ComfyUI install, a NAS), stored in app
settings. A network path is refused before any filesystem access unless it
lies inside a trusted network folder, and a trusted network folder is never
resolved or stat'ed while local files are judged (an offline NAS costs
nothing). The trusted list changes only through the app's own page.
"""

from __future__ import annotations

import ntpath
import os
import re
from pathlib import Path, PureWindowsPath
from typing import Dict, Iterable, List, Optional, Tuple

UNTRUSTED_MODEL_LOCATION_ERROR = (
    "Model files are loaded only from the program's models folder or a trusted "
    "model folder (Model Center). Add this file's folder to the trusted folders, "
    "or move the file into models/. / "
    "模型文件只能从程序的 models 文件夹或模型中心里信任的模型文件夹加载。"
    "请在模型中心把这个文件所在的文件夹加进信任清单，或把文件放进 models 文件夹。"
)
NETWORK_MODEL_PATH_ERROR = (
    "A network path is accepted only inside a trusted model folder (Model Center). / "
    "网络路径只有在信任的模型文件夹里才接受，请先在模型中心加入这个文件夹。"
)
MALFORMED_NETWORK_FOLDER_ERROR = (
    "A network folder must look like \\\\server\\share\\folder. / "
    "网络文件夹要写成 \\\\服务器\\共享名\\文件夹 的形式。"
)
WIDE_FOLDER_ERROR = (
    "This folder is very broad ({reason}): every file under it would be trusted. "
    "Choose the models subfolder instead, or confirm to trust it anyway. / "
    "这个文件夹范围很大（{reason_zh}），里面的所有文件都会被信任。"
    "请改选 models 子文件夹，或确认仍要信任整个文件夹。"
)
_WIDE_REASONS_ZH = {
    "drive_root": "整个磁盘",
    "home": "用户主目录",
    "users_root": "所有用户的目录",
    "system": "系统文件夹",
}

# The settings that place individual model families; a user may point one at
# another drive. Read as values: get_*_dir() would mkdir.
_CONFIGURED_MODEL_DIR_NAMES = (
    "WD14_MODEL_DIR",
    "YOLO_MODEL_DIR",
    "CLIP_MODEL_DIR",
    "ARTIST_MODEL_DIR",
    "SAM3_MODEL_DIR",
    "NUDENET_MODEL_DIR",
    "TORIIGATE_MODEL_DIR",
    "FLORENCE2_MODEL_DIR",
    "OPPAI_ORACLE_MODEL_DIR",
    "LUCIDA_MODEL_DIR",
    "CL_TAGGER_V2_MODEL_DIR",
)
# \\server\share: a real host name (not the ? / . device namespaces, no
# user@port WebDAV forms) and a non-empty share.
_UNC_DRIVE_RE = re.compile(r"^\\\\([A-Za-z0-9][A-Za-z0-9._-]*)\\([^\\]+)$")


class NeedsConfirmation(ValueError):
    """A very broad folder: refused until the user confirms (reason given)."""

    def __init__(self, message: str, reason: str):
        super().__init__(message)
        self.reason = reason


def _config():
    import config

    return config


def _windows_form(raw: object) -> str:
    """The path with every slash as a backslash; pure string work."""
    return str(raw or "").strip().replace("/", "\\")


def is_network_path(raw: object) -> bool:
    """A UNC path in any spelling pathlib or Win32 reads as one (``\\\\s\\x``,
    ``//s/x``, ``\\/s/x``, ``/\\s\\x``) or an NT-namespace path (``\\??\\``);
    pure string test, never touches the filesystem."""
    text = _windows_form(raw)
    return text.startswith("\\\\") or text.startswith("\\??\\")


def _network_key(raw: object) -> Optional[PureWindowsPath]:
    """The comparable form of a network path (case-insensitive, ``..``
    collapsed, Windows rules whatever the host OS), or None when it is not a
    well-formed ``\\\\server\\share`` path. Pure: never touches the network."""
    text = _windows_form(raw)
    if (
        not text.startswith("\\\\")
        or text.startswith("\\\\?\\")
        or text.startswith("\\\\.\\")
    ):
        return None
    normalized = ntpath.normpath(text)
    candidate = PureWindowsPath(normalized)
    if not _UNC_DRIVE_RE.match(candidate.drive or ""):
        return None
    return candidate


def _configured_model_dirs() -> List[str]:
    cfg = _config()
    values = []
    for name in _CONFIGURED_MODEL_DIR_NAMES:
        value = str(getattr(cfg, name, "") or "").strip()
        if value:
            values.append(value)
    return values


def program_model_roots() -> List[Path]:
    """The roots that are always allowed, as configured (nothing is created)."""
    cfg = _config()
    roots = [Path(cfg.PROJECT_ROOT) / "models", Path(cfg.DATA_DIR) / "models"]
    for value in _configured_model_dirs():
        if not is_network_path(value):
            roots.append(Path(value))
    return roots


def list_trusted_model_folders() -> List[str]:
    return list(_config().get_trusted_model_folders())


def _same_folder(first: str, second: str) -> bool:
    if is_network_path(first) or is_network_path(second):
        return (
            is_network_path(first)
            and is_network_path(second)
            and _network_key(first) is not None
            and _network_key(first) == _network_key(second)
        )
    return os.path.normcase(os.path.normpath(first)) == os.path.normcase(
        os.path.normpath(second)
    )


def _wide_folder_reason(folder: Path) -> Optional[str]:
    """Why a local folder is too broad to trust without a confirmation."""
    if folder == Path(folder.anchor):
        return "drive_root"
    try:
        home = Path.home().resolve()
    except (OSError, RuntimeError):
        home = None
    if home is not None:
        if folder == home:
            return "home"
        if folder == home.parent and home.parent != Path(home.anchor):
            return "users_root"
    system_dirs = [
        os.environ.get(name, "")
        for name in (
            "SystemRoot",
            "ProgramFiles",
            "ProgramFiles(x86)",
            "ProgramW6432",
            "ProgramData",
        )
    ]
    if os.name != "nt":
        system_dirs += ["/usr", "/etc", "/bin", "/lib", "/var", "/opt"]
    for value in system_dirs:
        if not value:
            continue
        try:
            if folder == Path(value).resolve():
                return "system"
        except OSError:
            continue
    return None


def _normalize_new_folder(raw: str, *, confirm: bool) -> str:
    text = str(raw or "").strip()
    if not text:
        raise ValueError("Folder path is empty / 文件夹路径是空的")
    if is_network_path(text):
        # Entered by the user in Model Center; the NAS may be offline right
        # now, so it is stored as written and never probed here.
        key = _network_key(text)
        if key is None:
            raise ValueError(MALFORMED_NETWORK_FOLDER_ERROR)
        return str(key)
    folder = Path(os.path.expanduser(text)).resolve()
    if not folder.is_dir():
        raise ValueError(f"Folder does not exist: {text} / 文件夹不存在：{text}")
    reason = _wide_folder_reason(folder)
    if reason and not confirm:
        raise NeedsConfirmation(
            WIDE_FOLDER_ERROR.format(reason=reason, reason_zh=_WIDE_REASONS_ZH[reason]),
            reason,
        )
    return str(folder)


def add_trusted_model_folder(raw: str, *, confirm: bool = False) -> List[str]:
    """Add a folder (deduplicated). A local one must exist and, when it is a
    drive, the home or a system folder, needs ``confirm``. Returns the list."""
    normalized = _normalize_new_folder(raw, confirm=confirm)
    folders = list_trusted_model_folders()
    if not any(_same_folder(normalized, folder) for folder in folders):
        _config().save_trusted_model_folders(folders + [normalized])
    return list_trusted_model_folders()


def remove_trusted_model_folder(raw: str) -> List[str]:
    """Remove a folder; KeyError when it is not in the list. Returns the list."""
    text = str(raw or "").strip()
    if is_network_path(text):
        key_path = _network_key(text)
        key = str(key_path) if key_path is not None else text
    else:
        key = os.path.expanduser(text)
    folders = list_trusted_model_folders()
    kept = [folder for folder in folders if not _same_folder(key, folder)]
    if len(kept) == len(folders):
        raise KeyError(text)
    _config().save_trusted_model_folders(kept)
    return list_trusted_model_folders()


def describe_trusted_model_folders() -> List[Dict[str, object]]:
    """The list as Model Center shows it: path, local/network, exists. A
    network folder is not checked (``exists`` is None): an offline NAS must
    not stall the page."""
    entries: List[Dict[str, object]] = []
    for folder in list_trusted_model_folders():
        if is_network_path(folder):
            entries.append({"path": folder, "kind": "network", "exists": None})
            continue
        try:
            exists = os.path.isdir(folder)
        except OSError:
            exists = False
        entries.append({"path": folder, "kind": "local", "exists": exists})
    return entries


def _network_roots() -> List[PureWindowsPath]:
    """The trusted (and configured) network folders as pure path keys; reads
    the settings file only, never the network."""
    network: List[PureWindowsPath] = []
    for value in _configured_model_dirs() + list_trusted_model_folders():
        if is_network_path(value):
            key = _network_key(value)
            if key is not None:
                network.append(key)
    return network


def _local_roots() -> List[Path]:
    """Local program roots resolved (cheap, local); a trusted local folder
    was resolved when it was added and is used as stored."""
    local: List[Path] = []
    for root in program_model_roots():
        try:
            local.append(root.resolve())
        except (OSError, ValueError):
            continue
    for folder in list_trusted_model_folders():
        if not is_network_path(folder):
            local.append(Path(folder))
    return local


def allowed_model_roots() -> Tuple[List[Path], List[PureWindowsPath]]:
    """(local roots, network roots); network roots are never resolved."""
    return _local_roots(), _network_roots()


def is_under_allowed_model_root(
    path: object, *, extra_roots: Iterable[str] = ()
) -> bool:
    """Resolved path semantics (``is_relative_to``), never a string prefix:
    ``<root>/models2/x.pt`` is outside ``<root>/models``. A network path is
    compared purely against the trusted network roots; a local path is
    resolved and compared against the local roots only, so an offline
    trusted NAS is never touched."""
    text = str(path or "")
    if is_network_path(text):
        key = _network_key(text)
        return key is not None and any(
            key.is_relative_to(root) for root in _network_roots()
        )
    local_roots = _local_roots()
    try:
        resolved = Path(os.path.expanduser(text)).resolve()
    except (OSError, ValueError):
        return False
    for extra in extra_roots:
        if is_network_path(extra):
            continue
        try:
            local_roots.append(Path(os.path.expanduser(str(extra))).resolve())
        except (OSError, ValueError):
            continue
    return any(resolved.is_relative_to(root) for root in local_roots)


def network_path_rejection(raw: object) -> Optional[str]:
    """Before any filesystem access: the error for a network path outside
    every trusted network folder (or in a spelling that is never accepted),
    None for a local path or a trusted one."""
    if not is_network_path(raw):
        return None
    key = _network_key(raw)
    if key is None:
        return NETWORK_MODEL_PATH_ERROR
    if any(key.is_relative_to(root) for root in _network_roots()):
        return None
    return NETWORK_MODEL_PATH_ERROR


def resolve_model_file(
    raw: object, allowed_extensions: set, *, extra_roots: Iterable[str] = ()
) -> str:
    """The absolute path of a model file the user may load; ValueError with
    the user-facing reason otherwise. Order: network rule, extension, allowed
    roots (all without touching the file), then the file checks, so a file
    outside the roots gets the same answer whether it exists or not."""
    from utils.path_validation import validate_file_path

    text = str(raw or "").strip()
    rejection = network_path_rejection(text)
    if rejection:
        raise ValueError(rejection)
    extension = os.path.splitext(text)[1].lower()
    if allowed_extensions and extension not in allowed_extensions:
        raise ValueError(f"File extension '{extension}' not allowed")
    if not is_under_allowed_model_root(text, extra_roots=extra_roots):
        raise ValueError(UNTRUSTED_MODEL_LOCATION_ERROR)
    is_valid, error = validate_file_path(text, allowed_extensions)
    if not is_valid:
        raise ValueError(error or "Invalid model path")
    return str(Path(os.path.expanduser(text)).resolve())
