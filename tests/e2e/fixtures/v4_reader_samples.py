"""Sample images for the V4 Reader, one per metadata format.

    python v4_reader_samples.py --images <dir>
        Write the four samples (ComfyUI PNG, A1111 PNG, NovelAI multi-character
        PNG, A1111 WebP) into <dir>. The Reader E2E drops these.

    python v4_reader_samples.py --json <file>
        Write the samples to a temporary folder, read each one the two ways the
        Reader gets an image, and save both answers as JSON: what
        POST /api/parse-image returns for an upload, and the library row a scan
        stores for the same file (GET /api/images/{id}). The Reader's adapter
        test checks that both give the same generation details.

Run with the backend's Python from the repository root.
"""

from __future__ import annotations

import argparse
import json
import os
import struct
import sys
import tempfile
from pathlib import Path

from PIL import Image
from PIL.PngImagePlugin import PngInfo

BACKEND = Path(__file__).resolve().parents[3] / "backend"

COMFY_PROMPT = {
    "4": {
        "class_type": "CheckpointLoaderSimple",
        "inputs": {"ckpt_name": "v4reader_comfy_model.safetensors"},
    },
    "10": {
        "class_type": "LoraLoader",
        "inputs": {
            "lora_name": "v4reader_style_lora.safetensors",
            "strength_model": 0.8,
            "strength_clip": 0.6,
            "model": ["4", 0],
            "clip": ["4", 1],
        },
    },
    "6": {
        "class_type": "CLIPTextEncode",
        "inputs": {
            "text": "1girl, (silver hair:1.2), v4reader comfy prompt",
            "clip": ["10", 1],
        },
    },
    "7": {
        "class_type": "CLIPTextEncode",
        "inputs": {"text": "lowres, v4reader comfy negative", "clip": ["10", 1]},
    },
    "5": {
        "class_type": "EmptyLatentImage",
        "inputs": {"width": 96, "height": 64, "batch_size": 1},
    },
    "3": {
        "class_type": "KSampler",
        "inputs": {
            "seed": 20260926,
            "steps": 24,
            "cfg": 6.5,
            "sampler_name": "euler",
            "scheduler": "karras",
            "denoise": 1.0,
            "model": ["10", 0],
            "positive": ["6", 0],
            "negative": ["7", 0],
            "latent_image": ["5", 0],
        },
    },
    "8": {"class_type": "VAEDecode", "inputs": {"samples": ["3", 0], "vae": ["4", 2]}},
    "9": {
        "class_type": "SaveImage",
        "inputs": {"images": ["8", 0], "filename_prefix": "v4reader"},
    },
}

A1111_PARAMETERS = (
    "masterpiece, 1girl, <lora:v4reader_detail:0.7>, (blue eyes:1.1), v4reader webui prompt\n"
    "Negative prompt: lowres, bad hands\n"
    "Steps: 28, Sampler: DPM++ 2M, Schedule type: Karras, CFG scale: 7, Seed: 123456789, "
    "Size: 96x64, Model hash: 0a1b2c3d4e, Model: v4reader_webui_model, "
    'Lora hashes: "v4reader_detail: 9f8e7d6c5b4a", Clip skip: 2, Version: v1.10.1'
)

NAI_COMMENT = {
    "prompt": "2girls, outdoors, v4reader nai prompt",
    "steps": 28,
    "height": 64,
    "width": 96,
    "scale": 5.0,
    "seed": 424242,
    "sampler": "k_euler_ancestral",
    "noise_schedule": "karras",
    "uc": "lowres, bad anatomy",
    "v4_prompt": {
        "caption": {
            "base_caption": "2girls, outdoors, v4reader nai prompt",
            "char_captions": [
                {
                    "char_caption": "girl, red hair, smile",
                    "centers": [{"x": 0.3, "y": 0.5}],
                },
                {
                    "char_caption": "girl, blue hair, wave",
                    "centers": [{"x": 0.7, "y": 0.5}],
                },
            ],
        },
        "use_coords": True,
        "use_order": True,
    },
    "v4_negative_prompt": {
        "caption": {
            "base_caption": "lowres, bad anatomy",
            "char_captions": [
                {"char_caption": "bad hands", "centers": [{"x": 0.3, "y": 0.5}]},
                {"char_caption": "extra fingers", "centers": [{"x": 0.7, "y": 0.5}]},
            ],
        },
    },
}

WEBP_PARAMETERS = (
    "1girl, cherry blossoms, v4reader webp prompt\n"
    "Negative prompt: worst quality\n"
    "Steps: 20, Sampler: Euler a, CFG scale: 5, Seed: 777, Size: 96x64, Model: v4reader_webp_model"
)


def _exif_user_comment(comment: str) -> bytes:
    """A TIFF block whose Exif IFD holds one UserComment (UNICODE), the way A1111 writes WebP."""
    comment_bytes = b"UNICODE\x00" + comment.encode("utf-16-le")
    tiff_header = b"II" + struct.pack("<H", 42) + struct.pack("<I", 8)
    exif_ifd_offset = 8 + 2 + 12 + 4
    ifd0 = (
        struct.pack("<H", 1)
        + struct.pack("<HHI", 0x8769, 4, 1)
        + struct.pack("<I", exif_ifd_offset)
        + struct.pack("<I", 0)
    )
    user_comment_offset = exif_ifd_offset + 2 + 12 + 4
    exif_ifd = (
        struct.pack("<H", 1)
        + struct.pack("<HHI", 0x9286, 7, len(comment_bytes))
        + struct.pack("<I", user_comment_offset)
        + struct.pack("<I", 0)
        + comment_bytes
    )
    return tiff_header + ifd0 + exif_ifd


def _picture(seed: int) -> Image.Image:
    img = Image.new("RGB", (96, 64))
    img.putdata(
        [
            ((x * 3 + seed) % 256, (y * 4 + seed * 2) % 256, (x + y + seed * 5) % 256)
            for y in range(64)
            for x in range(96)
        ]
    )
    return img


def write_samples(folder: Path) -> dict[str, Path]:
    folder.mkdir(parents=True, exist_ok=True)
    out = {
        "comfyui": folder / "v4reader-comfyui.png",
        "a1111": folder / "v4reader-a1111.png",
        "nai": folder / "v4reader-nai.png",
        "webp": folder / "v4reader-webp.webp",
    }

    info = PngInfo()
    info.add_text("prompt", json.dumps(COMFY_PROMPT))
    info.add_text("workflow", json.dumps({"nodes": [], "links": [], "version": 0.4}))
    _picture(10).save(out["comfyui"], pnginfo=info)

    info = PngInfo()
    info.add_text("parameters", A1111_PARAMETERS)
    _picture(60).save(out["a1111"], pnginfo=info)

    info = PngInfo()
    info.add_text("Title", "NovelAI generated image")
    info.add_text("Description", NAI_COMMENT["prompt"])
    info.add_text("Software", "NovelAI")
    info.add_text("Source", "NovelAI Diffusion V4.5 4BDE2A90")
    info.add_text("Comment", json.dumps(NAI_COMMENT))
    _picture(120).save(out["nai"], pnginfo=info)

    _picture(180).save(
        out["webp"], "WEBP", quality=95, exif=_exif_user_comment(WEBP_PARAMETERS)
    )
    return out


# The ImageDetail fields the V4 card and Reader read.
DETAIL_FIELDS = (
    "filename",
    "generator",
    "prompt",
    "negative_prompt",
    "metadata_json",
    "checkpoint",
    "loras",
    "width",
    "height",
    "file_size",
    "model_hash",
    "sidecar_caption",
)


def write_json(target: Path) -> None:
    sys.path.insert(0, str(BACKEND))
    with tempfile.TemporaryDirectory() as tmp:
        import database as db
        from image_manager_records import _build_metadata_success_record
        from metadata_parser import parse_image

        db.DATABASE_PATH = str(Path(tmp) / "reader-samples.db")
        db.init_db()
        result = {}
        for name, path in write_samples(Path(tmp) / "samples").items():
            parsed = parse_image(str(path))
            record = _build_metadata_success_record(
                str(path), path.name, os.stat(path), parsed
            )
            db.add_images_batch([record])
            row = db.get_image_by_path(str(path))
            parsed["source_temp_path"] = f"C:/reader-temp/{path.name}"
            parsed["file_size"] = 1000
            detail = {key: row.get(key) for key in DETAIL_FIELDS}
            detail["file_size"] = 1000
            result[name] = {"parse": parsed, "detail": detail}
    target.write_text(
        json.dumps(result, ensure_ascii=False, indent=1) + "\n", encoding="utf-8"
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--images", type=Path)
    parser.add_argument("--json", type=Path)
    args = parser.parse_args()
    if args.images:
        for path in write_samples(args.images).values():
            print(path)
    if args.json:
        write_json(args.json)
        print(args.json)
