"""Videos in the library (S5).

Covers: the media_type column (migration 065), scanning mixed folders,
reading ComfyUI recipes from container tags (SaveVideo, WebM upper-case and
VideoHelperSuite ``comment``) and from a companion PNG, ffprobe facts, the
background indexer, thumbnails with and without ffmpeg, HTTP Range on the
file endpoint, converted previews, and the ffmpeg installer's checksum gate.

Tests that need real ffmpeg/ffprobe make tiny clips with ffmpeg's built-in
test source and are skipped (with the reason) when ffmpeg is not installed.
"""

from __future__ import annotations

import hashlib
import io
import json
import shutil
import sqlite3
import subprocess
import time
import zipfile
from pathlib import Path

import pytest
from PIL import Image
from PIL.PngImagePlugin import PngInfo

import database as db
import db_videos
from image_manager import scan_folder
from services import (
    ffmpeg_install,
    video_index,
    video_preview,
    video_probe,
    video_tools,
)

HAS_FFMPEG = bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))
needs_ffmpeg = pytest.mark.skipif(
    not HAS_FFMPEG, reason="ffmpeg/ffprobe are not on PATH on this machine"
)

API_PROMPT = {
    "4": {
        "class_type": "CheckpointLoaderSimple",
        "inputs": {"ckpt_name": "wan_t2v.safetensors"},
    },
    "10": {
        "class_type": "LoraLoader",
        "inputs": {
            "lora_name": "motion_lora.safetensors",
            "strength_model": 1.0,
            "strength_clip": 1.0,
            "model": ["4", 0],
            "clip": ["4", 1],
        },
    },
    "6": {
        "class_type": "CLIPTextEncode",
        "inputs": {"text": "a fox running in snow", "clip": ["10", 1]},
    },
    "7": {
        "class_type": "CLIPTextEncode",
        "inputs": {"text": "blurry", "clip": ["10", 1]},
    },
    "3": {
        "class_type": "KSampler",
        "inputs": {
            "seed": 7,
            "steps": 4,
            "cfg": 1.0,
            "sampler_name": "euler",
            "scheduler": "simple",
            "denoise": 1.0,
            "model": ["10", 0],
            "positive": ["6", 0],
            "negative": ["7", 0],
            "latent_image": ["5", 0],
        },
    },
    "5": {
        "class_type": "EmptyLatentImage",
        "inputs": {"width": 64, "height": 64, "batch_size": 1},
    },
}
WORKFLOW = {"id": "wf", "nodes": [{"id": 6, "type": "CLIPTextEncode"}], "links": []}


def _ffmpeg(*args: str) -> None:
    subprocess.run(
        ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", *args],
        check=True,
        stdin=subprocess.DEVNULL,
        timeout=120,
    )


def _clip(path: Path, *extra: str, codec: tuple = ("-c:v", "mpeg4")) -> Path:
    """A one-second 64x48 clip (mpeg4 needs no optional encoder)."""
    _ffmpeg(
        "-f",
        "lavfi",
        "-i",
        "testsrc=size=64x48:rate=12",
        "-t",
        "1",
        *codec,
        *extra,
        str(path),
    )
    return path


def _a1111_png(path: Path) -> Path:
    info = PngInfo()
    info.add_text(
        "parameters",
        "1girl, beach\nNegative prompt: lowres\n"
        "Steps: 20, Sampler: Euler a, CFG scale: 7, Seed: 1, Size: 64x64, Model: animagine",
    )
    Image.new("RGB", (64, 64), (10, 20, 30)).save(path, pnginfo=info)
    return path


@pytest.fixture
def isolated_video_dirs(tmp_path, monkeypatch):
    import thumbnail_cache

    thumbs = tmp_path / "thumbs"
    tools = tmp_path / "tools"
    thumbs.mkdir()
    tools.mkdir()
    monkeypatch.setattr(thumbnail_cache, "CACHE_DIR", thumbs)
    monkeypatch.setattr(video_preview, "get_thumbnail_cache_dir", lambda: str(thumbs))
    monkeypatch.setattr(video_tools, "get_tools_dir", lambda: str(tools))
    monkeypatch.setattr(ffmpeg_install, "get_tools_dir", lambda: str(tools))
    video_tools.forget_tools()
    yield {"thumbs": thumbs, "tools": tools}
    video_tools.forget_tools()


# ---------- container tags and companion pictures (no ffmpeg needed) ----------


def test_savevideo_tags_become_prompt_and_workflow_chunks():
    tags = {
        "prompt": json.dumps(API_PROMPT),
        "workflow": json.dumps(WORKFLOW),
        "encoder": "Lavf",
    }
    chunks = video_probe.chunks_from_tags(tags)
    assert json.loads(chunks["prompt"]) == API_PROMPT
    assert json.loads(chunks["workflow"]) == WORKFLOW


def test_webm_upper_case_and_double_encoded_prompt_is_unwrapped():
    tags = {
        "PROMPT": json.dumps(json.dumps(API_PROMPT)),
        "WORKFLOW": json.dumps(WORKFLOW),
    }
    chunks = video_probe.chunks_from_tags(tags)
    assert json.loads(chunks["prompt"]) == API_PROMPT


def test_videohelpersuite_comment_holds_prompt_and_workflow():
    comment = json.dumps({"prompt": json.dumps(API_PROMPT), "workflow": WORKFLOW})
    chunks = video_probe.chunks_from_tags({"comment": comment})
    assert json.loads(chunks["prompt"]) == API_PROMPT
    assert json.loads(chunks["workflow"]) == WORKFLOW


def test_a_plain_comment_is_not_a_recipe():
    assert video_probe.chunks_from_tags({"comment": "made with love"}) == {}


def test_container_recipe_is_parsed_like_a_picture(tmp_path):
    info = video_probe.VideoInfo(
        duration=1.0,
        width=64,
        height=48,
        codec="h264",
        fps=12.0,
        has_audio=False,
        tags={"prompt": json.dumps(API_PROMPT)},
    )
    recipe, source = video_probe.recipe_for(str(tmp_path / "fox.mp4"), info)
    assert source == "container"
    assert recipe["generator"] == "comfyui"
    assert "fox running" in recipe["prompt"]
    assert recipe["checkpoint"] == "wan_t2v.safetensors"
    assert "motion_lora.safetensors" in recipe["loras"]
    assert recipe["metadata"]["_parsed"]["video_recipe"] == {"source": "container"}


def test_companion_png_pairs_by_stem_and_audio_suffix(tmp_path):
    png = _a1111_png(tmp_path / "clip_00001.png")
    (tmp_path / "clip_00001.mp4").write_bytes(b"x")
    (tmp_path / "clip_00001-audio.mp4").write_bytes(b"x")
    assert video_probe.companion_picture(str(tmp_path / "clip_00001.mp4")) == png
    assert video_probe.companion_picture(str(tmp_path / "clip_00001-audio.mp4")) == png
    assert video_probe.companion_picture(str(tmp_path / "other.mp4")) is None


def test_recipe_falls_back_to_the_companion_png(tmp_path):
    _a1111_png(tmp_path / "girl.png")
    recipe, source = video_probe.recipe_for(str(tmp_path / "girl.mp4"), None)
    assert source == "companion"
    assert recipe["generator"] in {"webui", "forge"}
    assert recipe["prompt"].startswith("1girl")
    assert recipe["metadata"]["_parsed"]["video_recipe"] == {
        "source": "companion",
        "file": "girl.png",
    }


def test_probe_json_facts_skip_cover_art_and_read_fps():
    data = {
        "streams": [
            {
                "codec_type": "video",
                "codec_name": "mjpeg",
                "disposition": {"attached_pic": 1},
            },
            {
                "codec_type": "video",
                "codec_name": "h264",
                "width": 480,
                "height": 320,
                "avg_frame_rate": "30000/1001",
                "tags": {"handler_name": "x"},
            },
            {"codec_type": "audio", "codec_name": "aac"},
        ],
        "format": {
            "duration": "4.04",
            "format_name": "mov,mp4",
            "tags": {"prompt": "{}"},
        },
    }
    info = video_probe.info_from_probe_json(data)
    assert (info.codec, info.width, info.height) == ("h264", 480, 320)
    assert info.fps == pytest.approx(29.97, abs=0.01)
    assert info.has_audio is True
    assert info.duration == pytest.approx(4.04)
    assert info.tags["prompt"] == "{}"


def test_probe_json_without_video_stream_is_an_error():
    with pytest.raises(video_probe.VideoProbeError):
        video_probe.info_from_probe_json(
            {"streams": [{"codec_type": "audio"}], "format": {}}
        )


def test_browser_playability_guess():
    assert video_preview.plays_in_browser("h264", "mov,mp4,m4a")
    assert video_preview.plays_in_browser("vp9", "matroska,webm")
    assert not video_preview.plays_in_browser("prores", "mov,mp4,m4a")
    assert video_preview.plays_in_browser(None)


# ---------- migration and scanning ----------


def test_migration_065_derives_media_type_from_the_path(test_db):
    with db.get_db() as conn:
        columns = {row[1] for row in conn.execute("PRAGMA table_xinfo(images)")}
        assert {
            "media_type",
            "duration_seconds",
            "video_codec",
            "video_fps",
            "video_has_audio",
            "video_probe_state",
            "video_probe_error",
        } <= columns
        for name in ("a.png", "b.MP4", "c.webm", "d.mov", "e.mkv", "f.m4v", "g.gif"):
            conn.execute(
                "INSERT INTO images (path, filename) VALUES (?, ?)",
                (f"C:/x/{name}", name),
            )
        rows = dict(conn.execute("SELECT filename, media_type FROM images").fetchall())
    assert rows == {
        "a.png": "image",
        "b.MP4": "video",
        "c.webm": "video",
        "d.mov": "video",
        "e.mkv": "video",
        "f.m4v": "video",
        "g.gif": "image",
    }


def test_migration_065_is_idempotent(test_db):
    from migrations import get_migrations

    migration = next(m for m in get_migrations() if m.version == 65)
    conn = sqlite3.connect(str(db.DATABASE_PATH))
    try:
        migration.apply(conn)
        migration.apply(conn)
    finally:
        conn.close()


def test_scan_lists_videos_next_to_pictures_without_waiting(
    test_db, tmp_path, monkeypatch
):
    kicks = []
    monkeypatch.setattr(video_index.VideoIndexer, "kick", lambda self: kicks.append(1))
    Image.new("RGB", (8, 8)).save(tmp_path / "pic.png")
    (tmp_path / "clip.mp4").write_bytes(b"\x00" * 64)
    (tmp_path / "notes.txt").write_text("no", encoding="utf-8")

    result = scan_folder(str(tmp_path), quick_import=True, precise_total=False)

    assert result["new"] == 2
    with db.get_db() as conn:
        rows = {
            r[0]: (r[1], r[2], r[3])
            for r in conn.execute(
                "SELECT filename, media_type, video_probe_state, file_size FROM images"
            )
        }
    assert rows["pic.png"][:2] == ("image", None)
    assert rows["clip.mp4"] == ("video", "pending", 64)
    assert kicks, "the scan wakes the video indexer"
    assert db_videos.pending_videos(10)[0]["path"].endswith("clip.mp4")


def test_unchanged_video_is_not_queued_again(test_db, tmp_path, monkeypatch):
    monkeypatch.setattr(video_index.VideoIndexer, "kick", lambda self: None)
    (tmp_path / "clip.mp4").write_bytes(b"\x00" * 64)
    scan_folder(str(tmp_path), quick_import=True, precise_total=False)
    row_id = db_videos.pending_videos(10)[0]["id"]
    db_videos.save_video_facts(
        row_id, state=db_videos.READY, duration=1.0, codec="h264"
    )

    result = scan_folder(str(tmp_path), quick_import=True, precise_total=False)

    assert result["unchanged"] == 1
    assert db_videos.get_video_row(row_id)["video_probe_state"] == db_videos.READY


def test_pipelines_that_read_pixels_skip_videos(test_db, tmp_path, monkeypatch):
    monkeypatch.setattr(video_index.VideoIndexer, "kick", lambda self: None)
    Image.new("RGB", (8, 8)).save(tmp_path / "pic.png")
    (tmp_path / "clip.mp4").write_bytes(b"\x00" * 64)
    scan_folder(str(tmp_path), quick_import=True, precise_total=False)

    untagged = {Path(r["path"]).name for r in db.get_untagged_images(10)}
    colors = {Path(r["path"]).name for r in db.get_images_missing_color_data(10)}
    assert untagged == {"pic.png"}
    assert colors == {"pic.png"}
    assert db.count_untagged_image_ids() == 1


# ---------- real ffmpeg: probing, indexing, thumbnails, previews ----------


@needs_ffmpeg
def test_indexer_reads_a_tagged_mp4(
    test_db, tmp_path, isolated_video_dirs, monkeypatch
):
    monkeypatch.setattr(video_index.VideoIndexer, "kick", lambda self: None)
    _clip(
        tmp_path / "fox.mp4",
        "-movflags",
        "use_metadata_tags",
        "-metadata",
        "prompt=" + json.dumps(API_PROMPT),
        "-metadata",
        "workflow=" + json.dumps(WORKFLOW),
    )
    scan_folder(str(tmp_path), quick_import=True, precise_total=False)
    row = db_videos.pending_videos(10)[0]

    state = video_index.index_one(row["id"], row["path"], now=time.time() + 3600)

    assert state == db_videos.READY
    image = db.get_image_by_id(row["id"])
    assert image["generator"] == "comfyui"
    assert "fox running" in image["prompt"]
    assert image["checkpoint"] == "wan_t2v.safetensors"
    assert (image["width"], image["height"]) == (64, 48)
    assert image["duration_seconds"] == pytest.approx(1.0, abs=0.1)
    assert image["video_codec"] == "mpeg4"
    assert image["video_fps"] == pytest.approx(12.0)


@needs_ffmpeg
def test_a_file_still_being_written_is_retried_not_dropped(
    test_db, tmp_path, monkeypatch
):
    monkeypatch.setattr(video_index.VideoIndexer, "kick", lambda self: None)
    (tmp_path / "half.mp4").write_bytes(b"\x00\x00\x00\x18ftypisom" + b"\x00" * 32)
    scan_folder(str(tmp_path), quick_import=True, precise_total=False)
    row = db_videos.pending_videos(10)[0]

    assert video_index.index_one(row["id"], row["path"]) == "retry"
    assert db_videos.get_video_row(row["id"])["video_probe_state"] == db_videos.PENDING
    later = time.time() + video_index.STILL_WRITING_SECONDS + 5
    assert (
        video_index.index_one(row["id"], row["path"], now=later) == db_videos.UNREADABLE
    )
    assert db_videos.get_video_row(row["id"])["video_probe_error"]


@needs_ffmpeg
def test_recipe_for_send_to_generator_comes_from_the_video(tmp_path):
    from services.generator_recipe import _chunks_from_file

    path = _clip(
        tmp_path / "fox.mp4",
        "-movflags",
        "use_metadata_tags",
        "-metadata",
        "prompt=" + json.dumps(API_PROMPT),
    )
    chunks = _chunks_from_file(str(path))
    assert json.loads(chunks["prompt"]) == API_PROMPT


@needs_ffmpeg
def test_video_thumbnail_is_a_real_frame(
    test_db, test_client, tmp_path, isolated_video_dirs, monkeypatch
):
    monkeypatch.setattr(video_index.VideoIndexer, "kick", lambda self: None)
    _clip(tmp_path / "clip.mp4")
    scan_folder(str(tmp_path), quick_import=True, precise_total=False)
    image_id = db_videos.pending_videos(10)[0]["id"]

    response = test_client.get(f"/api/image-thumbnail/{image_id}?size=256")

    assert response.status_code == 200
    assert "X-Thumbnail-Placeholder" not in response.headers
    frame = Image.open(io.BytesIO(response.content))
    assert frame.size == (256, 192)


@pytest.mark.parametrize(
    "tag, can_install",
    [("win64", True), ("linux64", True), (None, False)],
)
def test_video_thumbnail_without_ffmpeg_is_a_labelled_placeholder(
    test_db, test_client, tmp_path, isolated_video_dirs, monkeypatch, tag, can_install
):
    """Where a build exists (Windows, Linux) the size is offered; on a system
    without one (macOS) the page asks for a package-manager ffmpeg instead."""
    monkeypatch.setattr(video_index.VideoIndexer, "kick", lambda self: None)
    monkeypatch.setattr(video_tools, "_discover", lambda: None)
    monkeypatch.setattr(ffmpeg_install, "platform_tag", lambda: tag)
    video_tools.forget_tools()
    (tmp_path / "clip.mp4").write_bytes(b"\x00" * 64)
    scan_folder(str(tmp_path), quick_import=True, precise_total=False)
    image_id = db_videos.pending_videos(10)[0]["id"]

    response = test_client.get(f"/api/image-thumbnail/{image_id}?size=256")
    status = test_client.get("/api/video-support").json()

    assert response.status_code == 200
    assert response.headers["X-Thumbnail-Placeholder"] == "VIDEO_TOOLS_MISSING"
    assert status["available"] is False
    assert status["videos"] == 1 and status["pending"] == 1
    assert status["can_install"] is can_install
    assert bool(status["estimated_mb"]) is can_install


def test_video_file_supports_http_range(test_db, test_client, tmp_path, monkeypatch):
    monkeypatch.setattr(video_index.VideoIndexer, "kick", lambda self: None)
    payload = bytes(range(256)) * 8
    (tmp_path / "clip.mp4").write_bytes(payload)
    scan_folder(str(tmp_path), quick_import=True, precise_total=False)
    image_id = db_videos.pending_videos(10)[0]["id"]

    whole = test_client.get(f"/api/image-file/{image_id}")
    part = test_client.get(
        f"/api/image-file/{image_id}", headers={"Range": "bytes=100-199"}
    )

    assert whole.headers["content-type"] == "video/mp4"
    assert whole.headers.get("accept-ranges") == "bytes"
    assert part.status_code == 206
    assert part.content == payload[100:200]
    assert part.headers["content-range"] == f"bytes 100-199/{len(payload)}"


@needs_ffmpeg
def test_prores_gets_a_converted_vp9_preview(
    test_db, test_client, tmp_path, isolated_video_dirs, monkeypatch
):
    if "libvpx-vp9" not in video_tools.list_encoders(
        video_tools.find_tools(refresh=True)
    ):
        pytest.skip("this ffmpeg has no libvpx-vp9 encoder")
    if "prores_ks" not in video_tools.list_encoders(video_tools.find_tools()):
        pytest.skip("this ffmpeg has no ProRes encoder to make the test clip")
    monkeypatch.setattr(video_index.VideoIndexer, "kick", lambda self: None)
    _clip(tmp_path / "bars.mov", codec=("-c:v", "prores_ks"))
    scan_folder(str(tmp_path), quick_import=True, precise_total=False)
    row = db_videos.pending_videos(10)[0]
    video_index.index_one(row["id"], row["path"], now=time.time() + 3600)

    info = test_client.get(f"/api/videos/{row['id']}/playback").json()
    assert info["codec"] == "prores" and info["plays_in_browser"] is False
    test_client.post(f"/api/videos/{row['id']}/converted")
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        state = test_client.get(f"/api/videos/{row['id']}/playback").json()["converted"]
        if state["status"] in {"done", "failed"}:
            break
        time.sleep(0.3)
    assert state["status"] == "done", state
    preview = test_client.get(
        f"/api/videos/{row['id']}/converted", headers={"Range": "bytes=0-3"}
    )
    assert preview.status_code == 206
    assert preview.content == b"\x1a\x45\xdf\xa3"  # EBML (WebM) header
    assert (
        Path(row["path"]).read_bytes()[:4] != b"\x1a\x45\xdf\xa3"
    )  # original untouched


# ---------- ffmpeg installer ----------


def test_installer_picks_the_newest_numbered_lgpl_build():
    names = [
        "ffmpeg-master-latest-win64-lgpl-shared.zip",
        "ffmpeg-n8.1-latest-win64-lgpl-shared-8.1.zip",
        "ffmpeg-n9.0-latest-win64-lgpl-shared-9.0.zip",
        "ffmpeg-n9.0-latest-win64-gpl-shared-9.0.zip",
        "ffmpeg-n9.0-latest-linux64-lgpl-shared-9.0.tar.xz",
    ]
    asset = ffmpeg_install.pick_asset([{"name": n} for n in names], "win64")
    assert asset["name"] == "ffmpeg-n9.0-latest-win64-lgpl-shared-9.0.zip"
    linux = ffmpeg_install.pick_asset([{"name": n} for n in names], "linux64")
    assert linux["name"].endswith("linux64-lgpl-shared-9.0.tar.xz")


def test_expected_sha256_reads_the_checksums_file():
    text = "abc123  ffmpeg-a.zip\nDEF456 *ffmpeg-b.zip\n"
    assert ffmpeg_install.expected_sha256(text, "ffmpeg-b.zip") == "def456"
    assert ffmpeg_install.expected_sha256(text, "missing.zip") is None


def _fake_release(tmp_path: Path, monkeypatch, *, corrupt: bool) -> None:
    tag = ffmpeg_install.platform_tag()
    exe = ".exe" if tag.startswith("win") else ""
    name = f"ffmpeg-n9.0-latest-{tag}-lgpl-shared-9.0.zip"
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as bundle:
        bundle.writestr(f"ffmpeg-n9.0/bin/ffmpeg{exe}", b"ff")
        bundle.writestr(f"ffmpeg-n9.0/bin/ffprobe{exe}", b"fp")
        bundle.writestr("ffmpeg-n9.0/LICENSE.txt", b"LGPL")
    archive = buffer.getvalue()
    digest = hashlib.sha256(archive + (b"!" if corrupt else b"")).hexdigest()
    files = {
        ffmpeg_install.RELEASE_API: json.dumps(
            {
                "assets": [
                    {
                        "name": name,
                        "size": len(archive),
                        "browser_download_url": "https://x/a",
                    },
                    {"name": "checksums.sha256", "browser_download_url": "https://x/c"},
                ]
            }
        ).encode(),
        "https://x/a": archive,
        "https://x/c": f"{digest}  {name}\n".encode(),
    }
    monkeypatch.setattr(ffmpeg_install, "_open", lambda url: io.BytesIO(files[url]))


def test_installer_unpacks_a_verified_build(tmp_path, isolated_video_dirs, monkeypatch):
    if ffmpeg_install.platform_tag() is None:
        pytest.skip("no ffmpeg build for this platform")
    _fake_release(tmp_path, monkeypatch, corrupt=False)
    monkeypatch.setattr(video_index.VideoIndexer, "kick", lambda self: None)

    installer = ffmpeg_install.FfmpegInstaller()
    installer._run(ffmpeg_install.platform_tag())

    assert installer.status()["state"] == "done", installer.status()
    tools = video_tools.find_tools(refresh=True)
    assert tools is not None and tools.source == "installed"
    assert (isolated_video_dirs["tools"] / "ffmpeg" / "LICENSE.txt").is_file()
    assert not (isolated_video_dirs["tools"] / "ffmpeg-download").exists()


def test_installer_refuses_a_checksum_mismatch(
    tmp_path, isolated_video_dirs, monkeypatch
):
    if ffmpeg_install.platform_tag() is None:
        pytest.skip("no ffmpeg build for this platform")
    _fake_release(tmp_path, monkeypatch, corrupt=True)

    installer = ffmpeg_install.FfmpegInstaller()
    installer._run(ffmpeg_install.platform_tag())

    status = installer.status()
    assert status["state"] == "failed"
    assert "SHA256" in status["error"]
    assert status["error_code"] == "video_install_checksum_mismatch"
    assert not (isolated_video_dirs["tools"] / "ffmpeg").exists()


# ---------- folder watching waits for a finished video ----------


@needs_ffmpeg
def test_watcher_waits_until_ffprobe_reads_the_video(tmp_path):
    from services.folder_watch import FolderWatchService, _Pending

    video_tools.forget_tools()
    half = tmp_path / "rendering.mp4"
    half.write_bytes(b"\x00\x00\x00\x18ftypisom" + b"\x00" * 64)
    done = _clip(tmp_path / "done.mp4")
    service = FolderWatchService(list_roots=lambda: [], stable_seconds=0.01)
    pending = {}
    for path in (half, done):
        info = path.stat()
        pending[str(path)] = _Pending(
            size=info.st_size,
            mtime_ns=info.st_mtime_ns,
            seen_at=time.monotonic() - 0.05,
        )

    ready = service._take_ready(pending)

    assert ready == [str(done)]
    assert str(half) in pending, "a video ffprobe cannot read yet keeps waiting"
