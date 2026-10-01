"""WD14-family taggers and Kaloscope as external models (MS1a, split from model_matchers).

WD14: ComfyUI's flat ``<variant>.onnx`` + ``<variant>.csv`` layout
(comfyui-WD14-Tagger, ComfyUI-Booru-Tagger) and this program's
``<variant>/<model_file>`` layout; the model must match its size pin (and
SHA when hashable), the tags file must be present and match its pin, ONNX
external data must match too. Kaloscope: ``best_checkpoint.pth`` up to
three levels under ``models/lsnet`` with ``class_mapping.csv`` beside or
above it; the ``comfyui-lsnet`` checkout is reported with its git revision.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

from model_matchers import (
    KALOSCOPE_CHECKPOINT_NAME,
    KALOSCOPE_CHECKPOINT_SHA256,
    KALOSCOPE_CHECKPOINT_SIZE_BYTES,
    KALOSCOPE_CLASS_MAPPING_NAME,
    KALOSCOPE_VARIANT,
    KIND_COMFYUI,
    REASON_MISSING_COMPANION,
    VERIFY_SHA,
    VERIFY_SIZE,
    MatchReport,
    _Context,
    _KALOSCOPE_COMFY_SUBDIRS,
    _KALOSCOPE_EXTRA_KEYS,
    _KALOSCOPE_FOLDER_SUBDIRS,
    _KALOSCOPE_WALK_DEPTH,
    _WD14_COMFY_SUBDIRS,
    _WD14_EXTRA_KEYS,
    _WD14_FOLDER_SUBDIRS,
    _plain_children,
    _stat_file,
    _verify_pinned_file,
    _wd14_entries,
)


def _wd14_layouts(
    folder: Path, variant: str, entry: Dict[str, Any]
) -> List[Tuple[Path, Path, Dict[str, Path]]]:
    """(model, tags, external-data) candidates: ComfyUI flat ``<variant>.onnx`` and app ``<variant>/<model_file>``."""
    model_file = str(entry.get("model_file") or "")
    tags_file = str(entry.get("tags_file") or "")
    external = {
        name: folder / variant / name for name in entry.get("external_data_files") or ()
    }
    layouts: List[Tuple[Path, Path, Dict[str, Path]]] = []
    if model_file and tags_file:
        layouts.append(
            (folder / variant / model_file, folder / variant / tags_file, external)
        )
    if model_file.endswith(".onnx") and tags_file.endswith(".csv") and not external:
        layouts.append((folder / f"{variant}.onnx", folder / f"{variant}.csv", {}))
    return layouts


def match_wd14(ctx: _Context) -> MatchReport:
    report = MatchReport()
    for candidate in ctx.candidate_dirs(
        _WD14_COMFY_SUBDIRS, _WD14_FOLDER_SUBDIRS, _WD14_EXTRA_KEYS
    ):
        for variant, entry in _wd14_entries():
            for model_path, tags_path, external in _wd14_layouts(
                candidate.path, variant, entry
            ):
                stat = ctx.stat_file(model_path)
                if stat is None:
                    continue
                _match_wd14_file(
                    ctx,
                    report,
                    variant,
                    entry,
                    model_path,
                    stat,
                    tags_path,
                    external,
                    candidate.folder,
                )
    return report


def _check_external_data(
    ctx: _Context, entry: Dict[str, Any], external: Dict[str, Path], notes: List[str]
) -> Tuple[Optional[str], str, List[str]]:
    """ONNX external-data files beside the model: present and matching their pins."""
    pins = entry.get("external_data_pins") or {}
    companions: List[str] = []
    for name, path in external.items():
        ext_stat = ctx.stat_file(path)
        if ext_stat is None:
            return (
                REASON_MISSING_COMPANION,
                f"{name} is missing or not readable",
                companions,
            )
        pin = pins.get(name) or {}
        reason, detail, ext_notes = _verify_pinned_file(
            ctx, path, ext_stat, pin.get("size_bytes"), pin.get("sha256")
        )
        if reason:
            return reason, f"{name}: {detail}", companions
        notes.extend(f"{name}:{n}" for n in ext_notes)
        companions.append(str(path))
    return None, "", companions


def _match_wd14_file(
    ctx: _Context,
    report: MatchReport,
    variant: str,
    entry: Dict[str, Any],
    model_path: Path,
    stat: os.stat_result,
    tags_path: Path,
    external: Dict[str, Path],
    folder: str,
) -> None:
    reason, detail, notes = _verify_pinned_file(
        ctx, model_path, stat, entry.get("size_bytes"), entry.get("sha256")
    )
    if reason:
        report.rejected.append(ctx.reject("wd14", variant, model_path, reason, detail))
        return
    tags_pin = entry.get("tags_sha256")
    reason, detail = ctx.check_companion(tags_path, (tags_pin,) if tags_pin else ())
    if reason:
        report.rejected.append(ctx.reject("wd14", variant, model_path, reason, detail))
        return
    reason, detail, extra_companions = _check_external_data(ctx, entry, external, notes)
    if reason:
        report.rejected.append(ctx.reject("wd14", variant, model_path, reason, detail))
        return
    verify = VERIFY_SHA if "sha_verified" in notes else VERIFY_SIZE
    report.matches.append(
        ctx.match(
            "wd14",
            variant,
            model_path,
            stat,
            verify,
            [str(tags_path), *extra_companions],
            notes,
            folder=folder,
        )
    )


# ---------------------------------------------------------------------------
# Kaloscope 2.0 (artist)
# ---------------------------------------------------------------------------


def _walk_for_name(folder: Path, name: str, depth: int) -> List[Path]:
    """Files called ``name`` up to ``depth`` levels down; symlinks and junctions are not followed."""
    found: List[Path] = []
    for child in _plain_children(folder):
        if child.name == name and _stat_file(child) is not None:
            found.append(child)
        elif depth > 0 and child.is_dir() and not child.name.startswith("."):
            found.extend(_walk_for_name(child, name, depth - 1))
    return found


def read_git_head_commit(repo: Path) -> Optional[str]:
    """The commit a checkout is at, from ``.git/HEAD`` (direct, loose ref or packed-refs)."""
    git_dir = repo / ".git"
    try:
        head = (git_dir / "HEAD").read_text(encoding="utf-8").strip()
    except OSError:
        return None
    if not head.startswith("ref:"):
        return head.lower() if len(head) == 40 else None
    ref = head[4:].strip()
    try:
        return (git_dir / ref).read_text(encoding="utf-8").strip().lower()
    except OSError:
        pass
    try:
        for line in (git_dir / "packed-refs").read_text(encoding="utf-8").splitlines():
            parts = line.strip().split()
            if len(parts) == 2 and parts[1] == ref:
                return parts[0].lower()
    except OSError:
        return None
    return None


def _kaloscope_runtime(ctx: _Context) -> Tuple[Optional[Path], str]:
    import artist_identifier

    base = Path(ctx.root.path)
    candidates = (
        [base / "custom_nodes" / "comfyui-lsnet"]
        if ctx.root.kind == KIND_COMFYUI
        else [base / "comfyui-lsnet", base / "comfyui-lsnet-runtime"]
    )
    for runtime in candidates:
        if not ctx.may_read(runtime) or not (runtime / "lsnet_model").is_dir():
            continue
        commit = read_git_head_commit(runtime)
        if commit == artist_identifier.ARTIST_LSNET_RUNTIME_REVISION.lower():
            return runtime, "runtime_revision_verified"
        return runtime, "runtime_revision_unverified"
    return None, "runtime_missing"


def _kaloscope_mapping(checkpoint: Path) -> Path:
    """class_mapping.csv beside the checkpoint, or one level up (the HF layout)."""
    beside = checkpoint.parent / KALOSCOPE_CLASS_MAPPING_NAME
    above = checkpoint.parent.parent / KALOSCOPE_CLASS_MAPPING_NAME
    return (
        beside if _stat_file(beside) is not None or _stat_file(above) is None else above
    )


def _match_kaloscope_checkpoint(
    ctx: _Context,
    report: MatchReport,
    checkpoint: Path,
    mapping_pins: Sequence[str],
    folder: str,
) -> None:
    stat = ctx.stat_file(checkpoint)
    if stat is None:
        return
    reason, detail, notes = _verify_pinned_file(
        ctx,
        checkpoint,
        stat,
        KALOSCOPE_CHECKPOINT_SIZE_BYTES,
        KALOSCOPE_CHECKPOINT_SHA256,
    )
    if reason:
        report.rejected.append(
            ctx.reject("artist", KALOSCOPE_VARIANT, checkpoint, reason, detail)
        )
        return
    mapping = _kaloscope_mapping(checkpoint)
    reason, detail = ctx.check_companion(mapping, mapping_pins)
    if reason:
        report.rejected.append(
            ctx.reject("artist", KALOSCOPE_VARIANT, checkpoint, reason, detail)
        )
        return
    runtime, runtime_note = _kaloscope_runtime(ctx)
    companions = [str(mapping)] + ([str(runtime)] if runtime else [])
    verify = VERIFY_SHA if "sha_verified" in notes else VERIFY_SIZE
    report.matches.append(
        ctx.match(
            "artist",
            KALOSCOPE_VARIANT,
            checkpoint,
            stat,
            verify,
            companions,
            notes + [runtime_note],
            folder=folder,
        )
    )


def match_kaloscope(ctx: _Context) -> MatchReport:
    import artist_identifier

    report = MatchReport()
    mapping_pins = tuple(
        artist_identifier._EXPECTED_ARTIST_FILE_SHA256.get(
            KALOSCOPE_CLASS_MAPPING_NAME, ()
        )
    )
    seen: set = set()
    for candidate in ctx.candidate_dirs(
        _KALOSCOPE_COMFY_SUBDIRS, _KALOSCOPE_FOLDER_SUBDIRS, _KALOSCOPE_EXTRA_KEYS
    ):
        for checkpoint in _walk_for_name(
            candidate.path, KALOSCOPE_CHECKPOINT_NAME, _KALOSCOPE_WALK_DEPTH
        ):
            key = os.path.normcase(str(checkpoint))
            if key in seen:
                continue
            seen.add(key)
            _match_kaloscope_checkpoint(
                ctx, report, checkpoint, mapping_pins, candidate.folder
            )
    return report
