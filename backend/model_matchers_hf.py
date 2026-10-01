"""Hugging Face cache snapshots as model sources (MS1a, split from model_matchers).

A ``models--<org>--<repo>/snapshots/<revision>/`` folder whose name is the
pinned commit, with every required file present and non-empty (symlinks to
``blobs/`` resolved), is the pinned model: verify ``revision``; files that
carry a SHA pin and may be hashed raise it to ``sha``. Another snapshot is
``version_mismatch``, a snapshot missing a file is ``incomplete``. The
aesthetic backbone has no pin anywhere, so like ``aesthetic.py`` it is taken
from any snapshot by file name. Only the WD14 runtime family of
``TAGGER_MODELS`` is listed (see ``model_matchers``).
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, List, Optional, Sequence, Tuple

import aesthetic_backbone
from model_matchers import (
    REASON_INCOMPLETE,
    REASON_VERSION,
    VERIFY_NAME,
    VERIFY_REVISION,
    VERIFY_SHA,
    MatchReport,
    _Context,
    _stat_file,
    _verify_pinned_file,
    is_wd14_runtime_entry,
)
from tagger_models import TAGGER_MODELS


@dataclass(frozen=True)
class _HfFile:
    relpath: str
    size_bytes: Optional[int] = None
    sha256: Optional[str] = None


@dataclass(frozen=True)
class _HfSpec:
    model_id: str
    variant: Optional[str]
    repo: str
    revision: Optional[
        str
    ]  # None: any snapshot (no pin exists, name-only like the loader)
    files: Tuple[_HfFile, ...]
    any_of: Tuple[str, ...] = ()  # alternative primary files when ``files`` is empty


def _pinned_file(pinned: Any) -> _HfFile:
    return _HfFile(pinned.remote_path, pinned.size_bytes, pinned.sha256)


def _wd14_specs() -> List[_HfSpec]:
    specs: List[_HfSpec] = []
    for variant, entry in TAGGER_MODELS.items():
        if not (
            entry.get("repo_id") and entry.get("model_file") and entry.get("tags_file")
        ):
            continue
        if not is_wd14_runtime_entry(entry) or entry.get("official_download_only"):
            continue
        subfolder = str(entry.get("repo_subfolder") or "").strip("/")
        prefix = f"{subfolder}/" if subfolder else ""
        pins = entry.get("external_data_pins") or {}
        files = [
            _HfFile(
                prefix + entry["model_file"],
                entry.get("size_bytes"),
                entry.get("sha256"),
            ),
            _HfFile(prefix + entry["tags_file"], None, entry.get("tags_sha256")),
        ]
        files.extend(
            _HfFile(
                prefix + name,
                (pins.get(name) or {}).get("size_bytes"),
                (pins.get(name) or {}).get("sha256"),
            )
            for name in entry.get("external_data_files") or ()
        )
        files.extend(_HfFile(prefix + name) for name in entry.get("extra_files") or ())
        specs.append(
            _HfSpec("wd14", variant, entry["repo_id"], entry["revision"], tuple(files))
        )
    return specs


def _folder_specs() -> List[_HfSpec]:
    """Models loaded from a whole snapshot folder (transformers-style)."""
    import florence2_captioner
    import lucida_matting

    return [
        _HfSpec(
            "florence2",
            "base",
            florence2_captioner.FLORENCE2_MODEL_ID,
            florence2_captioner.FLORENCE2_REVISION,
            tuple(_HfFile(f) for f in florence2_captioner.FLORENCE2_REQUIRED_FILES),
        ),
        _HfSpec(
            "lucida",
            "pinned",
            lucida_matting.LUCIDA_MODEL_ID,
            lucida_matting.LUCIDA_REVISION,
            tuple(_HfFile(f) for f in lucida_matting.LUCIDA_REQUIRED_FILES),
        ),
    ]


def _pinned_file_specs() -> List[_HfSpec]:
    """Single pinned files (sha + size) and the unpinned aesthetic backbone."""
    import aesthetic
    import anime_aesthetic
    import anime_censor_models
    import csd_weights

    specs = [
        _HfSpec(
            "csd",
            None,
            csd_weights.CSD_FILE.repo,
            csd_weights.CSD_FILE.revision,
            (_pinned_file(csd_weights.CSD_FILE),),
        ),
        _HfSpec(
            "aesthetic-anime",
            None,
            anime_aesthetic.MODEL_FILE.repo,
            anime_aesthetic.MODEL_FILE.revision,
            (
                _pinned_file(anime_aesthetic.MODEL_FILE),
                _pinned_file(anime_aesthetic.SAMPLES_FILE),
            ),
        ),
        _HfSpec(
            "aesthetic-waifu",
            None,
            aesthetic.WAIFU_HEAD_FILE.repo,
            aesthetic.WAIFU_HEAD_FILE.revision,
            (_pinned_file(aesthetic.WAIFU_HEAD_FILE),),
        ),
        _HfSpec(
            "aesthetic",
            "backbone",
            aesthetic_backbone.BACKBONE_REPO,
            None,
            (),
            any_of=aesthetic_backbone.BACKBONE_SNAPSHOT_FILENAMES,
        ),
    ]
    for pinned in (anime_censor_models.CENSOR_FILE, anime_censor_models.FACE_FILE):
        specs.append(
            _HfSpec(
                "censor-anime",
                pinned.key,
                pinned.repo,
                pinned.revision,
                (_pinned_file(pinned),),
            )
        )
    return specs


def hf_cache_specs() -> List[_HfSpec]:
    """Built at call time so the pins the loaders hold are the ones checked."""
    return _folder_specs() + _pinned_file_specs() + _wd14_specs()


def _snapshot_dirs(ctx: _Context, repo: str) -> Tuple[Path, List[Path]]:
    repo_dir = Path(ctx.root.path) / ("models--" + repo.replace("/", "--"))
    snapshots = repo_dir / "snapshots"
    if not ctx.may_read(snapshots):
        return snapshots, []
    try:
        dirs = sorted(
            (d for d in snapshots.iterdir() if ctx.may_read(d) and d.is_dir()),
            reverse=True,
        )
    except OSError:
        dirs = []
    return snapshots, dirs


def _match_any_snapshot(
    ctx: _Context, spec: _HfSpec, dirs: Sequence[Path], report: MatchReport
) -> None:
    """No pin: the newest snapshot holding one of the named files, by name only."""
    for snapshot in dirs:
        for name in spec.any_of:
            stat = ctx.stat_file(snapshot / name)
            if stat is not None:
                report.matches.append(
                    ctx.match(
                        spec.model_id, spec.variant, snapshot / name, stat, VERIFY_NAME
                    )
                )
                return


def _check_snapshot_files(
    ctx: _Context, spec: _HfSpec, pinned: Path, report: MatchReport
) -> Optional[Tuple[List[Path], List[str]]]:
    """Every required file present, non-empty and matching its pin; None after a rejection."""
    notes: List[str] = []
    paths: List[Path] = []
    for item in spec.files:
        path = pinned / item.relpath
        stat = ctx.stat_file(path)
        if stat is None:
            report.rejected.append(
                ctx.reject(
                    spec.model_id,
                    spec.variant,
                    pinned,
                    REASON_INCOMPLETE,
                    f"{item.relpath} is missing, empty or not readable in snapshot {pinned.name[:8]}",
                )
            )
            return None
        reason, detail, file_notes = _verify_pinned_file(
            ctx, path, stat, item.size_bytes, item.sha256
        )
        if reason:
            report.rejected.append(
                ctx.reject(spec.model_id, spec.variant, path, reason, detail)
            )
            return None
        notes.extend(file_notes)
        paths.append(path)
    return paths, notes


def _match_hf_spec(ctx: _Context, spec: _HfSpec, report: MatchReport) -> None:
    snapshots, dirs = _snapshot_dirs(ctx, spec.repo)
    if not dirs:
        return
    if spec.revision is None:
        _match_any_snapshot(ctx, spec, dirs, report)
        return
    pinned = snapshots / spec.revision
    if not ctx.may_read(pinned) or not pinned.is_dir():
        others = ", ".join(d.name[:8] for d in dirs)
        report.rejected.append(
            ctx.reject(
                spec.model_id,
                spec.variant,
                dirs[0],
                REASON_VERSION,
                f"snapshot {others} found, pinned revision is {spec.revision[:8]}",
            )
        )
        return
    checked = _check_snapshot_files(ctx, spec, pinned, report)
    if checked is None:
        return
    paths, notes = checked
    first = spec.files[0]
    primary = (
        paths[0] if len(spec.files) == 1 or first.sha256 or first.size_bytes else pinned
    )
    primary_stat = primary.stat() if primary.is_file() else _dir_stat(pinned, paths)
    verify = VERIFY_SHA if "sha_verified" in notes else VERIFY_REVISION
    companions = [str(p) for p in paths if p != primary]
    report.matches.append(
        ctx.match(
            spec.model_id,
            spec.variant,
            primary,
            primary_stat,
            verify,
            companions,
            notes,
        )
    )


class _DirStat:
    def __init__(self, size: int, mtime_ns: int) -> None:
        self.st_size = size
        self.st_mtime_ns = mtime_ns


def _dir_stat(folder: Path, files: Sequence[Path]) -> Any:
    total = 0
    newest = 0
    for path in files:
        stat = _stat_file(path)
        if stat is not None:
            total += stat.st_size
            newest = max(newest, stat.st_mtime_ns)
    if newest == 0:
        newest = folder.stat().st_mtime_ns
    return _DirStat(total, newest)


def match_hf_cache(ctx: _Context) -> MatchReport:
    report = MatchReport()
    for spec in hf_cache_specs():
        _match_hf_spec(ctx, spec, report)
    return report
