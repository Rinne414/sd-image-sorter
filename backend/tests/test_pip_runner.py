"""pip progress reaches the progress bar, and a failure says why in plain words."""

from __future__ import annotations

import ast
import os
import subprocess
import sys
from pathlib import Path

import pytest

import folder_access
import install_progress
import optional_dependencies
import pip_runner

# What pip 24.2 really printed for `pip install --progress-bar raw numpy==2.1.3` (2026-11-07).
REAL_PIP_OUTPUT = """Collecting numpy==2.1.3
  Downloading numpy-2.1.3-cp312-cp312-win_amd64.whl.metadata (60 kB)
Downloading numpy-2.1.3-cp312-cp312-win_amd64.whl (12.6 MB)
Progress 0 of 12566858
Progress 262144 of 12566858
Progress 8650752 of 12566858
Progress 12566858 of 12566858
Installing collected packages: numpy
Successfully installed numpy-2.1.3
"""


@pytest.fixture
def reports():
    seen: list[dict] = []
    install_progress.set_listener(lambda **fields: seen.append(fields))
    yield seen
    install_progress.set_listener(None)


def _printing_command(tmp_path: Path, text: str, exit_code: int = 0) -> list[str]:
    source = tmp_path / "output.txt"
    source.write_text(text, encoding="utf-8")
    script = tmp_path / "fake_pip.py"
    script.write_text(
        "import sys\n"
        f"print(open({str(source)!r}, encoding='utf-8').read(), end='', flush=True)\n"
        f"sys.exit({exit_code})\n",
        encoding="utf-8",
    )
    return [sys.executable, str(script)]


def test_each_stage_of_real_pip_output_is_reported(tmp_path, reports):
    pip_runner.run_pip(_printing_command(tmp_path, REAL_PIP_OUTPUT))

    assert reports[0]["stage"] == "resolving"
    first_file = next(r for r in reports if r.get("stage") == "downloading")
    assert first_file["filename"] == "numpy-2.1.3-cp312-cp312-win_amd64.whl"
    assert first_file["file_index"] == 1
    assert first_file["total"] == 12_600_000
    moving = [r for r in reports if r.get("downloaded", 0) > 0]
    assert moving[-1]["downloaded"] == 12566858
    assert moving[-1]["total"] == 12566858
    assert moving[-1]["filename"] == "numpy-2.1.3-cp312-cp312-win_amd64.whl"
    installing = next(r for r in reports if r.get("stage") == "installing")
    assert installing["active"] is False
    assert installing["package_count"] == 1
    assert reports[-1] == install_progress.IDLE


def test_a_metadata_file_is_not_counted_as_a_download(reports):
    pip_runner.PipOutputReader().feed(
        "  Downloading x-1.0-py3-none-any.whl.metadata (2 kB)"
    )
    assert reports == []


def test_byte_counts_never_push_the_reason_for_a_failure_out_of_view(tmp_path, reports):
    output = "this is why it failed\n" + "Progress 1 of 9\n" * 40
    with pytest.raises(subprocess.CalledProcessError) as caught:
        pip_runner.run_pip(_printing_command(tmp_path, output, exit_code=1))
    assert "Progress" not in caught.value.output
    assert "this is why it failed" in pip_runner.explain_pip_failure(caught.value.output)


def test_a_failed_pip_raises_with_its_output_and_clears_the_progress(tmp_path, reports):
    with pytest.raises(subprocess.CalledProcessError) as caught:
        pip_runner.run_pip(_printing_command(tmp_path, "ERROR: boom\n", exit_code=3))
    assert caught.value.returncode == 3
    assert "ERROR: boom" in caught.value.output
    assert reports[-1] == install_progress.IDLE


def test_the_raw_flag_goes_right_after_install(monkeypatch):
    monkeypatch.setattr(pip_runner.importlib.metadata, "version", lambda _name: "24.2")
    assert pip_runner._with_progress_flag(
        ["py", "-m", "pip", "--x", "install", "a"]
    ) == [
        "py",
        "-m",
        "pip",
        "--x",
        "install",
        "--progress-bar=raw",
        "a",
    ]


def test_an_old_pip_runs_without_the_flag_it_would_refuse(monkeypatch):
    monkeypatch.setattr(
        pip_runner.importlib.metadata, "version", lambda _name: "23.3.1"
    )
    assert "--progress-bar=raw" not in pip_runner._with_progress_flag(
        ["py", "-m", "pip", "install", "a"]
    )


def test_an_unwritable_folder_says_so_and_names_it(monkeypatch):
    monkeypatch.setattr(
        pip_runner, "install_folder", lambda: r"C:\Program Files\sorter\site-packages"
    )
    monkeypatch.setattr(pip_runner, "folder_is_writable", lambda _folder: False)
    message = pip_runner.explain_pip_failure(
        "ERROR: [WinError 5] Access is denied: 'x.dll'"
    )
    assert r"C:\Program Files\sorter\site-packages" in message
    assert "管理员" in message
    assert "exit status" not in message


def test_a_file_in_use_is_not_blamed_on_folder_permissions(monkeypatch):
    monkeypatch.setattr(pip_runner, "folder_is_writable", lambda _folder: True)
    message = pip_runner.explain_pip_failure(
        "ERROR: [WinError 5] Access is denied: 'x.dll'"
    )
    assert "管理员" not in message
    assert "占用" in message


@pytest.mark.parametrize(
    ("output", "expected"),
    [
        (
            "WARNING: Retrying ... ConnectTimeoutError ... Connection to pypi.org timed out",
            "网络代理",
        ),
        ("ERROR: No matching distribution found for torch", "网络代理"),
        ("ERROR: [Errno 28] No space left on device", "磁盘空间"),
        (
            "HINT: This error might have occurred since this system does not have Windows Long Path support enabled.",
            "路径太长",
        ),
        ("ERROR: something new", "something new"),
    ],
)
def test_common_failures_are_explained(output, expected):
    assert expected in pip_runner.explain_pip_failure(output)


def test_credentials_in_pip_output_are_not_repeated():
    message = pip_runner.explain_pip_failure(
        "ERROR: failed for https://user:secret@mirror.example/simple"
    )
    assert "secret" not in message


@pytest.mark.parametrize("module", [pip_runner, install_progress, folder_access])
def test_the_repair_scripts_helpers_stay_standard_library_only(module):
    tree = ast.parse(Path(module.__file__).read_text(encoding="utf-8"))
    roots = set()
    for node in tree.body:
        if isinstance(node, ast.Import):
            roots.update(alias.name.split(".")[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            roots.add(node.module.split(".")[0])
    assert roots - set(sys.stdlib_module_names) - {"install_progress", "folder_access"} == set()


def _pip_error(text: str) -> subprocess.CalledProcessError:
    return subprocess.CalledProcessError(1, ["pip"], output=text, stderr="")


def test_a_permission_failure_is_reported_instead_of_retried_as_a_locked_dll(
    monkeypatch,
):
    commands = []

    def failing_pip(command):
        commands.append(command)
        raise _pip_error("ERROR: [WinError 5] Access is denied")

    monkeypatch.setattr(optional_dependencies.platform, "system", lambda: "Windows")
    monkeypatch.setattr(optional_dependencies, "run_pip", failing_pip)
    monkeypatch.setattr(
        optional_dependencies, "install_folder_is_writable", lambda: False
    )
    monkeypatch.setattr(pip_runner, "folder_is_writable", lambda _folder: False)

    with pytest.raises(pip_runner.PipInstallError) as caught:
        optional_dependencies._install_with_resolver(["a==1"], [])

    assert len(commands) == 1
    assert "管理员" in str(caught.value)
    assert "exit status" not in str(caught.value)


def test_a_really_locked_dll_still_gets_its_retry(monkeypatch):
    commands = []

    def locked_then_fine(command):
        commands.append(command)
        if len(commands) == 1:
            raise _pip_error("ERROR: [WinError 5] Access is denied")
        return subprocess.CompletedProcess(command, 0, stdout="", stderr="")

    monkeypatch.setattr(optional_dependencies.platform, "system", lambda: "Windows")
    monkeypatch.setattr(optional_dependencies, "run_pip", locked_then_fine)
    monkeypatch.setattr(
        optional_dependencies, "install_folder_is_writable", lambda: True
    )

    assert optional_dependencies._install_with_resolver(["a==1"], []) is True
    assert "--no-deps" in commands[1]


def test_any_other_failure_reaches_the_user_explained(monkeypatch):
    def failing_pip(_command):
        raise _pip_error("ERROR: No matching distribution found for a==1")

    monkeypatch.setattr(optional_dependencies, "run_pip", failing_pip)
    with pytest.raises(pip_runner.PipInstallError, match="网络代理"):
        optional_dependencies._install_with_resolver(["a==1"], [])


def test_hub_downloads_report_their_bytes_even_with_a_disabled_bar(reports):
    install_progress.watch_hub_downloads()
    from huggingface_hub.utils.tqdm import tqdm as hub_bar

    bar = hub_bar(total=100, unit="B", desc="model.onnx", disable=True)
    bar.update(40)
    bar.update(10)
    assert reports[-1]["stage"] == "downloading"
    assert reports[-1]["filename"] == "model.onnx"
    assert reports[-1]["downloaded"] == 50
    assert reports[-1]["total"] == 100
    bar.close()
    assert reports[-1] == install_progress.IDLE


def test_a_hub_file_count_bar_is_not_mistaken_for_bytes(reports):
    install_progress.watch_hub_downloads()
    from huggingface_hub.utils.tqdm import tqdm as hub_bar

    bar = hub_bar(total=5, desc="Fetching 5 files", disable=True)
    bar.update(1)
    bar.close()
    assert reports == []


def test_a_child_process_reports_through_its_parent(reports):
    script = (
        "import install_progress\n"
        "install_progress.report(active=True, stage='downloading', filename='torch.whl', downloaded=5, total=9)\n"
        "import time; time.sleep(1.2)\n"
    )
    backend = str(Path(install_progress.__file__).parent)
    with install_progress.relay_child_progress() as child_env:
        subprocess.run(
            [sys.executable, "-c", script],
            env={**os.environ, **child_env, "PYTHONPATH": backend},
            check=True,
            timeout=60,
        )
    assert any(
        r.get("filename") == "torch.whl" and r.get("downloaded") == 5 for r in reports
    )
    assert reports[-1] == install_progress.IDLE
