"""Current product docs and chrome must not advertise a retired or fake state.

These pins exist because stale comments (glassmorphism, experimental Style Finder,
keep-db_repos) were treated as the live product and misled both users and agents.
"""

from __future__ import annotations

from pathlib import Path

import artist_identifier as ai
from routers.artists import IdentifyResponse
from tagger_models import TAGGER_MODELS


ROOT = Path(__file__).resolve().parents[2]


def _read(*parts: str) -> str:
    return ROOT.joinpath(*parts).read_text(encoding="utf-8")


def test_current_product_docs_do_not_claim_glassmorphism():
    assert "glassmorphism" not in _read("README.md").lower()
    architecture = _read("docs", "architecture.md")
    assert "not glassmorphism" in architecture.lower()
    assert "Experimental artist identification" not in architecture


def test_identify_api_does_not_mark_style_finder_experimental():
    assert "experimental" not in IdentifyResponse.model_fields
    assert not (ROOT / "backend" / "artist" / "default_artists.py").exists()
    assert "DEFAULT_ARTISTS" not in (ROOT / "backend" / "artist_identifier.py").read_text(
        encoding="utf-8"
    )


def test_debt_notes_do_not_tell_agents_to_keep_deleted_db_repos():
    notes = _read("docs", "TECHNICAL_DEBT_NOTES.md")
    assert "deletion of `backend/db_repos/` was rejected" not in notes
    assert "Keep `backend/db_repos/`" not in notes
    assert not (ROOT / "backend" / "db_repos").exists()


def test_marketing_tagger_count_matches_the_catalog():
    tagger_count = sum(
        1 for cfg in TAGGER_MODELS.values() if not cfg.get("captioner_only")
    )
    readme = _read("README.md")
    why = _read("docs", "WHY_CHOOSE_US.md")
    assert "7 models" not in readme
    assert "7 个模型" not in readme
    assert "7 models" not in why
    for stale in (tagger_count - 1, tagger_count + 1):
        assert f"{stale} local tagger" not in readme
        assert f"{stale} 个本地打标" not in readme
        assert f"{stale} local tagger" not in why
    assert f"{tagger_count} local tagger" in why
    assert f"{tagger_count} 个本地打标" in readme
    assert f"{tagger_count} local tagger" in readme
    assert "OppaiOracle" in readme
    assert "CL Tagger v2" in readme
    assert "OppaiOracle" in why
    assert "CL Tagger v2" in why
    assert "ToriiGate captioner" in why
    assert "ToriiGate 描述器" in readme


def test_artist_load_failure_does_not_lock_a_placeholder_model():
    ident = ai.ArtistIdentifier()
    ident._mark_load_failed("no weights")
    assert ident._model is None


def test_marketing_copy_matches_shipped_template_and_vlm_facts():
    readme = _read("README.md")
    why = _read("docs", "WHY_CHOOSE_US.md")
    architecture = _read("docs", "architecture.md")

    assert "实验性画师" not in readme
    assert "14 个模板变量" not in readme
    assert "14 variables" not in readme
    assert "14 variables" not in why
    assert "17 个模板变量" in readme
    assert "17 variables" in readme
    assert "17 variables" in why
    assert "5 providers" not in readme
    assert "5 providers" not in why
    assert "Portable single-file" not in readme
    assert "Portable single-file" not in why
    assert "单文件便携" not in readme
    assert "| **Prompt Lab** |" not in readme
    assert "| **Prompt Lab** |" not in why
    assert "Models are loaded lazily on first use:" not in architecture
    assert "~65 MB" not in _read("backend", "config.py")
    assert "~65 MB" not in _read("backend", "similarity.py")
    assert "~65 MB" not in _read("docs", "API.md")
    assert "100% local, zero cloud upload" not in why
    assert "docs/screenshots/gallery_hero.png" not in readme
    assert "facebookresearch/sam2" not in readme
    assert "heathcliff01" not in readme.lower()

    assert "connection pooling" not in architecture.lower()
    assert "tags (id, image_id, tag, confidence, source, category)" in architecture

    security = _read("backend", "app_security.py")
    assert 'allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]' in security


def test_first_use_download_docs_and_artist_loader_stay_true():
    architecture = _read("docs", "architecture.md")
    assert "progress overlay" in architecture.lower()
    assert "1 GB" in architecture

    identifier = _read("backend", "artist_identifier.py")
    assert "or identifier._model == \"placeholder\"" not in identifier
    assert "self._model == \"placeholder\"" in identifier
