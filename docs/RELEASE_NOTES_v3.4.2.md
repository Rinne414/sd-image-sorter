## v3.4.2 — AI 任务排队 + 清空按钮回归 / AI Job Queue + Clear Button Restored

AI 任务现在自动排队：打标 / Smart Tag / VLM 描述在另一任务运行时加入队列，结束后自动开始，不再弹 409"忙碌"。清空图库按钮回到图库工具栏一眼可见处；筛选预设有了界面；WASD 连击重新可见；prompts count 参数生效。

AI jobs now queue (FIFO, auto-start) instead of failing with 409. The Clear Library button is back on the gallery toolbar; filter presets got their UI; the WASD combo counter is visible again; prompts `count` works.

---

## Added / 新增

- **AI job queue / AI 任务队列**: gallery tagging, Smart Tag, and VLM caption batches share a FIFO queue. Starting one while another AI job runs returns `{"status": "queued", "queue_position": N}` instead of 409; the queue drains automatically after success, error, or cancel; duplicate consecutive submits merge; each kind's cancel endpoint also removes its queued entries; progress shows "Queued #N / 排队中 #N" and F5 while queued re-attaches the UI. In-memory — a server restart clears pending entries.
  - 图库打标、Smart Tag、VLM 批量描述共用一个先进先出队列：运行中再启动会返回排队状态而非 409；当前任务成功、出错或取消后自动继续下一个；连续重复提交自动合并；取消接口同时清掉排队中的同类任务；进度显示"排队中 #N"，排队期间 F5 界面自动恢复。队列在内存中，重启服务后清空。

- **Filter presets UI / 筛选预设界面**: the preset save/load/delete logic existed but had no entry point — the filter editor now has a presets bar (name, save, load chips, delete).
  - 预设逻辑早已存在但一直没有按钮——筛选编辑器现在有了预设栏（命名、保存、点击载入、删除）。

## Fixed / 修复

- **Clear Library button on the gallery page / 清空图库按钮回到图库页面**: it was buried inside the Import modal's collapsed "Advanced options". Now at the right end of the gallery toolbar — always visible, danger-styled, away from everyday controls, same double-confirmation.
  - 此前藏在导入弹窗折叠的"高级选项"里。现在固定在图库工具栏最右端——红色危险样式、与常用按钮保持距离，确认流程不变。

- **Prompts `count` honored / count 参数生效**: `/api/prompts/generate` now returns a reproducible `prompts[]` batch for `count` 1-20 (fixed seed → seed+i per slot); the top-level single-prompt shape is unchanged.
  - `/api/prompts/generate` 现在按 `count`（1-20）返回可复现的多条 `prompts[]`；顶层单条响应结构不变。

- **WASD combo counter visible again / 连击计数重新可见**: it counted invisibly since a v2.6.0 markup restructure dropped its display element — restored.
  - 自 v2.6.0 重构误删显示元素后连击一直在"隐身计数"——已恢复。

- **VLM batch start no longer blocks the server / VLM 批量启动不再阻塞服务器**: the large-selection count at batch start moved off the event loop into a worker thread.
  - 批量启动时的大筛选集统计移出事件循环，改在工作线程执行。

- **/api/dataset/translate docs / 翻译接口文档**: rewritten to match the real VLM/external provider contract (doc-only).
  - 按真实的 VLM/外部翻译提供方契约重写（仅文档）。

- **Model Manager manual-upgrade hint / 模型管理器升级提示**: explains that "missing" models after upgrading into a new folder are still in the old folder's `data` directory.
  - 新增固定提示：手动升级到新文件夹后模型"缺失"，其实都在旧文件夹的 `data` 目录里。

---

## Upgrading / 升级注意

- No database migration. 不含数据库迁移。
- **If you upgrade by unzipping into a NEW folder / 手动解压到新文件夹升级**: copy the old folder's entire `data` directory into the new installation FIRST — it holds your library database and ALL downloaded models. Otherwise every model shows "missing" (nothing is actually deleted; in-app updates are unaffected).
  - 请先把旧文件夹的整个 `data` 目录复制到新目录——里面有图库数据库和所有已下载模型。不复制会导致所有模型显示"缺失"（数据并没有丢；应用内更新不受影响）。
- API note: the three AI start endpoints no longer return 409 when busy — scripts should treat `{"status": "queued"}` as accepted-pending.
  - API 提示：三个 AI 启动接口忙碌时不再返回 409——脚本请把 `{"status": "queued"}` 视为"已受理待执行"。

---

## Validation / 验证

- Full CI green on the release tree: backend full suite passed, Playwright E2E 138 passed / 5 skipped (incl. new queue + UI-regression specs), ruff lint, frontend JS syntax, dependency lock and security audit all passed; real portable boot test performed before publishing.

---

## ⬇️ Which file should I download? / 我该下载哪一个？

**Windows → `sd-image-sorter-v3.4.2-windows-portable.zip`** — extract, run `run-portable.bat`.

**Linux portable x86_64 → `sd-image-sorter-v3.4.2-linux-portable-x86_64.tar.gz`** — extract, `chmod +x run-portable.sh`, run `./run-portable.sh`.

**Linux portable aarch64 → `sd-image-sorter-v3.4.2-linux-portable-aarch64.tar.gz`** — for ARM Linux / Raspberry Pi 5 / Graviton.

**Linux source install → `sd-image-sorter-v3.4.2-linux.tar.gz`** — for users with their own Python 3.12+ environment.

**Do NOT download / 不要下载：**
- `sd-image-sorter-v3.4.2-app-patch.zip` — in-app updater payload only / 仅供更新器
- `sd-image-sorter-v3.4.2-release-manifest.json` — updater metadata / 更新器元数据

---

## Checksums

See `release-manifest.json` for SHA-256 checksums of all release assets.
