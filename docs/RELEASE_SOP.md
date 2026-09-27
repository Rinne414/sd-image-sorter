# Release SOP

> Canonical, version-controlled release procedure. The project's local
> `CLAUDE.md` mirrors this for in-editor guidance, but `CLAUDE.md` is gitignored
> — **this file is the shared source of truth.** Keep them in sync.

## CRITICAL: GitHub Release Notes Structure

Settings › About shows the start of `release_notes`: the summary above the
first `---`, at most **200 characters** (`notesLead` in
`frontend-v4/src/features/settings/about/updateState.ts`), as "更新说明".
The release body is fetched raw from `release.body` via the GitHub API
(`update_service_delivery.py`).

**The first 200 characters MUST be a useful changelog summary, NOT download
instructions.**

### Required Section Order

```
1. Title line (## Vopus X.Y.Z — 中文摘要 / English summary)
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
## Vopus X.Y.Z — 中文关键词 + 关键词 / English Keywords + Keywords
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

## Vopus Tags and the In-App Updater

This checkout is **Vopus** (formerly V4). The same GitHub repository also
publishes V3.5 (tags `vX.Y.Z`, e.g. `v3.5.0`), so Vopus releases carry their
own prefix:

- **Tag**: `vopus-vX.Y.Z`, lowercase, where `X.Y.Z` is `APP_VERSION` in
  `backend/app_info.py` (e.g. `vopus-v1.0.0`; a pre-release suffix such as
  `vopus-v1.1.0-beta.1` is allowed).
- **Files**: `sd-image-sorter-vopus-vX.Y.Z-<kind>` (the templates in
  `backend/app_info.py`; `build_release_packages.py` and
  `lazy_release_qa.py` use the same names).
- **Notes**: `docs/RELEASE_NOTES_vopus-vX.Y.Z.md`, copied to the root
  `release-notes.md`; the title line starts `## Vopus X.Y.Z — `.

What the updater does (`backend/services/update_service_delivery.py`, tests in
`backend/tests/test_update_vopus_releases.py`):

- It reads the release **list** beside GitHub's latest-release endpoint
  (`/repos/<owner>/<repo>/releases?per_page=100`, newest created first),
  through the update proxy when one is set. It reads the next page only while
  a full page holds no Vopus release, three pages (300 releases) at most. The
  GitHub "Latest" flag does not matter to Vopus.
- It offers the highest-versioned release whose tag is `vopus-v` followed by a
  version. Drafts, releases marked **pre-release**, V3.5 tags and malformed
  tags are never offered. A Vopus release you want installs to receive must be
  published as a normal (not pre-release) release.
- A channel URL that answers with one release instead of a list (a custom
  mirror) is checked for the same tag rule.

**v3.5.0 stays "Latest": publish every Vopus release with `--latest=false`.**
Older installs read `/releases/latest` and strip only a leading `v`, so a
Vopus release there reads as `opus-v1.0.0`:

- V3.1.0 to 3.4.3 and 3.5.0-beta.1 compare versions without type tags:
  `("opus", "v", 1, 0, 0)` against `(3, 4, 3)` raises TypeError, the check
  reports "Failed to reach the default GitHub update channel … enable VPN",
  and those users lose the in-app path to v3.5.0.
- 3.5.0 does not offer it, but shows "Latest Version: opus-v1.0.0" and the
  Vopus notes in its update popup.
- V4 preview installs (version 3.5.0, the same updater) are never offered
  Vopus; they need the full Vopus package. They must not take an in-app 3.5.x
  update either: it replaces the interface with V3.5, which cannot open the
  database Vopus upgraded.

With v3.5.0 as Latest, `/releases/latest` leads to V3.5, so the README links
Vopus users to the releases page and names the `vopus-v` tags.

## Release Build Steps

```bash
# 1. Ensure version in backend/app_info.py matches target
# 2. Ensure CHANGELOG.md has the version entry and docs/RELEASE_NOTES_vopus-vX.Y.Z.md
#    exists (copy it to the root release-notes.md)
# 3. Run full CI
python scripts/run_ci.py
# 4. Build packages
python scripts/build_release_packages.py --version X.Y.Z
# 5. Release QA gate (asset completeness + SHA256-vs-manifest verification)
#    Validates artifacts/release/ against the manifest. --skip-server keeps it
#    fast (archive integrity only; omit it to also boot the backend for a smoke run).
python scripts/lazy_release_qa.py --skip-server
# 6. Commit and push
git add . && git commit -m "release: prepare vopus-vX.Y.Z" && git push
# 7. Create GitHub release with ALL 6 assets (glob uploads every built artifact)
#    Tag vopus-vX.Y.Z (see "Vopus Tags and the In-App Updater"); never --prerelease
#    for a release installs should receive, and always --latest=false so v3.5.0
#    stays Latest for V3.5 installs.
#    --target: without an existing tag, gh tags the default branch (main = V3.5),
#    and the tag and GitHub's "Source code" archives would be V3.5 code. Run
#    this from the Vopus checkout whose pushed HEAD the packages were built from.
gh release create vopus-vX.Y.Z artifacts/release/sd-image-sorter-vopus-vX.Y.Z-* \
  --target "$(git rev-parse HEAD)" --latest=false \
  --title "Vopus X.Y.Z" --notes "$(cat release-notes.md)"
# 8. Verify: 6 assets (windows-portable, app-patch, linux, linux-portable x86_64, linux-portable aarch64, manifest)
gh release view vopus-vX.Y.Z --json assets --jq '.assets[].name'
# 9. Verify the tag is the built Vopus commit, not main
git fetch --tags && test "$(git rev-parse vopus-vX.Y.Z^{commit})" = "$(git rev-parse HEAD)"
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
- [ ] Tag is `vopus-vX.Y.Z` and every asset is named `sd-image-sorter-vopus-vX.Y.Z-*`
- [ ] The tag points at the Vopus commit the packages were built from (`--target <full SHA>`), not at `main`
- [ ] Published as a normal release (not pre-release) with `--latest=false`; `gh api repos/Rinne414/sd-image-sorter/releases/latest --jq .tag_name` still prints a V3.5 tag
- [ ] `CHANGELOG.md` entry exists with bilingual notes
- [ ] Full CI green (backend + E2E)
- [ ] `build_release_packages.py` completes without errors
- [ ] `python scripts/lazy_release_qa.py --skip-server` passes (asset completeness + SHA256-vs-manifest gate)
- [ ] All 6 assets uploaded to GitHub release
- [ ] Release notes first 200 chars are a useful bilingual summary (NOT download guide)
- [ ] Release notes contain download guide section (at bottom)
- [ ] Checksums table present
