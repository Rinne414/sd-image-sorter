"""Shared constants for the dataset export service (split 2026-07).

Moved verbatim from services/dataset_export_service.py and re-exported by the
facade. The engine reads the three DATASET_EXPORT_* limits back through the
facade (_svc()) so facade-level monkeypatches keep landing
(tests/test_dataset_export_pins.py pins the item-limit read); submodules import
the rest directly from here.
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
PACKAGE_MANIFEST_SCHEMA = "sd-image-sorter.dataset-package"
PACKAGE_MANIFEST_VERSION = 2
PACKAGE_INVENTORY_FILENAME = "export_inventory.jsonl"
PACKAGE_HASH_CHUNK_SIZE = 1024 * 1024
PACKAGE_LOCK_FILENAME = ".sd-image-sorter-package.lock"

VALID_MASK_EXPORT_MODES = ("none", "onetrainer", "kohya", "anima_lora")
VALID_TRAINER_CONFIGS = ("none", "kohya_toml", "anima_lora_toml")
