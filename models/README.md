# Local Model Guide

This folder is the shared local model cache for SD Image Sorter.

Most users should **not** set model paths by hand anymore.
If the recommended local files are present, the app now auto-selects them and shows a status banner in the UI.

## What Works Best Right Now

| Feature | Recommended local path | Normal user action |
|---|---|---|
| WD14 tagging | `models/wd14-tagger/wd-swinv2-tagger-v3/` | Leave defaults alone |
| Censor detection | `models/yolo/wenaka_yolov8s-seg.onnx` | Leave legacy model path blank |
| Similar search | `models/clip/Qdrant-clip-ViT-B-32-vision/` | Click `Generate Embeddings` once |
| NudeNet | `models/nudenet/320n.onnx` | No manual path needed |
| Artist ID | `models/artist/comfyui-lsnet-runtime/` + Kaloscope files | Check the runtime banner first |
| SAM3 refine | `models/sam3/facebook-sam3-modelscope/sam3.pt` | Optional, GPU-only |

## Simple Rule For Non-Coders

1. Extract the release package to a normal folder.
2. Double-click `run.bat`.
3. Open the browser UI.
4. Read the model status banner on `Censor`, `Similar`, and `Artist ID`.
5. Only touch custom paths if you already know why you need them.

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
