#!/usr/bin/env python3
"""Build deterministic review fixtures for live Playwright E2E.

The generated files intentionally live under ``backend/.tmp`` so they do not
ship in release archives, but this builder is tracked so CI can recreate them
from a clean checkout.
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path

from PIL import Image
from PIL.PngImagePlugin import PngInfo

ROOT = Path(__file__).resolve().parents[1]
TMP_ROOT = ROOT / "backend" / ".tmp"
DATASET = TMP_ROOT / "release_review_dataset"
AUTOSEP_DST = TMP_ROOT / "release_review_autosep"
MANUAL_A = TMP_ROOT / "release_review_manual_a"
MANUAL_D = TMP_ROOT / "release_review_manual_d"
CENSOR_OUT = TMP_ROOT / "release_review_censor_out"


def reset_dirs() -> None:
    for directory in (DATASET, AUTOSEP_DST, MANUAL_A, MANUAL_D, CENSOR_OUT):
        if directory.exists():
            shutil.rmtree(directory, ignore_errors=True)
        directory.mkdir(parents=True, exist_ok=True)


def comfyui_workflow(prompt: str, checkpoint: str) -> str:
    graph = {
        "3": {
            "class_type": "KSampler",
            "inputs": {"seed": 424242, "steps": 28, "cfg": 6.5, "sampler_name": "dpm++"},
        },
        "2": {
            "class_type": "CheckpointLoaderSimple",
            "inputs": {"ckpt_name": checkpoint},
        },
        "11": {
            "class_type": "CLIPTextEncode",
            "inputs": {"text": prompt},
        },
        "12": {
            "class_type": "CLIPTextEncode",
            "inputs": {"text": "worst quality, low quality"},
        },
    }
    return json.dumps(graph)


def nai_comment(prompt: str) -> str:
    return json.dumps(
        {
            "prompt": prompt,
            "uc": "nsfw, worst quality",
            "steps": 28,
            "scale": 6.0,
            "sampler": "k_euler_ancestral",
            "seed": 3141592,
            "noise_schedule": "karras",
            "Software": "NovelAI",
        }
    )


def webui_params(prompt: str, checkpoint: str, forge: bool = False) -> str:
    forge_tail = ""
    if forge:
        forge_tail = ", Version: f1.7.0-v1.8.0rc-latest-7-g1234abcd, Forge version: 0.1.0-preview"
    return (
        f"{prompt}\n"
        "Negative prompt: low quality, worst quality\n"
        "Steps: 30, Sampler: DPM++ 2M, CFG scale: 7.5, Seed: 9988776655, "
        f"Size: 512x768, Model hash: abcdef012345, Model: {checkpoint}, "
        f"Denoising strength: 0.5, Clip skip: 2, VAE: vae-ft-mse-840000-ema{forge_tail}"
    )


def save_png(path: Path, size: tuple[int, int] = (320, 320), color: tuple[int, int, int] = (200, 120, 90), info: PngInfo | None = None) -> None:
    image = Image.new("RGB", size, color)
    image.save(path, "PNG", pnginfo=info)


def build() -> None:
    reset_dirs()

    comfy_info = PngInfo()
    comfy_info.add_text("prompt", comfyui_workflow("1girl, masterpiece, starry sky", "v304_comfy.safetensors"))
    comfy_info.add_text("workflow", comfyui_workflow("1girl, masterpiece, starry sky", "v304_comfy.safetensors"))
    save_png(DATASET / "comfy_good.png", color=(60, 80, 160), info=comfy_info)

    nai_info = PngInfo()
    nai_info.add_text("Software", "NovelAI")
    nai_info.add_text("Comment", nai_comment("1girl, fantasy castle, artist:mocked"))
    nai_info.add_text("Source", "Stable Diffusion")
    save_png(DATASET / "nai_good.png", color=(160, 70, 120), info=nai_info)

    webui_info = PngInfo()
    webui_info.add_text("parameters", webui_params("portrait, masterpiece, highres, volumetric lighting", "v304_webui.safetensors"))
    save_png(DATASET / "webui_good.png", color=(70, 160, 100), info=webui_info)

    forge_info = PngInfo()
    forge_info.add_text("parameters", webui_params("landscape, forest, cinematic", "v304_forge.safetensors", forge=True))
    save_png(DATASET / "forge_good.png", color=(120, 120, 40), info=forge_info)

    save_png(DATASET / "no_metadata.png", color=(50, 50, 50))

    webp_image = Image.new("RGB", (256, 256), (90, 30, 90))
    webp_image.save(DATASET / "webp_good.webp", "WEBP", quality=85)

    truncated = DATASET / "truncated.png"
    truncated.write_bytes((DATASET / "comfy_good.png").read_bytes()[:128])

    (DATASET / "garbage.png").write_bytes(b"NOT AN IMAGE AT ALL")

    print("Dataset size (count):", len(list(DATASET.iterdir())))
    for image_path in sorted(DATASET.iterdir()):
        print(" -", image_path.name, image_path.stat().st_size, "bytes")


if __name__ == "__main__":
    build()
