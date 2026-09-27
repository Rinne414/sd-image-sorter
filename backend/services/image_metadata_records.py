"""Reader edits written back in the image's own metadata format.

A NovelAI PNG keeps its generation record in a ``Comment`` JSON chunk; an
A1111/Forge image keeps it in one ``parameters`` block. The Reader used to
rebuild an A1111 block for every image, which turned a saved NovelAI image
into a WebUI one on the next read and dropped every A1111 setting the editor
does not show. The helpers here put the edit into the record the image
already has instead.
"""

from __future__ import annotations

import copy
import json
import re
from typing import Any, Dict, List, Optional, Tuple

from PIL import PngImagePlugin

# The editor fields a NovelAI Comment record has a place for, by record key.
_NAI_TEXT_FIELDS = (
    ("prompt", "prompt", "v4_prompt"),
    ("negative_prompt", "uc", "v4_negative_prompt"),
)
_NAI_NUMBER_FIELDS = (
    ("steps", "steps", int),
    ("seed", "seed", int),
    ("cfg_scale", "scale", float),
)

NAI_UNSAVED_FIELDS_WARNING = (
    "A NovelAI record has no place for these fields, so they were not saved: {keys}."
)

# A1111's own infotext pattern (modules/infotext_utils.py ``re_param``): a
# ``Label: value`` pair whose value may be a quoted string holding commas.
_A1111_SETTING = re.compile(r'\s*(\w[\w \-/]+):\s*("(?:\\.|[^\\"])+"|[^,]*)(?:,|$)')

# Settings lines the Reader shows as fields. A shown setting missing from the
# rebuilt block was cleared by the user, so the original is not brought back.
READER_SHOWN_SETTING_LABELS = frozenset(
    {"Steps", "Sampler", "CFG scale", "Seed", "Size", "Model", "LoRAs"}
)

# A setting that describes another one and goes stale when that one changes.
_DEPENDENT_SETTINGS = {"Model hash": "Model"}


def nai_comment_record(
    source_chunks: Optional[Dict[str, str]],
) -> Optional[Dict[str, Any]]:
    """The NovelAI ``Comment`` record of a source image, or None.

    Mirrors the parser's NovelAI test (``prompt``/``uc``/``v4_*`` keys) and
    its Fooocus disambiguation, so only a record the app reads as NovelAI is
    edited in place.
    """
    raw = (source_chunks or {}).get("Comment")
    if not raw:
        return None
    try:
        record = json.loads(raw)
    except (TypeError, ValueError):
        return None
    if not isinstance(record, dict):
        return None
    if not any(
        key in record for key in ("prompt", "uc", "v4_prompt", "v4_negative_prompt")
    ):
        return None
    looks_like_fooocus = (
        record.get("metadata_scheme") in {"fooocus", "a1111"}
        or any(
            key in record
            for key in ("base_model", "performance", "Performance", "Base Model")
        )
        or ("negative_prompt" in record and "uc" not in record)
        or "fooocus" in str(record.get("version") or "").lower()
    )
    return None if looks_like_fooocus else record


def _set_v4_caption(record: Dict[str, Any], key: str, text: str) -> None:
    block = record.get(key)
    caption = block.get("caption") if isinstance(block, dict) else None
    if isinstance(caption, dict):
        caption["base_caption"] = text


def _parse_size(value: Any) -> Optional[Tuple[int, int]]:
    match = re.fullmatch(r"\s*(\d+)\s*[xX×]\s*(\d+)\s*", str(value or ""))
    return (int(match.group(1)), int(match.group(2))) if match else None


def apply_edit_to_nai_record(
    record: Dict[str, Any], metadata: Dict[str, Any]
) -> Dict[str, Any]:
    """A copy of ``record`` holding the edited fields.

    The Reader leaves out a field the user cleared: a cleared prompt becomes
    empty, a cleared number keeps the original (a NovelAI record needs one).
    """
    edited = copy.deepcopy(record)
    for field, record_key, v4_key in _NAI_TEXT_FIELDS:
        text = str(metadata.get(field) or "")
        edited[record_key] = text
        _set_v4_caption(edited, v4_key, text)
    for field, record_key, cast in _NAI_NUMBER_FIELDS:
        try:
            edited[record_key] = cast(metadata[field])
        except (KeyError, TypeError, ValueError):
            continue
    sampler = metadata.get("sampler")
    if sampler:
        edited["sampler"] = str(sampler)
    size = _parse_size(metadata.get("size"))
    if size:
        edited["width"], edited["height"] = size
    return edited


def build_nai_pnginfo(
    metadata: Dict[str, Any],
    source_chunks: Dict[str, str],
    record: Dict[str, Any],
    warnings: List[str],
) -> PngImagePlugin.PngInfo:
    """Every source chunk, with the edit written into the NovelAI record.

    ``Description`` is NovelAI's copy of the prompt and follows the edit when
    it still matched the record's prompt; ``Source`` names the model.
    """
    edited = apply_edit_to_nai_record(record, metadata)
    chunks = dict(source_chunks)
    chunks["Comment"] = json.dumps(edited, ensure_ascii=False)
    if chunks.get("Description") == record.get("prompt"):
        chunks["Description"] = edited["prompt"]
    model = str(metadata.get("model") or "").strip()
    if model:
        chunks["Source"] = model
    if metadata.get("loras"):
        warnings.append(NAI_UNSAVED_FIELDS_WARNING.format(keys="LoRAs"))

    pnginfo = PngImagePlugin.PngInfo()
    for key, value in chunks.items():
        pnginfo.add_text(key, value)
    return pnginfo


def _settings_line_index(lines: List[str]) -> Optional[int]:
    for index in range(len(lines) - 1, -1, -1):
        if lines[index].lstrip().startswith("Steps:"):
            return index
    return None


def _settings(line: str) -> List[Tuple[str, str]]:
    return [
        (match.group(1).strip(), match.group(2).strip())
        for match in _A1111_SETTING.finditer(line)
    ]


def keep_unshown_parameter_settings(
    parameters_text: str,
    source_chunks: Optional[Dict[str, str]],
) -> str:
    """The rebuilt A1111 block plus the source settings the editor does not show.

    Each kept setting is copied verbatim (quoted values included). A setting
    the Reader shows and the edit left out was cleared on purpose and stays
    out; a ``Model hash`` whose model was changed is stale and stays out too
    (``dropped_parameter_settings_warning`` then names it).
    """
    source_text = (source_chunks or {}).get("parameters") or ""
    source_lines = source_text.splitlines()
    source_index = _settings_line_index(source_lines)
    lines = parameters_text.splitlines()
    index = _settings_line_index(lines)
    if source_index is None or index is None:
        return parameters_text

    source_settings = _settings(source_lines[source_index])
    source_values = dict(source_settings)
    rebuilt = dict(_settings(lines[index]))
    kept: List[str] = []
    for label, value in source_settings:
        if label in rebuilt or label in READER_SHOWN_SETTING_LABELS:
            continue
        depends_on = _DEPENDENT_SETTINGS.get(label)
        if depends_on and rebuilt.get(depends_on) != source_values.get(depends_on):
            continue
        kept.append(f"{label}: {value}")
    if kept:
        lines[index] = ", ".join([lines[index], *kept])
    return "\n".join(lines)
