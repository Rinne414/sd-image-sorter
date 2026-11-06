"""Run pip so the program can show what it is doing and say why it failed.

Before this, pip's output was captured until it ended: the progress bar stayed
empty for minutes, and a failure reached the user as "returned non-zero exit
status 1". Standard library plus sibling standard-library-only modules.
"""

from __future__ import annotations

import importlib.metadata
import os
import re
import subprocess
import sysconfig
from typing import List, Optional, Sequence

import install_progress
from folder_access import folder_is_writable

# pip learned --progress-bar=raw ("Progress N of M" lines) in this version.
RAW_PROGRESS_MIN_PIP = (24, 1)
SIZE_UNITS = {"B": 1, "KB": 1000, "MB": 1000**2, "GB": 1000**3}
FAILURE_TAIL_CHARS = 600

_DOWNLOADING_RE = re.compile(
    r"^\s*Downloading\s+(\S+)(?:\s+\(([\d.,]+)\s*([kKMG]?B)\))?"
)
_PROGRESS_RE = re.compile(r"^Progress (\d+) of (\d+)\s*$")
_INSTALLING_RE = re.compile(r"^Installing collected packages:\s*(.+)$")
_CREDENTIALS_RE = re.compile(r"(\w+://)[^/@\s]+@")

PERMISSION_MARKERS = (
    "WinError 5",
    "Access is denied",
    "拒绝访问",
    "存取被拒",
    "Permission denied",
    "Errno 13",
)
LONG_PATH_MARKERS = ("Long Path", "WinError 206", "File name too long")
DISK_FULL_MARKERS = ("No space left on device", "WinError 112", "Errno 28")
NETWORK_MARKERS = (
    "Could not find a version",
    "No matching distribution",
    "Connection",
    "timed out",
    "ProxyError",
    "SSLError",
    "getaddrinfo failed",
    "Temporary failure in name resolution",
    "Max retries exceeded",
)


class PipInstallError(subprocess.CalledProcessError):
    """pip failed; str() is the sentence the user reads."""

    def __init__(self, error: subprocess.CalledProcessError, message: str) -> None:
        super().__init__(
            error.returncode, error.cmd, output=error.output, stderr=error.stderr
        )
        self.message = message

    def __str__(self) -> str:
        return self.message


def install_folder() -> str:
    return sysconfig.get_path("purelib")


def install_folder_is_writable() -> bool:
    return folder_is_writable(install_folder())


def _contains_any(text: str, markers: Sequence[str]) -> bool:
    return any(marker in text for marker in markers)


def _last_error_lines(output: str) -> str:
    lines = [line.strip() for line in output.splitlines() if line.strip()]
    errors = [line for line in lines if line.startswith("ERROR")]
    text = "\n".join(errors or lines[-6:])
    return _CREDENTIALS_RE.sub(r"\1***@", text)[-FAILURE_TAIL_CHARS:]


def explain_pip_failure(output: str) -> str:
    """The reason pip failed and what to do, in the words of the person using the program."""
    if _contains_any(output, LONG_PATH_MARKERS):
        return (
            "The program folder's path is too long for Windows. Move the folder closer to the "
            "drive root, for example D:\\SD-Image-Sorter, then try again. / "
            "程序文件夹的路径太长，Windows 装不下。把文件夹移到靠近盘符的位置"
            "（例如 D:\\SD-Image-Sorter）再试。"
        )
    if _contains_any(output, DISK_FULL_MARKERS):
        return (
            "The disk is full, so the packages could not be installed. Free some space, then "
            "try again. / 磁盘空间不够，包没有装上。腾出空间后再试。"
        )
    if _contains_any(output, PERMISSION_MARKERS):
        folder = install_folder()
        if not folder_is_writable(folder):
            return (
                f"The program cannot write to its own folder ({folder}), so the packages were "
                "not installed. Move the whole program folder somewhere you can write, for "
                "example D:\\SD-Image-Sorter, or run the launcher as administrator once. / "
                f"程序没有权限写入自己的文件夹（{folder}），所以包没有装上。把整个程序文件夹移到"
                "可写入的位置（例如 D:\\SD-Image-Sorter），或右键启动脚本选“以管理员身份运行”。"
            )
        return (
            "Windows refused to replace a file that another program is using. Close other SD "
            "Image Sorter and Python windows, then try again. If it keeps happening, your "
            "antivirus may be holding the file. / Windows 拒绝替换一个正被占用的文件。关掉其他 "
            "SD Image Sorter 和 Python 窗口后再试；如果还是这样，可能是杀毒软件占用了文件。"
        )
    if _contains_any(output, NETWORK_MARKERS):
        return (
            "Could not reach the package server. If you use a proxy, enter its port in Model "
            "Center under Network proxy, then try again. / 连不上包下载服务器。如果你在用代理，"
            "到模型中心的“网络代理”填上端口再试。"
            f"\n{_last_error_lines(output)}"
        )
    return (
        "pip could not install the packages. / pip 没有装上这些包。"
        f"\n{_last_error_lines(output)}"
    )


def _pip_has_raw_progress() -> bool:
    try:
        version = importlib.metadata.version("pip")
        parts = tuple(int(part) for part in version.split(".")[:2])
    except (importlib.metadata.PackageNotFoundError, ValueError):
        return False
    return parts >= RAW_PROGRESS_MIN_PIP


def _with_progress_flag(command: Sequence[str]) -> List[str]:
    arguments = list(command)
    if "install" not in arguments or not _pip_has_raw_progress():
        return arguments
    arguments.insert(arguments.index("install") + 1, "--progress-bar=raw")
    return arguments


def _size_in_bytes(number: Optional[str], unit: Optional[str]) -> int:
    if not number or not unit:
        return 0
    return int(float(number.replace(",", "")) * SIZE_UNITS.get(unit.upper(), 1))


class PipOutputReader:
    """Turns pip's output lines into progress reports."""

    def __init__(self) -> None:
        self.file_index = 0
        self.filename = ""

    def feed(self, line: str) -> None:
        progress = _PROGRESS_RE.match(line)
        if progress:
            install_progress.report(
                active=True,
                stage="downloading",
                filename=self.filename,
                file_index=self.file_index,
                downloaded=int(progress.group(1)),
                total=int(progress.group(2)),
            )
            return
        downloading = _DOWNLOADING_RE.match(line)
        if downloading:
            self._start_file(downloading)
            return
        installing = _INSTALLING_RE.match(line)
        if installing:
            install_progress.report(
                active=False,
                stage="installing",
                filename="",
                downloaded=0,
                total=0,
                package_count=len(installing.group(1).split(",")),
            )

    def _start_file(self, match: "re.Match[str]") -> None:
        name = match.group(1).rsplit("/", 1)[-1]
        if name.endswith(".metadata"):
            return
        self.file_index += 1
        self.filename = name
        install_progress.report(
            active=True,
            stage="downloading",
            filename=name,
            file_index=self.file_index,
            downloaded=0,
            total=_size_in_bytes(match.group(2), match.group(3)),
        )


def run_pip(command: Sequence[str]) -> "subprocess.CompletedProcess[str]":
    """Like subprocess.run(command, check=True, capture_output=True, text=True), reporting as it goes."""
    arguments = _with_progress_flag(command)
    reader = PipOutputReader()
    lines: List[str] = []
    install_progress.report(
        active=False, stage="resolving", filename="", downloaded=0, total=0
    )
    try:
        process = subprocess.Popen(
            arguments,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            encoding="utf-8",
            errors="replace",
            env={**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"},
        )
        assert process.stdout is not None
        with process:
            for line in process.stdout:
                text = line.rstrip("\r\n")
                reader.feed(text)
                # The reason for a failure must not scroll away behind byte counts.
                if not _PROGRESS_RE.match(text):
                    lines.append(line)
            returncode = process.wait()
    finally:
        install_progress.report_idle()
    output = "".join(lines)
    if returncode != 0:
        raise subprocess.CalledProcessError(
            returncode, arguments, output=output, stderr=""
        )
    return subprocess.CompletedProcess(arguments, returncode, stdout=output, stderr="")
