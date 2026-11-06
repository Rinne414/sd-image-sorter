"""A test run never touches the real data folder.

Collect tests without a test database added rows to the owner's real library on
every run from 2026-10-23 to 2026-11-07, and other tests overwrote the saved
Manual Sort session. conftest.py now points every data path at a temporary folder
before the backend is imported.
"""

from __future__ import annotations

from pathlib import Path

import config
import db_core

REAL_DATA = Path(__file__).resolve().parents[2] / "data"


def _is_real_data(path) -> bool:
    return Path(path).resolve().is_relative_to(REAL_DATA.resolve())


def test_the_database_used_by_tests_is_not_the_real_one():
    assert not _is_real_data(db_core.DATABASE_PATH)


def test_no_data_folder_used_by_tests_is_the_real_one():
    for name in (
        "DATA_DIR",
        "CONFIG_DIR",
        "STATE_DIR",
        "TEMP_DIR",
        "UPDATE_DIR",
        "THUMBNAIL_DIR",
    ):
        assert not _is_real_data(getattr(config, name)), name
