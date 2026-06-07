# Artist Runtime Guide

SD Image Sorter uses **Kaloscope2.0** for the experimental Artist ID feature.

> The live model cache is `data/models/artist/`. Paths under `models/artist/` are
> still detected for backward compatibility, but new downloads land in `data/models/artist/`.

## What The Feature Needs

The artist feature is only considered ready when all of these exist:

1. `data/models/artist/comfyui-lsnet-runtime/lsnet_model/`
2. `data/models/artist/kaloscope2.0/448-90.13/best_checkpoint.pth`
3. `data/models/artist/kaloscope2.0/class_mapping.csv`
4. Python dependencies including `torch`, `timm`
5. On Windows: `triton-windows`

## Easiest Route: Prepare / Download

1. Open **Feature Setup / Model Manager** in the UI.
2. Click **Prepare / Download** on the *Artist ID / Kaloscope* card.
3. If it says Python packages were installed, **restart the app**, then click Prepare again.
4. Pick the **Download Source** (top of the Model Manager) before preparing:
   - `Auto` / `hf-mirror` → HuggingFace `heathcliff01/Kaloscope2.0`
   - `ModelScope` → ModelScope `Heathcliff02/Kaloscope-2.0` (downloaded via direct
     `modelscope.cn` URLs — no extra SDK required)

The launcher already installs `timm` and, on Windows, `triton-windows`.

## Manual Placement (only if auto-download fails)

Detection is tolerant (case-insensitive folder names, nested sub-folders, and the
HuggingFace hub cache layout are all recognized), but the canonical layout is:

- `data/models/artist/kaloscope2.0/448-90.13/best_checkpoint.pth`
- `data/models/artist/kaloscope2.0/class_mapping.csv`
- `data/models/artist/comfyui-lsnet-runtime/lsnet_model/`

Download sources for the two Kaloscope files:

- HuggingFace: <https://huggingface.co/heathcliff01/Kaloscope2.0> (checkpoint lives under `448-90.13/`)
- ModelScope: <https://modelscope.cn/models/Heathcliff02/Kaloscope-2.0> (checkpoint at repo root)

Both mirrors serve a byte-identical checkpoint; `class_mapping.csv` is identical apart
from line endings (HuggingFace CRLF, ModelScope LF) and both are accepted.

After copying the files, reopen the Model Manager (or restart) so the banner re-checks.

## If The Banner Is Not Ready

- Missing runtime: re-run Prepare, or place a `comfyui-lsnet` checkout with a `lsnet_model/` folder.
- Missing checkpoint: confirm `best_checkpoint.pth` is under `kaloscope2.0/448-90.13/`.
- Missing `triton` on Windows: relaunch `run.bat` and let dependencies finish installing.
- Still seeing `undefined`: the runtime may be fine, but the prediction confidence is low for that image.

## Honest Limitation

The Artist ID feature is still experimental.
A working runtime does **not** guarantee high-confidence artist labels for every picture.
