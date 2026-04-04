# YOLO Model Notes

This folder is used by the **Legacy YOLO** path inside Censor Edit.

## Recommended Default

- `wenaka_yolov8s-seg.onnx`
- Purpose: privacy-part detection for censor workflows
- UI label: `Privacy-part detector`

If this file exists, the app now picks it automatically when the user leaves the legacy model path empty.

## Compatibility Models

- `yolo26s-seg.onnx`
- `yolov8s-seg.onnx`
- `.pt` variants of both

These files are useful for runtime compatibility checks and general object segmentation tests.
They are **not** the preferred model for privacy censoring.

## Source Notes

- The privacy model commonly shared by Wenaka is published on CivitAI:
  [CivitAI model page](https://civitai.com/models/1736285/and-or-dickvaginatitsanuscum-yolov8-segment-model)
- CivitAI currently requires login to download that asset directly.
- The app-side integration in this project is based on the local `wenaka_yolov8s-seg` files already placed in this folder.

## Normal User Workflow

1. Open `Censor Edit`.
2. Keep `Model Type` on `both` unless you have a reason to change it.
3. Leave the custom legacy model path empty.
4. Let the app use the recommended local privacy model automatically.
