## v3.0.4 — Reader truthfulness + Civitai auth wall semantics + unreadable image quarantine / Reader 说真话 + Civitai 登录墙语义 + 坏图隔离

v3.0.4 is a release-blocker fix pack. This patch closes the gaps that still made fresh-environment validation fail in v3.0.3: clipboard metadata truthfulness in Image Reader, business-error semantics for `censor-legacy`, unreadable image quarantine during scan, and similarity progress that actually tells users what failed.

v3.0.4 是一版专门收口发布阻塞的补丁。它把 v3.0.3 里仍然会让干净环境验收失败的几条都补齐了：Image Reader 对剪贴板 metadata 的诚实提示、`censor-legacy` 的业务错误语义、scan 对坏图的隔离，以及 similarity 进度不再只会说模糊的失败数。

---

## What's Fixed / 修复内容

### Image Reader clipboard path now tells the truth / Image Reader 剪贴板路径开始说真话

- The Reader still reads original files normally through drag-drop and file browse.
- Clipboard import now uses the real `paste` event path consistently. The button no longer pretends `navigator.clipboard.read()` is metadata-safe; it now arms paste capture and tells the user to press `Ctrl+V`.
- Clipboard images now show an explicit warning that browsers may drop original SD PNG metadata. If the pasted image arrives as `UNKNOWN` / no prompt / no checkpoint / no params, the UI says that metadata was not included instead of silently looking like a successful parse.

- Reader 通过拖放和文件选择读取原图的行为不变。
- 剪贴板导入现在统一走真实的 `paste event` 路径。按钮不再假装 `navigator.clipboard.read()` 是 metadata-safe；它现在只负责进入捕获态，并明确提示用户按 `Ctrl+V`。
- 剪贴板图片现在会明确提示浏览器可能丢失原始 SD PNG metadata。如果贴出来是 `UNKNOWN` / 没 prompt / 没 checkpoint / 没 params，UI 会直接说“这张剪贴板图没有带上原始 SD 元数据”，不会再装成解析成功。

### `censor-legacy` prepare is a structured `409`, not a fake server crash / `censor-legacy` prepare 改成结构化 `409`，不再伪装成服务器崩溃

- `POST /api/models/prepare {"model_id":"censor-legacy"}` now returns `409 Conflict` when Civitai blocks the download behind a signed-in browser session.
- The payload includes `error`, `type = CivitaiLoginRequired`, `message`, `provider`, `manual_steps`, and `external_url`.
- If Civitai serves a broken archive instead of a login wall, the backend now returns a structured non-500 `ModelPreparationFailed` response instead of surfacing `BadZipFile`.
- The model manager renders this as a warning toast instead of a generic server error.

- `POST /api/models/prepare {"model_id":"censor-legacy"}` 在 Civitai 登录墙挡住下载时，现在返回 `409 Conflict`。
- 返回体带有 `error`、`type = CivitaiLoginRequired`、`message`、`provider`、`manual_steps`、`external_url`。
- 如果 Civitai 给回来的是坏压缩包而不是登录墙，后端现在也会返回结构化的非 500 `ModelPreparationFailed`，不会再把 `BadZipFile` 裸抛出来。
- Model Manager 前端会把它显示成 warning，不再当成 generic server crash。

### Corrupt and truncated images are quarantined during scan / corrupt 和 truncated 图片在 scan 阶段就会被隔离

- Folder scan now performs a real decode verify (`verify()` + `load()`), not just a metadata open.
- Corrupt and truncated files are counted as errors, listed by filename in scan progress, marked unreadable in the DB when needed, and excluded from manual sort, tagging, similarity embedding, and batch move defaults.
- Mixed folders continue indexing good files instead of failing the entire scan.

- 文件夹扫描现在会做真实解码校验（`verify()` + `load()`），不再只靠 metadata open。
- corrupt / truncated 文件会记为错误、在 scan progress 里带文件名显示、必要时写入 DB 的 unreadable 状态，并默认从 manual sort、tagging、similarity embedding、batch move 里排除。
- 混合目录不会因为坏图整次扫描失败，好图照常入库。

### Similarity progress now distinguishes skipped / unreadable / failed / similarity 进度现在会区分 skipped / unreadable / failed

- Embedding progress now reports `embedded`, `skipped`, `unreadable`, and `failed` separately.
- Recent issue details include filename and image id so users can tell which file was skipped and why.
- Historical unreadable rows are also filtered out of similarity search and duplicate results even if they still had stale embeddings from an older library state.

- Embedding 进度现在会分别统计 `embedded`、`skipped`、`unreadable`、`failed`。
- 最近的问题项会带文件名和 image id，用户能直接知道是哪张图被跳过、为什么。
- 就算旧库里残留了历史 embedding，只要图片已经被标记成 unreadable，similarity 搜索和 duplicate 结果现在也会把它排除掉。

### ToriiGate runtime status is now truthful during the run / ToriiGate 运行时状态现在会说实话

- The first-use `~5 GB from HuggingFace` warning remains.
- Tagging progress now exposes `runtime_backend_target`, `runtime_backend_actual`, `runtime_backend_reason`, and `memory_pressure_warning`.
- The UI shows actual backend state during the run, so a CPU fallback is visible instead of being hidden behind the original target mode.

- 首次运行的 `~5 GB from HuggingFace` 提示保留。
- Tagging 进度现在会带 `runtime_backend_target`、`runtime_backend_actual`、`runtime_backend_reason`、`memory_pressure_warning`。
- UI 会在运行过程中显示实际 backend，所以 CPU fallback 不会再被原本的目标模式盖掉。

### Censor queue shows per-image batch failures / Censor 队列显示每张图的批次失败

- Detect All, Save All, and SAM3 Batch Refine now mark failed queue thumbnails with a red outline and attach the error to the thumbnail tooltip.
- When any image in a batch fails, the completion toast upgrades to a warning that includes the failure count so the user can find the red thumbnails immediately.
- Successful SAM3 refines that are not yet applied get a cyan outline so "what did SAM3 touch" is visible at a glance.

- Detect All、Save All、SAM3 批量精化现在会把失败的队列缩略图加红色边框，并把错误信息写进缩略图 tooltip。
- 只要批次里有任何失败，完成的提示会升级成警告并带失败张数，用户可以直接去看红框缩略图。
- SAM3 精化成功但尚未覆盖的图会出现青色外框，让用户直接看出这次 SAM3 动了哪几张。
