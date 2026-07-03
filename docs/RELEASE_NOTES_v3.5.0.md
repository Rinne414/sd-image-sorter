## v3.5.0 — 极光重设计 + 任务入口页 / Aurora Redesign Phases 1–2 + Mission Entry

全局配色换新为 v4.0「清爽极光」设计语言（蓝=下一步、粉=用户决定、紫=AI 产物），新增可跳过的启动任务入口页（四条任务动线 + ★5 门面）；模块拆分收尾、依赖安全清理。功能零删除，核心工作流语义不变。

The palette moves to the v4.0 "Fresh Aurora" design language (blue = next action, pink = user decisions, purple = AI output) and a skippable mission entry page lands at launch (four mission lanes + a daily ★5 cover). Module extraction and dependency security cleanup complete. Zero feature removals; core workflow semantics unchanged.

---

## Added / 新增

- **Mission entry page / 任务入口页**: launch surface with the four mission lanes (LoRA dataset / Pixiv set publishing / batch organize / free mode), live-count function tiles, a resume slab for saved manual-sort sessions, a daily ★5 full-bleed cover with 换一张 / 不想展示, and an activity streak. Top-level ESC returns to the entry without losing view state; Settings gains 跳过入口页 and ★5 门面 toggles. Backed by `GET /api/entry/summary` + `activity_log` daily counters (migration 020).
  - 新增任务入口页：四条任务动线（LoRA 数据集 / Pixiv 成套发布 / 批量整理 / 自由模式）、实时数字功能马赛克、手动分拣「接着上次」锚块、每日 ★5 全屏门面（换一张 / 不想展示）、连续整理天数。顶层 ESC 随时回入口且不丢视图状态；设置新增「跳过入口页」「★5 门面」开关。后端新增 `GET /api/entry/summary` 与 `activity_log` 日计数（migration 020）。

- **Frontend control audit / 前端控件审计**: `scripts/audit_frontend_controls.py` parses `frontend/index.html`, scans `frontend/js/**/*.js`, and outputs an evidence report for controls. Categories include `referenced-by-id`, `referenced-by-data`, `delegate-only`, `native-control`, `static-only`, and `needs-runtime-check`.
  - `scripts/audit_frontend_controls.py` 会解析 `frontend/index.html`、扫描 `frontend/js/**/*.js`，输出控件证据报告。分类包含 `referenced-by-id`、`referenced-by-data`、`delegate-only`、`native-control`、`static-only`、`needs-runtime-check`。

- **Known delegated-control tests / 已知委托控件测试**: contract coverage confirms Reader tabs, Dataset tabs, Dataset queue mode buttons, and Censor filter preset buttons are recognized as wired controls.
  - 契约测试确认 Reader tabs、Dataset tabs、Dataset queue mode、Censor filter preset 等委托控件不会被误判成静态 UI。

- **v3.5.0 phase plan / v3.5.0 阶段计划**: `.plans/sd-image-sorter-release/v3.5.0-plan.md` records the phase gates, assumptions, and current first-stage implementation scope.
  - `.plans/sd-image-sorter-release/v3.5.0-plan.md` 记录阶段门、假设与当前首阶段范围。

- **Smart Tag VLM grounding toggle / Smart Tag VLM 标签辅助开关**: VLM captioning can now explicitly disable booru-tag context, while the default remains on.
  - Smart Tag VLM 描述现在可以显式关闭 booru 标签上下文辅助，默认仍保持开启。

- **Dataset caption polish quick actions / Dataset caption 微调快捷动作**: Clear prefix, Reset template, and Refresh Chinese reading aid are now real controls with handlers.
  - Dataset Caption 微调补上清空前缀、重置模板、刷新中文阅读辅助等真实控件。

## Changed / 变更

- **Fresh Aurora visual system / 「清爽极光」视觉系统**: the new last-loaded `frontend/css/tokens.css` owns the global palette — blue-tinted dark surfaces, three semantic accents (blue #5CC8FF = next action, pink #FF8FC0 = user decisions, purple #A78BFF = AI output), unified 2px blue focus rings, solid-blue primary buttons with dark ink, a flat canvas, and Noto Sans SC + IBM Plex Mono + Oswald typography. Legacy tokens are remapped and ~470 hardcoded legacy colors across 13 stylesheets now reference tokens.
  - 全新最后加载的 `frontend/css/tokens.css` 接管全局配色：蓝调暗色表面、三个各司其职的强调色（蓝=下一步、粉=用户决定、紫=AI 产物）、统一 2px 蓝色焦点圈、实心蓝主按钮配深色文字、平坦画布、思源黑体 + IBM Plex Mono + Oswald 字体组。旧 token 全部重映射，13 个样式表约 470 处硬编码旧色改为 token 引用。

- **Module extraction completed + dependency security / 模块拆分收尾 + 依赖安全**: `app.js` delegates RequestManager and storage helpers to `modules/core/`; python-multipart bumped to 0.0.31 (three CVEs fixed) and the remaining starlette 1.x-only advisories are reviewed-and-documented ignores — the dependency audit gate is green.
  - `app.js` 的 RequestManager 与存储工具收束到 `modules/core/`；python-multipart 升级到 0.0.31（修复三条 CVE），其余仅 starlette 1.x 才修复的公告按惯例记录为已审阅忽略，依赖审计闸门恢复绿色。

- **Global component polish / 全局组件打磨**: nav tabs, buttons, danger actions, inputs, gallery toolbar, shared panels, modals, settings/model cards, empty states, progress bars, toasts, and selection-panel surfaces now use the same component language.
  - nav tabs、按钮、危险动作、输入框、图库工具栏、共享面板、弹窗、settings/model card、空状态、进度条、toast、多选面板完成首轮统一。

- **Quieter workbench background / 更安静的工作台背景**: old decorative glow is reduced so long sessions have less visual noise while keeping the dark glass identity.
  - 旧的装饰光斑已弱化，保留暗色玻璃识别度，同时降低长时间使用的视觉噪音。

- **Dataset Workbench reachability / Dataset 工作台可达性**: the right-side operation pane now scrolls in Workbench mode so optional caption-polish controls are not clipped below the viewport.
  - Dataset Workbench 右侧操作栏现在可滚动，可选 Caption 微调控件不会被裁在视口外。

---

## Compatibility / 兼容性

- No backend API contract changes.
- No DOM id migration.
- No feature deletion.
- Auto-Separate / Manual Sort defaults stay `copy`.
- Destructive actions stay separated and confirm-protected.

---

## Validation So Far / 当前验证

- `python scripts/audit_frontend_controls.py` — passed, reports 948 controls, 538 buttons, 61 JS files scanned.
- `python -m pytest backend/tests/test_frontend_contract.py -q` — passed, 68 tests.
- `python -m pytest backend/tests/test_smart_tag_service.py -q -k "grounding or caption_phase"` — passed, 4 selected tests.
- `python -m pytest backend/tests/test_release_build.py -q` — passed, 48 tests.
- `node --check frontend/js/smart-tag.js` and `node --check frontend/js/app.js` — passed.
- Playwright rendered QA — passed at 1366x768 and 1920x1080 for Gallery selection, filter modal, Dataset Workbench, Smart Tag modal, Censor, and Model Manager; Browser plugin was unavailable, so regular Playwright was used.

## Pending Release QA / 待发布 QA

- Full `python scripts/run_ci.py`.
- Remaining desktop screenshot review at 1440x900, 2560x1440, and 3840x2160.
- Release package build.
- `python scripts/lazy_release_qa.py`.
- Real portable startup smoke.

---

## Download / 下载

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
