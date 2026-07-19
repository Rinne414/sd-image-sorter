## v3.5.0 — 清爽极光 + 稳定性收口 / Fresh Aurora + Stability

清爽极光重塑桌面流程；图库搜索、LoRA/Dataset 导出、Smart Tag、排序、打码与大库任务全面升级。

Fresh Aurora upgrades search, export, Smart Tag, sorting, censoring, and scale.

---

## Fixed / 修复

- **Fresh Aurora workspace**: A new mission entry page, customizable task-scoped navigation, function catalog, and four cover modes make every major workflow easier to reach while preserving the familiar desktop top bar.
  - 全新的「清爽极光」桌面工作台加入任务入口页、按任务收束的可定制导航、所有功能清单与四种门面展示模式，同时保留熟悉的顶部导航。

- **Gallery search and selection**: The Gallery now supports a complete bilingual query language, comparisons, ranges, exclusions, Danbooru-aware autocomplete, quick filters, live result counts, color search, smart folders, and a persistent bottom action bar. Server-resolved selection tokens keep filtered actions correct beyond the currently loaded page.
  - 图库现支持完整双语查询语法、比较/范围/排除、Danbooru 补全、快捷筛选、实时命中数、颜色搜索、智能文件夹与常驻底部操作条；服务端 selection token 确保跨分页筛选批处理不会漏图。

- **LoRA and Dataset export integrity**: Export was rebuilt around per-image rating and quality, tag provenance, purpose filtering, implication deduplication, character-trait pruning, collision reporting, trainer health checks, and a WYSIWYG preview driven by the same engine that writes sidecars.
  - LoRA 与 Dataset 导出重做为逐图分级/画质、标签来源追踪、训练目的过滤、蕴含去重、角色特征修剪、撞名报告与训练可用性检查；预览和实际 sidecar 写入共用同一引擎，所见即所得。

- **Krea 2 Smart Tag path**: Krea 2 is treated as a natural-language-first target, with Qwen3-VL Instruct clearly recommended for local captions. Booru context is explicit and optional, and real Ollama output now flows through the intended natural-language caption field.
  - Krea 2 明确按自然语言优先目标处理，本地字幕清楚推荐 Qwen3-VL Instruct；Booru 上下文可显式开关，真实 Ollama 输出会进入正确的自然语言字幕字段。

- **Tagger and AI job correctness**: Manual tags survive re-tagging through source/category provenance, VLM tags pass a vocabulary gate, transparent images are prepared correctly, and camie-tagger-v2 reads the correct ONNX output. AI queue and Mass Tag lifecycle races no longer publish stale completion or lose queued work across restarts.
  - 标签来源/类别追踪确保手动标签不会被重打标覆盖，VLM 标签经过词表闸门，透明图预处理与 camie-tagger-v2 ONNX 输出头已修正；AI 队列和 Mass Tag 生命周期竞态不再发布过期完成状态，排队任务也可跨重启恢复。

- **Similarity and cleanup tools**: Whole-library Duplicate Cleanup groups near-duplicates without the old size cap and suggests the best keeper; semantic similarity, color discovery, and related navigation now form a coherent review workflow.
  - 整库「查重清理」不再受旧数量上限限制，可将近似图分组并建议最佳保留项；语义相似、颜色发现与相关入口已连成一致的审核流程。

- **Manual Sort workflow**: Three sorting modes, named presets, live scope counts, focus mode, durable session restore, undo-safe copy behavior, and a laptop-visible primary action make long WASD sessions faster and recoverable.
  - 手动排序加入三种模式、命名预设、实时范围计数、专注模式、持久会话恢复与可安全撤销的复制行为；主操作在笔记本分辨率下也始终可见。

- **Censor review and output integrity**: The editor adds a region-by-region review conveyor and per-image batch outcomes. JPEG transparency is flattened deliberately, PNG/WebP alpha and source formats are preserved where supported, and failed outputs are reported instead of being presented as success.
  - 打码编辑器新增逐区域审核流水线与逐图批处理结果；JPEG 透明度会明确铺底，PNG/WebP 在支持时保留 alpha 与源格式，失败输出会如实报告而不再显示假成功。

- **Large-library reliability**: Bulk delete, remove, export, metadata reparse, and duplicate scans run as cancellable background work with bounded progress and errors. Export pagination leaves the event loop responsive, while scan identity handling, junction traversal, WebP EXIF, metadata retention, and duplicate-result publication are hardened.
  - 批量删除、移出、导出、元数据重解析与查重扫描改为可取消后台任务，进度和错误有界；导出分页不再阻塞事件循环，扫描 identity、junction 遍历、WebP EXIF、原始元数据保留与查重结果发布也完成加固。

- **Model setup and runtime repair**: Model Manager now presents clearer prepare/repair state and download-source controls. CUDA, Torch, and ONNX Runtime compatibility checks produce actionable diagnostics, including Linux NVIDIA GPU repair, without hiding the original failure.
  - Model Manager 更清楚地展示 Prepare/Repair 状态与下载源；CUDA、Torch、ONNX Runtime 兼容检查提供可操作诊断，并覆盖 Linux NVIDIA GPU 修复，不再掩盖根本错误。

- **Desktop regression and maintainability**: High-risk application, Dataset, Censor, service, and Model Manager modules were split without changing their public behavior. The desktop Playwright gate is sharded with truthful run artifacts and expanded interaction coverage for supported laptop and desktop resolutions.
  - 高风险的应用、Dataset、Censor、服务与 Model Manager 模块在不改变公开行为的前提下完成拆分；桌面 Playwright 门禁采用可信分片产物，并扩展了受支持笔记本/桌面分辨率的交互覆盖。

---

## Upgrading / 升级注意

- Database migrations run automatically on first start; no manual schema steps are required and existing library data is preserved.
  - 首次启动会自动执行数据库迁移，无需手动处理 schema，现有图库数据会保留。

- The new mission entry page opens by default. Use Settings → 跳过入口页 to keep the previous direct-to-workspace startup, and click the brand block whenever you want to return to the entry page.
  - 新任务入口页默认显示；如需沿用直接进入工作区的启动方式，可在「设置 → 跳过入口页」开启，之后仍可点击品牌区返回入口页。

- Auto-Separate and Manual Sort remain non-destructive by default with `copy`; existing shortcuts and destructive-action confirmations are unchanged.
  - 自动分类与手动排序仍默认使用非破坏性的 `copy`，现有快捷键和危险操作确认保持不变。

- For local natural-language captions, choose a Qwen3-VL Instruct model in Model Setup. Existing WD14 tagger choices remain available; the balanced default is unchanged.
  - 本地自然语言字幕请在模型设置中选择 Qwen3-VL Instruct；现有 WD14 打标器仍可使用，均衡默认项不变。

- In-app updates from v3.4.x continue through Check Update; the app patch is for that updater only, not for a fresh installation.
  - v3.4.x 可继续通过「检查更新」升级；app patch 仅供应用内更新器使用，不适合全新安装。

---

## Validation / 验证

Full CI passed: 4,869 backend tests with 90% coverage (7 skipped); 539 desktop Playwright tests with 0 failures or flaky results (3 skipped); click coverage 46.92% (198/422). All six assets passed archive, manifest, checksum, permission, architecture, and internal-file checks. Fresh Windows and Linux x86_64 portable launches served `/`, `/docs`, and diagnostics as v3.5.0; aarch64 was archive- and ELF-validated on the x86_64 host. / 完整 CI 已通过：后端 4,869 项、覆盖率 90%（7 项跳过）；桌面 Playwright 539 项通过、0 失败、0 flaky（3 项跳过）；点击覆盖率 46.92%（198/422）。六项资产通过归档、manifest、校验和、权限、架构与内部文件检查；Windows 与 Linux x86_64 portable 全新首启均以 v3.5.0 提供首页、文档和诊断，aarch64 已在 x86_64 主机完成归档与 ELF 验证。

---

## ⬇️ Which file should I download? / 我该下载哪一个？

**Windows → `sd-image-sorter-v3.5.0-windows-portable.zip`** — extract, run `run-portable.bat`.

**Linux portable x86_64 → `sd-image-sorter-v3.5.0-linux-portable-x86_64.tar.gz`** — extract, run `./run-portable.sh`.

**Linux portable aarch64 → `sd-image-sorter-v3.5.0-linux-portable-aarch64.tar.gz`** — for ARM Linux, Raspberry Pi 5, and Graviton.

**Linux source install → `sd-image-sorter-v3.5.0-linux.tar.gz`** — for systems with Python 3.12+.

**Do NOT download / 不要下载：**
- `sd-image-sorter-v3.5.0-app-patch.zip` — in-app updater only / 仅供应用内更新器
- `sd-image-sorter-v3.5.0-release-manifest.json` — updater metadata / 更新器元数据

---

## Checksums

| Asset | SHA-256 |
|---|---|
| `sd-image-sorter-v3.5.0-windows-portable.zip` | `9944bd4e59abd677b16c610e1516a6b1ceeaa2854d35ff7e860c15cbfd48ac90` |
| `sd-image-sorter-v3.5.0-app-patch.zip` | `a0939d8781c380c3cc69b869031ff1bce972ca33e53f682349b860551fb0cd07` |
| `sd-image-sorter-v3.5.0-linux.tar.gz` | `741af6e7957f35d5100cb844dc7b3aa308ae1ccae288470acdbd590dc888e1c6` |
| `sd-image-sorter-v3.5.0-linux-portable-x86_64.tar.gz` | `511a1f58857309a8429233faf4a8b224dceec88073ad4d5d02ad9951cb69a8fe` |
| `sd-image-sorter-v3.5.0-linux-portable-aarch64.tar.gz` | `8d9711a1997a7e7a4cf3dc42d774136afc248152893d6467c2b708d4fe09b83b` |
| `sd-image-sorter-v3.5.0-release-manifest.json` | `28210ba1a8eef70b3f610ac8c1ab657f354edf828af31560affc1baca5978303` |

The manifest contains the five archive checksums; its own checksum is recorded above. / manifest 内含五个归档校验和，其自身校验和记录于上表。
