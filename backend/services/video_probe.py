"""Read a video's facts and its generation recipe.

Facts (duration, size, codec, fps, audio) come from ``ffprobe`` JSON. The
recipe is read in this order:

1. container tags. ComfyUI's SaveVideo writes ``prompt`` and ``workflow``
   (WebM: upper-case ``PROMPT`` / ``WORKFLOW``), sometimes JSON-encoded twice;
   VideoHelperSuite's Video Combine writes one ``comment`` tag holding
   ``{"prompt": ..., "workflow": ...}``. A WebUI-style ``parameters`` text is
   read as well.
2. a companion picture with the same name in the same folder
   (``clip.mp4`` + ``clip.png``; ``clip-audio.mp4`` also pairs with
   ``clip.png``). Video Combine and the MiniMax H3 nodes save one.

The recipe goes through the same parser as pictures, so prompt, model and
LoRAs land in the same fields.
"""

from __future__ import annotations

import json
import logging
import os
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

from services import video_tools

logger = logging.getLogger(__name__)

PROBE_TIMEOUT_SECONDS = 30.0
_RECIPE_KEYS = ("prompt", "workflow", "parameters")
_AUDIO_SUFFIX = "-audio"
_JSON_DECODE_ROUNDS = 3


@dataclass(frozen=True)
class VideoInfo:
    duration: Optional[float]
    width: Optional[int]
    height: Optional[int]
    codec: Optional[str]
    fps: Optional[float]
    has_audio: bool
    format_name: str = ""
    tags: Dict[str, str] = field(default_factory=dict)


class VideoProbeError(RuntimeError):
    """ffprobe could not read the file (still being written, damaged, not a video)."""


def _ratio(text: Any) -> Optional[float]:
    try:
        num, _, den = str(text).partition("/")
        value = float(num) / float(den or 1)
    except (TypeError, ValueError, ZeroDivisionError):
        return None
    return round(value, 3) if value > 0 else None


def _float_or_none(value: Any) -> Optional[float]:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number > 0 else None


def _main_video_stream(streams: list) -> Optional[dict]:
    for stream in streams:
        if stream.get("codec_type") != "video":
            continue
        if (stream.get("disposition") or {}).get("attached_pic"):
            continue
        return stream
    return None


def info_from_probe_json(data: Dict[str, Any]) -> VideoInfo:
    """Turn ``ffprobe -show_format -show_streams`` JSON into VideoInfo."""
    streams = data.get("streams") or []
    fmt = data.get("format") or {}
    video = _main_video_stream(streams)
    if video is None:
        raise VideoProbeError("No video stream")
    duration = _float_or_none(fmt.get("duration")) or _float_or_none(
        video.get("duration")
    )
    tags: Dict[str, str] = {}
    for stream in streams:
        for key, value in (stream.get("tags") or {}).items():
            tags.setdefault(str(key).lower(), str(value))
    for key, value in (fmt.get("tags") or {}).items():
        tags[str(key).lower()] = str(value)
    return VideoInfo(
        duration=round(duration, 3) if duration else None,
        width=int(video["width"]) if video.get("width") else None,
        height=int(video["height"]) if video.get("height") else None,
        codec=str(video.get("codec_name") or "") or None,
        fps=_ratio(video.get("avg_frame_rate")) or _ratio(video.get("r_frame_rate")),
        has_audio=any(s.get("codec_type") == "audio" for s in streams),
        format_name=str(fmt.get("format_name") or ""),
        tags=tags,
    )


def probe(path: str) -> VideoInfo:
    """Run ffprobe on ``path``. Raises VideoToolsMissing / VideoProbeError."""
    tools = video_tools.require_tools()
    args = [
        tools.ffprobe,
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        path,
    ]
    try:
        result = video_tools.run_tool(args, timeout=PROBE_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired as exc:
        raise VideoProbeError("ffprobe timed out") from exc
    except OSError as exc:
        raise VideoProbeError(f"ffprobe could not start: {exc}") from exc
    if result.returncode != 0:
        reason = result.stderr.decode("utf-8", "replace").strip().splitlines()
        raise VideoProbeError(reason[-1][:300] if reason else "ffprobe failed")
    try:
        data = json.loads(result.stdout.decode("utf-8", "replace") or "{}")
    except json.JSONDecodeError as exc:
        raise VideoProbeError("ffprobe returned unreadable output") from exc
    info = info_from_probe_json(data)
    if not info.duration:
        raise VideoProbeError("No duration yet")
    return info


def _unwrap_json_text(value: Any) -> Any:
    """Decode a value that may be JSON text, or JSON text inside a JSON string."""
    current = value
    for _ in range(_JSON_DECODE_ROUNDS):
        if not isinstance(current, str):
            return current
        stripped = current.strip()
        if not stripped or stripped[0] not in '{["':
            return current
        try:
            current = json.loads(stripped)
        except (json.JSONDecodeError, ValueError):
            return current
    return current


def _as_chunk_text(value: Any) -> Optional[str]:
    decoded = _unwrap_json_text(value)
    if isinstance(decoded, (dict, list)):
        return json.dumps(decoded, ensure_ascii=False)
    if isinstance(decoded, str) and decoded.strip():
        return decoded
    return None


def chunks_from_tags(tags: Dict[str, str]) -> Dict[str, str]:
    """The ``prompt`` / ``workflow`` / ``parameters`` texts found in container tags."""
    lowered = {str(k).lower(): v for k, v in (tags or {}).items()}
    chunks: Dict[str, str] = {}
    comment = _unwrap_json_text(lowered.get("comment"))
    if isinstance(comment, dict):
        for key in _RECIPE_KEYS:
            text = _as_chunk_text(comment.get(key))
            if text:
                chunks[key] = text
    elif isinstance(comment, str) and "Steps:" in comment and "Sampler:" in comment:
        chunks["parameters"] = comment
    for key in _RECIPE_KEYS:
        text = _as_chunk_text(lowered.get(key))
        if text:
            chunks[key] = text
    return chunks


def companion_picture(video_path: str) -> Optional[Path]:
    """The same-name PNG beside the video, if there is one."""
    video = Path(video_path)
    stems = [video.stem]
    if video.stem.lower().endswith(_AUDIO_SUFFIX):
        stems.append(video.stem[: -len(_AUDIO_SUFFIX)])
    for stem in stems:
        for suffix in (".png", ".PNG"):
            candidate = video.with_name(stem + suffix)
            if candidate.is_file():
                return candidate
    return None


def _has_recipe(parsed: Dict[str, Any]) -> bool:
    return parsed.get("generator") not in (None, "", "unknown") or bool(
        parsed.get("prompt")
    )


def _parse_chunks(chunks: Dict[str, str], path: str) -> Dict[str, Any]:
    from metadata_parser import get_parser

    parser = get_parser()
    return parser._detect_and_parse(dict(chunks), image_path=path, file_size=0)


def _result_from_parsed(
    parsed: Dict[str, Any], chunks: Dict[str, Any]
) -> Dict[str, Any]:
    from metadata_parser import PARSED_METADATA_VERSION, join_character_prompt_text

    character_prompts = parsed.get("character_prompts")
    metadata = dict(chunks)
    metadata["_parsed"] = {
        "version": PARSED_METADATA_VERSION,
        "generation_params": parsed.get("generation_params"),
        "is_img2img": parsed.get("is_img2img", False),
        "img2img_info": parsed.get("img2img_info"),
        "character_prompts": character_prompts,
        "character_prompt_text": join_character_prompt_text(character_prompts),
        "prompt_nodes": parsed.get("prompt_nodes"),
        "model_assets": parsed.get("model_assets"),
        "civitai_resources": parsed.get("civitai_resources"),
    }
    return {
        "generator": parsed.get("generator") or "unknown",
        "prompt": parsed.get("prompt"),
        "negative_prompt": parsed.get("negative_prompt"),
        "checkpoint": parsed.get("checkpoint"),
        "loras": parsed.get("loras") or [],
        "metadata": metadata,
    }


def _empty_recipe() -> Dict[str, Any]:
    return {
        "generator": "unknown",
        "prompt": None,
        "negative_prompt": None,
        "checkpoint": None,
        "loras": [],
        "metadata": {},
    }


def recipe_for(
    video_path: str, info: Optional[VideoInfo]
) -> Tuple[Dict[str, Any], Optional[str]]:
    """Parsed recipe and where it came from: 'container', 'companion' or None."""
    chunks = chunks_from_tags(info.tags) if info else {}
    if chunks:
        parsed = _parse_chunks(chunks, video_path)
        if _has_recipe(parsed):
            result = _result_from_parsed(parsed, chunks)
            result["metadata"]["_parsed"]["video_recipe"] = {"source": "container"}
            return result, "container"
    companion = companion_picture(video_path)
    if companion is not None:
        companion_chunks = companion_chunks_for(companion)
        if companion_chunks:
            parsed = _parse_chunks(companion_chunks, str(companion))
            if _has_recipe(parsed):
                result = _result_from_parsed(parsed, companion_chunks)
                result["metadata"]["_parsed"]["video_recipe"] = {
                    "source": "companion",
                    "file": companion.name,
                }
                return result, "companion"
    return _empty_recipe(), None


def companion_chunks_for(picture: Path) -> Dict[str, Any]:
    """Metadata chunks of a companion picture (prompt/workflow/parameters ...)."""
    from metadata_parser import get_parser

    parser = get_parser()
    try:
        loaded = parser._load_image_metadata(str(picture))
    except Exception as exc:  # a damaged companion must not stop the video
        logger.debug("Companion picture %s unreadable: %s", picture, exc)
        return {}
    chunks = loaded.get("metadata") if isinstance(loaded, dict) else None
    if not isinstance(chunks, dict):
        return {}
    promoted = parser._promote_carrier_payloads(chunks)
    return {k: v for k, v in promoted.items() if isinstance(v, str)}


def recipe_chunks(video_path: str) -> Dict[str, Any]:
    """Raw recipe chunks for "Send to generator": container tags, else the companion."""
    try:
        info = probe(video_path)
    except (video_tools.VideoToolsMissing, VideoProbeError):
        info = None
    chunks = chunks_from_tags(info.tags) if info else {}
    if chunks:
        return chunks
    companion = companion_picture(video_path)
    return companion_chunks_for(companion) if companion else {}


def file_is_quiet(path: str, quiet_seconds: float, now: float) -> bool:
    """True when the file has not changed for ``quiet_seconds``."""
    try:
        return now - os.stat(path).st_mtime >= quiet_seconds
    except OSError:
        return False
