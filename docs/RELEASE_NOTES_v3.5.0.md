## v3.5.0 — 清爽极光重设计 + 任务入口页 / Fresh Aurora Redesign + Mission Entry

全局换新 v4.0「清爽极光」设计语言：任务入口页（顶栏保持经典布局、品牌区一键回入口），图库搜索工具栏、底部批量操作条与可视缩图大小控制、排序专注模式与命名预设、打码审核流水线、「智能一趟」打标入口、Caption 双框编辑器统一。超大库批量操作转为可取消的后台任务，AI 队列跨重启持久化，Linux NVIDIA 修复 GPU 打标。功能零删除。

The v4.0 "Fresh Aurora" redesign lands: a mission entry page (the top bar keeps its classic layout, brand click returns to the entry), gallery toolbar search + a bottom batch action bar + a visible thumbnail-size control, sort focus mode & named presets, a censor review conveyor, a one-pass Smart Tag entry, and the caption editors consolidated into one two-box model. Huge-library bulk ops become cancellable background jobs, the AI queue survives restarts, and Linux NVIDIA machines get GPU tagging. Zero feature removals.

---

## Added / 新增

- **Mission entry page / 任务入口页**: launch surface with the four mission lanes (LoRA dataset / Pixiv set publishing / batch organize / free mode), live-count function tiles, a resume slab for saved manual-sort sessions, a daily ★5 full-bleed cover with 换一张 / 不想展示, and an activity streak. Top-level ESC returns to the entry without losing view state; Settings gains 跳过入口页 and ★5 门面 toggles. Backed by `GET /api/entry/summary` + `activity_log` daily counters (migration 020).
  - 新增任务入口页：四条任务动线（LoRA 数据集 / Pixiv 成套发布 / 批量整理 / 自由模式）、实时数字功能马赛克、手动分拣「接着上次」锚块、每日 ★5 全屏门面（换一张 / 不想展示）、连续整理天数。顶层 ESC 随时回入口且不丢视图状态；设置新增「跳过入口页」「★5 门面」开关。后端新增 `GET /api/entry/summary` 与 `activity_log` 日计数（migration 020）。

- **Top bar stays, brand returns to the entry / 顶栏保留、品牌区回入口**: navigation keeps the classic fixed top bar (a left-rail experiment was reverted on owner review), and clicking the brand block (or Enter / Space on it) returns to the mission entry page — even with 跳过入口页 enabled. The gallery toolbar also gains a visible − slider + thumbnail-size control (120–400px, live in grid / large / waterfall, persisted; `[` `]` step the same value), and the entry page is recomposed: calm equal-geometry tiles under Missions / Tools labels, an aurora gradient instead of a black void when no ★5 cover is set, and a bottom-left greeting + live stats (library / added today / handled today / streak).
  - 导航保持经典顶部固定栏（左侧导航栏实验按所有者反馈回退），点击品牌区（或在其上按 Enter / 空格）即可回任务入口页——开了「跳过入口页」也有效。图库工具栏新增可见的「− 滑杆 +」缩图大小控制（120–400px，网格/大图/瀑布流实时生效、重启后记住；`[` `]` 与滑杆同源）；入口页同步重排：任务/工具分组标签下等宽等高卡片、无 ★5 门面时显示极光渐层而非一片黑、左下新增问候语与实时统计（库内 / 今日新增 / 今日已处理 / 连续天数）。

- **Gallery toolbar search, quick chips + bottom action bar / 图库搜索、快捷筛选与底部批量操作条**: a key:value search box (`tag:` `checkpoint:` `lora:` `seed:` + free text) feeding the same filter store as the filter modal, one-click chips (有参数 / 美学 7+ / 无字幕), and batch actions in a floating bottom bar — Move / Tag / Censor Edit / Add to collection up front, the rest under More ▾ with destructive actions separated. The filter modal previews a live "≈N images" hit count, the aesthetic Unscored tier is a real filter, and selection turns pink with ♥ pick-order badges.
  - 新增 key:value 搜索框（`tag:` `checkpoint:` `lora:` `seed:` + 自由文本，与筛选弹窗共用状态）、「有参数 / 美学 7+ / 无字幕」快捷片；批量操作移到底部悬浮操作条——移动 / 打标 / 打码编辑 / 加入合集直接可点，其余收进「更多 ▾」，危险操作用分隔线隔离。筛选弹窗实时预览「预计 N 张」，美学「未评分」档变成真筛选，选中改为粉色描边 + ♥ 挑选顺序徽章。

- **Sort stage: live count, focus mode, named presets / 排序台：实时计数、专注模式、命名预设**: the setup card shows a live "≈N images in scope" count; a 🧘 focus mode hides the top nav bar so the WASD stage fills the screen; named presets save/load/delete the entire setup (folders, collection slots, layout, mode, action, filters); the HUD gains a mute toggle and the progress line shows percent + images/min.
  - 排序设置卡实时显示「范围内约 N 张图片」；🧘 专注模式隐藏顶部导航栏、WASD 舞台全屏；命名预设保存/载入/删除整套配置（文件夹、收藏夹槽位、布局、模式、动作、筛选）；HUD 新增静音开关，进度行显示百分比与「张/分」速度。

- **Censor sidebar tabs + review conveyor / 打码侧栏分页 + 审核流水线**: the right sidebar becomes three tabs — 画笔 Brush (all existing tools, unchanged), 调整 Adjust (photo filters), and the new 审核 Review conveyor: detect the current image, check/uncheck each region (unchecked stays uncensored), then Approve & Next bakes the kept regions and auto-advances (Prev / Next / Skip included). Detection boxes draw on a preview layer that is never saved into the image.
  - 打码右侧栏改为三个分页：画笔（原有工具全部保留）、调整（照片滤镜）、审核（新流水线：检测当前图 → 逐区域勾选/取消（取消=保留不打码）→「通过并下一张」烘焙勾选区域并自动前进，含上一张/下一张/跳过）。检测框画在独立预览层上，永不写入保存结果。

- **Tagger 智能一趟 landing tab / 打标弹窗「智能一趟」落地页**: the AI tag modal gains a Smart Tag one-pass tab in first position — it opens the full Smart Tag workspace (booru taggers with optional voting, cleanup, trigger word, optional caption) and forwards the armed Gallery selection scope. Gallery 选中打标 lands here; the global AI Tag button still opens the Local tagger tab directly.
  - 打标弹窗新增第一个分页「智能一趟」：一键打开完整 Smart Tag 工作区（booru 打标器可选投票、清洗、触发词、可选描述），自动带上图库已选范围。图库选中后点「打标」默认落在这里；全局「AI 打标」按钮仍直达本地打标分页。

- **Caption preview health strip + trigger check / Caption 预览健康条 + 触发词检查**: the batch-export caption preview always shows a checks strip (edited / empty / blacklist hits / duplicates / max tokens, plus missing-trigger when a trigger word is set); images missing the trigger word carry a ⚑ badge.
  - 批量导出 caption 预览常驻「检查」健康条（已编辑 / 空 caption / 黑名单命中 / 重复词 / 最多标签，设触发词时统计「缺触发词」）；缺触发词的图片带 ⚑ 徽章。

- **Caption editors consolidated / Caption 编辑器统一 (双框模型)**: the batch-export Caption Editor adopts the Dataset Maker two-box model — per-image Booru / Both / NL segment, an editable NL box seeded from the stored VLM sentence, a live "Will export" composed line, B+N / NL queue chips, bulk set/auto-assign. `/api/tags/export-batch` + `/api/tags/export-combined` accept the same `image_types` + `image_nl_overrides` as the dataset export (absent = unchanged output); both engines share one compose rule, so the preview text is exactly what lands in the sidecar.
  - 批量导出 Caption 编辑器与 Dataset Maker 双框编辑器统一：逐图 Booru / 两者 / NL 分段、可编辑 NL 框（带出已存 VLM 句子）、实时「导出效果」合成行、队列 B+N / NL 徽章、批量设置/自动分配。`/api/tags/export-batch` 与 `/api/tags/export-combined` 接受与数据集导出相同的 `image_types` + `image_nl_overrides`（不传=输出不变）；两套引擎共用同一条合成规则，预览即所得。

- **Dataset export manifest / 数据集导出清单**: every dataset export writes an `export_manifest.json` — settings snapshot, per-image results, and counts — so a training set's provenance is reproducible.
  - 数据集导出附带 `export_manifest.json`：设置快照、逐图结果与统计，训练集来源可复现。

- **Missing-file repair review / 移动文件修复审查**: ambiguous Find-Moved-Images matches persist as reviewable items — a modal previews the found file, lists candidate records, and commits relink / relink+remove-others / skip per row (migration 021).
  - 「找回移动的图片」的不确定匹配会保存下来供审查——弹窗预览找到的文件、列出候选记录，逐条确认重连 / 重连并移除其余 / 跳过（migration 021）。

- **Background bulk jobs + persistent AI queue / 后台批量任务 + AI 队列持久化**: huge Gallery delete / remove / sidecar-export selections run as cancellable background jobs with real progress; the AI job queue (tagging / Smart Tag / VLM batches) persists to disk and re-queues after a restart.
  - 超大图库删除/移出/同名导出改为可取消的后台任务并显示真实进度；AI 任务队列（打标 / Smart Tag / VLM 批次）落盘持久化，重启后按原顺序恢复。

- **Smart Tag VLM grounding toggle / Smart Tag VLM 标签辅助开关**: VLM captioning can explicitly disable booru-tag context (default stays on).
  - Smart Tag VLM 描述可显式关闭 booru 标签上下文辅助，默认仍开启。

- **Dataset caption polish quick actions / Dataset caption 微调快捷动作**: Clear prefix, Reset template, and Refresh Chinese reading aid are now real controls with handlers.
  - Dataset Caption 微调补上清空前缀、重置模板、刷新中文阅读辅助等真实控件。

## Changed / 变更

- **Fresh Aurora visual system / 「清爽极光」视觉系统**: the new last-loaded `frontend/css/tokens.css` owns the global palette — blue-tinted dark surfaces, three semantic accents (blue #5CC8FF = next action, pink #FF8FC0 = user decisions, purple #A78BFF = AI output), unified 2px blue focus rings, solid-blue primary buttons with dark ink, a flat canvas, and Noto Sans SC + IBM Plex Mono + Oswald typography. ~470 hardcoded legacy colors across 13 stylesheets now reference tokens, and every primary action button is the single clean Aurora blue (legacy orange primaries retired).
  - 全新最后加载的 `frontend/css/tokens.css` 接管全局配色：蓝调暗色表面、三个各司其职的强调色（蓝=下一步、粉=用户决定、紫=AI 产物）、统一 2px 蓝色焦点圈、实心蓝主按钮配深色文字、平坦画布、思源黑体 + IBM Plex Mono + Oswald 字体组。13 个样式表约 470 处硬编码旧色改为 token 引用，全部视图的主按钮统一为 Aurora 蓝（旧橙色主按钮退役）。

- **Module extraction completed + dependency security / 模块拆分收尾 + 依赖安全**: `app.js` delegates RequestManager and storage helpers to `modules/core/`; python-multipart bumped to 0.0.31 (three CVEs fixed) and the remaining starlette 1.x-only advisories are reviewed-and-documented ignores — the dependency audit gate is green.
  - `app.js` 的 RequestManager 与存储工具收束到 `modules/core/`；python-multipart 升级到 0.0.31（修复三条 CVE），其余仅 starlette 1.x 才修复的公告按惯例记录为已审阅忽略，依赖审计闸门恢复绿色。

- **Quieter workbench background / 更安静的工作台背景**: old decorative glow is reduced so long sessions have less visual noise while keeping the dark glass identity.
  - 旧的装饰光斑已弱化，保留暗色玻璃识别度，同时降低长时间使用的视觉噪音。

## Fixed / 修复

- **UI text coverage + Simplified-Chinese purity / 界面文案补全与简体统一**: 13 toast/button strings that silently fell back to English now have proper entries in both language packs, and ~20 Dataset template-help strings that shipped in Traditional Chinese are converted to Simplified Chinese.
  - 13 条此前静默回退英文的提示/按钮文案补上双语词条；Dataset 模板帮助区约 20 条繁体中文全部转换为简体。

- **Linux GPU tagging / Linux GPU 打标修复**: Linux installs only ever got the CPU-only `onnxruntime`, so WD14/NudeNet/CLIP stayed on CPU even with an NVIDIA card. The repair tool now detects NVIDIA via `nvidia-smi` and swaps in `onnxruntime-gpu[cuda,cudnn]` (x86_64); the Linux portable launcher runs it at startup and WD14 Prepare triggers it too. Non-NVIDIA machines keep the small CPU runtime; aarch64 is skipped (no PyPI wheels).
  - Linux 此前只会装 CPU 版 `onnxruntime`，有 NVIDIA 卡也只能 CPU 打标。修复工具现在用 `nvidia-smi` 检测到 NVIDIA 后换装 `onnxruntime-gpu[cuda,cudnn]`（x86_64）；Linux portable 启动时自动运行，WD14 Prepare 也会触发。非 NVIDIA 机器保持小体积 CPU 运行时；aarch64 无 wheel 自动跳过。

- **ESC no longer hijacks open menus or selection mode / ESC 不再劫持打开的菜单与选择模式**: ESC with the gallery More ▾ menu (or the nav tools menu / selection mode) open now closes/clears that first; only a bare ESC returns to the entry page.
  - 开着图库「更多 ▾」菜单（或导航工具菜单/选择模式）时按 ESC，现在先关菜单/清选择；空手再按才回入口页。

- **Dataset Workbench right-pane reachability / Dataset 工作台右侧栏可达性**: the right operation pane now scrolls in Workbench mode, so optional caption-polish controls are reachable instead of being clipped below the viewport.
  - Dataset Workbench 右侧操作栏现在可滚动，Caption 微调里的可选控件不会被裁在视口外不可达。

---

## Upgrading / 升级注意

- Database migrations 020 (`activity_log`) and 021 (`reconnect_reviews`) run automatically on first start — no manual steps, existing data untouched.
  - 数据库迁移 020（`activity_log`）与 021（`reconnect_reviews`）首次启动自动执行，无需手动操作，现有数据不受影响。
- First launch shows the new mission entry page; click any lane (or press ESC later to come back to it). Prefer the old behavior? Settings → 跳过入口页.
  - 首次启动会看到新的任务入口页；点任意动线进入，之后按 ESC 可随时回来。想跳过它：设置 → 「跳过入口页」。
- Navigation stays the familiar top bar; the brand block on its left now returns to the entry page. No workflow, shortcut, or destructive-action default changed; Auto-Separate / Manual Sort defaults stay `copy`.
  - 导航仍是熟悉的顶部栏，左侧品牌区现在可点击回入口页。工作流、快捷键、危险操作默认值均未改变；自动分类 / 手动分拣默认仍为 `copy`。
- In-app update from v3.4.x via "Check Update" works as usual.
  - 从 v3.4.x 用「检查更新」升级照常可用。

---

## Validation / 验证

- Full 7-gate CI green: backend pytest 2328 passed / 7 skipped; Playwright e2e 169 passed / 3 skipped; ruff, strict tsc, JS syntax, lock freshness, and dependency audit all clean.

---

## ⬇️ Which file should I download? / 我该下载哪一个？

**Windows → `sd-image-sorter-v3.5.0-windows-portable.zip`** — extract, run `run-portable.bat`.

**Linux portable x86_64 → `sd-image-sorter-v3.5.0-linux-portable-x86_64.tar.gz`** — extract, `chmod +x run-portable.sh`, run `./run-portable.sh`.

**Linux portable aarch64 → `sd-image-sorter-v3.5.0-linux-portable-aarch64.tar.gz`** — for ARM Linux / Raspberry Pi 5 / Graviton.

**Linux source install → `sd-image-sorter-v3.5.0-linux.tar.gz`** — for users with their own Python 3.12+ environment.

**Do NOT download / 不要下载：**
- `sd-image-sorter-v3.5.0-app-patch.zip` — in-app updater payload only / 仅供更新器
- `sd-image-sorter-v3.5.0-release-manifest.json` — updater metadata / 更新器元数据

---

## Checksums

See `sd-image-sorter-v3.5.0-release-manifest.json` after release package build.
