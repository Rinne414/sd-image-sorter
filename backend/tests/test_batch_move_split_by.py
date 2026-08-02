"""B3-②: batch-move split_by subfolder helpers + request validation."""
from __future__ import annotations

from pathlib import Path

import pytest
from pydantic import ValidationError

from services.sorting.batch_move import BatchMoveMixin
from services.sorting_models import BatchMoveRequest


def test_sanitize_split_folder_name_strips_unsafe_and_extensions():
    assert BatchMoveMixin._sanitize_split_folder_name('webui') == 'webui'
    assert BatchMoveMixin._sanitize_split_folder_name('foo/bar:baz') == 'foo_bar_baz'
    assert BatchMoveMixin._sanitize_split_folder_name('model.safetensors') == 'model'
    assert BatchMoveMixin._sanitize_split_folder_name('   ') == 'unknown'
    assert BatchMoveMixin._sanitize_split_folder_name('a' * 100).startswith('a')
    assert len(BatchMoveMixin._sanitize_split_folder_name('a' * 100)) <= 80


def test_split_destination_for_image_facets():
    base = str(Path('/tmp/out'))
    img = {
        'generator': 'webui',
        'checkpoint': 'D:/models/foo.safetensors',
        'checkpoint_normalized': 'foo',
        'user_rating': 5,
    }
    assert BatchMoveMixin._split_destination_for_image(base, img, None) == base
    gen_dest = BatchMoveMixin._split_destination_for_image(base, img, 'generator')
    assert Path(gen_dest).name == 'webui'
    ckpt_dest = BatchMoveMixin._split_destination_for_image(base, img, 'checkpoint')
    assert Path(ckpt_dest).name == 'foo'
    rating_dest = BatchMoveMixin._split_destination_for_image(base, img, 'rating')
    assert Path(rating_dest).name == 'star-5'
    missing = {}
    unknown_dest = BatchMoveMixin._split_destination_for_image(base, missing, 'generator')
    assert Path(unknown_dest).name == 'unknown'


def test_batch_move_request_accepts_split_by():
    req = BatchMoveRequest(
        generators=['webui'],
        destination_folder='/tmp/out',
        split_by='checkpoint',
    )
    assert req.split_by == 'checkpoint'
    req_none = BatchMoveRequest(
        generators=['webui'],
        destination_folder='/tmp/out',
        split_by='none',
    )
    assert req_none.split_by is None


def test_batch_move_request_rejects_bad_split_by():
    with pytest.raises(ValidationError):
        BatchMoveRequest(
            generators=['webui'],
            destination_folder='/tmp/out',
            split_by='tags',
        )
