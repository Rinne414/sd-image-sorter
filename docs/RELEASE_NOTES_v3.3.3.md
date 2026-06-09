## v3.3.3 — UI/UX 大改 + 工作流打通 / UI Overhaul + Workflow Wiring

界面按真实流程重排，设置与模型集中到一个入口；预览、选择、扫描、打标、整理完成后都有下一步操作。星级评分、单图分析、更新代理、Prompt Lab 数据工具、VLM 管理等后端能力已接上。

The UI now follows the real image workflow, Settings & Models is the single setup door, and post-action screens guide the next step. Star ratings, per-image analysis, update proxy, Prompt Lab tools, and VLM management are now wired.

---

## Fixed / 修复

- **Pipeline-first UI / 流程优先界面**: core navigation now follows Gallery / Reader → Sort → Censor Edit → Similar → Dataset, with Prompt Lab and Artist ID under Tools.
  - 核心导航按图库 / 读图 → 整理 → 打码编辑 → 相似图 → 数据集排列，Prompt Lab 与画师识别收进 Tools。
- **Settings & Models / 设置与模型**: one Settings door now owns model guidance, model downloads, disk usage, sound mute, UI scale, and saved AI defaults.
  - 设置与模型成为统一入口，集中模型指引、模型下载、磁盘占用、声音静音、界面缩放与 AI 默认值保存。
- **No more dead-end actions / 操作后不再断线**: scan, tag, sort, preview, and selection flows now expose next-step CTAs or handoff buttons.
  - 扫描、打标、整理、预览与选择流程会显示下一步 CTA 或交接按钮。
- **Backend features now reachable / 后端能力补上入口**: user star ratings, per-image Score / Colors / Artist / Caption actions, VLM provider auto-detect, update proxy/channel settings, Prompt Lab recategorize/delete tools, and local Ollama VLM model delete are wired into the UI.
  - 用户星级评分、单图美学 / 颜色 / 画师 / 描述、VLM provider 自动识别、更新代理/通道设置、Prompt Lab 重新分类/删除、本地 Ollama VLM 模型删除都已接到前端。
- **Unified tagging coordinator / 统一打标协调器**: Gallery AI Tag and Dataset Smart Tag now share one backend coordinator so heavy tagger/VLM jobs cannot run as two independent pipelines.
  - Gallery AI Tag 与 Dataset Smart Tag 共用一个后端协调器，避免两个重型打标 / VLM 流程各自独立运行。
- **Noise reduction / 降低界面噪音**: Queue Manager filters, Dataset notices, Censor shortcuts, caption editor secondary tools, and Gallery selection secondary actions are collapsed until needed.
  - Queue Manager 筛选、Dataset 提示、打码快捷键、caption 编辑器次级工具与图库选择次级动作默认收起，需要时再展开。
- **Censor naming cleanup / 打码命名统一**: the view/tool name is now consistently **Censor Edit / 打码编辑**.
  - 视图与工具名统一为 **Censor Edit / 打码编辑**。
- **Cache-busting / 缓存失效**: frontend JS/CSS served by the backend now refreshes with the app version, reducing stale-UI upgrade failures.
  - 后端提供的前端 JS/CSS 会随版本刷新，减少升级后继续加载旧界面的情况。

---

## Upgrading / 升级注意

- **Zero manual steps.** v3.3.3 does not add a database schema migration. New UI preferences use browser `localStorage`; existing libraries, model files, captions, tags, and image files are untouched.
  - **零手动操作。** v3.3.3 不新增数据库结构迁移。新增 UI 偏好使用浏览器 `localStorage`；既有图库、模型文件、caption、标签和图片文件不受影响。
- If the UI looks stale after updating, press normal browser refresh once. The backend now serves versioned static assets, so a hard cache clear should not be needed.
  - 如果更新后界面看起来仍是旧版，普通刷新一次即可。后端现在提供带版本的静态资源，一般不需要硬清缓存。

---

## Validation / 验证

- Targeted backend tests for the unified tagging coordinator, tag routers, Smart Tag, Dataset export golden gate, VLM, colors, artists, prompts, and update services passed during the overhaul.
- Frontend syntax checks passed for all changed JS files in the final UI/UX phases.
- Live desktop Playwright fallback checks passed at 1440×900 and 1366×768 for Settings, AI defaults persistence, Censor Edit naming, all 8 views, and preview modal open/close with zero console errors.
- Full `scripts/run_ci.py` passed: lock freshness, dependency security audit, frontend JS syntax, ruff lint, backend full suite, and Playwright E2E (`124 passed / 5 skipped`).
- `scripts/build_release_packages.py --version 3.3.3` built all 6 required assets; `scripts/lazy_release_qa.py --skip-server` passed manifest and checksum integrity.
- Real Windows portable smoke passed from `sd-image-sorter-v3.3.3-windows-portable.zip`: `run-portable.bat` booted on port 8498, `/api/stats` reported `app_version: 3.3.3`, and `/api/images` returned 200.

---

## ⬇️ Which file should I download? / 我该下载哪一个？

**Windows → `sd-image-sorter-v3.3.3-windows-portable.zip`** — extract, run `run-portable.bat`.

**Linux portable x86_64 → `sd-image-sorter-v3.3.3-linux-portable-x86_64.tar.gz`** — extract, `chmod +x run-portable.sh`, run `./run-portable.sh`.

**Linux portable aarch64 → `sd-image-sorter-v3.3.3-linux-portable-aarch64.tar.gz`** — for ARM Linux / Raspberry Pi 5 / Graviton.

**Linux source install → `sd-image-sorter-v3.3.3-linux.tar.gz`** — for users with their own Python 3.12+ environment.

**Do NOT download / 不要下载：**
- `sd-image-sorter-v3.3.3-app-patch.zip` — in-app updater payload only / 仅供更新器
- `sd-image-sorter-v3.3.3-release-manifest.json` — updater metadata / 更新器元数据

---

## Checksums

See `release-manifest.json` for SHA-256 checksums of all release assets.
