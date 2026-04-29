# Release Pack Guide

This document explains the release assets produced for the public build.

## Fastest Path For Normal Users

Download:

- `sd-image-sorter-vX.X.X-windows-portable.zip`

Then:

1. Extract it to any normal folder.
2. Double-click `run-portable.bat`.
3. Wait for dependency install on first run.
4. Open `http://localhost:8487`.

This package includes an embedded Python runtime — **no system Python install needed**.

That package is meant to cover the common workflows:

- Gallery
- WD14 tagging with the default `wd-swinv2` model
- Censor Edit with Wenaka privacy YOLO + NudeNet
- Similar search with local CLIP

## All Release Packages

| Package | Python Included | Models Included | Best For |
|:--------|:---------------:|:---------------:|:---------|
| `sd-image-sorter-vX.X.X-windows-portable.zip` | Yes | None (auto-download) | **Most Windows users** — no system Python install |
| `sd-image-sorter-vX.X.X-linux-mac.tar.gz` | No | None (auto-download) | Advanced Linux/Mac users with Python 3.12+ |
| `sd-image-sorter-vX.X.X-app-patch.zip` | No | None | In-app updater payload; not the recommended manual first install |
| `sd-image-sorter-vX.X.X-release-manifest.json` | No | No | SHA256/size manifest used by the updater and release checks |

## Model Download Sources

Models not bundled in the package will be downloaded automatically on first use.

- **Default**: Downloaded from [HuggingFace](https://huggingface.co)
- **Mainland China / GFW**: Set `HF_ENDPOINT=https://hf-mirror.com` in your environment or package-root `.env` file to use [hf-mirror](https://hf-mirror.com)
- **ModelScope**: Available for Artist ID and SAM3 features via the UI model source selector

## Package Manifest Model Policy

Every app package writes `update/package-manifest.json` with a `model_artifact_policy` block.

- Default app packages do **not** manage model payload files under `models/`; they only include model README/docs.
- Runtime model files live under package-local `data/models` via launcher environment variables.
- Auto-download model paths and optional release model assets are declared in the manifest so update/package checks do not mistake a model-free app package for a complete model bundle.
- If a future staging mistake drops model binaries into a default app package, the package manifest excludes them unless the builder explicitly opts into model payload management.

## Manual App Updates

The app only checks for updates when the user clicks the update button.

- Default channel: GitHub Releases
- Mainland China friendly option: set `SD_IMAGE_SORTER_UPDATE_API_URL`, `SD_IMAGE_SORTER_UPDATE_WEB_URL`, and `SD_IMAGE_SORTER_UPDATE_DOWNLOAD_URL_PREFIX` in the package-root `.env`
- Default user guidance: if GitHub is unreachable, enable VPN and retry the manual update check
- Asset selection rule: prefer `app-patch`, but automatically fall back to the platform full package when no patch asset exists
- Safety rule: the updater only replaces release-managed app files and never touches protected runtime paths

## Why The Updater Never Touches `data/`

This is intentional and must stay that way.

- `data/` is package-local user state: database, favorites, downloaded models, cache, thumbnails, temp files, and other long-lived runtime data
- `update/backups`, `update/downloads`, `update/logs`, `update/state`, and `update/worker` are updater runtime workspaces, not release payload content
- Protected runtime prefixes are: `data`, `update/backups`, `update/downloads`, `update/logs`, `update/state`, `update/worker`
- The in-app updater is meant to behave like "replace the app code in place", not "reinstall the whole environment from scratch"
- Release packaging already excludes runtime folders, but the worker also hard-blocks them so a future packaging mistake cannot silently overwrite or delete user state
- If a new release manifest ever tries to manage protected runtime paths, the worker aborts the update before copying or deleting installed files
- If an old installed manifest contains dirty entries for protected paths, the worker ignores those entries instead of treating user data as obsolete app files

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
