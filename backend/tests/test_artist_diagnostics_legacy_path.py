"""Regression test: artist diagnostics path resolver must include the
legacy `<repo>/models/artist/comfyui-lsnet-runtime/` path.

Background
==========
Older installs (pre-3.1.x) downloaded the LSNet runtime to
``<repo>/models/artist/comfyui-lsnet-runtime/`` rather than the modern
``<repo>/data/models/artist/comfyui-lsnet-runtime/`` location. The
runtime identifier (``artist_identifier._resolve_lsnet_runtime_path``)
already probed both paths, but the parallel diagnostics resolver
(``model_health._resolve_artist_runtime_path``) only checked the new
path. Result: the identifier loaded and ran fine, but
``GET /api/artists/diagnostics`` reported ``available: false`` forever
on these installs.

This test pins the parity between the two resolvers so a future drift
fails loud.
"""
from __future__ import annotations

from pathlib import Path

import pytest


@pytest.fixture
def legacy_runtime(tmp_path: Path):
    """Layout a fake legacy <project_root>/models/artist/comfyui-lsnet-runtime."""
    project_root = tmp_path / "fake-project"
    artist_root = project_root / "data" / "models" / "artist"
    legacy_dir = project_root / "models" / "artist" / "comfyui-lsnet-runtime"
    artist_root.mkdir(parents=True, exist_ok=True)
    legacy_dir.mkdir(parents=True, exist_ok=True)
    (legacy_dir / "lsnet_model").mkdir()
    (legacy_dir / "lsnet_model" / "__init__.py").write_text("# fake runtime\n")
    return project_root, artist_root, legacy_dir


def test_diagnostics_finds_legacy_lsnet_runtime(legacy_runtime, monkeypatch):
    project_root, artist_root, legacy_dir = legacy_runtime

    import model_health

    monkeypatch.setattr(model_health, "get_artist_model_dir", lambda: str(artist_root))
    monkeypatch.setattr(
        model_health.Path, "resolve",
        lambda self, *args, **kwargs: Path(self),
    )
    # Patch __file__ so project_root computes from the fake tree.
    fake_module_file = project_root / "backend" / "model_health.py"
    fake_module_file.parent.mkdir(parents=True, exist_ok=True)
    fake_module_file.write_text("# placeholder\n")
    monkeypatch.setattr(model_health, "__file__", str(fake_module_file))

    resolved = model_health._resolve_artist_runtime_path()
    assert resolved is not None, (
        "Diagnostics resolver did not find legacy "
        "<project_root>/models/artist/comfyui-lsnet-runtime/lsnet_model"
    )
    assert "comfyui-lsnet-runtime" in resolved


def test_diagnostics_resolver_parity_with_runtime_resolver(monkeypatch, tmp_path):
    """Both resolvers must accept the same set of legacy + modern paths."""
    import artist_identifier
    import model_health

    project_root = tmp_path / "fake-project"
    artist_root = project_root / "data" / "models" / "artist"
    artist_root.mkdir(parents=True)

    fake_backend = project_root / "backend"
    fake_backend.mkdir()
    fake_module_file = fake_backend / "model_health.py"
    fake_module_file.write_text("# placeholder\n")
    fake_artist_file = fake_backend / "artist_identifier.py"
    fake_artist_file.write_text("# placeholder\n")

    monkeypatch.setattr(model_health, "__file__", str(fake_module_file))
    monkeypatch.setattr(artist_identifier, "__file__", str(fake_artist_file))
    monkeypatch.setattr(model_health, "get_artist_model_dir", lambda: str(artist_root))
    monkeypatch.setattr(artist_identifier, "get_artist_model_dir", lambda: str(artist_root))
    monkeypatch.setattr(model_health, "ARTIST_LSNET_CODE_PATH", "")
    monkeypatch.setattr(artist_identifier, "ARTIST_LSNET_CODE_PATH", "")

    legacy_paths = [
        project_root / "models" / "artist" / "comfyui-lsnet-runtime",
        project_root / "models" / "artist" / "comfyui-lsnet",
        project_root / "models" / "artist" / "lsnet-test",
        project_root / "third_party" / "comfyui-lsnet",
        project_root / "third_party" / "lsnet-test",
    ]
    modern_paths = [
        artist_root / "comfyui-lsnet-runtime",
        artist_root / "comfyui-lsnet",
        artist_root / "lsnet-test",
    ]

    for path in legacy_paths + modern_paths:
        # Wipe previous fixtures and stage just this candidate
        for cleanup in legacy_paths + modern_paths:
            if cleanup.exists():
                import shutil as _sh
                _sh.rmtree(cleanup)
        path.mkdir(parents=True, exist_ok=True)
        (path / "lsnet_model").mkdir()
        (path / "lsnet_model" / "__init__.py").write_text("ok")

        runtime_resolved = artist_identifier._resolve_lsnet_runtime_path()
        diagnostics_resolved = model_health._resolve_artist_runtime_path()

        assert runtime_resolved is not None, f"runtime resolver missed {path}"
        assert diagnostics_resolved is not None, f"diagnostics resolver missed {path}"


def test_resolvers_skip_legacy_repo_paths_when_disable_flag_set(monkeypatch, tmp_path):
    """With SD_IMAGE_SORTER_DISABLE_LEGACY_MODEL_COPY=1 the repo's legacy
    models/artist/ locations are ignored by BOTH resolvers, so a developer's
    real checkout can't shadow the data-dir runtime (hermetic E2E isolation).
    Production never sets the flag, so legacy installs keep resolving.
    """
    import artist_identifier
    import model_health

    project_root = tmp_path / "fake-project"
    artist_root = project_root / "data" / "models" / "artist"
    artist_root.mkdir(parents=True)
    fake_backend = project_root / "backend"
    fake_backend.mkdir()
    (fake_backend / "model_health.py").write_text("# placeholder\n")
    (fake_backend / "artist_identifier.py").write_text("# placeholder\n")
    monkeypatch.setattr(model_health, "__file__", str(fake_backend / "model_health.py"))
    monkeypatch.setattr(artist_identifier, "__file__", str(fake_backend / "artist_identifier.py"))
    monkeypatch.setattr(model_health, "get_artist_model_dir", lambda: str(artist_root))
    monkeypatch.setattr(artist_identifier, "get_artist_model_dir", lambda: str(artist_root))
    monkeypatch.setattr(model_health, "ARTIST_LSNET_CODE_PATH", "")
    monkeypatch.setattr(artist_identifier, "ARTIST_LSNET_CODE_PATH", "")

    # Only a LEGACY repo runtime exists (no data-dir runtime yet).
    legacy_dir = project_root / "models" / "artist" / "comfyui-lsnet-runtime"
    (legacy_dir / "lsnet_model").mkdir(parents=True)
    (legacy_dir / "lsnet_model" / "__init__.py").write_text("ok")

    # Flag unset → legacy IS found (parity with the existing behaviour above).
    monkeypatch.delenv("SD_IMAGE_SORTER_DISABLE_LEGACY_MODEL_COPY", raising=False)
    assert artist_identifier._resolve_lsnet_runtime_path() is not None
    assert model_health._resolve_artist_runtime_path() is not None

    # Flag set → legacy repo paths skipped → nothing resolves (no data-dir runtime).
    monkeypatch.setenv("SD_IMAGE_SORTER_DISABLE_LEGACY_MODEL_COPY", "1")
    assert artist_identifier._resolve_lsnet_runtime_path() is None
    assert model_health._resolve_artist_runtime_path() is None

    # Flag set + a data-dir runtime present → resolves to the data-dir copy.
    modern_dir = artist_root / "comfyui-lsnet-runtime"
    (modern_dir / "lsnet_model").mkdir(parents=True)
    (modern_dir / "lsnet_model" / "__init__.py").write_text("ok")
    runtime_resolved = artist_identifier._resolve_lsnet_runtime_path()
    diag_resolved = model_health._resolve_artist_runtime_path()
    assert runtime_resolved is not None and "data" in runtime_resolved
    assert diag_resolved is not None and "data" in diag_resolved
