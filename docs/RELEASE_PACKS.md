# Release Pack Guide

This document explains the release assets produced for the public build.

## Fastest Path For Normal Users

Download:

- `sd-image-sorter-v2.1.0-portable-core-models.zip`

Then:

1. Extract it to any normal folder.
2. Double-click `run.bat`.
3. Wait for dependency install on first run.
4. Open `http://localhost:8000`.

That package is meant to cover the common workflows:

- Gallery
- WD14 tagging with the default `wd-swinv2` model
- Censor Edit with Wenaka privacy YOLO + NudeNet
- Similar search with local CLIP

## Optional Assets

### Higher-quality WD14 pack

- `sd-image-sorter-v2.1.0-wd14-eva02-model.zip`

Use this only if you want the heavier EVA02 tagger.

### Artist packs

- `sd-image-sorter-v2.1.0-artist-runtime.zip`
- `sd-image-sorter-v2.1.0-kaloscope-checkpoint.zip.001`
- `sd-image-sorter-v2.1.0-kaloscope-checkpoint.zip.002`

Put all Kaloscope split files in one folder and extract the `.zip.001` file with 7-Zip.

### SAM3 pack

- `sd-image-sorter-v2.1.0-sam3-modelscope-sam3pt.zip.001`
- `sd-image-sorter-v2.1.0-sam3-modelscope-sam3pt.zip.002`

This is included for advanced GPU users only.
In the current verified setup, SAM3 should be treated as CUDA-only.

## Why The Large Models Are Split

GitHub release assets have practical per-file limits, while Kaloscope and SAM3 are multi-gigabyte files.
Splitting them keeps the release downloadable without pretending they are “small normal zips”.

## Recommended Extraction Order

1. Main app or portable core package
2. Optional WD14 EVA02 pack
3. Optional artist runtime pack
4. Optional split Kaloscope checkpoint
5. Optional split SAM3 checkpoint

## After Extraction

The app itself will tell you what is ready:

- `Similar` tab banner: local CLIP readiness
- `Censor Edit` banner: recommended detection mode and default privacy model
- `Artist ID` banner: Kaloscope runtime readiness
