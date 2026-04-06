# Release Pack Guide

This document explains the release assets produced for the public build.

## Fastest Path For Normal Users

Download:

- `sd-image-sorter-vX.X.X-portable-python-win64.zip`

Then:

1. Extract it to any normal folder.
2. Double-click `run-portable.bat`.
3. Wait for dependency install on first run.
4. Open `http://localhost:8000`.

This package includes an embedded Python runtime — **no system Python install needed**.

That package is meant to cover the common workflows:

- Gallery
- WD14 tagging with the default `wd-swinv2` model
- Censor Edit with Wenaka privacy YOLO + NudeNet
- Similar search with local CLIP

## All Release Packages

| Package | Python Included | Models Included | Best For |
|:--------|:---------------:|:---------------:|:---------|
| `portable-python-win64` | Yes | Core models | **Most Windows users** — zero setup |
| `portable-core-models` | No | Core models | Users who already have Python 3.9+ |
| `app-python-win64` | Yes | None (auto-download) | Smaller download, okay with internet on first run |
| `app` | No | None (auto-download) | Advanced users, Linux/Mac |

## Model Download Sources

Models not bundled in the package will be downloaded automatically on first use.

- **Default**: Downloaded from [HuggingFace](https://huggingface.co)
- **Mainland China / GFW**: Set `HF_ENDPOINT=https://hf-mirror.com` in your environment or `backend/.env` file to use [hf-mirror](https://hf-mirror.com)
- **ModelScope**: Available for Artist ID and SAM3 features via the UI model source selector

## Optional Assets

### Higher-quality WD14 pack

- `sd-image-sorter-vX.X.X-wd14-eva02-model.zip`

Use this only if you want the heavier EVA02 tagger.

### Artist packs

- `sd-image-sorter-vX.X.X-artist-runtime.zip`
- `sd-image-sorter-vX.X.X-kaloscope-checkpoint.zip.001`
- `sd-image-sorter-vX.X.X-kaloscope-checkpoint.zip.002`

Put all Kaloscope split files in one folder and extract the `.zip.001` file with 7-Zip.

### SAM3 pack

- `sd-image-sorter-vX.X.X-sam3-modelscope-sam3pt.zip.001`
- `sd-image-sorter-vX.X.X-sam3-modelscope-sam3pt.zip.002`

This is included for advanced GPU users only.
In the current verified setup, SAM3 should be treated as CUDA-only.

## Why The Large Models Are Split

GitHub release assets have practical per-file limits, while Kaloscope and SAM3 are multi-gigabyte files.
Splitting them keeps the release downloadable without pretending they are "small normal zips".

## Why Models Are Not Included In The Repository

1. **Copyright**: Some models have specific redistribution terms
2. **Size**: Models range from 12 MB to 3.3 GB — too large for git
3. **Auto-download**: The app automatically downloads needed models on first use
4. **User choice**: Users only download what they actually need

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
