## v3.3.0 — 移动进度条 + 扫描不回头 + 筛选全选 + 收藏合集 / Move Progress + Scan Fix + Filter Select-All + Collections

修复三个用户痛点：移动文件重新显示进度条、扫描新文件夹不再「猛回头」扫回上一个、拥挤的生成器筛选新增全选 / 清除 / 反选 + Shift 范围。新增收藏与合集、Library Checkpoints 分页、按 Prompt / 颜色排除、手动分拣冷却，相似度搜索更快。未新增任何功能上限。

Fixes three reported pain points: file moves show a progress bar again, new-folder scans no longer flash back to the previous folder, and the crowded generator filter gains select-all / clear / invert + shift-range. Adds Favorites & Collections, a Library Checkpoints tab, exclude-by-prompt / color, a manual-sort cooldown, and a faster similarity search.

---

## 🛠️ Fixed / 修复

- **File moves show a progress bar again**: moving or copying a selection now runs as a background job with a cancelable progress bar, so you can tell when the originals have actually been moved and it is safe to continue. (No more "did it finish? can I delete the source?" guessing.)
  - **移动文件重新显示进度条**：移动 / 复制选中项改为后台任务，带可取消的进度条，让你清楚知道原文件何时真正被移动、何时可以安全继续。（不再猜「到底做完没？能删原文件了吗？」）

- **Scan no longer "flashes back" to the previous folder**: starting a scan on a new folder while a previous progress poll was still in flight could snap the bar back to the old folder. A poll-generation guard now discards stale pollers, and a second concurrent scan returns a clear "already running" message instead of fighting the first.
  - **扫描不再「猛回头」扫回上一个文件夹**：上一轮进度轮询还没结束时对新文件夹开始扫描，进度条会跳回旧文件夹。新增轮询代数守卫会丢弃过期轮询，重复扫描会返回明确的「已在运行」提示，而不是和前一个抢。

---

## ✨ Added / 新增

- **Favorites & Collections**: a heart toggle on every gallery card, plus named collections, via a new `/api/collections` API. Membership is a *reference* — no image files are copied — so toggling is instant and reversible, and nothing is duplicated on disk.
  - **收藏与合集**：每张图卡新增爱心切换，加上具名合集，经由新的 `/api/collections` API。成员关系是「引用」——不复制图片文件——切换即时可逆，磁盘上不产生副本。

- **Library Checkpoints tab**: the Library view now has a Checkpoints facet next to Tags and LoRAs, searchable across the whole indexed library.
  - **Library Checkpoints 分页**：Library 视图在 Tags / LoRAs 旁新增 Checkpoints 分页，可对整个索引库搜索。

- **Exclude by prompt / color**: gallery filters can now *exclude* by prompt text and by color temperature. Active prompt chips cycle include → exclude → remove on each click.
  - **按 Prompt / 颜色排除**：图库筛选新增按 prompt 文本与色温「排除」。已选 prompt 标签每次点击循环 包含 → 排除 → 移除。

- **Manual-sort (WASD) cooldown**: an optional per-action cooldown so an autoclicker or a held key can't fire several sorts at once and scatter images into the wrong folders.
  - **手动分拣（WASD）冷却**：可选的每动作冷却,避免连点器或长按一次触发多次分拣、把图片分到错的文件夹。

---

## ⚡ Performance / 性能

- **Faster similarity search**: repeated searches reuse an in-memory, L2-normalized embedding matrix instead of re-reading and re-decoding every embedding from SQLite on each query. The streaming scan stays as an automatic fallback, so results are identical and libraries too large to fit in memory still work. Zero new dependencies (numpy only); opt out with `SD_SIMILARITY_DISABLE_VECTOR_CACHE=1`.
  - **相似度搜索更快**：重复搜索改为复用内存中的 L2 归一化嵌入矩阵，而非每次查询都从 SQLite 重新读取并解码全部嵌入。流式扫描作为自动后备保留，结果完全一致，内存放不下的超大库照样能用。零新增依赖（仅 numpy）；可用 `SD_SIMILARITY_DISABLE_VECTOR_CACHE=1` 关闭。

- **Tiered AI runtime scheduler**: GPU/VRAM work stays mutually exclusive, but CPU-only AI work now runs on a bounded thread pool instead of serializing behind GPU jobs — better throughput when mixing tagging, censor detection, and embedding. `GET /api/system/ai-jobs` exposes the live scheduler state for diagnostics.
  - **分层 AI 运行调度器**：GPU/VRAM 工作仍互斥，但纯 CPU 的 AI 工作改在有界线程池上运行，不再排在 GPU 任务后面串行——混合打标 / 遮挡 / 嵌入时吞吐更好。`GET /api/system/ai-jobs` 提供实时调度状态以便诊断。

---

## 🔒 Security / 安全

- **VLM endpoint scheme guard**: the captioning endpoint rejects non-`http(s)` schemes (e.g. `file://`, `gopher://`) before connecting. Local / private / loopback endpoints (Ollama, LM Studio, llama.cpp on 127.0.0.1) remain first-class and are intentionally **not** blocked — local AI is a core use case, not a threat.
  - **VLM 端点协议守卫**：captioning 端点在连接前拒绝非 `http(s)` 协议（如 `file://`、`gopher://`）。本地 / 私有 / loopback 端点（Ollama、LM Studio、llama.cpp）仍是一级支持，刻意**不**拦截——本地 AI 是核心用例，不是威胁。

---

## ✨ UI / 介面

- **Generator filter is manageable**: the generator / rating / checkpoint / LoRA filter groups gained Select all / Clear / Invert buttons and Shift-click range selection, so a 14-checkbox list no longer needs an autoclicker.
  - **生成器筛选更好管理**：生成器 / 评级 / checkpoint / LoRA 筛选组新增 全选 / 清除 / 反选 按钮与 Shift 点击范围选取，14 个勾选框的列表不再需要连点器。

- **Censor detector default explained**: the detector picker labels **Both** as the recommended option and explains that the app auto-selects the best detector you have ready (privacy YOLO + NudeNet for the widest coverage).
  - **遮挡检测器默认说明**：检测器选择器把 **Both** 标为推荐项，并说明程序会自动选择你已就绪的最佳检测器（隐私 YOLO + NudeNet 覆盖最完整）。

- **Gallery keyboard navigation** was unified onto the shared accessibility helper (arrow keys / Home / End move focus across the grid, with screen-reader position announcements). No behavior change.
  - **图库键盘导航**统一到共享无障碍 helper（方向键 / Home / End 在网格内移动焦点，并向读屏软件播报位置）。行为不变。

---

## ⚠️ Upgrading / 升级注意

- **Near-zero manual steps.** No destructive migration: Favorites & Collections reuse the existing collection tables as references, and the similarity speed-up is an in-memory cache built on demand. In-app updater users get it via Check Update; portable users extract the new archive as usual. If you ever want the old similarity behavior, set `SD_SIMILARITY_DISABLE_VECTOR_CACHE=1`.
  - **几乎零操作。** 无破坏性迁移：收藏与合集以引用方式复用既有合集表，相似度加速是按需构建的内存缓存。更新器用户走「检查更新」即可；便携版用户照常解压新档。若想退回旧的相似度行为，设 `SD_SIMILARITY_DISABLE_VECTOR_CACHE=1`。

---

## ✅ Validation / 验证

- Backend: full pytest suite green on Python 3.12 (new vector-cache parity, collections, AI-scheduler, move-job, and VLM scheme-guard tests included).
- `ruff check backend`: clean. Compiled lock freshness + dependency security audit + frontend JS syntax: green.
- Playwright E2E: critical gallery / scan / move / filter flows pass.
- The faster similarity search was verified result-identical to the previous streaming scan across thresholds, pagination, exclusion, tie-breaks, and zero-vector queries.

---

## ⬇️ Which file should I download? / 我该下载哪一个？

**Windows → `sd-image-sorter-v3.3.0-windows-portable.zip`** — extract, run `run-portable.bat`.

**Linux (any modern distro, including Python 3.13 / 3.14 systems and Raspberry Pi 5) → `sd-image-sorter-v3.3.0-linux-portable-x86_64.tar.gz`** or `…-aarch64.tar.gz` — extract, `chmod +x run-portable.sh`, run `./run-portable.sh`.

**Linux source install** (advanced users with their own Python 3.12 / 3.13 toolchain) → `sd-image-sorter-v3.3.0-linux.tar.gz` — extract, run `./run.sh`.

**Do NOT download / 不要下载：**
- `sd-image-sorter-v3.3.0-app-patch.zip` — in-app updater payload only / 仅供更新器
- `sd-image-sorter-v3.3.0-release-manifest.json` — updater metadata / 更新器元数据

---

## Checksums

See `release-manifest.json` for the SHA-256 of each release asset.
