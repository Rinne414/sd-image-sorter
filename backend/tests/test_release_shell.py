"""The Windows release package carries the desktop shell next to run-portable.bat.

Only a small launcher (SD Image Sorter.exe) sits at the top of the package;
the Electron shell and its ~20 loose files live in the desktop/ folder. Both
are added after the package manifest so the in-app updater never manages
them, the shell is recorded in the release manifest with its own version, and
none of it goes into any other package. The browser extension sources ship in every package so the program
can build the Chrome and Firefox folders on demand.
"""

from __future__ import annotations

import importlib.util
import json
import sys
import tarfile
import zipfile
from pathlib import Path

import pytest
from typing import NamedTuple

ROOT = Path(__file__).resolve().parents[2]


class _ShellBuild(NamedTuple):
    unpacked: Path
    launcher: Path


def _load(module_name: str, relative_path: str):
    spec = importlib.util.spec_from_file_location(module_name, ROOT / relative_path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def builder():
    return _load(
        "build_release_packages_for_shell_test", "scripts/build_release_packages.py"
    )


@pytest.fixture
def shell():
    return _load("release_shell_for_test", "scripts/release_shell.py")


@pytest.fixture
def qa():
    return _load("lazy_release_qa_for_shell_test", "scripts/lazy_release_qa.py")


def _unpacked_shell(folder: Path):
    files = {
        "sd-image-sorter-shell.exe": b"MZ",
        "resources.pak": b"pak",
        "resources/app.asar": b"asar",
        "locales/en-US.pak": b"en",
    }
    for relative, data in files.items():
        target = folder / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    launcher = folder.parent / "launcher-build" / "sd-image-sorter-launcher.exe"
    launcher.parent.mkdir(parents=True, exist_ok=True)
    launcher.write_bytes(b"MZlauncher")
    return _ShellBuild(unpacked=folder, launcher=launcher)


# --- staging ----------------------------------------------------------------


def test_only_the_launcher_is_at_the_top_and_every_shell_file_is_in_desktop(
    shell, tmp_path
):
    stage = tmp_path / "stage"
    stage.mkdir()

    added = shell.stage_desktop_shell(_unpacked_shell(tmp_path / "unpacked"), stage)

    assert (stage / "SD Image Sorter.exe").read_bytes() == b"MZlauncher"
    assert (stage / "desktop" / "sd-image-sorter-shell.exe").read_bytes() == b"MZ"
    assert (stage / "desktop" / "resources" / "app.asar").is_file()
    assert sorted(added) == [
        "SD Image Sorter.exe",
        "desktop/locales/en-US.pak",
        "desktop/resources.pak",
        "desktop/resources/app.asar",
        "desktop/sd-image-sorter-shell.exe",
    ]
    assert sorted(path.name for path in stage.iterdir()) == [
        "SD Image Sorter.exe",
        "desktop",
    ]


def test_a_shell_file_never_overwrites_a_package_file(shell, tmp_path):
    stage = tmp_path / "stage"
    (stage / "desktop" / "resources").mkdir(parents=True)
    (stage / "desktop" / "resources" / "app.asar").write_bytes(b"mine")

    with pytest.raises(RuntimeError, match="collides"):
        shell.stage_desktop_shell(_unpacked_shell(tmp_path / "unpacked"), stage)

    assert (stage / "desktop" / "resources" / "app.asar").read_bytes() == b"mine"


def test_staging_needs_a_built_shell_and_launcher(shell, tmp_path):
    (tmp_path / "empty").mkdir()
    with pytest.raises(FileNotFoundError):
        shell.stage_desktop_shell(
            _ShellBuild(unpacked=tmp_path / "empty", launcher=tmp_path / "x.exe"),
            tmp_path,
        )
    build = _unpacked_shell(tmp_path / "unpacked")
    build.launcher.unlink()
    with pytest.raises(FileNotFoundError, match="launcher"):
        shell.stage_desktop_shell(build, tmp_path / "stage")


def test_a_missing_cargo_stops_the_build_with_a_clear_message(
    shell, monkeypatch, tmp_path
):
    monkeypatch.setattr(shell.shutil, "which", lambda name: None)
    with pytest.raises(RuntimeError, match="cargo was not found.*rustup"):
        shell.build_launcher(tmp_path)


def test_the_launcher_crate_matches_the_names_the_package_uses(shell):
    crate = ROOT / "desktop" / "launcher"
    cargo = (crate / "Cargo.toml").read_text(encoding="utf-8")
    source = (crate / "src" / "main.rs").read_text(encoding="utf-8")
    assert shell.LAUNCHER_CARGO_BIN == "sd-image-sorter-launcher.exe"
    assert 'name = "sd-image-sorter-launcher"' in cargo
    assert (crate / "Cargo.lock").is_file()
    assert f'"{shell.SHELL_EXE_NAME}"' in source
    assert f'"{shell.SHELL_DIRNAME}"' in source
    assert "windows_subsystem" in source
    # The launcher gets the program icon and starts the renamed Electron exe.
    assert "icon.ico" in (crate / "build.rs").read_text(encoding="utf-8")
    package = json.loads((ROOT / "desktop" / "package.json").read_text("utf-8"))
    assert package["build"]["executableName"] + ".exe" == shell.SHELL_EXE_NAME


def test_shell_version_comes_from_its_package_json(shell, tmp_path):
    (tmp_path / "desktop").mkdir()
    (tmp_path / "desktop" / "package.json").write_text(
        '{"version": "0.4.0"}', encoding="utf-8"
    )

    assert shell.shell_manifest_fields(tmp_path, "0.2.0") == {
        "shell_version": "0.4.0",
        "min_shell_version": "0.2.0",
    }


def test_the_repository_shell_is_not_older_than_what_the_app_needs(shell):
    import app_info

    fields = shell.shell_manifest_fields(ROOT, app_info.MIN_SHELL_VERSION)
    from services.shell_compat import shell_is_older

    assert not shell_is_older(fields["shell_version"], fields["min_shell_version"])


# --- what each package holds --------------------------------------------------


def test_only_the_windows_package_holds_the_shell_and_the_updater_does_not_manage_it(
    builder, shell, monkeypatch, tmp_path
):
    fake_root = tmp_path / "repo"
    artifact_root = tmp_path / "artifacts"
    version = "9.9.9"
    notes = fake_root / "docs" / f"RELEASE_NOTES_v{version}.md"
    notes.parent.mkdir(parents=True)
    notes.write_bytes(b"## v9.9.9 -- Test\n\nSummary.\n\n## Checksums\n\nx\n")
    (fake_root / "desktop").mkdir()
    (fake_root / "desktop" / "package.json").write_text(
        '{"version": "0.4.0"}', encoding="utf-8"
    )
    shell_build = _unpacked_shell(tmp_path / "unpacked")

    def minimal_project(stage_dir):
        (stage_dir / "backend").mkdir(parents=True, exist_ok=True)
        (stage_dir / "backend" / "main.py").write_text("pass\n", encoding="utf-8")

    monkeypatch.setattr(builder, "ROOT", fake_root)
    monkeypatch.setattr(builder, "ARTIFACT_ROOT", artifact_root)
    monkeypatch.setattr(builder, "STAGING_ROOT", artifact_root / "staging")
    monkeypatch.setattr(
        builder, "BOOTSTRAP_DOWNLOAD_ROOT", artifact_root / "staging" / "_downloads"
    )
    monkeypatch.setattr(builder, "find_seven_zip", lambda: None)
    monkeypatch.setattr(builder, "copy_project", minimal_project)
    monkeypatch.setattr(builder, "build_frontend_v4", lambda: None)
    monkeypatch.setattr(builder, "build_desktop_shell", lambda root: shell_build)
    monkeypatch.setattr(builder, "prepare_embedded_python", lambda stage_dir: None)
    monkeypatch.setattr(
        builder, "prepare_bundled_linux_python", lambda stage_dir, arch: None
    )

    assets = builder.build_release_assets(version, 1900)

    by_name = {asset.name: asset for asset in assets}
    with zipfile.ZipFile(
        by_name["sd-image-sorter-v9.9.9-windows-portable.zip"]
    ) as archive:
        names = set(archive.namelist())
        managed = json.loads(archive.read("update/package-manifest.json"))[
            "managed_paths"
        ]
    assert {
        "SD Image Sorter.exe",
        "desktop/sd-image-sorter-shell.exe",
        "desktop/resources/app.asar",
        "desktop/locales/en-US.pak",
    } <= names
    assert not {"resources.pak", "resources/app.asar", "locales/en-US.pak"} & names
    assert "backend/main.py" in managed
    assert not [path for path in managed if path.startswith("desktop/")]
    assert "SD Image Sorter.exe" not in managed

    with zipfile.ZipFile(by_name["sd-image-sorter-v9.9.9-app-patch.zip"]) as archive:
        assert "SD Image Sorter.exe" not in archive.namelist()
        assert not [n for n in archive.namelist() if n.startswith("desktop/")]
    for name, asset in by_name.items():
        if name.endswith(".tar.gz"):
            with tarfile.open(asset, "r:gz") as archive:
                assert not any(
                    "SD Image Sorter.exe" in member or member.startswith("desktop/")
                    for member in archive.getnames()
                )

    release_manifest = json.loads(
        by_name["sd-image-sorter-v9.9.9-release-manifest.json"].read_text(
            encoding="utf-8"
        )
    )
    assert release_manifest["shell_version"] == "0.4.0"
    assert release_manifest["min_shell_version"]


def test_a_failed_shell_build_stops_the_release(builder, shell, monkeypatch, tmp_path):
    monkeypatch.setattr(builder, "ARTIFACT_ROOT", tmp_path / "artifacts")
    monkeypatch.setattr(builder, "STAGING_ROOT", tmp_path / "artifacts" / "staging")
    monkeypatch.setattr(builder, "build_frontend_v4", lambda: None)

    def failed(root):
        raise RuntimeError("npm was not found")

    monkeypatch.setattr(builder, "build_desktop_shell", failed)

    with pytest.raises(RuntimeError, match="npm was not found"):
        builder.build_release_assets("9.9.9", 1900)


@pytest.mark.parametrize(
    ("relative", "skipped"),
    [
        ("desktop/src/main.js", True),
        ("desktop/dist/win-unpacked/sd-image-sorter-shell.exe", True),
        ("desktop/launcher/src/main.rs", True),
        ("desktop/package.json", True),
        ("browser-extension/dist/chrome/manifest.json", True),
        ("browser-extension/manifest.base.json", False),
        ("browser-extension/src/background.js", False),
        ("browser-extension/src/_locales/en/messages.json", False),
    ],
)
def test_source_sweep_keeps_extension_sources_and_drops_shell_sources(
    builder, relative, skipped
):
    assert builder.should_skip_path(Path(relative)) is skipped


# --- --output-dir -------------------------------------------------------------


def test_output_dir_must_not_be_the_repository_or_hold_other_files(
    builder, monkeypatch, tmp_path
):
    monkeypatch.setattr(builder, "ARTIFACT_ROOT", builder.ARTIFACT_ROOT)
    with pytest.raises(ValueError, match="repository"):
        builder.configure_output_root(builder.ROOT)
    with pytest.raises(ValueError, match="repository"):
        builder.configure_output_root(builder.ROOT.parent)

    holding = tmp_path / "docs"
    holding.mkdir()
    (holding / "thesis.docx").write_bytes(b"x")
    with pytest.raises(ValueError, match="not release output"):
        builder.configure_output_root(holding)


def test_output_dir_redirects_every_build_folder(builder, monkeypatch, tmp_path):
    for name in ("ARTIFACT_ROOT", "STAGING_ROOT", "BOOTSTRAP_DOWNLOAD_ROOT"):
        monkeypatch.setattr(builder, name, getattr(builder, name))
    target = tmp_path / "release"
    target.mkdir()
    (target / "sd-image-sorter-v1.0.0-linux.tar.gz").write_bytes(b"old")

    builder.configure_output_root(target)

    assert builder.ARTIFACT_ROOT == target.resolve()
    assert builder.STAGING_ROOT == target.resolve() / "staging"
    assert (
        builder.BOOTSTRAP_DOWNLOAD_ROOT == target.resolve() / "staging" / "_downloads"
    )


# --- launcher ---------------------------------------------------------------


def test_launcher_can_stop_after_setup_for_the_shell(builder, tmp_path):
    bat = builder.write_portable_launcher(tmp_path).read_text(encoding="utf-8")

    setup_exit = bat.index('"!SD_IMAGE_SORTER_SETUP_ONLY!"=="1"')
    assert (
        bat.index("Dependencies installed.")
        < setup_exit
        < bat.index("Checking startup readiness")
    )
    assert bat.index("exit /b 0", setup_exit) < bat.index("Checking startup readiness")
    assert ":serve" in bat  # browser mode is unchanged


# --- release QA ---------------------------------------------------------------


def test_qa_refuses_a_shell_in_a_package_that_is_not_windows(qa):
    names = {"SD Image Sorter.exe"}
    with pytest.raises(qa.LazyQaError, match="must not include SD Image Sorter.exe"):
        qa.assert_shell_presence(names, package_kind="app-patch")


def test_qa_refuses_a_windows_package_without_the_shell(qa):
    with pytest.raises(qa.LazyQaError, match="desktop shell file"):
        qa.assert_shell_presence({"run-portable.bat"}, package_kind="windows-portable")


def test_qa_refuses_shell_files_in_a_package_that_is_not_windows(qa):
    with pytest.raises(qa.LazyQaError, match="desktop shell files"):
        qa.assert_shell_presence({"desktop/resources.pak"}, package_kind="linux")


def test_qa_refuses_electron_files_loose_at_the_top_of_the_windows_package(qa):
    names = {*qa.SHELL_REQUIRED_FILES, "resources.pak"}
    with pytest.raises(qa.LazyQaError, match="belong in desktop/"):
        qa.assert_shell_presence(names, package_kind="windows-portable")
    qa.assert_shell_presence(set(qa.SHELL_REQUIRED_FILES), package_kind="windows-portable")


def test_qa_refuses_a_windows_package_without_the_inner_shell_exe(qa):
    names = set(qa.SHELL_REQUIRED_FILES) - {"desktop/sd-image-sorter-shell.exe"}
    with pytest.raises(qa.LazyQaError, match="sd-image-sorter-shell.exe"):
        qa.assert_shell_presence(names, package_kind="windows-portable")


def test_qa_refuses_a_manifest_that_manages_the_shell(qa):
    names = ["update/package-manifest.json", "SD Image Sorter.exe", "backend/main.py"]
    manifest = json.dumps(
        {"managed_paths": ["backend/main.py", "SD Image Sorter.exe"]}
    ).encode("utf-8")

    with pytest.raises(qa.LazyQaError, match="manages desktop shell files"):
        qa.assert_shell_not_managed(lambda name: manifest, names)


def test_qa_accepts_a_manifest_that_leaves_the_shell_alone(qa):
    names = ["update/package-manifest.json", "SD Image Sorter.exe", "backend/main.py"]
    manifest = json.dumps({"managed_paths": ["backend/main.py"]}).encode("utf-8")

    qa.assert_shell_not_managed(lambda name: manifest, names)


def test_qa_refuses_a_release_manifest_without_shell_versions(qa, tmp_path):
    manifest = tmp_path / "sd-image-sorter-v9.9.9-release-manifest.json"
    manifest.write_text(
        json.dumps({"version": "9.9.9", "assets": [{}, {}, {}]}), encoding="utf-8"
    )

    with pytest.raises(qa.LazyQaError, match="shell_version"):
        qa.check_release_packages(tmp_path, "9.9.9")


# --- building on Linux / macOS (CI) ---------------------------------------------


def _fake_release_tree(builder, monkeypatch, tmp_path, version="9.9.9"):
    fake_root = tmp_path / "repo"
    artifact_root = tmp_path / "artifacts"
    notes = fake_root / "docs" / f"RELEASE_NOTES_v{version}.md"
    notes.parent.mkdir(parents=True)
    notes.write_bytes(b"## v9.9.9 -- Test\n\nSummary.\n\n## Checksums\n\nx\n")
    (fake_root / "desktop").mkdir()
    (fake_root / "desktop" / "package.json").write_text('{"version": "0.4.0"}', encoding="utf-8")

    def minimal_project(stage_dir):
        (stage_dir / "backend").mkdir(parents=True, exist_ok=True)
        (stage_dir / "backend" / "main.py").write_text("pass\n", encoding="utf-8")

    monkeypatch.setattr(builder, "ROOT", fake_root)
    monkeypatch.setattr(builder, "ARTIFACT_ROOT", artifact_root)
    monkeypatch.setattr(builder, "STAGING_ROOT", artifact_root / "staging")
    monkeypatch.setattr(builder, "BOOTSTRAP_DOWNLOAD_ROOT", artifact_root / "staging" / "_downloads")
    monkeypatch.setattr(builder, "find_seven_zip", lambda: None)
    monkeypatch.setattr(builder, "copy_project", minimal_project)
    monkeypatch.setattr(builder, "build_frontend_v4", lambda: None)
    monkeypatch.setattr(builder, "prepare_embedded_python", lambda stage_dir: None)
    monkeypatch.setattr(builder, "prepare_bundled_linux_python", lambda stage_dir, arch: None)


def test_without_the_windows_package_the_shell_is_not_built(builder, monkeypatch, tmp_path):
    """CI builds the Linux packages on Linux, where the Windows launcher and the
    Electron shell cannot be built (the v3.8.0 candidate failed there)."""
    _fake_release_tree(builder, monkeypatch, tmp_path)
    monkeypatch.setattr(builder, "build_desktop_shell", lambda root: pytest.fail("shell built"))

    assets = builder.build_release_assets("9.9.9", 1900, include_windows=False)

    names = {asset.name for asset in assets}
    assert "sd-image-sorter-v9.9.9-windows-portable.zip" not in names
    assert {
        "sd-image-sorter-v9.9.9-app-patch.zip",
        "sd-image-sorter-v9.9.9-linux.tar.gz",
        "sd-image-sorter-v9.9.9-linux-portable-x86_64.tar.gz",
        "sd-image-sorter-v9.9.9-linux-portable-aarch64.tar.gz",
        "sd-image-sorter-v9.9.9-release-manifest.json",
    } <= names
    manifest = json.loads(
        next(a for a in assets if a.name.endswith("release-manifest.json")).read_text(encoding="utf-8")
    )
    assert not [entry for entry in manifest["assets"] if "windows-portable" in json.dumps(entry)]


def test_a_full_release_off_windows_is_refused_with_the_way_out(builder, monkeypatch, capsys):
    monkeypatch.setattr(builder.sys, "platform", "linux")
    monkeypatch.setattr(builder.sys, "argv", ["build_release_packages.py", "--version", "9.9.9"])
    monkeypatch.setattr(builder, "build_release_assets", lambda *a, **k: pytest.fail("built"))

    assert builder.main() == 1
    assert "--skip-windows-package" in capsys.readouterr().err


def test_ci_builds_the_linux_packages_without_the_windows_one():
    workflow = (ROOT / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")

    assert "build_release_packages.py --skip-windows-package" in workflow
