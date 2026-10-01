"""Hugging Face cache snapshots as model sources (MS1a, split from model_matchers).

A ``models--<org>--<repo>/snapshots/<revision>/`` folder whose name is the
pinned commit, with every required file present and non-empty (symlinks to
``blobs/`` resolved), is the pinned model: verify ``revision``; files that
carry a SHA pin and may be hashed raise it to ``sha``. Another snapshot is
``version_mismatch``, a snapshot missing a file is ``incomplete``. The
aesthetic backbone has no pin anywhere, so like ``aesthetic.py`` it is taken
from any snapshot by file name.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, List, Optional, Sequence, Tuple

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
)
from tagger_models import TAGGER_MODELS

AESTHETIC_BACKBONE_REPO = "timm/vit_large_patch14_clip_224.openai"
AESTHETIC_BACKBONE_FILES = ("open_clip_model.safetensors", "pytorch_model.bin")


# ---------------------------------------------------------------------------


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


def hf_cache_specs() -> List[_HfSpec]:
    """Built at call time so the pins the loaders hold are the ones checked."""
    import aesthetic
    import anime_aesthetic
    import anime_censor_models
    import florence2_captioner
    import lucida_matting

    specs: List[_HfSpec] = [
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
        _HfSpec(
            "aesthetic-anime",
            None,
            anime_aesthetic.MODEL_FILE.repo,
            anime_aesthetic.MODEL_FILE.revision,
            (
                _HfFile(
                    anime_aesthetic.MODEL_FILE.remote_path,
                    anime_aesthetic.MODEL_FILE.size_bytes,
                    anime_aesthetic.MODEL_FILE.sha256,
                ),
                _HfFile(
                    anime_aesthetic.SAMPLES_FILE.remote_path,
                    anime_aesthetic.SAMPLES_FILE.size_bytes,
                    anime_aesthetic.SAMPLES_FILE.sha256,
                ),
            ),
        ),
        _HfSpec(
            "aesthetic-waifu",
            None,
            aesthetic.WAIFU_HEAD_FILE.repo,
            aesthetic.WAIFU_HEAD_FILE.revision,
            (
                _HfFile(
                    aesthetic.WAIFU_HEAD_FILE.remote_path,
                    aesthetic.WAIFU_HEAD_FILE.size_bytes,
                    aesthetic.WAIFU_HEAD_FILE.sha256,
                ),
            ),
        ),
        _HfSpec(
            "aesthetic",
            "backbone",
            AESTHETIC_BACKBONE_REPO,
            None,
            (),
            any_of=AESTHETIC_BACKBONE_FILES,
        ),
    ]
    for pinned in (anime_censor_models.CENSOR_FILE, anime_censor_models.FACE_FILE):
        specs.append(
            _HfSpec(
                "censor-anime",
                pinned.key,
                pinned.repo,
                pinned.revision,
                (_HfFile(pinned.remote_path, pinned.size_bytes, pinned.sha256),),
            )
        )
    for variant, entry in TAGGER_MODELS.items():
        if (
            not entry.get("repo_id")
            or not entry.get("model_file")
            or not entry.get("tags_file")
        ):
            continue
        if entry.get("official_download_only") or entry.get("captioner_only"):
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


def _snapshot_dirs(hub: Path, repo: str) -> Tuple[Path, List[Path]]:
    repo_dir = hub / ("models--" + repo.replace("/", "--"))
    snapshots = repo_dir / "snapshots"
    try:
        dirs = sorted((d for d in snapshots.iterdir() if d.is_dir()), reverse=True)
    except OSError:
        dirs = []
    return snapshots, dirs


def _match_hf_spec(ctx: _Context, spec: _HfSpec, report: MatchReport) -> None:
    snapshots, dirs = _snapshot_dirs(Path(ctx.root.path), spec.repo)
    if not dirs:
        return
    if spec.revision is None:
        for snapshot in dirs:
            for name in spec.any_of:
                stat = _stat_file(snapshot / name)
                if stat is not None:
                    report.matches.append(
                        ctx.match(
                            spec.model_id,
                            spec.variant,
                            snapshot / name,
                            stat,
                            VERIFY_NAME,
                        )
                    )
                    return
        return
    pinned = snapshots / spec.revision
    if not pinned.is_dir():
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
    notes: List[str] = []
    paths: List[Path] = []
    for item in spec.files:
        path = pinned / item.relpath
        stat = _stat_file(path)
        if stat is None:
            report.rejected.append(
                ctx.reject(
                    spec.model_id,
                    spec.variant,
                    pinned,
                    REASON_INCOMPLETE,
                    f"{item.relpath} is missing or empty in snapshot {spec.revision[:8]}",
                )
            )
            return
        reason, detail, file_notes = _verify_pinned_file(
            ctx, path, stat, item.size_bytes, item.sha256
        )
        if reason:
            report.rejected.append(
                ctx.reject(spec.model_id, spec.variant, path, reason, detail)
            )
            return
        notes.extend(file_notes)
        paths.append(path)
    primary = (
        paths[0]
        if len(spec.files) == 1 or spec.files[0].sha256 or spec.files[0].size_bytes
        else pinned
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
