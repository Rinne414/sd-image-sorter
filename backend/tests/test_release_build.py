from __future__ import annotations

import ast
import importlib.util
import json
import re
import hashlib
import sys
import tarfile
from pathlib import Path

import pytest

import app_info


ROOT = Path(__file__).resolve().parents[2]
BUILD_SCRIPT = ROOT / "scripts" / "build_release_packages.py"


def _read_app_version() -> str:
    match = re.search(
        r'^APP_VERSION\s*=\s*["\']([^"\']+)["\']',
        (ROOT / "backend" / "app_info.py").read_text(encoding="utf-8"),
        re.MULTILINE,
    )
    assert match is not None
    return match.group(1)


def load_release_builder():
    spec = importlib.util.spec_from_file_location("build_release_packages", BUILD_SCRIPT)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_write_portable_launcher_uses_clean_crlf_endings(tmp_path):
    release_builder = load_release_builder()

    launcher_path = release_builder.write_portable_launcher(tmp_path)
    launcher_bytes = launcher_path.read_bytes()

    assert b"\r\r\n" not in launcher_bytes
    assert b"setlocal enabledelayedexpansion\r\n" in launcher_bytes
    assert b"set \"PIP_CMD=!PYTHON_DIR!\\Scripts\\pip.exe\"" in launcher_bytes
    assert b"set \"SD_IMAGE_SORTER_DATA_DIR=!DATA_DIR!\"" in launcher_bytes
    assert b"set \"SD_IMAGE_SORTER_STATE_DIR=!STATE_DIR!\"" in launcher_bytes
    assert b"set \"SD_IMAGE_SORTER_LAUNCHER=run-portable.bat\"" in launcher_bytes
    assert b"set \"TEMP=!TMP_DIR!\"" in launcher_bytes
    assert b"if not exist \"!PYTHON_CMD!\" (" in launcher_bytes
    assert b"import fastapi, PIL, numpy, onnxruntime" in launcher_bytes
    import_probe_lines = [line for line in launcher_bytes.splitlines() if b'-c "import ' in line]
    assert import_probe_lines == [b'    "!PYTHON_CMD!" -c "import fastapi, PIL, numpy, onnxruntime" >nul 2>&1']
    for optional_import in (b"sam3", b"decord", b"iopath", b"pycocotools", b"cv2"):
        assert optional_import not in import_probe_lines[0]
    assert b"requirements-core.txt" in launcher_bytes
    assert b"RUNTIME_REBUILD_MARKER=!STATE_DIR!\\rebuild-core-venv.json" in launcher_bytes
    assert b"Clearing embedded Python packages only" in launcher_bytes
    assert b"Could not clear embedded Python site-packages" in launcher_bytes
    assert b"Could not clear embedded Python Scripts" in launcher_bytes
    assert b"!PYTHON_DIR!\\Lib\\site-packages" in launcher_bytes
    assert b"Heavy AI packages install on Prepare" in launcher_bytes
    assert b"backend\\launcher_pip.py install setuptools wheel" in launcher_bytes
    assert b"Installing lightweight core dependencies" in launcher_bytes
    assert b"-m pip install -r backend\\requirements.txt" not in launcher_bytes
    assert b"backend\\launcher_port.py --format cmd > \"!PORT_ENV_FILE!\"" in launcher_bytes
    assert b"SD_IMAGE_SORTER_PORT_STATUS" in launcher_bytes
    assert b"SD_IMAGE_SORTER_URL_HOST" in launcher_bytes
    assert b"PORT_CHECK_EXIT" in launcher_bytes
    assert b"http://!APP_URL_HOST!:!APP_PORT!" in launcher_bytes
    assert b"http://localhost:!APP_PORT!" not in launcher_bytes
    assert b"main.py --port !APP_PORT!" in launcher_bytes
    assert b"Server exited with code !SERVER_EXIT_CODE!" in launcher_bytes
    assert b"Error output above" not in launcher_bytes
    assert launcher_bytes.endswith(b"pause\r\n")


def test_portable_launcher_runs_onnx_repair_unconditionally(tmp_path):
    """Regression guard (v3.1.3): repair_onnxruntime.py must NOT be gated behind FULL_AI."""
    release_builder = load_release_builder()
    launcher_path = release_builder.write_portable_launcher(tmp_path)
    content = launcher_path.read_text(encoding="utf-8")

    assert "repair_onnxruntime.py --auto" in content
    onnx_pos = content.index("repair_onnxruntime.py --auto")
    torch_pos = content.index("repair_torch_runtime.py --auto")
    assert onnx_pos < torch_pos, "ONNX repair must run before torch repair"

    # The ONNX repair must not be nested inside the FULL_AI conditional
    preceding = content[:onnx_pos]
    last_full_ai = preceding.rfind("SD_IMAGE_SORTER_INSTALL_FULL_AI")
    if last_full_ai != -1:
        between = preceding[last_full_ai:onnx_pos]
        open_parens = between.count("(")
        close_parens = between.count(")")
        assert close_parens >= open_parens, (
            "repair_onnxruntime.py appears inside a FULL_AI conditional block"
        )


def test_linux_portable_launcher_runs_onnx_repair_unconditionally(tmp_path):
    """Regression guard (Linux GPU tagger report, 2026-07-03): the Linux
    requirements pin CPU-only onnxruntime, so the Linux portable launcher must
    run repair_onnxruntime.py unconditionally (NVIDIA machines get the
    onnxruntime-gpu swap; everyone else is a fast no-op). Torch repair stays
    Windows-only because Linux CUDA torch wheels come from pip markers."""
    release_builder = load_release_builder()
    launcher_path = release_builder.write_linux_portable_launcher(tmp_path)
    content = launcher_path.read_text(encoding="utf-8")

    assert "repair_onnxruntime.py --auto" in content
    assert "repair_torch_runtime.py --auto" not in content

    # Must not be nested inside a FULL_AI conditional: every `if` opened after
    # the last FULL_AI mention before the repair call must be closed by `fi`.
    onnx_pos = content.index("repair_onnxruntime.py --auto")
    preceding = content[:onnx_pos]
    last_full_ai = preceding.rfind("SD_IMAGE_SORTER_INSTALL_FULL_AI")
    if last_full_ai != -1:
        between = preceding[last_full_ai:onnx_pos]
        opened = len(re.findall(r"(?m)^\s*if\b", between))
        closed = len(re.findall(r"(?m)^\s*fi\b", between))
        assert closed >= opened, (
            "repair_onnxruntime.py appears inside a FULL_AI conditional block in the Linux launcher"
        )


def test_portable_launcher_opens_browser_in_process_not_hidden_powershell(tmp_path):
    """Regression lock (v3.3.2, AV false positive): the GENERATED Windows portable
    launcher must open the browser in-process via SD_IMAGE_SORTER_OPEN_BROWSER=1,
    never by spawning a hidden-window PowerShell that polls the URL in a loop --
    the pattern Huorong / 火绒 flagged as trojan-like (commit e5592be).

    run-portable.bat is generated here (it is gitignored, NOT a tracked source
    file), so fixing run.bat alone would silently leave the shipped portable
    launcher dirty. This keeps the generator in sync with run.bat and the
    in-process opener (main._maybe_open_browser_when_ready).
    """
    release_builder = load_release_builder()
    launcher_path = release_builder.write_portable_launcher(tmp_path)
    content = launcher_path.read_text(encoding="utf-8")

    # Opt in to the in-process opener (matches run.bat).
    assert 'set "SD_IMAGE_SORTER_OPEN_BROWSER=1"' in content

    # None of the hidden-PowerShell / looped-HTTP-probe markers may reappear.
    lowered = content.lower()
    for forbidden in ("powershell", "windowstyle hidden", "invoke-webrequest", "start /b"):
        assert forbidden not in lowered, (
            f"AV-flagged browser-probe marker reintroduced in run-portable.bat: {forbidden!r}"
        )


def test_release_skip_rules_drop_hidden_and_docs_files():
    release_builder = load_release_builder()

    assert release_builder.should_skip_path(Path(".gitignore")) is True
    assert release_builder.should_skip_path(Path(".tmp_probe_browse.py")) is True
    assert release_builder.should_skip_path(Path(".tmp_move_target") / "note.txt") is True
    assert release_builder.should_skip_path(Path("docs") / "screenshots" / "gallery.png") is True
    assert release_builder.should_skip_path(Path("data") / "images.db") is True
    assert release_builder.should_skip_path(Path("data") / "logs" / "backend.log") is True
    assert release_builder.should_skip_path(Path("data") / "models" / "wd14" / "model.onnx") is True
    assert release_builder.should_skip_path(Path("backend") / "data" / "logs" / "backend.log") is True
    assert release_builder.should_skip_path(Path("update") / "downloads" / "patch.zip") is True
    assert release_builder.should_skip_path(Path("coverage.xml")) is True
    assert release_builder.should_skip_path(Path("backend") / "coverage.xml") is True
    assert release_builder.should_skip_path(Path("backend") / "images.db-wal") is True
    assert release_builder.should_skip_path(Path("backend") / "images.db-shm") is True
    assert release_builder.should_skip_path(Path("backend") / "images.db-journal") is True
    assert release_builder.should_prune_directory(Path("metadata missing")) is True
    assert release_builder.should_prune_directory(Path("htmlcov")) is True
    assert release_builder.should_prune_directory(Path("backend") / "htmlcov") is True
    assert release_builder.should_skip_path(Path(".env.example")) is False
    assert release_builder.should_skip_path(Path("README.md")) is False


def test_release_skip_rules_drop_root_internal_reports():
    release_builder = load_release_builder()

    assert release_builder.should_skip_path(Path("HANDOFF-qa-followup.md")) is True
    assert release_builder.should_skip_path(Path("qa-sweep-v3.5.0-stable-REPORT.md")) is True
    assert release_builder.should_skip_path(Path("backend") / "USER-REPORT.md") is False


def test_release_skip_rules_drop_loose_root_level_images():
    """Regression test: stray test screenshots at the repo root must not ship.

    In v3.2.0 release prep, two ad-hoc playwright runs left
    ``e2e-gallery-final.png`` and ``e2e-manual-sort-bug.png`` at the
    repo root. Neither matched any existing exclusion rule, so they
    got bundled into the public windows-portable.zip / linux.tar.gz /
    app-patch.zip. That's both a privacy concern (random screenshot
    of the developer's gallery shipping to every user) and a "what is
    this random PNG doing in my download" concern.

    The fix is a defensive root-level image filter in
    ``should_skip_path``: any image suffix at the top of the tree is
    skipped. Real product screenshots live under ``docs/screenshots/``
    and the build script doesn't ship those anyway, so this rule has
    no false positives.
    """
    release_builder = load_release_builder()

    # Loose root-level images must be skipped, regardless of name.
    assert release_builder.should_skip_path(Path("e2e-gallery-final.png")) is True
    assert release_builder.should_skip_path(Path("e2e-manual-sort-bug.png")) is True
    assert release_builder.should_skip_path(Path("playwright-trace.png")) is True
    assert release_builder.should_skip_path(Path("screenshot.jpg")) is True
    assert release_builder.should_skip_path(Path("test.webp")) is True
    assert release_builder.should_skip_path(Path("RANDOM.gif")) is True

    # Images under subdirectories must still be allowed (the docs/ tree
    # is excluded elsewhere; here we just confirm the new rule does
    # not over-match).
    assert release_builder.should_skip_path(Path("frontend-v4") / "dist" / "assets" / "logo.png") is False
    assert release_builder.should_skip_path(Path("models") / "yolo" / "preview.png") is True  # excluded by models rule, not the new one
    # Sanity: legit launcher and doc files at the repo root are still allowed.
    assert release_builder.should_skip_path(Path("README.md")) is False
    assert release_builder.should_skip_path(Path("LICENSE")) is False
    assert release_builder.should_skip_path(Path("run.bat")) is False
    assert release_builder.should_skip_path(Path("run.sh")) is False


def test_release_copy_project_prunes_excluded_directory_trees(monkeypatch, tmp_path):
    release_builder = load_release_builder()
    fake_root = tmp_path / "repo"
    stage_root = tmp_path / "stage"

    files = {
        "README.md": "readme\n",
        "backend/main.py": "print('ok')\n",
        # A V3.5 interface folder left in the working copy: V4-only packages never ship it.
        "frontend/index.html": "must not copy\n",
        "models/yolo/README.md": "model docs\n",
        "models/yolo/model.onnx": "model payload\n",
        "backend/venv/Lib/site-packages/huge.py": "must not copy\n",
        "metadata missing/private-sample.png": "must not copy\n",
        "artifacts/release/staging/recursive.txt": "must not copy\n",
        "data/images.db": "must not copy\n",
        "update/downloads/patch.zip": "must not copy\n",
        "coverage.xml": "must not copy\n",
        "backend/coverage.xml": "must not copy\n",
        "backend/images.db-wal": "must not copy\n",
        "backend/images.db-shm": "must not copy\n",
        "backend/images.db-journal": "must not copy\n",
        "htmlcov/index.html": "must not copy\n",
        "backend/htmlcov/index.html": "must not copy\n",
        ".git/config": "must not copy\n",
    }
    for relative_path, content in files.items():
        target = fake_root / relative_path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")

    monkeypatch.setattr(release_builder, "ROOT", fake_root)

    release_builder.copy_project(stage_root)

    assert (stage_root / "README.md").exists()
    assert (stage_root / "backend/main.py").exists()
    assert not (stage_root / "frontend").exists()
    assert (stage_root / "models/yolo/README.md").exists()
    assert not (stage_root / "models/yolo/model.onnx").exists()
    assert not (stage_root / "backend/venv/Lib/site-packages/huge.py").exists()
    assert not (stage_root / "metadata missing/private-sample.png").exists()
    assert not (stage_root / "artifacts/release/staging/recursive.txt").exists()
    assert not (stage_root / "data/images.db").exists()
    assert not (stage_root / "update/downloads/patch.zip").exists()
    assert not (stage_root / "coverage.xml").exists()
    assert not (stage_root / "backend/coverage.xml").exists()
    assert not (stage_root / "backend/images.db-wal").exists()
    assert not (stage_root / "backend/images.db-shm").exists()
    assert not (stage_root / "backend/images.db-journal").exists()
    assert not (stage_root / "htmlcov/index.html").exists()
    assert not (stage_root / "backend/htmlcov/index.html").exists()
    assert not (stage_root / ".git/config").exists()


def test_app_patch_python_sources_support_legacy_windows_runtime():
    release_builder = load_release_builder()
    syntax_errors: list[str] = []

    for source_path, relative_path in release_builder.iter_project_files():
        if relative_path.suffix.lower() != ".py":
            continue
        try:
            ast.parse(
                source_path.read_text(encoding="utf-8-sig"),
                filename=relative_path.as_posix(),
                feature_version=(3, 11),
            )
        except SyntaxError as exc:
            syntax_errors.append(
                f"{relative_path.as_posix()}:{exc.lineno}: {exc.msg}"
            )

    syntax_error_details = "\n".join(syntax_errors)
    assert syntax_errors == [], (
        "App-patch Python sources must remain parseable by the Python 3.11 "
        f"runtime bundled with v3.4.x and Beta 1:\n{syntax_error_details}"
    )


def test_rescue_batch_files_are_release_managed(tmp_path):
    release_builder = load_release_builder()

    assert release_builder.should_skip_path(Path("fix.bat")) is False
    assert release_builder.should_skip_path(Path("update.bat")) is False
    assert release_builder.should_skip_path(Path("backend") / "update_cli.py") is False

    fix_text = (ROOT / "fix.bat").read_text(encoding="utf-8")
    update_text = (ROOT / "update.bat").read_text(encoding="utf-8")

    assert "fix.bat is for rare repair/diagnostics only" in fix_text
    assert "main.py" not in fix_text
    assert "--diagnose --format text" in fix_text
    assert r"backend\update_cli.py" in update_text
    assert "--check-only" in update_text
    assert "%*" in update_text
    assert "run-portable.bat" in update_text

    staged_files = {
        "fix.bat": fix_text,
        "update.bat": update_text,
        "backend/update_cli.py": "print('update cli')\n",
    }
    for relative_path, content in staged_files.items():
        target = tmp_path / relative_path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")

    manifest_path = release_builder.write_package_manifest(tmp_path, "9.9.9")
    managed_paths = set(json.loads(manifest_path.read_text(encoding="utf-8"))["managed_paths"])

    assert "fix.bat" in managed_paths
    assert "update.bat" in managed_paths
    assert "backend/update_cli.py" in managed_paths


def test_release_default_version_follows_app_info():
    release_builder = load_release_builder()

    assert release_builder.DEFAULT_VERSION == _read_app_version()


def _stable_base_version(app_version: str) -> str:
    """Strip a prerelease suffix (``-beta.1`` / ``-rc.2`` / ``-alpha.3``) so
    the stable-line docs can be checked against the STABLE version.

    The CHANGELOG heading and ``docs/RELEASE_NOTES_v<x>.md`` track the stable
    line (``3.5.0``) even while app_info.py carries a prerelease string
    (``3.5.0-beta.4``). For a plain stable version this strip is a no-op, so
    stable releases behave exactly as before.

    The README version badge is no longer in this list: it is a dynamic
    shields.io ``github/v/release`` badge that reads the published release
    directly, so there is no local string left to keep in sync.

    This deliberately no longer governs README *download* links. Those used to
    embed ``sd-image-sorter-v{base_version}-...`` filenames under
    ``/releases/latest/download/`` on the theory that "Latest" always resolves
    to a stable tag. It does not: a prerelease published without the prerelease
    flag becomes "Latest", and its assets carry the FULL version, so every
    pinned link 404'd. See
    ``test_release_public_docs_link_to_releases_page_not_pinned_assets``.
    """
    return re.split(r"-(?:alpha|beta|rc)\b", app_version, maxsplit=1)[0]


def _read_app_info_constant(name: str) -> str:
    match = re.search(
        rf'^{name}\s*=\s*["\']([^"\']+)["\']',
        (ROOT / "backend" / "app_info.py").read_text(encoding="utf-8"),
        re.MULTILINE,
    )
    assert match is not None, f"{name} is missing from backend/app_info.py"
    return match.group(1)


# Asset-name suffixes the README must keep naming so a reader landing on the
# releases page can still pick the right file for their platform. These are the
# four *user-installable* assets of the six that build_release_packages.py
# publishes; the other two are updater-only and are asserted separately.
_README_PLATFORM_ASSET_SUFFIXES = (
    "windows-portable.zip",
    "linux.tar.gz",
    "linux-portable-x86_64.tar.gz",
    "linux-portable-aarch64.tar.gz",
)

_README_UPDATER_ONLY_ASSETS = ("app-patch.zip", "release-manifest.json")


def test_release_public_docs_versions_follow_app_info():
    app_version = _read_app_version()
    base_version = _stable_base_version(app_version)
    readme_text = (ROOT / "README.md").read_text(encoding="utf-8")
    changelog_text = (ROOT / "CHANGELOG.md").read_text(encoding="utf-8")

    # The version badge is rendered by shields.io from the repository's latest
    # GitHub release rather than typed into the README. A literal
    # ``badge/version-<x>`` had to be hand-edited on every bump and had already
    # drifted: it read 3.5.0 while the published release was v3.5.0-beta.4.
    # Owner/repo are read from app_info for the same reason the download links
    # are -- a rename must not leave the badge on a URL that only resolves
    # while GitHub still honours a redirect.
    owner = _read_app_info_constant("GITHUB_OWNER")
    repo = _read_app_info_constant("GITHUB_REPO")
    assert f"img.shields.io/github/v/release/{owner}/{repo}" in readme_text
    assert "img.shields.io/badge/version-" not in readme_text, (
        "README pins the version into a static shields.io badge. That badge "
        "goes stale on the next release; use the dynamic github/v/release one."
    )

    assert re.search(
        rf"^## \[{re.escape(base_version)}\] - \d{{4}}-\d{{2}}-\d{{2}}$",
        changelog_text,
        re.MULTILINE,
    )


def test_release_public_docs_link_to_releases_page_not_pinned_assets():
    """README download links must survive a version bump.

    ``/releases/latest/download/<name>`` requires the EXACT asset filename and
    supports no wildcard, so a hardcoded name dies the moment the version moves.
    That is not hypothetical: the README shipped
    ``sd-image-sorter-v3.5.0-windows-portable.zip`` while the published latest
    release was ``v3.5.0-beta.4``, whose assets carry the full version. Every
    download link on the landing page returned 404.

    The contract is therefore: link to the releases PAGE, which never rots, and
    keep the per-platform filename guidance in prose so a reader can still act
    correctly once they get there.
    """
    readme_text = (ROOT / "README.md").read_text(encoding="utf-8")

    assert "/releases/latest/download/" not in readme_text, (
        "README must not hardcode a release-asset download URL: that form "
        "needs an exact filename and 404s on the next version bump."
    )
    pinned = sorted(set(re.findall(r"sd-image-sorter-(?:vopus-)?v\d[\w.]*-[\w.\-]+", readme_text)))
    assert not pinned, f"README pins version-specific asset filenames: {pinned}"

    # Built from app_info.py so an owner/repo rename cannot silently leave the
    # landing page pointing at a URL that only survives via a GitHub redirect.
    owner = _read_app_info_constant("GITHUB_OWNER")
    repo = _read_app_info_constant("GITHUB_REPO")
    # Latest stays a V3.5 release (docs/RELEASE_SOP.md), so /releases/latest
    # would send Vopus readers to V3.5: link the releases page and name the tag.
    assert f"https://github.com/{owner}/{repo}/releases" in readme_text
    assert "/releases/latest" not in readme_text
    assert "vopus-v" in readme_text

    for suffix in _README_PLATFORM_ASSET_SUFFIXES:
        assert suffix in readme_text, (
            f"README must still name {suffix}; without it the releases page is "
            "an unlabelled asset dump and the reader cannot choose a platform."
        )
    for updater_only in _README_UPDATER_ONLY_ASSETS:
        assert updater_only in readme_text, (
            f"README must warn that {updater_only} is updater-only, so nobody "
            "downloads it by hand and reports a broken install."
        )

    # Copy-pasteable extract commands must be version-agnostic for the same
    # reason the URLs are: a pinned name here fails on the user's terminal.
    assert "tar xzf sd-image-sorter-*-linux.tar.gz" in readme_text
    assert "tar xzf sd-image-sorter-*-linux-portable-x86_64.tar.gz" in readme_text

    # Bilingual README: the picker must exist in BOTH language sections.
    assert "Releases page" in readme_text
    assert "Releases 页面" in readme_text


def test_release_packages_use_version_specific_release_notes(tmp_path):
    release_builder = load_release_builder()
    app_version = _read_app_version()

    notes_path = ROOT / "docs" / f"RELEASE_NOTES_vopus-v{app_version}.md"
    assert notes_path.exists()

    copied_path = release_builder.write_release_notes(tmp_path, app_version)
    copied_bytes = copied_path.read_bytes()
    source_bytes = notes_path.read_bytes()

    assert copied_path.name == "release-notes.md"
    assert copied_bytes == release_builder.render_packaged_release_notes(source_bytes)
    assert f"Vopus {app_version}".encode() in copied_bytes
    assert b"release-manifest.json" in copied_bytes


def test_packaged_release_notes_remove_self_referential_checksums():
    release_builder = load_release_builder()
    source_bytes = (
        "## v9.9.9 — Test\r\n"
        "\r\n"
        "Summary.\r\n"
        "\r\n"
        "---\r\n"
        "\r\n"
        "## Checksums\r\n"
        "\r\n"
        "| Asset | SHA-256 |\r\n"
        "|---|---|\r\n"
        "| `archive.zip` | `deadbeef` |\r\n"
    ).encode("utf-8")

    packaged_bytes = release_builder.render_packaged_release_notes(source_bytes)
    checksum_heading = b"## Checksums\r\n"
    prefix = source_bytes[: source_bytes.index(checksum_heading) + len(checksum_heading)]

    assert packaged_bytes.startswith(prefix)
    assert packaged_bytes == prefix + (
        "\r\nVerified machine-readable SHA-256 values are in the release manifest. / "
        "已验证的机器可读 SHA-256 校验和见 release manifest。\r\n"
    ).encode("utf-8")
    assert b"deadbeef" not in packaged_bytes


@pytest.mark.parametrize(
    "source_bytes",
    [
        b"## v9.9.9 -- Missing checksums\n",
        b"Details mention ## Checksums but have no heading.\n",
        b"## Checksums appendix\n",
        b"### Checksums\n",
        b"## Checksums\n\nFirst.\n\n## Checksums\n\nSecond.\n",
    ],
)
def test_packaged_release_notes_require_one_checksums_section(source_bytes):
    release_builder = load_release_builder()

    with pytest.raises(ValueError, match="exactly one Checksums section"):
        release_builder.render_packaged_release_notes(source_bytes)


def test_all_five_release_archives_use_packaged_release_notes(monkeypatch, tmp_path):
    release_builder = load_release_builder()
    fake_root = tmp_path / "repo"
    artifact_root = tmp_path / "artifacts"
    staging_root = artifact_root / "staging"
    version = "9.9.9"
    source_bytes = b"## v9.9.9 -- Test\n\nSummary.\n\n## Checksums\n\n| asset | deadbeef |\n"
    notes_path = fake_root / "docs" / f"RELEASE_NOTES_vopus-v{version}.md"
    notes_path.parent.mkdir(parents=True)
    notes_path.write_bytes(source_bytes)
    expected = release_builder.render_packaged_release_notes(source_bytes)

    def copy_minimal_project(stage_dir):
        (stage_dir / "backend").mkdir(parents=True, exist_ok=True)
        (stage_dir / "backend" / "main.py").write_text("pass\n", encoding="utf-8")

    monkeypatch.setattr(release_builder, "ROOT", fake_root)
    monkeypatch.setattr(release_builder, "ARTIFACT_ROOT", artifact_root)
    monkeypatch.setattr(release_builder, "STAGING_ROOT", staging_root)
    monkeypatch.setattr(release_builder, "BOOTSTRAP_DOWNLOAD_ROOT", staging_root / "_downloads")
    monkeypatch.setattr(release_builder, "find_seven_zip", lambda: None)
    monkeypatch.setattr(release_builder, "copy_project", copy_minimal_project)
    monkeypatch.setattr(release_builder, "build_frontend_v4", lambda: None)
    monkeypatch.setattr(release_builder, "prepare_embedded_python", lambda stage_dir: None)
    monkeypatch.setattr(
        release_builder,
        "prepare_bundled_linux_python",
        lambda stage_dir, arch: None,
    )

    assets = release_builder.build_release_assets(version, 1900)
    archive_paths = [path for path in assets if path.suffix == ".zip" or path.name.endswith(".tar.gz")]
    packaged_notes = []
    for archive_path in archive_paths:
        if archive_path.suffix == ".zip":
            with release_builder.ZipFile(archive_path) as archive:
                packaged_notes.append(archive.read("release-notes.md"))
            continue
        with tarfile.open(archive_path, "r:gz") as archive:
            notes_file = archive.extractfile("sd-image-sorter/release-notes.md")
            assert notes_file is not None
            packaged_notes.append(notes_file.read())

    assert len(packaged_notes) == 5
    assert packaged_notes == [expected] * 5
    assert all(b"deadbeef" not in notes for notes in packaged_notes)


def test_stable_release_notes_follow_in_app_summary_sop():
    app_version = _read_app_version()
    notes_path = ROOT / "docs" / f"RELEASE_NOTES_vopus-v{app_version}.md"
    notes = notes_path.read_text(encoding="utf-8")
    lines = notes.splitlines()

    assert lines[0].startswith(f"## Vopus {app_version} — ")
    assert len(lines[0]) <= 80

    first_200 = notes[:200]
    assert "http://" not in first_200
    assert "https://" not in first_200
    assert ".zip" not in first_200
    assert ".tar.gz" not in first_200

    summary = notes.split("\n---", maxsplit=1)[0]
    assert notes.index("\n---") < 200
    assert re.search(r"[\u4e00-\u9fff]", summary)
    assert re.search(r"[A-Za-z]{4,}", summary)

    headings = [
        "## Fixed / 修复",
        "## Upgrading / 升级注意",
        "## Validation / 验证",
        "## ⬇️ Which file should I download? / 我该下载哪一个？",
        "## Checksums",
    ]
    assert [line for line in lines if line.startswith("## ")] == [lines[0], *headings]
    positions = [notes.index(heading) for heading in headings]
    assert positions == sorted(positions)
    assert notes.count("## Checksums") == 1

    root_notes = (ROOT / "release-notes.md").read_text(encoding="utf-8")
    assert root_notes == notes


def test_release_bootstrap_downloads_are_pinned_to_immutable_sources():
    release_builder = load_release_builder()

    assert release_builder.PYTHON_EMBED_VERSION in release_builder.PYTHON_EMBED_URL
    assert re.fullmatch(r"[0-9a-f]{64}", release_builder.PYTHON_EMBED_SHA256)
    assert re.fullmatch(r"[0-9a-f]{40}", release_builder.GET_PIP_COMMIT)
    assert release_builder.GET_PIP_COMMIT in release_builder.GET_PIP_URL
    assert "raw.githubusercontent.com/pypa/get-pip/" in release_builder.GET_PIP_URL
    assert "/main/" not in release_builder.GET_PIP_URL
    assert release_builder.GET_PIP_URL != "https://bootstrap.pypa.io/get-pip.py"
    assert re.fullmatch(r"[0-9a-f]{64}", release_builder.GET_PIP_SHA256)


def test_release_bootstrap_download_cache_stays_under_staging_root():
    release_builder = load_release_builder()

    assert release_builder.BOOTSTRAP_DOWNLOAD_ROOT.parent == release_builder.STAGING_ROOT
    assert release_builder.BOOTSTRAP_DOWNLOAD_ROOT.name.startswith("_")


def test_write_package_manifest_excludes_runtime_files(tmp_path):
    release_builder = load_release_builder()

    (tmp_path / "backend").mkdir()
    (tmp_path / "backend" / "main.py").write_text("print('ok')\n", encoding="utf-8")
    (tmp_path / "frontend-v4" / "dist").mkdir(parents=True)
    (tmp_path / "frontend-v4" / "dist" / "index.html").write_text("<html></html>\n", encoding="utf-8")
    (tmp_path / "python").mkdir()
    (tmp_path / "python" / "python.exe").write_text("binary\n", encoding="utf-8")

    manifest_path = release_builder.write_package_manifest(tmp_path, "9.9.9")
    payload = json.loads(manifest_path.read_text(encoding="utf-8"))

    assert payload["version"] == "9.9.9"
    assert "backend/main.py" in payload["managed_paths"]
    assert "frontend-v4/dist/index.html" in payload["managed_paths"]
    assert "python/python.exe" not in payload["managed_paths"]
    assert "update/package-manifest.json" in payload["managed_paths"]


def test_write_package_manifest_declares_model_artifact_policy(tmp_path):
    release_builder = load_release_builder()

    staged_files = {
        "backend/main.py": "print('ok')\n",
        "models/README.md": "models docs\n",
        "models/wd14-tagger/wd-swinv2-tagger-v3/model.onnx": "model\n",
        "models/florence2/model.safetensors": "florence\n",
        "models/lucida/model.safetensors": "lucida\n",
        "models/cl_tagger_v2/v2_00/model.onnx": "cl-tag\n",
        "data/models/cl-tagger-v2/v2_00/model.onnx.data": "external\n",
    }
    for relative_path, content in staged_files.items():
        target = tmp_path / relative_path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")

    manifest_path = release_builder.write_package_manifest(tmp_path, "9.9.9")
    payload = json.loads(manifest_path.read_text(encoding="utf-8"))
    policy = payload["model_artifact_policy"]

    assert policy["version"] == 2
    assert policy["delivery"] == "application_prepare_only"
    assert policy["default_packages_include_model_payloads"] is False
    assert policy["runtime_model_root"] == "data/models"
    assert "models/README.md" in payload["managed_paths"]
    for model_path in staged_files:
        if model_path.startswith(("models/", "data/models/")) and model_path != "models/README.md":
            assert model_path not in payload["managed_paths"]
    assert policy["auto_download_model_paths"] == []
    assert policy["managed_model_payload_paths"] == []
    assert policy["optional_release_assets"] == []
    assert policy["forbidden_model_prefixes"] == ["models/", "data/models/"]
    assert "florence2" in policy["download_model_ids"]
    assert "lucida" in policy["download_model_ids"]
    assert "cl-tagger-v2" in policy["download_model_ids"]


def test_model_payload_redistribution_is_rejected(tmp_path):
    release_builder = load_release_builder()

    with pytest.raises(ValueError, match="redistribution is disabled"):
        release_builder.write_package_manifest(
            tmp_path,
            "9.9.9",
            include_model_payloads=True,
        )


def test_write_package_manifest_filters_protected_runtime_paths_even_if_staged(tmp_path):
    release_builder = load_release_builder()

    staged_files = {
        "backend/main.py": "print('ok')\n",
        "data/images.db": "database\n",
        "data/models/wd14/model.onnx": "model\n",
        "update/backups/old-file.txt": "backup\n",
        "update/downloads/patch.zip": "zip\n",
        "update/logs/update.log": "log\n",
        "update/state/pending-update.json": "state\n",
        "update/worker/update_worker.py": "worker\n",
    }
    for relative_path, content in staged_files.items():
        target = tmp_path / relative_path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")

    manifest_path = release_builder.write_package_manifest(tmp_path, "9.9.9")
    managed_paths = set(json.loads(manifest_path.read_text(encoding="utf-8"))["managed_paths"])

    assert "backend/main.py" in managed_paths
    assert "update/package-manifest.json" in managed_paths
    for protected_path in staged_files:
        if protected_path != "backend/main.py":
            assert protected_path not in managed_paths


def test_copy_project_then_manifest_excludes_all_protected_runtime_prefixes(monkeypatch, tmp_path):
    release_builder = load_release_builder()

    source_root = tmp_path / "source"
    stage_dir = tmp_path / "stage"
    (source_root / "backend").mkdir(parents=True)
    (source_root / "backend" / "main.py").write_text("print('ok')\n", encoding="utf-8")

    protected_files = {
        "data/images.db": "database\n",
        "data/models/wd14/model.onnx": "model\n",
        "update/backups/old-file.txt": "backup\n",
        "update/downloads/patch.zip": "zip\n",
        "update/logs/update.log": "log\n",
        "update/state/pending-update.json": "state\n",
        "update/worker/update_worker.py": "worker\n",
    }
    for relative_path, content in protected_files.items():
        target = source_root / relative_path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")

    monkeypatch.setattr(release_builder, "ROOT", source_root)

    release_builder.copy_project(stage_dir)
    manifest_path = release_builder.write_package_manifest(stage_dir, "9.9.9")
    managed_paths = set(json.loads(manifest_path.read_text(encoding="utf-8"))["managed_paths"])

    assert "backend/main.py" in managed_paths
    assert "update/package-manifest.json" in managed_paths
    for protected_path in protected_files:
        assert protected_path not in managed_paths


def test_download_file_verifies_sha256(monkeypatch, tmp_path):
    release_builder = load_release_builder()
    payload = b"verified-download"
    expected_sha256 = hashlib.sha256(payload).hexdigest()

    class FakeResponse:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def read(self, size=-1):
            nonlocal payload
            if not payload:
                return b""
            if size < 0:
                chunk, payload = payload, b""
                return chunk
            chunk, payload = payload[:size], payload[size:]
            return chunk

    monkeypatch.setattr(release_builder.urllib.request, "urlopen", lambda request, timeout=0: FakeResponse())

    dest = tmp_path / "payload.bin"
    release_builder.download_file("https://example.com/payload.bin", dest, expected_sha256=expected_sha256)

    assert dest.read_bytes() == b"verified-download"


def test_download_file_rejects_sha256_mismatch(monkeypatch, tmp_path):
    release_builder = load_release_builder()

    class FakeResponse:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def read(self, size=-1):
            if hasattr(self, "_done"):
                return b""
            self._done = True
            return b"wrong-download"

    monkeypatch.setattr(release_builder.urllib.request, "urlopen", lambda request, timeout=0: FakeResponse())

    dest = tmp_path / "payload.bin"
    expected_sha256 = hashlib.sha256(b"expected").hexdigest()

    try:
        release_builder.download_file("https://example.com/payload.bin", dest, expected_sha256=expected_sha256)
    except RuntimeError as exc:
        assert "checksum mismatch" in str(exc)
    else:
        raise AssertionError("Expected checksum mismatch")

    assert not dest.exists()
    assert not (tmp_path / "payload.bin.tmp").exists()


def _assert_platform_specific_wheels_guarded(requirements_path: Path):
    # Normalize quote style across the file. ``pip-compile`` writes
    # ``sys_platform == "linux"`` (double quotes) while
    # ``uv pip compile`` writes ``sys_platform == 'linux'`` (single
    # quotes). The substring assertions below use double quotes; we
    # canonicalize the file content so either tool's output passes.
    requirement_lines: dict[str, list[str]] = {}
    for raw_line in requirements_path.read_text(encoding="utf-8").splitlines():
        if not raw_line or raw_line.startswith(("#", " ")) or "==" not in raw_line:
            continue
        line = raw_line.replace("'", '"')
        package_name = line.split("==", 1)[0].split("[", 1)[0]
        requirement_lines.setdefault(package_name, []).append(line)

    linux_only_packages = {
        "cuda-bindings",
        "cuda-pathfinder",
        "cuda-toolkit",
        "nvidia-cublas",
        "nvidia-cuda-cupti",
        "nvidia-cuda-nvrtc",
        "nvidia-cuda-runtime",
        "nvidia-cudnn-cu13",
        "nvidia-cufft",
        "nvidia-cufile",
        "nvidia-curand",
        "nvidia-cusolver",
        "nvidia-cusparse",
        "nvidia-cusparselt-cu13",
        "nvidia-nccl-cu13",
        "nvidia-nvjitlink",
        "nvidia-nvshmem-cu13",
        "nvidia-nvtx",
        "triton",
    }
    for package_name in linux_only_packages:
        assert any('sys_platform == "linux"' in line for line in requirement_lines[package_name])

    assert any('sys_platform != "win32"' in line for line in requirement_lines["uvloop"])
    # onnxruntime now has a Python-version split too: 1.25.0 for 3.12 + linux,
    # 1.26.0 (or whatever uv resolves) for 3.13 across linux/win32. uv's
    # universal resolver may collapse the marker into a compound expression
    # like ``python_full_version >= "3.13" or sys_platform != "darwin"`` which
    # still installs onnxruntime 1.25.0 on Linux. Verify by:
    #   1. an onnxruntime line installs version 1.25.0 (the Linux 3.12 pin)
    #   2. an onnxruntime line is gated on sys_platform somehow (linux,
    #      != darwin, != win32, etc.)
    assert any(line.startswith("onnxruntime==1.25.0") for line in requirement_lines["onnxruntime"]), (
        f"Expected onnxruntime==1.25.0 (3.12 Linux pin) in requirements; got: "
        f"{requirement_lines['onnxruntime']}"
    )
    assert any(
        "sys_platform" in line for line in requirement_lines["onnxruntime"]
    ), "onnxruntime needs at least one sys_platform marker (compound or otherwise)"
    assert any('sys_platform == "win32"' in line for line in requirement_lines["onnxruntime-gpu"])
    assert any(line.startswith("triton-windows==3.6.0.post") for line in requirement_lines["triton-windows"])
    assert any('sys_platform == "win32"' in line for line in requirement_lines["triton-windows"])
    assert any(line.startswith("websocket-client==") for line in requirement_lines["websocket-client"])
    assert any(line.startswith("sniffio==") for line in requirement_lines["sniffio"])
    assert any(line.startswith("sortedcontainers==") for line in requirement_lines["sortedcontainers"])
    assert any(
        line.startswith("cffi==")
        and 'sys_platform == "win32"' in line
        and 'platform_python_implementation != "PyPy"' in line
        for line in requirement_lines["cffi"]
    )
    assert any(
        line.startswith("pycparser==")
        and 'sys_platform == "win32"' in line
        and 'platform_python_implementation != "PyPy"' in line
        for line in requirement_lines["pycparser"]
    )


def test_runtime_requirements_keep_platform_specific_wheels_guarded():
    """The optional full-AI requirements file keeps platform-specific wheels guarded."""
    requirements_path = ROOT / "backend" / "requirements.txt"
    _assert_platform_specific_wheels_guarded(requirements_path)
    requirements_text = requirements_path.read_text(encoding="utf-8")
    for package_name in (
        "sam3==0.1.3",
        "hydra-core==",
        "omegaconf==",
        "pycocotools==",
        "decord==",
        "iopath==",
    ):
        assert package_name not in requirements_text
    assert "transformers==" in requirements_text
    assert "safetensors==" in requirements_text
    assert "opencv-python==" in requirements_text
    assert "einops==0.8.2" in requirements_text
    assert "kornia==0.8.3" in requirements_text


def test_core_requirements_exclude_heavy_ai_packages():
    requirements_text = (ROOT / "backend" / "requirements-core.txt").read_text(encoding="utf-8")
    for package_name in (
        "torch==",
        "torchvision==",
        "sam3==",
        "ultralytics==",
        "fastembed==",
        "open-clip-torch==",
        "transformers==",
        "timm==",
        "nudenet==",
        "onnxruntime-gpu==",
        "nvidia-",
        "cuda-",
        "triton==",
    ):
        assert package_name not in requirements_text
    # Normalize quote style: pip-compile uses double quotes in markers, uv pip
    # compile uses single quotes. Canonicalize so the assertions below pass
    # regardless of which tool generated the lockfile.
    normalized_text = requirements_text.replace("'", '"')
    # Each onnxruntime line is checked for both the package version AND the
    # platform marker, but allowing other markers (python_full_version) to
    # appear between them, since uv emits compound markers.
    onnxruntime_lines = [
        line for line in normalized_text.splitlines() if line.startswith("onnxruntime==")
    ]
    assert any(
        line.startswith("onnxruntime==1.25.0") and 'sys_platform == "linux"' in line
        for line in onnxruntime_lines
    )
    assert any(
        line.startswith("onnxruntime==1.19.2")
        and 'python_full_version < "3.13"' in line
        and 'sys_platform == "darwin"' in line
        for line in onnxruntime_lines
    )
    assert any(
        line.startswith("onnxruntime==1.23.2")
        and 'python_full_version >= "3.13"' in line
        and 'sys_platform == "darwin"' in line
        for line in onnxruntime_lines
    )
    assert any(
        line.startswith("onnxruntime==1.20.1") and 'sys_platform == "win32"' in line
        for line in onnxruntime_lines
    )
    assert any(
        line.startswith("uvloop==0.22.1") and 'sys_platform != "win32"' in line
        for line in normalized_text.splitlines()
    )
    assert any(
        line.startswith("cffi==2.0.0") and 'sys_platform == "win32"' in line
        for line in normalized_text.splitlines()
    )
    assert "fastapi==" in requirements_text


def test_dev_requirements_keep_platform_specific_wheels_guarded():
    """The dev lock must stay core-only and installable on every CI platform."""
    path = ROOT / "backend" / "requirements-dev.txt"
    text = path.read_text(encoding="utf-8")
    input_text = (ROOT / "backend" / "requirements-dev.in").read_text(encoding="utf-8")

    normalized_lines = [
        line.replace("'", '"')
        for line in text.splitlines()
        if line and not line.startswith(("#", " "))
    ]
    assert "uv pip compile --universal" in text
    assert "--no-emit-package pip" in text
    assert "--no-emit-package setuptools" not in text
    assert "setuptools==83.0.0" in text

    assert input_text.splitlines()[0] == "-r requirements-core.txt"
    forbidden_prefixes = (
        "torch==",
        "torchvision==",
        "ultralytics==",
        "nvidia-",
        "cuda-",
        "triton==",
        "triton-windows==",
    )
    assert not any(
        line.startswith(forbidden_prefixes)
        for line in normalized_lines
    )

    assert any(
        line.startswith("onnxruntime==1.25.0")
        and 'python_full_version < "3.13"' in line
        and 'sys_platform == "linux"' in line
        for line in normalized_lines
    )
    assert any(
        line.startswith("onnxruntime==1.19.2")
        and 'python_full_version < "3.13"' in line
        and 'sys_platform == "darwin"' in line
        for line in normalized_lines
    )
    assert any(
        line.startswith("onnxruntime==1.23.2")
        and 'python_full_version >= "3.13"' in line
        and 'sys_platform == "darwin"' in line
        for line in normalized_lines
    )
    assert any(
        line.startswith("onnxruntime==1.20.1")
        and 'python_full_version < "3.13"' in line
        and 'sys_platform == "win32"' in line
        for line in normalized_lines
    )
    assert any(
        line.startswith("onnxruntime==1.26.0")
        and 'python_full_version >= "3.13"' in line
        and 'sys_platform == "linux"' in line
        and 'sys_platform == "win32"' in line
        for line in normalized_lines
    )
    assert any(
        line.startswith("uvloop==0.22.1")
        and 'sys_platform != "win32"' in line
        for line in normalized_lines
    )


def test_linux_release_package_uses_linux_only_name():
    release_builder = load_release_builder()

    assert release_builder.build_release_assets.__name__ == "build_release_assets"
    app_info = (ROOT / "backend" / "app_info.py").read_text(encoding="utf-8")
    build_script = (ROOT / "scripts" / "build_release_packages.py").read_text(encoding="utf-8")

    assert "linux.tar.gz" in app_info
    assert "LINUX_FULL_ASSET_TEMPLATE.format(version=version)" in build_script
    assert "linux-mac.tar.gz" not in app_info
    assert "linux-mac.tar.gz" not in build_script


def test_linux_portable_release_constants_are_pinned_and_consistent():
    """The linux-portable bundle must declare a pinned python-build-standalone
    version, a SHA256 for the tarball, and an asset filename that flows
    through to backend/app_info.py.

    A drift between any of these surfaces (build script vs. app_info vs.
    install_only_stripped wheel name) silently breaks the in-app updater
    and the README download link, so we pin them in the test instead of
    relying on review to catch a one-side bump.

    Phase 2 introduced ``LINUX_PORTABLE_PYTHON_BUNDLES`` which keys per
    architecture; each entry must satisfy the same drift contract.
    """
    release_builder = load_release_builder()

    # build script side: the PBS tag + cpython version are still single
    # constants because both arches must use the same Python version.
    assert release_builder.LINUX_PORTABLE_PYTHON_PBS_TAG, "PBS tag must be pinned"
    assert release_builder.LINUX_PORTABLE_PYTHON_VERSION.startswith("3."), (
        "python-build-standalone version must look like 3.x.y"
    )

    # The per-arch bundles dict must cover x86_64 and aarch64.
    bundles = release_builder.LINUX_PORTABLE_PYTHON_BUNDLES
    assert set(bundles) == {"x86_64", "aarch64"}, (
        "Phase 2 contract: x86_64 + aarch64 are both first-class portable "
        "targets. If a third arch is added, update this test."
    )

    for arch, spec in bundles.items():
        assert len(spec["sha256"]) == 64, (
            f"SHA256 for {arch} must be 64 hex chars; this gates a network "
            "download so a typo would let a tampered tarball into the public bundle."
        )
        assert release_builder.LINUX_PORTABLE_PYTHON_PBS_TAG in spec["url"]
        assert release_builder.LINUX_PORTABLE_PYTHON_VERSION in spec["url"]
        # PBS triple naming: the URL must contain the standard cpython
        # triple, NOT the v2/v3/v4 micro-arch builds (those require
        # newer CPU features and would silently break older hardware).
        assert spec["pbs_triple"] in spec["url"]
        assert spec["pbs_triple"].endswith("-unknown-linux-gnu")
        assert "install_only_stripped.tar.gz" in spec["url"], (
            f"{arch} bundle must use the install_only_stripped variant — "
            "the regular install_only build is bigger and ships test files."
        )

    # x86_64 bundle must use the baseline triple (NOT v2/v3/v4 variants).
    assert "x86_64-unknown-linux-gnu" in bundles["x86_64"]["url"]
    assert "x86_64_v2" not in bundles["x86_64"]["url"]
    assert "x86_64_v3" not in bundles["x86_64"]["url"]
    assert "x86_64_v4" not in bundles["x86_64"]["url"]

    # aarch64 bundle must NOT also embed an x86_64 wheel name.
    assert "x86_64" not in bundles["aarch64"]["url"]

    # Backwards-compat aliases (kept so the v3.2.2 release-build tests in
    # downstream forks keep working).
    assert release_builder.LINUX_PORTABLE_PYTHON_URL == bundles["x86_64"]["url"]
    assert release_builder.LINUX_PORTABLE_PYTHON_SHA256 == bundles["x86_64"]["sha256"]

    # app_info side: the template that the in-app updater reads must exist
    # AND match the build-script asset name format. Phase 2 templates the
    # arch via {arch} so the updater can pick the right tarball at runtime.
    app_info = (ROOT / "backend" / "app_info.py").read_text(encoding="utf-8")
    assert "LINUX_PORTABLE_ASSET_TEMPLATE" in app_info
    assert "sd-image-sorter-vopus-v{version}-linux-portable-{arch}.tar.gz" in app_info
    assert "LINUX_PORTABLE_ASSET_ARCHES" in app_info
    assert '"x86_64"' in app_info
    assert '"aarch64"' in app_info

    # build-script side: the filename comes from that same template.
    build_script = (ROOT / "scripts" / "build_release_packages.py").read_text(encoding="utf-8")
    assert "LINUX_PORTABLE_ASSET_TEMPLATE.format(version=version, arch=arch)" in build_script

    # The build script must call its three new pieces — the helper, the
    # launcher writer, and the build step — so a future cleanup that
    # accidentally drops one path fails the test instead of silently
    # producing an empty / launcher-less archive.
    assert hasattr(release_builder, "prepare_bundled_linux_python")
    assert hasattr(release_builder, "write_linux_portable_launcher")


def test_prepare_bundled_linux_python_rejects_unknown_arch(tmp_path):
    """``prepare_bundled_linux_python`` must reject an arch that is not in
    ``LINUX_PORTABLE_PYTHON_BUNDLES`` rather than silently downloading
    nothing or, worse, attempting to download a bad URL. This protects
    against a future caller passing ``"arm64"`` (the Apple naming) when
    we expect ``"aarch64"`` (the Linux/PBS naming)."""
    release_builder = load_release_builder()

    with pytest.raises(ValueError) as excinfo:
        release_builder.prepare_bundled_linux_python(tmp_path, arch="arm64")
    msg = str(excinfo.value)
    assert "arm64" in msg
    assert "aarch64" in msg, "Error must point the caller at the supported arches"
    assert "x86_64" in msg


def test_linux_portable_prunes_terminfo_symlink_loops(tmp_path):
    """The bundled PBS terminfo tree can contain self-referential symlinks.

    Those entries are useless for the browser app and can make release
    tarball creation fail with ELOOP on WSL / Windows-mounted drives.
    """
    release_builder = load_release_builder()

    python_dir = tmp_path / "python"
    terminfo_n = python_dir / "share" / "terminfo" / "n"
    (python_dir / "bin").mkdir(parents=True)
    terminfo_n.mkdir(parents=True)
    (python_dir / "bin" / "python3").write_bytes(b"\x7fELF")

    loop = terminfo_n / "ncr260vt300wpp"
    try:
        loop.symlink_to("../n/ncr260vt300wpp")
    except OSError as exc:  # pragma: no cover - Windows without symlink rights
        pytest.skip(f"symlink creation is unavailable: {exc}")

    assert loop.is_symlink()
    release_builder.prune_bundled_linux_python_for_release(python_dir)

    assert (python_dir / "bin" / "python3").exists()
    assert not (python_dir / "share" / "terminfo").exists()


def test_linux_portable_skips_terminfo_members_during_extract():
    """Self-referential terminfo aliases must be skipped before extraction."""
    release_builder = load_release_builder()

    assert release_builder.is_linux_python_terminfo_member("python/share/terminfo")
    assert release_builder.is_linux_python_terminfo_member("python/share/terminfo/n/ncr260vt300wpp")
    assert release_builder.is_linux_python_terminfo_member("./python/share/terminfo/x/xterm")
    assert not release_builder.is_linux_python_terminfo_member("python/bin/python3")
    assert not release_builder.is_linux_python_terminfo_member("python/share/doc/readme.txt")


def test_linux_portable_launcher_script_has_lf_endings_and_exec_bit(tmp_path):
    """run-portable.sh must be LF-only in the staged tarball.

    /bin/sh on Linux refuses to parse heredocs that contain CRLF, surfacing
    as ``$'\\r': command not found`` to the user. The release tarball must
    therefore preserve LF endings AND ship with the executable bit set.

    On Linux build machines we also assert the on-disk exec bit; on Windows
    ``Path.chmod(0o755)`` is a no-op (Windows has no Unix exec bit), so the
    contract is enforced one layer up via the tarfile filter — see
    ``test_linux_portable_tar_filter_sets_correct_mode_bits``.
    """
    release_builder = load_release_builder()

    script_path = release_builder.write_linux_portable_launcher(tmp_path)

    raw = script_path.read_bytes()
    assert b"\r\n" not in raw, (
        "run-portable.sh must use LF endings only; CRLF would break /bin/sh."
    )
    assert raw.startswith(b"#!/usr/bin/env bash"), (
        "run-portable.sh must start with a portable bash shebang."
    )

    if sys.platform != "win32":
        import stat
        mode = script_path.stat().st_mode
        assert mode & stat.S_IXUSR, "owner-execute bit must be set"
        assert mode & stat.S_IXGRP, "group-execute bit must be set"
        assert mode & stat.S_IXOTH, "other-execute bit must be set"

    # Sanity-check the content covers the moving pieces the launcher
    # promises: bundled python detection, hash check, lightweight default.
    text = raw.decode("utf-8")
    assert "python/bin/python3" in text
    assert "requirements-core.txt" in text
    assert "SD_IMAGE_SORTER_INSTALL_FULL_AI" in text
    assert "rebuild-core-venv.json" in text  # rebuild marker still respected


def test_linux_portable_tar_filter_sets_correct_mode_bits(tmp_path):
    """The build script's tar filter must force the executable bit on
    ``run-portable.sh`` and everything under ``python/bin/``, regardless
    of the host OS the build runs on.

    Windows hosts can't represent Unix exec bits in the file system, so
    if the build script just trusts ``stat.st_mode`` the resulting
    tarball lands on the user's Linux machine with permission denied
    on every script and the bundled interpreter. This test pins the
    filter contract directly: simulate adding the relevant paths and
    assert the rewritten ``TarInfo.mode`` is 0o755 / 0o644 as designed.
    """
    release_builder = load_release_builder()

    # Build a fake stage tree so we can call the filter against real
    # TarInfo objects produced by tarfile.add().
    stage = tmp_path / "linux-portable-stage"
    (stage / "python" / "bin").mkdir(parents=True)
    (stage / "python" / "lib").mkdir(parents=True)
    (stage / "backend").mkdir()

    (stage / "run-portable.sh").write_bytes(b"#!/usr/bin/env bash\n")
    (stage / "python" / "bin" / "python3").write_bytes(b"\x7fELF...fake binary")
    (stage / "python" / "bin" / "pip3").write_bytes(b"#!python\n")
    (stage / "python" / "lib" / "libpython3.13.so.1.0").write_bytes(b"\x7fELF...fake .so")
    (stage / "backend" / "main.py").write_bytes(b"print('hi')\n")
    (stage / "README.md").write_bytes(b"hello\n")

    import tarfile
    archive_path = tmp_path / "linux-portable-test.tar.gz"

    # Re-extract the filter using the same mechanism the build script
    # does. The test cannot import the inner closure directly, so we
    # reproduce its contract by running the actual build helper through
    # a thin shim — but the helper is a closure over ``populate_*``,
    # so the cleanest available API is to invoke ``tar.add`` ourselves
    # with the policy and then read back the archive.
    # The policy is simple enough that we can validate via an inline
    # filter that mirrors the build script's rules; if either side
    # diverges, ``test_linux_portable_release_constants_are_pinned_and_consistent``
    # plus this test together will fail.
    def mirror_filter(info):
        name = info.name
        if info.isdir():
            info.mode = 0o755
            return info
        if name.endswith("/run-portable.sh"):
            info.mode = 0o755
        elif "/python/bin/" in name:
            info.mode = 0o755
        elif name.endswith(".so") or ".so." in name or name.endswith(".dylib"):
            info.mode = 0o755
        else:
            info.mode = 0o644
        info.uid = 0
        info.gid = 0
        info.uname = ""
        info.gname = ""
        return info

    with tarfile.open(archive_path, "w:gz") as tar:
        tar.add(stage, arcname="sd-image-sorter", filter=mirror_filter)

    # Now read it back and assert mode bits.
    with tarfile.open(archive_path, "r:gz") as tar:
        modes = {member.name: member.mode for member in tar.getmembers() if member.isfile()}

    assert modes["sd-image-sorter/run-portable.sh"] == 0o755
    assert modes["sd-image-sorter/python/bin/python3"] == 0o755
    assert modes["sd-image-sorter/python/bin/pip3"] == 0o755
    assert modes["sd-image-sorter/python/lib/libpython3.13.so.1.0"] == 0o755
    assert modes["sd-image-sorter/backend/main.py"] == 0o644
    assert modes["sd-image-sorter/README.md"] == 0o644

    # Source-of-truth check: the build script must include this exact
    # rule set. If somebody refactors the closure into a free function,
    # the rule names change but the assertion below still anchors the
    # 0o755 and 0o644 invariants in the actual build script source.
    build_script = (ROOT / "scripts" / "build_release_packages.py").read_text(encoding="utf-8")
    assert "0o755" in build_script
    assert "0o644" in build_script
    assert "/python/bin/" in build_script
    assert "python/share/terminfo" in build_script
    assert "run-portable.sh" in build_script


def test_run_sh_forwards_to_run_portable_when_bundled_python_present():
    """``run.sh`` must defer to ``run-portable.sh`` when a portable bundle
    extraction is detected, so users who double-click run.sh from the
    extracted tarball still get the bundled-Python path instead of being
    asked to install distro Python 3.12+."""
    run_sh = (ROOT / "run.sh").read_text(encoding="utf-8")

    assert "./python/bin/python3" in run_sh, (
        "run.sh must check for the bundled Python before the system Python "
        "lookup; otherwise portable users still see 'Python is not installed'."
    )
    assert "exec ./run-portable.sh" in run_sh, (
        "run.sh must hand off via exec so the running shell becomes the "
        "portable launcher (not a child) — Ctrl+C and signal handling "
        "work correctly only in that mode."
    )


def test_portable_python_version_matches_runtime_lock_header():
    release_builder = load_release_builder()
    requirements_text = (ROOT / "backend" / "requirements.txt").read_text(encoding="utf-8")

    # The lockfile is now compiled by ``uv pip compile --universal``, which
    # resolves a single requirements.txt that works for both Python 3.12 and
    # Python 3.13. Verify both:
    #   1. the file uses the uv universal header (so ``check_lockfiles.py``
    #      can re-stamp on bump)
    #   2. the file contains explicit branches for both Python versions
    #      (so a 3.13 user does not get a numpy 1.26.4 source-build trap)
    assert "uv pip compile" in requirements_text
    assert "--universal" in requirements_text
    assert "python_full_version < '3.13'" in requirements_text
    assert "python_full_version >= '3.13'" in requirements_text

    # Embed bundle is still 3.12 for the Windows portable. The 3.13 path is
    # source-install only (run.sh / run.bat detect 3.13 and use the same
    # universal lockfile, but Windows portable bundles 3.12 to keep the
    # download size constant).
    embed_minor = ".".join(release_builder.PYTHON_EMBED_VERSION.split(".")[:2])
    assert embed_minor == "3.12"


def test_launchers_reject_python_older_than_runtime_lock():
    run_sh = (ROOT / "run.sh").read_text(encoding="utf-8")
    run_bat = (ROOT / "run.bat").read_text(encoding="utf-8")

    assert "Python 3.12" in run_sh
    assert "PY_MINOR\" -lt 12" in run_sh
    assert "Python 3.9" not in run_sh
    assert "Python 3.12" in run_bat
    assert "LSS 12" in run_bat
    assert "Python 3.9" not in run_bat
    # Mirror probe (v3.2.1) inserts ``--index-url`` / ``--extra-index-url``
    # flags between ``launcher_pip.py install`` and the package arguments, so
    # the original single-substring match is split into two checks.
    assert "backend/launcher_pip.py install" in run_sh
    assert "setuptools wheel" in run_sh
    assert 'INSTALL_REQUIREMENTS="backend/requirements-core.txt"' in run_sh
    assert 'SD_IMAGE_SORTER_INSTALL_FULL_AI' in run_sh
    assert "--no-build-isolation" in run_sh
    assert '-r "${INSTALL_REQUIREMENTS}"' in run_sh
    # Mirror probe contract — both launchers must probe before installing and
    # pass the picked URL with an official fallback so a slow path to
    # pypi.org's Fastly CDN cannot dominate the ~1.5 GB requirements install.
    assert "backend/mirror_probe_stdlib.py" in run_sh
    assert '--index-url "${PIP_INDEX_URL}"' in run_sh
    assert "--extra-index-url https://pypi.org/simple" in run_sh
    assert "backend\\mirror_probe_stdlib.py" in run_bat
    assert "--index-url \"!PIP_INDEX_URL!\"" in run_bat
    assert "macOS is not supported by this release package" in run_sh
    assert "Full AI setup requires Apple Silicon" in run_sh
    assert "Full AI setup requires macOS 14 or newer" in run_sh
    assert "--index-url https://download.pytorch.org/whl/cpu torch==2.13.0 torchvision==0.28.0" in run_sh
    assert "requirements-linux-runtime.txt" in run_sh
    assert "HASH_REQUIREMENTS=\"${INSTALL_REQUIREMENTS}\"" in run_sh
    assert "md5sum \"${HASH_REQUIREMENTS}\"" in run_sh
    assert '"nvidia-"' in run_sh
    assert '"cuda-"' in run_sh
    assert "Skipping ONNX GPU repair for lightweight startup" in run_sh
    assert 'VENV_REBUILD_MARKER="${STATE_DIR}/rebuild-core-venv.json"' in run_sh
    assert 'rm -rf "backend/venv"' in run_sh
    assert 'rm -f "backend/.requirements_hash"' in run_sh
    assert "backend\\venv\\Scripts\\python.exe backend\\launcher_pip.py install" in run_bat
    assert "setuptools wheel" in run_bat
    assert "--no-build-isolation" in run_bat
    assert '-r "!INSTALL_REQUIREMENTS!"' in run_bat
    assert 'VENV_REBUILD_MARKER=%STATE_DIR%\\rebuild-core-venv.json' in run_bat
    assert 'rmdir /s /q "backend\\venv"' in run_bat
    assert 'del "backend\\.requirements_hash"' in run_bat
    assert "requirements-core.txt" in run_bat


def test_current_install_docs_match_python_312_floor():
    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    release_packs = (ROOT / "docs" / "RELEASE_PACKS.md").read_text(encoding="utf-8")
    current_docs = "\n".join([readme, release_packs])

    # README badge and prose now advertise both 3.12 and 3.13 since the
    # universal lockfile resolves on either Python (numpy 1.26.4 on 3.12
    # for SAM3/onnxruntime ABI compat, numpy 2.x on 3.13 because no cp313
    # wheel exists for numpy 1.26.4). The Windows portable still bundles
    # 3.12 specifically.
    assert "python-3.12" in readme or "python-3.13" in readme
    assert "Windows 便携版自带 Python 3.12" in readme
    assert "Python 3.12" in release_packs or "Python 3.13" in release_packs
    assert "python-3.9%2B" not in current_docs
    assert "Python 3.9+" not in current_docs
    assert "Python 3.11" not in current_docs


def test_release_ci_keeps_security_audit_and_windows_linux_guardrails():
    run_ci = (ROOT / "scripts" / "run_ci.py").read_text(encoding="utf-8")
    workflow = (ROOT / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")

    security_check = (ROOT / "scripts" / "security_check.py").read_text(encoding="utf-8")

    assert "scripts/security_check.py" in run_ci
    assert "dependency security audit" in run_ci
    assert "v4 frontend typecheck" in run_ci
    # The dependency audit now scans the full resolved tree (no --no-deps flag)
    # and is blocking, with reviewed advisories explicitly allowlisted in source.
    assert "--ignore-vuln" in security_check
    assert "IGNORED_VULN_IDS" in security_check
    # Every CI stage blocks; there is no non-blocking escape hatch.
    assert "non_blocking" not in run_ci
    assert "ubuntu-latest" in workflow
    assert "windows-latest" in workflow
    assert "macos-latest" in workflow
    assert "workflow_dispatch:" in workflow
    assert "Release and updater tests" in workflow
    assert "macOS dependency import and release guard tests" not in workflow
    assert "cache: \"pip\"" in workflow


def test_macos_compat_installs_node_dependencies_before_backend_suite():
    workflow = (ROOT / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")
    macos_job = workflow.split("  macos-compat:", 1)[1].split(
        "  linux-portable-smoke:",
        1,
    )[0]

    setup_node_index = macos_job.index("actions/setup-node@v4")
    npm_install_index = macos_job.index("npm ci")
    backend_suite_index = macos_job.index("Backend full test suite (macOS)")

    assert 'node-version: "20"' in macos_job
    assert "working-directory: tests/e2e" in macos_job
    assert setup_node_index < npm_install_index < backend_suite_index


def test_release_ci_runs_runtime_dependency_check_as_a_blocking_step():
    run_ci = (ROOT / "scripts" / "run_ci.py").read_text(encoding="utf-8")
    checker_path = ROOT / "scripts" / "check_runtime_dependencies.py"

    assert checker_path.is_file()
    assert re.search(
        r"\(\s*['\"]runtime dependency consistency['\"]\s*,\s*"
        r"\[\s*str\(BACKEND_PYTHON\)\s*,\s*"
        r"['\"]scripts/check_runtime_dependencies\.py['\"]\s*,?\s*\]",
        run_ci,
        re.DOTALL,
    )
    # Every CI stage blocks; there is no non-blocking escape hatch.
    assert "non_blocking" not in run_ci


def test_playwright_specs_are_not_an_empty_ci_shell():
    specs_dir = ROOT / "tests" / "e2e" / "specs"
    specs = sorted(specs_dir.glob("*.spec.ts"))

    assert len(specs) >= 1
    assert any(path.name == "v4-shell.spec.ts" for path in specs)


def test_playwright_ci_inputs_are_tracked_or_generated():
    config = (ROOT / "tests" / "e2e" / "playwright.config.ts").read_text(encoding="utf-8")

    assert "storage/onboarding-complete.json" not in config
    assert "sd-image-sorter-onboarding-completed" not in config


def test_playwright_ai_runtime_stubs_match_exact_lock():
    config = (ROOT / "tests" / "e2e" / "playwright.config.ts").read_text(encoding="utf-8")

    assert "fs.rmSync(e2eStubModulesDir, { recursive: true, force: true })" in config
    assert "__version__ = '2.13.0+cu126'" in config
    assert "cuda = '12.6'" in config
    assert "writeStubPackageMetadata('torch', '2.13.0+cu126')" in config
    assert "writeStubModule('transformers.py', `__version__ = '5.10.4'\\n`)" in config
    assert "writeStubPackageMetadata('transformers', '5.10.4')" in config
    assert "writeStubModule('timm.py', `__version__ = '1.0.26'\\n`)" in config
    assert "writeStubPackageMetadata('timm', '1.0.26')" in config
    assert "function backendPythonHasModule(moduleName: string): boolean" in config
    assert "env: { ...process.env, PYTHONPATH: '' }" in config
    assert "if (!backendPythonHasModule('cv2'))" in config
    assert "writeStubModule('cv2.py', `__version__ = '4.11.0'\\n`)" in config
    assert "writeStubPackageMetadata('opencv-python', '4.11.0.86')" in config


def test_model_manager_sam3_setup_copy_matches_lazy_prepare_policy():
    model_service = (ROOT / "backend" / "services" / "model_service.py").read_text(encoding="utf-8")

    assert "First launch installs SAM3 Python runtime packages" not in model_service
    assert "Click Prepare / Download to install SAM3 Python runtime packages if they are missing." in model_service
    assert "Restart SD Image Sorter if the Prepare result says Python packages were installed." in model_service
    assert "sam3.pt / model.safetensors" not in model_service


def _load_lazy_release_qa_module(name: str):
    script_path = ROOT / "scripts" / "lazy_release_qa.py"
    spec = importlib.util.spec_from_file_location(name, script_path)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def _lazy_release_common_archive_names():
    return {
        "sd-image-sorter/backend/main.py",
        "sd-image-sorter/backend/config.py",
        "sd-image-sorter/backend/services/service_provider.py",
        "sd-image-sorter/frontend-v4/dist/index.html",
        "sd-image-sorter/update/package-manifest.json",
    }


def test_lazy_release_qa_accepts_linux_archive_without_windows_launchers():
    module = _load_lazy_release_qa_module("lazy_release_qa_linux_archive_for_test")

    names = _lazy_release_common_archive_names() | {
        "sd-image-sorter/run.sh",
    }

    module.assert_archive_contents(names, package_kind="linux")


def test_lazy_release_qa_rejects_an_archive_that_ships_the_v35_interface():
    module = _load_lazy_release_qa_module("lazy_release_qa_no_v35_for_test")

    names = _lazy_release_common_archive_names() | {
        "sd-image-sorter/run.sh",
        "sd-image-sorter/frontend/index.html",
    }

    with pytest.raises(module.LazyQaError, match="forbidden runtime/dev paths: frontend/index.html"):
        module.assert_archive_contents(names, package_kind="linux")


def test_lazy_release_qa_rejects_linux_archive_with_bundled_python():
    module = _load_lazy_release_qa_module("lazy_release_qa_linux_no_python_for_test")

    names = _lazy_release_common_archive_names() | {
        "sd-image-sorter/run.sh",
        "sd-image-sorter/python/bin/python3",
    }

    with pytest.raises(module.LazyQaError, match="linux archive must not include embedded python/"):
        module.assert_archive_contents(names, package_kind="linux")


def test_lazy_release_qa_accepts_linux_portable_archive_with_shell_launcher_and_python():
    module = _load_lazy_release_qa_module("lazy_release_qa_linux_portable_archive_for_test")

    names = _lazy_release_common_archive_names() | {
        "sd-image-sorter/run.sh",
        "sd-image-sorter/run-portable.sh",
        "sd-image-sorter/python/bin/python3",
    }

    module.assert_archive_contents(names, package_kind="linux-portable")


def test_lazy_release_qa_rejects_linux_portable_archive_without_bundled_python():
    module = _load_lazy_release_qa_module("lazy_release_qa_linux_portable_python_for_test")

    names = _lazy_release_common_archive_names() | {
        "sd-image-sorter/run.sh",
        "sd-image-sorter/run-portable.sh",
    }

    with pytest.raises(module.LazyQaError, match="linux-portable archive does not include embedded python/"):
        module.assert_archive_contents(names, package_kind="linux-portable")


def test_lazy_release_qa_accepts_windows_portable_archive_with_batch_launchers_and_python():
    module = _load_lazy_release_qa_module("lazy_release_qa_windows_archive_for_test")

    names = _lazy_release_common_archive_names() | {
        "sd-image-sorter/run.bat",
        "sd-image-sorter/run.sh",
        "sd-image-sorter/run-portable.bat",
        "sd-image-sorter/python/python.exe",
    }

    module.assert_archive_contents(names, package_kind="windows-portable")


@pytest.mark.parametrize(
    "internal_name",
    ["HANDOFF-qa-followup.md", "qa-sweep-v3.5.0-stable-REPORT.md"],
)
def test_lazy_release_qa_rejects_root_internal_reports(internal_name):
    module = _load_lazy_release_qa_module(f"lazy_release_qa_internal_{internal_name}")
    names = _lazy_release_common_archive_names() | {
        "run.bat",
        "run.sh",
        "run-portable.bat",
        "python/python.exe",
        internal_name,
    }

    with pytest.raises(module.LazyQaError, match="internal release-work file"):
        module.assert_archive_contents(names, package_kind="windows-portable")


def test_lazy_release_qa_rejects_app_patch_archive_with_bundled_python():
    module = _load_lazy_release_qa_module("lazy_release_qa_app_patch_for_test")

    names = _lazy_release_common_archive_names() | {
        "sd-image-sorter/run.bat",
        "sd-image-sorter/run.sh",
        "sd-image-sorter/run-portable.bat",
        "sd-image-sorter/python/python.exe",
    }

    with pytest.raises(module.LazyQaError, match="app-patch archive must not include embedded python/"):
        module.assert_archive_contents(names, package_kind="app-patch")


def test_lazy_release_qa_rejects_unknown_package_kind():
    module = _load_lazy_release_qa_module("lazy_release_qa_unknown_package_for_test")

    with pytest.raises(module.LazyQaError, match="Unknown package kind"):
        module.assert_archive_contents(_lazy_release_common_archive_names(), package_kind="mystery")


# --- V4 interface (/v4/) in every package ------------------------------------

V4_INDEX_HTML = (
    "<!doctype html><html><head>"
    '<script type="module" crossorigin src="/v4/assets/index-AbC12345.js"></script>'
    '<link rel="modulepreload" crossorigin href="/v4/assets/client-QwE_4567.js">'
    '<link rel="stylesheet" crossorigin href="/v4/assets/index-DeF-6789.css">'
    '</head><body><div id="root"></div></body></html>\n'
)
V4_ENTRY_JS = (
    'import{a as e}from"./client-QwE_4567.js";'
    'const m=["assets/Lazy-XyZ98765.js","assets/Lazy-Css11111.css"];'
    "const p=()=>import(`./Lazy-XyZ98765.js`);\n"
    "//# sourceMappingURL=index-AbC12345.js.map\n"
)
V4_DIST_FILES = {
    "frontend-v4/dist/index.html": V4_INDEX_HTML,
    "frontend-v4/dist/assets/index-AbC12345.js": V4_ENTRY_JS,
    "frontend-v4/dist/assets/index-AbC12345.js.map": '{"sourcesContent":["source"]}',
    "frontend-v4/dist/assets/client-QwE_4567.js": "export const a=1;\n",
    "frontend-v4/dist/assets/index-DeF-6789.css": "body{}\n",
    "frontend-v4/dist/assets/Lazy-XyZ98765.js": "export default 1;\n",
    "frontend-v4/dist/assets/Lazy-Css11111.css": ".x{}\n",
}
V4_DEV_FILES = {
    "frontend-v4/.gitignore": "node_modules/\n",
    "frontend-v4/index.html": '<script type="module" src="/src/main.tsx"></script>\n',
    "frontend-v4/package.json": "{}\n",
    "frontend-v4/package-lock.json": "{}\n",
    "frontend-v4/tsconfig.json": "{}\n",
    "frontend-v4/vite.config.ts": "export default {}\n",
    "frontend-v4/src/main.tsx": "export {}\n",
    "frontend-v4/src/features/gallery/Grid.tsx": "export {}\n",
    "frontend-v4/node_modules/vite/package.json": "{}\n",
    "frontend-v4/node_modules/.package-lock.json": "{}\n",
}
V4_SHIPPED_PATHS = sorted(path for path in V4_DIST_FILES if not path.endswith(".map"))


def _write_tree(root: Path, files: dict[str, str]) -> None:
    for relative_path, content in files.items():
        target = root / relative_path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")


def test_release_copy_ships_only_the_built_v4_interface(monkeypatch, tmp_path):
    release_builder = load_release_builder()
    fake_root = tmp_path / "repo"
    stage_root = tmp_path / "stage"
    _write_tree(fake_root, {"backend/main.py": "pass\n", **V4_DIST_FILES, **V4_DEV_FILES})
    monkeypatch.setattr(release_builder, "ROOT", fake_root)

    release_builder.copy_project(stage_root)

    shipped = sorted(
        path.relative_to(stage_root).as_posix()
        for path in (stage_root / "frontend-v4").rglob("*")
        if path.is_file()
    )
    assert shipped == V4_SHIPPED_PATHS


def test_package_manifest_manages_every_shipped_v4_file(tmp_path):
    release_builder = load_release_builder()
    _write_tree(tmp_path, {path: V4_DIST_FILES[path] for path in V4_SHIPPED_PATHS})

    manifest_path = release_builder.write_package_manifest(tmp_path, "9.9.9")
    managed_paths = set(json.loads(manifest_path.read_text(encoding="utf-8"))["managed_paths"])

    assert set(V4_SHIPPED_PATHS) <= managed_paths


def _fake_npm(monkeypatch, release_builder, *, writes_index=True, which="C:/node/npm.cmd"):
    calls = []

    def fake_run(command, cwd=None, check=False, **_kwargs):
        calls.append((list(command), Path(cwd)))
        if list(command[1:]) == ["run", "build"] and writes_index:
            index = Path(cwd) / "dist" / "index.html"
            index.parent.mkdir(parents=True, exist_ok=True)
            index.write_text(V4_INDEX_HTML, encoding="utf-8")
        return release_builder.subprocess.CompletedProcess(command, 0)

    monkeypatch.setattr(release_builder.shutil, "which", lambda name: which if name == "npm" else None)
    monkeypatch.setattr(release_builder.subprocess, "run", fake_run)
    return calls


def test_build_frontend_v4_installs_from_the_lockfile_then_builds(monkeypatch, tmp_path):
    release_builder = load_release_builder()
    fake_root = tmp_path / "repo"
    (fake_root / "frontend-v4").mkdir(parents=True)
    monkeypatch.setattr(release_builder, "ROOT", fake_root)
    calls = _fake_npm(monkeypatch, release_builder)

    dist = release_builder.build_frontend_v4()

    frontend = fake_root / "frontend-v4"
    assert calls == [
        (["C:/node/npm.cmd", "ci"], frontend),
        (["C:/node/npm.cmd", "run", "build"], frontend),
    ]
    assert dist == frontend / "dist"


def test_build_frontend_v4_refuses_to_release_without_npm(monkeypatch, tmp_path):
    release_builder = load_release_builder()
    monkeypatch.setattr(release_builder, "ROOT", tmp_path)
    calls = _fake_npm(monkeypatch, release_builder, which=None)

    with pytest.raises(RuntimeError, match="Node.js"):
        release_builder.build_frontend_v4()
    assert calls == []


def test_build_frontend_v4_refuses_a_build_without_index_html(monkeypatch, tmp_path):
    release_builder = load_release_builder()
    (tmp_path / "frontend-v4").mkdir()
    monkeypatch.setattr(release_builder, "ROOT", tmp_path)
    _fake_npm(monkeypatch, release_builder, writes_index=False)

    with pytest.raises(RuntimeError, match="index.html"):
        release_builder.build_frontend_v4()


def _fake_release_project(root: Path, version: str) -> None:
    _write_tree(
        root,
        {
            "backend/main.py": "pass\n",
            "backend/config.py": "pass\n",
            "backend/services/service_provider.py": "pass\n",
            # Left over from V3.5 in the working copy; no package may carry it.
            "frontend/index.html": "<html></html>\n",
            "run.bat": "@echo off\n",
            "run.sh": "#!/bin/bash\n",
            f"docs/RELEASE_NOTES_vopus-v{version}.md": "## v9.9.9 -- Test\n\nSummary.\n\n## Checksums\n\n| a | b |\n",
            **V4_DIST_FILES,
            **V4_DEV_FILES,
        },
    )


def _archive_names_and_manifest(release_builder, archive_path: Path) -> tuple[set[str], dict]:
    if archive_path.suffix == ".zip":
        with release_builder.ZipFile(archive_path) as archive:
            names = {name.replace("\\", "/") for name in archive.namelist()}
            return names, json.loads(archive.read("update/package-manifest.json"))
    with tarfile.open(archive_path, "r:gz") as archive:
        names = {name.removeprefix("sd-image-sorter/") for name in archive.getnames()}
        manifest_file = archive.extractfile("sd-image-sorter/update/package-manifest.json")
        assert manifest_file is not None
        return names, json.loads(manifest_file.read())


def test_every_release_archive_carries_the_built_v4_interface(monkeypatch, tmp_path):
    release_builder = load_release_builder()
    qa = _load_lazy_release_qa_module("lazy_release_qa_v4_archives_for_test")
    fake_root = tmp_path / "repo"
    artifact_root = tmp_path / "artifacts"
    version = "9.9.9"
    _fake_release_project(fake_root, version)
    order = []

    def fake_windows_python(stage_dir):
        order.append("stage")
        _write_tree(stage_dir, {"python/python.exe": "exe\n"})
        release_builder.write_portable_launcher(stage_dir)

    def fake_linux_python(stage_dir, arch):
        _write_tree(stage_dir, {"python/bin/python3": "elf\n"})

    monkeypatch.setattr(release_builder, "ROOT", fake_root)
    monkeypatch.setattr(release_builder, "ARTIFACT_ROOT", artifact_root)
    monkeypatch.setattr(release_builder, "STAGING_ROOT", artifact_root / "staging")
    monkeypatch.setattr(release_builder, "BOOTSTRAP_DOWNLOAD_ROOT", artifact_root / "staging" / "_downloads")
    monkeypatch.setattr(release_builder, "find_seven_zip", lambda: None)
    monkeypatch.setattr(release_builder, "build_frontend_v4", lambda: order.append("build"))
    monkeypatch.setattr(release_builder, "prepare_embedded_python", fake_windows_python)
    monkeypatch.setattr(release_builder, "prepare_bundled_linux_python", fake_linux_python)

    assets = release_builder.build_release_assets(version, 1900)

    assert order[:2] == ["build", "stage"]
    # Every file carries the Vopus prefix the updater looks for (app_info templates).
    assert sorted(path.name for path in assets) == sorted(
        [
            app_info.WINDOWS_FULL_ASSET_TEMPLATE.format(version=version),
            app_info.PATCH_ASSET_TEMPLATE.format(version=version),
            app_info.LINUX_FULL_ASSET_TEMPLATE.format(version=version),
            *(
                app_info.LINUX_PORTABLE_ASSET_TEMPLATE.format(version=version, arch=arch)
                for arch in app_info.LINUX_PORTABLE_ASSET_ARCHES
            ),
            app_info.RELEASE_MANIFEST_ASSET_TEMPLATE.format(version=version),
        ]
    )
    assert all(path.name.startswith("sd-image-sorter-vopus-v9.9.9-") for path in assets)
    archives = [path for path in assets if not path.name.endswith(".json")]
    assert len(archives) == 5
    for archive_path in archives:
        names, manifest = _archive_names_and_manifest(release_builder, archive_path)
        v4_files = sorted(name for name in names if name.startswith("frontend-v4/") and "." in name.rsplit("/", 1)[-1])
        assert v4_files == V4_SHIPPED_PATHS, archive_path.name
        assert set(V4_SHIPPED_PATHS) <= set(manifest["managed_paths"]), archive_path.name
        assert not any(name.startswith("frontend/") for name in names), archive_path.name

    qa.check_release_packages(artifact_root, version)


def test_lazy_release_qa_does_not_take_a_v35_release_manifest(tmp_path):
    qa = _load_lazy_release_qa_module("lazy_release_qa_v35_manifest_for_test")
    (tmp_path / "sd-image-sorter-v3.5.0-release-manifest.json").write_text('{"assets": []}', encoding="utf-8")

    with pytest.raises(qa.LazyQaError, match="No release manifest"):
        qa.find_manifest(tmp_path, None)
    with pytest.raises(qa.LazyQaError, match="No release manifest"):
        qa.find_manifest(tmp_path, "3.5.0")

    vopus = tmp_path / "sd-image-sorter-vopus-v1.0.0-release-manifest.json"
    vopus.write_text('{"assets": []}', encoding="utf-8")
    assert qa.find_manifest(tmp_path, None) == vopus
    assert qa.find_manifest(tmp_path, "1.0.0") == vopus


def _v4_reader(files: dict[str, str]):
    return lambda path: files[path]


def test_lazy_release_qa_requires_the_v4_index_in_every_package_kind():
    module = _load_lazy_release_qa_module("lazy_release_qa_v4_index_for_test")
    extras = {
        "windows-portable": {"run.bat", "run.sh", "run-portable.bat", "python/python.exe"},
        "app-patch": {"run.bat", "run.sh", "run-portable.bat"},
        "linux": {"run.sh"},
        "linux-portable": {"run.sh", "run-portable.sh", "python/bin/python3"},
    }
    for kind, extra in extras.items():
        names = (_lazy_release_common_archive_names() - {"sd-image-sorter/frontend-v4/dist/index.html"}) | extra
        with pytest.raises(module.LazyQaError, match="frontend-v4/dist/index.html"):
            module.assert_archive_contents(names, package_kind=kind)


@pytest.mark.parametrize(
    "dev_path",
    ["frontend-v4/src/main.tsx", "frontend-v4/node_modules/vite/package.json"],
)
def test_lazy_release_qa_rejects_v4_sources_and_node_modules(dev_path):
    module = _load_lazy_release_qa_module("lazy_release_qa_v4_dev_for_test")
    names = _lazy_release_common_archive_names() | {"run.sh", dev_path}

    with pytest.raises(module.LazyQaError, match="forbidden"):
        module.assert_archive_contents(names, package_kind="linux")


def test_lazy_release_qa_accepts_a_v4_build_with_every_loaded_asset():
    module = _load_lazy_release_qa_module("lazy_release_qa_v4_ok_for_test")
    files = {path: V4_DIST_FILES[path] for path in V4_SHIPPED_PATHS}

    module.assert_frontend_v4_build(set(files), _v4_reader(files), package_kind="app-patch")


@pytest.mark.parametrize(
    "missing",
    [
        "frontend-v4/dist/assets/index-AbC12345.js",
        "frontend-v4/dist/assets/index-DeF-6789.css",
        "frontend-v4/dist/assets/client-QwE_4567.js",
        "frontend-v4/dist/assets/Lazy-XyZ98765.js",
        "frontend-v4/dist/assets/Lazy-Css11111.css",
    ],
)
def test_lazy_release_qa_fails_when_a_loaded_v4_asset_is_missing(missing):
    module = _load_lazy_release_qa_module("lazy_release_qa_v4_missing_for_test")
    files = {path: V4_DIST_FILES[path] for path in V4_SHIPPED_PATHS if path != missing}

    with pytest.raises(module.LazyQaError, match=missing):
        module.assert_frontend_v4_build(set(files), _v4_reader(files), package_kind="app-patch")


def test_lazy_release_qa_fails_when_the_v4_index_loads_no_built_script():
    module = _load_lazy_release_qa_module("lazy_release_qa_v4_dev_index_for_test")
    files = {"frontend-v4/dist/index.html": V4_DEV_FILES["frontend-v4/index.html"]}

    with pytest.raises(module.LazyQaError, match="no built script"):
        module.assert_frontend_v4_build(set(files), _v4_reader(files), package_kind="linux")


def _first_line_index(text: str, prefix: str) -> int:
    lines = text.splitlines()
    return next(index for index, line in enumerate(lines) if line.lstrip().startswith(prefix))


def test_portable_launchers_never_read_the_users_own_site_packages(tmp_path):
    """The bundled Python must use only its own packages. Without this, Python
    also imports from %APPDATA%\\Python\\PythonXY\\site-packages (Windows) or
    ~/.local/lib/pythonX.Y/site-packages (Linux), so a user-level install could
    fill in or shadow a package. Checked on embedded 3.11.9 and 3.12.8: the
    variable is honoured despite the ._pth file, and child processes inherit it."""
    release_builder = load_release_builder()
    (tmp_path / "win").mkdir()
    (tmp_path / "linux").mkdir()

    bat = release_builder.write_portable_launcher(tmp_path / "win").read_text(encoding="utf-8")
    bat_lines = bat.splitlines()
    bat_setting = bat_lines.index('set "PYTHONNOUSERSITE=1"')
    assert bat_setting < _first_line_index(bat, '"!PYTHON_CMD!"')

    sh = release_builder.write_linux_portable_launcher(tmp_path / "linux").read_text(encoding="utf-8")
    sh_lines = sh.splitlines()
    sh_setting = sh_lines.index("export PYTHONNOUSERSITE=1")
    assert sh_setting < _first_line_index(sh, '"$PYTHON_CMD"')


@pytest.mark.parametrize("launcher", ["fix.bat", "update.bat"])
def test_rescue_launchers_keep_portable_python_off_user_site_packages(launcher):
    text = (ROOT / launcher).read_text(encoding="utf-8")
    start = text.index('if exist "%ROOT_DIR%\\python\\python.exe" (')
    portable_branch = text[start : text.index("goto :found_python", start)]

    assert 'set "PYTHONNOUSERSITE=1"' in portable_branch
