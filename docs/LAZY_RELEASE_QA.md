# Lazy Release QA

This is the "I am a lazy developer" release gate for SD Image Sorter.
It automates the boring parts of release testing: package integrity, startup,
synthetic image generation, scan/import, filters, selection-token export,
thumbnail serving, copy operations, obfuscation encode/decode, and status
endpoints for optional model features.

## Quick Command

After building release assets:

```bash
python3 scripts/lazy_release_qa.py --version 3.1.0-techdebt.48793ff
```

Use the current version string from the package filename. If you only want to
validate the zip/tar assets:

```bash
python3 scripts/lazy_release_qa.py --version 3.1.0-techdebt.48793ff --skip-server
```

## Large Smoke

For a larger synthetic gallery/selection scan:

```bash
python3 scripts/lazy_release_qa.py --version 3.1.0-techdebt.48793ff --image-count 10000 --scan-timeout 900
```

For a heavier stress run:

```bash
python3 scripts/lazy_release_qa.py --version 3.1.0-techdebt.48793ff --image-count 50000 --scan-timeout 3600
```

## What It Covers

- Release manifest SHA-256 and size checks
- Zip/tar archive integrity
- Required package files are present
- Dev/runtime folders are not accidentally packaged
- Isolated temporary app data and SQLite DB
- Synthetic images with WebUI, Forge, NovelAI, ComfyUI, plain JPG, corrupt file, zero-byte file, unicode paths, nested folders, and long prompts
- Backend startup on a random local port
- `/`, `/docs`, `/api/stats`
- Model/status endpoints for Models, Censor, Aesthetic, Artist, Similarity, Prompt Lab, and Updates
- Path validation and folder browsing
- Folder scan and progress polling
- Gallery list, filters, sort, image details, original file, thumbnail, thumbnail cache
- Selection token/chunk and legacy selection IDs
- Export data from selection token
- Copy one indexed image through `/api/move`
- Obfuscation encode/decode round trip
- Tag library/progress/model endpoints

## What It Does Not Replace

This script does not fully validate human UX quality, visual regressions, real AI
model inference quality, or destructive production-library workflows. It is a
fast release gate, not an excuse to never do exploratory QA before a major public
release.

## Failure Handling

On failure, the script prints the failed step and tails the backend log.
The workspace is under:

```text
.tmp/lazy-release-qa/
```

Useful files:

```text
.tmp/lazy-release-qa/backend.log
.tmp/lazy-release-qa/images/
.tmp/lazy-release-qa/runtime-data/images.db
```

Rerun with `--keep-workdir` if you want to preserve the previous workspace for debugging.
