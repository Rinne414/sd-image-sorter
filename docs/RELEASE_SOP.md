# Release SOP

> Canonical, version-controlled release procedure. The project's local
> `CLAUDE.md` mirrors this for in-editor guidance, but `CLAUDE.md` is gitignored
> — **this file is the shared source of truth.** Keep them in sync.

## CRITICAL: GitHub Release Notes Structure

The in-app "Check Update" popup (`app.js:_showUpdatePopup`) truncates
`release_notes` to the **first 200 characters** and displays it as "更新说明".
The release body is fetched raw from `release.body` via the GitHub API
(`update_service.py`).

**The first 200 characters MUST be a useful changelog summary, NOT download
instructions.**

### Required Section Order

```
1. Title line (## vX.Y.Z — 中文摘要 / English summary)
2. 2-3 sentence bilingual changelog summary (this is what users see in-app)
3. ---
4. ## Fixed / 修复  (detailed bilingual changelog)
5. ---
6. ## Upgrading / 升级注意  (migration notes for old users)
7. ---
8. ## Validation / 验证  (CI results, one line)
9. ---
10. ## ⬇️ Download guide  (LAST — GitHub web readers see it, in-app users don't)
11. ---
12. ## Checksums
```

### Title Line Format

```
## vX.Y.Z — 中文关键词 + 关键词 / English Keywords + Keywords
```

Keep under 80 chars. This becomes the "更新说明" heading.

### First 200 Characters Rule

The 2-3 sentence summary immediately after the title MUST:
- Be bilingual (Chinese first, English second)
- Summarize the most important user-visible changes
- NOT contain markdown links, download URLs, or file names
- NOT start with "Which file should I download" or similar

### Fixed Section Format

Each bullet:
```
- **English feature name**: English description.
  - 中文描述。
```

### Download Guide (ALWAYS LAST)

```
## ⬇️ Which file should I download? / 我该下载哪一个？

**Windows → windows-portable.zip** — extract, run run-portable.bat
**Linux → linux.tar.gz** — extract, run ./run.sh

**Do NOT download / 不要下载：**
- app-patch.zip — in-app updater only / 仅供更新器
- release-manifest.json — updater metadata / 更新器元数据
```

## Release Build Steps

```bash
# 1. Ensure version in backend/app_info.py matches target
# 2. Ensure CHANGELOG.md has the version entry
# 3. Run full CI
python scripts/run_ci.py
# 4. Build packages
python scripts/build_release_packages.py --version X.Y.Z
# 5. Release QA gate (asset completeness + SHA256-vs-manifest verification)
#    Validates artifacts/release/ against the manifest. --skip-server keeps it
#    fast (archive integrity only; omit it to also boot the backend for a smoke run).
python scripts/lazy_release_qa.py --skip-server
# 6. Commit and push
git add . && git commit -m "release: prepare vX.Y.Z" && git push
# 7. Create GitHub release with ALL 6 assets (glob uploads every built artifact)
gh release create vX.Y.Z artifacts/release/sd-image-sorter-vX.Y.Z-* \
  --title "vX.Y.Z" --notes "$(cat release-notes.md)"
# 8. Verify: 6 assets (windows-portable, app-patch, linux, linux-portable x86_64, linux-portable aarch64, manifest)
gh release view vX.Y.Z --json assets --jq '.assets[].name'
```

### Required Assets (always 6)

| Asset | Purpose | Who uses it |
|-------|---------|-------------|
| `windows-portable.zip` | Full Windows package with embedded Python | New Windows users |
| `linux.tar.gz` | Linux source package (uses system Python) | New Linux users with Python 3.12+ |
| `linux-portable-x86_64.tar.gz` | Linux package with bundled CPython (x86_64) | Linux users without Python 3.12+ |
| `linux-portable-aarch64.tar.gz` | Linux package with bundled CPython (aarch64/ARM) | ARM Linux (Pi 5, Graviton) |
| `app-patch.zip` | In-app updater payload | Existing users via "Check Update" |
| `release-manifest.json` | Version + SHA256 metadata | In-app updater version detection + release QA gate |

### Pre-Release Checklist

- [ ] `backend/app_info.py` version matches
- [ ] `CHANGELOG.md` entry exists with bilingual notes
- [ ] Full CI green (backend + E2E)
- [ ] `build_release_packages.py` completes without errors
- [ ] `python scripts/lazy_release_qa.py --skip-server` passes (asset completeness + SHA256-vs-manifest gate)
- [ ] All 6 assets uploaded to GitHub release
- [ ] Release notes first 200 chars are a useful bilingual summary (NOT download guide)
- [ ] Release notes contain download guide section (at bottom)
- [ ] Checksums table present
