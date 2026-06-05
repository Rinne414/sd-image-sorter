## v3.3.2 — Sort & Cull 工作台 + 大图库更顺 / Sort & Cull Workbench + Faster Large Libraries

把手动分拣页升级成多模式 Sort & Cull 工作台：保留 WASD 槽位分拣，新增 A/B 擂台（擂主守擂）与 留/汰 快筛，都带 SD 专属的「只看差异」元数据对比条与同步像素级放大——通用素材管理器做不到。大图库更顺：批量删除 / 移除 / 导出改后台任务、缩略图扫描时让路、AI 运行调度加优先级与显存感知、相似度缓存可跨重启。另含高分屏自适应缩放与一批 UI/UX 与 bug 修复。未新增任何功能上限。

The Manual Sort tab becomes a multi-mode Sort & Cull Workbench: keep the fast WASD slot-sort, add an A/B 擂台 King-of-Hill showdown and a 留/汰 Keep-Reject quick-cull, both with SD-aware metadata-diff tooling and synchronized pixel-peep zoom. Large libraries feel faster — background bulk delete / remove / export, scan-aware thumbnail backpressure, a priority + VRAM-aware AI runtime scheduler, and a persistent similarity cache. Plus adaptive UI scaling for high-res desktops and a batch of UI/UX and bug fixes.

---

## ✨ Added / 新增

- **Sort & Cull Workbench (Manual Sort redesign)** — the Manual Sort tab is now a switchable hub. The existing WASD slot-sort is preserved as one mode; the start button and keyboard map adapt to the active mode.
  - **Sort & Cull 工作台（手动分拣重构）** —— 手动分拣页现在是可切换的多模式中心。原有的 WASD 槽位分拣保留为其中一种模式，开始按钮与键位随当前模式自适应。
- **A/B 擂台 King-of-Hill showdown** — a champion image stays on screen and faces the next challenger; pick the winner with ← / → (↑ skip, Z undo, Esc exit). Each fighter shows real SD metadata chips (sampler / CFG / steps / seed / checkpoint / size / aesthetic) and a champion win-streak (👑 连胜 ×N). The winner can be routed to a Collection or Favorites — non-destructive and opt-in.
  - **A/B 擂台（擂主守擂）** —— 擂主留在画面上迎战下一位挑战者；用 ← / → 选出胜者（↑ 跳过、Z 撤销、Esc 退出）。每位选手显示真实 SD 元数据芯片（采样器 / CFG / 步数 / 种子 / checkpoint / 尺寸 / 美学分）与擂主连胜（👑 连胜 ×N）。胜者可收入某个合集或收藏——非破坏性、需手动开启。
- **Showdown inspector (the SD moat)** — a side-by-side comparator that lists only the *differing* generation params (sampler / CFG / steps / seed / scheduler / clip / denoise / model / size) and a synchronized pixel-peep zoom that scales both images to the same point. This is what a generic asset manager structurally cannot do.
  - **擂台检视器（SD 护城河）** —— 并排比对，只列出**有差异**的生成参数（采样器 / CFG / 步数 / 种子 / 调度器 / clip / denoise / 模型 / 尺寸），并提供把两张图缩放到同一位置的同步像素级放大。这是通用素材管理器结构上做不到的。
- **留/汰 Keep-Reject cull mode** — a single-image fast first pass: → keep, ← reject, ↑ skip, with a live ♥ keep / ✕ reject tally and undo / redo. On finish, kept and rejected images route to your chosen destinations (none / Favorites / a collection), all by reference (no file move unless you ask).
  - **留/汰 快筛模式** —— 单图快速初筛：→ 留下、← 汰除、↑ 跳过，带实时 ♥ 留 / ✕ 汰 计数与撤销 / 重做。结束时留下与汰除的图片按你选择的去向归位（无 / 收藏 / 某合集），全部按引用处理（除非你要求，否则不移动文件）。
- **Adaptive interface scaling** — on large / high-resolution desktops the UI now scales up automatically (root zoom keyed to window width; viewports ≤1920 are untouched), with a manual override, so controls stay comfortably sized on 2560-wide and 4K screens.
  - **界面自适应缩放** —— 在大尺寸 / 高分辨率桌面上界面会自动放大（根 zoom 按窗口宽度调整；≤1920 的视口不变），并可手动覆盖，让 2560 宽与 4K 屏幕上的控件保持舒适大小。

---

## 🚀 Performance / 性能

- **Background bulk delete / remove / export** — deleting files from disk, removing from the gallery, and batch tag export now run as cancelable background jobs with progress bars, so large selections no longer freeze the browser (file move was already a background job in v3.3.0).
  - **批量删除 / 移除 / 导出改为后台任务** —— 从磁盘删除、从图库移除、批量标签导出现在都是可取消、带进度条的后台任务，大量选择不再卡死浏览器（移动文件在 v3.3.0 已是后台任务）。
- **Scan-aware thumbnail backpressure** — while a scan is running, thumbnail generation throttles to a small bounded pool so it stops competing with metadata parsing; scans feel faster, and idle throughput is unchanged.
  - **扫描感知的缩略图背压** —— 扫描进行时，缩略图生成会限制在一个有界小线程池，避免与元数据解析抢资源；扫描更快，空闲时吞吐不变。
- **AI runtime scheduler — priority + VRAM + timeout** — the AI runtime guard gained fair priority ordering (interactive vs batch), a per-job VRAM estimate, and an opt-in acquire timeout, so concurrent AI jobs (tag + censor + similarity + aesthetic) stop fighting. Defaults match the prior fully-serialized behavior byte-for-byte.
  - **AI 运行调度器——优先级 + 显存 + 超时** —— AI 运行守卫新增公平优先级排序（交互 vs 批处理）、每任务显存估算与可选获取超时，让并发 AI 任务（打标 + 打码 + 相似度 + 美学）不再互抢；默认行为与此前完全串行化逐字节一致。
- **Persistent similarity cache + optional ANN** — the similarity vector matrix now persists to disk so cold-start search skips re-reading every embedding from SQLite, and an optional `hnswlib` ANN top-k path is available (exact re-rank preserves results; opt out with `SD_SIMILARITY_DISABLE_ANN=1`).
  - **相似度缓存持久化 + 可选 ANN** —— 相似度向量矩阵现在会持久化到磁盘，冷启动搜索不必再从 SQLite 重读全部 embedding；并提供可选的 `hnswlib` ANN top-k 路径（精确重排保证结果一致；用 `SD_SIMILARITY_DISABLE_ANN=1` 可关闭）。

---

## 🛠️ Fixed / 修复

- **Filter "select all" no longer drops images** — ticking *select all* models or LoRAs (with no search) now means "no restriction", matching ratings / generators. Previously it sent the full explicit list, which silently excluded images with a NULL checkpoint or zero LoRAs, so "select all" returned fewer images than expected.
  - **筛选「全选」不再漏图** —— 勾选「全选」模型或 LoRA（且无搜索）现在表示「不限制」，与评级 / 生成器一致。此前它会发送完整明确列表，悄悄排除了 checkpoint 为空或没有 LoRA 的图片，导致「全选」反而比预期少。
- **Gallery total no longer flashes "-1"** — a count-skipped sentinel could briefly render as "-1 张图片"; it is now guarded.
  - **图库总数不再闪现「-1」** —— 计数被跳过的哨兵值曾短暂显示为「-1 张图片」，现已加保护。
- **Antivirus false positive on launch** — the launchers no longer spawn a hidden PowerShell window to open the browser (some AV, e.g. Huorong, flagged it as a trojan); opening the browser is now done in-process.
  - **启动时杀软误报** —— 启动器不再用隐藏的 PowerShell 窗口打开浏览器（部分杀软如火绒会误判为木马）；改为进程内打开浏览器。
- **Dropped-folder scan path** — dragging a folder onto the scan input now resolves its real path before scanning, with a browse fallback.
  - **拖入文件夹的扫描路径** —— 把文件夹拖到扫描输入框现在会先解析真实路径再扫描，并提供浏览兜底。
- **Auto-Separate preview & progress** — the preview grid fills the available pane height instead of a fixed two rows (no more large empty space), the image count is clamped to ≥0 with reset-on-error, and the move progress bar scrolls into view with an idle grace period.
  - **Auto-Separate 预览与进度** —— 预览网格现在填满可用面板高度，而非固定两行（不再有大片空白）；图片计数夹紧到 ≥0 并在出错时重置；移动进度条会滚动到可见处并保留空闲宽限。
- **Wasted-space empty states** — the Reader and Prompt Lab no longer reserve large empty columns before content loads; the Prompt Lab stats copy now points to AI tagging when there are no tags yet.
  - **空状态的空白浪费** —— 读图与 Prompt Lab 在内容加载前不再预留大片空列；Prompt Lab 统计在尚无标签时改为提示先做 AI 打标。
- **Censor editor layout** — fixed the 769–960px range where the toolbar went off-screen (it now stacks), and hid the editing chrome (toolbar + footer bars) in the empty no-image state so only the "select an image" card shows.
  - **打码编辑器布局** —— 修复 769–960px 区间工具栏跑出屏幕的问题（现在改为堆叠），并在无图的空状态下隐藏编辑外壳（工具栏 + 底栏），只显示「选择一张图片」卡片。

---

## ⚙️ Internal / 内部

- **E2E coverage for the Workbench** — added Playwright coverage for the A/B Showdown flow and the Keep-Reject cull flow, plus a WASD slot-sort regression; the batch remove / delete / export smoke mocks were repointed at the new background-job `/start` + `/progress` endpoints.
  - **工作台 E2E 覆盖** —— 新增 A/B 擂台流程与留/汰快筛流程的 Playwright 覆盖，以及 WASD 槽位分拣回归；批量移除 / 删除 / 导出的 smoke mock 已改指向新的后台任务 `/start` + `/progress` 接口。

---

## ⚠️ Upgrading / 升级注意

- **Near-zero manual steps.** No destructive migration: the Workbench reuses the existing manual-sort session model (old WASD sessions still load and resume), the cull / showdown outcomes are reference-based (no image files are copied or moved unless you opt in), and the similarity disk cache is rebuilt automatically if missing. In-app updater users get it via **Check Update**; portable users extract the new archive as usual. A normal F5 refetches the new assets (the cache-bust token follows the version).
  - **几乎零操作。** 无破坏性迁移：工作台复用既有的手动分拣会话模型（旧的 WASD 会话仍可加载、续做），留/汰与擂台的结果都是引用方式（除非你主动选择，否则不复制、不移动任何图片文件），相似度磁盘缓存若缺失会自动重建。更新器用户走 **检查更新** 即可；便携版用户照常解压新档。普通 F5 即可重新拉取新资源（缓存失效令牌跟随版本号）。

---

## ✅ Validation / 验证

- Backend: full pytest suite green on Python 3.12 (1809 passed / 6 skipped), including the new A/B bracket + Keep-Reject cull session tests. `ruff check backend`: clean. Lock freshness + dependency security audit + frontend JS syntax: green.
- Playwright E2E: 124 passed / 5 skipped — critical gallery / scan / move / filter flows plus the new **A/B Showdown** and **Keep/Reject cull** specs and the WASD slot-sort regression.
- Workbench verified live against a 43k-image library: mode switch, A/B pick → champion advance with the metadata-diff strip, and cull keep/reject, with 0 console errors.

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
