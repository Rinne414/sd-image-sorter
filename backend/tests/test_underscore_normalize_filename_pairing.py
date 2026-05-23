"""Issue #5 Point 1 regression tests: enabling ``normalize_tag_underscores``
must NOT convert underscores in OUTPUT FILENAMES to spaces.

The user's exact complaint: "if enable the _ to space when export, it
will also chanhe those files name making the .txt name not matching
the images name". For LoRA training that pairs ``image.png`` with
``image.txt`` by exact basename match, this is fatal — a file named
``my_character_001.png`` next to a caption named ``my character 001.txt``
breaks pairing silently and the trainer skips both.

This test set covers BOTH export endpoints:

- ``POST /api/tags/export-batch`` — the legacy export-batch flow used
  by the export modal in the gallery.
- ``POST /api/dataset/export`` — the v3.2.2 Dataset Maker flow that
  writes images and captions in one step.

We also assert the positive sanity case: caption *content* DOES get
its underscores converted (because that's the whole point of the
flag — danbooru ``long_hair`` → English ``long hair`` for the model
text encoder), even when the surrounding *filename* is preserved.
"""
from __future__ import annotations

import os
from pathlib import Path

import pytest
from PIL import Image


SOURCE_FILENAMES_WITH_UNDERSCORES = [
    "my_character_001.png",
    "long_hair_blue_eyes_2girls.png",
    "no_underscores.png",
    "multiple_words_in_filename.png",
    "score_5_high_quality.png",  # tricky: score_ prefix is preserved by tag pipeline
]


@pytest.fixture
def staged_images_with_underscores(test_db, tmp_path: Path):
    """Build 5 images on disk whose filenames contain underscores,
    add to the DB, attach a few tags that will exercise the underscore
    pipeline."""
    import database as db

    src = tmp_path / "src"
    src.mkdir()
    info = []
    for name in SOURCE_FILENAMES_WITH_UNDERSCORES:
        path = src / name
        Image.new("RGB", (32, 32), color=(80, 120, 160)).save(path)
        image_id = db.add_image(path=str(path), filename=name)
        # Tags include underscored tags (long_hair, school_uniform) and a
        # score_* tag that should be preserved verbatim by the pipeline.
        db.add_tags(image_id, [
            {"tag": "1girl", "confidence": 0.9},
            {"tag": "long_hair", "confidence": 0.85},
            {"tag": "school_uniform", "confidence": 0.82},
            {"tag": "looking_at_viewer", "confidence": 0.80},
            {"tag": "score_9", "confidence": 0.95},
        ])
        info.append((image_id, name, path))
    return info


# ============== /api/tags/export-batch ==============

def test_export_batch_normalize_underscores_keeps_filename_underscores(
    test_client, staged_images_with_underscores, tmp_path: Path
):
    """When ``normalize_tag_underscores=True`` is set on
    ``/api/tags/export-batch``, the produced ``.txt`` sidecar
    filenames MUST preserve underscores so they pair with the
    underscore-bearing image filenames on disk.

    Concrete failure mode (before the fix): a source file named
    ``my_character_001.png`` produces ``my character 001.txt``,
    breaking LoRA training.
    """
    out = tmp_path / "out"
    out.mkdir()
    image_ids = [i[0] for i in staged_images_with_underscores]

    response = test_client.post("/api/tags/export-batch", json={
        "image_ids": image_ids,
        "output_folder": str(out),
        "output_mode": "folder",
        "content_mode": "tags",
        "overwrite_policy": "overwrite",
        "normalize_tag_underscores": True,
    })
    assert response.status_code == 200, response.text

    # Every input filename's stem must have a corresponding .txt
    # with underscores still intact (no spaces inserted).
    mismatches = []
    for _, original_name, _ in staged_images_with_underscores:
        stem = os.path.splitext(original_name)[0]
        expected_txt = out / f"{stem}.txt"
        if not expected_txt.exists():
            actual = sorted(p.name for p in out.iterdir() if p.suffix == ".txt")
            mismatches.append({
                "source": original_name,
                "expected_txt": expected_txt.name,
                "actual_txt_files": actual,
            })

    assert not mismatches, (
        "sidecar filenames had their underscores converted to spaces "
        "(or otherwise didn't pair):\n"
        + "\n".join(
            f"  source='{m['source']}' expected='{m['expected_txt']}' "
            f"actual_txt_files={m['actual_txt_files']}"
            for m in mismatches
        )
    )

    # Negative check: there should be NO file with spaces in the stem
    # corresponding to any of our underscore-bearing source filenames.
    for _, original_name, _ in staged_images_with_underscores:
        stem = os.path.splitext(original_name)[0]
        # Only check stems that contain underscores; "score_5_high_quality"
        # in particular MUST NOT become "score 5 high quality.txt".
        if "_" not in stem:
            continue
        spaced_variant = stem.replace("_", " ")
        bad_path = out / f"{spaced_variant}.txt"
        assert not bad_path.exists(), (
            f"sidecar filename was mangled: '{stem}' became '{spaced_variant}'. "
            f"That breaks pairing with the on-disk image '{original_name}'."
        )


def test_export_batch_normalize_underscores_does_convert_caption_content(
    test_client, staged_images_with_underscores, tmp_path: Path
):
    """Sanity (positive case): when ``normalize_tag_underscores=True``
    is set, the caption CONTENT does still get underscores converted
    — that's the whole point of the flag. ``score_*`` tags are
    preserved verbatim because LoRA recipes (Pony / NoobAI) rely on
    the literal ``score_9`` token.

    This test exists so a future "fix" to the filename bug doesn't
    accidentally disable the caption normalization too.
    """
    out = tmp_path / "out"
    out.mkdir()
    # Pick the one image whose filename does not contain underscores
    # so the test is laser-focused on caption content.
    target = next(
        i for i in staged_images_with_underscores
        if i[1] == "no_underscores.png"
    )
    image_id, original_name, _ = target

    response = test_client.post("/api/tags/export-batch", json={
        "image_ids": [image_id],
        "output_folder": str(out),
        "output_mode": "folder",
        "content_mode": "tags",
        "overwrite_policy": "overwrite",
        "normalize_tag_underscores": True,
    })
    assert response.status_code == 200, response.text

    txt = out / f"{os.path.splitext(original_name)[0]}.txt"
    assert txt.exists(), f"missing caption: {txt}"
    content = txt.read_text(encoding="utf-8")

    # Underscored tags should be converted in the content
    assert "long hair" in content, content
    assert "school uniform" in content, content
    assert "looking at viewer" in content, content
    # Underscored variants should NOT appear in the caption
    assert "long_hair" not in content, content
    assert "school_uniform" not in content, content
    # ``score_*`` MUST stay literal (Pony / NoobAI recipe lock)
    assert "score_9" in content, content
    assert "score 9" not in content, content


# ============== /api/dataset/export ==============

def test_dataset_export_normalize_underscores_keeps_filename_underscores(
    test_client, staged_images_with_underscores, tmp_path: Path
):
    """Same regression on the v3.2.2 ``/api/dataset/export`` endpoint
    with the ``{filename}`` (default) naming pattern — output
    filenames MUST keep their underscores.
    """
    out = tmp_path / "out"
    out.mkdir()
    image_ids = [i[0] for i in staged_images_with_underscores]

    response = test_client.post("/api/dataset/export", json={
        "image_ids": image_ids,
        "output_folder": str(out),
        "naming_pattern": "{filename}",
        "trigger": "",
        "image_op": "copy",
        "overwrite_policy": "unique",
        "normalize_tag_underscores": True,
    })
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "ok", body

    for _, original_name, _ in staged_images_with_underscores:
        stem = os.path.splitext(original_name)[0]
        ext = os.path.splitext(original_name)[1]
        # The image keeps its underscores in the rename
        assert (out / f"{stem}{ext}").exists(), (
            f"renamed image '{stem}{ext}' missing — underscores may have "
            f"been converted to spaces."
        )
        # The .txt sidecar matches the renamed image stem exactly
        assert (out / f"{stem}.txt").exists(), (
            f"caption '{stem}.txt' missing — pairing broken with image."
        )


def test_dataset_export_normalize_underscores_keeps_trigger_underscore_in_filename(
    test_client, staged_images_with_underscores, tmp_path: Path
):
    """``{trigger}_{index:03d}`` with ``trigger=my_oc`` and
    normalize=True must produce ``my_oc_001.png`` / ``my_oc_001.txt``
    — the trigger word's underscores are sacred (they form a unique
    BPE token the LoRA learns to map to the trained subject).
    """
    out = tmp_path / "out"
    out.mkdir()
    image_ids = [i[0] for i in staged_images_with_underscores]

    response = test_client.post("/api/dataset/export", json={
        "image_ids": image_ids,
        "output_folder": str(out),
        "naming_pattern": "{trigger}_{index:03d}",
        "trigger": "my_oc",
        "image_op": "copy",
        "overwrite_policy": "unique",
        "normalize_tag_underscores": True,
    })
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "ok", body

    # Pattern produces my_oc_001..my_oc_005 — no spaces anywhere.
    for idx in range(1, len(staged_images_with_underscores) + 1):
        stem = f"my_oc_{idx:03d}"
        # Source extensions vary; we copy the source ext through.
        candidates = list(out.glob(f"{stem}.*"))
        image_files = [p for p in candidates if p.suffix.lower() != ".txt"]
        assert image_files, (
            f"renamed image '{stem}.*' missing. "
            f"Output dir: {sorted(p.name for p in out.iterdir())}"
        )
        assert (out / f"{stem}.txt").exists(), (
            f"caption '{stem}.txt' missing — pairing broken."
        )

    # Negative: the spaced trigger variant must not have leaked into any
    # output filename.
    for bad_stem in ("my oc", "my oc_001", "my oc 001"):
        leaked = list(out.glob(f"{bad_stem}*"))
        assert not leaked, (
            f"trigger 'my_oc' was converted to '{bad_stem}' in output "
            f"filenames: {[p.name for p in leaked]}"
        )


def test_dataset_export_caption_still_normalizes_when_filename_does_not(
    test_client, staged_images_with_underscores, tmp_path: Path
):
    """End-to-end sanity: with normalize=True, the .png filename
    keeps underscores AND the .txt content has them converted —
    the two transforms are independent and both must hold.
    """
    out = tmp_path / "out"
    out.mkdir()
    target = next(
        i for i in staged_images_with_underscores
        if i[1] == "long_hair_blue_eyes_2girls.png"
    )
    image_id, original_name, _ = target

    response = test_client.post("/api/dataset/export", json={
        "image_ids": [image_id],
        "output_folder": str(out),
        "naming_pattern": "{filename}",
        "trigger": "",
        "image_op": "copy",
        "overwrite_policy": "unique",
        "normalize_tag_underscores": True,
    })
    assert response.status_code == 200, response.text

    # Filename: underscores intact
    stem = "long_hair_blue_eyes_2girls"
    assert (out / f"{stem}.png").exists()
    assert (out / f"{stem}.txt").exists()
    # Caption content: underscores converted
    content = (out / f"{stem}.txt").read_text(encoding="utf-8")
    assert "long hair" in content, content
    assert "long_hair" not in content, content
    assert "school uniform" in content, content
