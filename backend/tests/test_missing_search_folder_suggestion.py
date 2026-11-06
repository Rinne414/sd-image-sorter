"""A moved library: the summary says where to look, and the listing says what it skipped.

Real case (2026-11): rows pointed at ``output\\testing`` while the files now live in
other subfolders of ``output``. Searching ``output`` recovered 14,341 of 14,392
images. The summary now computes that folder from the data, so Find Moved Files
opens with it filled in instead of an empty box.

The gallery listing marks the rows it cannot find while it runs, so a summary read
at the same moment can still say 0. The listing therefore reports how many rows it
skipped, and the page asks for the summary again once it knows.
"""

from __future__ import annotations

from pathlib import Path

import database as db
from services.image import missing as missing_module
from services.image_service import ImageService


def _svc() -> ImageService:
    return ImageService()


def _missing_row(path: Path) -> int:
    image_id = db.add_image(path=str(path), filename=path.name)
    db.mark_image_unreadable(image_id, "file not found")
    return image_id


def _fake_home(monkeypatch, home: Path) -> None:
    monkeypatch.setattr(missing_module, "_home_dir", lambda: home)


class TestWhereToLook:
    def test_a_removed_folder_points_at_the_nearest_folder_that_still_exists(
        self, test_db, tmp_path, monkeypatch
    ):
        _fake_home(monkeypatch, tmp_path / "somewhere-else")
        output = tmp_path / "output"
        (output / "renamed-batch").mkdir(parents=True)
        (output / "renamed-batch" / "x.png").write_bytes(b"x")
        for n in range(3):
            _missing_row(output / "testing" / f"{n}.png")

        summary = _svc().summarize_missing_images()

        assert summary["suggested_search_folder"] == str(output)

    def test_a_folder_that_exists_but_lost_its_files_points_at_its_parent(
        self, test_db, tmp_path, monkeypatch
    ):
        _fake_home(monkeypatch, tmp_path / "somewhere-else")
        output = tmp_path / "output"
        (output / "testing").mkdir(parents=True)
        (output / "testing" / "other.png").write_bytes(b"still here")
        _missing_row(output / "testing" / "gone.png")

        assert _svc().summarize_missing_images()["suggested_search_folder"] == str(
            output
        )

    def test_the_largest_group_decides(self, test_db, tmp_path, monkeypatch):
        _fake_home(monkeypatch, tmp_path / "somewhere-else")
        big = tmp_path / "big-parent"
        small = tmp_path / "small-parent"
        big.mkdir()
        small.mkdir()
        (big / "keep.txt").write_bytes(b"x")
        (small / "keep.txt").write_bytes(b"x")
        for n in range(3):
            _missing_row(big / "gone-a" / f"{n}.png")
        _missing_row(small / "gone-b" / "0.png")

        assert _svc().summarize_missing_images()["suggested_search_folder"] == str(big)

    def test_nothing_missing_suggests_nothing(self, test_db):
        assert _svc().summarize_missing_images()["suggested_search_folder"] == ""

    def test_a_drive_root_is_never_suggested(self, test_db, tmp_path, monkeypatch):
        _fake_home(monkeypatch, tmp_path / "somewhere-else")
        root = Path(tmp_path.anchor)
        # Two levels under the root that do not exist: the nearest parent is the root.
        gone = root / "sd-sorter-test-no-such-folder" / "inner"
        assert not gone.parent.exists()
        _missing_row(gone / "a.png")

        assert _svc().summarize_missing_images()["suggested_search_folder"] == ""

    def test_the_users_home_is_never_suggested(self, test_db, tmp_path, monkeypatch):
        home = tmp_path / "home"
        (home / "keep").mkdir(parents=True)
        _fake_home(monkeypatch, home)
        _missing_row(home / "gone-folder" / "a.png")

        assert _svc().summarize_missing_images()["suggested_search_folder"] == ""

    def test_a_folder_above_home_is_never_suggested(
        self, test_db, tmp_path, monkeypatch
    ):
        home = tmp_path / "users" / "me"
        home.mkdir(parents=True)
        _fake_home(monkeypatch, home)
        _missing_row(tmp_path / "users" / "gone-one" / "a.png")

        assert _svc().summarize_missing_images()["suggested_search_folder"] == ""

    def test_a_folder_under_home_is_fine(self, test_db, tmp_path, monkeypatch):
        home = tmp_path / "home"
        pictures = home / "Pictures"
        pictures.mkdir(parents=True)
        (pictures / "keep.png").write_bytes(b"x")
        _fake_home(monkeypatch, home)
        _missing_row(pictures / "old-name" / "a.png")

        assert _svc().summarize_missing_images()["suggested_search_folder"] == str(
            pictures
        )

    def test_an_unreachable_largest_group_suggests_nothing(
        self, test_db, tmp_path, monkeypatch
    ):
        """An unplugged drive: nothing sensible to search, and no guessing."""
        _fake_home(monkeypatch, tmp_path / "somewhere-else")
        _missing_row(tmp_path / "gone-parent" / "gone" / "a.png")
        monkeypatch.setattr(
            missing_module,
            "classify_missing_location",
            lambda raw: (
                missing_module.REASON_LOCATION_UNREACHABLE,
                str(Path(raw).parent),
            ),
        )

        assert _svc().summarize_missing_images()["suggested_search_folder"] == ""


class TestWhatTheListingSkipped:
    def test_the_listing_reports_the_rows_it_could_not_find(self, test_db, tmp_path):
        live = tmp_path / "here.png"
        live.write_bytes(b"png")
        db.add_image(path=str(live), filename=live.name, metadata_json="{}")
        for n in range(3):
            db.add_image(
                path=str(tmp_path / "renamed-away" / f"{n}.png"),
                filename=f"{n}.png",
                metadata_json="{}",
            )

        page = _svc().get_images(limit=50)

        assert [Path(row["path"]).name for row in page["images"]] == ["here.png"]
        assert page["missing_skipped"] == 3

    def test_a_listing_that_skipped_nothing_says_zero(self, test_db, tmp_path):
        live = tmp_path / "here.png"
        live.write_bytes(b"png")
        db.add_image(path=str(live), filename=live.name, metadata_json="{}")

        assert _svc().get_images(limit=50)["missing_skipped"] == 0

    def test_the_offset_listing_reports_it_too(self, test_db, tmp_path):
        for n in range(2):
            db.add_image(
                path=str(tmp_path / "renamed-away" / f"{n}.png"),
                filename=f"{n}.png",
                metadata_json="{}",
            )

        page = _svc().get_images(limit=50, sort_by="name_asc")

        assert page["images"] == []
        assert page["missing_skipped"] == 2
