"""Dataset / Smart Tag trigger: plain spaces and underscores are both accepted."""

from __future__ import annotations

import pytest
from pydantic import TypeAdapter, ValidationError

from services.dataset_trigger import DatasetTrigger, validate_dataset_trigger


def test_space_and_underscore_trigger_spellings_are_accepted():
    assert validate_dataset_trigger("long_hair_girl") == "long_hair_girl"
    assert validate_dataset_trigger("long hair girl") == "long hair girl"
    assert validate_dataset_trigger("  long  hair   girl  ") == "long hair girl"


def test_dataset_trigger_field_accepts_spaced_danbooru_token():
    adapter = TypeAdapter(DatasetTrigger)
    assert adapter.validate_python("long hair girl") == "long hair girl"


@pytest.mark.parametrize(
    "trigger",
    [
        "boxchar,extra",
        "line\nbreak",
        "tab\there",
        "zero\ufeffwidth",
    ],
)
def test_trigger_still_rejects_commas_and_control_whitespace(trigger):
    with pytest.raises(ValueError, match="commas|whitespace|line breaks"):
        validate_dataset_trigger(trigger)


def test_dataset_trigger_field_rejects_comma():
    adapter = TypeAdapter(DatasetTrigger)
    with pytest.raises(ValidationError):
        adapter.validate_python("a,b")
