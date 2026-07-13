"""Shared constants for the dataset export service (split 2026-07).

Moved verbatim from services/dataset_export_service.py and re-exported by the
facade. _EXPORT_ACTIVE_STATUSES is NOT here — it stays defined on the facade
next to the job-registry family it guards. The engine reads the three
DATASET_EXPORT_* limits back through the facade (_svc()) so facade-level
monkeypatches keep landing (tests/test_dataset_export_pins.py pins the
item-limit read); submodules import the rest directly from here.
"""

VALID_IMAGE_OPS = {"copy", "move"}
VALID_OVERWRITE_POLICIES = {"unique", "overwrite", "skip"}
TRAINING_TAG_CONTENT_MODES = {"tags", "caption_tags", "caption_merged", "tags_nl"}
DATASET_LEGACY_TEMPLATE = "{trigger}, {tags:filtered}, {append}"
DATASET_EXPORT_RESPONSE_ITEM_LIMIT = 2_000
DATASET_EXPORT_RECENT_ERROR_LIMIT = 20
DATASET_EXPORT_DB_CHUNK_SIZE = 500
EXPORT_MANIFEST_FILENAME = "export_manifest.json"
EXPORT_MANIFEST_VERSION = 1

VALID_MASK_EXPORT_MODES = ("none", "onetrainer", "kohya")
VALID_TRAINER_CONFIGS = ("none", "kohya_toml")
