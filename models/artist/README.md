# Artist Runtime Guide

SD Image Sorter now uses **Kaloscope2.0** for the experimental Artist ID feature.

## What The Feature Needs

The artist feature is only considered ready when all of these exist:

1. `models/artist/comfyui-lsnet-runtime/`
2. `models/artist/kaloscope2.0/448-90.13/best_checkpoint.pth`
3. `models/artist/kaloscope2.0/class_mapping.csv`
4. Python dependencies including `torch`, `timm`
5. On Windows: `triton-windows`

## Recommended Windows Route

This project prefers the `comfyui-lsnet` runtime layout because it is the most reliable path we verified on Windows.

The launcher already installs:

- `timm`
- `triton-windows` on Windows

So the normal user only needs the runtime folder and Kaloscope files in the right place.

## Release Asset Extraction

For the release assets:

1. Extract `sd-image-sorter-v2.1.0-artist-runtime.zip` into the project root.
2. Download all `sd-image-sorter-v2.1.0-kaloscope-checkpoint.zip.00x` parts into the same folder.
3. Use 7-Zip to extract the `.zip.001` file.
4. Confirm this final file exists:
   `models/artist/kaloscope2.0/448-90.13/best_checkpoint.pth`
5. Launch the app and open the `Artist ID` tab.
6. If the banner says `Kaloscope runtime is ready`, you are done.

## If The Banner Is Not Ready

- Missing runtime: extract the artist runtime package again
- Missing checkpoint: re-extract the split Kaloscope package
- Missing `triton` on Windows: relaunch `run.bat` and let dependencies finish installing
- Still seeing `undefined`: the runtime may be fine, but the prediction confidence is low for that image

## Honest Limitation

The Artist ID feature is still experimental.
Working runtime does **not** guarantee high-confidence artist labels for every picture.
