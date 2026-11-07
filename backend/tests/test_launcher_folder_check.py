"""Starting from a folder the program cannot write to says so at once and offers the way out."""

from __future__ import annotations

from pathlib import Path

import pytest

import launcher_folder_check as check

ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture
def blocked(monkeypatch, tmp_path):
    """A program folder whose root cannot be written."""
    monkeypatch.setattr(
        check, "folder_is_writable", lambda folder: folder != str(tmp_path)
    )
    monkeypatch.setattr(check.sys, "platform", "win32")
    return tmp_path


def _answers(*replies):
    remaining = iter(replies)

    def ask(_prompt):
        try:
            return next(remaining)
        except StopIteration as stop:
            raise EOFError from stop

    return ask


def _never_restart(_launcher, _root):
    raise AssertionError("must not open an administrator window")


def test_a_writable_folder_asks_nothing(tmp_path):
    def ask(_prompt):
        raise AssertionError("must not ask")

    assert check.check_folder(tmp_path, "run.bat", ask=ask) == check.EXIT_OK


def test_it_checks_the_install_folders_that_exist(monkeypatch, tmp_path):
    packages = tmp_path / "backend" / "venv" / "Lib" / "site-packages"
    packages.mkdir(parents=True)
    monkeypatch.setattr(
        check, "folder_is_writable", lambda folder: folder != str(packages)
    )
    assert check.unwritable_folders(tmp_path) == [packages]


def test_the_message_names_the_folder_and_the_way_out(blocked, capsys):
    check.check_folder(blocked, "run.bat", ask=_answers("q"), is_admin=lambda: False)
    said = capsys.readouterr().out
    assert str(blocked) in said
    assert "管理员" in said
    assert "D:\\SD-Image-Sorter" in said


def test_linux_and_macos_get_their_own_way_out(blocked, monkeypatch, capsys):
    # Seen in WSL: a Linux user was told to move the folder to D:\\ and that
    # it would then no longer need administrator rights.
    monkeypatch.setattr(check.sys, "platform", "linux")
    check.check_folder(blocked, "run.sh", ask=_answers("q"), restart=_never_restart)
    said = capsys.readouterr().out
    assert str(blocked) in said
    assert "~/SD-Image-Sorter" in said
    assert "D:\\" not in said
    assert "管理员" not in said
    assert "[A]" not in said


@pytest.mark.parametrize("runtime", ["backend/venv", "python"])
def test_linux_package_folders_are_checked_too(monkeypatch, tmp_path, runtime):
    packages = tmp_path / runtime / "lib" / "python3.12" / "site-packages"
    packages.mkdir(parents=True)
    monkeypatch.setattr(
        check, "folder_is_writable", lambda folder: folder != str(packages)
    )
    assert check.unwritable_folders(tmp_path) == [packages]


def test_run_sh_names_the_folder_when_the_venv_cannot_be_made():
    # Seen in WSL: "go on anyway" in a read-only folder failed with
    # "you may need: sudo apt install python3-venv", the wrong way out.
    script = (ROOT / "run.sh").read_text(encoding="utf-8")
    failure = script[script.index("-m venv backend/venv") :][:900]
    assert '[ -w "backend" ]' in failure
    assert "cannot be written" in failure


def test_a_opens_the_launcher_again_as_administrator(blocked):
    opened = []

    def restart(launcher, root):
        opened.append((launcher, root))
        return True

    code = check.check_folder(
        blocked,
        "C:/x/run.bat",
        ask=_answers("a"),
        is_admin=lambda: False,
        restart=restart,
    )
    assert code == check.EXIT_RESTARTED_AS_ADMIN
    assert opened == [("C:/x/run.bat", blocked)]


def test_a_refused_permission_prompt_asks_again(blocked, capsys):
    code = check.check_folder(
        blocked,
        "run.bat",
        ask=_answers("a", "q"),
        is_admin=lambda: False,
        restart=lambda *_: False,
    )
    assert code == check.EXIT_USER_STOPPED
    assert "did not open" in capsys.readouterr().out


def test_already_administrator_is_not_offered_it_again(blocked, capsys):
    code = check.check_folder(
        blocked,
        "run.bat",
        ask=_answers("a", "c"),
        is_admin=lambda: True,
        restart=_never_restart,
    )
    assert code == check.EXIT_OK
    assert "[A]" not in capsys.readouterr().out


def test_go_on_anyway_goes_on(blocked):
    assert (
        check.check_folder(
            blocked,
            "run.bat",
            ask=_answers("c"),
            is_admin=lambda: False,
            restart=_never_restart,
        )
        == check.EXIT_OK
    )


def test_nobody_at_the_keyboard_never_hangs(blocked):
    assert (
        check.check_folder(
            blocked,
            "run.bat",
            ask=_answers(),
            is_admin=lambda: False,
            restart=_never_restart,
        )
        == check.EXIT_OK
    )


@pytest.mark.parametrize("launcher", ["run.bat", "run.sh"])
def test_the_source_launchers_check_before_they_install(launcher):
    text = (ROOT / launcher).read_text(encoding="utf-8")
    assert text.index("launcher_folder_check.py") < text.index("launcher_pip.py")


def test_no_launcher_passes_a_folder_that_ends_in_a_backslash():
    """`--root "D:\\app\\"` swallows the closing quote, and the check silently never ran."""
    for name in ("run.bat", "run.sh", "scripts/build_release_packages.py"):
        assert "launcher_folder_check.py --root" not in (ROOT / name).read_text(encoding="utf-8")


def test_the_program_folder_is_the_one_holding_the_backend(monkeypatch):
    seen = []
    monkeypatch.setattr(check, "check_folder", lambda root, launcher: seen.append((root, launcher)) or 0)
    assert check.main(["--launcher", "C:/x y/run.bat"]) == 0
    assert seen == [(ROOT, "C:/x y/run.bat")]


def test_the_portable_launcher_checks_before_it_installs():
    text = (ROOT / "scripts" / "build_release_packages.py").read_text(encoding="utf-8")
    bat = text[text.index("def write_portable_launcher") :]
    assert bat.index("launcher_folder_check.py") < bat.index("launcher_pip.py")
    shell = text[text.index('echo "[OK] Using bundled Python') :]
    assert shell.index("launcher_folder_check.py") < shell.index("launcher_pip.py")
