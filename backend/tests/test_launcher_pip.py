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
