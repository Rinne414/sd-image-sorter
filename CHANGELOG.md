# Changelog

All notable changes to SD Image Sorter will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [3.2.1] - 2026-05-20

### Added / 新增
- **VLM (Vision Language Model) captioning system**: a multi-provider natural-language captioning pipeline that runs alongside the existing WD14 / Camie / PixAI / ToriiGate taggers. Supports OpenAI-compatible (OpenAI, Ollama, vLLM, LMStudio, OpenRouter, Volcengine Ark), Anthropic Claude, Google Gemini (public API and Vertex AI with service-account JSON), and any local model that exposes a chat-completions endpoint. Per-image caption stored in the existing `ai_caption` column. Concurrency-controlled batch processing with retry-on-error (configurable max retries + delay), NSFW-refusal detection with relaxed-prompt fallback, mid-batch cancel that preserves completed work, token usage and success/failed counts in the progress UI.
  - **VLM 多厂商自然语言打标系统**：多家 provider 的 NL caption 流程，跟现有 WD14 / Camie / PixAI / ToriiGate 并存。支持 OpenAI 协议（OpenAI、Ollama、vLLM、LMStudio、OpenRouter、Volcengine Ark）、Anthropic Claude、Google Gemini（公共 API + Vertex AI service-account 认证）、和任何兼容 chat completions 的本地端点。NL caption 存进既有的 `ai_caption` 字段。批量处理带并发控制、自动重试（次数/间隔可配）、NSFW 拒绝时自动用宽松 prompt 重试、可中途取消保留已完成结果、进度面板显示 token 用量和成功/失败计数。
- **HTTP / HTTPS / SOCKS proxy support for VLM providers**: paste a proxy URL in VLM Settings → all VLM API calls route through it. Useful for restricted regions where OpenAI / Anthropic / Gemini are blocked. Supports separate HTTP and HTTPS proxies, or a single SOCKS5 proxy that covers both schemes.
  - **VLM provider 支持 HTTP / HTTPS / SOCKS 代理**：在 VLM 设置里填代理 URL，所有 VLM API 请求都会走这个代理。适合 OpenAI / Anthropic / Gemini 在某些地区直连不通的场景。可以分别配 HTTP 和 HTTPS 代理，或者用一个 SOCKS5 代理同时覆盖。
- **Vertex AI Gemini support**: the Gemini provider now supports Google Cloud Vertex AI in addition to the public Gemini API. Configure with project ID, region, and a service account JSON (paste content or file path). Access tokens cached for ~50 minutes. Enables enterprise / regulated deployments where the public Gemini key isn't an option.
  - **Gemini provider 支持 Vertex AI**：除了公共 Gemini API key 模式，现在也能跑 Google Cloud Vertex AI。填入 GCP project、region、service account JSON 即可（内容直接粘贴或填本地文件路径）。OAuth token 缓存约 50 分钟。适合不能用公共 Gemini key 的企业 / 合规场景。
- **VLM-as-danbooru-tagger mode**: VLM can output structured danbooru tags instead of (or in addition to) NL captions. New `output_format` setting: `nl_caption` (default), `danbooru_tags` (parsed comma-separated list, written to the tags table), or `both` (hybrid `<NL>...</NL><TAGS>...</TAGS>` format). Two new prompt presets `vlm_danbooru` and `vlm_hybrid`. Lets users with no GPU use a hosted VLM as their primary tagger, or pair WD14 with VLM-refined tags.
  - **VLM 也可以打 danbooru 标签**：除了出 NL caption，VLM 也能输出结构化 danbooru 标签。新增 `output_format` 设置：`nl_caption`（默认）、`danbooru_tags`（解析逗号分隔列表写入 tags 表）、`both`（`<NL>...</NL><TAGS>...</TAGS>` 混合格式）。新增两个 prompt preset `vlm_danbooru` 和 `vlm_hybrid`。无 GPU 用户可以用云端 VLM 当主打标，或让 VLM 来精修 WD14 的标签。
- **One-click Ollama local model deployment**: VLM Settings shows a curated list of recommended vision models (Gemma 3 4B, Gemma 4 27B + uncensored 26B Heretic, Qwen 2.5 VL 7B/32B, Qwen3-VL 8B/32B, MiniCPM-V 4.5/4.6) with size + minimum VRAM requirements + NSFW tolerance badges. Click "Download" to fetch via Ollama with live progress; "Use This" to auto-configure the endpoint. Auto-starts Ollama if installed but not running. Detects platform-specific install instructions if Ollama is missing.
  - **一键下载部署本地 VLM**：VLM 设置显示推荐的视觉模型列表（Gemma 3 4B、Gemma 4 27B + 解锁版 26B Heretic、Qwen 2.5 VL 7B/32B、Qwen3-VL 8B/32B、MiniCPM-V 4.5/4.6），每个都标注体积、最低显存、NSFW 容忍度。点 "Download" 通过 Ollama 拉取，实时进度；"Use This" 自动填好 endpoint。Ollama 已安装但没启动会自动起服务；没装会显示对应平台的安装指引。
- **Provider auto-detection from endpoint URL**: paste any endpoint URL in VLM Settings → app auto-detects whether it's Anthropic, Gemini, Vertex, or OpenAI-compatible. No more guessing which provider option to pick.
  - **从 endpoint URL 自动识别 provider**：在 VLM 设置里填任意 endpoint，app 会自动判断是 Anthropic / Gemini / Vertex / OpenAI 兼容。不用自己猜该选哪个。
- **5 prompt presets for different LoRA training styles**: built-in system prompts tuned for general LoRA training (NL caption), Anima / FLUX-style detailed NL, short single-sentence captions, character LoRA training (skips fixed character features), and NSFW-tolerant for local models.
  - **5 个 prompt preset 对应不同 LoRA 训练风格**：内建 system prompt 模板，包括通用 LoRA 训练（NL caption）、Anima / FLUX 风格详细 NL、单句短描述、角色 LoRA（跳过固定特征）、本地模型用的 NSFW 兼容版。
- **Export template engine for LoRA training**: a new template-based export system with 7 LoRA training presets (Anima Tags+NL, Anima Tags-only, Illustrious / Pony, NoobAI, FLUX, Kohya SD1.5, Custom). Anima preset auto-converts underscores to spaces (preserving `score_N`). Tag-processing pipeline: blacklist → replace → max-N → append. 14 template variables: `{trigger}`, `{tags}`, `{tags:N}`, `{tags:filtered}`, `{nl_caption}`, `{prompt}`, `{negative}`, `{rating}`, `{count}` (auto-extracts `1girl`/`2boys`/etc.), `{characters}`, `{general}`, `{quality}`, `{safety}`, `{append}`. New `nl_caption` and `prompt_nl` content modes for simple natural-language exports. Live preview API renders captions for up to 20 sample images at once.
  - **LoRA 训练专用导出模板引擎**：新的模板化导出系统，附 7 个 LoRA 训练 preset（Anima Tags+NL、Anima 纯 Tags、Illustrious / Pony、NoobAI、FLUX、Kohya SD1.5、自定义）。Anima preset 自动把下划线换成空格（保留 `score_N`）。标签处理顺序：黑名单 → 替换 → 最多 N 个 → 附加。14 个模板变量：`{trigger}`、`{tags}`、`{tags:N}`、`{tags:filtered}`、`{nl_caption}`、`{prompt}`、`{negative}`、`{rating}`、`{count}`（自动抽取 `1girl`/`2boys` 之类）、`{characters}`、`{general}`、`{quality}`、`{safety}`、`{append}`。新增 `nl_caption` 和 `prompt_nl` 两个简单的 NL-only 导出模式。Live preview API 一次最多渲染 20 张样图。
- **Color analysis during scan + color-based gallery filter & sort**: a new color analyzer extracts dominant colors (top 5 with hex + percentage), average brightness (HSV V, 0-255), color saturation, color temperature (warm / cool / neutral), brightness histogram (16 buckets), brightness skew (third moment), and brightness distribution shape (left_heavy / right_heavy / middle_heavy / edge_heavy / balanced). Stored in 7 new indexed DB columns added by migration 010. New gallery sort options: brightness, saturation, brightness_skew (asc + desc). New filter parameters: brightness_min/max, color_temperature, brightness_distribution. Colors compute on a 64x64 thumbnail (~5-15ms per image).
  - **扫图时分析图片色彩 + 图库按色彩筛选/排序**：新增色彩分析模块，抽取主色（top 5 含 hex 和占比）、平均亮度（HSV V 通道，0-255）、饱和度、色温（暖 / 冷 / 中性）、亮度直方图（16 桶）、亮度偏度（三阶矩）、亮度分布形状（左侧重 / 右侧重 / 中间重 / 两端重 / 均衡）。这些信息存进 migration 010 新增的 7 个有索引的字段。图库新增排序选项：亮度、饱和度、亮度偏度（升 + 降）。新增筛选参数：亮度区间、色温、亮度分布。色彩在 64x64 缩略图上计算，每张约 5-15 毫秒。
- **Histogram shape classification distinguishes line art from photos**: the `edge_heavy` distribution detects images with both pure-black and pure-white concentrations (line art / sketches / B&W comic style). `middle_heavy` flags typical photos / anime cels. `left_heavy` / `right_heavy` mark dark-dominant or bright-dominant scenes. New `Sort by Dark→Bright distribution` option puts dark-heavy images first.
  - **亮度分布形状分类能把线稿和照片区分开**：`edge_heavy` 识别图片同时有大量纯黑和纯白（线稿 / 素描 / 黑白漫画风格）。`middle_heavy` 对应大部分照片 / 动画。`left_heavy` / `right_heavy` 是暗调主导或亮调主导。新增 "Dark→Bright 分布" 排序，把暗调密集的图排前面。
- **`/api/colors/analyze` batch backfill endpoint**: batch-runs color analysis on existing libraries that haven't been analyzed yet. Concurrency-controlled, cancelable, with progress polling. Use `/api/colors/missing-count` to see how many images still need analysis.
  - **`/api/colors/analyze` 批量补算接口**：给已有图库批量补算色彩信息。带并发控制、可取消、可轮询进度。`/api/colors/missing-count` 看还剩多少张没分析。
- **Mass tag editor (Tag-Master inspired)**: 4 new bulk tag operations on the DB tags table — Find & Replace (rename a tag across N images, supports remove via empty replace), Bulk Add (append tags with confidence override, dedupe vs existing), Bulk Remove (delete specified tags, case-sensitive optional), Cleanup (drop tags below min confidence + dedupe by case-insensitive tag name keeping highest-confidence copy). Each operation supports `dry_run=True` to preview affected_images count and up to 5 sample before/after pairs before committing.
  - **批量标签编辑器（参考 Tag-Master 设计）**：新增 4 个批量标签操作 — 查找替换（跨 N 张图重命名标签，replace 留空表示删除）、批量添加（追加标签并指定置信度，自动去重）、批量删除（删指定标签，可选大小写敏感）、清理（删除置信度低于阈值的标签 + 按 tag 名字去重保留最高置信度）。所有操作支持 `dry_run=True` 预览，返回影响图片数和最多 5 条修改前后对比。
- **Mass Tag Editor frontend**: the nav bar gains a 🧹 button that opens a modal for the 4 bulk-tag operations above. Scope picker (current selection vs current filter), tabbed operation panels, mandatory dry-run preview, and a confirm dialog with a 2-second delayed Apply button when scope exceeds 1,000 images. Filter scope uses the `/api/images/selection-token` + `selection-chunk` flow so even a 70k-image filter loads in ~3s. Fully bilingual (en + zh-CN), zero new dependencies.
  - **批量标签编辑器前端**：导航栏新增 🧹 入口，打开上述 4 个后端接口的统一界面。带范围选择（已选 vs 当前筛选）、Tab 切换操作面板、强制 Dry-run 预览、超过 1,000 张时二次确认弹窗（Apply 按钮有 2 秒倒计时）。筛选范围通过 `/api/images/selection-token` + `selection-chunk` 分块抓 ID，7 万张图 ~3 秒搞定。完全双语，无新增依赖。
- **VLM Settings — proxy / Vertex AI / output format frontend**: the VLM Settings modal now surfaces the proxy, Vertex AI, and output-format backend features. Output Format is a segmented control (NL caption / Danbooru tags / Both) at the top. Network Proxy is a collapsed `<details>` with HTTP / HTTPS / SOCKS fields. Vertex AI is a separate collapsed `<details>` (project / region / service-account JSON) that auto-appears only when provider is Gemini. Both sections show an "active" badge when they hold non-default values.
  - **VLM 设置 — 代理 / Vertex AI / 输出格式前端**：VLM 设置弹窗现在把代理、Vertex AI、输出格式三组后端功能全接出。Output Format 是顶部三段控件；Network Proxy 是折叠区含 HTTP / HTTPS / SOCKS 三个框；Vertex AI 是另一个折叠区（GCP project / 区域 / 服务账户 JSON），仅 provider 选 Gemini 时显示。有非默认值时显示 "已启用" 徽章。
- **Color analysis backfill UX**: a banner appears above the gallery when the user picks a color-based sort and the library has images with missing color data. Shows live missing count via `/api/colors/missing-count` with a one-click "Analyze N images" button. While running, a `[🎨 N%]` chip in the nav bar opens a bottom-right toast with progress bar, current filename, and Pause / Run-hidden actions. Banner can be dismissed for 24h via localStorage.
  - **色彩补算引导**：选色彩排序但库里还有没分析过的图时，图库上方弹引导横幅。实时显示未分析数，一键启动补算。运行时导航栏出现 `[🎨 N%]` 进度芯片，点开右下角 toast 含进度条、文件名、暂停操作。横幅可关闭 24 小时。
- **`count_images_missing_color_data()` helper**: a `SELECT COUNT(*)` helper in `database.py` that replaces the "fetch full ID list then `len()`" pattern in `/api/colors/missing-count`. Constant memory regardless of library size.
  - **`count_images_missing_color_data()` 计数辅助**：用 `SELECT COUNT(*)` 替代 `/api/colors/missing-count` 里 "拉完整 ID 列表再 len()" 的写法，常数内存。

### Changed / 變更
- **Caption Editor full-screen workbench (task #33)**: the same-name `.txt` / LoRA caption export now exposes its 3-column workbench (image queue / current caption editor / shared-tag toolbox) in a dedicated near-fullscreen modal, opened via a new `Open Editor` button next to `🔄 Refresh` in the batch-export preview header. Closing the editor returns the workbench to the inline pane with all temporary edits preserved. The workbench logic, blacklist, and image-override semantics are unchanged — this is purely about giving power users editing LoRA training captions real horizontal real estate.
  - **Caption 编辑器全屏工作台（任务 #33）**：同名 `.txt` / LoRA caption 导出的 3 栏工作台（左：图片队列；中：当前 caption 编辑；右：共同标签 + 检查 + 清理）现在可以在专用的近全屏弹窗里打开，通过批量导出预览顶栏新增的 `Open Editor` 按钮。关闭弹窗后工作台回到原来的内嵌面板，临时编辑全部保留。工作台逻辑、黑名单、image override 语义都没变 —— 这次纯粹是给在改 LoRA 训练 caption 的高强度用户更宽的编辑空间。
- **Auto-Separate 3-pane workbench redesign (task #35)**: the Auto-Separate page no longer stacks Saved Configs / Filter Criteria / Destination / Preview / File Action / Run vertically on a tall single column. It now uses a left/center/right workbench: filter editor + saved configs + scope status on the left, the preview grid (the visual focus) in the center, and Destination + Move/Copy + Run CTA on the right. The shell caps to viewport so the big Run CTA stays visible at the bottom of the action pane on every common screen size. At 1080-1280px the action pane becomes a sticky bottom bar across the full shell width; below 760px the layout stacks into a single column. Every previously locked element ID is preserved verbatim, so the existing `autosep.js` keeps working without changes — saved configs, scope intent buttons (use saved / copy from gallery / resync), filter scope independence, copy-by-default radio, `confirmBeforeMove=true` default, preview list, and the underlying `/api/batch-move` flow all continue to behave identically.
  - **自动分类 3 栏工作台重设计（任务 #35）**：自动分类页不再像长表单那样把 已保存配置 / 筛选条件 / 目标文件夹 / 预览 / 文件操作 / 执行 一路竖着叠下来。现在改成左中右三栏：左侧是 已保存配置 + 筛选条件 + 同步状态；中间是预览图网格（视觉焦点）；右侧是 目标文件夹 + 移动 / 复制 + 大执行按钮。整个外壳高度被钉到 viewport，所以右侧的大「Run」按钮在常见屏幕尺寸下永远可见。1080-1280px 时右栏会改成横跨整宽的吸底操作条；低于 760px 单列堆叠。所有原来锁定的元素 ID 都原封保留，所以现有的 `autosep.js` 不需要任何改动 —— 已保存配置、3 个筛选 scope 按钮（使用已保存 / 从图库复制 / 再次复制）、自动分类筛选与图库筛选互相独立、默认复制不移动、`confirmBeforeMove=true` 默认勾、预览列表、`/api/batch-move` 后端流程全部维持原本行为。
- **VLM batch progress now reports token usage**: progress endpoint includes `tokens_used` (sum across completed requests) and `errors` list with up to 50 entries showing `image_id`, error message, and error type for debugging.
  - **VLM 批量进度增加 token 统计**：进度接口新增 `tokens_used`（已完成请求的 token 总数）和 `errors` 列表，最多 50 条，每条含 `image_id` / 错误信息 / 错误类型，方便排查。
- **`/api/images` now returns color columns**: `dominant_colors`, `avg_brightness`, `color_temperature`, `color_saturation`, `brightness_distribution` are now in gallery/list views; detail view additionally returns `brightness_histogram` and `brightness_skew`. Previously migration-010 columns existed in SQLite but were never SELECT-ed, so color sort/filter worked but display didn't. Fix in `_IMAGE_COLUMNS_*_FIELDS` constants in `database.py`.
  - **`/api/images` 现在会返回色彩字段**：5 个用户可见色彩字段加入列表视图；详情视图还多 `brightness_histogram` 和 `brightness_skew`。之前 migration 010 字段在 SQLite 存在但 SELECT 列表遗漏，修复在 `_IMAGE_COLUMNS_*_FIELDS`。
- **Tags-bulk batch-load tags** (`routers/tags_bulk.py`): the 4 bulk-tag endpoints used to call `db.get_image_tags(id)` per image (500k round-trips at max). Now one up-front `db.get_image_tags_map(image_ids)` batched 500 IDs per query. ~500× fewer SELECTs on the read side.
  - **批量标签操作改成批读**：四个端点之前逐图查标签，现在改成一次性 `get_image_tags_map` 批量读取（每 500 ID 一批），读取阶段 SELECT 降低约 500×。
- **`asyncio.get_event_loop()` → `asyncio.create_task()` / `asyncio.get_running_loop()`** in `routers/colors.py` and `routers/vlm.py`: deprecated in Python 3.10, raises in 3.12 outside a running loop.
  - **asyncio 现代化**：`routers/colors.py` 和 `routers/vlm.py` 的 `get_event_loop()` 替换为 `create_task()` / `get_running_loop()`。
- **`db.add_tags` docstring** now warns this is `DELETE + INSERT` (replace) semantics, not append. Behaviour unchanged, only documentation.
  - **`db.add_tags` docstring**：明确说明是替换语义，不是追加。

### Fixed / 修复
- **Same-name `.txt` export no longer produces LoRA-incompatible `123.json.txt` sidecars** (`backend/services/tag_export_service.py`): when two indexed images shared a basename but had different source extensions (e.g. `123.png` and `123.json`, or `sample.jpg` and `sample.gif`), the collision-disambiguation fallback used to write the second sidecar as `{full_filename}.txt` — for example `123.json.txt` or `sample.gif.txt`. LoRA training pipelines pair captions with images by basename match, so those dual-extension sidecars were silently ignored at training time and the model never saw the captions. The allocator now uses a clean numeric suffix (`123.txt` first, `123_1.txt`, `123_2.txt`, ...) for collisions, which every LoRA trainer accepts. Existing single-image-per-basename exports are unaffected (still write `image_001.txt`). Regression coverage in `test_export_batch_keeps_lora_friendly_sidecar_for_dotted_filenames` reproduces the original `123.json.txt` failure mode and asserts the fix holds for `photo.bak.png` (which still uses `photo.bak.txt`, the LoRA-correct stem) and the `sample.jpg` / `sample.gif` collision case.
  - **同名 `.txt` 导出不再生成 LoRA 不兼容的 `123.json.txt`**：之前如果图库里有 basename 相同但副档名不同的两张图（例如 `123.png` 和 `123.json`，或 `sample.jpg` 和 `sample.gif`），第二张图的 sidecar fallback 会用 `{完整原文件名}.txt` 命名 —— 实际写出 `123.json.txt` / `sample.gif.txt` 这样的双副档名文件。LoRA 训练脚本以 basename 配对 caption 和图片，这种文件训练时会被静默忽略，模型根本看不到 caption。现在第二张图改用纯数字后缀（首张 `123.txt`，冲突的 `123_1.txt`、`123_2.txt`），任何 LoRA 训练器都能识别。单 basename 单图的常规导出不受影响（依然写 `image_001.txt`）。
- **PyPI + CUDA PyTorch downloads both auto-pick the fastest mirror**: the launcher (`run.bat` / `run.sh`) now probes Tsinghua TUNA, Aliyun, USTC, and the official PyPI host with a stdlib-only probe BEFORE `pip install -r requirements.txt`, then passes `--index-url <fastest> --extra-index-url https://pypi.org/simple` to every pip call. The same probe runs again for the CUDA torch wheel reinstall in `repair_torch_runtime.py`, choosing between SJTU and the official PyTorch host. Both probes hit the real PEP 503 path (`<base>/pip/` and `<base>/cu128/torch/`) so portal-page mirrors that 200 on `/` but 404 on the actual index are detected at probe time. The httpx-based selector caches its answer in `data/state/mirror_cache.json` for 30 minutes; the launcher's pre-install probe is stdlib-only (no httpx dep, since httpx is being installed by the very call we are accelerating). Power users can force a specific mirror with `SD_IMAGE_SORTER_PYPI_MIRROR=tuna|aliyun|ustc|official|<url>` and `SD_IMAGE_SORTER_TORCH_CUDA_MIRROR=sjtu|official|<url>`. Before this fix `_resolve_pypi_fallback_index()` already referenced a `mirror_selector` module that had never been committed — every call silently fell back to `pypi.org/simple` and the CUDA torch wheel was never routed through any mirror selection at all. On a Chinese broadband line that means the previously slow ~1.5 GB `requirements.txt` install (10–25 minutes on Fastly) plus the 2.5 GB CUDA torch wheel (30–60 minutes) now both fall to minutes via Tuna / SJTU.
  - **PyPI 和 CUDA PyTorch 下载都自动选最快镜像**：启动脚本（`run.bat` / `run.sh`）在 `pip install -r requirements.txt` **之前**用纯 stdlib 探测清华 TUNA、阿里云、中科大、官方 PyPI 源，挑最快的传给每个 pip 调用 `--index-url <fastest> --extra-index-url https://pypi.org/simple`。CUDA torch wheel 在 `repair_torch_runtime.py` 里再探一次，在 SJTU 和官方 PyTorch 源之间挑。两个 probe 都打真正的 PEP 503 路径（`<base>/pip/` 和 `<base>/cu128/torch/`），所以"`/` 返回 200 但实际 index 404"的门户页假镜像在探测阶段就会被识破。httpx 版的选择器把结果缓存到 `data/state/mirror_cache.json` 保 30 分钟；启动脚本里那一步是 stdlib-only（不能用 httpx，因为 httpx 正是它要装的东西）。可用 `SD_IMAGE_SORTER_PYPI_MIRROR=tuna|aliyun|ustc|official|<url>` 和 `SD_IMAGE_SORTER_TORCH_CUDA_MIRROR=sjtu|official|<url>` 强制指定。修复前 `_resolve_pypi_fallback_index()` 已经引用了一个从未提交过的 `mirror_selector` 模块 —— 每次调用都静默回退到 `pypi.org/simple`，而 CUDA torch wheel 主路径压根没接入任何镜像选择。对中国宽带用户来说，原来慢的 ~1.5 GB `requirements.txt`（Fastly 上 10–25 分钟）加上 2.5 GB CUDA torch wheel（30–60 分钟），现在通过 Tuna / SJTU 都能降到几分钟。
- **Thumbnail cache temp-path collision** (`thumbnail_cache.py`): two writers in the same process+thread that both finished in the same `time.time_ns()` window could collide on the `.tmp` path. Path now combines PID + TID + nanosecond + process-local counter + 8 hex chars of OS randomness. Verified by the previously-failing regression test `test_thumbnail_cache_temp_paths_are_unique_for_same_cache_key`.
  - **缩略图缓存临时路径冲突**：同进程同线程两个写入者落在同一 `time.time_ns()` 窗口会撞到相同 `.tmp` 路径。现在路径组合 PID + TID + 纳秒戳 + 单调计数 + 8 个随机十六进制字符。

### Notes / 注意事項
- Vertex AI requires the `google-auth` Python package; the app shows a helpful error message if it's missing. Run `pip install google-auth` to enable.
  - Vertex AI 需要 `google-auth` 包，没装会有提示。`pip install google-auth` 装上即可。
- SOCKS proxy requires `httpx[socks]` extra. The provider falls back to direct connection with a log warning if not installed.
  - SOCKS 代理需要 `httpx[socks]`，没装的话会自动降级直连并记录警告。
- Color analysis is opt-in for existing libraries; run via `/api/colors/analyze` or use the new backfill banner to backfill. New scans automatically populate color data.
  - 色彩分析对老图库是按需执行；用 `/api/colors/analyze` 或新的补算引导横幅来补算。新扫的图会自动填好。
- All 1,112 backend tests pass after the changes.
  - 改完后 1,112 个后端测试全部通过。
- The Mass Tag Editor confirm-dialog threshold (1,000 images) is the trip-wire for the 2-second delayed Apply button. Below that, the operation runs immediately on click.
  - Mass Tag Editor 二次确认阈值是 1,000 张（超过才会出现倒计时 Apply 按钮），少于该数量直接执行。

### UX Polish (pre-release sweep) / 体验抛光（发版前最后一轮）
- **i18n stays fresh after upgrade without `Ctrl+Shift+R`**: every `<script>` and `<link>` tag served by `GET /` now gets a `?v=APP_VERSION` cache-bust query, so a normal browser F5 after upgrading the backend pulls the new `lang/*.js` instead of silently re-using the cached old language pack. The Help modal also gains a "🔄 Refresh translations / 🔄 重新载入界面文字" button that re-fetches the language packs in place — gallery filters, scan progress, selection state, and `localStorage` survive the swap.
  - **升级后 i18n 不再需要硬刷**：服务端在每个 `<script>` 和 `<link>` 上自动加 `?v=APP_VERSION`，浏览器普通 F5 就能拉到新版 `lang/*.js`，不会再静默用旧语言包。Help 弹窗也加了「🔄 重新载入界面文字」按钮，原地重抓语言包，**图库筛选 / 扫描进度 / 选择 / `localStorage` 都会保留**，不会丢资料。
- **Help "?" reachable at every viewport**: at ≤768px the desktop nav row is hidden by CSS; we now expose a `mobile-btn-help` inside the hamburger overlay that opens the same Guide modal. Verified by Playwright on 1920 / 1366 / 1024 / 800 / 768 / 600 / 480.
  - **❓ 在任何视口都能找到**：768px 以下桌面导航被 CSS 隐藏，现在 hamburger 菜单里加了 `mobile-btn-help`，进同一个 Guide 弹窗。Playwright 实际点过 7 种视口都没问题。
- **Scan modal feels less cramped in zh-CN**: the import modal moves from `modal-small` (400px) to `modal-medium` (500px), giving folder path input + Browse button visible breathing room.
  - **扫描弹窗中文版不再挤**：导入图片对话框从 400px 改到 500px，路径输入框和 Browse 按钮都有空间了。
- **Tagger modal split into 3 tabs**: the single "AI Auto Tagging" panel now has Local Tagger / Natural Language / Aesthetic Score tabs. The model dropdown is filtered per tab (Local: WD14 / Camie / PixAI / Custom; Natural Language: ToriiGate + VLM API; Aesthetic: dedicated panel). VLM mode banner and ToriiGate setup card live inside Natural Language. Aesthetic gets its own Score / Set up CTA.
  - **打标弹窗拆成 3 个 tab**：原来一锅烩的"AI 自动打标"现在分本地打标 / 自然语言 / 美学评分三个标签页。每个 tab 自动过滤模型下拉（本地：WD14 / Camie / PixAI / Custom；自然语言：ToriiGate + VLM API；美学：独立面板）。VLM banner、ToriiGate 安装卡片归到自然语言；美学评分独立有自己的 Score / 安装 CTA。
- **"Set up Aesthetic / ToriiGate" deep-links into Setup**: the Setup CTA in the new Tagger tabs closes the tagger modal, opens Model Manager, scrolls the matching card into view, and pulses a 2-second highlight so you know exactly where to click.
  - **「美学 / ToriiGate 安装」直接跳到 Setup**：Tagger 里的安装按钮会自动关掉打标弹窗、打开 Model Manager、滚到对应模型卡片、做 2 秒的高亮闪烁，让你不用自己找。
- **Model Manager card buttons readable in zh-CN at 1366×768**: prepare/repair buttons go from `btn-small` (32px tall) to default `btn` (40px tall, 132px wide minimum) so "立即准备" / "重新检查" never get clipped. Bulk download button gets the same treatment.
  - **Model Manager 卡片按钮中文版可读**：「立即准备」「重新检查」不再被截断 — 按钮从 32px 改到 40px 高、最少 132px 宽。批量下载按钮同样处理。
- **Export modal becomes the unified per-image preview/edit hub**: the batch-export modal's preview pane is now visible for **every** content mode (was template-only before), and gains two new output destinations alongside sidecar files: "📋 Copy combined to clipboard" and "⬇️ Download single file". Per-image edit applies to the combined paths too — your text overrides survive into the clipboard / download blob.
  - **导出弹窗变成统一的逐图预览/编辑中心**：原来只有 template 模式才显示的 preview 区，现在所有内容格式都显示。新增两个输出目的地：「📋 合并复制到剪贴板」「⬇️ 下载成单一文件」，跟原来的 sidecar 一起放在 segmented control 里。逐图编辑对合并路径同样生效，你的文字覆盖会原样写进剪贴板 / 下载文件。
- **Gallery auto-refreshes after tagging / VLM completion**: tagging done path dispatches a `taggingCompleted` event, VLM batch completion now dispatches `vlmBatchCompleted` and also calls `loadImages()` + `loadStats()` directly, so freshly tagged images surface their new tag chips and counts without you having to switch tabs.
  - **打标 / VLM 完成后图库自动刷新**：打标完成除了原本的 `loadImages` 还会派发 `taggingCompleted` 事件；VLM 批量完成会派发 `vlmBatchCompleted` 并直接调 `loadImages()` + `loadStats()`，刚打完的图标签和计数会自动出现在图库，不用切 tab 再切回来。

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
- **Batch Tag Export: "Save next to each image" mode**: a new segmented control above "Output Folder" in the Batch Tag Export modal lets the user choose between writing every sidecar into one shared folder (legacy flat output) or writing each `.txt` / `.json` into the same directory as its source image. The new mode preserves subfolder structure for libraries spread across many directories and matches the convention of per-folder training tools that look for `foo.png` + `foo.txt` side by side. New API field `output_mode: "folder" | "beside_image"`. UI defaults to `beside_image`; the `output_folder` field is greyed out and skipped when that mode is selected. Rows whose source folder no longer exists are reported as per-row errors instead of crashing the whole export.
  - **批量打标导出新增 "存到每张图所在的资料夹" 模式**：批量打标导出弹窗里"输出文件夹"上方新增一组单选，可选"存到每张图所在的资料夹"或"统一存到一个资料夹"。新模式会把每个 `.txt` / `.json` 写到对应来源图的同一个资料夹，保留子资料夹结构，适合图库分散在多个子资料夹或依赖 `foo.png` + `foo.txt` 同位的训练工具。API 新增 `output_mode: "folder" | "beside_image"` 字段，UI 默认 `beside_image`，此时输出文件夹输入框会自动禁用。来源资料夹已不存在的图片会按行报错，不会让整批导出崩掉。

### Changed / 變更
- **Setup moved to the nav bar**: the global "Setup" button now lives in the top nav bar, reachable from any view (Reader, Censor, Sorting, Library Health) instead of being hidden in the gallery toolbar.
  - **Setup 移到主導航**：全域用的 "Setup" 按鈕現在在最上方導航列，從任何頁面都可以打開，不再藏在 Gallery 工具列裡。
- **Clear Gallery moved into the gallery toolbar**: the destructive "Clear Gallery" action moved out of the global nav bar and into the gallery toolbar, where its scope is visible.
  - **Clear Gallery 移到 Gallery 工具列**：破壞性的 "Clear Gallery" 按鈕從全域導航列移到 Gallery 自己的工具列，在 UI 上明確只影響當前 gallery。
- **Setup added to the mobile menu**: a "Setup" entry was added to the mobile navigation panel.
  - **手機選單新增 Setup 入口**：手機版選單也能直接打開 Setup。
- **Generator filter and tab list now expose "Others"**: gallery generator tabs, the filter modal, and gallery counts now include an "Others" category alongside ComfyUI / NovelAI / WebUI / Forge / Unknown.
  - **Generator 分類與篩選新增 "Others"**：分類列、篩選彈窗、計數都多了 "Others" 一欄。
- **Auto-Separate and Manual Sort default to copy (not move)**: the file-action mode for both batch sorting flows now defaults to "Copy and keep originals" out of the box. The Move radio is still available and the user's last choice is persisted to localStorage, so power users only flip once. This is the safer default for first-time users who might click Start before reading the radio labels and end up moving thousands of files into the wrong folders. Locked by `docs/AI_PRINCIPLES.md` Principle #11 + a regression test that asserts the radio markup and JS fallbacks resolve to copy.
  - **Auto-Separate 与 Manual Sort 默认改为复制而不是移动**：两套批量分类流程的文件操作默认值都改成"复制并保留原图"。移动选项仍在，用户上次的选择会保存到 localStorage，重度用户切换一次就行。新默认对第一次使用、还没看清单选按钮就点 Start 的用户更安全，避免一不小心把成千上万的文件搬到错的资料夹。`docs/AI_PRINCIPLES.md` Principle #11 加上回归测试一起锁住该默认值。
- **Default scan brings back the count-first pass**: scan progress now walks the folder once for a precise total, then runs the import + metadata pipeline with a real `current/total` denominator. The phase order is `counting → counted → importing` and every import heartbeat shows `processed=14800/48062` (instead of `processed=14800/?` like before). On a local SSD the count walk is ~1–2 seconds for 50 K files, which is dwarfed by the metadata-parse phase that follows. Callers that legitimately need to skip the count walk (e.g. multi-million-file network shares) can opt out with `precise_total=False`.
  - **默认扫描恢复"先点数再导入"两阶段**：扫描进度现在会先走一遍资料夹算出精确总数，再跑导入和 metadata 流程，进度条和心跳都会显示真正的 `current/total`。阶段顺序是 `counting → counted → importing`，每次心跳显示 `processed=14800/48062` 而不是原本的 `processed=14800/?`。本地 SSD 上 5 万张图的点数大约 1–2 秒，相比后面的 metadata 解析微不足道。确实需要跳过点数（例如几百万张图的网路硬碟）的调用方可以传 `precise_total=False` 选择 streaming 模式。

### Fixed / 修复
- **JPEG / WEBP / GIF files saved with `.png` extension now import (no more "Invalid PNG signature" errors)**: real-world libraries are full of JPEGs renamed to `.png` by Civitai, Discord, browsers, and content-management tools. Browsers and Windows Explorer render them fine because they sniff format from content magic bytes, but the parser was strict-trusting the extension and rejecting the file with `Invalid PNG signature` — flagging hundreds of perfectly valid images as "unreadable" and hiding them from the gallery. Fixed by falling through to Pillow's content-sniff path whenever the PNG fast-path's magic-byte check fails. Pillow detects format from content regardless of file extension, so a `.png`-extension JPEG is parsed as JPEG. Genuine PNG corruption (truncated chunks, bad IEND, etc.) still surfaces as a parse failure — the fallback only kicks in for the magic-bytes-don't-match-extension case.
  - **`.png` 后缀但实际是 JPEG / WEBP / GIF 的图片不再被报为不可读**：Civitai、Discord、浏览器等工具经常会在上传/下载时把 JPEG 改成 `.png` 后缀。浏览器和 Windows 资源管理器能渲染是因为它们看魔术字节嗅探格式，但 metadata 解析器以前完全相信扩展名，看到首 8 字节不是 PNG 签名就直接报 `Invalid PNG signature`，导致成百上千张正常的图被当成"损坏"藏起来。修复方法：PNG 快速路径校验失败时回退到 Pillow 的内容嗅探路径。Pillow 完全按内容识别格式，所以 `.png` 后缀的 JPEG 会被当 JPEG 正常解析。真正的 PNG 损坏（chunk 截断、IEND 错误等）仍会按错误处理——回退只针对"魔术字节与扩展名不一致"这一种情况。
- **Dataset Audit panel layout fixed**: the score ring inside the Dataset Audit (Setup → Dataset Audit) was using `display: grid; place-items: center` plus per-child `margin-top` overrides (8 px on the score, 52 px on the label) that pushed the "Health Score" label completely outside the inner dark donut hole and onto the conic-gradient ring, where it was nearly unreadable. The "Read-only library audit" eyebrow heading was also styled as a tiny uppercase label that visually disappeared under the subtitle, and the hero baseline-aligned the subtitle with the Refresh button — pushing the eyebrow off the top of the modal-content scroll area on common viewport heights. All three issues fixed: the score ring now uses a proper flex column with sane font sizes; the eyebrow is rendered as the actual section heading (1.05 rem bold); and opening the audit details now scrolls the section's top into view so the eyebrow is always visible.
  - **资料集体检面板排版修复**：体检里的分数环之前用 `display: grid; place-items: center` 加上每个子元素的 `margin-top`（数字 8px、标签 52px）硬撑，结果 "健康评分" 标签整个被挤出内圈深色甜甜圈，落在外层渐变圈上几乎看不清。"只读图库体检" 这行 eyebrow 还被做成很小的大写标签，视觉上完全藏在副标题下面；hero 区还用 baseline 对齐让副标题和"重新体检"按钮排在同一基准线，把 eyebrow 推到 modal 滚动区上方裁掉。三处都修了：分数环改用正常的 flex 纵向排列加合理字号；eyebrow 改成真正的小标题（1.05rem 粗体）；展开体检时会自动把整段顶端滚到可见位置，eyebrow 一定看得到。
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
