"""Contract checks for migration isolation and frozen helpers."""

from __future__ import annotations

import importlib.util
import re
from pathlib import Path


def _load_migration_006_module():
    migration_path = Path(__file__).resolve().parents[1] / "migrations" / "006_prompt_token_index.py"
    spec = importlib.util.spec_from_file_location("migration_006_prompt_token_index", migration_path)
    assert spec and spec.loader, "failed to load migration 006 module"
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_migration_006_does_not_import_database_module_directly():
    migration_path = Path(__file__).resolve().parents[1] / "migrations" / "006_prompt_token_index.py"
    source = migration_path.read_text(encoding="utf-8")
    assert not re.search(r"^\s*(?:from\s+database\s+import|import\s+database)\b", source, re.MULTILINE), (
        "Migration 006 must remain self-contained and must not import runtime database helpers."
    )


def test_migration_006_tokenizer_matches_frozen_examples():
    migration = _load_migration_006_module()

    extract = migration._extract_prompt_tokens_v1
    assert extract("Best_Quality, MASTERPIECE, high res") == {"best quality", "masterpiece", "high res"}
    assert extract("cat, <lora:style:0.8>, dog") == {"cat", "dog"}
    assert extract("(cat:1.2), (dog:0.8)") == {"cat", "dog"}
    assert extract("") == set()


def _load_migration_003_module():
    migration_path = Path(__file__).resolve().parents[1] / "migrations" / "003_legacy_backfills.py"
    spec = importlib.util.spec_from_file_location("migration_003_legacy_backfills", migration_path)
    assert spec and spec.loader, "failed to load migration 003 module"
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_migration_003_does_not_import_database_module_directly():
    migration_path = Path(__file__).resolve().parents[1] / "migrations" / "003_legacy_backfills.py"
    source = migration_path.read_text(encoding="utf-8")
    assert not re.search(r"^\s*(?:from\s+database\s+import|import\s+database)\b", source, re.MULTILINE), (
        "Migration 003 must remain self-contained and must not import runtime database helpers."
    )


def test_migration_003_lora_extractor_matches_frozen_examples():
    migration = _load_migration_003_module()

    extract = migration._extract_lora_names_v1
    assert extract('["Anima\\\\anime\\\\My_Lora.safetensors", "bad"]', "") == {"my_lora", "bad"}
    assert extract("", "girl, <lora:StylePack:0.8>, <lora:path/name.ckpt:1>") == {"stylepack", "name"}
    assert extract("not-json", "<lora:abc:1>") == {"abc"}
