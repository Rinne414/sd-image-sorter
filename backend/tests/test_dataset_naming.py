"""Unit tests for the dataset export naming engine."""
from __future__ import annotations

from pathlib import Path
import pytest

from services.dataset_naming import (
    NamingError,
    plan_renames,
    render_stem,
    resolve_collision,
)


# ============== render_stem ==============

def test_filename_keeps_original_stem():
    assert render_stem("{filename}", image_filename="my_subject_001.png", index=1) == "my_subject_001"


def test_filename_preserves_special_chars():
    """Same fix-class as the LoRA pairing bug: parens / apostrophes /
    commas in the original filename must survive."""
    assert render_stem("{filename}", image_filename="my (lora char).png", index=1) == "my (lora char)"
    assert render_stem("{filename}", image_filename="apostrophe's.png", index=1) == "apostrophe's"
    assert render_stem("{filename}", image_filename="with.commas, sort.png", index=1) == "with.commas, sort"


def test_index_pattern():
    assert render_stem("subject_{index}", image_filename="orig.png", index=7) == "subject_7"


def test_index_padded():
    assert render_stem("subject_{index:03d}", image_filename="orig.png", index=7) == "subject_007"
    assert render_stem("img_{index:05d}", image_filename="orig.png", index=42) == "img_00042"


def test_padding_clamped():
    """Padding >2 digits in the regex spec is rejected (kept literal),
    and accepted padding values are capped at 8 in the formatter."""
    # 3+ digit padding spec in the regex is rejected (regex only matches 1-2 digits).
    # The colon in the literal then gets sanitized to ``_`` because colons
    # are OS-illegal on Windows filenames -- but the user clearly sees the
    # invalid pattern survived as a literal.
    result = render_stem("{index:999d}", image_filename="orig.png", index=1)
    assert "999d}" in result  # literal survived (just sanitized colon)
    # 2-digit padding spec is accepted but capped at 8 by the formatter
    capped = render_stem("{index:88d}", image_filename="orig.png", index=1)
    assert capped == "00000001"  # 8 digits (the cap), not 88


def test_trigger_substituted():
    assert render_stem("{trigger}_{index:03d}", image_filename="x.png", index=3, trigger="my_subject") \
        == "my_subject_003"


def test_trigger_empty_kept_as_empty():
    assert render_stem("{trigger}_{index}", image_filename="x.png", index=2, trigger="") == "_2"


def test_generator_substituted():
    assert render_stem("{generator}_{filename}", image_filename="orig.png", index=1, generator="webui") \
        == "webui_orig"


def test_ext_substituted():
    """{ext} returns the original extension (without dot)."""
    assert render_stem("{filename}_{ext}", image_filename="cat.png", index=1) == "cat_png"
    assert render_stem("{filename}_{ext}", image_filename="cat.JPEG", index=1) == "cat_jpeg"


def test_date_substituted():
    """The ``{date}`` variable should produce a YYYY-MM-DD stamp."""
    import re
    result = render_stem("{date}_{filename}", image_filename="x.png", index=1)
    assert re.match(r"^\d{4}-\d{2}-\d{2}_x$", result), result


def test_unknown_variable_kept_literal():
    """An unknown variable like {foo} should be kept as the literal token
    so the user can spot and fix the typo, rather than silently dropped."""
    assert render_stem("{foo}_{filename}", image_filename="x.png", index=1) == "{foo}_x"


def test_static_pattern():
    """A pattern with no variables is a literal stem (every image gets
    the same name; collision policy will disambiguate)."""
    assert render_stem("training", image_filename="x.png", index=1) == "training"


def test_empty_pattern_uses_filename_default():
    assert render_stem("", image_filename="x.png", index=1) == "x"
    assert render_stem("   ", image_filename="x.png", index=1) == "x"


def test_pattern_pure_whitespace_after_substitution_raises():
    # Trigger is "" and pattern is just {trigger} -> empty string after sub
    with pytest.raises(NamingError):
        render_stem("{trigger}", image_filename="x.png", index=1, trigger="")


def test_path_separator_in_pattern_is_sanitized():
    """An attacker-typed pattern with ``/`` or ``\\`` must not escape the
    output folder. ``sanitize_filename`` strips path separators."""
    result = render_stem("../../etc/passwd_{filename}", image_filename="x.png", index=1)
    assert "/" not in result and "\\" not in result and ".." not in result


def test_trigger_with_path_separator_sanitized():
    """A trigger containing path separators (whether by accident or
    malice) must not let the stem escape the output folder."""
    result = render_stem("{trigger}_{filename}", image_filename="x.png", index=1, trigger="../../etc/passwd")
    assert "/" not in result and "\\" not in result and ".." not in result


# ============== resolve_collision ==============

def test_collision_unique_first_image_uses_bare_name(tmp_path: Path):
    used: set[str] = set()
    out = resolve_collision(tmp_path, "subject", ".png", used_paths=used, overwrite_policy="unique")
    assert out == tmp_path / "subject.png"


def test_collision_unique_second_image_gets_suffix(tmp_path: Path):
    used: set[str] = {str(tmp_path / "subject.png")}
    out = resolve_collision(tmp_path, "subject", ".png", used_paths=used, overwrite_policy="unique")
    assert out == tmp_path / "subject_1.png"


def test_collision_unique_with_existing_file_on_disk(tmp_path: Path):
    (tmp_path / "subject.png").write_bytes(b"x")
    used: set[str] = set()
    out = resolve_collision(tmp_path, "subject", ".png", used_paths=used, overwrite_policy="unique")
    assert out == tmp_path / "subject_1.png"


def test_collision_overwrite_first_image_uses_bare_name(tmp_path: Path):
    used: set[str] = set()
    out = resolve_collision(tmp_path, "subject", ".png", used_paths=used, overwrite_policy="overwrite")
    assert out == tmp_path / "subject.png"


def test_collision_overwrite_second_image_in_run_disambiguates(tmp_path: Path):
    """Even with overwrite, two images cannot legitimately claim the
    same target in one run. Disambiguate."""
    used: set[str] = {str(tmp_path / "subject.png")}
    out = resolve_collision(tmp_path, "subject", ".png", used_paths=used, overwrite_policy="overwrite")
    assert out == tmp_path / "subject_1.png"


def test_collision_skip_returns_none_when_existing_on_disk(tmp_path: Path):
    (tmp_path / "subject.png").write_bytes(b"x")
    used: set[str] = set()
    out = resolve_collision(tmp_path, "subject", ".png", used_paths=used, overwrite_policy="skip")
    assert out is None


# ============== plan_renames ==============

def test_plan_renames_renumbers_with_padded_index(tmp_path: Path):
    images = [
        {"id": 1, "filename": "img_a.png", "path": "/x/img_a.png"},
        {"id": 2, "filename": "img_b.png", "path": "/x/img_b.png"},
        {"id": 3, "filename": "img_c.png", "path": "/x/img_c.png"},
    ]
    plan = plan_renames(
        images, output_folder=tmp_path,
        pattern="train_{index:03d}", trigger="", overwrite_policy="unique",
    )
    assert [str(p[1].name) for p in plan] == ["train_001.png", "train_002.png", "train_003.png"]
    # Caption stems must match image stems exactly
    assert [str(p[2].name) for p in plan] == ["train_001.txt", "train_002.txt", "train_003.txt"]


def test_plan_renames_keeps_filename_with_special_chars(tmp_path: Path):
    """Default ``{filename}`` pattern must preserve user filenames including
    parentheses / apostrophes (LoRA pairing requirement)."""
    images = [
        {"id": 1, "filename": "my (lora char).png", "path": "/x/my (lora char).png"},
        {"id": 2, "filename": "apostrophe's.png", "path": "/x/apostrophe's.png"},
    ]
    plan = plan_renames(
        images, output_folder=tmp_path,
        pattern="{filename}", trigger="", overwrite_policy="unique",
    )
    # Image and caption stems both keep the special chars
    assert plan[0][1].name == "my (lora char).png"
    assert plan[0][2].name == "my (lora char).txt"
    assert plan[1][1].name == "apostrophe's.png"
    assert plan[1][2].name == "apostrophe's.txt"


def test_plan_renames_static_pattern_disambiguates(tmp_path: Path):
    """Pattern with no variables -> every image gets the same base stem;
    collision policy adds numeric suffix."""
    images = [
        {"id": 1, "filename": "a.png"},
        {"id": 2, "filename": "b.png"},
        {"id": 3, "filename": "c.png"},
    ]
    plan = plan_renames(
        images, output_folder=tmp_path,
        pattern="train", trigger="", overwrite_policy="unique",
    )
    assert [p[1].name for p in plan] == ["train.png", "train_1.png", "train_2.png"]


def test_plan_renames_skip_existing_on_disk(tmp_path: Path):
    """skip + already-existing destination = None entry, no overwrite."""
    (tmp_path / "subject_001.png").write_bytes(b"x")
    images = [
        {"id": 1, "filename": "a.png"},
        {"id": 2, "filename": "b.png"},
    ]
    plan = plan_renames(
        images, output_folder=tmp_path,
        pattern="subject_{index:03d}", trigger="", overwrite_policy="skip",
    )
    assert plan[0][1] is None and plan[0][3] == "existing"
    assert plan[1][1] is not None  # subject_002 is fine


def test_plan_renames_mixed_extensions(tmp_path: Path):
    """Different source extensions stay paired correctly."""
    images = [
        {"id": 1, "filename": "a.png"},
        {"id": 2, "filename": "b.jpeg"},
        {"id": 3, "filename": "c.webp"},
    ]
    plan = plan_renames(
        images, output_folder=tmp_path,
        pattern="train_{index:02d}", trigger="", overwrite_policy="unique",
    )
    assert plan[0][1].name == "train_01.png"
    assert plan[1][1].name == "train_02.jpeg"
    assert plan[2][1].name == "train_03.webp"
    # Captions all .txt regardless of image extension
    assert all(p[2].suffix == ".txt" for p in plan)
