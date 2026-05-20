"""
Contract tests that keep touched routers behind service boundaries.
"""

from __future__ import annotations

from pathlib import Path


def test_images_router_does_not_import_database_or_metadata_parser_directly():
    """The images router should delegate parse/open-folder business logic to ImageService."""
    source = Path(__file__).resolve().parents[1] / "routers" / "images.py"
    text = source.read_text(encoding="utf-8")

    assert "import database as db" not in text
    assert "from metadata_parser import" not in text


def test_prompts_router_does_not_import_database_directly():
    """The prompts router should route DB-backed Prompt Lab logic through PromptService."""
    source = Path(__file__).resolve().parents[1] / "routers" / "prompts.py"
    text = source.read_text(encoding="utf-8")

    assert "import database as db" not in text


def test_artists_router_does_not_import_database_directly():
    """The artists router should route DB-backed artist logic through ArtistService."""
    source = Path(__file__).resolve().parents[1] / "routers" / "artists.py"
    text = source.read_text(encoding="utf-8")

    assert "import database as db" not in text


def test_aesthetic_router_does_not_import_database_directly():
    """The aesthetic router should route DB-backed scoring logic through AestheticService."""
    source = Path(__file__).resolve().parents[1] / "routers" / "aesthetic.py"
    text = source.read_text(encoding="utf-8")

    assert "import database as db" not in text


def test_tags_router_does_not_own_tagger_model_metadata_table():
    """The tags router should delegate tagger model catalog metadata to TaggingService."""
    source = Path(__file__).resolve().parents[1] / "routers" / "tags.py"
    text = source.read_text(encoding="utf-8")

    assert "import database" not in text
    assert "from database" not in text
    assert "TAGGER_MODEL_HINTS =" not in text
    assert "from config import DEFAULT_TAGGER_MODEL, TAGGER_MODELS" not in text


def test_tags_router_does_not_define_local_progress_proxy_logic():
    """The tags router should keep progress state ownership in TaggingService."""
    source = Path(__file__).resolve().parents[1] / "routers" / "tags.py"
    text = source.read_text(encoding="utf-8")

    assert "class _TagProgressProxy" not in text


def test_sorting_router_does_not_inline_hardware_recommendation_logic():
    """The sorting router should delegate system-info recommendation assembly to SortingService."""
    source = Path(__file__).resolve().parents[1] / "routers" / "sorting.py"
    text = source.read_text(encoding="utf-8")

    assert "recommend_tagger_config" not in text
    assert "from hardware_monitor import" not in text


def test_sorting_router_does_not_define_local_session_or_scan_proxy_logic():
    """The sorting router should keep scan/session state ownership in SortingService."""
    source = Path(__file__).resolve().parents[1] / "routers" / "sorting.py"
    text = source.read_text(encoding="utf-8")

    assert "class _ScanProgressProxy" not in text
    assert "class _SortSessionProxy" not in text

def test_models_router_stays_thin_and_delegates_runtime_downloads():
    """The models router should not regain model preparation or archive-download logic."""
    source = Path(__file__).resolve().parents[1] / "routers" / "models.py"
    text = source.read_text(encoding="utf-8")

    forbidden_fragments = [
        "import tagger",
        "import similarity",
        "import artist_identifier",
        "import censor",
        "import urllib",
        "import zipfile",
        "urlopen",
        "extractall",
        "_get_model_paths",
    ]
    for fragment in forbidden_fragments:
        assert fragment not in text
