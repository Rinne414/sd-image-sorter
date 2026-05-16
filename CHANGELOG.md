# Changelog

All notable changes to SD Image Sorter will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [3.2.0] - 2026-05-16

### Added / 新增
- **Detect more generators**: Fooocus, sd-webui-reForge, Easy Diffusion, InvokeAI (v3 `invokeai_metadata`, v3 `invokeai_graph`, v2 `sd-metadata`, legacy `Dream`), SwarmUI / StableSwarmUI (`sui_image_params`), Draw Things (XMP `exif:UserComment`), Gemini / nano-banana (Software/Make/Description regex + C2PA byte-scan), and OpenAI gpt-image / ChatGPT / DALL-E (Software/Make/Description regex + C2PA byte-scan). All show their actual generator name in the gallery now instead of "Unknown" or generic "Others".
  - **识别更多 generator**：Fooocus、sd-webui-reForge、Easy Diffusion、InvokeAI（v3 `invokeai_metadata`、v3 `invokeai_graph`、v2 `sd-metadata`、旧版 `Dream`）、SwarmUI / StableSwarmUI（`sui_image_params`）、Draw Things（XMP `exif:UserComment`）、Gemini / nano-banana（Software/Make/Description 关键字 + C2PA 字节扫描）、OpenAI gpt-image / ChatGPT / DALL-E（Software/Make/Description 关键字 + C2PA 字节扫描）。这些图现在在图库里都会显示真实的生成器名字，不再统一归到"Unknown"或笼统的"Others"。
- **C2PA Content Credentials byte-scan**: when a Gemini or gpt-image image has its EXIF tags stripped by hosting platforms (Twitter / Discord / Pixiv re-encode), the parser now scans the first 512 KiB of the file for a C2PA / JUMBF manifest anchor and the provider's `claim_generator_info`. Anchor-required guard prevents false positives where an SD prompt happens to mention "openai-style" or "imagen-style".
  - **C2PA Content Credentials 字节扫描**：图片被平台重新转存导致 EXIF 被清掉时，本版本会去文件前 512 KiB 找 C2PA / JUMBF manifest 锚点和 `claim_generator_info`，从而仍然识别出 Gemini 和 gpt-image。需要锚点 + 厂商关键字同时命中才算数，避免提示词中提到 "openai" 类似词被误判。
- **Filter Criteria modal expanded**: the filter modal now lists all 14 generators (ComfyUI / NovelAI / WebUI / Forge / reForge / Fooocus / InvokeAI / SwarmUI / Easy Diffusion / Draw Things / Gemini / gpt-image / Unknown / Others) so users can isolate exactly the generator they want. The top-level gallery tab bar stays compact at 5 primary tabs + 1 "Others" bucket.
  - **筛选条件弹窗扩充**：筛选弹窗现在列出全部 14 个 generator，可以精确单选某一个。最上方的图库分类列保持紧凑，仍然是 5 个主分类 + 1 个 "其他" 合集。
- **"Others" tab bundles uncommon generators**: clicking the "Others" gallery tab queries the union of `others / fooocus / reforge / easy-diffusion / invokeai / swarmui / drawthings / gemini / gpt-image`, and the badge count sums them.
  - **"其他" 分类合并罕见 generator**：点击 "其他" 分类会一次性显示罕见 generator 全部，徽标数字也是合计。
- **"Download all recommended models" button in Feature Setup**: one click to fetch every recommended model in one go (default WD14 swinv2 / NudeNet / CLIP / Aesthetic / Artist ID / SAM 3). Confirmation dialog shows total disk space needed, per-model size, which models will be downloaded vs already ready, and which models are intentionally skipped (Wenaka Privacy YOLO and ToriiGate). Downloads run sequentially with progress; the dialog can be closed to leave the download running in the background.
  - **功能准备新增 "一键下载推荐模型"**：一次性下载所有推荐模型（默认 WD14 swinv2、NudeNet、CLIP、美学评分、画师识别、SAM 3）。确认窗会显示所需磁盘空间总量、每个模型体积、哪些会下载、哪些已就绪，以及为什么跳过 Wenaka Privacy YOLO 和 ToriiGate。多个模型按顺序下载，可关掉窗口让它在后台继续。
- **Closed-source AI provider notice in image-detail modal**: when the user opens a Gemini or gpt-image image, an inline note now explains that the source was identified via Content Credentials / EXIF metadata and that the in-pixel invisible watermark (SynthID for Gemini, OpenAI's pixel signal for gpt-image) is NOT yet checked by the app. Tracked as a TODO for a future opt-in detector.
  - **图片详情弹窗对闭源 AI 厂商图片增加提示**：打开 Gemini 或 gpt-image 图片时会显示一行提示，说明本图通过 Content Credentials / EXIF 元数据识别，App 暂时还没检测像素层的隐形水印（Gemini 的 SynthID、OpenAI 的内嵌信号）。已记入 TODO，未来作为可选功能加入。

### Changed / 變更
- **Setup moved to the nav bar**: the global "Setup" button now lives in the top nav bar, reachable from any view (Reader, Censor, Sorting, Library Health) instead of being hidden in the gallery toolbar.
  - **Setup 移到主導航**：全域用的 "Setup" 按鈕現在在最上方導航列，從任何頁面都可以打開，不再藏在 Gallery 工具列裡。
- **Clear Gallery moved into the gallery toolbar**: the destructive "Clear Gallery" action moved out of the global nav bar and into the gallery toolbar, where its scope is visible.
  - **Clear Gallery 移到 Gallery 工具列**：破壞性的 "Clear Gallery" 按鈕從全域導航列移到 Gallery 自己的工具列，在 UI 上明確只影響當前 gallery。
- **Setup added to the mobile menu**: a "Setup" entry was added to the mobile navigation panel.
  - **手機選單新增 Setup 入口**：手機版選單也能直接打開 Setup。
- **Generator filter and tab list now expose "Others"**: gallery generator tabs, the filter modal, and gallery counts now include an "Others" category alongside ComfyUI / NovelAI / WebUI / Forge / Unknown.
  - **Generator 分類與篩選新增 "Others"**：分類列、篩選彈窗、計數都多了 "Others" 一欄。

### Fixed / 修复
- **Fresh Windows portable: SAM3 now survives a flaky CUDA-index download (release blocker)**: when `repair_torch_runtime.py` ran on first SAM3 prepare and the cu126 wheel download hit an `IncompleteRead` or DNS hiccup mid-transfer, the fallback loop tried cu124 / cu121 in order. Each fallback used `--extra-index-url https://pypi.org/simple` plus a plain `torch==X.Y.Z` requirement, which let pip silently satisfy the requirement from PyPI's CPU torch wheel instead of the cu-specific index. The install reported success, but `torch.version.cuda` was empty and SAM3 refused to load with the confusing message "this app's Python has CPU-only PyTorch; SAM3 needs a CUDA-enabled Torch build". The user had no clear path forward. Fixed by (1) pinning the explicit `+cuXXX` local-version label on the torch and torchvision requirements so PyPI's no-suffix CPU wheel cannot match, (2) dropping `--extra-index-url` from the cu-index pip call so the cu-specific index is the only source, and (3) installing the `numpy<2.0` constraint in a separate up-front pip call from PyPI (numpy never lives on download.pytorch.org). A new regression test `test_cuda_install_pins_local_version_label_so_pypi_cannot_satisfy` locks the behaviour.
  - **Windows 便携版首次启动 SAM3 在 CUDA 索引网路抖动下也能装好（发布阻断 bug）**：第一次准备 SAM3 时如果 cu126 wheel 下载中途断流（`IncompleteRead`、DNS 解析失败等），原本的回退会接着试 cu124 / cu121，每次重试都带 `--extra-index-url https://pypi.org/simple` + 普通 `torch==X.Y.Z`，结果 pip 在 cu 索引断流时悄悄从 PyPI 拉到 CPU 版 torch wheel，安装报成功但 `torch.version.cuda` 是空的，SAM3 报 "Python 是 CPU-only PyTorch，SAM3 需要 CUDA 版" 让人摸不着头脑。修复方法：(1) 给 torch / torchvision 加上明确的 `+cuXXX` local version 标签，PyPI 上没后缀的 CPU wheel 没法对上；(2) 从 cu 索引那次 pip 调用中移除 `--extra-index-url`，让 cu 专属索引成为唯一来源；(3) 把 `numpy<2.0` 这个约束改成单独一次 pip 调用从 PyPI 装，因为 numpy 从来不放在 download.pytorch.org。新增回归测试 `test_cuda_install_pins_local_version_label_so_pypi_cannot_satisfy` 锁住新行为。
- **Fresh Windows portable: ONNX Runtime now installs on first launch (release blocker)**: when `repair_onnxruntime.py` ran on a freshly-extracted Windows portable with NO onnxruntime variant installed at all (`onnxruntime`, `onnxruntime-gpu`, `onnxruntime-directml` all missing), it would report "No repair needed" and exit cleanly. The next WD14 / NudeNet / CLIP model download then failed with `No module named 'onnxruntime'`. The repair function only handled the cases where at least one variant was already present (CPU+GPU coexisting, CPU-only-with-GPU-detected, both GPU runtimes installed, mismatched vendor). The empty-state case fell through every branch. Fixed by adding Step 0: when nothing is installed, install the runtime that matches the detected GPU vendor (NVIDIA → `onnxruntime-gpu[cuda,cudnn]`, AMD/Intel → `onnxruntime-directml`, no vendor detected → CPU `onnxruntime`). Two new regression tests (`test_repair_installs_runtime_when_nothing_present_with_nvidia_vendor` and `test_repair_falls_back_to_cpu_runtime_when_nothing_present_and_no_gpu_detected`) lock the behaviour.
  - **Windows 便携版首次启动 ONNX Runtime 自动安装（发布阻断 bug）**：刚解压的 Windows 便携版本来一个 onnxruntime 变体都没装的情况下，`repair_onnxruntime.py` 会报 "No repair needed" 然后正常退出。之后第一次下载 WD14 / NudeNet / CLIP 模型就会因为 `No module named 'onnxruntime'` 失败。修复方法是给 repair 函数加 Step 0：当所有 onnxruntime 变体都不存在时，按检测到的 GPU 厂商安装匹配版本（NVIDIA→`onnxruntime-gpu[cuda,cudnn]`、AMD/Intel→`onnxruntime-directml`、未检测到 GPU→CPU 版 `onnxruntime`）。新增两个回归测试锁住新行为。
- **Real Fooocus output now classifies as Fooocus, not NAI**: upstream lllyasviel/Fooocus writes its `Comment` PNG chunk with lowercase `prompt` + `negative_prompt` keys plus Fooocus-specific siblings (`base_model`, `performance`, `metadata_scheme`). Earlier drafts of the parser saw the lowercase `prompt` key and classified the image as NovelAI. The parser now disambiguates Fooocus vs NovelAI by looking for sibling keys (or `negative_prompt` without `uc`) before claiming the block.
  - **真实 Fooocus 输出现在归到 Fooocus，不再归到 NAI**：上游 lllyasviel/Fooocus 写到 PNG `Comment` 里的 JSON 用的是小写 `prompt` + `negative_prompt`，加上 Fooocus 自己的 sibling key（`base_model`、`performance`、`metadata_scheme`）。之前看到小写 `prompt` 就直接当 NovelAI 处理。现在 parser 会先用 sibling key（或 `negative_prompt` 但没有 `uc`）来区分 Fooocus 与 NovelAI。
- **Chinese UI: navbar emoji icons no longer clipped**: a global text-truncation rule (`overflow:hidden; text-overflow:ellipsis`) on `.nav-actions .btn span:last-child` was clipping the emoji glyph (the ONLY child) on icon-only buttons (🧰 Setup / 📚 Library / 🌐 Language / ⬆️ Update / ❓ Help) by ~24px. Fixed by scoping the rule to `:not(.btn-icon-only)` and adding an explicit unclipped rule for `.btn-icon-only span[aria-hidden]`. Visual symptom was most obvious in Chinese because longer translations made the navbar layout tighter.
  - **中文 UI：导航栏 emoji 图标不再被裁切**：导航栏图标按钮（🧰 Setup / 📚 Library / 🌐 Language / ⬆️ Update / ❓ Help）的 emoji 图标因为一条全局的文本省略规则（`overflow:hidden; text-overflow:ellipsis`）被裁掉了大约 24px。修复方式是把规则限制在非 icon-only 按钮上。中文模式下因为标签更长、布局更紧，问题最明显。
- **Filter modal generator labels alignment**: the order-sensitive `_setCheckboxTexts` translation list was binding 6 keys to the 14 new checkboxes, causing reForge / Fooocus to render as "其他" / "未知" in zh-CN. List updated to match the new HTML order.
  - **筛选弹窗 generator 标签错位**：旧的 `_setCheckboxTexts` 只传了 6 个翻译 key 给新加的 14 个 checkbox，导致 reForge / Fooocus 在简中模式下显示成 "其他" / "未知"。已按新 HTML 顺序补齐 14 个 key。
- **Metadata parser no longer silently buckets recognizable images into "Unknown"**: PNG / JPEG / WebP rows that carry a real prompt, negative prompt, checkpoint, or LoRA list but whose generator string is not ComfyUI / NovelAI / WebUI / Forge are now classified as `others` instead of `unknown`.
  - **Metadata parser 不再把有 metadata 的圖默默歸成 "Unknown"**：有真實 prompt / negative prompt / checkpoint / LoRA、但 generator 字串不在已知列表內的 PNG / JPEG / WebP 現在歸到 `others`，不再混進 `unknown`。

### Notes / 備註
- No database migration. Drop-in replacement for v3.1.6.
  - 不需要資料庫遷移，可以直接替換 v3.1.6。
- Existing rows whose generator is `unknown` keep that value; new scans, reparses, and Reader / clipboard uploads use the new generator labels when applicable.
  - 升級後 `unknown` 的舊 row 保留原值；新掃描、reparse、Reader / 剪貼簿上傳的新圖在合適情況下會用上新的 generator 標籤。
- Detection uses metadata only — see the in-app notice on Gemini / gpt-image images for the limitation. Tracked as `Debt-23` in `docs/TECHNICAL_DEBT_NOTES.md` (pixel-level SynthID detection deferred to opt-in feature).
  - 识别只读元数据 —— Gemini / gpt-image 图片的弹窗里有提示。已记录在 `docs/TECHNICAL_DEBT_NOTES.md` 的 `Debt-23`（像素级 SynthID 检测延后做为可选功能）。

## [3.1.6] - 2026-05-13

### Fixed / 修复
- **Tagger threshold race condition**: concurrent tagging requests no longer corrupt each other's confidence thresholds.
  - **标签器阈值竞态条件**：并发标签请求不再互相覆盖置信度阈值。
- **Graceful shutdown on update**: update apply now uses SIGINT instead of os._exit(0), allowing proper cleanup of DB connections and pending writes.
  - **更新时优雅关闭**：更新应用现在使用 SIGINT 而非 os._exit(0)，确保数据库连接和待写入数据正确清理。
- **Similarity progress race**: embedding progress dict is now updated under its lock, preventing partial reads.
  - **相似度进度竞态**：嵌入进度字典现在在锁内更新，防止读取到不完整状态。
- **Censor resize listener leak**: resize handler is now debounced (150ms) and removed when leaving censor view.
  - **打码编辑器 resize 泄漏**：resize 处理器现在有 150ms 防抖，离开打码视图时移除。
- **JPEG prompt metadata scanning**: `.jpg` / `.jpeg` images are now parsed for SD metadata in EXIF `UserComment` and APP1 XMP, including UTF-16 `UNICODE` UserComment blocks. Existing JPEG rows parsed by older parser versions will reparse on normal folder scan.
  - **JPEG 提示词元数据扫描**：现在会从 `.jpg` / `.jpeg` 的 EXIF `UserComment` 和 APP1 XMP 里解析 SD 元数据，包括 UTF-16 `UNICODE` UserComment。旧解析版本扫过的 JPEG 行会在普通文件夹扫描时自动重扫。
- **Broader bounded metadata harvesting**: TIFF/TIF images, GIF comments, WebP XMP chunks, and small same-name `.txt` / `.json` / `.xmp` sidecars can now feed Gallery metadata when embedded fields are missing. Sidecars are size-capped and fallback-only to avoid slowing normal scans.
  - **更广但有边界的元数据收集**：TIFF/TIF、GIF comment、WebP XMP chunk，以及小体积同名 `.txt` / `.json` / `.xmp` sidecar 现在可以在图片内嵌字段缺失时补充 Gallery 元数据。Sidecar 有大小限制且只作兜底，避免拖慢普通扫描。

### Improved / 优化
- **Pagination performance**: COUNT query automatically skipped on cursor-paginated pages (saves 200-500ms per page on large libraries).
  - **翻页性能**：游标翻页时自动跳过 COUNT 查询（大图库每页节省 200-500ms）。
- **Query efficiency**: removed unnecessary SELECT DISTINCT on non-JOIN queries (10-30% faster for simple filters).
  - **查询效率**：非 JOIN 查询移除不必要的 SELECT DISTINCT（简单过滤快 10-30%）。
- **Generator facet cache**: get_all_generators() now cached with 60s TTL (saves 10-50ms per gallery load).
  - **生成器缓存**：get_all_generators() 现在有 60 秒 TTL 缓存（每次加载图库节省 10-50ms）。
- **Prompt Lab memory**: image picker no longer loads entire library into memory; uses server-side search with 200-image initial page.
  - **Prompt Lab 内存**：图片选择器不再将整个图库加载到内存；使用服务端搜索，初始只加载 200 张。
- **WD14 GPU runtime repair**: Windows portable startup and WD14 Prepare / Recheck now run ONNX Runtime repair before tagger code loads. Supported NVIDIA hardware is repaired to `onnxruntime-gpu==1.21.0` plus CUDA/cuDNN runtime DLLs; AMD/Intel hardware is repaired to `onnxruntime-directml==1.21.0`; CPU-only or undetected hardware keeps the small CPU runtime. Repair also downgrades incompatible newer installs, force-reinstalls the pinned runtime when the `onnxruntime` import surface is corrupt, and uses no-deps/pip-safe locked constraints so first launch does not reinstall GPU runtime twice or drift shared pins such as NumPy.
  - **WD14 GPU 运行库修复**：Windows 便携版启动、WD14 Prepare / Recheck 现在都会在 tagger 代码加载前运行 ONNX Runtime 修复。检测到 NVIDIA 时修复到 `onnxruntime-gpu==1.21.0` 并补 CUDA/cuDNN runtime DLL；检测到 AMD/Intel 时修复到 `onnxruntime-directml==1.21.0`；纯 CPU 或未可靠检测到 GPU 时保留轻量 CPU runtime。修复也会把不兼容的新版本降回发布 pin，在 `onnxruntime` 导入表面损坏时强制重装发布 pin，并用 no-deps/锁定 constraints 避免首启重复重装 GPU runtime 或把 NumPy 等共享依赖漂到未锁版本。

## [3.1.5] - 2026-05-12

### Changed / 改进
- **Prompt Lab fixed tags**: Generate / Randomize now supports fixed beginning and ending tags with automatic duplicate removal. Presets save and restore these fields, and the UI explains the behavior in beginner-readable copy.
  - **Prompt Lab 固定标签**：生成 / 随机生成现在支持固定加开头和固定加结尾，并自动去重。Preset 会保存 / 恢复这些字段，界面文案也改成新手能直接看懂。
- **Export scope clarity**: Combined Export and same-name `.txt` export now explicitly say they only affect the currently selected Gallery images, so users can add training caption prefixes/blacklists to just one selected batch.
  - **导出范围更清楚**：Combined Export 和同名 `.txt` 导出现在明确说明只影响当前在图库里选中的图片，方便只给某一批训练 caption 加前缀 / 黑名单。
- **Censor model clarity**: Auto Censor now shows the actual local YOLO file being used near the detector selector, instead of hiding it inside the advanced picker only.
  - **打码模型更清楚**：自动打码现在会在检测器选择器附近显示实际使用的本地 YOLO 文件，不再只藏在高级选择器里。
- **Optional AI dependency predictability**: Feature Setup optional Python installs now prefer the exact versions already pinned in `backend/requirements.txt` when preparing feature groups, reducing surprise resolver drift.
  - **可选 AI 依赖更可预测**：Feature Setup 准备可选功能时，会优先使用 `backend/requirements.txt` 里已经锁定的精确版本，减少 pip 临场解析漂移。
- **Security lock refresh**: `urllib3` is pinned to `2.7.0` in the full/dev runtime locks to clear the current pip-audit CVE report.
  - **安全锁定更新**：full/dev runtime lock 中的 `urllib3` 已升到 `2.7.0`，解决当前 pip-audit 报告的 CVE。

### Fixed / 修复
- **Portable launcher runtime check**: The portable launcher dependency probe now checks only startup-critical packages (`fastapi`, `PIL`, `numpy`, `onnxruntime`). Optional heavy AI packages no longer force repeated `pip install` on every startup.
  - **Portable 启动依赖检查**：便携版启动器现在只检查启动必需包（`fastapi`、`PIL`、`numpy`、`onnxruntime`）。可选重型 AI 包不会再导致每次启动都重跑 `pip install`。


## [3.1.4] - 2026-05-10

### Fixed / 修复
- **Artist ID / Kaloscope availability**: `triton` is no longer a hard blocker for Artist ID on Windows. The health check now treats triton as informational instead of blocking `available=True`. Feature Setup Prepare now also installs `triton-windows` (Windows) or `triton` (Linux) as a best-effort soft dependency — if the install fails, core Artist ID still works with the PyTorch fallback.
  - **画师识别 / Kaloscope 可用性**：`triton` 不再是 Windows 上画师识别的硬性阻断条件。健康检查现在把 triton 视为信息提示而非阻止 `available=True`。Feature Setup 的 Prepare 现在也会尝试安装 `triton-windows`（Windows）或 `triton`（Linux）作为 best-effort 软依赖——如果安装失败，核心画师识别仍然可以通过 PyTorch fallback 正常工作。
- **Prompt filter duplicate bug**: Clicking a prompt suggestion in the filter modal now normalizes underscores to spaces before checking for duplicates, matching the existing Enter-key handler behavior. Previously, clicking a suggestion could add a duplicate prompt if the existing filter used spaces while the suggestion used underscores (or vice versa).
  - **Prompt 过滤器重复 bug**：在过滤器弹窗中点击 prompt 建议现在会在检查重复前将下划线正规化为空格，与已有的回车键处理逻辑一致。之前点击建议可能会添加重复的 prompt（如果现有过滤器用空格而建议用下划线，或反之）。

## [3.1.3] - 2026-05-09

### Fixed / 修复
- Large folder scans are now safer for 80k+ metadata-heavy libraries: metadata parsing uses bounded process workers by default, timed-out metadata reads are skipped instead of freezing the whole scan, expected corrupt-image metadata failures stay out of normal console noise, and scan progress exposes stalled-state diagnostics with support log access. This does not mean every filesystem wait can be killed; network/cloud drives, antivirus, SQLite/disk I/O, or OS directory enumeration can still be slow, but the UI now tells users what is happening and how to collect support information.
  - 大图库扫描现在对 8 万+ 带 metadata 的图片更安全：metadata 解析默认走有上限的进程 worker，单图 metadata 超时会跳过而不是拖死整个扫描，常见坏图 metadata 错误不会刷爆普通终端，并且扫描进度会暴露卡住诊断和支持日志入口。这不代表所有文件系统等待都能被强杀；网络盘/云盘、杀毒软件、SQLite/磁盘 I/O、系统枚举目录仍可能很慢，但 UI 会明确告诉用户当前情况和如何收集支持信息。
- Metadata storage compaction now covers old and new write paths: scans, reparses, copied images, direct DB upserts, and favorites/collection snapshots are normalized to compact `_compact` / `_parsed` payloads instead of re-copying legacy raw EXIF/XMP/ComfyUI workflow blobs back into `images.db`. Migration 009 also catches raw-only metadata rows that an already-run v8 migration could have missed.
  - metadata 存储瘦身现在覆盖旧库和新写入口：扫描、重新解析、复制图片、直接 DB upsert、收藏/collection 快照都会统一写入 compact 的 `_compact` / `_parsed`，不会把旧 raw EXIF/XMP/ComfyUI workflow 大块数据重新塞回 `images.db`；新增迁移 009 会补压已经跑过 v8 但漏掉的 raw-only metadata 行。
- Feature Setup now keeps first launch lightweight: the default launcher installs only core dependencies, heavy AI Python packages move behind Prepare, system Python is protected from accidental optional installs, and old full-AI installs can schedule a next-start lightweight runtime rebuild without deleting `data/`, `images.db`, settings, caches, or downloaded models.
  - Feature Setup 现在让首次启动保持轻量：默认启动器只装核心依赖，重型 AI Python 包改为按需 Prepare，system Python 默认不会被误装 optional 包；旧的 full-AI 安装可以安排下次启动重建轻量运行环境，而且不会删除 `data/`、`images.db`、设置、缓存或已下载模型。
- Thumbnail cache now has a default 500 MB cap, can be disabled with a `0` limit, and explains the disk-vs-CPU/IO trade-off in Disk Usage.
  - 缩略图缓存现在默认上限为 500 MB，可用 `0` 关闭持久缓存，并在 Disk Usage 里明确说明省空间与重建缩略图 CPU/IO 开销之间的取舍。
- Feature Setup / Disk Usage no longer advertises externally redirected temp/cache/thumbnail paths as one-click safe cleanup targets. The cleanup list is app-owned `data/` cache only, symlinked safe-cache roots are refused, symlink targets are not counted as reclaimable bytes, and external package/model/runtime cache locations remain visible as informational/preserved rows.
  - Feature Setup / 磁盘占用不再把被环境变量重定向到外部的临时/缓存/缩略图路径显示成“一键安全清理”。可清理列表只包含 app 自己 `data/` 下的缓存，symlink 形式的可清理根目录会被拒绝，symlink 指向的外部目标不会被算成可回收空间，外部包/模型/运行时缓存会作为信息展示/保留。
- Feature Setup / Disk Usage asks for a second confirmation before cleaning any selected cache whose size could not be fully scanned, and the manual setup guide keeps keyboard focus inside the dialog.
  - Feature Setup / 磁盘占用现在会在清理大小未完整扫描的缓存前二次确认，并且手动设置引导弹窗会把键盘焦点留在弹窗内。
- ToriiGate optional setup now requires a Transformers version new enough for the Qwen3.5 classes it imports, and Linux full-AI launcher installs no longer repeat because of a temporary filtered requirements hash.
  - ToriiGate optional setup 现在要求足够新的 Transformers 版本来匹配实际导入的 Qwen3.5 类；Linux full-AI 启动器也不会再因为临时过滤后的 requirements hash 反复安装。
- Thumbnail cache writes are now atomic (write-then-rename), preventing corrupt partial thumbnails when concurrent requests or crashes overlap.
  - 缩略图缓存写入现在是原子操作（先写临时文件再 rename），避免并发请求或崩溃导致半写损坏的缩略图。
- Stale `.tmp` files left in the thumbnail cache by interrupted writes are now cleaned up automatically during periodic cache maintenance.
  - 被中断写入遗留在缩略图缓存里的 `.tmp` 文件现在会在定期缓存维护时自动清理。
- Artist ID optional dependency group now declares the same Transformers version floor as SAM3 and ToriiGate, preventing version drift across feature groups.
  - Artist ID 的 optional dependency group 现在和 SAM3、ToriiGate 声明相同的 Transformers 最低版本，防止 feature group 之间版本漂移。
- File-rename collision loops in sidecar export and image move/copy operations now have a safety cap, preventing theoretical infinite loops when a destination folder contains an extreme number of identically-named files.
  - sidecar 导出和图片 move/copy 的文件名冲突重试循环现在有安全上限，防止目标目录中存在极端数量同名文件时的理论死循环。

### Release Notes / 发布注意
- Existing users who still see large Python runtime usage should open **Feature Setup → Disk Usage → Python runtime environment → Rebuild lightweight runtime on next start**, then close and restart the app.
  - 旧用户如果 Python runtime 占用仍然很大，请进入 **Feature Setup → Disk Usage → Python 运行环境 → 下次启动重建轻量运行环境**，然后关闭并重启 app。
- The first launch after upgrading an old metadata-heavy `images.db` may spend time compacting metadata and running `VACUUM`; very large databases need temporary free disk space while SQLite rewrites the file.
  - 旧的大 metadata `images.db` 升级后首次启动可能会花时间压缩 metadata 并执行 `VACUUM`；超大数据库在 SQLite 重写文件时需要临时空闲磁盘空间。
- Lower thumbnail cache limits save disk, but large-gallery scrolling may regenerate thumbnails more often and use more CPU / disk I/O.
  - 缩略图缓存上限调低会省磁盘，但大图库滚动时可能更频繁重建缩略图，占用更多 CPU / 磁盘 IO。

### Validation / 验证
- Added regression coverage for scan diagnostics contracts, metadata compaction write paths and migrations, Disk Usage cleanup safety, runtime rebuild, optional dependency install guards, and release packaging launcher behavior.
  - 新增回归覆盖扫描诊断契约、metadata compact 写入口和迁移、Disk Usage 清理安全、runtime rebuild、optional dependency 安装保护，以及发布包启动器行为。

## [3.1.2] - 2026-05-08

### Added / 新增
- Added `update.bat` as an external rescue updater so users can check, download, verify, and apply updates even when the web UI cannot open.
  - 新增 `update.bat` 外部救援更新入口：即使网页进不去，也能检查、下载、校验并应用更新。
- Added `fix.bat` as a rare diagnostics/repair tool for runtime packages, port diagnostics, and startup readiness snapshots. It does not start the app and is not the normal port fallback path.
  - 新增 `fix.bat` 作为少数情况下使用的诊断/修复工具，用于 runtime 包修复、端口诊断和启动就绪快照；它不会启动 app，也不是普通端口兜底入口。

### Fixed / 修复
- Facet search now searches the full indexed library before applying display limits, so typing partial terms like `blue` can find lower-frequency tags such as `nagisa_(blue_archive)` instead of only searching the first preloaded slice.
  - Facet 搜索现在会先查完整索引库，再应用显示数量限制；输入 `blue` 这类局部词时，可以找到低频标签（例如 `nagisa_(blue_archive)`），不再只搜前端预载的前几百/一千项。
- Manual Sort now starts from a JSON request body instead of packing large tag/checkpoint/LoRA/prompt scopes into the URL, while keeping the legacy query-string API compatible. Large filter scopes no longer fail because of arbitrary query-length limits.
  - Manual Sort 现在通过 JSON 请求体启动，不再把大量 tag / checkpoint / LoRA / prompt 筛选条件塞进 URL，同时保留旧 query-string API 兼容；大型筛选范围不会再因为随意的查询字符串长度限制失败。
- Custom ONNX tagging now treats explicit local model and metadata paths as hard user contracts: missing files fail loudly, profile-specific metadata is validated, and user-supplied ONNX files are never deleted or replaced by the built-in model repair/download path.
  - Custom ONNX 标注现在把用户显式填写的本地模型和 metadata 路径当成硬契约：文件不存在会明确失败，metadata 会按 profile 校验，并且绝不会删除或替换用户提供的本地 ONNX。
- Custom Local Model now supports explicit WD14-compatible, PixAI, and Camie ONNX profiles while rejecting ToriiGate as a fake Custom ONNX path because ToriiGate uses the separate VLM/PyTorch backend.
  - Custom Local Model 现在支持明确选择 WD14-compatible、PixAI、Camie ONNX profile；ToriiGate 会被拒绝伪装成 Custom ONNX，因为它走的是独立 VLM/PyTorch 后端。
- Windows launchers now preflight the localhost port before opening the browser. If the default `8487` is refused by a Windows reserved/excluded TCP range, the launcher automatically uses the next safe localhost port and starts the backend on that same port; explicit `SD_IMAGE_SORTER_PORT` values still fail loudly instead of being silently changed.
  - Windows 启动器现在会先检查 localhost 端口再打开浏览器。如果默认 `8487` 被 Windows 保留/排除端口段拒绝，会自动改用下一个安全的本机端口，并让后端绑定同一个端口；用户显式设置的 `SD_IMAGE_SORTER_PORT` 仍然会明确报错，不会偷偷改掉。
- The selected launcher port is now written back into the backend environment before startup so runtime diagnostics and browser URL agree with the actual bind port.
  - 启动器选出的端口现在会写回后端环境，确保运行时诊断、浏览器 URL 和实际绑定端口一致。
- Artist identification single-image requests now run model loading/inference off the FastAPI event loop, so a slow Kaloscope load no longer freezes unrelated UI/API requests.
  - 画师识别的单图请求现在会在线程池中执行模型加载/推理；Kaloscope 加载很慢时，不再冻结其它 UI/API 请求。
- Tagging cancel issued before the worker process is spawned is no longer silently swallowed: `cancel_tagging` now finalizes the `cancelled` state and invalidates the pending run id so the queued background task aborts when it finally executes, instead of clobbering progress back to `running` and starting an unkillable batch.
  - 标记任务在 worker 子进程起来之前就被取消时，不再被静默吃掉：`cancel_tagging` 现在会在锁内直接落地「已取消」状态并废弃排队中的 run id，让 FastAPI 后台任务真正执行时主动放弃，而不是把进度回写成 `running` 并启动一个无法取消的批次。
- The rescue updater (`update.bat` / `backend/update_cli.py`) now probes the configured localhost port and refuses to apply an update while another SD Image Sorter instance is still running. Without this guard, the in-process apply + relaunch would race the existing window for the same port and leave the user with two instances on different ports. `--force` overrides the guard when the existing window is hung.
  - 救援更新器（`update.bat` / `backend/update_cli.py`）现在会先探测配置的本机端口，如果还有 SD Image Sorter 实例在运行就拒绝直接覆盖；不加这层守护，就会出现 in-process apply + relaunch 和旧窗口抢同一个端口、最终两个实例占两个端口的情况。`--force` 可在旧窗口卡死时强制覆盖。
- PixAI tagger now applies sigmoid to ONNX logits before thresholding, matching the v3.1.1 fix that landed for Camie. Without this, runtime logs showed ~940 of ~9000 scores per image discarded as out-of-range and the threshold compared against meaningless confidence values; the v3.1.1 fix accidentally only patched Camie's config.
  - PixAI tagger 现在会在比对阈值前对 ONNX logits 套用 sigmoid，对齐 v3.1.1 给 Camie 的修复。之前 v3.1.1 漏改 PixAI 的 config，导致每张图运行日志会丢掉 ~940/9000 分数为越界、并用毫无意义的 confidence 跟阈值比较。

### Validation / 验证
- Added regression coverage for Custom ONNX profile selection, explicit path failures, metadata validation, user-file safety, artist request threadpool dispatch, and deterministic E2E tag/artist persistence without live WD14 or Kaloscope loads.
  - 新增 Custom ONNX profile 选择、显式路径失败、metadata 校验、用户文件安全、画师识别线程池派发，以及不依赖在线 WD14 或 Kaloscope 加载的确定性 E2E 标签/画师持久化覆盖。
- Added launcher port-selection, rescue updater, external PID-free update application, and release packaging regression coverage so portable builds keep `run` self-healing plus `fix.bat` / `update.bat`.
  - 新增启动端口选择、救援更新器、外部无 PID 更新应用和发布打包回归测试，确保 portable 包保留 `run` 自愈以及 `fix.bat` / `update.bat`。
- Added regression coverage for the tagging cancel-vs-spawn race: cancellations issued before the worker process spawns finalize cleanly and invalidate the pending background task instead of being clobbered back into a running state.
  - 新增标记取消与 worker 启动竞态的回归测试：worker 子进程起来之前按下取消能落地「已取消」并废弃排队中的后台任务，不会被回写成 running。
- Added regression coverage for the rescue updater's running-instance guard, covering the abort path with a clear error message, the `--force` bypass for hung windows, and the read-only `--check-only` exemption.
  - 新增救援更新器「实例运行中」守护的回归测试，覆盖中止路径并提示明确错误信息、`--force` 在旧窗口卡死时的绕过，以及只读 `--check-only` 不受守护影响。
- Added a contract regression test asserting both PixAI and Camie declare `output_activation=sigmoid`, so future v3.x changes cannot silently drop the activation again.
  - 新增 PixAI / Camie 的 `output_activation=sigmoid` 契约回归测试，未来 v3.x 修改不会再悄悄漏掉激活函数。

## [3.1.1] - 2026-05-08

### Fixed / 修复
- Fixed Custom ONNX tagger layout detection so WD14-compatible NCHW models (`[B,3,H,W]`) no longer crash with width/channel shape errors.
  - 修复 Custom ONNX tagger 的输入布局判断，WD14 兼容的 NCHW 模型（`[B,3,H,W]`）不会再因为宽度/通道维度反了而崩。
- Fixed Camie tagger score handling by applying sigmoid to logits before threshold filtering.
  - 修复 Camie tagger 分数语义：先把 logits 过 sigmoid，再按阈值过滤。
- Hardened tag filtering so NaN/Inf/out-of-range model scores are rejected instead of becoming random-looking tags.
  - 加固标签过滤：NaN / Inf / 越界分数直接丢弃，不再变成看起来随机的标签。
- Fixed PixAI fallback rating/category handling so it only uses tags that already passed the configured thresholds.
  - 修复 PixAI fallback rating / 分类逻辑，只使用已经通过阈值的标签。
- Clarified Custom model UX/docs: Custom is for WD14-compatible ONNX only; Camie, PixAI, and ToriiGate must use their built-in entries.
  - 明确 Custom 模型的边界：Custom 只支持 WD14 兼容 ONNX；Camie、PixAI、ToriiGate 必须走内建模型选项。

### Security / 安全
- Updated `python-multipart` to `0.0.27` in backend runtime/dev lockfiles.
  - 后端 runtime/dev lockfile 将 `python-multipart` 升到 `0.0.27`。

### Validation / 验证
- Added regression coverage for strict thresholds, invalid-score rejection, Camie sigmoid confidence, Custom NCHW ONNX input layout, PixAI thresholded fallback, and ToriiGate long-caption output handling.
  - 新增回归测试覆盖严格阈值、非法分数拒绝、Camie sigmoid 置信度、Custom NCHW ONNX 输入布局、PixAI 阈值 fallback，以及 ToriiGate 长 caption 输出处理。

## [3.1.0] - 2026-05-04

### About This Release / 关于这一版
v3.1.0 was driven by real user feedback and a focused tech-debt pass. Almost every fix below either resolves a concrete issue reported by users running the portable build on real hardware, or pays down accumulated complexity that was making the app harder to use and harder to ship safely. **A huge thank you to everyone who shared logs, screenshots, and step-by-step reproductions — this release exists because of you.**

v3.1.0 完全由真实用户反馈和一轮聚焦的技术债务清理推动。下面几乎每一项修复，要么是来自用户在真机上跑 portable 包时报告的具体问题，要么是在偿还过去积累下来的复杂度——那些让 app 越来越难用、越来越难安全发版的东西。**衷心感谢每一位分享日志、截图、复现步骤的用户——这一版完全是因为你们才存在的。**

### Added / 新增
- Reader is no longer just for viewing. Users can now edit prompt, negative prompt, seed, sampler, steps, CFG, size, model, and LoRA fields, then save the result as a new image directly from the app.
  - Reader 不再只是看图。现在可以直接在 app 里编辑 prompt、负面 prompt、seed、采样器、步数、CFG、尺寸、模型、LoRA 等字段，改完直接另存成新图。
- Reader save now lets users choose the output format (`png` / `webp` / `jpg`) and save location more directly, including images that were uploaded through the browser.
  - Reader 保存时可以选输出格式（`png` / `webp` / `jpg`）和保存位置，浏览器上传进来的图也能存。
- Folder scan now becomes usable earlier: the library can appear first, while the remaining images and metadata continue loading in the background. (commit `d818029`, `5f38955`)
  - 资料夹扫描更早可用：图库会先显示出来，剩下的图片和 metadata 继续在后台加载，不用傻等。
- **Reconnect-missing flow** for libraries whose images were moved or renamed. The app can now match missing rows against new locations and re-link them without re-importing. (commit `d818029`)
  - **重新连接遗失文件流程**：图库里的图被移动或改名后，新的「重连」流程可以扫描新位置并重新对上，不用整个重新导入。
- **Disk Usage panel** in Feature Setup modal — see how much space `tmp` / `pip_cache` / `thumbnails` / `cache` take up, with safe-cleanup checkboxes. Read-only sizes for protected directories (`models`, `hf_cache`, `torch_runtime`, `favorites`, `config`) so users never accidentally wipe model data. Backed by a strict whitelist + path-containment service. (commit `d3178ea`)
  - **Feature Setup 模态框里新增「磁盘占用」面板**：看 tmp / pip 缓存 / 缩略图 / 通用缓存各占多少、勾选可安全清理；模型、HF 缓存、Torch runtime、favorites、设置等只读显示，避免误删模型数据。后端走严格白名单 + 路径包含检查。
- **Auto-Separate cooperative cancellation** — batch move/copy can be cancelled mid-flight and stops cleanly instead of running to completion. (commit `667212c`)
  - **自动分类批量移动/复制可中途取消**，按下取消会立刻停下来，不会硬跑完。
- **Aesthetic + artist filters wired through the sorting backend**, so they actually compose with the rest of the gallery filter pipeline instead of living off to the side. (commits `5426926`, `23651f7`)
  - **美学分数与画师筛选接入后端排序通道**，可以和图库其他筛选条件正常叠用，不再是孤岛。
- **Larger libraries supported.** identify-batch / obfuscation per-request ceilings raised from 10,000 to 50,000 (so users with >10k images can run a single pass), with a 5,000,000 backend ceiling for `image_ids`. (commits `0d059fe`, `cdac6e2`)
  - **支持更大的图库**：identify-batch / obfuscation 单次上限从 1 万提到 5 万（17k 图库的用户可以一次跑完），后端 `image_ids` 总上限拉到 500 万。
- **SAM3 Pro Segmentation** is available as an experimental option in the censor editor, alongside the existing Wenaka / NudeNet privacy detectors. (commits `c85f38a`, `452629e`, `95305d6`)
  - **SAM3 Pro 文字 prompt 分割（实验性）**，跟原本的 Wenaka / NudeNet 隐私检测器并存。
- **Privacy YOLO setup guidance dialog** — Civitai login wall now produces a structured 409 with manual fallback steps instead of a silent failure. (commit `6b82134`)
  - **Privacy YOLO 设置引导对话框**：Civitai 登录墙改成结构化 409 响应 + 手动下载步骤指引，不会再静默失败。
- WD14 tagger picker now lists Camie and PixAI tagger options alongside the default WD14/EVA02 set. (model registry update + credit doc)
  - WD14 tagger 选单新增 Camie、PixAI 选项，跟原本的 WD14/EVA02 并列。
- Lazy-human / lazy-release QA harnesses for repeatable manual-style smoke runs (developer tooling, no user-visible UI). (commits `a3f82a5`, `ed5944b`)
  - 增加 lazy-human / lazy-release 自动化 QA 跑测脚本（开发者工具，没有用户可见 UI）。

### Changed / 变更
- **SAM3 backend switched from `sam3==0.1.3` to `transformers.Sam3Model`.** The original Meta `sam3` PyPI package is no longer maintained; we now load checkpoints via `Sam3Model.from_pretrained(directory)` which expects a directory layout (`config.json` + `model.safetensors` + tokenizer files). ModelScope downloads deliver the correct shape automatically. (commit `c85f38a`)
  - **SAM3 后端从 `sam3==0.1.3` 套件换到 `transformers.Sam3Model`**：Meta 那个 PyPI 套件已经停更，新方案用 `Sam3Model.from_pretrained(目录)`，需要目录结构（`config.json` + `model.safetensors` + tokenizer 档）。从 ModelScope 下载的就是正确格式。
- Bundled portable Python embed bumped from 3.11.9 to 3.12.8 to match `requirements.txt`'s `python_requires`. (commit `5624f9a`)
  - Portable 内建 Python embed 从 3.11.9 升到 3.12.8，对齐 `requirements.txt` 的 python_requires。
- Service layer extracted **domain exceptions** (`ServiceError`, `ImageFileNotFoundError`) from raw `HTTPException`, so router-vs-service responsibilities are clean. (commit `5624f9a`)
  - Service 层从 raw `HTTPException` 抽出 **domain exceptions**（`ServiceError`、`ImageFileNotFoundError`），router 与 service 的职责分开。

### Fixed / 修复
- Reader overwrite is now safer and less annoying. If the user saves to the same path, the app asks first instead of failing once before asking. (commit `0e6faf9`)
  - Reader 覆盖保存更顺：保存到同一路径时会先问你要不要覆盖，而不是先报错一次再问。
- Reader confirmation text no longer gets overwritten while the dialog is open.
  - Reader 确认对话框开着的时候，文字不会再被动态覆写。
- Desktop navigation no longer hides the Reader tab too aggressively on normal desktop screens.
  - 桌面端导航不会再在正常桌面尺寸下把 Reader 页签藏起来。
- WSL / Linux runs now handle old Windows drive paths (`L:\...`) properly, so affected libraries no longer lose thumbnails just because the backend is running in WSL.
  - 在 WSL / Linux 跑后端时，旧的 Windows 路径（`L:\...`）也能正常处理，受影响的图库缩略图不会再因此消失。
- Scan progress is clearer during large imports. Users now see that the app is still importing in the background instead of feeling like the scan froze. (commit `5f38955`)
  - 大型扫描进度更清楚：后台还在继续导入时，画面会明确告诉你「还在跑」，不会再像卡死。
- JPG / WebP warnings now explain the metadata limitations honestly instead of implying they behave like PNG.
  - JPG / WebP 的提示会诚实告诉你 metadata 限制，不会再让人以为它们和 PNG 一样能塞所有信息。
- **Critical correctness fixes in core flows** (commit `fa93a23`):
  - Clear gallery no longer throws `ReferenceError: _scanProgressTimer is not defined` — Clear DB button works again. Scan/tag/aesthetic progress now probed in parallel via `Promise.allSettled`.
  - Auto move with copy no longer freezes at 0% for minutes — the up-front pixel-decode pass moved into the per-image loop, so progress shows up on the first iteration. Truncated-PNG protection preserved.
  - Tagging "Collecting image list", batch tag export, and delete-selected switched from per-id `db.get_image_by_id` loops to batched `db.get_images_by_ids` / `db.get_image_tags_map` (already chunks at 500 ids).
  - Similarity progress no longer gets stuck on `step="embedding"` after a crash — surfaces `step="error"` with the failure message; cancellation writes `step="cancelled"` instead of the success message.
  - Manual sort undo: file-op failures now return HTTP 500 with the session state rolled back (history/redo_stack restored).
  - **核心流程关键正确性修复**：Clear gallery 不再 ReferenceError，自动移动复制不再 0% 卡死，批量打标/导出/删除走批量 DB 查询，相似度进度死锁时正确报错并支持取消，手动分类撤销失败时回滚 session 状态。
- Aesthetic scores no longer become invisible after stop. Sort-by was being forced back to `newest` when the predictor went unavailable, hiding existing scored images behind unscored recent imports. (commit `0d059fe`)
  - 美学分数不再因为「停止」就消失。之前预测器不可用时前端会强制把排序拉回 newest，把已经打分的图盖在没打分的新图后面。
- 4 user-reported portable-testing bugs fixed: large-library 10k ceiling, aesthetic visibility, missing-folder rename UX, and a Bug 4 surface fix. (commit `0d059fe`)
  - 真机 portable 测试发现的 4 个用户回报 bug 全部修好（大图库上限、美学可见性、目录改名 UX、Bug 4 表层）。
- Embedded Python sibling import resolution + `nvidia-smi` CUDA-version parser fix. The launcher's CUDA detection no longer misreads driver version as CUDA version, and the embedded interpreter can find sibling backend modules during repair. (commit `17fd80a`)
  - 内嵌 Python 兄弟模块导入修复，加 `nvidia-smi` 解析 CUDA 版本不再误读成驱动版本。Launcher 修复脚本能正确找到 backend 模块，CUDA 选择更准。
- Aesthetic background task errors now surface to the UI; `ImageFileNotFoundError` raised by the service layer correctly maps to HTTP 404 instead of generic 500. (commit `dbeffc7`)
  - 美学后台任务错误会上抛到前端；`ImageFileNotFoundError` 走 404 而不是 500。
- Heavy AI runtime no longer crashes the server on certain edge cases (timing-related model loading guards). (commit `14a2800`)
  - 重型 AI 模块加载时序导致的 server 崩溃修复。
- Kaloscope artist runtime no longer hits `UnboundLocalError` on missing modules — explicit raise with diagnostic message instead. (commit `89389c9`)
  - Kaloscope 画师识别 runtime 缺模块时不再 `UnboundLocalError`，改成明确抛出诊断错误。
- Tag import writes unified into a single transactional path; Reader overwrite now refreshes derived state correctly. (commit `0e6faf9`)
  - 标签导入写入统一为一条事务路径；Reader 覆盖保存正确刷新派生状态。
- **Pagination cursor stability** — opaque cursors no longer break across edits/deletes during a paginated session. (commit `0e3d470`)
  - **分页 cursor 稳定性修复**：不透明 cursor 在编辑/删除时不会再失效。
- Cross-platform runtime dependency lock fixed — Linux / Windows / macOS all resolve to the correct PyTorch / ONNX / opencv variants. (commit `d5fa92c`)
  - 跨平台 runtime 依赖 lock 修好：Linux / Windows / macOS 都能正确解析到对应的 PyTorch / ONNX / OpenCV 版本。
- Selection token + migration review bugs (selection state desync after page changes; migration safety checks). (commit `4eec3e0`)
  - 选取 token 与 migration review 多个 bug 修好（页面变化时选取状态不同步、migration 安全检查）。
- Gallery batch actions + manual sort resume guard fixed. (commit `ba06d08`)
  - 图库批量操作 + 手动分类恢复 session 守卫修复。
- Smoke-test UX regressions (release-package smoke blockers). (commits `26bd20b`, `8607219`)
  - Release smoke 测试的 UX 回归与发布阻塞问题修好。
- Filter contracts + runtime invariants hardened — filter store mutations go through proper commits instead of side-channel writes. (commit `5426926`)
  - 筛选 contract 与 runtime invariant 收紧：筛选 store 变更走正规 commit，不允许 side-channel 写入。
- **6 verified tech-debt streams** (commit `5624f9a`): styles.css `:root` block corruption (modal-color rules misplaced), `censor-v2.css` hardcoded `60px` → `var(--nav-height)`, broken `aria-labelledby="nav-tab-gallery"` reference, 19 duplicate `promptlab.*` keys in zh-CN.js + 21 in en.js removed, dead `RedoStack` from manual-sort.js, `finishSorting()` raw `fetch` → API layer, minimap thumbnail capped at 1000 images (OOM cap), 64 MB PNG-chunk size limit + 64 MB zlib-decompression limit in metadata_parser, `aesthetic_service` DB connection unified to `get_db()` context manager.
  - **6 条已验证的技术债流**：CSS root 块错位、硬编码导航高度、aria-labelledby 引用错、200 个重复 i18n 键移除、dead code 清理、原生 fetch 换成 API 层、minimap 1000 图上限防 OOM、metadata parser 64 MB PNG/zlib 限制、aesthetic 服务统一 DB context manager。
- Service lifecycle hardening — clean shutdown paths and release-time safety checks. (commit `48793ff`)
  - Service 生命周期收紧：明确的关闭路径与发布期安全检查。
- SAM3 Pro censor no longer paints a giant box over the whole image when a prompt isn't actually present. A presence-probability gate plus a max-mask-area cap rejects the whole-body false-positive collapse. Concepts that genuinely *are* present (breasts, nipples, buttocks) keep working and recover small detections that the old score-only threshold accidentally filtered out. (commit `d800da4`)
  - SAM3 Pro 打码不再在 prompt 实际不存在时画整张图框。新的 presence-probability 门控加 mask 最大面积上限挡掉全身框误判，真的存在的概念（breasts、nipples、buttocks）继续正常工作，旧的纯分数阈值误过滤掉的小区域救回来了。
- SAM3 launcher / build robustness: tokenizer vocab provisioned from `open_clip` on first SAM3 load, `torch.load weights_only=False` forced during build, dead SAM3 runtime patch + orphan similarity helpers removed. (commits `452629e`, `95305d6`, `d6d1add`)
  - SAM3 启动 / 打包鲁棒性：第一次加载从 `open_clip` 取 tokenizer 词表、build 时强制 `torch.load weights_only=False`、清理 SAM3 runtime 死代码与相似度孤儿函数。
- SAM3 popup close handling fixed — modal can be dismissed cleanly. (commit `6b82134`)
  - SAM3 弹窗关闭逻辑修复，可以正常退出。
- Windows first launch no longer misreads a freshly installed CUDA PyTorch wheel through the old already-imported CPU `torch` module. Adds `--no-deps` to the CUDA torch reinstall to kill the multi-GB transitive cascade noise. (commits `0ef4fe1`, `17fd80a`)
  - Windows 第一次启动不再透过已经 import 进 process 的旧 CPU `torch` 看刚装好的 CUDA wheel；CUDA torch 重装加 `--no-deps`，避免几 GB 的 transitive 依赖瀑布噪音。
- Artist (Kaloscope) generic `torch.load` fallback now passes `weights_only=False` so the load actually succeeds. (commit `d921c5a`)
  - 画师识别（Kaloscope）的 `torch.load` 通用回退路径补 `weights_only=False`，加载真的能成功。
- Lockfile hash now normalizes line endings before computing sha256 — a stamp written on Windows (CRLF) now validates on Linux CI (LF), so lock-freshness checks are stable across platforms. (commit `4f806c7`)
  - Lockfile 哈希在算 sha256 前先 normalize 换行符——Windows（CRLF）写的 stamp 在 Linux CI（LF）也验得过，跨平台 lockfile freshness 检查不再误报 stale。

### Security / 安全
- File-protocol model downloads (`file://` URLs) are now refused unless the explicit test-only env var `SD_IMAGE_SORTER_TEST_ALLOW_FILE_DOWNLOADS=1` is set. Closes a small attack surface where a misconfigured `SD_IMAGE_SORTER_*_URL` could redirect to a local path. (commit `0a563af`)
  - `file://` 协议的模型下载默认全部拒绝，除非显式设置测试用 env var `SD_IMAGE_SORTER_TEST_ALLOW_FILE_DOWNLOADS=1`。封住一个 misconfigured `SD_IMAGE_SORTER_*_URL` 可能指向本地路径的小攻击面。

### Documentation / 文档
- README now states realistic first-launch disk-space and network-traffic budgets, including CUDA runtimes, pip cache, and on-demand AI model sizes.
  - README 现在写出真实的首次启动磁盘空间和网络流量预算，包含 CUDA runtime、pip cache、按需下载的 AI 模型大小。
- Special thanks / credits expanded with all currently-used model and tool authors: Camie, PixAI, ToriiGate, NudeNet, SAM3, ModelScope (heathcliff01), LAION aesthetic predictor, OpenCLIP, 大番茄 / 小番茄 obfuscation. Self-references removed.
  - 鸣谢 / 致谢表更新，把当前用到的所有模型和工具作者都列出来：Camie、PixAI、ToriiGate、NudeNet、SAM3、ModelScope（heathcliff01）、LAION 美学预测器、OpenCLIP、大番茄 / 小番茄 obfuscation。移除了自我引用。
- New `docs/AI_PRINCIPLES.md` and `docs/TECHNICAL_DEBT_NOTES.md` capturing AI-assisted development governance and the ongoing tech-debt log.
  - 新增 `docs/AI_PRINCIPLES.md` 与 `docs/TECHNICAL_DEBT_NOTES.md`，记录 AI 协作开发治理与持续追踪的技术债。

### Known Limitations / 已知限制
- **SAM3 Pro Segmentation is experimental.** The text-prompted detection path is significantly weaker than its ComfyUI counterpart (which uses box-prompted refinement). Recall on anime/SD images is low and bounding boxes are often coarse. **Recommended workflow: keep NudeNet (default) or Wenaka YOLOv8 for primary censoring.** SAM3 is best treated as an opt-in experiment until a future release lands a hybrid NudeNet→SAM3 refine pipeline.
  - **SAM3 Pro 文字 prompt 分割是实验性的。** 它的文字 prompt 路线明显比 ComfyUI 上的 box-prompt refine 用法弱：在动漫/SD 图上的召回率低、bounding box 也常常粗糙。**建议工作流：主打码请继续用 NudeNet（默认）或 Wenaka YOLOv8，把 SAM3 当成需要时再开的实验功能。** 我们下个版本会做 NudeNet→SAM3 的混合 refine 流程，到时候 SAM3 才会真正发挥价值。

### Validation / 验证
- 749+ backend pytest, 0 failures (pre-`5624f9a` measurement); the v3.1.0 release commit also passes the full `python scripts/run_ci.py` pipeline (lockfile freshness, security audit, frontend JS syntax, backend pytest, Playwright E2E) on Linux + Windows.
  - 后端 pytest 749+ 项全过零失败；v3.1.0 发布 commit 在 Linux + Windows 双平台 `python scripts/run_ci.py` 全套（lockfile / security / frontend JS / backend pytest / Playwright E2E）通过。
- Reader save / overwrite flow passed real browser validation end-to-end.
  - Reader 保存 / 覆盖流程在真实浏览器里走完整 E2E 通过。
- Scan + metadata regression suite passed after the v3.1.0 scan-experience updates.
  - 扫描与 metadata regression 套件在 v3.1.0 扫描体验更新后通过。
- SAM3 presence-gate verified on real anime/SD test images (no whole-body false positives on absent prompts; small-region recall preserved).
  - SAM3 presence-gate 在真实动漫/SD 测试图上验证：prompt 不存在时不会出全身框、原本会被误过滤的小区域保留下来了。
- Reconnect-missing flow verified on a library where files were renamed/moved out-of-band.
  - 重连流程在真实「文件被改名/移动」的图库上验证可用。

## [3.0.6] - 2026-04-20

### Fixed
- ComfyUI prompt extraction now follows `SamplerCustomAdvanced → CFGGuider` chains, `JoinStringMulti` nodes, and capital-`S` `String` nodes.
- Aesthetic scoring no longer freezes the system at ~1000 images. Added periodic `torch.cuda.empty_cache()` + `gc.collect()`, explicit PIL image closing, and batched commits.
- Disabled LoRAs (`on: false`) in rgthree Power Lora Loader are now excluded from the LoRA list and filter.
- Censor save as JPG/WebP now preserves SD metadata by converting PNG text chunks to EXIF UserComment. Parser also reads ComfyUI JSON back from EXIF UserComment in JPEG/WebP files.
- Gallery empty state no longer shows a duplicate camera-icon message alongside the styled card.
- Artist ID progress bar no longer stuck on "Starting..." — removed blocking overlay and fixed `data-i18n` attribute that kept overwriting dynamic progress text.
- Artist confidence threshold value no longer disappears after language refresh.
- Manual Sort now shows a confirmation dialog before starting a sort session.

### Added
- LoRA weights (`strength_model` / `strength_clip`) are now extracted and displayed next to each LoRA name in the image detail modal.
- VAE and CLIP/Text Encoder models are now extracted from ComfyUI workflows and shown in the Model Assets section.
- Version strings synced to `3.0.6`.

## [3.0.5] - 2026-04-20

### Fixed
- Removed the stale "launch-time GPU confirmation" product semantics from the tagger flow. The UI and E2E suite now match the real behaviour: automatic hardware clamps stay active without a separate confirmation modal.
- Tightened the Censor workspace sidebar sizing so the queue header and Queue Manager button stay readable without squeezing the canvas workspace.
- Folder scan now performs a real two-pass streaming walk: one cheap count pass for truthful progress totals, then a second processing pass without materializing the full file list in memory.
- Synced release-facing version strings to `3.0.5` across the API metadata, README download links, and the model-download User-Agent.
- Playwright startup paths now fall back across Windows and POSIX virtualenv layouts instead of hardcoding one platform-specific Python path.

## [3.0.4] - 2026-04-19

### Fixed
- Reader clipboard capture now tells the truth: clipboard images may lose SD PNG metadata in the browser, the button arms the `Ctrl+V` capture flow instead of relying on `navigator.clipboard.read()`, and metadata-lost clipboard results no longer silently look like successful parses.
- `POST /api/models/prepare` for `censor-legacy` now returns a structured `409 Conflict` auth-wall response instead of a generic `500`. The payload includes `error`, `type`, `message`, `manual_steps`, and `provider`, and the model manager renders the result as a warning instead of a server crash.
- `POST /api/models/prepare` for `censor-legacy` now also returns a structured non-500 `ModelPreparationFailed` response when Civitai serves a bad archive or extraction fails, instead of leaking `BadZipFile` / generic server-crash semantics.
- Folder scan now performs a real image decode verification, so corrupt and truncated files are reported as errors, named in scan progress, and kept out of manual sort / tagging / similarity flows.
- Single-image move now re-validates file readability, so truncated images are rejected instead of being treated as successful moves just because the file still exists.
- Similarity embedding progress now reports `skipped`, `unreadable`, and `failed` separately, including recent filenames / image ids instead of a vague `1 failed`, and similarity search / duplicate results now exclude rows already marked unreadable.

## [3.0.3] - 2026-04-18

### Fixed
- `run-portable.bat`, `run.bat`, and `run.sh` now honour `SD_IMAGE_SORTER_PORT` when printing the "Open browser" URL and when auto-opening the browser. Previously the launchers hardcoded `http://localhost:8487`, so users who overrode the port were silently routed to the wrong URL while the server bound the correct one.
- `/api/models/prepare` for `censor-legacy` no longer 500s on fresh installs. Two fixes: (1) Civitai metadata + archive requests now use a realistic browser `User-Agent` header (the old default `Python-urllib/x.y` was rejected with HTTP 403), target the new `civitai.red` domain, and fall back to a pinned direct-download URL when the API path misbehaves. (2) Civitai additionally gates NSFW model downloads behind account login; unauthenticated requests get an HTML sign-in page instead of the zip, which used to surface as a cryptic `BadZipFile`. The backend now detects the sign-in page (Content-Type `text/html` or invalid zip) and raises a clear manual-download guide pointing at the Civitai page and the local `models/yolo/` directory. The app cannot bypass Civitai's auth wall — this is a Civitai policy change.
- `/api/artists/diagnostics` now reports `available:true` when the HuggingFace / ModelScope fallback has already loaded a working artist model at runtime, matching the behaviour of `/api/artists/identify`. Adds `runtime_loaded`, `runtime_backend`, and `runtime_error` fields so the UI can distinguish "Kaloscope files missing but fallback loaded" from "nothing loaded".

### Added
- ToriiGate first-use now emits an explicit `~5 GB from HuggingFace` progress message before the model download starts, so users on slow or metered connections are not surprised by a silent multi-gigabyte fetch. Subsequent runs show a short "Loading ToriiGate on GPU/CPU" message instead.

## [3.0.2] - 2026-04-18

### Fixed
- NVIDIA VRAM total is no longer clamped at 4095 MB on Windows when `torch.cuda` is unavailable. `hardware_monitor.py` now overlays `nvidia-smi --query-gpu` results on top of WMI's 32-bit `AdapterRAM` readout.
- Dual-NVIDIA rigs match each card to its own VRAM by device name instead of by enumeration index, so WMI PnP order and nvidia-smi NVML order disagreeing no longer swaps VRAM between cards.
- Tagger batch-size recommendation now reflects actual VRAM (e.g., RTX 3090 picks batch size 32 instead of 8).

### Added
- Regression tests in `backend/tests/test_hardware_monitor.py` covering the WMI cap override, the degraded fallback when nvidia-smi is unavailable, dual-NVIDIA name-match ordering, and the guarantee that Intel/AMD devices never receive nvidia-smi overlays.

## [2.1.0] - 2026-04-04

### Added
- Local model readiness reporting in the launcher and browser UI
- Portable release packaging script with core-model, artist-runtime, and split large-model assets
- User-facing release and model setup guides
- Artist diagnostics endpoint and Similar CLIP status endpoint

### Changed
- Default artist backend switched from `cafe_style` to `Kaloscope2.0`
- Censor Edit now auto-selects the recommended Wenaka privacy model when it exists locally
- Legacy YOLO support now distinguishes privacy-part models from general compatibility models
- README and third-party model policy rewritten around the real verified model pipeline

### Fixed
- Kaloscope runtime path now works with `comfyui-lsnet` / `lsnet-test` layouts
- Local CLIP model path is preferred correctly for similarity search
- NudeNet box normalization is corrected for frontend/backend integration
- General YOLO `.onnx` / `.pt` compatibility is validated instead of assuming Wenaka-only outputs

## [2.0.0] - 2024-03-XX

### Added
- **Favorites Workflow**: New favorites gallery with copy-to-favorites functionality
- **Upgraded Gallery Preview**: Improved image preview with keyboard navigation
- **SAM3 Mask Refinement**: Pixel-precise segmentation for censoring
- **CLIP Similarity Search**: Find similar images and detect duplicates
- **Prompt Lab**: Intelligent prompt generation with tag categorization
- **Artist Identification**: Experimental artist/style classification (LSNet-based)
- **Thumbnail Cache**: Persistent disk-based thumbnail cache with WebP compression
- **Service Layer Refactoring**: Dependency injection pattern for all routers
- **Path Validation Security**: Comprehensive directory traversal prevention

### Changed
- Refactored all routers to use service layer pattern
- Improved metadata parser to handle more ComfyUI workflow variations
- Enhanced thumbnail generation with configurable sizes
- Updated UI with glassmorphism design improvements

### Fixed
- SQL injection prevention in all database queries
- Path traversal vulnerabilities in file operations
- Memory leaks in AI model loading
- Race conditions in background tasks

### Security
- Added `utils/path_validation.py` for comprehensive path security
- Parameterized all SQL queries
- Added input validation at API layer

## [1.5.0] - 2024-02-XX

### Added
- YOLOv8 detection for NSFW content
- NudeNet integration for body part detection
- Manual sort session with WASD keyboard controls
- Auto-separate feature for batch image organization
- WebP metadata extraction support

### Changed
- Improved ComfyUI workflow parsing
- Enhanced tag import/export functionality

### Fixed
- Unicode handling in prompts
- Memory usage with large image libraries
- Database locking issues

## [1.4.0] - 2024-01-XX

### Added
- WD14 tagger integration (ONNX Runtime)
- Multiple tagger model support (EVA02, ViT, Swin, ConvNeXt)
- Tag confidence filtering
- Batch tagging with progress tracking

### Changed
- Migrated to ONNX Runtime for AI models
- Improved database schema with indexes

## [1.3.0] - 2023-12-XX

### Added
- Forge generator detection
- NovelAI metadata parsing
- ComfyUI workflow extraction
- WebUI/A1111 parameter parsing

### Changed
- Unified metadata parser architecture

## [1.2.0] - 2023-11-XX

### Added
- Gallery view with generator tabs
- Advanced filtering (generator, tags, dimensions)
- Image detail modal with metadata display

### Changed
- Redesigned frontend with glassmorphism theme

## [1.1.0] - 2023-10-XX

### Added
- SQLite database for image metadata
- Folder scanning with metadata extraction
- Basic image grid view

### Changed
- Initial FastAPI backend structure

## [1.0.0] - 2023-09-XX

### Added
- Initial release
- Basic image serving
- Simple HTML frontend
