# Local Model Guide

This folder is a legacy/bundled model location. The **live** model cache now lives under
`data/models/` (e.g. `data/models/artist/`, `data/models/clip/`, `data/models/sam3/`).
Files found here are still detected for backward compatibility, but new downloads land in `data/models/`.

Most users should **not** set model paths by hand anymore.
If the recommended local files are present, the app auto-selects them and shows a status banner in the UI.

## What Works Best Right Now

| Feature | Recommended local path | Normal user action |
|---|---|---|
| WD14 tagging | `data/models/wd14-tagger/wd-swinv2-tagger-v3/` | Leave defaults alone |
| Censor detection | `data/models/yolo/wenaka_yolov8s-seg.onnx` | Leave legacy model path blank |
| Similar search (CLIP) | `data/models/clip/` (HF cache or `Qdrant-clip-ViT-B-32-vision/`) | Click `Generate Embeddings` once |
| NudeNet | `data/models/nudenet/320n.onnx` | No manual path needed |
| Artist ID | `data/models/artist/comfyui-lsnet-runtime/` + `data/models/artist/kaloscope2.0/` files | Check the runtime banner first |
| SAM3 refine | `data/models/sam3/facebook-sam3-modelscope/` (config.json + model.safetensors) | Optional, GPU-only |

## Simple Rule For Non-Coders

1. Extract the release package to a normal folder.
2. Double-click `run.bat`.
3. Open the browser UI and open **Feature Setup / Model Manager**.
4. Click **Prepare / Download** on the feature you want, and follow any restart prompt.
5. Only touch custom paths if you already know why you need them.

## Manual Placement (only if auto-download fails)

The app detects manually-placed files tolerantly (it scans the HuggingFace hub cache
layout `models--Org--Repo/snapshots/HASH/`, case-insensitive folder names, and nested
sub-folders), but the **canonical** layouts are:

- **Artist / Kaloscope 2.0**
  - `data/models/artist/kaloscope2.0/448-90.13/best_checkpoint.pth`
  - `data/models/artist/kaloscope2.0/class_mapping.csv`
  - `data/models/artist/comfyui-lsnet-runtime/lsnet_model/`
  - Sources: HuggingFace `heathcliff01/Kaloscope2.0` (checkpoint under `448-90.13/`) or
    ModelScope `Heathcliff02/Kaloscope-2.0` (checkpoint at repo root). Both are byte-identical.
- **CLIP** — let FastEmbed download into `data/models/clip/` (any HF-cache nesting is detected).
- **SAM3** — a transformers checkpoint dir (`config.json` + `model.safetensors` + tokenizer files)
  under `data/models/sam3/facebook-sam3-modelscope/`.

## Important Notes

- `wenaka_yolov8s-seg` is the privacy-part model you want for censoring.
- `wenaka_yolov8s-seg` is treated in the app as the quick fixed-class privacy detector. It is not a free-text prompt model.
- `yolo26s-seg` and `yolov8s-seg` are useful compatibility models, but the current local files are fixed-class COCO models, not open-text detectors.
- `SAM3` is currently treated as an advanced optional feature. In this project it is only considered ready when CUDA is available.
- Artist ID now targets `Kaloscope2.0`, not `cafe_style`.

## More Detailed Guides

- [Artist runtime guide](./artist/README.md)
- [YOLO model notes](./yolo/README.md)
- [Release pack guide](../docs/RELEASE_PACKS.md)
