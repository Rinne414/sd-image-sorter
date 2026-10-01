from __future__ import annotations

import io
import subprocess

import launcher_pip


def test_stream_filtered_pip_output_hides_platform_marker_noise(capsys):
    pip_output = io.StringIO(
        "Ignoring cuda-bindings: markers 'sys_platform == \"linux\"' don't match your environment\n"
        "Collecting fastapi\n"
        "Downloading fastapi-0.136.1-py3-none-any.whl\n"
        "Installing collected packages: fastapi\n"
    )

    launcher_pip.stream_filtered_pip_output(pip_output)

    output = capsys.readouterr().out
    assert "Ignoring cuda-bindings" not in output
    assert "Collecting fastapi" in output
    assert "Downloading fastapi" in output
    assert "Installing collected packages" in output


def test_main_runs_current_python_pip_with_filtered_stream(monkeypatch, capsys):
    monkeypatch.setattr(launcher_pip, "non_cpu_onnxruntime_installed", lambda: False)
    calls = []

    class FakeProcess:
        stdout = io.StringIO(
            "Ignoring triton: markers 'sys_platform == \"linux\"' don't match your environment\n"
            "Collecting pillow\n"
        )

        def wait(self):
            return 0

    def fake_popen(command, **kwargs):
        calls.append((command, kwargs))
        return FakeProcess()

    monkeypatch.setattr(launcher_pip.subprocess, "Popen", fake_popen)

    assert launcher_pip.main(["install", "-r", "backend/requirements.txt"]) == 0

    assert calls == [
        (
            [
                launcher_pip.sys.executable,
                "-m",
                "pip",
                "--disable-pip-version-check",
                "install",
                "-r",
                "backend/requirements.txt",
            ],
            {
                "stdout": subprocess.PIPE,
                "stderr": subprocess.STDOUT,
                "text": True,
                "bufsize": 1,
            },
        )
    ]
    output = capsys.readouterr().out
    assert "Ignoring triton" not in output
    assert "Collecting pillow" in output


def test_main_requires_pip_arguments(capsys):
    assert launcher_pip.main([]) == 2
    assert "Usage: python launcher_pip.py" in capsys.readouterr().err


REQUIREMENTS_WITH_ORT = (
    "fastapi==0.136.1\n"
    "onnxruntime==9.9.9 ; sys_platform != 'no-such-platform'\n"
    "onnxruntime==1.0.0 ; sys_platform == 'no-such-platform'\n"
    "onnxruntime-gpu==1.21.0 ; sys_platform != 'no-such-platform'\n"
    "    # via onnxruntime\n"
    "pillow==11.0.0\n"
)


def test_filter_cpu_onnxruntime_drops_only_the_pin_for_this_platform():
    filtered, removed = launcher_pip.filter_cpu_onnxruntime(REQUIREMENTS_WITH_ORT)

    assert removed == 1
    assert "onnxruntime==9.9.9" not in filtered
    # other platform's pin, onnxruntime-gpu, comments and unrelated packages stay
    assert "onnxruntime==1.0.0 ; sys_platform == 'no-such-platform'" in filtered
    assert "onnxruntime-gpu==1.21.0" in filtered
    assert "    # via onnxruntime\n" in filtered
    assert "fastapi==0.136.1\n" in filtered and "pillow==11.0.0\n" in filtered


def test_prepare_pip_args_leaves_everything_alone_without_gpu_onnxruntime(tmp_path, monkeypatch):
    requirements = tmp_path / "requirements-core.txt"
    requirements.write_text(REQUIREMENTS_WITH_ORT, encoding="utf-8")
    monkeypatch.setattr(launcher_pip, "non_cpu_onnxruntime_installed", lambda: False)
    args = ["install", "--no-build-isolation", "-r", str(requirements)]

    new_args, temp_file = launcher_pip.prepare_pip_args(args)

    assert new_args == args
    assert temp_file is None


def test_prepare_pip_args_ignores_installs_without_requirements_file(monkeypatch):
    monkeypatch.setattr(launcher_pip, "non_cpu_onnxruntime_installed", lambda: True)

    assert launcher_pip.prepare_pip_args(["install", "setuptools", "wheel"]) == (
        ["install", "setuptools", "wheel"],
        None,
    )


def test_main_installs_from_filtered_copy_and_deletes_it_when_gpu_onnxruntime_present(tmp_path, monkeypatch, capsys):
    requirements = tmp_path / "requirements-core.txt"
    requirements.write_text(REQUIREMENTS_WITH_ORT, encoding="utf-8")
    monkeypatch.setattr(launcher_pip, "non_cpu_onnxruntime_installed", lambda: True)
    seen = {}

    class FakeProcess:
        stdout = io.StringIO("Collecting fastapi\n")

        def wait(self):
            return 0

    def fake_popen(command, **kwargs):
        used = command[command.index("-r") + 1]
        seen["path"] = used
        seen["text"] = open(used, encoding="utf-8").read()
        return FakeProcess()

    monkeypatch.setattr(launcher_pip.subprocess, "Popen", fake_popen)

    assert launcher_pip.main(["install", "-r", str(requirements)]) == 0

    assert seen["path"] != str(requirements)
    assert "onnxruntime==9.9.9" not in seen["text"]
    assert "pillow==11.0.0" in seen["text"]
    assert not launcher_pip.Path(seen["path"]).exists()
    assert requirements.read_text(encoding="utf-8") == REQUIREMENTS_WITH_ORT
    assert "GPU onnxruntime present, CPU onnxruntime skipped" in capsys.readouterr().out


def test_non_cpu_onnxruntime_installed_uses_metadata_not_import(monkeypatch):
    seen = []

    def fake_distribution(name):
        seen.append(name)
        if name == "onnxruntime-directml":
            return object()
        raise launcher_pip.metadata.PackageNotFoundError(name)

    monkeypatch.setattr(launcher_pip.metadata, "distribution", fake_distribution)

    assert launcher_pip.non_cpu_onnxruntime_installed() is True
    assert seen == ["onnxruntime-gpu", "onnxruntime-directml"]


def test_remove_stale_filtered_files_only_removes_old_launcher_copies(tmp_path):
    old = tmp_path / ".launcher-filtered-old.txt"
    fresh = tmp_path / ".launcher-filtered-fresh.txt"
    other = tmp_path / "requirements-core.txt"
    for path in (old, fresh, other):
        path.write_text("x", encoding="utf-8")
    two_days_ago = launcher_pip.time.time() - 2 * 24 * 60 * 60
    launcher_pip.os.utime(old, (two_days_ago, two_days_ago))

    launcher_pip.remove_stale_filtered_files(tmp_path)

    assert not old.exists()
    assert fresh.exists() and other.exists()


def test_prepare_pip_args_deletes_the_temp_file_when_writing_it_fails(tmp_path, monkeypatch):
    requirements = tmp_path / "requirements-core.txt"
    requirements.write_text(REQUIREMENTS_WITH_ORT, encoding="utf-8")
    spare_temp = tmp_path / "spare-temp"
    spare_temp.mkdir()
    monkeypatch.setattr(launcher_pip, "non_cpu_onnxruntime_installed", lambda: True)
    monkeypatch.setattr(launcher_pip.tempfile, "gettempdir", lambda: str(spare_temp))

    def failing_fdopen(*args, **kwargs):
        raise OSError("disk full")

    monkeypatch.setattr(launcher_pip.os, "fdopen", failing_fdopen)
    args = ["install", "-r", str(requirements)]

    assert launcher_pip.prepare_pip_args(args) == (args, None)
    assert list(tmp_path.glob(".launcher-filtered-*")) == []
    assert list(spare_temp.glob(".launcher-filtered-*")) == []
