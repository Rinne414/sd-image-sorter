"""Regression tests for /api/tags/export-batch sidecar filename pairing.

Bug report (user-reported): "if enable the _ to space when export, it
will also chanhe those files name making the .txt name not matching
the images name". The user was hitting the broader pattern: characters
that aren't ``[A-Za-z0-9_\\s.\\-]`` (apostrophes, parentheses, commas,
brackets) were being replaced with ``_`` by ``sanitize_filename`` when
the export pipeline computed the .txt sidecar name from the DB
``filename`` field.

Concrete failure (before the fix, all in folder mode with normalize=True):
  ``my (test).png``    -> ``my _test_.txt``       ❌ pairing broken
  ``apostrophe's.png`` -> ``apostrophe_s.txt``    ❌
  ``with, commas.png`` -> ``with_ commas.txt``    ❌

This breaks LoRA training tools that pair images with captions by
exact basename match. The trainer sees:
  - ``my (test).png``      (image, on disk)
  - ``my _test_.txt``      (caption, what the export wrote)
  -> trainer skips both because no caption pairs with the image.

Fix: derive the sidecar stem from the actual on-disk image path
(``os.path.basename(image["path"])`` -> stem) instead of running
``image["filename"]`` through ``sanitize_filename``. The image
file already exists on disk, so its filename is by definition
OS-legal; sanitization is overkill and breaks pairing.

The ``beside_image`` mode already did this via ``_sidecar_stem_override``;
this fix aligns the ``folder`` mode with the same behavior.
"""
from __future__ import annotations

import os
from pathlib import Path
import pytest
from PIL import Image


SPECIAL_CHAR_FILENAMES = [
    "simple.png",
    "with_underscore.png",
    "my (parentheses).png",
    "with-dash.png",
    "multi.dot.name.png",
    "spaces in name.png",
    "CamelCase.png",
    "mixed (test_001).png",
    "with.commas, sort.png",
    "apostrophe's.png",
    "CJK字符.png",
    "numbers123.png",
]


@pytest.fixture
def sandbox_with_special_filenames(tmp_path: Path) -> tuple[Path, list[str]]:
    """Build a folder with images that exercise the various special-character
    cases that ``sanitize_filename`` used to mangle."""
    folder = tmp_path / "images"
    folder.mkdir()
    for name in SPECIAL_CHAR_FILENAMES:
        try:
            Image.new("RGB", (32, 32), color=(50, 100, 150)).save(folder / name)
        except OSError:
            # Some characters may not be valid on the host filesystem
            # (CJK on a non-UTF locale, etc.); skip those silently.
            pass
    actual = [f.name for f in folder.iterdir()]
    return folder, actual


def test_folder_mode_sidecar_preserves_special_chars(test_client, test_db, sandbox_with_special_filenames, tmp_path):
    """folder-mode export should produce .txt files whose stem matches
    the ON-DISK image stem exactly, even when the filename contains
    apostrophes, parentheses, commas, etc."""
    folder, on_disk_names = sandbox_with_special_filenames

    # Scan the folder
    test_client.post("/api/scan/reset")
    response = test_client.post("/api/scan", json={"folder_path": str(folder), "recursive": False})
    assert response.status_code == 200, response.text

    # Wait for scan
    import time
    for _ in range(60):
        time.sleep(0.3)
        progress = test_client.get("/api/scan/progress").json()
        if progress.get("status") in ("done", "idle", "completed", "success"):
            break

    # Get the scanned images
    list_resp = test_client.get(f"/api/images?path_prefix={str(folder).replace(chr(92), '/')}&limit=30")
    assert list_resp.status_code == 200, list_resp.text
    images = [img for img in list_resp.json().get("images", []) if str(folder) in str(img.get("path", "")).replace("/", os.sep)]
    assert len(images) >= 5, f"Expected at least 5 images scanned, got {len(images)}"

    image_ids = [img["id"] for img in images]

    # Add a tag so export has content
    test_client.post("/api/tags/bulk/add", json={
        "image_ids": image_ids,
        "tags": ["1girl", "long_hair"],
        "confidence": 0.85,
        "dry_run": False,
    })

    # Export with normalize=True (the user's exact scenario)
    output_dir = tmp_path / "out"
    output_dir.mkdir()
    export_resp = test_client.post("/api/tags/export-batch", json={
        "image_ids": image_ids,
        "output_folder": str(output_dir),
        "output_mode": "folder",
        "content_mode": "tags",
        "overwrite_policy": "overwrite",
        "normalize_tag_underscores": True,
    })
    assert export_resp.status_code == 200, export_resp.text

    # For every scanned image, the .txt with the same stem must exist
    mismatches = []
    for img in images:
        on_disk_filename = os.path.basename(str(img.get("path") or img.get("filename") or ""))
        on_disk_stem = os.path.splitext(on_disk_filename)[0]
        expected_txt = output_dir / f"{on_disk_stem}.txt"
        if not expected_txt.exists():
            actual_files = [f.name for f in output_dir.iterdir() if f.suffix == ".txt"]
            mismatches.append({
                "image": on_disk_filename,
                "expected_txt": expected_txt.name,
                "all_actual_txt": actual_files,
            })

    assert not mismatches, (
        "sidecar filenames don't match image filenames:\n"
        + "\n".join(f"  image='{m['image']}' expected='{m['expected_txt']}'" for m in mismatches)
    )


def test_special_char_filenames_dont_become_underscores(test_client, test_db, tmp_path: Path):
    """Specifically: my (test).png -> my (test).txt (not my _test_.txt)."""
    folder = tmp_path / "imgs"
    folder.mkdir()
    img_path = folder / "my (lora char).png"
    Image.new("RGB", (32, 32), color=(50, 100, 150)).save(img_path)

    test_client.post("/api/scan/reset")
    test_client.post("/api/scan", json={"folder_path": str(folder), "recursive": False})

    import time
    for _ in range(30):
        time.sleep(0.2)
        if test_client.get("/api/scan/progress").json().get("status") in ("done", "idle", "completed"):
            break

    list_resp = test_client.get(f"/api/images?path_prefix={str(folder).replace(chr(92), '/')}&limit=5")
    images = [img for img in list_resp.json().get("images", []) if str(folder) in str(img.get("path", "")).replace("/", os.sep)]
    assert len(images) == 1, f"Expected 1 image, got {len(images)}"
    image_id = images[0]["id"]

    test_client.post("/api/tags/bulk/add", json={
        "image_ids": [image_id],
        "tags": ["1girl"],
        "confidence": 0.9,
        "dry_run": False,
    })

    output_dir = tmp_path / "out"
    output_dir.mkdir()
    test_client.post("/api/tags/export-batch", json={
        "image_ids": [image_id],
        "output_folder": str(output_dir),
        "output_mode": "folder",
        "content_mode": "tags",
        "overwrite_policy": "overwrite",
    })

    # The .txt MUST be ``my (lora char).txt``, NOT ``my _lora char_.txt``
    expected = output_dir / "my (lora char).txt"
    bad = output_dir / "my _lora char_.txt"
    assert expected.exists(), (
        f"Expected '{expected.name}' to exist for image 'my (lora char).png'. "
        f"Got: {[f.name for f in output_dir.iterdir()]}"
    )
    assert not bad.exists(), (
        f"sidecar filename was sanitized — got '{bad.name}' but should keep "
        f"the parentheses to pair with image 'my (lora char).png'."
    )


# ============== P1-6: unique-policy collision keeps image↔caption pairing ==============
#
# Under the default ``unique`` policy the sidecar stem is pinned to the image
# stem so pairing always holds. A name clash is therefore reported (folder
# mode) or skipped (beside_image, when a caption already sits next to the
# image) rather than renamed to ``{stem}_1.txt`` — a renamed caption pairs
# with no image and is a silently broken LoRA training sample.


def _stage_image(tmp_path: Path, subdir: str, filename: str, tag: str) -> tuple[int, Path]:
    """Create one on-disk image with a single tag; return its DB id + path."""
    import database as db

    folder = tmp_path / subdir
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / filename
    Image.new("RGB", (16, 16), color=(90, 120, 150)).save(path)
    image_id = db.add_image(path=str(path), filename=filename)
    db.add_tags(image_id, [{"tag": tag, "confidence": 0.9}])
    return image_id, path


def test_folder_unique_collision_first_wins_second_errors(test_client, test_db, tmp_path: Path):
    """(a) folder mode, two images sharing a stem, unique → the first exports,
    the second is a per-image error, and no ``{stem}_1.txt`` lands on disk."""
    id_a, _ = _stage_image(tmp_path, "a", "dup.png", "alpha_tag")
    id_b, _ = _stage_image(tmp_path, "b", "dup.jpg", "beta_tag")  # same stem 'dup'

    out = tmp_path / "out"
    out.mkdir()
    resp = test_client.post("/api/tags/export-batch", json={
        "image_ids": [id_a, id_b],
        "output_folder": str(out),
        "output_mode": "folder",
        "content_mode": "tags",
        "overwrite_policy": "unique",
    })
    assert resp.status_code == 200, resp.text
    data = resp.json()

    assert data["exported"] == 1
    assert data["error_count"] == 1
    assert data["skipped"] == 0
    assert data["status"] == "partial"

    # Winner is on disk; the collision produced no rename or dual-extension name.
    assert (out / "dup.txt").exists()
    assert not (out / "dup_1.txt").exists()
    assert not (out / "dup.jpg.txt").exists()
    assert not (out / "dup.png.txt").exists()
    assert [p.name for p in out.glob("*.txt")] == ["dup.txt"]

    # The error names the taken sidecar, its first owner, and the remedy.
    message = " ".join(data["error_messages"])
    assert "dup.txt" in message
    assert "dup.png" in message  # first owner's source path
    assert "already taken" in message
    assert "overwrite/skip" in message


def test_beside_image_unique_preexisting_sidecar_is_skipped(test_client, test_db, tmp_path: Path):
    """(b) beside_image mode, a caption already sits next to the image, unique →
    the image is skipped (not errored) and the existing sidecar is left
    untouched with no ``_1`` rename."""
    image_id, path = _stage_image(tmp_path, "lib", "hero.png", "fresh_tag")
    existing = path.with_suffix(".txt")
    existing.write_text("preexisting caption", encoding="utf-8")

    resp = test_client.post("/api/tags/export-batch", json={
        "image_ids": [image_id],
        "output_folder": "",  # ignored in beside_image mode
        "output_mode": "beside_image",
        "content_mode": "tags",
        "overwrite_policy": "unique",
    })
    assert resp.status_code == 200, resp.text
    data = resp.json()

    assert data["exported"] == 0
    assert data["skipped"] == 1
    assert data["error_count"] == 0
    assert data["status"] == "partial"

    # The pre-existing caption is untouched; no rename was created.
    assert existing.read_text(encoding="utf-8") == "preexisting caption"
    assert not path.with_name("hero_1.txt").exists()


def test_folder_unique_overwrite_still_overwrites(test_client, test_db, tmp_path: Path):
    """(c) overwrite policy still replaces a pre-existing sidecar in place, with
    no ``_1`` rename."""
    image_id, _ = _stage_image(tmp_path, "src", "pic.png", "fresh_tag")

    out = tmp_path / "out"
    out.mkdir()
    (out / "pic.txt").write_text("stale caption", encoding="utf-8")

    resp = test_client.post("/api/tags/export-batch", json={
        "image_ids": [image_id],
        "output_folder": str(out),
        "output_mode": "folder",
        "content_mode": "tags",
        "overwrite_policy": "overwrite",
        "normalize_tag_underscores": False,
    })
    assert resp.status_code == 200, resp.text
    data = resp.json()

    assert data["exported"] == 1
    assert data["error_count"] == 0
    content = (out / "pic.txt").read_text(encoding="utf-8")
    assert content == "fresh_tag"
    assert "stale" not in content
    assert not (out / "pic_1.txt").exists()
