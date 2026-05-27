## v3.2.2 — Dataset Maker pipeline + Smart Tag wizard / Dataset Maker 管线 + 智能标注向导

Dataset Maker 全新 3-tab 管线（导入 / 工作台 / 输出）+ 可选训练就绪度审计；新增 ✨ 智能标注向导（WD14 / OppaiOracle / Camie / PixAI + VLM）和 LoRA caption 一键流程；同步加入 Linux portable bundle、批量移动护栏、Python 3.13 支持，以及多项稳定性修复。

v3.2.2 ships a redesigned Dataset Maker (3-tab pipeline + optional Audit) and a new Smart Tag wizard (WD14 / OppaiOracle / Camie / PixAI + VLM), plus Linux portable bundles, Python 3.13 support, and several critical safety fixes.

---

## ✨ Added / 新增

- **Dataset Maker 3-tab pipeline + Smart Tag wizard**: a focused 3-tab nav (Import / Workbench / Export) replaces the old single-page layout. The Workbench tab houses Organize, Tag, and Caption flows; an optional Audit modal launched from the Import toolbar runs the LoRA-readiness checks. A new `✨ Smart Tag (WD14 + VLM)` button runs the local tagger plus a VLM in one pipeline with training-purpose-aware prompts (Style / Character / General / Concept), automatic noise-tag stripping, trigger-word injection, and merge-vs-replace handling for existing captions.
  - **Dataset Maker 3-tab 管线 + 智能标注向导**：聚焦的 3-tab 导航（导入 / 工作台 / 输出）取代旧版单页布局。工作台 tab 包含 Organize / Tag / Caption 流程；从导入工具列打开的可选审计模态执行 LoRA 就绪度检查。新增 `✨ 智能标注 (WD14 + VLM)` 按钮一次跑完本地 tagger + VLM，按训练用途（风格 / 角色 / 通用 / 概念）自动选 prompt、剔除噪音 tag、注入 trigger word、可选替换或追加现有 caption。

- **Dataset Maker LoRA-trainer readiness audit**: optional Audit modal with three independent checks (aesthetic, perceptual-hash duplicate clustering, image-side dimension) plus an unconditional untagged check. All thresholds optional and unbounded; result badges click-to-filter the queue; `Download report (.json)` exports the raw report.
  - **Dataset Maker 训练就绪度审计**：可选审计模态含三项独立检查（美学分、phash 重复聚类、最短边像素）+ 未标注无条件启用。预设全关、每个阈值可选不设硬上限；结果徽章可点击高亮队列、可下载 .json 报告。

- **Dataset Maker small-gallery workspace**: `📁 Add from Folder` button + `POST /api/dataset/folder-scan` endpoint let you add images directly from a folder without scanning them into the main library. Local items render thumbnails from the scan response and persist caption edits to localStorage by absolute path so re-imports restore your work. Hard invariant: folder-scan never writes to `images.db`.
  - **Dataset Maker 小图库工作区**：📁「从资料夹加入」按钮 + `POST /api/dataset/folder-scan` 端点，直接拖图入 Dataset Maker 不写主图库。本地项目缩图直接从 scan 回的 base64 渲染，caption 编辑写到 localStorage（按绝对路径键）。强不变式：folder-scan 绝对不动 `images.db`。

- **Dataset Maker tag vocabulary side panel + Anime LoRA defaults**: collapsible vocab panel under the queue (`POST /api/dataset/vocab`) lets you cycle each tag through neutral → common → blacklist → neutral with live two-way sync to the common-tags / blacklist textareas. A fresh session also pre-fills `Common tags = masterpiece, best_quality`, `underscore_to_space = ON`, `naming preset = renumber`, and the `🎌 Apply Anime LoRA defaults` button re-applies in one click.
  - **Dataset Maker 标签词汇侧栏 + Anime LoRA 预设**：队列下方可折叠面板循环 中性 → 共用 → 黑名单 → 中性，与共用 / 黑名单输入框双向即时同步。新 session 自动填 `共用标签 = masterpiece, best_quality`、`底线转空格 = 开`、`命名预设 = renumber`，「🎌 套用 Anime LoRA 预设」按钮一键重套。

- **OppaiOracle V1.1 ONNX tagger**: a from-scratch ViT (~247M params, 19,294 general tags, 448x448 input) anime tagger added as a first-class option alongside WD14 / Camie / PixAI. Auto-download (~947 MB) is wired through Model Manager and the Tagger modal's first-run flow. Default threshold pinned to 0.7927 (the model's published P=R threshold).
  - **OppaiOracle V1.1 ONNX 打标模型**：和 WD14 / Camie / PixAI 并列的新打标选项，从零训练的 ViT（约 2.47 亿参数，19,294 个通用标签，448x448 输入）。Model Manager 和 Tagger 弹窗都接好了 ~947 MB 自动下载，默认阈值 0.7927。

- **Linux portable bundle (x86_64 + aarch64)**: new `linux-portable-x86_64.tar.gz` and `linux-portable-aarch64.tar.gz` release assets that ship their own cpython 3.13 via [astral-sh/python-build-standalone](https://github.com/astral-sh/python-build-standalone). Same first-run flow as the Windows portable: extract, `chmod +x run-portable.sh`, run. Works on every modern distro on either architecture, including Raspberry Pi 5, AWS Graviton, and systems whose `python3` is 3.14. The existing `linux.tar.gz` source-install variant stays available for advanced users who manage their own toolchain. CI smoke job builds and probes both arches on every push.
  - **Linux 便携版打包（x86_64 + aarch64）**：新增 `linux-portable-x86_64.tar.gz` 跟 `linux-portable-aarch64.tar.gz` 两个发布 asset，内置 cpython 3.13。和 Windows 便携版一样：解压 → `chmod +x run-portable.sh` → 直接跑。任何现代 Linux 发行版都可用（含 Raspberry Pi 5、AWS Graviton、系统 Python 已经是 3.14 的情况）。源码版 `linux.tar.gz` 保留给会自管 Python 工具链的进阶用户。CI smoke 在两种架构上都跑过。

- **Python 3.13 support alongside Python 3.12**: `requirements-core.in` / `requirements.in` now use `python_version` env markers so a single universal lockfile resolves under both. 3.12 stays on numpy 1.26.4 + onnxruntime 1.20.1 (matches existing SAM3/torch/scipy/opencv numpy-1 ABI); 3.13 picks numpy 2.4.6 + onnxruntime 1.26.0 (newest cp313 wheels). Fixes the Arch / Fedora 41+ / Ubuntu 25.04+ / Debian 13 source-install case where the system default `python3` is 3.13.
  - **Python 3.13 与 3.12 双轨支援**：requirements 改用 `python_version` env marker，单一 lockfile 在两个 Python 下都能解。3.12 维持 numpy 1.26.4 + onnxruntime 1.20.1；3.13 走 numpy 2.4.6 + onnxruntime 1.26.0。修好 Arch / Fedora 41+ / Ubuntu 25.04+ / Debian 13 等系统预设 `python3` 已经是 3.13 的源码安装路径。

- **VLM (Vision Language Model) captioning with multi-provider support, Vertex AI, proxy, and danbooru-tag output mode**: full natural-language captioning pipeline supporting OpenAI-compatible, Anthropic Claude, Google Gemini (public + Vertex AI), and any local chat-completions endpoint; HTTP/HTTPS/SOCKS proxy; `output_format` of NL caption / danbooru tags / both; one-click Ollama local model deployment; 5 prompt presets for different LoRA training styles. (Folded forward from v3.2.1 prep into v3.2.2 since v3.2.1 was not separately released.)
  - **VLM 多厂商自然语言打标**：支援 OpenAI 协议 / Anthropic Claude / Gemini（公共 + Vertex AI）/ 任意本地 chat completions 端点；HTTP/HTTPS/SOCKS 代理；输出格式 NL caption / danbooru tags / 两者；一键部署 Ollama 本地模型；5 个 LoRA 训练 prompt preset。（v3.2.1 准备内容并入 v3.2.2，因为 v3.2.1 未单独发布。）

- **LoRA-friendly tag export pipeline**: same-name `.txt` / LoRA caption export now converts danbooru underscores to spaces by default (preserves `score_*` for Pony / NoobAI), exposes a Caption Editor virtual-scroll workbench with unlimited images, ships 7 LoRA training presets (Anima Tags+NL, Anima Tags-only, Illustrious / Pony, NoobAI, FLUX, Kohya SD1.5, Custom), and adds a renamed-pair discoverability chip that shows the live `your_lora_001.png + your_lora_001.txt` filename pair as you type.
  - **LoRA 友好的标签导出管线**：同名 `.txt` 默认把 danbooru 下划线转成空格（保留 `score_*`），Caption 编辑器虚拟滚动支持无上限图片，附 7 个 LoRA 训练 preset（Anima / Pony / NoobAI / FLUX / Kohya 等），输出资料夹下方 chip 即时显示档名对。

- **Color analysis during scan + color-based gallery filter & sort**: dominant colors, brightness, saturation, color temperature, histogram, brightness skew, distribution shape (line-art vs photo detection). Stored in 7 indexed columns via migration 010; backfillable via `/api/colors/analyze` with progress polling and a one-click backfill banner.
  - **扫图时分析图片色彩 + 图库按色彩筛选/排序**：抽取主色、亮度、饱和度、色温、直方图、亮度偏度、分布形状（能区分线稿和照片）。Migration 010 加 7 个有索引的字段；老图库可通过 `/api/colors/analyze` 和补算引导横幅按需补算。

- **Mass Tag Editor**: nav-bar 🧹 button opens a unified UI for 4 bulk operations on the tags table — Find & Replace, Bulk Add, Bulk Remove, Cleanup. Mandatory Dry-run preview; confirm dialog with 2-second delayed Apply when scope > 1,000 images. Filter scope works on 70k libraries in ~3s via the selection-token / selection-chunk flow.
  - **批量标签编辑器**：导航栏 🧹 按钮统一界面，覆盖查找替换 / 批量添加 / 批量删除 / 清理 4 个操作。强制 Dry-run 预览，超过 1,000 张时二次确认弹窗（Apply 按钮 2 秒倒计时）。7 万张图筛选范围约 3 秒。

- **Caption Editor full-screen workbench**: the 3-column workbench (image queue / current caption editor / shared-tag toolbox) now opens in a near-fullscreen modal via an `Open Editor` button in the batch-export preview header, giving LoRA-training power users real horizontal real estate.
  - **Caption 编辑器全屏工作台**：3 栏工作台（队列 / 编辑 / 共同标签）可在近全屏弹窗里打开，给改 LoRA 训练 caption 的高强度用户更宽的编辑空间。

- **Auto-Separate 3-pane workbench redesign**: Auto-Separate page replaces the long vertical form with a left/center/right workbench — filter editor + saved configs on the left, preview grid in the center, Destination + Move/Copy + Run CTA on the right. Sticky bottom action bar at 1080-1280px; single-column stack below 760px.
  - **自动分类 3 栏工作台重设计**：左：筛选 + 已保存配置；中：预览网格；右：目标资料夹 + 移动/复制 + 大执行按钮。1080-1280px 改吸底操作条，760px 以下单列堆叠。

- **Per-item exclude filters + Auto-Separate inline chip editing + nav-bar tab icons**: filter chips cycle include → exclude → remove; Auto-Separate filter chips can be cleared inline without opening the modal; all 7 nav tabs now have consistent emoji icons + stable `id="nav-tab-{view}"` for deep-linking and screen-reader consistency.
  - **筛选可排除 + 自动分类内联 chip 编辑 + 导航 tab 图标统一**：筛选 chip 循环 include → exclude → remove；自动分类可直接清除内联 chip；7 个导航 tab 图标和 id 统一。

---

## 🛠 Fixed / 修复

- **Smart Tag VLM gate accepts local OpenAI-compatible servers without an api_key (BLOCKER)** — `_coerce_request` previously required BOTH `endpoint` AND `api_key` for any VLM, so users with a configured local Ollama / vLLM / LM Studio endpoint hit `HTTP 400 "VLM Settings has no endpoint or API key configured"` even after saving valid settings. The gate now lets local endpoints (loopback, `*.local`, `*.lan`, `*.internal`, `host.docker.internal`, RFC1918 LAN ranges) through without an api_key, and adds a Vertex AI auth path that requires `vertex_project` instead of an api_key. Cloud providers (Anthropic, Gemini public, OpenAI cloud, OpenRouter, etc.) still get caught with a clear error when the api_key is missing.
  - **智能标注 VLM 配置闸门接受本地 OpenAI 兼容服务无需 api_key（BLOCKER）**：`_coerce_request` 之前强制要求 `endpoint` + `api_key` 都有，本地 Ollama / vLLM / LM Studio 用户配好端点后还是会撞到 `HTTP 400 "VLM Settings has no endpoint or API key configured"`。现在本地端点（loopback / `*.local` / `*.lan` / `*.internal` / `host.docker.internal` / RFC1918 私网段）放行不需要 api_key，Vertex AI 改要 `vertex_project`，云端服务（Anthropic / 公共 Gemini / OpenAI / OpenRouter）若没填 api_key 仍按之前的明确错误拦下。

- **Drag-drop folders, ZIP, and RAR archives now support same-name `.txt` beside imported copies (HIGH)** — Beside-image export previously only worked for Gallery and folder-path scan sources; uploaded files were marked `cache_only` and forced into the folder-export branch. Drag-drop images, dropped folders, ZIP, and (new) RAR all now write the .txt next to the imported copy in the app data directory. RAR support is opt-in: needs the optional `rarfile` Python package + a system `unrar` binary; the upload route returns a clear bilingual error when those are missing instead of the previous hard rejection.
  - **拖入文件夹 / ZIP / RAR 都支持「写同名 .txt 到原图旁边」（HIGH）**：之前只有 Gallery 和文件夹路径扫描支持，浏览器上传的文件被标 `cache_only` 强制走文件夹导出分支。拖图、拖入文件夹、ZIP、RAR（新增）现在都会把 .txt 写到应用数据目录的导入副本旁边。RAR 是可选支持：需要 `rarfile` Python 包和系统 `unrar` 程序，没装时上传接口会返回明确双语错误而不是之前的硬拒绝。

- **`switchView` no longer flags an unconditional gallery refresh on every nav-out (HIGH)** — leaving the gallery used to always set `AppState.galleryNeedsRefresh = true`, which forced a full `loadImages()` API round-trip every time the user came back. After Reader save-as-new to a path outside the indexed library, the Reader's own `_markGalleryRefreshForIndexedOverwrite` correctly skipped marking, but the upstream view-switch had already flipped the flag, so the gallery still re-fetched and the `smoke.spec.ts:942` E2E contract failed. The cached `AppState.images` array survives the round-trip; coming back to the gallery now re-renders DOM via `Gallery.setImages` without a network refetch unless an explicit caller (scan completion, batch-move, save to indexed path) requested a refresh.
  - **`switchView` 不再每次离开图库都无条件标记需要刷新（HIGH）**：之前离开图库总会把 `AppState.galleryNeedsRefresh = true`，回来时强制走一次 `loadImages()`。Reader 「另存为新档案」到图库外路径时，Reader 自己的 `_markGalleryRefreshForIndexedOverwrite` 已经正确判定不该标记，但上游的 `switchView` 已经先把 flag 翻成 true，于是图库还是会重抓，`smoke.spec.ts:942` E2E 合约因此挂掉。`AppState.images` 缓存其实跨视图保留得住；现在回到图库走 `Gallery.setImages` 用缓存重渲染 DOM，只有显式调用方（扫描完成、批量移动、写到图库内路径）请求时才真正重抓。

- **`batch-move` catastrophic foot-gun (CRITICAL)** — `/api/batch-move` previously moved every image in the library when no filters were specified. A 3rd-party script POSTing `{"destination_folder": ..., "operation": "move", "image_ids": [a, b, c]}` had its `image_ids` silently dropped (no such field in `BatchMoveRequest`), so the worker counted 71,251 unfiltered matches and started moving them all. Schema now requires at least one filter; empty filter sets return 400 with a clear error.
  - **批量移动灾难性陷阱（CRITICAL）**：`/api/batch-move` 原本在没有任何 filter 时会把整个图库都搬走。Schema 现在强制至少指定一个 filter；空 filter 直接 400 并提示哪些字段算 filter。

- **`/api/similarity/embed` ignored body `image_ids` (HIGH)** — handler declared `image_ids: Optional[list]` without a Pydantic body model, so FastAPI treated it as a query parameter on POST and silently embedded the entire library instead of the requested subset. Now wrapped in `EmbedRequest` BaseModel with 7 router tests pinning every body variant.
  - **`/api/similarity/embed` 忽略 body 里的 `image_ids`（HIGH）**：handler 用裸 `Optional[list]`，body 里的 `image_ids` 被静默丢弃，导致不管指定多少张都对整个图库做嵌入。现在用 `EmbedRequest` BaseModel 包好。

- **VLM tag parser rejects markdown / prose / LaTeX noise (HIGH)** — real Gemma / Qwen / GPT responses leak chain-of-thought into danbooru-tags output (`### 1. Address...`, `*   **Character Design:**`, LaTeX `$$x = ...$$`, sentence fragments). Old parser only checked `2 ≤ len ≤ 100`, so 401 garbage rows were silently written to the user's tags table. New shape-based filter rejects them at parse time; migration 012 retroactively cleans existing pollution.
  - **VLM 标签解析过滤 markdown / 散文 / LaTeX 噪声（HIGH）**：本地 Gemma / Qwen / GPT 输出会把 chain-of-thought 漏进 danbooru 标签，已经悄悄写了 401 行垃圾标签。新形状过滤器在解析阶段就拒掉；迁移 012 一次性清干净。

- **`/api/library-health` event-loop blocking + 12 s SQL (HIGH)** — route was `async def` but called synchronous SQL aggregations (~10 SUM/COUNT scans across 71k-row library). Cold-cache calls took 4-12 s and blocked the event loop, so 50 concurrent reads → 16 OK + 34 timeouts. Route switched to `def` (offloaded to thread pool) + 60 s TTL cache keyed by `sample_limit`. After: 50/50 succeed.
  - **`/api/library-health` 卡死事件循环 + SQL 慢 12 秒（HIGH）**：路由是 `async def` 但里面调同步 SQL；改 `def` 让 FastAPI 丢线程池，加 60 秒 TTL 缓存。

- **Concurrent `POST /api/scan` race condition (HIGH)** — three simultaneous scans all returned 200 "Scan started" but only one was actually running, because the original guard required `status == 'running' AND worker_alive` and the worker isn't alive until background task pickup. Added a `'starting'` transition state set inside the lock.
  - **并发 `POST /api/scan` race condition（HIGH）**：三个同时打的 scan 都拿到 200 但实际只跑一个。新加 `'starting'` 过渡状态在锁里就 set。

- **VLM endpoint validation (BLOCKER)** — Smart Tag wizard now fails fast with a clear error when natural-language captioning is enabled but VLM Settings has no endpoint or API key configured, instead of silently falling back to booru-only output.
  - **VLM 端点验证（BLOCKER）**：智能标注向导启用 NL caption 但 VLM Settings 没配置端点时，直接弹出明确错误，不再静默 fallback 成 booru-only。

- **Smart Tag cancel feedback** — clicking Stop now immediately shows "Cancelling..." and a toast; previously the bar kept moving for ~1 second with no UI response.
  - **智能标注取消反馈**：按 Stop 立刻显示「Cancelling...」+ toast，不再有 1 秒空窗。

- **`beforeunload` guard fixed for Chrome / Edge** — Dataset Maker now correctly warns before losing unsaved caption edits on F5 / tab close.
  - **`beforeunload` 防离开在 Chrome / Edge 上修好**：Dataset Maker 在有未保存 caption 编辑时按 F5 / 关分页会先弹确认。

- **Audit-flagged removal now cleans local-import state** — removing duplicate-flagged items previously left them in folder-scan manifests and they would reappear on rescan.
  - **审计标记移除现在会清干净本地匯入状态**：之前移除重复标记的本地图，重扫资料夹会再回来。

- **System-info endpoint cached, ~1000× faster on repeat calls** — Tagger setup modal repeatedly hits `/api/system-info`; each call re-spawned `nvidia-smi` + `Get-CimInstance` + `torch.cuda` init (~2-4 s). Now cached for 30 s with explicit `invalidate_system_info_cache()` for tests.
  - **`/api/system-info` 加 30 秒缓存，重复调用快约 1000 倍**：标签器设置弹窗反复打这个接口，原本每次都重跑 `nvidia-smi` / `Get-CimInstance` / `torch.cuda` 初始化。

- **OSError-vs-ImportError DLL gap on Windows** — every prepare / status flow that imported torch only caught `ImportError`. Windows raises `OSError` for cudnn / cuda DLL load failures, so users with broken torch DLLs saw raw `[WinError 127] cudnn_cnn64_9.dll` 500s instead of a clean "feature unavailable" response. All affected routes / helpers now also catch `OSError`.
  - **Windows 上 OSError 与 ImportError 的 DLL 鸿沟**：所有 import torch 的 prepare / status 流只 catch `ImportError`，Windows 抛 `OSError` 时漏过。受影响的 route / helper 现在一并 catch。

- **Caption sidecar `.txt` no longer mangled by parens / apostrophes / commas / brackets (CRITICAL)** — `sanitize_filename` used a strict allow-list `[\w\s\.\-]` and replaced every other character with `_`, so `my (lora char).png` produced `my _lora char_.txt` breaking exact-basename pairing. Switched to a block-list that strips only OS-illegal chars; `_allocate_output_path` now derives sidecar stem from the on-disk path.
  - **关键修复 — 同名 `.txt` 在文件名含 `()` `'` `,` `[]` 时跟原图配不起来**：`sanitize_filename` 改成黑名单（只挡 OS 不合法字符），`_allocate_output_path` 直接用磁盘上图片的 basename。

- **Same-name `.txt` export no longer produces LoRA-incompatible `123.json.txt` sidecars** — when two indexed images shared a basename but had different source extensions, the collision fallback wrote `{full_filename}.txt`, which LoRA trainers silently ignore. Allocator now uses clean numeric suffixes (`123.txt`, `123_1.txt`, `123_2.txt`, ...).
  - **同名 `.txt` 导出不再生成 LoRA 不兼容的 `123.json.txt`**：basename 冲突时改用纯数字后缀。

- **Legacy DB upgrade broken on pre-v3.2.0 schemas (CRITICAL)** — users upgrading from a pre-v3.2.0 schema hit `OperationalError: no such column: tagged_at` during `init_db()`. Three timestamp columns (`tagged_at`, `indexed_at`, `created_at`) were in `FULL_SCHEMA` but missing from `LEGACY_IMAGE_COLUMNS`. Backfill list updated so old DBs migrate cleanly.
  - **关键修复 — 旧版 DB 升级到 v3.2.x 直接报错**：三个时间戳列漏在补列清单里，补回去后旧 DB 能干净迁移。

- **`/api/obfuscate/preview` 500 + Python BytesIO repr leak (HIGH)** — posting a zip / HTML / empty body returned `500` with `cannot identify image file <_io.BytesIO object at 0x000001...>` exposing internal Python repr. Now catches `UnidentifiedImageError` + `OSError` and returns a clean 400 with sanitized message.
  - **`/api/obfuscate/preview` 收到非图片时 500 + 泄漏 Python BytesIO 对象内存地址（HIGH）**：现在一并 catch，回干净的 400。

- **`/api/images/{id}` int overflow returns 500 (HIGH)** — 24-digit numeric IDs that overflow int64 raised `UnhandledException`. Added FastAPI Path bounds `1 ≤ id ≤ 2³¹-1` so out-of-range IDs return 422 with the field name.
  - **`/api/images/{id}` 整数溢出回 500（HIGH）**：加上 `1 ≤ id ≤ 2³¹-1` 的 Path bound，越界值改回 422。

- **`?offset=` parameter now rejects negative values and absurd offsets** — `/api/images?offset=-1` previously silently fell back to offset=0 returning real data; now responds 400. Upper bound 100 M caps blatant abuse.
  - **`?offset=` 拒绝负数和超大偏移量**：`/api/images?offset=-1` 改回 400 并指出是 offset 字段，上限 100M。

- **`/api/images?generator=nai` (singular) silently returned the entire library (MEDIUM)** — FastAPI dropped the singular form as an unknown query param, so `?generator=nai` returned 71k images instead of 2,291. Added singular aliases for `generator` / `tag` / `rating` / `checkpoint` / `lora` — merged + deduped with the plural form.
  - **`?generator=nai`（单数）静默回整个图库（MEDIUM）**：4 个字段的单数形式现在自动当复数 alias 合并去重。

- **Empty filter result no longer mistaken for empty library (MEDIUM)** — when a user filtered their library and got 0 results, they saw the "No images yet — Import a folder!" onboarding card meant for brand-new libraries. Added a second variant: "No images match your filters" + 🧹 "Clear all filters" CTA, fully bilingual.
  - **空筛选结果被误显示成「图库是空的」（MEDIUM）**：新增「没有符合条件的图片」+「清除所有筛选」按钮变体。

- **Reader save-as `output_path` errors (MEDIUM)** — writing into `C:\Windows\System32\` returned `500 UnhandledException`. Now `PermissionError` → 403, generic `OSError` → 400 with the underlying message. Empty `format=""` rejected at validation.
  - **Reader 另存为路径错误处理（MEDIUM）**：写到受限路径改回 403 / 400。

- **Mass-Tag-Editor modal Escape key did NOT close (MEDIUM)** — modal opened via private `classList.add('visible')` bypassing `showModal`; Escape didn't close, focus wasn't trapped, focus wasn't restored. Now delegates to `window.showModal/hideModal` with full ARIA.
  - **批量标签编辑器 modal 按 Escape 关不掉（MEDIUM）**：改成走 `window.showModal/hideModal`，ARIA 也补齐。

- **`/api/tags/bulk/cleanup` `min_confidence` accepted out-of-range values (MEDIUM)** — `>1.0` silently meant "remove all tags" (destructive when `dry_run=False`); `<0` was a silent no-op. Now bounded with Pydantic `ge=0.0, le=1.0`.
  - **`/api/tags/bulk/cleanup` `min_confidence` 接受超出范围的值（MEDIUM）**：加 `ge=0.0, le=1.0` Pydantic 约束。

- **Purge leaked pytest fixture rows from `images.db`** — older test runs sometimes leaked fixture rows into `data/images.db` when `TMPDIR` redirected to `data/tmp/`. Migration 011 detects and removes them; the test fixture now asserts `DATABASE_PATH` was actually patched so future regressions fail loudly.
  - **清理迁入图库的测试 fixture 行**：迁移 011 一次性清掉；fixture 本身也加了断言防回归。

- **PyPI + CUDA PyTorch downloads both auto-pick the fastest mirror** — launcher probes Tsinghua TUNA / Aliyun / USTC / official PyPI before `pip install`; the CUDA torch repair probes SJTU and the official PyTorch host. Chinese broadband users see the ~1.5 GB `requirements.txt` install drop from 10–25 minutes to a few minutes, and the 2.5 GB CUDA torch wheel from 30–60 minutes down similarly.
  - **PyPI 和 CUDA PyTorch 下载都自动选最快镜像**：启动脚本和 CUDA torch repair 都接入了镜像探测，国内宽带从原来的几十分钟降到几分钟。

- **Thumbnail cache temp-path collision fixed** — two writers in the same process+thread that both finished in the same `time.time_ns()` window could collide on the `.tmp` path. Path now combines PID + TID + nanosecond + process-local counter + 8 hex chars of OS randomness.
  - **缩略图缓存临时路径冲突**：路径组合改为 PID + TID + 纳秒戳 + 单调计数 + 8 个随机十六进制字符。

- **Windows browser no longer opens before server is ready** — launcher probes the port in a background PowerShell process and only opens the browser once the server responds (up to 15 s timeout). Eliminates the `ERR_CONNECTION_REFUSED` page on first launch.
  - **Windows 浏览器不再在 server 就绪前打开**：启动器后台探测端口，server 响应后才开浏览器。

- **macOS source-clone no longer rejected by `run.sh`** — the Darwin check now only fires inside release tarballs (detected via `update/package-manifest.json`), so users cloning from source on macOS can run `./run.sh` directly.
  - **macOS 从源码 clone 不再被 `run.sh` 拒绝**：Darwin 检查只在 release tarball 内触发。

- **Onboarding tour, model-download cancel, and 4-minute polling timeout** — first-run gallery auto-starts the guided tour; in-progress model downloads now expose a Cancel button; polling has a 4-minute timeout that re-enables the Prepare button instead of spinning forever.
  - **首次启动引导导览 / 模型下载可取消 / 4 分钟超时**：空图库自动启动导览；下载中出现 Cancel 按钮；4 分钟无响应提示并恢复按钮。

- **Gallery auto-refreshes after tagging / VLM completion** — tagging done path dispatches a `taggingCompleted` event; VLM batch completion dispatches `vlmBatchCompleted` and calls `loadImages()` + `loadStats()`, so freshly tagged images surface without switching tabs.
  - **打标 / VLM 完成后图库自动刷新**：完成事件触发自动 `loadImages()` + `loadStats()`，不用切 tab 再切回来。

- **i18n stays fresh after upgrade without `Ctrl+Shift+R`** — `<script>` / `<link>` tags now get `?v=APP_VERSION` cache-bust, and the Help modal exposes a "🔄 Refresh translations" button that re-fetches language packs in place (gallery filters, scan progress, selection, `localStorage` all survive the swap).
  - **升级后 i18n 不再需要硬刷**：cache-bust + Help 弹窗「🔄 重新载入界面文字」按钮原地重抓。

- **Filter modal generator labels alignment + filter stat grid + chip exclude** — order-sensitive `_setCheckboxTexts` list updated to match the new 14-generator HTML order so reForge / Fooocus no longer render as 其他 / 未知 in zh-CN; filter modal's 9 stat chips fit one row at any width; stale "up to 20 images" text removed from export preview; duplicate `TestExportSelectionData` test class renamed.
  - **筛选弹窗 generator 标签对齐 + 9 chip 单行 + 过期文案清理**：标签翻译列表与新 HTML 顺序对齐；9 chip 单行；移除「最多 20 张」过期文字；重复测试类重命名。

---

## ⚠️ Upgrading / 升级注意

- **Smart Tag now requires an explicit VLM endpoint** (api_key only required for cloud providers): if you previously had natural-language captioning enabled without configuring VLM Settings, Smart Tag will now error out instead of silently running booru-only. Local Ollama / vLLM / LM Studio servers (localhost / `*.local` / RFC1918 LAN) work without an api_key; cloud providers still need one. Vertex AI Gemini uses `vertex_project` + service-account credentials instead of an api_key.
  - **智能标注现在强制 VLM 端点**（云端服务才需要 api_key）：之前没配置 VLM Settings 但勾了 NL caption 的用户，现在按 Run 会报错。本地 Ollama / vLLM / LM Studio（localhost / `*.local` / RFC1918 私网段）不需要 api_key，云端服务仍需。Vertex AI Gemini 用 `vertex_project` + 服务账号凭据替代 api_key。

- **Dataset Maker UI is now a 3-tab nav** (Import / Workbench / Export) with an optional Audit modal — earlier v3.2.2 docs incorrectly described a "5-step pipeline". The 3-tab layout is intentional and final.
  - **Dataset Maker 改为 3-tab 导航**（导入 / 工作台 / 输出）+ 可选审计模态。早期 v3.2.2 文件误称「5 步 pipeline」，3-tab 是定版。

- **Migrations 011 (test-fixture purge) + 012 (VLM garbage-tag cleanup) + 013 (stress-test pollution)** run automatically on first launch. No manual action required.
  - **迁移 011（清理测试 fixture 行）+ 012（清理 VLM 垃圾标签）+ 013（清理 stress-test 污染）** 首次启动自动执行。

- **Auto-Separate / Manual Sort default to "copy"**: if you rely on the old "move" default for an automated workflow, flip the radio once — your choice is persisted to localStorage.
  - **Auto-Separate / Manual Sort 预设改为「复制」**：靠旧「移动」预设的自动化流程请手动切一次，选择会写入 localStorage。

- **Existing rows whose generator is still `unknown` keep that value** — new scans, reparses, and Reader / clipboard uploads use the new `others` classification when appropriate.
  - **既有的 `unknown` 行保留原值**：重新扫描、reparse、Reader / 剪贴板上传的新图会用新的 `others` 分类。

- **macOS Intel (x86_64)** keeps `torch==2.2.2` / `torchvision==0.17.2` / `opencv-python==4.9.0.80` per-platform pins because PyTorch dropped Intel macOS wheels after 2.2.2 and opencv 4.11 only ships macOS 13+ wheels.
  - **macOS Intel (x86_64)** 维持旧版 pin，因为 PyTorch 在 2.2.2 之后没有 Intel Mac wheel。

---

## ✅ Validation / 验证

- Backend: 1526 passed / 6 skipped / 0 failed on Python 3.12.7 + numpy 1.26.4 (98 s)
- Backend: 1526 passed / 6 skipped / 0 failed on Python 3.13.13 + numpy 2.4.6 + torch 2.11.0+cpu + transformers 5.6.2 (561 s)
- Linux portable smoke (x86_64 on `ubuntu-22.04` + aarch64 on `ubuntu-24.04-arm`): pass
- Frontend Dataset Maker + Smart Tag UI manually re-reviewed pre-release

---

## ⬇️ Which file should I download? / 我该下载哪一个？

**Windows → `sd-image-sorter-v3.2.2-windows-portable.zip`** — extract, run `run-portable.bat`.

**Linux (any modern distro, including Python 3.13 / 3.14 systems and Raspberry Pi 5) → `sd-image-sorter-v3.2.2-linux-portable-x86_64.tar.gz`** or `…-aarch64.tar.gz` — extract, `chmod +x run-portable.sh`, run `./run-portable.sh`.

**Linux source install** (advanced users with their own Python 3.12 / 3.13 toolchain) → `sd-image-sorter-v3.2.2-linux.tar.gz` — extract, run `./run.sh`.

**Do NOT download / 不要下载：**
- `sd-image-sorter-v3.2.2-app-patch.zip` — in-app updater payload only / 仅供更新器
- `sd-image-sorter-v3.2.2-release-manifest.json` — updater metadata / 更新器元数据

---

## Checksums

See `release-manifest.json` for the SHA-256 of each release asset.
