"""A Publish Set export says what each file lost, and its byte copy cannot
damage the file it replaces."""

from __future__ import annotations

from pathlib import Path

from PIL import Image, PngImagePlugin

from services import publish_service as ps
from services.censor.output_io import METADATA_NOT_COPIED_WARNING


def _png(path: Path, prompt: str = "") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    info = PngImagePlugin.PngInfo()
    if prompt:
        info.add_text("parameters", prompt)
    Image.new("RGB", (16, 12), (90, 120, 200)).save(path, format="PNG", pnginfo=info)
    return path


def _add(conn, image_id: int, path: Path) -> None:
    conn.execute(
        "INSERT INTO images (id, path, filename, width, height, file_size, user_rating) VALUES (?, ?, ?, 16, 12, 100, 0)",
        (image_id, str(path), path.name),
    )


def test_a_file_whose_original_is_gone_says_its_metadata_was_not_copied(
    test_db, tmp_path
):
    original = _png(tmp_path / "library" / "pose.png", "1girl, solo")
    censored = _png(tmp_path / "library" / "pose_censored.png")
    conn = test_db.get_connection()
    try:
        _add(conn, 11, original)
        conn.commit()
    finally:
        conn.close()
    original.unlink()

    result = ps.export_set(
        items=[{"image_id": 11, "use_censored": True, "censored_path": str(censored)}],
        output_folder=str(tmp_path / "out"),
        metadata_option="minimal",
    )

    assert result["errors"] == []
    assert result["exported"][0]["warnings"] == [METADATA_NOT_COPIED_WARNING]


def test_a_byte_copy_cut_short_leaves_the_file_it_would_replace(
    test_db, tmp_path, monkeypatch
):
    import image_manager

    original = tmp_path / "library" / "keep.png"
    original.parent.mkdir(parents=True)
    original.write_bytes(b"the original picture bytes")
    conn = test_db.get_connection()
    try:
        _add(conn, 12, original)
        conn.commit()
    finally:
        conn.close()
    out = tmp_path / "out"
    out.mkdir()
    (out / "01.png").write_bytes(b"the earlier export")

    def disk_full(src, dst, *args, **kwargs):
        Path(dst).write_bytes(Path(src).read_bytes()[:5])
        raise OSError(28, "No space left on device")

    monkeypatch.setattr(image_manager.shutil, "copy2", disk_full)
    monkeypatch.setattr(ps.shutil, "copy2", disk_full)
    result = ps.export_set(
        items=[{"image_id": 12}],
        output_folder=str(out),
        metadata_option="keep",
        overwrite=True,
    )

    assert len(result["errors"]) == 1
    assert (out / "01.png").read_bytes() == b"the earlier export"
    assert sorted(p.name for p in out.iterdir()) == ["01.png"]
