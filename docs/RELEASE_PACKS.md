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

On NVIDIA machines, the first ONNX Runtime check may install CUDA / cuDNN runtime wheels after the normal dependency install. The launcher prints the actual pip progress during that step; do not close it just because it is still working under `Checking Windows ONNX Runtime package state...`.

That package is meant to cover the common workflows:

- Gallery
- WD14 tagging with the default `wd-swinv2` model
- Censor Edit with Wenaka privacy YOLO + NudeNet
- Similar search with local CLIP

## All Release Packages

| Package | Python Included | Models Included | Best For |
|:--------|:---------------:|:---------------:|:---------|
| `sd-image-sorter-vX.X.X-windows-portable.zip` | Yes | None (auto-download) | **Most Windows users** — no system Python install |
| `sd-image-sorter-vX.X.X-linux-portable-x86_64.tar.gz` | Yes (cpython 3.13, x86_64) | None (auto-download) | **Most Linux users on PCs / laptops / x86 servers** — works on any distro, including ones whose system Python is 3.14 (where heavy AI wheels are not yet available) |
| `sd-image-sorter-vX.X.X-linux-portable-aarch64.tar.gz` | Yes (cpython 3.13, aarch64) | None (auto-download) | **Linux users on ARM** — Raspberry Pi 4 / 5, ARM Linux servers, AWS Graviton, Apple Silicon running Linux |
| `sd-image-sorter-vX.X.X-linux.tar.gz` | No | None (auto-download) | Advanced Linux users with Python 3.12+ already installed and managed |
| `sd-image-sorter-vX.X.X-app-patch.zip` | No | None | In-app updater payload; not the recommended manual first install |
| `sd-image-sorter-vX.X.X-release-manifest.json` | No | No | SHA256/size manifest used by the updater and release checks |

### Linux Portable Notes

- The bundled Python is `cpython-3.13.13` from [astral-sh/python-build-standalone](https://github.com/astral-sh/python-build-standalone), built against an old enough glibc (2.17 on x86_64, 2.28 on aarch64) to run on every modern Linux distro on either architecture.
- Both `x86_64` and `aarch64` ship in this release line. Pick the tarball that matches your CPU; the runtime experience is identical (same Python, same first-run install flow, same `Setup Now` UX for heavy AI features).
- The `python/` directory inside the archive is the bundled interpreter. `run.sh` automatically detects it and forwards to `run-portable.sh`, so users only need to chmod once and double-click.
- First launch installs the lightweight core dependencies (~120 MB extra after install). Heavy AI features (CLIP, SAM3, NudeNet, Aesthetic Score, Artist ID, ToriiGate) install on demand via **Setup Now → Prepare**.

### macOS: Source-Install Only (No Portable Bundle Yet)

There is **no `macos-portable-*.tar.gz` asset** by design. macOS users should clone the repo (or download `linux.tar.gz` — its `run.sh` works on macOS too) and run `./run.sh` against system Python (Homebrew / pyenv / asdf / `uv` all work; the app's lockfile supports Python 3.12 and 3.13).

The reasons are documented in [`docs/AI_DECISION_LOG.md`](AI_DECISION_LOG.md) under **ADR-2026-05-24: macOS portable bundle deferred**, summarised here:

1. **Gatekeeper friction without notarization.** A macOS portable would need [Apple Developer notarization](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution) (\$99 / yr Apple Developer Program) to launch without `"developer cannot be verified"` warnings on every fresh download. Without notarization, every user has to right-click → Open or `xattr -dr com.apple.quarantine sd-image-sorter/` before launching — a much worse first-run experience than the Windows / Linux portable double-click flow.
2. **macOS users almost always already have Python.** Homebrew, `pyenv`, `asdf`, and `uv` are standard on macOS dev machines, so the "no system Python" pain point that drove the Linux portable basically does not exist on macOS. The existing `./run.sh` source path already creates a venv and installs deps; PR #12 fixed Darwin-clone detection so this works on the source bundle.
3. **macOS Intel is fading upstream.** PyTorch dropped macOS Intel (`x86_64-apple-darwin`) wheels after `2.2.2`; the lockfile pins that legacy version explicitly. Shipping an Intel macOS portable today would freeze users to an upstream-deprecated stack — a worse outcome than `run.sh` against `brew install python@3.13`, which lets the user manage upgrades on their own schedule.
4. **Apple Silicon under macOS works fine via source.** M1 / M2 / M3 / M4 users get full functionality through `./run.sh`; ONNX Runtime auto-selects the optimal provider (CoreML or CPU). No CUDA on macOS means heavy GPU paths are not the value-add anyway.

This decision will be revisited if any of the following becomes true:

- An Apple Developer account becomes available for notarization, removing the Gatekeeper friction.
- A real macOS user reports the source path is broken in a way `./run.sh` cannot fix.
- PyTorch ships a renewed macOS Intel wheel line that justifies a fresh look at the legacy pin.

Until then, macOS users should:

```bash
git clone https://github.com/peter119lee/sd-image-sorter.git
cd sd-image-sorter
./run.sh
```

…OR download `sd-image-sorter-vX.X.X-linux.tar.gz` and run `./run.sh` from the extracted directory (the script detects Darwin and behaves correctly).

## Model Download Sources

Models not bundled in the package will be downloaded automatically on first use.

- **Default**: Downloaded from [HuggingFace](https://huggingface.co)
- **Can't access HuggingFace?**: Open **Setup Now** and switch **Download Source** to hf-mirror or ModelScope
- **ModelScope**: Available for Artist ID and SAM3 features

## Package Manifest Model Policy

Every app package writes `update/package-manifest.json` with a `model_artifact_policy` block.

- Default app packages do **not** manage model payload files under `models/`; they only include model README/docs.
- Runtime model files live under package-local `data/models` via launcher environment variables.
- Auto-download model paths and optional release model assets are declared in the manifest so update/package checks do not mistake a model-free app package for a complete model bundle.
- If a future staging mistake drops model binaries into a default app package, the package manifest excludes them unless the builder explicitly opts into model payload management.

## Manual App Updates

The app only checks for updates when the user clicks the update button.

- Default channel: GitHub Releases
- If GitHub is unreachable, the app will suggest setting up an update proxy
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
In the current verified setup, SAM3 should be treated as CUDA-only. Windows and Linux launchers prepare the SAM3 Python runtime. macOS is not supported by this release line.

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
