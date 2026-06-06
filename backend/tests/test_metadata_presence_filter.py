"""Tests for the v3.3.2 "has SD generation parameters" gallery filter (small-opt).

An image "has metadata" when it carries SD generation parameters: a known
generator (not ``unknown``/blank) OR a non-empty positive prompt. The tri-state
``has_metadata`` filter (None = all, True = only with, False = only without)
composes with the rest of the gallery read path and round-trips through the
stateless selection-token contract.

This is the gallery *presence* filter — distinct from ``metadata_status`` (the
parse-pipeline state) and from the SD metadata *parser* tests.
"""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))


def _add(db, filename, *, generator, prompt=None):
    return db.add_image(
        path=f"/lib/{filename}",
        filename=filename,
        generator=generator,
        prompt=prompt,
        metadata_json="{}",
    )


@pytest.fixture
def seeded(test_db):
    """Two images carry metadata, two do not (an exact 2/2 partition)."""
    _add(test_db, "known_gen.png", generator="comfyui")                         # known generator -> has
    _add(test_db, "unknown_with_prompt.png", generator="unknown", prompt="masterpiece")  # prompt -> has
    _add(test_db, "unknown_no_prompt.png", generator="unknown")                 # none
    _add(test_db, "blank_gen.png", generator="")                                # none
    return test_db


class TestMetadataPresenceFilter:
    def test_none_is_noop(self, seeded):
        assert seeded.get_images_paginated(has_metadata=None, limit=50)["total"] == 4

    def test_true_returns_only_with_metadata(self, seeded):
        res = seeded.get_images_paginated(has_metadata=True, limit=50)
        assert sorted(i["filename"] for i in res["images"]) == [
            "known_gen.png",
            "unknown_with_prompt.png",
        ]
        assert res["total"] == 2

    def test_false_returns_only_without_metadata(self, seeded):
        res = seeded.get_images_paginated(has_metadata=False, limit=50)
        assert sorted(i["filename"] for i in res["images"]) == [
            "blank_gen.png",
            "unknown_no_prompt.png",
        ]
        assert res["total"] == 2

    def test_partition_is_exact_and_complete(self, seeded):
        total = seeded.get_images_paginated(has_metadata=None, limit=50)["total"]
        with_meta = seeded.get_images_paginated(has_metadata=True, limit=50)["total"]
        without = seeded.get_images_paginated(has_metadata=False, limit=50)["total"]
        assert with_meta + without == total

    def test_count_helper_respects_filter(self, seeded):
        assert seeded.get_filtered_image_count(has_metadata=True) == 2
        assert seeded.get_filtered_image_count(has_metadata=False) == 2
        assert seeded.get_filtered_image_count(has_metadata=None) == 4

    def test_composes_with_generator_filter(self, seeded):
        # generator=comfyui already implies "has metadata"; the extra filter is a no-op narrowing.
        res = seeded.get_images_paginated(generators=["comfyui"], has_metadata=True, limit=50)
        assert [i["filename"] for i in res["images"]] == ["known_gen.png"]


class TestMetadataPresenceSelectionToken:
    """The tri-state filter must survive the stateless select-all token round-trip."""

    def _service(self):
        from services.image_service import ImageService
        return ImageService()

    def test_token_with_metadata_resolves_only_matching_ids(self, seeded):
        svc = self._service()
        info = svc.create_selection_token(has_metadata=True)
        chunk = svc.get_selection_chunk(info["selection_token"], offset=0, limit=100)
        assert len(chunk["image_ids"]) == 2

    def test_token_without_metadata_resolves_only_matching_ids(self, seeded):
        svc = self._service()
        info = svc.create_selection_token(has_metadata=False)
        chunk = svc.get_selection_chunk(info["selection_token"], offset=0, limit=100)
        assert len(chunk["image_ids"]) == 2

    def test_token_default_includes_everything(self, seeded):
        svc = self._service()
        info = svc.create_selection_token()
        chunk = svc.get_selection_chunk(info["selection_token"], offset=0, limit=100)
        assert len(chunk["image_ids"]) == 4
