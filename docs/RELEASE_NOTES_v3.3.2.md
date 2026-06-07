## v3.3.2 — Sort & Cull 工作台 · 资料库导航 · CLIP 找图 · GPU 更稳 / Sort & Cull Workbench, Library Navigation, CLIP Tools & GPU Resilience

手动分拣页升级为多模式 **Sort & Cull 工作台**（A/B 擂台 + 留/汰 快筛，带「只看差异」的 SD 元数据对比与同步像素级放大）；新增**资料库导航**（侧栏文件夹树 + 图片来源管理 + 空闲自动刷新）、**CLIP 两图比对 / 一键找近似**、Dataset Maker **双框 caption 编辑器**与 **danbooru 彩色标签分群**。GPU 打标更稳——CUDA 显存不足时自适应缩小批量而非崩溃或永久退回 CPU，并行预处理让 GPU 不空转。大图库更顺：批量删除 / 移除 / 导出转后台、扫描时缩略图让路、相似度缓存跨重启。另含模型源（ModelScope）与 Kaloscope GPU/CPU 切换、Censor 原生像素遮罩、一批 i18n 与 bug 修复。未新增任何功能上限。

The Manual Sort tab becomes a multi-mode **Sort & Cull Workbench** (A/B 擂台 King-of-Hill + 留/汰 Keep-Reject, with SD-aware differences-only metadata compare and synchronized pixel-peep zoom). New **Library Navigation** (sidebar folder tree + image-source manager + idle auto-refresh), **CLIP two-image compare / one-click near-duplicates**, and a Dataset Maker **two-box caption editor** with **danbooru colored tag groups**. GPU tagging is more resilient — a too-large batch now backs off to a smaller GPU batch on real CUDA OOM instead of crashing or permanently dropping to CPU, and parallel preprocessing keeps the GPU fed. Large libraries feel faster, plus ModelScope model routing, a Kaloscope GPU/CPU toggle, native censor pixel masks, and a batch of i18n and bug fixes.

---

## ✨ Added / 新增

### Sort & Cull Workbench (Manual Sort redesign) / Sort & Cull 工作台（手动分拣重构）

- **Switchable multi-mode hub** — the Manual Sort tab is now a hub. The fast WASD slot-sort is preserved as one mode; the start button and keyboard map adapt to the active mode.
  - **可切换的多模式中心** —— 手动分拣页现在是一个中心。原有的快速 WASD 槽位分拣保留为其中一种模式，开始按钮与键位随当前模式自适应。
- **A/B 擂台 King-of-Hill showdown** — a champion image stays on screen and faces the next challenger; pick the winner with ← / → (↑ skip, Z undo, Esc exit). Each fighter shows real SD metadata chips (sampler / CFG / steps / seed / checkpoint / size / aesthetic) and a champion win-streak (👑 连胜 ×N). The winner can be routed to a Collection or Favorites — non-destructive and opt-in.
  - **A/B 擂台（擂主守擂）** —— 擂主留在画面上迎战下一位挑战者；用 ← / → 选出胜者（↑ 跳过、Z 撤销、Esc 退出）。每位选手显示真实 SD 元数据芯片（采样器 / CFG / 步数 / 种子 / checkpoint / 尺寸 / 美学分）与擂主连胜（👑 连胜 ×N）。胜者可收入某个合集或收藏——非破坏性、需手动开启。
- **Showdown inspector (the SD moat)** — a side-by-side comparator that lists only the *differing* generation params (sampler / CFG / steps / seed / scheduler / clip / denoise / model / size) and a synchronized pixel-peep zoom that scales both images to the same point. This is what a generic asset manager structurally cannot do.
  - **擂台检视器（SD 护城河）** —— 并排比对，只列出**有差异**的生成参数（采样器 / CFG / 步数 / 种子 / 调度器 / clip / denoise / 模型 / 尺寸），并提供把两张图缩放到同一位置的同步像素级放大。这是通用素材管理器结构上做不到的。
- **留/汰 Keep-Reject cull mode** — a single-image fast first pass: → keep, ← reject, ↑ skip, with a live ♥ keep / ✕ reject tally and undo / redo. On finish, kept and rejected images route to your chosen destinations (none / Favorites / a collection), all by reference (no file move unless you ask).
  - **留/汰 快筛模式** —— 单图快速初筛：→ 留下、← 汰除、↑ 跳过，带实时 ♥ 留 / ✕ 汰 计数与撤销 / 重做。结束时留下与汰除的图片按你选择的去向归位（无 / 收藏 / 某合集），全部按引用处理（除非你要求，否则不移动文件）。

### Library Navigation / 资料库导航

- **Folder tree in the gallery sidebar** — a collapsible **Folders** tree, built from the directories that actually contain indexed images, scopes the gallery to a folder *and everything beneath it* (recursive subtree) with one click — exactly the way Collections drives the gallery.
  - **图库侧栏文件夹树** —— 可折叠的「文件夹」树，由实际包含已索引图片的目录构建，点一下即可把图库限定到某个文件夹**及其下所有子目录**（递归子树）——和合集驱动图库的方式一致。
- **Library Roots manager** — a modal that lists the folders you added as image sources (auto-registered on scan), with per-root **Rescan** and **Remove** (removing a root drops it from the library; image files stay on disk). "Add Folder…" reuses the existing scan flow.
  - **图片来源（Library Roots）管理** —— 一个弹窗列出你加入的图片来源文件夹（扫描时自动登记），每个来源都可单独**重扫**与**移除**（移除只是从库里去掉，磁盘文件不动）。「添加文件夹…」复用既有扫描流程。
- **Idle library auto-refresh (opt-in, default OFF)** — when enabled, the app quietly quick-imports the stalest library root while you are idle, so newly dropped images appear without a manual scan. It **never tags** (quick-import only — GPU safety) and no-ops while any scan is running, so it is always safe.
  - **空闲自动刷新（可选，默认关闭）** —— 开启后，应用会在你空闲时悄悄对最久没更新的来源做 quick-import，让新放进去的图片不必手动扫描就出现。它**绝不打标**（只做 quick-import——显存安全），且任何扫描进行时自动跳过，因此始终安全。

### CLIP image tools / CLIP 图像工具

- **Two-image compare** — pick any two images and get their CLIP cosine similarity, so you can judge "how alike" a pair really is instead of eyeballing it.
  - **两图比对** —— 任选两张图，得出它们的 CLIP 余弦相似度，让你用数值判断「有多像」，而不是凭肉眼。
- **One-click near-duplicates** — from any image, jump to its top-K closest neighbours to find near-dupes / variants fast. Built on read-only similarity endpoints; pairs with the cull workbench for de-duping a set.
  - **一键找近似** —— 从任意一张图出发，跳到它最接近的 top-K 邻居，快速找出近似 / 变体图。基于只读相似度接口，配合精挑工作台可用来给一组图去重。

### Dataset Maker & captioning / Dataset Maker 与打标

- **Two-box caption editor** — booru tags and the natural-language caption are now edited in two separate boxes instead of one mixed blob, so a VLM sentence and the tag list no longer contaminate each other on export.
  - **双框 caption 编辑器** —— booru 标签与自然语言描述现在分两个框编辑，不再混在一团，导出时 VLM 句子与标签列表不会互相污染。
- **Per-image natural-language caption type** — each image can carry its own NL caption type, and the exporter / preview reads the stored `ai_caption` directly so what you edit is what ships.
  - **每图自然语言描述类型** —— 每张图都能带自己的 NL 描述类型，导出 / 预览直接读取存好的 `ai_caption`，你编辑什么就导出什么。
- **Danbooru colored tag groups** — every booru tag is classified into a danbooru-style category and color-coded in the caption editor, so character / copyright / general / meta / quality tags are visually separable at a glance.
  - **danbooru 彩色标签分群** —— 每个 booru 标签都会归类到 danbooru 风格的类别并在 caption 编辑器里用颜色标注，让角色 / 版权 / 通用 / meta / 质量等标签一眼就能区分。
- **Robust VLM tag/caption split** — the hybrid parser more reliably separates a VLM's tag output from its prose, so mixed responses no longer leak sentence fragments into the tag set.
  - **更稳的 VLM 标签 / 描述拆分** —— 混合解析器更可靠地把 VLM 的标签输出与散文描述分开，混合回复不再把句子碎片漏进标签集。
- **VLM proxy support (http / https / socks)** — the VLM client honours a configured proxy for cloud captioning; SOCKS support is bundled (`socksio`), and a missing SOCKS dependency surfaces a clear error instead of crashing.
  - **VLM 代理支持（http / https / socks）** —— 云端打标的 VLM 客户端会遵循配置的代理；已内置 SOCKS 支持（`socksio`），缺少 SOCKS 依赖时给出明确错误而不是崩溃。

### Models & tagging / 模型与打标

- **Kaloscope (Artist ID) GPU/CPU toggle** — the experimental Kaloscope artist identifier now has the same GPU/CPU switch as the WD14 tagger (it was previously hard-pinned to CUDA, the only model with no escape hatch); CPU works, ~2.1× slower.
  - **Kaloscope（画师识别）GPU/CPU 切换** —— 实验性的 Kaloscope 画师识别器现在和 WD14 打标器一样有 GPU/CPU 开关（此前被硬绑在 CUDA，是唯一没有退路的模型）；CPU 可用，约慢 2.1×。
- **Real ModelScope route + tolerant manual placement** — the "ModelScope" mirror now genuinely routes the artist / Kaloscope and SAM3 downloads to modelscope.cn (the flat ModelScope repo layout is handled), and manual model placement is detected even with a HuggingFace-hub cache layout, case-insensitive folder names, or a git-clone directory.
  - **真正的 ModelScope 路由 + 宽容的手动放置** —— 「ModelScope」镜像现在会真正把画师 / Kaloscope 与 SAM3 的下载指向 modelscope.cn（已处理其扁平仓库结构），手动放置的模型即使是 HuggingFace-hub 缓存结构、大小写不同的文件夹名或 git-clone 目录也能被识别。

### Censor / 打码

- **Native YOLOv8-seg pixel masks + Precise / Box toggle** — the auto-detector can produce true polygon pixel masks (YOLOv8-seg / SAM3) instead of only rectangles, with a Precise / Box toggle; when a "Precise" run gets only boxes back, that is surfaced honestly.
  - **原生 YOLOv8-seg 像素遮罩 + 精确 / 方框切换** —— 自动检测可输出真正的多边形像素遮罩（YOLOv8-seg / SAM3），而非只有矩形，并提供「精确 / 方框」切换；当「精确」运行只拿回方框时会如实提示。
- **SAM3 refine entry** — a refine entry point lets SAM3 tighten an existing detection into a precise mask.
  - **SAM3 精修入口** —— 提供精修入口，让 SAM3 把已有检测收紧为精确遮罩。

### Desktop UX / 桌面体验

- **Adaptive interface scaling** — on large / high-resolution desktops the UI scales up automatically (root zoom keyed to window width; viewports ≤1920 are untouched), with a manual override, so controls stay comfortably sized on 2560-wide and 4K screens.
  - **界面自适应缩放** —— 在大尺寸 / 高分辨率桌面上界面会自动放大（根 zoom 按窗口宽度调整；≤1920 的视口不变），并可手动覆盖，让 2560 宽与 4K 屏幕上的控件保持舒适大小。
- **Selection-mode sidebar** — entering gallery selection mode collapses the browse / filter sidebar so the actions panel has room and its labels no longer clip at the fixed sidebar width.
  - **选择模式侧栏** —— 进入图库选择模式时会折叠浏览 / 筛选侧栏，让操作面板有空间，标签也不再在固定侧栏宽度下被截断。

---

## 🚀 Performance / 性能

- **Adaptive GPU OOM backoff (WD14 + OppaiOracle)** — a batch that hits genuine CUDA out-of-memory now halves the GPU sub-batch (rebuilding the GPU session between steps) and retries on the GPU before any CPU fallback, and only halves for *real* OOM — a non-OOM GPU error skips straight to CPU instead of wastefully halving 64→1 first. A too-large batch degrades to a smaller GPU batch instead of crashing or permanently dropping to CPU.
  - **GPU 显存不足自适应回退（WD14 + OppaiOracle）** —— 真正撞到 CUDA 显存不足的批量现在会把 GPU 子批量减半（步骤之间重建 GPU 会话）并先在 GPU 上重试，之后才考虑回退 CPU；而且只对**真正的** OOM 减半——非 OOM 的 GPU 错误直接走 CPU，不再无谓地把 64 一路砍到 1。批量过大会降级为更小的 GPU 批量，而不是崩溃或永久退回 CPU。
- **Parallel image preprocessing** — image decode / letterbox now runs on a small bounded thread pool so the GPU is not starved waiting on a single CPU core between batches (GPU inference itself stays serialized by the AI runtime guard).
  - **并行图像预处理** —— 图像解码 / letterbox 现在跑在一个有界小线程池上，避免 GPU 在批次之间空等单核 CPU（GPU 推理本身仍由 AI 运行守卫串行化）。
- **Hardware-aware Smart Tag batching** — Smart Tag starts from a VRAM / model-aware booru batch size (mirrors the bulk tagging worker) instead of a fixed 64, so an 8GB-VRAM laptop GPU starts at a size that fits; it also reacts to live memory pressure mid-run (refresh session under VRAM pressure, shrink batch under RAM pressure).
  - **硬件感知的 Smart Tag 批量** —— Smart Tag 从显存 / 模型感知的 booru 批量起步（与批量打标 worker 一致），而非固定 64，让 8GB 显存的笔记本 GPU 一开始就用得下的尺寸；运行中还会响应实时内存压力（显存吃紧时刷新会话、内存吃紧时缩小批量）。
- **ToriiGate KV cache speedup** — the ToriiGate captioner turns its generation KV cache on (~2–4× faster) when free VRAM is comfortable, and keeps it off on a tight GPU to avoid an OOM mid-generation. CPU always uses it.
  - **ToriiGate KV 缓存加速** —— ToriiGate 描述模型在显存充裕时开启生成 KV 缓存（约 2–4× 更快），显存紧张时保持关闭以免生成中途 OOM。CPU 始终启用。
- **Background bulk delete / remove (+ background export)** — deleting files from disk and removing from the gallery now run as cancelable background jobs with progress bars; batch tag export also runs in the background (coarse progress, not cancelable mid-run). Large selections no longer freeze the browser (file move was already a background job in v3.3.0).
  - **批量删除 / 移除改为后台任务（导出也在后台）** —— 从磁盘删除、从图库移除现在是可取消、带进度条的后台任务；批量标签导出也在后台运行（粗粒度进度，运行中不可取消）。大量选择不再卡死浏览器（移动文件在 v3.3.0 已是后台任务）。
- **Scan-aware thumbnail backpressure** — while a scan is running, thumbnail generation throttles to a small bounded pool so it stops competing with metadata parsing; scans feel faster, and idle throughput is unchanged.
  - **扫描感知的缩略图背压** —— 扫描进行时，缩略图生成会限制在一个有界小线程池，避免与元数据解析抢资源；扫描更快，空闲时吞吐不变。
- **Persistent similarity vector cache** — the similarity vector matrix persists to disk, so cold-start search skips re-reading every embedding from SQLite (verified identical to the streaming path). An experimental `hnswlib` ANN top-k index also ships (`SimilarityIndex.top_k_similar`, with exact re-rank) but is **not yet wired into the default paginated search** — opt-in groundwork for very large libraries (disable with `SD_SIMILARITY_DISABLE_ANN=1`).
  - **相似度向量缓存持久化** —— 相似度向量矩阵会持久化到磁盘，冷启动搜索不必再从 SQLite 重读全部 embedding（已验证与流式路径结果一致）。另附实验性 `hnswlib` ANN top-k 索引（`SimilarityIndex.top_k_similar`，带精确重排），但**尚未接入默认的分页搜索路径**——为超大图库预留的可选打底（用 `SD_SIMILARITY_DISABLE_ANN=1` 关闭）。
- **AI runtime guard — concurrency groundwork** — the AI runtime guard gained plumbing for fair priority ordering, per-job VRAM estimates, and an opt-in acquire timeout. This ships as foundation for future concurrency; the shipped default is unchanged, so all AI work (tag + censor + similarity + aesthetic) still runs fully serialized and there is no new OOM risk.
  - **AI 运行守卫——并发打底** —— AI 运行守卫新增了公平优先级排序、每任务显存估算与可选获取超时的底层管线。这是为后续并发预留的基础；默认行为不变，所有 AI 工作（打标 + 打码 + 相似度 + 美学）仍完全串行，因此不引入新的显存风险。

---

## 🛠️ Fixed / 修复

- **Filter "select all" no longer drops images + gallery/auto-separate count parity** — ticking *select all* models or LoRAs (with no search) now means "no restriction" (matching ratings / generators), instead of sending the full explicit list that silently excluded NULL-checkpoint or zero-LoRA images. The gallery total and the Auto-Separate match count now agree for the same filter.
  - **筛选「全选」不再漏图 + 图库/自动分离计数一致** —— 勾选「全选」模型或 LoRA（且无搜索）现在表示「不限制」（与评级 / 生成器一致），不再发送会悄悄排除「checkpoint 为空 / 无 LoRA」图片的完整明确列表。同一筛选下，图库总数与 Auto-Separate 匹配数现在一致。
- **Favorites survive a rescan** — favorites are now path-anchored, so re-scanning or re-indexing a folder no longer loses your hearts.
  - **收藏不怕重扫** —— 收藏现在以路径锚定，重扫 / 重新索引文件夹不再丢失你的红心。
- **Honest SAM3 batch counts + no 500-box cap** — batch SAM3 now reports the real processed / detected counts instead of an optimistic number, and the previous 500-box ceiling is gone. Folder scope and the metadata radios also clear correctly on reset.
  - **诚实的 SAM3 批量计数 + 取消 500 框上限** —— 批量 SAM3 现在报告真实的处理 / 检测数量，而非乐观估计，且取消了此前 500 框的上限。重置时文件夹范围与元数据单选也会正确清除。
- **Gallery total no longer flashes "-1"** — a count-skipped sentinel could briefly render as "-1 张图片"; it is now guarded. The move progress bar is also restored.
  - **图库总数不再闪现「-1」** —— 计数被跳过的哨兵值曾短暂显示为「-1 张图片」，现已加保护。移动进度条也已恢复。
- **Antivirus false positive on launch** — the launchers no longer spawn a hidden PowerShell window to open the browser (some AV, e.g. Huorong, flagged it as a trojan); opening the browser is now done in-process.
  - **启动时杀软误报** —— 启动器不再用隐藏的 PowerShell 窗口打开浏览器（部分杀软如火绒会误判为木马）；改为进程内打开浏览器。
- **Localization gaps in the zh-CN UI** — 23 strings that still showed English are now localized, sub-UI modal labels (export / save options / queue manager / reconnect, etc.) are translated, and the zh-CN folder vocabulary is normalized for consistency.
  - **zh-CN 界面本地化缺口** —— 修正 23 处仍显示英文的字符串，翻译了子界面弹窗标签（导出 / 保存选项 / 队列管理 / 重连等），并统一了 zh-CN 的文件夹词汇。
- **Workbench resume (A/B 擂台 + 留/汰)** — a paused A/B Showdown now shows a resume banner and resumes correctly instead of failing with a 409; 留/汰 keep/reject decisions made before a reload are no longer dropped (rebuilt from the saved session and still routed at finish); the resume banner shows mode-appropriate info (comparisons / images left) instead of slot-only folder text.
  - **工作台恢复（A/B 擂台 + 留/汰）** —— 暂停的 A/B 擂台现在会显示恢复横幅并正确续做，而不再以 409 失败；留/汰 在刷新前做出的留/汰决定不再丢失（从已保存会话重建，结束时仍会归位）；恢复横幅按模式显示对应信息（剩余对决 / 待筛图片），而非只适用槽位分拣的文件夹文案。
- **Metadata-diff accuracy + synchronized zoom (showdown inspector)** — the differences-only strip reads the scheduler under each generator's key (ComfyUI `scheduler` / A1111 `schedule_type` / NovelAI `noise_schedule`), normalizes sampler names so the same sampler isn't flagged as different across generators, and shows "No SD generation metadata to compare" instead of a misleading "Same generation params" when neither image carries params. The A/B zoom maps to the same picture point on both images even at different aspect ratios (it corrects for object-fit letterboxing).
  - **元数据差异更准 + 同步放大（擂台检视器）** —— 只显示差异的对比条会读取各生成器各自的调度器键（ComfyUI `scheduler` / A1111 `schedule_type` / NovelAI `noise_schedule`），对采样器名称做归一化（同一采样器跨生成器不再误报不同），两张图都没有生成参数时显示「没有可对比的 SD 生成参数」而非误导性的「生成参数相同」。A/B 缩放即便两图长宽比不同也对准同一画面位置（已校正 object-fit 留白）。
- **Dropped-folder scan path** — dragging a folder onto the scan input resolves its real path before scanning, with a browse fallback.
  - **拖入文件夹的扫描路径** —— 把文件夹拖到扫描输入框会先解析真实路径再扫描，并提供浏览兜底。
- **Auto-Separate preview & progress, wasted-space empty states, censor editor layout** — the Auto-Separate preview grid fills the available height (no fixed two rows), counts clamp to ≥0 with reset-on-error, and the move progress bar scrolls into view; the Reader and Prompt Lab no longer reserve large empty columns before content loads; the censor editor hides its chrome in the empty no-image state and stacks the toolbar in narrow windows.
  - **Auto-Separate 预览与进度、空状态空白、打码编辑器布局** —— Auto-Separate 预览网格填满可用高度（不再固定两行），计数夹紧到 ≥0 并在出错时重置，移动进度条会滚动到可见处；读图与 Prompt Lab 在内容加载前不再预留大片空列；打码编辑器在无图空状态下隐藏外壳，窄窗口下工具栏改为堆叠。

---

## ⚙️ Internal / 内部

- **`nl_caption` schema migration (018)** — the natural-language caption column is now created by a numbered migration, so upgrading an existing database no longer risks a crash-on-upgrade (a column added without a numbered migration would have been missing for existing users).
  - **`nl_caption` 结构迁移（018）** —— 自然语言描述列现在由编号迁移创建，升级既有数据库不再有「升级即崩溃」风险（没有编号迁移的新列对老用户会缺失）。
- **E2E + backend coverage for the new flows** — Playwright covers the A/B Showdown and Keep-Reject cull flows plus a WASD slot-sort regression; backend tests assert the cull decision-map (cleared on undo), VLM proxy / hybrid-parse, similarity compare/near, the vector cache, and the GPU OOM-backoff / hardware-aware batch paths.
  - **新流程的 E2E + 后端覆盖** —— Playwright 覆盖 A/B 擂台与留/汰快筛流程及 WASD 槽位分拣回归；后端测试断言留/汰 决定映射（撤销时清除）、VLM 代理 / 混合解析、相似度比对/找近似、向量缓存，以及 GPU OOM 回退 / 硬件感知批量路径。

---

## ⚠️ Upgrading / 升级注意

- **Near-zero manual steps.** Database migrations (including the new `nl_caption` migration 018, library-roots and favorite-paths tables) run automatically on first launch; old WASD sort sessions still load and resume; cull / showdown outcomes are reference-based (no image files are copied or moved unless you opt in); the similarity disk cache rebuilds itself if missing. In-app updater users get it via **Check Update**; portable users extract the new archive as usual. A normal F5 refetches the new frontend assets (the cache-bust token follows the version).
  - **几乎零操作。** 数据库迁移（含新的 `nl_caption` 迁移 018、library-roots 与 favorite-paths 表）在首次启动时自动执行；旧的 WASD 分拣会话仍可加载、续做；留/汰与擂台结果都是引用方式（除非你主动选择，否则不复制、不移动任何图片文件）；相似度磁盘缓存若缺失会自动重建。更新器用户走 **检查更新** 即可；便携版用户照常解压新档。普通 F5 即可重新拉取新前端资源（缓存失效令牌跟随版本号）。

---

## ✅ Validation / 验证

- **Backend:** full pytest suite green on Python 3.12 — **1949 passed / 6 skipped**, 81% coverage. `ruff check backend`: clean. Compiled-lock freshness + dependency security audit + frontend JS syntax: all green.
- **Playwright E2E:** **124 passed / 5 skipped** — gallery / scan / move / filter / reader / censor / tagger flows plus the A/B Showdown and Keep-Reject cull specs and the WASD slot-sort regression.
- 后端 1949 通过 / 6 跳过（覆盖率 81%），ruff 干净，依赖安全审计通过；E2E 124 通过 / 5 跳过。

---

## ⬇️ Which file should I download? / 我该下载哪一个？

**Windows → `sd-image-sorter-v3.3.2-windows-portable.zip`** — extract, run `run-portable.bat`.

**Linux (any modern distro, including Python 3.13 / 3.14 systems and Raspberry Pi 5) → `sd-image-sorter-v3.3.2-linux-portable-x86_64.tar.gz`** or `…-aarch64.tar.gz` — extract, `chmod +x run-portable.sh`, run `./run-portable.sh`.

**Linux source install** (advanced users with their own Python 3.12 / 3.13 toolchain) → `sd-image-sorter-v3.3.2-linux.tar.gz` — extract, run `./run.sh`.

**Do NOT download / 不要下载：**
- `sd-image-sorter-v3.3.2-app-patch.zip` — in-app updater payload only / 仅供更新器
- `sd-image-sorter-v3.3.2-release-manifest.json` — updater metadata / 更新器元数据

---

## Checksums

See `release-manifest.json` for the SHA-256 of each release asset.
