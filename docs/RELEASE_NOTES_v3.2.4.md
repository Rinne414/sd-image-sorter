## v3.2.4 — Event-loop 不卡死 + 安全修补 + UI 优化 / Event-loop Unblocking + Security + UI Polish

稳定性 + 安全修补。重型 API 路由（tags / sorting / 批量打标 / analytics）改到 threadpool 执行，大图库下不再卡死整个 server；tag / 角色数排序与排除筛选更快（新增索引）；数据集 ZIP/RAR 上传新增解压炸弹防护、错误不再泄漏原始异常、VLM API key 不走明文；一轮 UI 无障碍 / 版面 / i18n 优化。升级只在首次启动自动加几个 DB 索引，零手动操作。

Stability + security patch. Heavy API routes moved off the event loop so large libraries no longer freeze the server; faster tag-count / exclude filtering via new indexes; dataset ZIP/RAR upload bomb-guard, no raw exceptions leaked to clients, VLM key never sent over cleartext; a round of UI accessibility / layout / i18n polish. Upgrade just adds a few DB indexes on first launch.

---

## ⚡ Performance / 性能

- **Event loop no longer blocks under large libraries**: ~16 synchronous API routes (tags, sorting, colors, bulk-tag, analytics/stats) were moved off the event loop into FastAPI's threadpool, so one heavy SQL/CPU request no longer freezes the whole server. Behaviour and responses are unchanged.
  - **大图库下 event loop 不再卡死**：约 16 个同步 API 路由（tags / sorting / colors / 批量打标 / analytics）改到 FastAPI threadpool 执行，单一重型请求不再让整个 server 卡住。行为与回应不变。

- **Faster gallery sort / filter on large libraries**: tag-count / character-count sorts now use a single `LEFT JOIN ... GROUP BY` instead of per-row correlated subqueries; exclude-tag / exclude-rating filters use `NOT EXISTS` + a new `LOWER(tag)` index; new partial indexes on `aesthetic_score` / `color_saturation`. Query results are byte-for-byte unchanged (verified against the previous SQL across 60 sort × filter combinations).
  - **大图库排序 / 筛选更快**：tag / 角色数排序改用单次 `LEFT JOIN ... GROUP BY`；排除筛选改用 `NOT EXISTS` + 新增 `LOWER(tag)` 索引；新增 `aesthetic_score` / `color_saturation` 偏索引。查询结果与旧 SQL 完全一致（60 组排序 × 筛选组合验证过）。

- **Thumbnail cache**: one fewer filesystem `stat()` call per cached-thumbnail request.
  - **缩图快取**：每次命中快取少一次 `stat()` 系统呼叫。

---

## 🔒 Security / 安全

- **Decompression-bomb guard on dataset ZIP/RAR uploads**: archives are rejected before extraction if they exceed a generous entry-count / uncompressed-size cap. This is a malware guard, **not** a dataset-size limit — a real LoRA dataset never trips it. Complements the obfuscation-endpoint guard added in 3.2.3.
  - **数据集 ZIP/RAR 上传解压炸弹防护**：超过宽松的档案数 / 解压体积上限的压缩档会在解压前被拒。这是防恶意档，**不是**数据集大小限制——正常 LoRA 数据集不会触发。补齐 3.2.3 已加的混淆端点防护。

- **No raw exceptions leaked to clients**: the dataset / obfuscation / support-log endpoints now return a generic message and log the detail server-side. Status codes are unchanged.
  - **不再向客户端泄漏原始异常**：dataset / 混淆 / 支援日志端点改回传通用讯息，详细错误仅记录在 server 端；状态码不变。

- **VLM API key withheld over cleartext**: the captioning API key is no longer transmitted over a non-loopback `http://` endpoint or proxy. Local loopback servers (Ollama / llama.cpp / LM Studio on 127.0.0.1) are unaffected.
  - **VLM API key 不走明文**：captioning API key 不再经由非 loopback 的 `http://` 端点或代理传送；本地 loopback 服务（Ollama / llama.cpp / LM Studio）不受影响。

- Several previously-swallowed exceptions (censor mask draw, similarity model probe, dataset translator fallback, temp-file cleanup) are now logged instead of silently ignored.
  - 若干先前被吞掉的异常（censor 遮罩绘制、相似度模型探测、dataset 翻译 fallback、暂存档清理）现在会记录，不再静默忽略。

---

## ✨ UI / 介面

- **Modal accessibility**: the Auto-Detect and Rename dialogs now have proper `role="dialog"` / focus-trap / Esc handling, routed through the shared modal helpers.
  - **弹窗无障碍**：自动侦测与重命名弹窗补上 `role="dialog"` / focus-trap / Esc，统一走共用 modal helper。

- **Gallery aspect quick-toggle**: square / landscape / portrait filtering is now a one-click toggle in the gallery header (previously buried inside the filter modal).
  - **图库比例快速切换**：方形 / 横向 / 纵向筛选现在是图库标题列的一键切换（以前藏在筛选弹窗里）。

- **Layout / i18n polish**: unified button heights via a `--btn-h` token, no more single-CJK-character label wrapping, a cleaner Processing-Queue button grid, and the gallery sidebar summary labels + "Any" colors default are now translatable.
  - **版面 / i18n 优化**：用 `--btn-h` token 统一按钮高度、修掉单个中文字换行、整理处理队列按钮版面、图库侧栏摘要标签与「任意」颜色预设可翻译。

---

## ⚠️ Upgrading / 升级注意

- **Near-zero manual steps.** This release ships one additive DB migration that creates a few indexes (`aesthetic_score`, `color_saturation`, `LOWER(tag)`) on first launch — fast, no data is rewritten or moved. No behaviour changes. In-app updater users get it via Check Update; portable users extract the new archive as usual.
  - **几乎零操作。** 本版本带一个纯新增的 DB 迁移，首次启动会自动建几个索引（`aesthetic_score`、`color_saturation`、`LOWER(tag)`），很快、不重写也不搬移任何数据，无行为变更。更新器用户走「检查更新」即可；便携版用户照常解压新档。

---

## ✅ Validation / 验证

- Backend: 1675 passed / 6 skipped / 0 failed on Python 3.12.
- `ruff check backend`: clean. Compiled lock freshness + dependency security audit + frontend JS syntax: green.
- Playwright E2E: 121 passed (incl. modal a11y and responsive filter-modal flows).
- PERF-3 query rewrite verified result-identical to the previous SQL across 60 sort × filter combinations plus a real ~23k-image library.

---

## ⬇️ Which file should I download? / 我该下载哪一个？

**Windows → `sd-image-sorter-v3.2.4-windows-portable.zip`** — extract, run `run-portable.bat`.

**Linux (any modern distro, including Python 3.13 / 3.14 systems and Raspberry Pi 5) → `sd-image-sorter-v3.2.4-linux-portable-x86_64.tar.gz`** or `…-aarch64.tar.gz` — extract, `chmod +x run-portable.sh`, run `./run-portable.sh`.

**Linux source install** (advanced users with their own Python 3.12 / 3.13 toolchain) → `sd-image-sorter-v3.2.4-linux.tar.gz` — extract, run `./run.sh`.

**Do NOT download / 不要下载：**
- `sd-image-sorter-v3.2.4-app-patch.zip` — in-app updater payload only / 仅供更新器
- `sd-image-sorter-v3.2.4-release-manifest.json` — updater metadata / 更新器元数据

---

## Checksums

See `release-manifest.json` for the SHA-256 of each release asset.
