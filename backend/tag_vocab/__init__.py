"""tag_vocab: verbatim data tables extracted from backend/tag_rules.py (2026-07 split).

Data-only package - no logic and no imports of app modules. The tag_rules
facade re-imports every table; production code and tests must keep importing
(and monkeypatching) tag names via tag_rules, not from tag_vocab.
"""
