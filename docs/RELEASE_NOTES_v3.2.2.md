# SD Image Sorter v3.2.2 Release Notes

**Released**: 2026-05-20

补完 v3.2.1 留下的后端漏洞和缺失前端：色彩字段终于会在图库 API 返回；缩略图临时文件路径唯一化；批量打标 N+1 SQL 合并；新增 Mass Tag Editor / VLM 代理与 Vertex AI 设置 / 色彩补算引导横幅。

Finishes the gaps left in v3.2.1: color columns now ship through `/api/images`; thumbnail cache uses unique temp paths under concurrent writes; tags-bulk operations batch-load instead of N+1; new Mass Tag Editor + VLM proxy/Vertex/output-format controls + color analysis backfill banner.

---

## TL;DR

- **Mass Tag Editor (frontend)** — the 4 bulk-tag endpoints v3.2.1 shipped finally get a UI: nav button, modal with scope picker, tabbed operations, mandatory dry-run, and a 2-second delayed Apply for >1,000-image scope.
- **Color analysis backfill UX (frontend)** — banner + nav chip + progress toast so users know to backfill when picking a color-based sort.
- **VLM Settings — proxy / Vertex AI / output-format (frontend)** — the three v3.2.1 backend features without UI now have surfaced controls in the existing VLM Settings modal.
- **Color columns reach the API** — `/api/images` now SELECTs `dominant_colors`, `avg_brightness`, `color_temperature`, `color_saturation`, `brightness_distribution` (and the detail view adds `brightness_histogram` + `brightness_skew`). Previously the columns existed in SQLite but were never returned, so color sort/filter worked but display didn't.
- **Thumbnail temp-path collision fixed** — PID + TID + nanosecond + counter + 8 hex chars of OS randomness in the `.tmp` filename.
- **Tags-bulk batch reads** — `db.get_image_tags_map(ids)` once before the loop, ~500x fewer SELECTs at the 500k-image upper bound.
- **asyncio modernization** — `get_event_loop()` to `create_task()` / `get_running_loop()` in `routers/colors.py` and `routers/vlm.py`.

---

## What's New

### 1. Mass Tag Editor (frontend)

The new nav-bar button opens a full modal that fronts the 4 backend bulk-tag operations v3.2.1 shipped without UI.

**Layout**:
- **Scope picker** at the top — "Current selection" vs "Current filter"
- **Tab strip** — Find & Replace / Bulk Add / Bulk Remove / Cleanup
- **Operation panel** changes per tab, with the parameters each endpoint needs
- **Mandatory Dry Run** — every Apply is preceded by a dry-run preview that shows affected-image count + up to 5 sample before/after diffs
- **Result panel** — collapsible summary with the diff sample

**Safety**:
- When the chosen scope touches **>1,000 images**, the Apply button opens a separate confirm dialog with a **2-second countdown** before the real Apply button becomes clickable. Below 1,000 images, Apply commits immediately.
- Filter-scope resolution uses the existing `/api/images/selection-token` + `selection-chunk` flow (5000-item chunks) so even a 70k-image filter loads in ~3 s. This bypasses the 1000-image cap on `/api/images?limit=`.

**i18n**: ~20 new keys in both `en` and `zh-CN`, fully translated.

### 2. Color analysis backfill UX (frontend)

The first time a user picks a color-based sort (Brightness / Saturation / Brightness distribution) AND their library still has images with NULL color data, a banner appears above the gallery offering a one-click "Analyze N images" button. Live count comes from `GET /api/colors/missing-count`.

While analysis runs, a `[N%]` chip lives in the nav bar. Clicking it opens a bottom-right corner toast with:
- Live progress bar
- Current filename being analyzed
- Pause / Run-hidden actions

Banner dismissal is recorded in `localStorage` and respected for 24 hours.

### 3. VLM Settings — proxy / Vertex / output format (frontend)

The existing VLM Settings modal now exposes the three feature groups v3.2.1 shipped backend-only:

- **Output Format** — segmented control at the top: NL caption / Danbooru tags / Both
- **Network Proxy** — collapsed `<details>` section with HTTP / HTTPS / SOCKS fields. Summary line shows an "active" badge when non-default values are set.
- **Vertex AI** — separate collapsed `<details>` with project / region / service-account JSON. **Auto-appears only when provider is Gemini**. Same "active" badge pattern.

No new dependencies; layout reuses existing CSS design tokens.

---

## What's Fixed

### 4. Color columns reach `/api/images`

Migration 010 (v3.2.1) added 7 color columns to the `images` table, but earlier code only listed them in the analyzer's SELECT — the gallery and detail-view queries skipped them entirely. After successful color backfill, the frontend could sort/filter on color but had no values to display in the gallery card or detail panel.

Fix lives in `_IMAGE_COLUMNS_*_FIELDS` constants in `backend/database.py`:
- Gallery / list views now SELECT `dominant_colors`, `avg_brightness`, `color_temperature`, `color_saturation`, `brightness_distribution` (5 user-facing columns).
- Detail view additionally returns `brightness_histogram` + `brightness_skew` (the heavier columns needed for the histogram component).

### 5. Thumbnail cache temp-path collision

Two writers in the same process + thread that both finished thumbnailing in the same `time.time_ns()` window (Windows clock resolution can be coarser than nanoseconds) could land on the exact same `.tmp` path and clobber each other's atomic rename. Path now combines:

```
{cache_name}.{pid}.{tid}.{ns}.{process_local_counter}.{8_hex_chars}.tmp
```

Verified by the previously-failing regression test `test_thumbnail_cache_temp_paths_are_unique_for_same_cache_key`.

### 6. Tags-bulk N+1 SQL

The 4 bulk-tag endpoints (`/find-replace`, `/add`, `/remove`, `/cleanup`) used to call `db.get_image_tags(id)` per image. At Pydantic's 500,000-image upper bound that meant 500k individual SQL round-trips. Now a single up-front `db.get_image_tags_map(image_ids)` (batched 500 IDs per query) populates the lookup map. Same write path; same dry-run semantics; ~500x fewer SELECTs on the read side.

### 7. asyncio modernization

`routers/colors.py` and `routers/vlm.py`:
- `asyncio.get_event_loop().create_task(...)` to `asyncio.create_task(...)`
- `asyncio.get_event_loop()` to `asyncio.get_running_loop()`

The old API was deprecated in Python 3.10 and now raises `RuntimeError` in 3.12 when no loop is running. All call sites are inside async handlers, so the modern API is the correct equivalent. `test_vlm_batch_progress_and_debug_chat` updated to patch the new symbol.

### 8. `count_images_missing_color_data()` helper

`GET /api/colors/missing-count` previously fetched the full ID list of unanalyzed images and used `len()` on the result — fine at 100 images, painful at 70k. Replaced with a `SELECT COUNT(*)` helper that's constant memory regardless of library size.

---

## Migration Notes

No new schema; no new dependencies; no breaking API changes. v3.2.2 is a drop-in upgrade over v3.2.1.

If you previously ran `/api/colors/analyze` against your library:
- Color values now actually appear in `/api/images` responses (they were always stored, just not returned). The frontend gallery cards and detail panel surface them automatically.

If you have NOT run color analysis yet:
- Picking a color-based sort surfaces the new backfill banner. One click starts the analyzer.

---

## Known Limitations

- Mass Tag Editor scope picker currently supports "current selection" and "current filter" only. Operating on the entire library requires clearing the filter first.
- Color backfill banner only triggers when a color-based sort is selected; it doesn't proactively prompt on every gallery open.
- Vertex AI section in VLM Settings still requires the user to know they need `google-auth` installed (the error is friendly, but the install step is manual).

---

## Validation

- 1,112 backend pytest tests pass.
- Frontend Playwright sweep run against 1920 / 1366 / 1024 / 800 / 768 / 600 / 480 viewports for the Mass Tag Editor, color backfill banner, and VLM Settings additions.
- Build verified via `scripts/build_release_packages.py --version 3.2.2`.
