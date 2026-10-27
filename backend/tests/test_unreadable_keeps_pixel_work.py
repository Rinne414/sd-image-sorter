"""A picture we cannot read right now keeps what was worked out from it.

39b636ae stopped an unreadable mark from deleting tags, but it still dropped
the pixel work: AI and natural-language captions, aesthetic scores, the AI
rating, the CLIP embedding, ``tagged_at`` and the content fingerprint. Listing
the gallery with a drive unplugged was enough, and a caption from a cloud
model the user pays for costs money to make again. Nothing about the picture
changed; we just could not look. The next scan that can read the file compares
digests and drops the machine's work only when the pixels really differ.
"""

from __future__ import annotations

import database as db
from services.image_service import ImageService

PATH = r"Q:\unplugged-drive\portrait.png"

WORK_COLUMNS = (
    "content_fingerprint",
    "embedding",
    "tagged_at",
    "ai_caption",
    "nl_caption",
    "aesthetic_score",
    "ai_rating",
)


def _add_worked_picture(path: str = PATH) -> int:
    image_id = db.add_image(
        path=path,
        filename="portrait.png",
        source_mtime_ns=100,
        source_size=200,
        content_fingerprint="fp-good",
    )
    db.add_tags(
        image_id,
        [
            {"tag": "1girl", "confidence": 0.98, "source": "tagger"},
            {"tag": "my_oc_name", "confidence": 1.0, "source": "manual"},
        ],
        content_fingerprint="fp-good",
    )
    with db.get_db() as conn:
        conn.execute(
            """
            UPDATE images
            SET embedding = X'0102',
                tagged_at = CURRENT_TIMESTAMP,
                ai_caption = 'a girl with silver hair',
                nl_caption = 'A girl with silver hair stands by a window.',
                aesthetic_score = 6.5,
                ai_rating = 'general'
            WHERE id = ?
            """,
            (image_id,),
        )
    return image_id


def _row(image_id: int) -> dict:
    with db.get_db() as conn:
        row = conn.execute(
            f"""
            SELECT is_readable, source_mtime_ns, source_size, {", ".join(WORK_COLUMNS)}
            FROM images WHERE id = ?
            """,
            (image_id,),
        ).fetchone()
    return dict(row)


def _tags(image_id: int) -> list[str]:
    return sorted(tag["tag"] for tag in db.get_image_tags(image_id))


def _assert_work_kept(image_id: int) -> None:
    row = _row(image_id)
    assert row["content_fingerprint"] == "fp-good"
    assert row["embedding"] == b"\x01\x02"
    assert row["tagged_at"] is not None
    assert row["ai_caption"] == "a girl with silver hair"
    assert row["nl_caption"] == "A girl with silver hair stands by a window."
    assert row["aesthetic_score"] == 6.5
    assert row["ai_rating"] == "general"
    assert _tags(image_id) == ["1girl", "my_oc_name"]


class TestAMissingPictureKeepsItsWork:
    def test_mark_image_unreadable_keeps_the_pixel_work(self, test_db):
        image_id = _add_worked_picture()

        db.mark_image_unreadable(image_id, "File not found")

        assert _row(image_id)["is_readable"] == 0
        _assert_work_kept(image_id)

    def test_listing_the_gallery_with_the_drive_unplugged_keeps_the_pixel_work(
        self, test_db
    ):
        image_id = _add_worked_picture()

        live, missing = ImageService()._filter_and_mark_missing_images(
            [{"id": image_id, "path": PATH}]
        )

        assert (live, missing) == ([], 1)
        assert _row(image_id)["is_readable"] == 0
        _assert_work_kept(image_id)

    def test_marking_by_path_keeps_the_pixel_work(self, test_db):
        image_id = _add_worked_picture()

        db.mark_image_unreadable_by_path(PATH, "File not found on disk")

        assert _row(image_id)["is_readable"] == 0
        _assert_work_kept(image_id)


class TestAScanThatCannotReadTheFile:
    def test_keeps_the_work_and_the_last_readable_size(self, test_db):
        """The unreadable file's mtime/size must not sit next to the old digest.

        Otherwise a later scan would call the file unchanged and trust a digest
        of pixels it never compared.
        """
        image_id = _add_worked_picture()

        db.add_image(
            path=PATH,
            filename="portrait.png",
            is_readable=False,
            read_error="Truncated File Read",
            source_mtime_ns=999,
            source_size=17,
        )

        row = _row(image_id)
        assert row["is_readable"] == 0
        assert (row["source_mtime_ns"], row["source_size"]) == (100, 200)
        _assert_work_kept(image_id)

    def test_the_same_picture_back_keeps_everything(self, test_db):
        image_id = _add_worked_picture()
        db.mark_image_unreadable(image_id, "File not found")

        db.add_image(
            path=PATH,
            filename="portrait.png",
            source_mtime_ns=100,
            source_size=200,
            content_fingerprint="fp-good",
        )

        assert _row(image_id)["is_readable"] == 1
        _assert_work_kept(image_id)

    def test_a_different_picture_back_drops_the_machine_work_but_not_hand_tags(
        self, test_db
    ):
        image_id = _add_worked_picture()
        db.add_image(
            path=PATH,
            filename="portrait.png",
            is_readable=False,
            read_error="Truncated File Read",
            source_mtime_ns=999,
            source_size=17,
        )

        db.add_image(
            path=PATH,
            filename="portrait.png",
            source_mtime_ns=300,
            source_size=400,
            content_fingerprint="fp-other",
        )

        row = _row(image_id)
        assert row["is_readable"] == 1
        assert row["ai_caption"] is None
        assert row["nl_caption"] is None
        assert row["aesthetic_score"] is None
        assert row["embedding"] is None
        assert _tags(image_id) == ["my_oc_name"]


class TestAMetadataRewriteThatCannotReadTheFile:
    def test_keeps_the_work_and_the_last_readable_size(self, test_db):
        image_id = _add_worked_picture()

        db.update_image_metadata(
            image_id=image_id,
            generator="unknown",
            prompt=None,
            negative_prompt=None,
            metadata_json="{}",
            width=None,
            height=None,
            file_size=17,
            checkpoint=None,
            loras=[],
            is_readable=False,
            read_error="parse failed",
            source_mtime_ns=999,
            source_size=17,
            metadata_status="error",
            content_fingerprint=None,
            preserve_derived_state=True,
        )

        row = _row(image_id)
        assert row["is_readable"] == 0
        assert (row["source_mtime_ns"], row["source_size"]) == (100, 200)
        _assert_work_kept(image_id)
