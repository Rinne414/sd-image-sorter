# SD Image Sorter v3.2.2 Release Notes

## Caption Editor — Unlimited Images + Virtual Scroll

The Caption Editor no longer has any artificial image cap. Select 100, 10000, or 100000+ images — the queue uses virtual scroll (only ~30 DOM nodes regardless of count) and fetches captions on-demand when you click an item.

- **Virtual scroll queue**: fixed-height items, absolute positioning, only visible items rendered
- **On-demand caption loading**: clicking a queue item fetches its rendered caption from the backend
- **Keyboard shortcuts**: `Escape` close, `Ctrl+Enter` next, `Ctrl+Shift+Enter` prev, `Arrow Up/Down` navigate
- **Queue count badge**: shows total with amber warning when >1000

## Per-Item Exclude on Filters

Filter chips now cycle: **include** (green) → **exclude** (red strikethrough) → **remove**. Excluded items filter OUT matching images.

Works on: tags, generators, ratings, checkpoints, LoRAs.

Applies everywhere: Gallery, Auto-Separate, Manual Sort, selection tokens.

## Auto-Separate Inline Filter Chip Editing

Each filter row in the left pane now has:
- **Active filters**: clickable row with '×' clear button (clears that dimension, debounced 350ms preview refresh)
- **Inactive filters**: '+' button that opens the filter modal for that field

## Other Fixes

- Filter modal stat grid: all 9 chips (including Color) fit on one row at any width
- Stale "up to 20 images" text removed from export preview helper
- Duplicate `TestExportSelectionData` test class renamed (Debt-25)

## Deep Bug Hunt 2026-05 — 18 backend bugs + 7 user-facing UX fixes

This release also includes the results of a multi-phase deep bug
hunt against the candidate v3.2.2 build, focused on data-integrity,
robustness, and user-friendliness. 18 backend bugs and 7 UX issues
were found and fixed across 18 commits, with 169 new regression
tests pinning the invariants.

### Critical / High severity

- **Caption sidecar `.txt` filenames now match images even with
  parens / apostrophes / commas / brackets**. Reported by user.
  ``my (lora char).png`` previously produced ``my _lora char_.txt``,
  silently breaking LoRA training because trainers pair captions
  with images by exact basename match. ``sanitize_filename``
  switched from a strict allow-list to a block-list (preserves all
  OS-legal characters); ``_allocate_output_path`` now derives the
  sidecar stem from the on-disk image path rather than the DB
  ``filename`` field. Same fix automatically resolves the parallel
  mangling in censor-edit's save-data endpoint.
- **Legacy DB upgrade fixed for pre-v3.2.0 schemas**. Anyone
  upgrading from a v3.1.x or earlier schema hit
  ``OperationalError: no such column: tagged_at`` during init
  because three timestamp columns were in ``FULL_SCHEMA`` but missing
  from the legacy backfill list ``LEGACY_IMAGE_COLUMNS``. Added.
- **`/api/library-health` no longer blocks the event loop**. The
  route was ``async def`` but ran synchronous SQL aggregations that
  take 4-12 seconds on a 71k-row library, blocking other requests.
  Now ``def`` (offloaded to thread pool) + 60 s TTL cache. Verified
  fix: 50/50 concurrent reads now succeed.
- **Concurrent `POST /api/scan` race condition**. Three simultaneous
  scan-start requests all returned 200 "Scan started" but only one
  actually ran. Fixed via a ``'starting'`` transition state set
  inside the lock.
- **VLM tag parser cleaned 401 garbage rows from real DBs**. Local
  Gemma / Qwen / GPT chain-of-thought leaked into danbooru tags
  (markdown headers, bullets, LaTeX, prose). Migration 012
  retroactively cleans existing pollution; new shape-based filter
  rejects them at parse time.
- **`/api/obfuscate/preview` no longer leaks Python repr**. Posting
  a non-image body returned 500 with
  ``cannot identify image file <_io.BytesIO object at 0x...>``
  exposing internal repr. Now returns 400.
- **`/api/images/{huge_id}` no longer 500s on int overflow**. Bound
  to ``1 ≤ id ≤ 2³¹-1``.
- **7 nav tab visual / a11y inconsistency fixed**. The Reader tab was
  the only tab without an icon (others had 🖼️ 🔳 📁 🔍 🎨 🧪);
  6 of 7 tabs lacked ``id`` attributes. Added 📖 for Reader plus
  ``id="nav-tab-{view}"`` on all 7 tabs.

### Medium severity

- **Mass-Tag-Editor modal now closes on Escape**. The modal opened
  via private ``classList.add('visible')``, bypassing the global
  modal helper. Now delegates to ``window.showModal/hideModal`` so
  Escape works, focus is trapped, focus is restored on close, and
  the modal has full role/aria-modal/aria-labelledby.
- **`/api/images?generator=nai` (singular) now filters correctly**.
  Previously dropped as an unknown query param and returned the
  entire library. Same fix for ``tag``, ``rating``, ``checkpoint``,
  ``lora`` — all five plural filter params now accept their natural
  singular form too.
- **Empty filter result no longer claims library is empty**. Filter
  → 0 results showed the "No images yet — import a folder!"
  onboarding card, scaring users with populated libraries. Added a
  second variant: "No images match your filters" + 🧹 "Clear all
  filters" CTA. Bilingual.
- **Reader save-as error messages improved**. Writing into
  protected directories returned 500 ``UnhandledException``
  (looked like a crash). Now ``PermissionError`` → 403 with OS
  reason, generic ``OSError`` → 400. Empty ``format=""`` rejected
  at validation.
- **`/api/tags/bulk/cleanup` `min_confidence` bounded to [0,1]**.
  Out-of-range values silently meant "remove all tags" or were
  no-ops.

### Low severity

- Artist diagnostics endpoint now reports correctly on legacy model
  paths.
- 424 residual stress-test pollution rows cleaned via migration 013.
- ToriiGate VRAM threshold retuned 48 GB → 16 GB.

### Test coverage

- **+169 backend regression tests** pinning every fix above.
- **1343 backend tests passing**, CI green on linux-full,
  macos-compat, windows-risk-areas across all 18 commits.

---

## 中文摘要

- **Caption 编辑器无上限**：虚拟滚动 + 按需加载，100K 张图也不卡
- **筛选排除**：标签/生成器/分级/模型/LoRA 支持排除（红色删除线）
- **自动分类 inline chip 编辑**：左栏每行可直接清除或添加筛选
- **键盘快捷键**：Esc 关闭、Ctrl+Enter 下一张、方向键导航
- **Filter 9 chips 一行**：颜色不再独占第二行


## New-User First-Run Experience Improvements

- **Windows browser timing**: no more `ERR_CONNECTION_REFUSED` on first launch — browser opens only after server is ready
- **macOS source-clone**: `./run.sh` works on macOS when cloned from source (only release tarballs reject Darwin)
- **Onboarding tour**: auto-starts on true first-run (empty gallery); restart via Guide modal "Tour" button
- **Model download timeout**: 4-minute cap prevents infinite "Working..." state
- **Model download cancel**: Cancel button appears during downloads
- **Feature Setup discoverability**: orange pulse animation on the wrench button until first click
- **Feature availability notice**: now mentions Color Analysis, LoRA Export, and VLM captioning
