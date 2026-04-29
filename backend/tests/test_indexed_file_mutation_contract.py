"""Contract tests for save/overwrite ownership."""

from __future__ import annotations

from pathlib import Path

import pytest

from services.indexed_file_mutation_service import preflight_output_write, save_and_reconcile_checked


ROOT = Path(__file__).resolve().parents[2]


def test_preflight_output_write_rejects_existing_target_without_confirmation(tmp_path):
    target = tmp_path / "existing.png"
    target.write_bytes(b"old")

    with pytest.raises(FileExistsError, match="already exists"):
        preflight_output_write(str(target), allow_overwrite=False)


def test_preflight_output_write_rejects_same_source_without_confirmation(tmp_path):
    source = tmp_path / "source.png"
    source.write_bytes(b"old")

    with pytest.raises(FileExistsError, match="same as the source"):
        preflight_output_write(str(source), source_path=str(source), allow_overwrite=False)


def test_save_and_reconcile_checked_reports_target_existence(tmp_path, test_db):
    target = tmp_path / "existing.png"
    target.write_bytes(b"old")

    result = save_and_reconcile_checked(
        str(target),
        lambda output_path, _overwrite: Path(output_path).write_bytes(b"new"),
        allow_overwrite=True,
        backend_file=__file__,
    )

    assert result.target_existed is True
    assert target.read_bytes() == b"new"


def test_feature_save_paths_do_not_own_overwrite_preflight():
    checked_files = [
        ROOT / "backend" / "services" / "image_service.py",
        ROOT / "backend" / "services" / "censor_service.py",
        ROOT / "backend" / "obfuscation.py",
    ]
    violations = []

    for file_path in checked_files:
        source = file_path.read_text(encoding="utf-8")
        if "_ensure_overwrite_allowed" in source:
            violations.append(f"{file_path.relative_to(ROOT)} keeps a feature-local overwrite helper")
        if "output.exists and not allow_overwrite" in source:
            violations.append(f"{file_path.relative_to(ROOT)} keeps caller-owned ImageOutputPath overwrite logic")

    assert not violations, "\n".join(violations)
