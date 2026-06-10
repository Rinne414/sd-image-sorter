## v3.4.0 — 全面体检：流程可靠性 + 范围保真 / Full-Audit Reliability + Scope Fidelity

三路全面体检（前端 UI/UX、后端、端到端流程）后的可靠性大版本：标签分类恢复正确（保护 LoRA caption 导出）；批量操作与整理范围和你筛选的完全一致；长任务如实报错、F5 可恢复；打码保存后缩略图立即更新。

Reliability release after a three-track audit: tag categories fixed (protecting LoRA caption exports), bulk/sort scopes now match your filters exactly, long jobs report real errors and survive reloads, censored thumbnails refresh instantly.

---

## Fixed / 修复

- **Tag categorization regression / 标签分类回归**: since v3.3.3 common outfit/action tags (tank_top, pencil_skirt, winter_coat, holding_egg…) were misrouted to "background"; dataset export "remove background tags" could silently strip clothing tags from LoRA training captions. Rules reordered with a garment veto, locked by regression tests.
  - v3.3.3 起 tank_top、pencil_skirt、winter_coat 等常见服装/动作标签被误分到"背景"，数据集导出勾选"移除背景标签"会悄悄删掉训练 caption 里的服装标签。已重排规则并用回归测试锁定。
- **Bulk tag operations skipped images / 批量标签漏图**: mass remove/find-replace paged the same shrinking result set while committing per chunk — with 500+ matches roughly half were silently skipped. All bulk scopes (tags, Smart Tag, VLM batch) now snapshot matching IDs before mutating.
  - 批量移除/查找替换边改边翻页，超过 500 张时约一半被静默跳过。现在所有批量范围先快照 ID 再修改。
- **Sorting scope fidelity / 整理范围保真**: Auto-Separate "Copy from Gallery", WASD manual sort, and batch-move now honor collection, folder, star-rating, exclude-prompts/colors, and brightness filters — the moved set equals what the gallery shows, and the "matches gallery" indicator is truthful.
  - 自动分流"从图库复制"、WASD 手动整理与批量移动现在完整继承合集/文件夹/星级/排除词/明暗筛选，移动范围与图库所见一致，"与图库筛选一致"指示不再误报。
- **Job reliability overhaul / 任务可靠性整顿**: scan progress no longer freezes when polled during startup; Dataset Maker "Tag all" attaches the real progress bar; aesthetic/artist batch crashes show errors instead of success toasts; Smart Tag and VLM batches retry transient errors, resume after F5 (cancel reachable again), and VLM batch covers the full filtered set instead of only the loaded page.
  - 扫描刚启动时轮询不再卡死；数据集制作"全部打标"接上真实进度条；美学/画师批次崩溃时如实报错；Smart Tag 与 VLM 批次可重试瞬时错误、F5 后可恢复并能取消、VLM 范围覆盖全部筛选结果。
- **One AI job at a time / 同时只跑一个 AI 任务**: gallery tagging, Smart Tag, and VLM caption batches are mutually exclusive under one coordinator (clear 409 message), preventing double GPU model loads and caption double-writes.
  - 图库打标、Smart Tag 与 VLM 批量描述纳入同一协调器互斥（409 + 双语提示），避免 GPU 双载模型与 caption 重复写入。
- **Censored thumbnails refresh immediately / 打码后缩略图立即更新**: thumbnail URLs are versioned by file modification time; overwriting in Censor Edit no longer shows the uncensored cached thumbnail for up to 24 hours.
  - 缩略图 URL 按文件修改时间加版本号，打码覆盖保存后图库立即显示已打码图，不再被浏览器缓存 24 小时。
- **Exact prompt exclusion / 精确排除词**: excluding "cat" in exact mode no longer hides "catgirl"/"scattered".
  - exact 模式排除 "cat" 不再连 "catgirl"/"scattered" 一起隐藏。
- **Desktop UX polish / 桌面体验打磨**: Tools menu positions correctly on 2K/4K auto-zoom; "Teach categories" from the preview closes it before opening Prompt Lab; "Build prompt from this image" works for older images beyond the recent-200 catalog; large model downloads no longer show a false "stalled" warning after 4 minutes; filter summaries keep their colons and missing Chinese translations were filled in.
  - 2K/4K 自动缩放下 Tools 菜单定位正确；预览窗内"教分类"会先关闭预览；"用此图构建 Prompt"对旧图也有效；大模型下载不再误报"卡住"；筛选摘要冒号与缺失的中文翻译已补齐。

---

## Upgrading / 升级注意

- **Zero manual steps.** v3.4.0 does not add a database schema migration. Existing libraries, image files, captions, model files, tags, and ratings are untouched.
  - **零手动操作。** v3.4.0 不新增数据库结构迁移。既有图库、图片文件、caption、模型文件、标签与评分不受影响。
- API note: starting a tagging / Smart Tag / VLM job while another runs now returns 409 (previously sometimes 400).
  - API 提示：AI 任务互斥冲突现在统一返回 409（此前部分场景为 400）。

---

## Validation / 验证

- Full CI green on the release tree: backend suite 2000+ tests passed, Playwright E2E 133 passed / 5 skipped, ruff lint, frontend JS syntax, dependency lock and security audit all passed; new regression tests added for every fixed finding (tag categories, bulk snapshot, sorting scope, scan poller).

---

## ⬇️ Which file should I download? / 我该下载哪一个？

**Windows → `sd-image-sorter-v3.4.0-windows-portable.zip`** — extract, run `run-portable.bat`.

**Linux portable x86_64 → `sd-image-sorter-v3.4.0-linux-portable-x86_64.tar.gz`** — extract, `chmod +x run-portable.sh`, run `./run-portable.sh`.

**Linux portable aarch64 → `sd-image-sorter-v3.4.0-linux-portable-aarch64.tar.gz`** — for ARM Linux / Raspberry Pi 5 / Graviton.

**Linux source install → `sd-image-sorter-v3.4.0-linux.tar.gz`** — for users with their own Python 3.12+ environment.

**Do NOT download / 不要下载：**
- `sd-image-sorter-v3.4.0-app-patch.zip` — in-app updater payload only / 仅供更新器
- `sd-image-sorter-v3.4.0-release-manifest.json` — updater metadata / 更新器元数据

---

## Checksums

See `release-manifest.json` for SHA-256 checksums of all release assets.
