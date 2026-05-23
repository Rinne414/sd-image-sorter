"""Regression test for v3.2.2 T2 real-click finding:
``oppai-oracle`` (the family-level id used by Model Manager UI and
Smart Tag wizard) must resolve to ``oppai-oracle-v1.1`` (the actual
TAGGER_MODELS registry key).

Without this resolver, ``POST /api/smart-tag/start`` failed with
``Unknown OppaiOracle model: oppai-oracle. Available: ['oppai-oracle-v1.1']``
because the wizard passes the unversioned id but the OppaiOracle
tagger expects the versioned key.
"""
from __future__ import annotations

import importlib

import pytest


def _import_module():
    """Import the tagger module fresh so the module-level constants
    are visible. We don't reload between tests; both tests just read
    from the same module instance."""
    return importlib.import_module("oppai_oracle_tagger")


@pytest.fixture
def oppai_module():
    return _import_module()


def test_normalize_alias_translates_family_id(oppai_module):
    """``oppai-oracle`` -> ``oppai-oracle-v1.1``."""
    assert oppai_module._normalize_oppai_model_alias("oppai-oracle") == "oppai-oracle-v1.1"


def test_normalize_alias_keeps_versioned_id(oppai_module):
    """The versioned id is already a registry key — keep as-is."""
    assert oppai_module._normalize_oppai_model_alias("oppai-oracle-v1.1") == "oppai-oracle-v1.1"


def test_normalize_alias_default_when_empty(oppai_module):
    """Empty / None / whitespace-only fall through to DEFAULT_MODEL."""
    assert oppai_module._normalize_oppai_model_alias("") == oppai_module.DEFAULT_MODEL
    assert oppai_module._normalize_oppai_model_alias(None) == oppai_module.DEFAULT_MODEL
    assert oppai_module._normalize_oppai_model_alias("   ") == oppai_module.DEFAULT_MODEL


def test_normalize_alias_case_insensitive(oppai_module):
    """Family id is matched case-insensitively (Smart Tag wizard
    sends lowercase, but defensive callers may not)."""
    assert oppai_module._normalize_oppai_model_alias("OPPAI-ORACLE") == "oppai-oracle-v1.1"
    assert oppai_module._normalize_oppai_model_alias("Oppai-Oracle") == "oppai-oracle-v1.1"


def test_normalize_alias_unknown_id_passes_through(oppai_module):
    """Unknown ids fall through unchanged so ``_model_config`` can
    still raise the explicit "Unknown OppaiOracle model" error."""
    assert oppai_module._normalize_oppai_model_alias("oppai-oracle-v9.9") == "oppai-oracle-v9.9"
    assert oppai_module._normalize_oppai_model_alias("not-an-oppai-model") == "not-an-oppai-model"


def test_oppai_tagger_init_resolves_family_alias(oppai_module):
    """The tagger constructor itself accepts ``oppai-oracle`` and
    stores the canonical key — covering the smart-tag-service code path
    (where the ``oppai-oracle`` family id was rejected before the fix).
    """
    tagger = oppai_module.OppaiOracleTagger(
        model_name="oppai-oracle", use_gpu=False
    )
    assert tagger.model_name == "oppai-oracle-v1.1"


def test_get_oppai_oracle_tagger_accepts_family_alias(oppai_module):
    """Smart Tag wizard's exact dispatch path: ``get_oppai_oracle_tagger
    (model_name="oppai-oracle", ...)`` must succeed without throwing
    ``Unknown OppaiOracle model``."""
    tagger = oppai_module.get_oppai_oracle_tagger(
        model_name="oppai-oracle",
        use_gpu=False,
        force_reload=True,
    )
    assert tagger.model_name == "oppai-oracle-v1.1"
