## v3.5.0 — Serious Redesign Phase 1 / 重设计首阶段

v3.5.0 starts the serious UI/UX redesign and debt cleanup track. This first stage focuses on evidence and the global visual system: no feature was removed, no core workflow semantics were changed, and destructive defaults remain unchanged.

v3.5.0 开始 UI/UX 重设计与债务清理路线。首阶段重点是证据与全局视觉系统：没有删除功能，没有改变核心工作流语义，危险动作默认值保持不变。

---

## Added / 新增

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

- **Professional Dark Glass visual system / 专业暗色玻璃视觉系统**: `frontend/css/ui-refresh.css` now owns v3.5.0 surface, border, focus, toolbar, modal, danger, progress, toast, and empty-state tokens.
  - `frontend/css/ui-refresh.css` 现在统一管理 v3.5.0 的 surface、border、focus、toolbar、modal、danger、progress、toast、empty-state token。

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
