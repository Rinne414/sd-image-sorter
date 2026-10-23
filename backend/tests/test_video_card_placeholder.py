"""A video card shows the play-mark tile until its frame arrives, never black.

ffmpeg grabs each video's frame on first request (about 2 s for a burst), and
the "Videos only" filter showed black cards meanwhile. The card now carries the
same tile the server sends when no frame can be read (dark, amber ring and
play mark, services/video_preview.py video_placeholder_thumbnail) as its
background; the thumbnail covers it once loaded. Checked in a browser with the
thumbnails held back on 2026-10-23.
"""

from __future__ import annotations

import re
from pathlib import Path

VIDEO_CSS = Path(__file__).resolve().parents[2] / "frontend" / "css" / "video.css"


def test_video_cards_have_the_play_mark_tile_behind_the_thumbnail():
    css = VIDEO_CSS.read_text(encoding="utf-8")
    match = re.search(
        r"\.gallery-item\.is-video,\s*\.gallery-item\.is-video \.gallery-item-media\s*\{([^}]*)\}",
        css,
    )
    assert match, "video card placeholder rule missing"
    body = match.group(1)
    assert "#18181a" in body  # the server tile's background (24, 24, 26)
    assert (
        "data:image/svg+xml" in body and "%23c8873c" in body
    )  # its play mark (200, 135, 60)
