## v3.4.1 — Smart Tag 跳过已标记 + 提示词与打码修复 / Skip-Tagged + Prompt & Censor Fixes

Smart Tag 新增"跳过已有 AI 标签的图片"（默认开启），大库重复打标不再浪费 GPU；修复 ComfyUI 运行时提示词抽到上一轮旧值，以及三处假功能：SAM3 置信度滑块、一键自动打码按钮、统计面板标签点击。

Smart Tag gains a default-on "skip already-tagged images" option; fixes stale ComfyUI runtime prompts and three non-functional UI surfaces: the SAM3 confidence slider, the Quick Auto Censor button, and Analytics tag clicks.

---

## Added / 新增

- **Smart Tag skip-existing / 跳过已标记**: the documented `skip_existing` option is now actually implemented. Images whose `tagged_at` marker is set (the same definition the gallery's untagged filter uses — a run that matched zero tags still counts) are skipped before any tagger or VLM call. Works for selected images and filter/selection scopes; Dataset Maker local-file sources are never skipped. The progress payload and completion message report the skipped count. If the tag-state lookup fails, the run fails open and processes everything instead of silently dropping work.
  - 文档中的 `skip_existing` 参数此前从未生效，现已真正实现。以 `tagged_at` 标记判定已标记（与图库"未标记"筛选同一定义；打过标但零命中的图也算），在 tagger 与 VLM 调用之前直接跳过。选中图片与筛选范围都生效；数据集制作的本地文件来源不受影响。进度与完成信息显示跳过数量；查询失败时宁可全量重打也不静默丢图。

## Fixed / 修复

- **ComfyUI runtime-generated prompts / ComfyUI 运行时生成的提示词**: workflows where a VLM (e.g. Qwen3-VL) builds the positive prompt at runtime and feeds CLIPTextEncode through a ShowText node used to extract a stale cached prompt from a previous run — queuing 5 images in a batch stamped all 5 with an older, different image's prompt. The parser now resolves current-run literals upstream first (including DanbooruGallery selections — the run's actual source post) and falls back to display caches only when nothing else is recoverable. Re-parse affected images via the preview window's "Re-read info" or by rescanning the folder.
  - 正向提示词由 VLM（如 Qwen3-VL）在运行时生成、经 ShowText 接入 CLIPTextEncode 的工作流，以前会抽到上一轮的陈旧缓存——一次排队 5 张会让 5 张全部带上更早另一张图的提示词。解析器现在优先回溯本轮的字面值（包括 DanbooruGallery 的本轮选图），全部不可得时才退回显示缓存。受影响的图片可用预览窗"重新读取信息"或重新扫描该文件夹刷新。

- **SAM3 confidence slider now works / SAM3 置信度滑块真正生效**: the censor editor's confidence slider was sent to the API but never consumed — refinements always ran at fixed thresholds. The value now gates both the mask score and the text-prompt presence check; low-confidence refinements fall back to bounding-box censoring (counted separately in the UI). The API gains an optional `sam3_confidence` field on refine-mask, with per-item batch overrides.
  - 打码编辑器的置信度滑块此前虽随请求发送但后端从未使用——细化始终按固定阈值跑。现在滑块同时控制掩码得分与文本提示存在性两道门槛；低置信度的细化退回边界框打码（UI 单独计数）。API 在 refine-mask 上新增可选 `sam3_confidence` 字段，批量请求支持逐项覆盖。

- **Quick Auto Censor button restored / 一键自动打码按钮恢复**: the one-click "detect + censor the whole queue" flow had a live handler and help copy, but the button itself was missing from the page. It is back in the censor sidebar's Auto Detect card; the underlying pipeline was audited end-to-end and needed no repairs.
  - 「检测+打码整个队列」的一键流程有完整处理逻辑和帮助文案，但页面上的按钮本身丢失。按钮已恢复到打码侧栏的自动检测卡片中；底层流程经逐行审计无需修复。

- **Analytics tag click no longer crashes / 统计面板标签点击不再崩溃**: clicking a tag in the Analytics panel threw a silent error against a removed DOM element — the filter was applied internally but the modal never closed and the gallery never reloaded. Tag clicks now use the same renderer as the rest of the tag filter UI.
  - 在统计面板点击标签会对已被移除的 DOM 元素抛出静默错误——筛选内部已生效，但弹窗不关闭、图库也不刷新。现在与其余标签筛选 UI 使用同一渲染路径。

---

## Upgrading / 升级注意

- **Zero manual steps.** v3.4.1 does not add a database schema migration. Existing libraries, image files, captions, model files, tags, and ratings are untouched.
  - **零手动操作。** v3.4.1 不新增数据库结构迁移。既有图库、图片文件、caption、模型文件、标签与评分不受影响。
- If you routinely re-tag existing images with Smart Tag, uncheck the new "Skip images that already have AI tags" box in the Smart Tag dialog (it defaults to on).
  - 如果你习惯用 Smart Tag 对已标记图片重新打标，请取消勾选新的"跳过已有 AI 标签的图片"（默认开启）。

---

## Validation / 验证

- Full CI green on the release tree: backend suite (incl. new skip-existing, SAM3-confidence and censor-router regression tests) passed, Playwright E2E passed (incl. a new Quick Auto Censor reachability test), ruff lint, frontend JS syntax, dependency lock and security audit all passed.

---

## ⬇️ Which file should I download? / 我该下载哪一个？

**Windows → `sd-image-sorter-v3.4.1-windows-portable.zip`** — extract, run `run-portable.bat`.

**Linux portable x86_64 → `sd-image-sorter-v3.4.1-linux-portable-x86_64.tar.gz`** — extract, `chmod +x run-portable.sh`, run `./run-portable.sh`.

**Linux portable aarch64 → `sd-image-sorter-v3.4.1-linux-portable-aarch64.tar.gz`** — for ARM Linux / Raspberry Pi 5 / Graviton.

**Linux source install → `sd-image-sorter-v3.4.1-linux.tar.gz`** — for users with their own Python 3.12+ environment.

**Do NOT download / 不要下载：**
- `sd-image-sorter-v3.4.1-app-patch.zip` — in-app updater payload only / 仅供更新器
- `sd-image-sorter-v3.4.1-release-manifest.json` — updater metadata / 更新器元数据

---

## Checksums

See `release-manifest.json` for SHA-256 checksums of all release assets.
