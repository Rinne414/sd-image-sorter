"""Before anything installs: can the program write to its own folder?

A folder under Program Files, or one owned by another account, makes every
install fail one step at a time with "Access is denied", and people only find
out after a long while that it needed administrator rights. Say so at the start
and offer the way out. Standard library only: this runs before the packages
exist, on any Python the launcher found.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Callable, List, Optional

BACKEND_DIR = Path(__file__).resolve().parent
if (
    str(BACKEND_DIR) not in sys.path
):  # embedded Python does not search next to the script
    sys.path.insert(0, str(BACKEND_DIR))

from folder_access import folder_is_writable  # noqa: E402

EXIT_OK = 0
EXIT_RESTARTED_AS_ADMIN = 10
EXIT_USER_STOPPED = 11
# ShellExecute answers above this number mean it started.
SHELL_EXECUTE_OK = 32

# Where installs and data go, when they already exist; the root covers the rest.
INSTALL_FOLDERS = (
    "",
    "backend",
    "data",
    "backend/venv/Lib/site-packages",
    "python/Lib/site-packages",
)
# Linux and macOS keep packages one level deeper, under the Python version.
INSTALL_FOLDER_PATTERNS = (
    "backend/venv/lib/python*/site-packages",
    "python/lib/python*/site-packages",
)


def unwritable_folders(root: Path) -> List[Path]:
    candidates = [root / relative for relative in INSTALL_FOLDERS]
    for pattern in INSTALL_FOLDER_PATTERNS:
        candidates.extend(sorted(root.glob(pattern)))
    return [
        folder
        for folder in candidates
        if folder.is_dir() and not folder_is_writable(str(folder))
    ]


def _is_admin() -> bool:
    if sys.platform != "win32":
        return False
    import ctypes

    try:
        return bool(ctypes.windll.shell32.IsUserAnAdmin())
    except OSError:
        return False


def _restart_as_admin(launcher: str, root: Path) -> bool:
    """Open the launcher again through the Windows permission prompt; False when it did not start."""
    import ctypes

    result = ctypes.windll.shell32.ShellExecuteW(
        None, "runas", launcher, None, str(root), 1
    )
    return int(result) > SHELL_EXECUTE_OK


def _say(text: str) -> None:
    try:
        print(text, flush=True)
    except UnicodeEncodeError:  # redirected output in a legacy code page
        print(text.encode("ascii", "replace").decode("ascii"), flush=True)


def _explain(folders: List[Path], can_elevate: bool) -> None:
    _say("")
    _say(
        "[WARN] 程序没有权限写入这些文件夹 / The program cannot write to these folders:"
    )
    for folder in folders:
        _say(f"         {folder}")
    _say("       继续的话，安装依赖和保存图库都会失败。")
    _say("       If you go on, installing packages and saving the library will fail.")
    _say("")
    if sys.platform == "win32":
        _say(
            "       推荐：把整个文件夹移到普通位置（例如 D:\\SD-Image-Sorter），以后就不用管理员了。"
        )
        _say(
            "       Best: move the whole folder somewhere normal, for example D:\\SD-Image-Sorter."
        )
    else:
        _say(
            "       推荐：把整个文件夹移到你的主文件夹（例如 ~/SD-Image-Sorter），或者把它的所有者改成你自己。"
        )
        _say(
            "       Best: move the whole folder into your home folder, for example ~/SD-Image-Sorter, or make it yours."
        )
    _say("")
    if can_elevate:
        _say("       [A] 以管理员身份重新打开 / Open again as administrator")
    _say("       [C] 仍然继续 / Go on anyway")
    _say("       [Q] 退出 / Quit")


def check_folder(
    root: Path,
    launcher: str,
    ask: Callable[[str], str] = input,
    is_admin: Callable[[], bool] = _is_admin,
    restart: Callable[[str, Path], bool] = _restart_as_admin,
) -> int:
    folders = unwritable_folders(root)
    if not folders:
        return EXIT_OK
    can_elevate = sys.platform == "win32" and not is_admin()
    _explain(folders, can_elevate)
    while True:
        try:
            answer = ask("> ").strip().lower()
        except EOFError:  # nobody at the keyboard: say it and let the launcher go on
            return EXIT_OK
        if answer == "c":
            return EXIT_OK
        if answer == "q":
            return EXIT_USER_STOPPED
        if answer == "a" and can_elevate:
            if restart(launcher, root):
                return EXIT_RESTARTED_AS_ADMIN
            _say("[WARN] 没有打开管理员窗口 / The administrator window did not open.")


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--launcher", required=True, help="The script to open again as administrator"
    )
    arguments = parser.parse_args(argv)
    return check_folder(BACKEND_DIR.parent, arguments.launcher)


if __name__ == "__main__":
    raise SystemExit(main())
