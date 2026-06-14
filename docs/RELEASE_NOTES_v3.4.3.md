## v3.4.3 — 详细NL修复 + 黑屏修复 + UI/数据集工作流修复 / Detailed-NL Fix + Black-Screen Fix + UI/Dataset Workflow Fixes

「详细NL」不再输出半截 JSON（写入点解析 + 迁移清洗旧数据）；WD14+ToriiGate 改两阶段流水线，修复整机黑屏。合集支持批量加入与扫描后一键建合集；AI Auto Tagging 补上直接打开 Smart Tag 的入口，Dataset Maker 重做 Import / Workbench / Split 体验，并统一浮层定位，避免右键/下拉菜单越界。

"Detailed NL" captions no longer leak truncated JSON (parsed at write point + migration heals old rows). WD14+ToriiGate is now two-phase, fixing whole-machine black screens. Collections gain bulk add and a one-click post-scan collection; AI Auto Tagging gains a direct Smart Tag entry, Dataset Maker gets Import / Workbench / Split UX polish, and popups now share viewport-safe positioning.

---

## Fixed / 修复

- **"Detailed NL" captions were truncated raw JSON / 「详细NL」输出半截 JSON**: ToriiGate often answers `{"description": ..., "tags": ...}`; that raw text (cut off at 160 tokens) was stored straight into `nl_caption`/`ai_caption`, so exports contained broken JSON. Output is now sanitized to plain prose at the write point, prompts forbid JSON, the detailed token budget is 512, and the cloud-VLM `nl_caption` path parses JSON-shaped replies too. **Migration 019** cleans previously stored rows automatically (idempotent; only JSON-shaped text is touched).
  - ToriiGate 常回 `{"description": ..., "tags": ...}`，这段原文（且在 160 token 处截断）此前被直接存进 `nl_caption`/`ai_caption`，导出自然是烂的。现在写入点强制解析为纯句子，提示词明确禁止 JSON，详细模式 token 上限提至 512，云端 VLM 的 `nl_caption` 路径同样解析 JSON 形态回复。**迁移 019** 自动清洗历史脏数据（幂等，只动 JSON 形态文本）。

- **Whole-machine black screens during WD14+ToriiGate / WD14+ToriiGate 整机黑屏**: both models used to stay resident together; on mid-VRAM cards ToriiGate's GPU load failed and fell back to CPU float32 (~20+GB RAM), crashing the OS. Now two-phase: WD14 tags everything → releases its session → ToriiGate loads with the full GPU. Plus a GPU pre-flight headroom check, a CPU dtype guard (fp32 only with ~24GB+ free RAM, bf16 with ~13GB+, otherwise a clear error instead of an OS crash), and periodic memory-pressure checks while captioning. Booru tags persist even if the caption phase fails. Thresholds tunable via `SD_TORIIGATE_*` env vars.
  - 此前两个模型同时驻留；中等显存的卡上 ToriiGate GPU 加载失败后以 float32 回退 CPU（吃 20+GB 内存），直接把系统干崩。现在两阶段：WD14 全部打完→释放会话→ToriiGate 独占全显存加载。另有 GPU 余量预检、CPU 精度守门（空闲内存 ~24GB+ 才 fp32，~13GB+ 用 bf16，再不够明确报错而非系统崩溃）、描述阶段周期性内存压力检查。描述阶段失败时 booru 标签照常落库。阈值可用 `SD_TORIIGATE_*` 环境变量调。

- **Caption editor: NL text + tag colors / 字幕编辑器 NL 缺失与标签颜色**: "Both"/"Natural Language" modes showed only tags (a seeding path missed the `ai_caption` fallback) — fixed. Tag chips now carry the 14-category danbooru colors; switching content mode refreshes the preview immediately.
  - 「两者」/「自然语言」模式只显示标签（一条数据填充路径漏了 `ai_caption` 兜底）——已修。标签芯片带上 14 类 danbooru 分类颜色；切换内容模式即时刷新预览。

- **Popup positioning + collection picker / 浮层定位与加入合集**: selection-panel "Add to collection" now opens a picker instead of silently doing nothing. Gallery right-click menus, collection pickers, Tools, update popups, autocomplete, and other coordinate-based overlays use a shared viewport-safe positioner that handles UI zoom and screen edges.
  - 多选面板「加入合集」现在会正常打开选择器，不再静默无反应。图库右键菜单、合集选择器、Tools、更新弹窗、自动完成等坐标型浮层统一走同一套视窗安全定位，处理 UI 缩放与屏幕边界。

- **Dataset Maker Split UI / Dataset Maker 分割比较界面**: Split now opens a real two-card comparison editor with current/next image previews, separate Booru and natural-language text areas, clear labels, open-next/close actions, and no overlap with the base editor controls.
  - 「分割」现在是可用的双卡比较编辑器：当前/下一张图片预览、Booru 与自然语言独立文本框、清楚的标签、打开下一张/关闭操作，并且不会被原编辑器按钮遮挡。

- **Disk usage and scan completion refresh / 磁盘占用与扫描完成刷新**: cache/runtime usage now reports exact byte counts from an iterative `os.scandir` scan instead of "Large / not fully scanned"; after scans complete the folder tree refreshes automatically.
  - 缓存/运行时占用改用迭代式 `os.scandir` 精确扫描并显示真实数值，不再显示「较大 / 未完整扫描」；扫描完成后左侧 Folders 树会自动刷新。

- **Training-purpose tag filtering / 训练用途标签过滤**: the Smart Tag purpose selector now applies to the actual final caption/tag rows. The rule is intentionally conservative: official Kohya/Diffusers training docs define caption mechanics (caption files/columns, comma-token shuffling, keep tokens), not a universal "style/character/concept LoRA must delete these tags" table. Style removes only clearly style/artist-like general tags; Character removes detected character names only when a trigger word is set; General/Concept preserve context.
  - Smart Tag「训练用途」现在真正作用到最终 caption 与落库 tag rows。规则刻意保守：Kohya/Diffusers 官方训练文档定义的是 caption 机制（caption 文件/字段、逗号 token shuffle、keep tokens），不是「风格/角色/概念 LoRA 必删标签表」。Style 只移除明确像风格/画师的 general tags；Character 只有设置 trigger word 时才移除检测到的角色名；General/Concept 保留上下文。

- **`@xxx` / `artist:xxx` are artist tags / `@xxx`、`artist:xxx` 归画师类**: Anima-style `@name` and SDXL-style `artist:name` prompts now categorize and color as artist/style.
  - Anima 的 `@名字`、SDXL 的 `artist:名字` 现在归入画师分类并显示对应颜色。

## Added / 新增

- **ToriiGate options + tag grounding / ToriiGate 参数与标签辅助**: description length select (detailed default / brief) and a default-on "ground with booru tags" toggle that feeds WD14 tags into ToriiGate for more accurate descriptions.
  - 新增「描述长度」选择（默认详细，可选简短）与默认开启的「以 booru 标签辅助」开关——把 WD14 标签喂给 ToriiGate 做参照，描述更准。

- **Bulk add to collection / 批量加入合集**: new `POST /api/collections/{id}/items/bulk` (explicit ids or a selection token covering the whole filtered scope); the multi-select panel gains an "Add to collection" button; the right-click picker uses one bulk call.
  - 新增批量接口（显式 id 列表或筛选范围 token）；多选面板新增「加入合集」按钮；右键加入合集改为一次批量调用。

- **One-click collection after scan / 扫描后一键建合集**: the scan-done banner offers "Create collection" — named after the folder, bulk-adding everything just imported, so separate datasets stop blurring together.
  - 扫描完成横幅新增「建立合集」——按文件夹命名并把刚导入的图批量加入，不同数据集不再混在一起。

- **VLM caption parameters in UI / VLM 描述参数进界面**: caption `max_tokens` (was hardcoded 1024) and `temperature` (0.3) now configurable in VLM Advanced Settings, plus previously backend-only retry delay, max image size, and NSFW retry prompt.
  - 描述用 `max_tokens`（此前写死 1024）与 `temperature`（0.3）可在 VLM 高级设置调整，并补上重试间隔、最大图片尺寸、NSFW 重试提示词。

- **Multi-line, persistent custom templates / 自订模板多行+记忆**: template override fields are textareas — free words, spaces, and blank lines around `{placeholders}` survive into the output; content persists across reloads.
  - 模板覆盖框改多行——`{占位符}` 周围的自由文字、空格、空行保留进输出；内容跨刷新记忆。

- **Smart Tag forces `nl_caption` / Smart Tag 强制自然语言格式**: per-job VLM config pins `output_format=nl_caption`, so JSON-analysis presets can't corrupt caption runs.
  - 每任务 VLM 配置强制 `output_format=nl_caption`，JSON 分析预设不会再污染描述任务。

- **Smart Tag entry points + navigation polish / Smart Tag 入口与导航整理**: AI Auto Tagging now exposes a prominent Smart Tag action that opens the Smart Tag modal directly. Dataset Maker keeps its Smart Tag entry, while Mass Tag Editor entry points default to the scope users expect: current selection from the selection panel, current filter from the filter modal. Prompt Helper and Style Finder appear directly in the top bar when space allows and move under More only when the nav would overflow.
  - AI Auto Tagging 现在提供醒目的 Smart Tag 入口，并直接打开 Smart Tag 弹窗。Dataset Maker 保留原有 Smart Tag 入口；Mass Tag Editor 从不同入口打开时会自动使用使用者预期范围：多选面板=当前选择、Filter 视窗=当前筛选。Prompt Helper 与 Style Finder 在空间足够时直接显示，只有导航会溢出时才收进「更多」。

- **Dataset Maker Import / Workbench polish / Dataset Maker 导入与工作台打磨**: Step 1 now separates quick Gallery import, larger folder import, and Audit into clearer cards. Step 2 gives more width and height to the image/caption editor, with the side panes tightened so editing work gets the primary space.
  - Step 1 改成更清楚的卡片式入口：图库快速导入、较大的文件夹导入、Audit 辅助检查。Step 2 把更多宽度和高度给图片 / caption 编辑区，左右侧栏收紧，让真正编辑的内容拿到主空间。

- **Generator rail overflow / 生成器筛选栏防溢出**: All stays pinned, while NovelAI / ComfyUI / Forge / WebUI / Unknown / Others and future generator filters scroll horizontally inside the rail instead of pushing buttons out of the UI.
  - 「全部」固定可见，NovelAI / ComfyUI / Forge / WebUI / 未知 / Others 以及未来新增生成器在栏内横向滚动，不再把按钮挤出界面。

---

## Upgrading / 升级注意

- Migration 019 runs automatically on first start and only rewrites JSON-shaped `nl_caption`/`ai_caption` text; clean rows are untouched.
  - 迁移 019 首次启动自动执行，只改写 JSON 形态的描述文本，干净数据不动。
- ToriiGate now defaults to **detailed** descriptions (slower per image); switch to "brief" in Smart Tag's ToriiGate options for the old speed.
  - ToriiGate 默认改为**详细**描述（单张更慢）；想要旧速度可在 ToriiGate 选项切回「简短」。
- **If you upgrade by unzipping into a NEW folder / 手动解压到新文件夹升级**: copy the old folder's entire `data` directory first — it holds your library database and ALL downloaded models.
  - 请先把旧文件夹的整个 `data` 目录复制过去——里面有你的图库数据库和所有已下载模型。

---

## Validation / 验证

- Release-candidate validation run in this workspace on 2026-06-15:
  - `python scripts/run_ci.py` — passed: lockfile freshness, dependency security audit, frontend JS syntax, ruff, 2145 backend pytest, and Playwright E2E (142 passed, 5 skipped).
  - `python scripts/build_release_packages.py --version 3.4.3` — passed: built Windows portable, app patch, Linux source, Linux portable x86_64, Linux portable aarch64, and the release manifest.
  - `python scripts/lazy_release_qa.py --skip-server` — passed: release package integrity and manifest checksum validation.
  - Real Windows portable boot smoke from the freshly-built `sd-image-sorter-v3.4.3-windows-portable.zip` — passed: extracted package, ran `run-portable.bat`, completed first-launch lightweight dependency setup, served `/` over HTTP 200, and `/api/support/diagnostics` reported `app_version=3.4.3`.

---

## ⬇️ Which file should I download? / 我该下载哪一个？

**Windows → `sd-image-sorter-v3.4.3-windows-portable.zip`** — extract, run `run-portable.bat`.

**Linux portable x86_64 → `sd-image-sorter-v3.4.3-linux-portable-x86_64.tar.gz`** — extract, `chmod +x run-portable.sh`, run `./run-portable.sh`.

**Linux portable aarch64 → `sd-image-sorter-v3.4.3-linux-portable-aarch64.tar.gz`** — for ARM Linux / Raspberry Pi 5 / Graviton.

**Linux source install → `sd-image-sorter-v3.4.3-linux.tar.gz`** — for users with their own Python 3.12+ environment.

**Do NOT download / 不要下载：**
- `sd-image-sorter-v3.4.3-app-patch.zip` — in-app updater payload only / 仅供更新器
- `sd-image-sorter-v3.4.3-release-manifest.json` — updater metadata / 更新器元数据

---

## Checksums

See `sd-image-sorter-v3.4.3-release-manifest.json` for SHA-256 checksums of all release assets.
