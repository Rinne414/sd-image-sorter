# Release Notes Template

> **CRITICAL:** The in-app "Check Update" popup truncates `release_notes` to the **first 200 characters** and displays it as "更新说明". The first 200 characters MUST be a useful bilingual changelog summary, NOT download instructions.

## Structure

```markdown
## vX.Y.Z — 中文关键词 + 关键词 / English Keywords + Keywords

[2-3 sentence bilingual summary — this is what users see in-app popup]
[Chinese first, English second]
[NO markdown links, NO download URLs, NO file names]
[Must be under 200 characters total]

---

## Fixed / 修复

- **English feature name**: English description.
  - 中文描述。

[Repeat for each fix, improvement, or new feature]

---

## Upgrading / 升级注意

[Migration notes for users upgrading from previous versions]
[Breaking changes, required actions, deprecation warnings]

中文 + English bilingual

---

## Validation / 验证

CI results (one line):
- Backend: X passed / Y failed
- E2E: X passed / Y failed
- QA: PASS/FAIL
- Portable boot test: SUCCESS/FAIL

---

## ⬇️ Which file should I download? / 我该下载哪一个？

**Windows → windows-portable.zip** — extract, run run-portable.bat

**Linux → linux.tar.gz** (source, needs Python 3.12+) — extract, run ./run.sh

**Linux → linux-portable-x86_64.tar.gz** (portable, no Python needed, x86_64 CPU)

**Linux → linux-portable-aarch64.tar.gz** (portable, no Python needed, ARM CPU)

**Do NOT download / 不要下载：**
- app-patch.zip — in-app updater only / 仅供更新器
- release-manifest.json — updater metadata / 更新器元数据

---

## Checksums (SHA256)

| File | SHA256 |
|------|--------|
| sd-image-sorter-vX.Y.Z-windows-portable.zip | `abc123...` |
| sd-image-sorter-vX.Y.Z-linux.tar.gz | `def456...` |
| sd-image-sorter-vX.Y.Z-linux-portable-x86_64.tar.gz | `ghi789...` |
| sd-image-sorter-vX.Y.Z-linux-portable-aarch64.tar.gz | `jkl012...` |
| sd-image-sorter-vX.Y.Z-app-patch.zip | `mno345...` |
| release-manifest.json | `pqr678...` |
```

## Title Line Format

```
## vX.Y.Z — 中文关键词 + 关键词 / English Keywords + Keywords
```

**Rules:**
- Keep under 80 characters
- Use actual feature names, not generic words like "improvements" or "fixes"
- Chinese first, English second
- Separate with ` / `

**Examples:**

✅ Good:
```
## v3.4.0 — Collections + 多模式分拣 + 背景队列 / Collections + Multi-Mode Sort + Job Queue
```

❌ Bad:
```
## v3.4.0 — Bug fixes and improvements
```

## First 200 Characters (Summary)

**This is the MOST IMPORTANT part.** Users see this in the in-app update popup.

**Must:**
- Be 2-3 sentences
- Be bilingual (Chinese first, English second)
- Summarize the most important user-visible changes
- Be under 200 characters total (Chinese counts as 1 char per character, English as 1 char per letter)

**Must NOT:**
- Contain markdown links
- Contain download URLs
- Contain file names
- Start with download instructions
- Use technical jargon without context

**Example:**

✅ Good (Chinese 88 chars + English 95 chars = 183 total):
```
Collections 整理功能上线；手动分拣支持 Slot / Bracket / Cull 三模式；后台任务队列统一管理所有 AI 任务。

Collections system launched; Manual Sort now supports Slot/Bracket/Cull modes; unified job queue for all AI tasks.
```

❌ Bad (starts with download instructions):
```
Download windows-portable.zip and extract it. This release includes Collections, multi-mode sorting, and a background job queue.
```

## Fixed Section Format

Each bullet:

```markdown
- **English feature name**: English description. Technical details if needed.
  - 中文功能名：中文描述。技术细节如需要。
```

**Example:**

```markdown
- **Collections System**: Organize images into persistent named collections. Filter by collection, bulk add/remove, collection-aware navigation.
  - Collections 整理功能：将图片组织到持久化的命名集合中。按集合筛选、批量添加/移除、集合感知的导航。

- **Manual Sort Multi-Mode**: Three sort modes — Slot Mode (W/A/S/D 4-way), Bracket Mode (tournament ranking), Cull Mode (keep/delete binary).
  - 手动分拣多模式：三种分拣模式——Slot 模式（W/A/S/D 四向）、Bracket 模式（锦标赛排名）、Cull 模式（保留/删除二分）。

- **Background Job Queue**: Unified queue for tagging, similarity, aesthetic, artist ID. Live progress tracking, pause/resume, priority reordering.
  - 后台任务队列：统一管理 tagging、相似度、美学评分、画师识别等任务。实时进度跟踪、暂停/恢复、优先级调整。
```

## Upgrading Section

**Purpose:** Warn users about breaking changes, required actions, or deprecated features.

**Format:**

```markdown
## Upgrading / 升级注意

**From v3.3.x to v3.4.x:**

- Collections feature requires database migration (automatic on first launch)
- Star ratings now visible in gallery grid (was hidden by default)
- Old "Queue Solitaire" mode renamed to "Bracket Mode" in Manual Sort

**从 v3.3.x 升级到 v3.4.x：**

- Collections 功能需要数据库迁移（首次启动时自动执行）
- 星级评分现在在 gallery 网格中可见（之前默认隐藏）
- 旧的 "Queue Solitaire" 模式在手动分拣中改名为 "Bracket Mode"
```

If no breaking changes:

```markdown
## Upgrading / 升级注意

No breaking changes. Drop-in replacement for v3.3.x.

无破坏性变更。可直接替换 v3.3.x。
```

## Validation Section

**One-line CI summary:**

```markdown
## Validation / 验证

CI: backend 1949 passed / 6 failed, E2E 124 passed / 5 failed, QA gate PASS, portable boot test SUCCESS (served /, /docs, /api all 200).
```

If all green:

```markdown
## Validation / 验证

CI: backend 2139 passed / 0 failed, E2E 142 passed / 0 failed, QA gate PASS, portable boot test SUCCESS.
```

## Download Guide Section

**ALWAYS place this LAST.** This section is for GitHub web readers only — in-app users never see it.

**Use the template from Structure section above.**

## Checksums Section

**Always include SHA256 table.** Get checksums from `release-manifest.json` or run:

```bash
# Windows PowerShell
Get-FileHash -Algorithm SHA256 *.zip, *.tar.gz, *.json | Format-Table -AutoSize

# Linux/macOS
shasum -a 256 *.zip *.tar.gz *.json
```

## Complete Example

```markdown
## v3.4.0 — Collections + 多模式分拣 + 背景队列 / Collections + Multi-Mode Sort + Job Queue

Collections 整理功能上线；手动分拣支持 Slot / Bracket / Cull 三模式；后台任务队列统一管理所有 AI 任务。

Collections system launched; Manual Sort now supports Slot/Bracket/Cull modes; unified job queue for all AI tasks.

---

## Fixed / 修复

- **Collections System**: Organize images into persistent named collections. Filter by collection, bulk add/remove, collection-aware navigation.
  - Collections 整理功能：将图片组织到持久化的命名集合中。按集合筛选、批量添加/移除、集合感知的导航。

- **Manual Sort Multi-Mode**: Three sort modes — Slot Mode (W/A/S/D 4-way), Bracket Mode (tournament ranking), Cull Mode (keep/delete binary).
  - 手动分拣多模式：三种分拣模式——Slot 模式（W/A/S/D 四向）、Bracket 模式（锦标赛排名）、Cull 模式（保留/删除二分）。

- **Background Job Queue**: Unified queue for tagging, similarity, aesthetic, artist ID. Live progress tracking, pause/resume, priority reordering.
  - 后台任务队列：统一管理 tagging、相似度、美学评分、画师识别等任务。实时进度跟踪、暂停/恢复、优先级调整。

- **Star Ratings**: 1-5 star ratings visible in gallery grid. Filter by min/max stars. Bulk star assignment.
  - 星级评分：1-5 星评分在 gallery 网格中可见。按最小/最大星级筛选。批量设置星级。

- **Library Roots & Folder Tree**: Define multiple library root folders. Folder tree navigation in sidebar. Filter by folder path.
  - Library Roots 与文件夹树：定义多个库根目录。侧边栏文件夹树导航。按文件夹路径筛选。

---

## Upgrading / 升级注意

**From v3.3.x to v3.4.x:**

- Collections feature requires database migration (automatic on first launch)
- Star ratings now visible in gallery grid (was hidden by default)
- Old "Queue Solitaire" mode renamed to "Bracket Mode" in Manual Sort

**从 v3.3.x 升级到 v3.4.x：**

- Collections 功能需要数据库迁移（首次启动时自动执行）
- 星级评分现在在 gallery 网格中可见（之前默认隐藏）
- 旧的 "Queue Solitaire" 模式在手动分拣中改名为 "Bracket Mode"

---

## Validation / 验证

CI: backend 2139 passed / 0 failed, E2E 142 passed / 0 failed, QA gate PASS, portable boot test SUCCESS.

---

## ⬇️ Which file should I download? / 我该下载哪一个？

**Windows → windows-portable.zip** — extract, run run-portable.bat

**Linux → linux.tar.gz** (source, needs Python 3.12+) — extract, run ./run.sh

**Linux → linux-portable-x86_64.tar.gz** (portable, no Python needed, x86_64 CPU)

**Linux → linux-portable-aarch64.tar.gz** (portable, no Python needed, ARM CPU)

**Do NOT download / 不要下载：**
- app-patch.zip — in-app updater only / 仅供更新器
- release-manifest.json — updater metadata / 更新器元数据

---

## Checksums (SHA256)

| File | SHA256 |
|------|--------|
| sd-image-sorter-v3.4.0-windows-portable.zip | `a1b2c3d4e5f6...` |
| sd-image-sorter-v3.4.0-linux.tar.gz | `f6e5d4c3b2a1...` |
| sd-image-sorter-v3.4.0-linux-portable-x86_64.tar.gz | `123456789abc...` |
| sd-image-sorter-v3.4.0-linux-portable-aarch64.tar.gz | `abc987654321...` |
| sd-image-sorter-v3.4.0-app-patch.zip | `def123456789...` |
| release-manifest.json | `789abcdef123...` |
```

## Pre-Release Checklist

Before publishing release:

- [ ] Title line under 80 characters
- [ ] First 200 characters are bilingual summary (NOT download guide)
- [ ] Summary does not contain markdown links or file names
- [ ] Fixed section has bilingual bullets
- [ ] Upgrading section present (even if "no breaking changes")
- [ ] Validation section has CI results
- [ ] Download guide is LAST section
- [ ] Checksums table complete with all 6 assets
- [ ] All 6 assets uploaded: windows-portable, linux, linux-portable-x86_64, linux-portable-aarch64, app-patch, manifest
