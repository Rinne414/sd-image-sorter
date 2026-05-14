## v3.1.6 — 稳定性与大图库性能修复 / Stability and Large-Library Performance Fixes

这版是发布前的稳定性补丁：修掉 WD14 tagger 阈值复用问题、Windows 轻量启动后 WD14 GPU runtime 没有被 Prepare 修复的问题、相似度进度竞态、更新退出时的硬退出风险、Censor resize 监听泄漏，并让大图库翻页 / generator facet / Prompt Lab 图片选择器更轻。

This release is a stability patch before publishing: it fixes WD14 tagger threshold reuse, WD14 GPU runtime repair after Windows lightweight startup, similarity progress races, hard-exit risk during update apply, Censor resize listener cleanup, and makes large-library pagination, generator facets, and the Prompt Lab image picker lighter.

---

## Fixed / 修复

- **Tagger thresholds are request-scoped**: Reusing the same loaded WD14 model no longer means later calls silently inherit the first call’s threshold. `tag()` / `tag_batch()` now pass per-call general and character thresholds into result scoring.
  - Tagger 阈值现在按请求隔离：复用同一个 WD14 模型时，后续调用不会继续吃第一次调用的阈值。`tag()` / `tag_batch()` 会把本次请求的 general / character 阈值传入评分流程。

- **Prompt Lab image search now sends the real search parameter**: The image picker now uses `search`, matching `/api/images`, instead of the ignored `searchQuery` key.
  - Prompt Lab 图片搜索现在会真正带上 `search` 参数，不再使用 `getImages()` 不认识的 `searchQuery`。

- **Windows ONNX GPU runtime repair is hardware-gated and constrained**: Windows portable startup and WD14 Prepare / Recheck run ONNX Runtime repair before tagger code loads. Supported NVIDIA machines may spend extra first-start time installing `onnxruntime-gpu==1.21.0` plus CUDA/cuDNN runtime DLLs; AMD/Intel machines install `onnxruntime-directml==1.21.0`; CPU-only or undetected hardware keeps the lightweight CPU runtime. Repair also downgrades incompatible newer installs such as `onnxruntime-gpu 1.26.0` / newer DirectML wheels, force-reinstalls the pinned runtime when the `onnxruntime` import surface is corrupt, and uses no-deps / pip-safe locked constraints so CUDA extra installs do not drift shared pins such as NumPy. If repair changes runtime packages while the app is already open, restart before GPU tagging.
  - Windows ONNX GPU 运行库修复现在会按硬件 gating 且受锁定约束：Windows 便携版启动、WD14 Prepare / Recheck 都会在 tagger 代码加载前运行 ONNX Runtime 修复。支持的 NVIDIA 机器首次启动可能会额外花时间安装 `onnxruntime-gpu==1.21.0` 和 CUDA/cuDNN runtime DLL；AMD/Intel 机器会安装 `onnxruntime-directml==1.21.0`；纯 CPU 或未可靠检测到 GPU 的机器保留轻量 CPU runtime。修复也会把 `onnxruntime-gpu 1.26.0` 或较新的 DirectML wheel 这类不兼容版本降回发布 pin，在 `onnxruntime` 导入表面损坏时强制重装发布 pin，并用 no-deps / 锁定 constraints 避免 CUDA extras 把 NumPy 等共享依赖漂到未锁版本。如果 app 已经打开后才修复运行库，请重启后再跑 GPU 打标。

- **Similarity embedding progress is updated under lock**: Progress readers should no longer see partially replaced embedding progress state.
  - 相似度 embedding 进度现在在锁内更新，避免读取到半更新状态。

- **Update apply exits more gracefully**: The updater shutdown path now sends `SIGINT` instead of calling `os._exit(0)`, giving cleanup hooks a chance to run.
  - 应用更新时现在用 `SIGINT` 关闭，而不是直接 `os._exit(0)`，让清理流程有机会执行。

- **Censor resize listener cleanup**: The Censor editor resize handler is debounced and removed when leaving the Censor view.
  - Censor 编辑器 resize 处理加了防抖，并在离开 Censor 页面时清理监听。

- **JPEG prompt metadata scanning**: `.jpg` / `.jpeg` images are now scanned for Stable Diffusion metadata in EXIF `UserComment` and APP1 XMP, including UTF-16 `UNICODE` UserComment blocks. Existing JPEG records from older parser versions will reparse during a normal folder scan; no force reparse is required.
  - JPEG 提示词元数据扫描：现在会从 `.jpg` / `.jpeg` 的 EXIF `UserComment` 和 APP1 XMP 里扫描 Stable Diffusion 元数据，包括 UTF-16 `UNICODE` UserComment。旧解析版本扫过的 JPEG 记录会在普通文件夹扫描时自动重扫，不需要手动 force reparse。

- **More metadata sources without heavy scans**: TIFF/TIF, GIF comments, WebP XMP chunks, and small same-name `.txt` / `.json` / `.xmp` sidecars can now fill Gallery metadata when embedded image metadata is missing. The scanner still reads metadata/header structures only, caps sidecar size, and avoids automatic full-library reparses for PNG/WebP/TIFF.
  - 更多元数据来源，但不做重型扫描：TIFF/TIF、GIF comment、WebP XMP chunk，以及小体积同名 `.txt` / `.json` / `.xmp` sidecar 现在可以在图片内嵌元数据缺失时补充 Gallery 元数据。扫描器仍然只读 metadata/header 结构，限制 sidecar 大小，并避免对 PNG/WebP/TIFF 自动全图库重扫。

---

## Improved / 优化

- **Cursor pagination skips unnecessary count queries**: Cursor-paginated image pages skip the expensive total count after the first page.
  - 游标翻页在后续页跳过昂贵的总数查询。

- **Simple image queries avoid unnecessary DISTINCT**: Non-join image queries no longer pay for `SELECT DISTINCT` when it is not needed.
  - 简单图片查询不再无意义使用 `SELECT DISTINCT`。

- **Generator facet results are cached briefly**: Generator counts use a short TTL cache and are invalidated when image records change.
  - Generator 分类计数使用短 TTL 缓存，并在图片记录变化时失效。

- **Prompt Lab image picker is lighter on large libraries**: The picker loads an initial 200-image page and uses server-side search instead of loading the entire library into memory.
  - Prompt Lab 图片选择器初始只取 200 张，并使用服务端搜索，不再一次性加载整个图库。

---

## Upgrading / 升级注意

- No database migration needed. This is a drop-in replacement for v3.1.5.
  - 不需要数据库迁移。可以直接替换 v3.1.5。
- If you use the in-app updater, keep the app open until it reports that the update has been staged, then let it restart/shut down normally.
  - 如果使用内置更新器，请等它提示更新已准备好，再让程序正常重启 / 关闭。

---

## Validation / 验证

Local release validation passed with `python3 scripts/run_ci.py`:

- compiled lock freshness: passed
- dependency security audit: passed
- frontend JS syntax: passed
- backend full suite: 1019 passed, 5 skipped
- Playwright E2E: 121 passed, 5 skipped

本地发布验证已通过 `python3 scripts/run_ci.py`：依赖锁、依赖安全扫描、前端 JS 语法、后端全量测试、Playwright E2E 全部通过。

---

## ⬇️ Which file should I download? / 我该下载哪一个？

**Windows → windows-portable.zip** — extract, run `run-portable.bat`
**Linux → linux.tar.gz** — extract, run `./run.sh`

**Do NOT download / 不要下载：**
- app-patch.zip — in-app updater only / 仅供更新器
- release-manifest.json — updater metadata / 更新器元数据

---

## Checksums

See `release-manifest.json` for SHA-256 checksums of all assets.
