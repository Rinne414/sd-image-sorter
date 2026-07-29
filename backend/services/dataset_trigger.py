"""Shared Dataset Maker trigger and caption-list contracts."""
from __future__ import annotations

from typing import Annotated

from pydantic import AfterValidator, Field


DATASET_TRIGGER_MAX_LENGTH = 100
DATASET_CAPTION_TAG_LIST_MAX_LENGTH = 1000
DATASET_TRIGGER_WHITESPACE = (
    "\u0009\u000a\u000b\u000c\u000d"
    "\u001c\u001d\u001e\u001f\u0020"
    "\u0085\u00a0\u1680"
    "\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a"
    "\u2028\u2029\u202f\u205f\u3000\ufeff"
)


def validate_dataset_trigger(value: str) -> str:
    trigger = value.strip(DATASET_TRIGGER_WHITESPACE)
    if "," in trigger or any(
        character in DATASET_TRIGGER_WHITESPACE for character in trigger
    ):
        raise ValueError(
            "trigger must be one token without commas, line breaks, or internal whitespace"
        )
    if value and not trigger.replace("_", " ").strip():
        raise ValueError(
            "trigger must contain characters other than spaces or underscores"
        )
    return trigger


DatasetTrigger = Annotated[
    str,
    Field(max_length=DATASET_TRIGGER_MAX_LENGTH),
    AfterValidator(validate_dataset_trigger),
]
