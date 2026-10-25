"""Release packages carry the Vopus interface (/vopus/) as its finished build.

Users of a download never build anything: every package must hold
frontend-v4/dist (without its source maps) and nothing else of frontend-v4,
the release QA must refuse a package whose build is missing a file, and CI must
build, test and browser-test Vopus next to the classic interface.
"""

from __future__ import annotations

import hashlib
import importlib.util
import io
import json
import subprocess
import sys
import tarfile
import zipfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]


def _load_script(module_name: str, relative_path: str):
    spec = importlib.util.spec_from_file_location(module_name, ROOT / relative_path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def builder():
    return _load_script(
        "build_release_packages_for_vopus_test", "scripts/build_release_packages.py"
    )


@pytest.fixture
def qa():
    return _load_script("lazy_release_qa_for_vopus_test", "scripts/lazy_release_qa.py")


def _write_tree(root: Path, files: dict[str, str]) -> None:
    for relative_path, content in files.items():
        target = root / relative_path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")


# --- packaging -------------------------------------------------------------


def test_packages_carry_the_vopus_build_but_not_its_sources(
    builder, monkeypatch, tmp_path
):
    fake_root = tmp_path / "repo"
    stage_root = tmp_path / "stage"
    _write_tree(
        fake_root,
        {
            "frontend/index.html": "classic\n",
            "frontend-v4/package.json": "{}\n",
            "frontend-v4/package-lock.json": "{}\n",
            "frontend-v4/vite.config.ts": "source\n",
            "frontend-v4/tsconfig.json": "{}\n",
            "frontend-v4/tsconfig.tsbuildinfo": "{}\n",
            "frontend-v4/index.html": "source entry\n",
            "frontend-v4/src/main.tsx": "source\n",
            "frontend-v4/node_modules/vite/index.js": "dependency\n",
            "frontend-v4/dist/index.html": "built entry\n",
            "frontend-v4/dist/assets/index-AbC12345.js": "built\n",
            "frontend-v4/dist/assets/index-AbC12345.js.map": "source map\n",
            "frontend-v4/dist/assets/favicon-GhI_2345.svg": "<svg/>\n",
        },
    )
    monkeypatch.setattr(builder, "ROOT", fake_root)

    builder.copy_project(stage_root)

    shipped = sorted(
        path.relative_to(stage_root).as_posix()
        for path in (stage_root / "frontend-v4").rglob("*")
        if path.is_file()
    )
    assert shipped == [
        "frontend-v4/dist/assets/favicon-GhI_2345.svg",
        "frontend-v4/dist/assets/index-AbC12345.js",
        "frontend-v4/dist/index.html",
    ]
    assert (stage_root / "frontend" / "index.html").read_text(
        encoding="utf-8"
    ) == "classic\n"


def _fake_frontend(builder, monkeypatch, tmp_path) -> Path:
    fake_root = tmp_path / "repo"
    frontend_dir = fake_root / "frontend-v4"
    _write_tree(frontend_dir, {"package.json": "{}\n", "dist/stale.js": "old build\n"})
    monkeypatch.setattr(builder, "ROOT", fake_root)
    return frontend_dir


def test_release_build_installs_from_the_lockfile_then_builds_vopus(
    builder, monkeypatch, tmp_path
):
    frontend_dir = _fake_frontend(builder, monkeypatch, tmp_path)
    calls = []

    def fake_run(command, *, cwd, check):
        calls.append((command, Path(cwd), check))
        if command[1:] == ["run", "build"]:
            _write_tree(Path(cwd), {"dist/index.html": "built\n"})

    monkeypatch.setattr(
        builder.shutil, "which", lambda name: "NPM" if name == "npm" else None
    )
    monkeypatch.setattr(builder.subprocess, "run", fake_run)

    dist_dir = builder.build_frontend_v4()

    assert calls == [
        (["NPM", "ci"], frontend_dir, True),
        (["NPM", "run", "build"], frontend_dir, True),
    ]
    assert dist_dir == frontend_dir / "dist"
    # An earlier build never survives into the package.
    assert not (dist_dir / "stale.js").exists()


def test_release_build_stops_without_node(builder, monkeypatch, tmp_path):
    _fake_frontend(builder, monkeypatch, tmp_path)
    monkeypatch.setattr(builder.shutil, "which", lambda name: None)

    with pytest.raises(RuntimeError, match="Node.js"):
        builder.build_frontend_v4()


def test_release_build_stops_when_the_build_leaves_no_page(
    builder, monkeypatch, tmp_path
):
    _fake_frontend(builder, monkeypatch, tmp_path)
    monkeypatch.setattr(builder.shutil, "which", lambda name: "NPM")
    monkeypatch.setattr(builder.subprocess, "run", lambda command, *, cwd, check: None)

    with pytest.raises(RuntimeError, match="index.html"):
        builder.build_frontend_v4()


def test_a_failed_vopus_build_leaves_the_previous_packages_alone(
    builder, monkeypatch, tmp_path
):
    artifact_root = tmp_path / "artifacts" / "release"
    _write_tree(artifact_root, {"sd-image-sorter-v1.0.0-app-patch.zip": "previous\n"})
    monkeypatch.setattr(builder, "ARTIFACT_ROOT", artifact_root)
    monkeypatch.setattr(builder, "STAGING_ROOT", artifact_root / "staging")

    def failed_build():
        raise RuntimeError("vite build failed")

    monkeypatch.setattr(builder, "build_frontend_v4", failed_build)

    with pytest.raises(RuntimeError, match="vite build failed"):
        builder.build_release_assets("9.9.9", 1900)

    assert (artifact_root / "sd-image-sorter-v1.0.0-app-patch.zip").is_file()


# --- release QA ------------------------------------------------------------

INDEX_HTML = (
    '<link rel="icon" href="/vopus/assets/favicon-GhI_2345.svg">'
    '<script type="module" crossorigin src="/vopus/assets/index-AbC12345.js"></script>'
    '<link rel="stylesheet" crossorigin href="/vopus/assets/index-DeF67890.css">'
)
VOPUS_BUILD = {
    "frontend-v4/dist/index.html": INDEX_HTML,
    "frontend-v4/dist/assets/favicon-GhI_2345.svg": "<svg/>",
    "frontend-v4/dist/assets/index-AbC12345.js": (
        'const deps = ["assets/Page-MnO12345.css"]; import("./Page-JkL-6789.js");'
    ),
    "frontend-v4/dist/assets/index-DeF67890.css": "body{background:url(/vopus/assets/paper-PqR12345.png)}",
    "frontend-v4/dist/assets/paper-PqR12345.png": "png",
    "frontend-v4/dist/assets/Page-JkL-6789.js": "export {}",
    "frontend-v4/dist/assets/Page-MnO12345.css": ".page{}",
}
COMMON_FILES = {
    "backend/main.py": "",
    "backend/config.py": "",
    "backend/services/service_provider.py": "",
    "frontend/index.html": "",
    "frontend/js/app.js": "",
    "frontend/js/gallery.js": "",
    "browser-extension/manifest.base.json": "{}",
    "browser-extension/src/background.js": "",
    "update/package-manifest.json": "{}",
    **VOPUS_BUILD,
}
FILES_BY_ASSET = {
    "windows-portable.zip": {
        "run.bat": "",
        "run.sh": "",
        "run-portable.bat": "",
        "python/python.exe": "",
        "SD Image Sorter.exe": "",
        "desktop/sd-image-sorter-shell.exe": "",
        "desktop/resources/app.asar": "",
        "desktop/resources.pak": "",
    },
    "app-patch.zip": {"run.bat": "", "run.sh": "", "run-portable.bat": ""},
    "linux.tar.gz": {"run.sh": ""},
    "linux-portable-x86_64.tar.gz": {
        "run.sh": "",
        "run-portable.sh": "",
        "python/bin/python3": "",
    },
    "linux-portable-aarch64.tar.gz": {
        "run.sh": "",
        "run-portable.sh": "",
        "python/bin/python3": "",
    },
}


def _write_release(artifact_root: Path, *, drop_from: str = "", drop: str = "") -> None:
    artifact_root.mkdir(parents=True)
    entries = []
    for suffix, extra in FILES_BY_ASSET.items():
        members = {**COMMON_FILES, **extra}
        if suffix == drop_from:
            members.pop(drop)
        name = f"sd-image-sorter-v9.9.9-{suffix}"
        path = artifact_root / name
        if suffix.endswith(".zip"):
            with zipfile.ZipFile(path, "w") as archive:
                for member, text in members.items():
                    archive.writestr(member, text)
        else:
            with tarfile.open(path, "w:gz") as archive:
                for member, text in members.items():
                    data = text.encode("utf-8")
                    info = tarfile.TarInfo(f"sd-image-sorter/{member}")
                    info.size = len(data)
                    archive.addfile(info, io.BytesIO(data))
        payload = path.read_bytes()
        entries.append(
            {
                "name": name,
                "size_bytes": len(payload),
                "sha256": hashlib.sha256(payload).hexdigest(),
            }
        )
    manifest = artifact_root / "sd-image-sorter-v9.9.9-release-manifest.json"
    manifest.write_text(
        json.dumps(
            {
                "version": "9.9.9",
                "shell_version": "0.1.0",
                "min_shell_version": "0.1.0",
                "assets": entries,
            }
        ),
        encoding="utf-8",
    )


def test_release_qa_accepts_packages_with_the_whole_vopus_build(qa, tmp_path):
    _write_release(tmp_path / "release")

    qa.check_release_packages(tmp_path / "release", "9.9.9")


@pytest.mark.parametrize(
    ("asset", "missing"),
    [
        ("app-patch.zip", "frontend-v4/dist/assets/Page-JkL-6789.js"),
        ("linux-portable-aarch64.tar.gz", "frontend-v4/dist/assets/Page-MnO12345.css"),
        ("windows-portable.zip", "frontend-v4/dist/assets/favicon-GhI_2345.svg"),
        # Loaded only by a stylesheet.
        ("linux.tar.gz", "frontend-v4/dist/assets/paper-PqR12345.png"),
    ],
)
def test_release_qa_refuses_a_package_missing_a_vopus_file(
    qa, tmp_path, asset, missing
):
    _write_release(tmp_path / "release", drop_from=asset, drop=missing)

    with pytest.raises(qa.LazyQaError, match=missing):
        qa.check_release_packages(tmp_path / "release", "9.9.9")


def test_release_qa_refuses_a_package_without_vopus(qa, tmp_path):
    _write_release(
        tmp_path / "release",
        drop_from="linux.tar.gz",
        drop="frontend-v4/dist/index.html",
    )

    with pytest.raises(qa.LazyQaError, match="frontend-v4/dist/index.html"):
        qa.check_release_packages(tmp_path / "release", "9.9.9")


def test_release_qa_refuses_a_vopus_build_made_for_another_address(qa):
    files = {
        **VOPUS_BUILD,
        "frontend-v4/dist/index.html": INDEX_HTML.replace("/vopus/", "/v4/"),
    }

    with pytest.raises(qa.LazyQaError, match="/vopus/"):
        qa.assert_frontend_v4_build(files, files.__getitem__, package_kind="app-patch")


@pytest.mark.parametrize(
    "member", ["frontend-v4/src/main.tsx", "frontend-v4/node_modules/vite/index.js"]
)
def test_release_qa_refuses_vopus_sources_in_a_package(qa, member):
    names = {
        f"sd-image-sorter/{name}"
        for name in {**COMMON_FILES, **FILES_BY_ASSET["linux.tar.gz"]}
    }

    with pytest.raises(qa.LazyQaError, match="forbidden"):
        qa.assert_archive_contents(
            names | {f"sd-image-sorter/{member}"}, package_kind="linux"
        )


# --- CI --------------------------------------------------------------------


def test_full_ci_skips_the_browser_tests_when_the_vopus_build_fails(
    monkeypatch, tmp_path, capsys
):
    # By path, like the other scripts here: `from scripts import run_ci` only
    # worked when an earlier test had put the repo root on sys.path.
    run_ci = _load_script("run_ci_for_vopus_test", "scripts/run_ci.py")

    commands: list[tuple[str, ...]] = []

    def run_command(command, cwd, env):
        normalized = tuple(str(part) for part in command)
        commands.append(normalized)
        is_vopus_build = any(part.endswith("vite.js") for part in normalized)
        return subprocess.CompletedProcess(normalized, 1 if is_vopus_build else 0)

    monkeypatch.setattr(run_ci, "CI_LOCK_PATH", tmp_path / "run-ci.lock")
    monkeypatch.setattr(run_ci, "_prepare_playwright_fixtures", lambda env: True)
    monkeypatch.setattr(run_ci, "_find_available_port", lambda *ports: str(ports[0]))
    monkeypatch.setattr(run_ci.subprocess, "run", run_command)

    assert run_ci.main() == 1

    ran = [part for command in commands for part in command]
    assert any(part.endswith("vite.js") for part in ran)
    assert not any("run-playwright.mjs" in part for part in ran)
    assert "SKIPPED: playwright e2e" in capsys.readouterr().out


def test_full_ci_builds_and_tests_vopus_before_the_browser_tests():
    run_ci = (ROOT / "scripts" / "run_ci.py").read_text(encoding="utf-8")

    stages = [
        '"vopus frontend typecheck"',
        '"vopus frontend unit tests"',
        '"vopus frontend build"',
    ]
    positions = [run_ci.index(stage) for stage in stages]
    assert positions == sorted(positions)
    assert positions[-1] < run_ci.index('"playwright e2e",')
    # The classic interface keeps its own check.
    assert '"frontend js syntax"' in run_ci


def test_ci_workflow_prepares_node_for_vopus():
    workflow = (ROOT / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")
    linux_full = workflow.split("  linux-full:", 1)[1].split(
        "  windows-risk-areas:", 1
    )[0]
    portable = workflow.split("  linux-portable-smoke:", 1)[1]

    # vitest 5 needs Node 22.12 or newer (frontend-v4/package-lock.json engines).
    assert 'node-version: "22"' in linux_full
    install = linux_full.index("working-directory: frontend-v4")
    assert linux_full.index("npm ci", install) < linux_full.index(
        "python scripts/run_ci.py"
    )
    # The package build runs npm ci + npm run build for frontend-v4.
    assert portable.index("actions/setup-node@v4") < portable.index(
        "python scripts/build_release_packages.py"
    )
    assert 'node-version: "22"' in portable
    # The unpacked package must answer at /vopus/ without building anything.
    assert "http://127.0.0.1:8499/vopus/" in portable
