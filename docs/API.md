# SD Image Sorter API Documentation

**Version:** 3.6.1
**Base URL:** `http://127.0.0.1:8487` (default; configurable via `SD_IMAGE_SORTER_PORT`)
**Interactive Docs:** `http://127.0.0.1:8487/docs` (Swagger UI, same port as runtime)

---

## Overview

SD Image Sorter provides a local REST API for managing, tagging, sorting, censoring, and exploring Stable Diffusion generated images.

### Key Features

- **Image Management**: Scan folders, retrieve images with filters, serve files
- **AI Tagging**: WD14 tagger for automatic image tagging
- **Sorting**: Batch move operations and manual keyboard sorting sessions
- **Censoring**: NSFW detection with multiple backends (privacy YOLO, NudeNet, optional SAM3 refinement)
- **Similarity Search**: CLIP-based image similarity and duplicate detection
- **Prompt Generation**: Prompt builder with exclusion rules and presets
- **Artist Identification**: Kaloscope artist/style classification

---

## Authentication

**None required.** The app is intended for local-only usage and rejects non-local requests.

---

## Common Patterns

### Cursor Pagination

`GET /api/images` uses cursor pagination.

```bash
GET /api/images?limit=100
GET /api/images?limit=100&cursor=eyJpZCI6MTIzNCwic29ydF92YWx1ZSI6IjIwMjQtMDEtMTVUMTA6MzA6MDBaIiwidiI6MX0
```

Response shape:

```json
{
  "images": [],
  "next_cursor": "eyJpZCI6MTIzNCwic29ydF92YWx1ZSI6IjIwMjQtMDEtMTVUMTA6MzA6MDBaIiwidiI6MX0",
  "has_more": true,
  "total": 500
}
```

Notes:
- Treat `cursor` / `next_cursor` as opaque tokens. Pass `next_cursor` back unchanged.
- Legacy integer cursors are still accepted for backward compatibility, but clients should not generate or parse cursors themselves.
- Cursor pagination is intended for `sort_by=newest` and `sort_by=oldest`
- For `sort_by=random`, do not use a cursor

### Comma-Separated Filters

Many filters accept comma-separated values:

```bash
GET /api/images?tags=1girl,solo,long_hair
GET /api/images?generators=comfyui,nai
```

Notes:
- tag filters use **exact** AND matching
- generator / rating / checkpoint filters use OR matching

### Background Tasks

Long-running operations run in the background:

```bash
POST /api/scan
GET /api/scan/progress
POST /api/tag
GET /api/tag/progress
POST /api/similarity/embed
GET /api/similarity/progress
```

### Error Responses

Most errors use structured JSON:

```json
{
  "error": "Invalid request parameters",
  "type": "ValidationError"
}
```

---

## Rate Limiting

A lightweight in-memory rate limit exists, but the default production path is
loopback-only (`RATE_LIMIT_APPLY_TO_LOOPBACK=False`), so localhost clients are
not limited unless that flag is enabled. Static files and image-serving
endpoints are exempt.

---

## Request Guard (`/api/*`)

Besides the loopback client-IP check, every `/api` request must look like it
comes from this app's own page or a local non-browser client; otherwise it is
answered `403 {"error": "...", "type": "Forbidden"}`:

| Header | Rule |
|--------|------|
| `Host` | Exactly `host[:port]`: a loopback name (`127.0.0.1`, `localhost`, `[::1]`, any `127.x`) on the port the socket is bound to (`request.scope["server"]`, which no client can set; `SD_IMAGE_SORTER_PORT` only when the server did not fill it). A DNS-rebound hostname, another port, a LAN address, or a value with userinfo, a path, a query or a fragment fails |
| `Origin` | Absent (non-browser clients, same-origin GET) or exactly `http(s)://<loopback host>[:port]` on any port, so another local web app may call the API. Any extra (userinfo, path, query, fragment, whitespace, a second value) or a non-loopback host fails |
| `Sec-Fetch-Site` | `cross-site` passes only together with such a loopback `Origin`. That is how another local web app looks to the browser (a page on `localhost:3000` calling `127.0.0.1:8487` is cross-site, and its fetch carries its loopback Origin). A cross-site request without an Origin, which is what a link, a GET form, `window.open`, `location=` or a hidden `<iframe>` from any site sends, is refused. `same-origin`, `same-site`, `none` and absent pass |

Pages, `/static`, `/docs` and `/openapi.json` are not guarded. With
`SD_SORTER_TESTING=1` the test suite's `testserver` host and a port-less
loopback host are accepted. Refusals are logged once per reason per
`REJECTION_LOG_INTERVAL_SECONDS` (60 s); the rest are counted and reported
with the next line.

---

## Endpoints

### Images

#### GET /api/images

Retrieve images with filters and cursor pagination.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `generators` | string | - | Comma-separated: `comfyui`, `nai`, `webui`, `forge`, `unknown` |
| `tags` | string | - | Comma-separated exact tags, AND logic |
| `ratings` | string | - | Comma-separated: `general`, `sensitive`, `questionable`, `explicit` |
| `checkpoints` | string | - | Comma-separated checkpoint names |
| `loras` | string | - | Comma-separated LoRA names |
| `search` | string | - | Free-text prompt / filename search |
| `artist` | string | - | Artist name filter |
| `sort_by` | string | `newest` | `newest`, `oldest`, `name_asc`, `name_desc`, `generator`, `generator_desc`, `prompt_length`, `prompt_length_asc`, `tag_count`, `tag_count_asc`, `rating`, `rating_desc`, `character_count`, `character_count_asc`, `random`, `file_size`, `file_size_asc`, `aesthetic`, `aesthetic_asc`, `aesthetic_waifu`, `aesthetic_waifu_asc`, `aesthetic_anime`, `aesthetic_anime_asc` (unscored images last both ways), `brightness`, `brightness_asc`, `saturation`, `saturation_asc`, `brightness_skew`, `brightness_skew_asc`, `user_rating`, `user_rating_asc` |
| `limit` | int | 100 | Max images per page |
| `cursor` | string | - | Opaque cursor token from the previous page; pass it back unchanged |
| `min_width` | int | - | Minimum width in pixels |
| `max_width` | int | - | Maximum width in pixels |
| `min_height` | int | - | Minimum height in pixels |
| `max_height` | int | - | Maximum height in pixels |
| `prompts` | string | - | Comma-separated prompt terms (AND logic) |
| `prompt_match_mode` | string | `exact` | `exact` keeps normalized prompt-token matching; `contains` matches substring text in the normalized full prompt, including variants like `takamatsu_tomori(...)` |
| `aspect_ratio` | string | - | `square`, `landscape`, `portrait` |
| `brightness_min` | float | - | Minimum average brightness, `0..255`; requires color analysis data |
| `brightness_max` | float | - | Maximum average brightness, `0..255`; requires color analysis data |
| `color_temperature` | string | - | `warm`, `cool`, `neutral`; requires color analysis data |
| `color_hues` | string | - | Comma-separated dominant hues (ANY match): `red`, `orange`, `yellow`, `green`, `cyan`, `blue`, `purple`, `pink`, `brown`, `white`, `black`, `gray`; requires color analysis data (v3.5.0) |
| `exclude_color_hues` | string | - | Comma-separated dominant hues to exclude; unanalyzed images are kept (v3.5.0) |
| `brightness_distribution` | string | - | `left_heavy`, `right_heavy`, `middle_heavy`, `edge_heavy`, `balanced`; requires color analysis data |
| `folder` | string | - | v3.3.2: absolute directory path; restricts results to that folder **and all subfolders** (recursive, case-insensitive). Forward- or back-slashes accepted. Composes with every other filter. |
| `has_metadata` | bool | - | v3.3.2: tri-state "has SD generation parameters" filter. Omit for all images; `true` keeps only images with a known generator **or** a non-empty prompt; `false` keeps only images with neither (e.g. plain PNGs). Distinct from `metadata_status` (parse-pipeline state). Composes with every other filter. |
| `no_caption` | bool | - | v3.5.0: `true` keeps only images with no AI caption and no NL caption (both empty/NULL) — the "still needs captioning" workflow chip. |
| `aesthetic_unscored` | bool | - | v3.5.0: `true` keeps only images with no aesthetic score yet (`aesthetic_score IS NULL`); takes precedence over `min_aesthetic`/`max_aesthetic` when set. Backs the filter modal's 未评分 tier. |
| `min_saturation` | float | - | v3.5.0: minimum average saturation, `0..255`; requires color analysis data |
| `max_saturation` | float | - | v3.5.0: maximum average saturation, `0..255`; requires color analysis data |
| `seed` | int | - | v3.5.0: exact generation seed match (extracted from metadata). Powers the toolbar `seed:` search key. |
| `date_from` | string | - | v3.5.x: inclusive `YYYY-MM-DD` lower bound on the file's first-seen time (`COALESCE(library_order_time, created_at)` — same key the newest/oldest sort uses). Powers the `date:` search key + filter-modal date range. NOT a generation timestamp. |
| `date_to` | string | - | v3.5.x: inclusive `YYYY-MM-DD` upper bound on the same file-time expression (SQL half-open on the next day, so the whole end day matches). |

Example response:

```json
{
  "images": [
    {
      "id": 1,
      "filename": "image_001.png",
      "path": "/path/to/image_001.png",
      "generator": "comfyui",
      "prompt": "1girl, solo, masterpiece",
      "negative_prompt": "lowres, bad anatomy",
      "checkpoint": "sd_xl_base_1.0.safetensors",
      "loras": ["detail_tweaker", "add_detail"],
      "width": 1024,
      "height": 1536,
      "file_size": 2048576,
      "tagged_at": "2024-01-15T11:00:00Z"
    }
  ],
  "next_cursor": "eyJpZCI6MSwic29ydF92YWx1ZSI6IjIwMjQtMDEtMTVUMTA6MzA6MDBaIiwidiI6MX0",
  "has_more": true,
  "total": 500
}
```

#### GET /api/images/count
Return the exact number of images matching the same filter parameters as `GET /api/images` (v3.5.0, Aurora Phase 3). Powers the filter modal's live "应用筛选 · 预计 N 张" Apply preview.

Accepts every filter parameter from the table above (plus the include/exclude families); sort and pagination parameters are irrelevant to a count and are not accepted. Unlike the `total` field on `GET /api/images` — which can return a `-1` skip sentinel on the cursor path for very large libraries — this endpoint always runs the count and returns a real total.

Example response:

```json
{ "total": 4213 }
```

#### GET /api/folders
List the distinct directories that contain indexed images, forward-slash normalized and sorted (v3.3.2 Library Navigation). The frontend builds a collapsible folder tree by splitting each path on `/`; clicking a node scopes the gallery via the `folder` parameter documented under `GET /api/images` (recursive subtree). Recomputed per call from the live index, so it always reflects the current library.

Example response:

```json
{
  "folders": [
    "L:/Pictures/AAA Reference/AAAwith prompt",
    "L:/Pictures/AAA Reference/AAAwith prompt/NSFW",
    "L:/Pictures/AAA Reference/AAAwith prompt/SFW"
  ]
}
```

#### GET /api/library-roots
List registered library roots — folders the user added as image sources — each with a live recursive indexed-image count (v3.3.2 Library Navigation). Roots are auto-registered when a folder is scanned and persist independently of the images currently under them, providing the target list for multi-root management and idle auto-refresh.

Example response:

```json
{
  "roots": [
    {
      "id": 1,
      "path": "L:/Pictures/AAA Reference",
      "label": null,
      "enabled": 1,
      "added_at": "2026-06-06T12:00:00",
      "last_scanned_at": "2026-06-06T12:05:00",
      "image_count": 43483
    }
  ]
}
```

#### DELETE /api/library-roots/{root_id}
Unregister a library root (v3.3.2 Library Navigation). The folder's already-indexed images stay in the gallery — only the source registration is removed. Returns `404` if the root id is unknown.

#### POST /api/library-roots/{root_id}/rescan
Quick-import re-scan of a registered root to pick up new or changed files (v3.3.2 Library Navigation). Runs in the background; poll `GET /api/scan/progress`. Returns `404` for an unknown root and `409` if a scan is already running.

#### POST /api/library/auto-refresh
Idle-triggered quick-import re-scan of the stalest enabled root (v3.3.2 Library Navigation), so newly added files surface without a manual scan. Returns `{"status": "started", "root": ...}` when it kicks off, `{"status": "skipped", ...}` while a scan is running, or `{"status": "idle", ...}` when no roots are enabled. Never runs AI tagging (GPU safety).

#### GET /api/images/{image_id}
Get one image with its tags.


#### PATCH /api/images/{image_id}/caption

Manually edit the composed display caption (`ai_caption`) and/or the pure
natural-language caption (`nl_caption`) for one image.

Explicit-clear semantics: a field is written only when its key is present in
the request body, so sending an empty-string `nl_caption` clears NL while
leaving `ai_caption` untouched. Returns the stored captions after the write.

Request body:

```json
{
  "ai_caption": "1girl, smiling, park",
  "nl_caption": "A girl smiling in a park."
}
```

Response:

```json
{
  "id": 42,
  "ai_caption": "1girl, smiling, park",
  "nl_caption": "A girl smiling in a park."
}
```
#### GET /api/image-file/{image_id}
Serve the original image file.

#### GET /api/image-thumbnail/{image_id}
Serve a thumbnail for the image.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `size` | int | 256 | Max dimension in pixels (1-4096) |

#### GET /api/image-preview-by-path
Serve a WebP thumbnail for an image file addressed by absolute path (v3.5.0, Roadmap-C missing-file repair). Used by the repair-review UI to preview a found-but-unlinked candidate file that the id-based thumbnail endpoint cannot reach.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `path` | string | required | Absolute path to the image file |
| `size` | int | 256 | Max dimension in pixels (1-1024) |

The path is validated before any read: directory traversal (`..`) is rejected, the file must exist, and it must be an allowed image type. Returns `404` for an invalid, missing, or non-image path.

#### GET /api/thumbnail-cache/stats
Get thumbnail cache statistics, including `max_size_mb`, `max_size_bytes`, and whether the persistent thumbnail cache limit is enabled.

#### POST /api/thumbnail-cache/clear
Clear all cached thumbnails.

#### POST /api/thumbnail-cache/cleanup
Remove old cached thumbnails, then enforce the configured thumbnail cache size limit.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `max_age_days` | int | 30 | Maximum age in days (1-365) |

#### POST /api/images/{image_id}/reparse
Re-parse metadata for one image.

#### POST /api/images/{image_id}/rating
Set an image's explicit user star rating (v3.3.2). Body `{ "stars": 0-5 }` where `0` clears the rating (unrated). This Eagle-style manual rating is stored on `images.user_rating` and is independent of the AI WD14 rating tags. The gallery can then filter with `min_user_rating` and sort by `user_rating` / `user_rating_asc`. Returns `404` for an unknown image id and `400`/`422` for an out-of-range value.

#### POST /api/images/selection-ids
Resolve the full ordered ID set for the current filtered result set.

This is the compatibility endpoint for callers that need one complete response. It uses the same filter payload as the gallery, including `tagMode` (`and`/`or`), `minUserRating`, color fields, `folder`, `hasMetadata`, `collectionId`, and all include/exclude filters (`excludeTags` / `excludeGenerators` / `excludeRatings` / `excludeCheckpoints` / `excludeLoras` / `excludePrompts` / `excludeColors`). Responses are capped at 100,000 IDs; larger selections return `413` and must use the token/chunk pair below unless `sortBy` is `random`.

#### POST /api/images/count
Count the images matching a gallery filter payload without returning rows or IDs.

Request body is the same filter payload as `selection-ids` (all include/exclude filters, `tagMode`, `folder`, `collectionId`, `hasMetadata`, color fields, and the Aurora Phase 3 fields such as `noCaption`). Powers the gallery Smart Folders sidebar: pinned filter presets poll this for live counts. Response: `{ "count": 123, "exact": true }`. `exact=false` mirrors the selection-token `exact_total` semantics — prompt terms in `exact` match mode are post-filtered after SQL, so the count can over-report for those payloads.

#### POST /api/images/selection-token
Create a stateless token for chunked filtered-selection ID retrieval.

Request body is the same filter payload as `selection-ids`, including `tagMode`, `minUserRating`, `folder`, `hasMetadata`, `collectionId`, exclude filters, and color fields (`brightnessMin`, `brightnessMax`, `colorTemperature`, `brightnessDistribution`, `excludeColors`), plus optional `chunkSize` (`1..10000`, default `2000`) and `excludedImageIds` (`0..10000`) for inverted filtered-selection scopes.

Response:

```json
{
  "selection_token": "opaque-token",
  "total_estimate": 12000,
  "exact_total": true,
  "chunk_size": 2000
}
```

Notes:
- `sortBy=random` is rejected because stateless offset chunks would re-randomize and duplicate/skip images.
- `excludedImageIds` is intended for small explicit exclusions after an inverted filtered selection; it must not become a giant client-side ID payload.
- `exact_total=false` means prompt post-filtering may still remove SQL false positives.
- Filter payloads accept `promptMatchMode` (`exact` or `contains`, default `exact`). `contains` is useful for free-form prompt variants such as `takamatsu_tomori(bang dream!)`.
- The token is not a result-set snapshot; clients should fetch chunks immediately in one UI operation.

#### GET /api/images/selection-chunk
Fetch one ordered ID chunk from a token returned by `selection-token`.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `selection_token` | string | required | Opaque token returned by `POST /api/images/selection-token` |
| `offset` | int | 0 | Exact-match offset into the filtered result set |
| `limit` | int | 2000 | Max IDs to return (`1..10000`) |

Response:

```json
{
  "image_ids": [11, 22],
  "offset": 0,
  "limit": 2000,
  "next_offset": 2,
  "has_more": true
}
```

#### POST /api/images/export-data
Return prompt/tags export payload for explicit image IDs or one selection-token page.

Legacy request:

```json
{
  "image_ids": [1, 2, 3]
}
```

Token-page request for large filtered selections:

```json
{
  "selection_token": "opaque-token",
  "offset": 0,
  "limit": 2000
}
```

Rules:
- Provide either `image_ids` or `selection_token`, not both.
- `limit` is capped at `1..10000`.
- Token mode is an immediate stateless filter contract; it is not a durable snapshot.
- Response includes `images`, `missing_ids`, `count`, `total`, `offset`, `limit`, `next_offset`, `has_more`, `source`, and `exact_total`.
- Each image row includes SD/pro export fields where available: `prompt`, `negative_prompt`, `ai_caption`, `generation_params`, `tags`, `checkpoint`, dimensions, and score metadata.

#### POST /api/images/delete-selected
Delete selected image files with per-item partial-failure reporting. This is destructive and requires `confirm_delete_files: true`.

Request body accepts either explicit IDs or a filtered-selection token:

```json
{
  "image_ids": [1, 2, 3],
  "confirm_delete_files": true
}
```

```json
{
  "selection_token": "opaque-token",
  "confirm_delete_files": true
}
```

Rules:
- Provide either `image_ids` or `selection_token`, not both.
- Token mode snapshots matching IDs server-side into a temporary bounded stream before mutating rows/files, so deletion does not skip records as the filtered set shrinks.
- Response includes `deleted`, `missing_ids`, `failed`, `errors`, and `permanent_delete: true`.

#### POST /api/images/delete-selected/start
Run the same deletion as a background job so a large selection does not freeze the browser. Requires `confirm_delete_files: true` and accepts the same `image_ids` / `selection_token` body; matching IDs are snapshotted server-side before any mutation. Response includes `status` and `message`.

#### GET /api/images/delete-selected/progress
Return the current delete-job progress. Fields: `status` (`idle`/`running`/`done`/`cancelled`/`error`), `step`, `current`, `total`, `deleted`, `failed`, `errors`, `recent_errors`, `current_item`, `message`, `operation: "delete"`, `started_at`, `updated_at`.

#### POST /api/images/delete-selected/cancel
Request cancellation of the running delete job. The task stops between items and returns the latest progress snapshot.

#### POST /api/images/delete-selected/reset
Reset a stuck or finished delete job back to `idle`.

#### POST /api/images/remove-selected
Remove selected image rows from the gallery index without deleting the backing files from disk.

Request body accepts either explicit IDs or a filtered-selection token:

```json
{
  "image_ids": [1, 2, 3]
}
```

```json
{
  "selection_token": "opaque-token"
}
```

Rules:
- Provide either `image_ids` or `selection_token`, not both.
- Token mode snapshots matching IDs server-side into a temporary bounded stream before removing rows, so the operation does not depend on a browser-materialized 200k-ID array.
- Response includes `removed`, `missing_ids`, and `permanent_delete: false`. Re-scanning the source folder can add the files back.

#### POST /api/images/remove-selected/start
Run the same index removal as a background job for large selections. Accepts the same `image_ids` / `selection_token` body; matching IDs are snapshotted server-side before rows are removed. Files on disk are never touched. Response includes `status` and `message`.

#### GET /api/images/remove-selected/progress
Return the current remove-job progress. Fields: `status` (`idle`/`running`/`done`/`cancelled`/`error`), `step`, `current`, `total`, `removed`, `missing_ids`, `current_item`, `message`, `operation: "remove"`, `permanent_delete: false`, `started_at`, `updated_at`.

#### POST /api/images/remove-selected/cancel
Request cancellation of the running remove job. The task stops between items and returns the latest progress snapshot.

#### POST /api/images/remove-selected/reset
Reset a stuck or finished remove job back to `idle`.

### Bulk background jobs (Debt-22)

Token-scoped Gallery bulk operations (delete-to-trash, remove-from-gallery, same-name sidecar export) can run as durable background jobs with progress polling and mid-run cancellation. Opt in on the existing endpoints:

- `POST /api/images/delete-selected` with `background: true` (still requires `confirm_delete_files: true`)
- `POST /api/images/remove-selected` with `background: true`
- `POST /api/tags/export-batch` with `background: true`

Each returns a job envelope: `id` (durable job id), `kind` (`delete_files` / `remove_from_gallery` / `export_sidecars`), `status`, `total`, `processed`, `operation`. The synchronous behavior (no `background` flag) is unchanged. Matching IDs are snapshotted server-side before any mutation, so rows changed mid-job cannot expand the job's scope.

#### GET /api/bulk-jobs
List durable bulk background jobs, newest first. Query param `active_only=true` hides finished (`done`/`error`/`cancelled`) jobs. Response: `{ "jobs": [ ... ] }`. Each job carries an English `message` plus a stable `message_key` (empty unless the job sets one; sidecar export sets `exporting`).

#### GET /api/bulk-jobs/{job_id}
Return one bulk job by id. Fields: `id`/`job_id`, `kind`, `status` (`queued`/`running`/`done`/`error`/`cancelled`), `total`, `processed`, `error_count`, `error_samples` (bounded to 20), `message`, `result` (operation summary, populated on completion), `created_at`, `started_at`, `finished_at`. Returns 404 if the id is unknown.

#### POST /api/bulk-jobs/{job_id}/cancel
Request cooperative cancellation of a running bulk job. The worker stops at the next chunk boundary and settles as `cancelled` with partial progress. Returns the latest job snapshot, or 404 if the id is unknown.

#### POST /api/tags/export-batch
Write same-name sidecar `.txt` exports for explicit IDs or a filtered-selection token.

Request body accepts either explicit IDs or a filtered-selection token plus the export options:

```json
{
  "image_ids": [1, 2, 3],
  "output_mode": "beside_image",
  "output_folder": "",
  "blacklist": [],
  "prefix": "",
  "content_mode": "tags",
  "overwrite_policy": "unique"
}
```

```json
{
  "selection_token": "opaque-token",
  "output_mode": "folder",
  "output_folder": "L:/exports/tags",
  "blacklist": [],
  "prefix": "",
  "content_mode": "tags",
  "overwrite_policy": "unique"
}
```

Rules:
- Provide either `image_ids` or `selection_token`, not both.
- `output_mode` selects where the sidecars land:
  - `"folder"` — write every sidecar into the supplied `output_folder`. The folder is created if missing. Use when collecting captions for a single training set.
  - `"beside_image"` — write each sidecar into the same directory as its source image. `output_folder` is ignored. Use when the library spans multiple subfolders or feeds a per-folder training tool that expects `foo.png` + `foo.txt` to sit together. Rows whose source folder no longer exists are reported in `error_messages` and other rows still succeed.
- The default for `output_mode` is `"folder"` for backwards compatibility with existing API clients.
- Response includes the chosen `output_mode` so the UI can confirm which path was taken.
- Backend reads images and tags in chunks while writing files; clients should prefer token mode for large filtered exports.

#### POST /api/images/reconnect-missing/start
Start a background search for gallery records whose original files no longer exist. The search scans `search_folder`, optionally recursively, and reconnects matching records to found files by updating the library path only. It does not move, copy, delete, or edit image files.

Request body:

```json
{
  "search_folder": "L:/Images/moved-folder",
  "recursive": true,
  "verify_uncertain": true
}
```

Response includes `status` and `message`.

#### GET /api/images/reconnect-missing/progress
Return the current missing-file reconnect progress.

Response includes `status`, `step`, `current`, `processed`, `total`, `total_final`, `checked_files`, `missing_total`, `matched`, `ambiguous`, `conflicts`, `skipped`, `errors`, `message`, `current_item`, and optional `result` when finished.

#### POST /api/images/reconnect-missing/cancel
Request cancellation of the current missing-file reconnect search. The task stops between files and returns the latest progress snapshot.

#### GET /api/images/repair-candidates
List ambiguous missing-file matches awaiting review (v3.5.0, Roadmap-C). During a reconnect run, a discovered file that matches **several** missing library rows by name+size is never auto-linked — the group is persisted as a *pending* review (migration 021, `reconnect_reviews`) and the rows keep their old paths. Each new run replaces the previous run's pending snapshot; resolved history is pruned to the newest 500 rows.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `limit` | int | 50 | Page size (1-500) |
| `offset` | int | 0 | Pagination offset |
| `status` | string | `pending` | `pending`, `resolved`, `conflict`, or `all` |

Each item carries the review row plus candidates enriched from the live images table (`image_id`, current `path`, `file_size`, `source_mtime_ns`, `still_missing`, `pixels_match`) and `found_exists` for the discovered file. Candidate ids deleted since the run are omitted.

`pixels_match` compares the candidate's stored pixel fingerprint with the found file: `true` / `false`, or `null` when the candidate has no fingerprint, the found file is gone or unreadable, **or `limit` is above 50**. Each found file is hashed at most once per listed review and the digest is cached in-process per `(path, mtime, size)`, so a page costs at most `limit` full-image reads the first time and nothing afterwards; the endpoint runs that work off the event loop.

Example response:

```json
{
  "total": 1,
  "items": [
    {
      "review_id": 12,
      "filename": "same.png",
      "found_path": "D:/new/same.png",
      "found_exists": true,
      "candidate_count": 2,
      "run_started_at": 1717430000.0,
      "status": "pending",
      "resolution": null,
      "candidates": [
        { "image_id": 3, "path": "D:/old/same.png", "file_size": 2048, "source_mtime_ns": 1700000000000000000, "still_missing": true, "pixels_match": true }
      ]
    }
  ]
}
```

#### POST /api/images/repair-confirm
Resolve one pending ambiguous-match review (v3.5.0, Roadmap-C). Body: `{ "review_id": N, "action": "pick" | "merge" | "skip", "chosen_image_id": N }` (`chosen_image_id` required for pick/merge, ignored for skip).

- **pick** — relink `chosen_image_id` to the review's found file; other candidates untouched.
- **merge** — relink `chosen_image_id` **and delete** the other still-existing candidate rows (returned as `deleted_ids`).
- **skip** — record the decision; touch no image rows.

Returns `404` for an unknown review and `409` when a reconnect run is active, the review is already resolved, the found file no longer exists, or the found path is already indexed as a different row (the review is then marked `conflict` — a row is never silently duplicated).

#### GET /api/images/missing-summary
Group every unreadable row by the folder it claims to live in, and report whether that place is reachable right now. This completes the missing-file flow: reconnect handles files that **moved**, and this handles files that are **gone**.

`reason` per group:

| Reason | Meaning | `clearable` |
|--------|---------|-------------|
| `file_deleted` | The folder is readable, still holds other entries, and the file is not among them | `true` |
| `folder_deleted` | The folder is gone, but a readable ancestor still holds content — so the volume is mounted and the folder really was removed | `true` |
| `location_unreachable` | We cannot confirm the place is really there | `false` |

The bias is deliberate and asymmetric: refusing to clear something that is genuinely gone leaves a banner the user can resolve by reconnecting and re-scanning, while clearing something merely unreachable destroys tags and ratings for files that still exist. So `location_unreachable` also covers every ambiguous case:

- nothing above the file is readable — a disconnected drive or an offline share;
- the folder exists but is not readable (permission denied) — the files are probably fine and we simply cannot look;
- the folder is readable but **completely empty**, which is indistinguishable from an unmounted mount point (on Linux a disconnected `/mnt/usb` is exactly a readable directory holding nothing);
- the row has a blank path, which would otherwise resolve to the working directory.

`user_work_total` counts images that would lose something a rescan cannot bring back: tags, a star rating, collection membership, or dataset-project membership. Prompts, checkpoints and dimensions are re-read from the file, so they are not counted.

`clearable_user_work_total` is the same count restricted to groups that can actually be cleared, and it is the figure a confirmation prompt should quote. The two differ whenever a blocked location holds tagged images: those keep their tags precisely because they are never cleared, so quoting the library-wide total would warn about a loss that cannot happen.

At most 12 groups are returned (`groups_truncated` says whether more exist); `total`, `clearable_total`, `blocked_total`, `user_work_total` and `location_total` always cover the whole library, and `unreachable_locations` names every blocked location even beyond the group cap.

Example response:

```json
{
  "total": 1614,
  "clearable_total": 1614,
  "blocked_total": 0,
  "user_work_total": 0,
  "clearable_user_work_total": 0,
  "location_total": 6,
  "groups_truncated": false,
  "unreachable_locations": [],
  "groups": [
    {
      "location": "L:/datasets/retired-lora",
      "reason": "folder_deleted",
      "clearable": true,
      "count": 945,
      "with_tags": 0,
      "with_rating": 0,
      "in_collection": 0,
      "in_dataset": 0,
      "user_work_total": 0,
      "sample_filenames": ["00001.png", "00002.png", "00003.png"]
    }
  ]
}
```

#### POST /api/images/missing/clear
Clear gallery records for missing files. **No file is deleted or moved** — only database rows are removed, and re-scanning the folder adds them back if the files reappear.

Body: `{ "location": "L:/datasets/retired-lora" }` clears one folder's records. Omit `location` to clear every reachable location at once.

A `location_unreachable` group is never cleared. Naming one explicitly returns `status: "refused"` with `reason: "location_unreachable"` and removes nothing; a clear-everything call reports those rows under `skipped_unreachable`. The guard exists because an unplugged external drive marks its rows unreadable while the files are intact, so clearing them would drop tags and ratings for images that still exist.

`status` is `cleared`, `refused`, or `nothing_to_clear`. Call `GET /api/images/missing-summary` first to learn what clearing would cost.

#### POST /api/image-metadata/save-edited
Save an image copy with edited metadata fields. The edit is written in the image's own format: a NovelAI PNG gets it inside its `Comment` record (plus `Description` and `Source`), with no A1111 `parameters` block, and a warning names fields a NovelAI record has no place for (LoRAs); an A1111/Forge block keeps every setting the editor does not show, verbatim (a `Model hash` whose model was changed is dropped and named in the warnings). A ComfyUI graph is kept as it is next to the edited `parameters` block and still reads back as ComfyUI.

#### POST /api/open-folder
Open an image's containing folder in the host file explorer.

#### POST /api/parse-image
Parse uploaded image metadata without inserting into library DB.

### Libraries

#### GET /api/libraries
List durable local library workspaces and return the active library id.

#### GET /api/libraries/current
Return the active library workspace and its id.

#### POST /api/libraries
Create a library workspace. Body: `{ "name": "Library name" }`.

#### POST /api/libraries/move-images
Move indexed image ownership to another library without moving source files. Body: `{ "image_ids": [1, 2], "target_library_id": "library-id" }`.

#### POST /api/libraries/claim-paths
Claim indexed paths for the target (or current) library. Body: `{ "paths": ["/absolute/path/image.png"], "target_library_id": "library-id" }`.

#### GET /api/libraries/{library_id}/export
Export one library's indexed paths and light metadata as JSON. Add `download=false` for an inline JSON response.

#### PATCH /api/libraries/{library_id}
Rename a library workspace. Body: `{ "name": "New name" }`.

#### DELETE /api/libraries/{library_id}
Delete a non-default library and its indexed ownership; source files are not deleted.

### Tags

**Tag provenance (v3.5.0, migration 024):** every tag row now carries `source` (`tagger` | `vlm` | `manual` | `trigger`; `NULL` = pre-migration legacy) and `category` (`general` | `character` | `copyright` | `artist` | `rating` | `meta` | `trigger`). Tag arrays returned by image endpoints include both fields. Pipeline re-tags (gallery tagger, Smart Tag) replace only their own rows (`source` in tagger/vlm/trigger or `NULL`) — user-added `manual` rows survive re-tagging, and the tag import endpoint marks imported rows `manual`. The export template engine uses `category` for the `{characters}` / `{copyright}` / `{artists}` sections.

#### GET /api/tags
Get all tags with counts.

#### GET /api/generators
Get generators with counts.

#### GET /api/tags/library
Get tag library. Optional query params: `sort_by=frequency|alphabetical`, `q=<text>`, `limit=<n>`. Search runs across the full tag table before applying `limit`.

#### POST /api/duplicates/scan
Start a whole-library near-duplicate GROUP scan (v3.5.0). Body: `{ "threshold": 0.80-0.999, default 0.95 }`. Clusters all CLIP-embedded images into groups (hnswlib ANN when available, exact chunked matmul otherwise — no size cap), ranks each group's members by user rating → aesthetic → resolution → file size and flags the best as `suggested_keep`. Runs as a bulk background job: poll `GET /api/bulk-jobs/{job_id}` with the returned `job_id`. 409 while another scan runs. Results persist to `<state>/duplicate-groups.json`.

#### GET /api/duplicates/scan-status
Return `{ "active", "job_id", "job" }` for the running duplicate scan (if any) so a reopened UI can re-attach to the progress poll.

#### GET /api/duplicates/groups
Page through the last completed duplicate scan. Query: `offset`, `limit` (1-200). Returns `{ "available", "scanned_at", "threshold", "summary": { "embedded_count", "group_count", "redundant_count", "reclaimable_bytes" }, "groups": [{ "group_id", "similarity", "members": [{ "id", "path", "filename", "width", "height", "file_size", "aesthetic_score", "user_rating", "suggested_keep" }] }], "total_groups", "has_more" }`. Deletion reuses the existing delete endpoints.

#### GET /api/metadata/health
Per-generator text-parse coverage (metadata L3, v3.5.0). Returns `{ "generators": [{ "generator", "total", "missing_prompt", "missing_text", "with_raw" }], "totals": { "total", "missing_prompt", "missing_text", "with_raw" }, "scope": "readable_images", "excluded_unreadable" }`. Every counter describes the same population as the recovery job — readable rows only (`COALESCE(is_readable, 1) = 1`) — because these numbers sit beside the button that runs it: `missing_prompt` is exactly the set a run retries, `missing_text` (neither a prompt nor a sidecar caption) is the subset a run can still change, and `with_raw` counts rows carrying a stored raw metadata envelope (re-parseable without the original file). `excluded_unreadable` reports the indexed rows left out; whole-library composition is `GET /api/library-health`. Drives the settings-page metadata health row.

#### POST /api/metadata/reparse
Re-parse missing-prompt images through the current parser (metadata L3, v3.5.0). Body: `{ "scope": "missing_prompt" | "comfyui" }` (422 otherwise). For every readable image with an empty positive prompt, replays the gzipped raw metadata envelope stored at scan time first (`used_raw`), then falls back to fully re-parsing the file if it still exists (`used_file`); rows with neither count as `missing_source`. Runs as a bulk background job — poll `GET /api/bulk-jobs/{job_id}`; 409 while another re-parse runs. Job result: `{ "recovered", "still_missing", "used_raw", "used_file", "missing_source" }`. `scope: "comfyui"` (v3.6.0) is the other job: it re-reads EVERY readable ComfyUI image of the current library from its file with the current parser, stored prompt or not, and rewrites only the prompt-derived fields (`update_reparsed_prompt_fields`) of rows whose prompt or negative prompt came out different; a file that no longer parses to a prompt leaves its row untouched. Result: `{ "changed", "unchanged", "kept", "missing_source" }`. Meant for after a parser upgrade that changed how ComfyUI graphs are read.

#### GET /api/metadata/reparse-status
Return `{ "active", "job_id", "job", "scope" }` for the running metadata re-parse (if any) so a reopened UI can re-attach to the progress poll; `scope` names the running job's scope (`missing_prompt` or `comfyui`).

#### POST /api/publish/censor-pairs
Resolve censored variants for a publish set (v3.5.0). Body: `{ "image_ids": [int, ...], "censor_suffix": "_censored" }` (suffix optional, sanitized to `[A-Za-z0-9_-]`). For each image, probes `{stem}{suffix}.{png|jpg|jpeg|webp}` — first next to the original on disk (`censored_source: "disk"`), then anywhere in the library by exact filename, newest indexed copy first (`censored_source: "library"`). Response preserves request order (duplicates removed): `{ "pairs": [{ "image_id", "missing", "filename", "path", "width", "height", "file_size", "found", "censored_path", "censored_filename", "censored_source" }], "total", "found_count", "censor_suffix" }`. Unknown ids come back with `missing: true`.

#### POST /api/publish/staging-folder
Create a fresh, empty folder under the data directory (`publish-staging/<session>`) for the Censor page's hand-over to the publish set. The Censor page renders each censored queue item there through its own save endpoints, then sends every file's path to `/api/publish/export` as `censored_path`. Earlier hand-over folders are removed. Returns `{ "folder" }`; 500 when the folder cannot be created.

#### POST /api/publish/export
Export an ordered publish set with sequential platform-style names (v3.5.0). Body: `{ "items": [{ "image_id", "use_censored", "censored_path"?, "output_name"? }], "metadata_option": "strip" | "keep" | "minimal" (default "strip"), "output_folder", "name_prefix": "", "start_index": 1, "pad_width": 1-4 (default 2), "caption_text": "", "censor_suffix": "_censored", "overwrite": false, "watermark": { "enabled": false, "text": "", "position": "bottom_right", "opacity": 80, "size_percent": 8, "margin_percent": 2, "color": "#FFFFFF" } }`. Item position defines the publish index: each file is copied to `{name_prefix}{number:0{pad}}{ext}` (source extension kept, e.g. `01.png`, `02.jpg`); numbering stays stable across retries because it is positional. An item's `output_name` (a name given on the Censor page) replaces the numbered name; its extension always follows the exported file, and a name used twice in one set fails that item. Items requesting `use_censored` export their `censored_path` when one is sent, otherwise the `{stem}{suffix}.*` pairing; they FAIL (per-item error) when no censored file resolves — the uncensored original is never silently substituted. `metadata_option` controls generation info: `strip` (default) re-encodes without PNG text chunks, EXIF or XMP, `minimal` keeps only the color profile and DPI, `keep` copies the file unchanged (with a watermark it re-encodes and carries the original's generation info over). Animated sources can only be exported with `keep` and no watermark. Existing files are skipped unless `overwrite`. When `watermark.enabled` is true, the selected source is rendered with the configured text into the export copy only; gallery and training sources are untouched. Non-empty `caption_text` is written to `caption.txt`. Output folder is validated against traversal and created if needed (400 on invalid); a blank `output_folder` means the `publish` folder under the output root (see Output folders). Returns `{ "success", "exported": [{ "index", "output_name", "image_id", "used_censored", "source_path", "metadata" }], "skipped_existing", "errors", "caption_file", "output_folder", "reveal_path", "metadata_option" }`; `reveal_path` is the first written (else first skipped) file, for `POST /api/output-folders/reveal`.

#### GET /api/tags/suggest
Type-ahead tag suggestions for autocomplete inputs (v3.5.0). Query params: `q=<partial token>`, `limit=<1..50, default 20>`. Merges the user's library tags (frequency-ranked, `source: "library"`) with the bundled danbooru vocabulary `backend/assets/danbooru_tags.csv` (popularity-ranked, alias-aware, `source: "danbooru"`). Each suggestion carries a 14-category `category` (same palette as Dataset Maker tag pills) and an optional `zh` display string. CJK queries fuzzy-match the bundled MIT Chinese/Japanese alias table (`backend/assets/danbooru_zh.csv`, derived from StoryAura/Danbooru-Dataset-csv); a user file at `data/danbooru_zh.csv` still overrides it. Returns `{ "suggestions": [{ "tag", "count", "source", "category", "zh", "copyright" }], "danbooru_loaded", "zh_loaded" }`. Character hits include the StoryAura series/copyright when known; accepting that suggestion in a comma-separated tag box also inserts the copyright token if it is not already present. Empty `q` returns the library's most frequent tags.

#### POST /api/tags/suggest-upsample
TIPO tag-upsampling assist (v3.5.x, roadmap #8, v1). Proposes danbooru tags the WD14-family taggers have no label for (vocabulary blind spots) — complements the score-band coverage-gaps flow, which can only see tags the tagger scored. Body: `{ "tags": [1..200 strings], "image_id"?: int, "rating"?: string, "aspect_ratio"?: float, "target": "short"|"long" (default "short"), "model": "v2.1"|"200m-ft"|"100m" (default "v2.1") }`. When `aspect_ratio` is omitted but `image_id` is given, the ratio is derived from the gallery record (404 for unknown ids). Runs TIPO (KohakuBlueleaf/KGen, arXiv:2411.08127) via the OPT-IN dependency pair `tipo-kgen` + `llama-cpp-python` (CPU GGUF; NOT in requirements-core.txt — missing install returns 400 with the extra-index `--only-binary=llama-cpp-python` hint. Supported path is Model Center → TIPO → Prepare, which installs the official CPU wheel; the PyPI sdist is refused because public packages have no C compiler). Weights download on first real use into `DATA_DIR/models/tipo` (override: `SD_IMAGE_SORTER_TIPO_DIR`). The UI offers two variants: `v2.1` = TIPO-v2.1-1B-A200M Q8_0 (~1.1 GB; kohaku-license-1.0, free for local use; Danbooru rating words are mapped to the v2.1 vocabulary) and `200m-ft` = TIPO-200M-ft Q8_0 (~210 MB; the lighter CPU option). `100m` remains accepted by the API. Post-processing: input tags are stripped (case/underscore-folded), candidates pass the shared VLM vocabulary gate (out-of-vocab hallucinations dropped), capped at 40. Returns `{ "proposed_tags": [{ "tag", "category" }], "model", "elapsed_ms", "input_tags" }`. Read-only and NEVER auto-applied — Reverse Prompt and the Separation Console render a default-unchecked checklist whose confirmed picks land in the draft / Common-tags box.

#### POST /api/tags/consistency/report

Pre-training dataset health check (v3.5.x BE-5'). Body: `{image_ids|selection_token, trigger, training_purpose}`. Runs the checks an experienced LoRA trainer performs by eye and returns `{images, images_in_scope, images_truncated, findings, tag_frequencies, shot_distribution}`; at most 20,000 images are checked, and `images_truncated` says when the scope (`images_in_scope`) was larger. Each finding carries `severity`, bilingual `title/detail` (symptom → cause → fix guidance), optional `fix` (a ready-made payload for an existing bulk endpoint — never applied server-side) and `data`. Checks: trigger coverage + danbooru-collision (N5), full-body composition balance (N4), duplicate/missing rating rows, single-occurrence junk tags, multi-spelling variants, always-co-occurring tag pairs. Read-only; capped at 20k images.

#### POST /api/tags/trait-candidates
Compute character-trait pruning candidates (P1-17, v3.5.0). Body: `{ "image_ids": [..] }` or `{ "selection_token": "..." }` (exactly one), optional `min_ratio` (0.05–1.0, default 0.6) and `limit` (1–200, default 60). Returns `{ "total_images", "candidates": [{ "tag", "family", "count", "ratio" }] }` — innate-trait tags (hair / eyes / skin / body families, general-category rows only) present in at least `min_ratio` of the selected images, ranked by frequency. The export UI surfaces these as a reviewable checklist whose picks feed the ordinary export blacklist; nothing is removed silently.

#### GET /api/tags/info
Learn-while-tagging popover (v3.5.x, competitive roadmap #6). Query: `tag=<tag or alias>`. Returns `{tag, canonical, found_in_vocab, category, danbooru_count, aliases, zh, copyright, parent_tag, implies, implied_by, library_count}` — canonical resolution for alias input, 14-category verdict (bundled vocab code, falling back to the app heuristic), CJK display name, character series/parent from the bundled StoryAura catalog when known, implication edges from the bundled/drop-in table (child → parents both directions), and the live library tag count. Unknown tags still return the heuristic category + library count.

#### POST /api/tags/rethreshold
Virtual re-threshold from stored scores (v3.5.x BE-1) — rewrites tag rows at new thresholds with **zero inference**. Requires prior tagging runs made with tag-score persistence on (default; see `GET /api/tags/scores/stats`). Body: `{image_ids|selection_token, model, threshold?, character_threshold?, consensus_min?: 2, dry_run: true, pre_tag_blacklist?: [], max_tags_per_image?: 0}`. `model` is a tagger name with stored scores, or `"consensus"` to fuse every stored model with the Smart Tag voting function (weight 1.0 each; explicit `threshold` required). Omitted thresholds resolve to the model's registry defaults. Thresholds below the storage floor (`TAG_SCORES_FLOOR`, default 0.15) return 400 — those scores were never persisted. Writes go through the normal pipeline path (`replace_scope="pipeline"`), so manually added tags survive. Property-tested: results equal re-running inference at the same thresholds. Returns `{dry_run, model, threshold, character_threshold, requested, with_scores, skipped_no_scores, images_changed, tags_added, tags_removed, diffs: [{image_id, added, removed, added_count, removed_count}] (first 200), applied}`.

#### POST /api/tags/coverage-gaps
Coverage completion (v3.5.x BE-1, N2): images whose stored score for `tag` sits just under the threshold but that carry **no such tag row** — "should probably have it, doesn't". Body: `{tag, image_ids|selection_token?, model?, band_low?, band_high?, limit?: 200, offset?: 0}` (`limit` is one page, at most 2,000; `offset` pages on). Scope omitted = whole library. `band_high` defaults to the model's registry threshold (0.35 without a model); `band_low` defaults to 0.10 under `band_high`, clamped to the storage floor. Without `model`, the best score across stored models wins per image. Returns `{tag, band_low, band_high, model, scope_images, gaps: [{image_id, model, score, filename, path}], total, offset, has_more}` ranked by score descending; `total` counts every gap, not just this page. Feeds the Separation Console's find-missing flow; confirmed adds should go through `POST /api/tags/bulk/add` (writes `source: "manual"`).

#### POST /api/tags/scores/tag-audit
Per-model audit for ONE tag (v3.5.x BE-1-UI): which stored models scored `tag` inside the scope, at what confidence spread. Body: `{tag, image_ids|selection_token?}` (scope omitted = whole library). Returns `{tag, scope_images, models: [{model, images, avg_score, max_score, min_score}]}` sorted by model name. The Separation Console's per-tag 🧪 action renders this as the "which model said that?" view for dubious tags.

#### GET /api/tags/scores/stats
Storage report for the `tag_scores` table (v3.5.x BE-1): `{enabled, floor, total_rows, images_with_scores, models: [{model, rows, images}], estimated_bytes}`. Score persistence is on by default (`SD_IMAGE_SORTER_TAG_SCORES=0` disables; `SD_IMAGE_SORTER_TAG_SCORES_FLOOR` tunes the floor).

#### POST /api/tags/scores/purge
Delete stored tag scores. Body: `{model?: string}` — omit to purge all models. Returns `{removed, model}`. Re-tagging repopulates scores; purging only removes the re-threshold/coverage-gap capability for images tagged before the next run.

#### GET /api/masks/{image_id}
Stored masked-training mask for one gallery image, as a grayscale PNG (white = train, black = ignore). 404 = no mask stored, which trainers treat as "train the whole image" (v3.5.x Phase 4 mask editor).

#### PUT /api/masks/{image_id}
Save a canvas-edited training mask. Body: `{data_url}` — a base64 `data:image/png;base64,...` URL (webp/jpeg accepted, converted to grayscale PNG). Atomic write to `DATA_DIR/masks/{image_id}.png`. 404 when the image id is not in the library; 400 on undecodable payloads or >32 MB. Returns `{saved, image_id, width, height, filename}`.

#### DELETE /api/masks/{image_id}
Remove the stored mask (the image reverts to fully trained). Returns `{removed, image_id}`.

#### POST /api/masks/status
Which of these images carry a stored mask. Body: `{image_ids: [..]}`. Returns `{masks: {"<id>": true|false}}` — queue badge data for the Dataset Maker.

#### POST /api/masks/{image_id}/auto
Generate a subject mask for canvas preview — NOT saved until the user saves the edited result. Body: `{method: "rembg" | "lucida"}`; omitted `method` defaults to `rembg`. rembg is an opt-in dependency set up from Model Center (`POST /api/models/prepare` with `model_id: "rembg"` installs the pinned `rembg==2.0.69` and downloads the ~170 MB u2net model into `DATA_DIR/models/rembg`). Lucida returns a soft-alpha grayscale mask and is set up the same way (`model_id: "lucida"`, application-pinned revision). A missing runtime/checkpoint or failed inference returns 400 with an actionable bilingual error. Returns `{image_id, method, width, height, data_url, saved: false}`.

#### POST /api/masks/auto-batch
Queue Lucida/rembg mask generation for many gallery images (Dataset Maker “Auto-mask all”). Body: `{image_ids: [..], method: "lucida"|"rembg", overwrite?: false}`. Existing mask files are skipped unless `overwrite` is true, so a cancelled or interrupted run can resume. Returns `202` with `{job_id, kind: "mask_auto_batch", status, total}`; poll `GET /api/bulk-jobs/{job_id}`. `409` if another auto-mask batch is already running. Max 5000 ids.

#### GET /api/prompts/library
Get prompt token library. Optional query params: `q=<text>`, `limit=<n>`. Search runs across the full prompt-token index before applying `limit`.

#### GET /api/loras/library
Get LoRA library. Optional query params: `q=<text>`, `limit=<n>`. Search runs across the full LoRA index before applying `limit`.

#### GET /api/checkpoints/library
Get the checkpoint (base model) library for the Library tab's Checkpoints facet. Returns `{ "checkpoints": [{ "name", "count" }], "total" }` aggregated across the full indexed library.

#### GET /api/tagger/models
Get available tagger models and runtime guidance. Each model item includes default thresholds, GPU/runtime guidance, and Custom profile metadata such as `custom_profile_supported`, `custom_metadata_format`, and `custom_tags_file_hint`. v3.5.0: each item also carries `captioner_only` — `true` marks caption-only models (ToriiGate) that stay in the catalog for Smart Tag and model downloads but are hidden from the gallery tagger dropdown and rejected by `/api/tag` with a 400. Florence-2 Base is a separate Smart Tag local captioner and is intentionally absent from this booru tagger endpoint. `cl-tagger-v2` is an optional gated booru tagger exposed here; its fixed revision is downloaded only after explicit user preparation from official Hugging Face and its weights are never bundled in portable releases. `pixai-tagger-v1.0` (1008 px input, 30,877 tags) is prepared through the WD14 model card; GPU batch caps shrink with a model's input area relative to 448 px.

#### POST /api/tag/start
Start background tagging (alias for POST /api/tag).

**AI job queue (v3.4.2):** gallery tagging, Smart Tag, and VLM caption batches share one runtime. Starting any of them while another AI job is running no longer returns 409 — the job is enqueued (FIFO) and auto-starts when the current job finishes (including after an error or cancel). The start endpoint then returns `{"status": "queued", "pipeline_queued": true, "queue_id": "qN", "enqueued_at": "<ISO time>", "queue_position": N, "queue_length": N, "message": ..., "pipeline_owner": ..., "pipeline_mode": ...}` instead of the started-now shape. Re-submitting an identical request while it is already last in the queue returns the same shape with `"duplicate": true` instead of enqueueing twice. The queue is saved to disk and restored when the server starts again; a `queue_id` can be reused after a restart, so a client that remembers a queued entry also compares `enqueued_at`. 409 is still returned for the fail-closed case (a sibling job's status could not be determined) and for validation errors. Each kind's cancel endpoint also removes that kind's queued entries (`removed_queued` count in the response).

#### POST /api/tag
Start background tagging.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `image_ids` | int[] \| null | null | Specific images (`null` + `retag_all=false` = all untagged) |
| `threshold` | float | 0.35 | Threshold for general tags after score normalization |
| `character_threshold` | float | 0.85 | Threshold for character tags after score normalization |
| `retag_all` | bool | false | Re-tag already tagged images when no explicit `image_ids` are supplied |
| `model_name` | string \| null | default tagger | Built-in tagger model name, or the selected Custom profile when `model_path` is used. Captioner-only models (`toriigate-0.5`) are rejected with 400 — caption with Smart Tag's natural-language mode instead (v3.5.0 owner decision). `cl-tagger-v2` is a dedicated downloaded model and does not accept the Custom ONNX path |
| `model_path` | string \| null | null | Local Custom ONNX model path; must exist and end in `.onnx`. User-supplied files are never deleted or re-downloaded by the repair path |
| `tags_path` | string \| null | null | Optional local tag metadata path for Custom ONNX only; requires `model_path`. If supplied, it must exist and match the selected profile extension. If omitted, the tagger auto-detects profile-specific metadata next to the model: WD14/PixAI use `selected_tags.csv`; Camie uses `camie-tagger-v2-metadata.json` or `metadata.json` |
| `custom_profile` | string \| null | null | Custom ONNX profile: `wd14`, `camie-tagger-v2`, or `pixai-tagger-v0.9`. `toriigate-0.5` is rejected because ToriiGate is not ONNX |
| `use_gpu` | bool | true | Request GPU runtime when available |
| `allow_unsafe_acceleration` | bool | false | Reserved unsafe acceleration override |
| `batch_size` | int \| null | null | Optional user override for runtime chunk size. If omitted, Custom ONNX starts conservatively |

#### GET /api/tag/scope-count
How many images a whole-library tagging run (no `image_ids`) would process in the current library: `?retag_all=false` (default) counts readable images with no AI tags yet, `?retag_all=true` counts every readable image. Returns `{ "count", "retag_all" }`. The tag modal shows it next to Start.

#### GET /api/tag/progress
Get tagging progress.
The response now includes truthful runtime fields so the UI can distinguish target mode from the backend that actually ran:

- `runtime_backend_target`
- `runtime_backend_actual`
- `runtime_backend_reason`
- `memory_pressure_warning`

`message` is an English display string kept for API compatibility; clients localise from `message_key` (`preparing`, `loading_custom`, `first_download`, `loading_backend`, `loading_model`, `runtime_notice`, `gpu_load_failed`, `collecting`, `tagging_started`, `skipped_unreadable`, `skipped_changed`, `memory_refresh`, `memory_critical`, `memory_high`, `tagging_batch`, `tagging_one`, `runtime_adjusted`, `gpu_inference_failed`, `image_done`, `batch_error`, `cancelling`, `cancelled_early`, `cancelled`, `cancelled_worker_stopped`, `done`, `worker_crashed`, `monitor_error`, `setup_failed`, `schedule_failed`, `torii_loading`, `error`), the counters, and `message_args` (a small object such as `{"item": "a.png"}` or `{"device": "gpu"}`; `error` and `monitor_error` carry the raw exception text as `detail`; `schedule_failed` carries `detail`; `gpu_load_failed` and `gpu_inference_failed` carry `reason` (English) and `reason_key` (`cuda_unavailable`, `torii_left_cuda`, `no_gpu_provider`, `gpu_provider_failed`, `inference_failed`); `runtime_notice` carries the runtime advisory as `notice`). Every progress state also carries `runtime_notice`, the English runtime advisory of the current run (empty when none), so a client can show it for the whole run. `POST /api/tag` also returns `message_key: "started"`.

**v3.4.2:** the progress snapshot additionally carries `pipeline_queue`: `{"total_queued": N, "queued": [{"queue_id", "kind", "position", "enqueued_at"}], "last_start_error"}` so pollers can render "Queued #N" before the job starts. The same field appears on the Smart Tag and VLM batch progress endpoints.

#### GET /api/tags/pipeline-queue
Read-only snapshot of the shared AI-job FIFO queue across all kinds — gallery tagging / smart-tag / VLM / aesthetic (v3.5.0, Aurora Phase 3). Returns the same shape as the `pipeline_queue` field above, standalone: `{"total_queued": N, "queued": [{"queue_id", "kind", "position", "enqueued_at"}], "last_start_error"}`. Powers the gallery action bar's live AI-queue indicator without polling a job-specific progress endpoint. No side effects.

#### POST /api/tag/single
Tag ONE arbitrary image file synchronously, with no database row involved (v3.5.x). Body: `{ "image_path": string (required), "tagger_model"?: string, "general_threshold"?: 0..1, "character_threshold"?: 0..1, "copyright_threshold"?: 0..1, "use_gpu"?: bool }` — field names match Smart Tag's so one client form can drive both. `image_path` is a filesystem path, not an `images.id`: it may be a library file, a loose file anywhere on disk, or the `source_temp_path` that `POST /api/parse-image` returns for a retained upload, so a drop-one-image page needs no second upload route. Nothing in the library is read, created or updated — the response always carries `"stored": false`. Omitted thresholds fall through to the selected model's registry defaults rather than being re-pinned here. Returns `{image_path, model, rating, rating_confidences, general_tags, character_tags, copyright_tags, all_tags, tags, elapsed_ms, stored}`; the batch path's `raw_scores` (`tag_scores` persistence payload) is deliberately not exposed. Paths go through the shared `utils/path_validation.validate_file_path` guard with the image-extension allow-list: traversal, control characters and non-image extensions are 400, a missing file is 404. A file the tagger cannot decode is 422 (the engine reports per-image failures as an empty result carrying `error`, and reporting that as "no tags found" would be a false success); a runtime that cannot start is 503. Unlike `POST /api/tag` there is no job to poll and no queue entry — but note this endpoint takes the shared AI runtime lease at normal priority, so it waits behind a running batch chunk like every other single-image AI endpoint.

#### POST /api/tag/reset
Reset stuck tagging task.

#### POST /api/tag/cancel
Cancel the active tagging task.

#### GET /api/tags/export
Export the tag data of the current library's (`X-SD-Library-Id`, default `main`) tagged images as JSON: `version`, `count`, `images`.

#### POST /api/tags/import
Import tag data from JSON into the current library only: rows match its images by path, then by file name; a file name several of its images share is skipped, not guessed. Response: `imported`, `skipped`, and the reasons that add up to `skipped`: `not_found`, `ambiguous`, `already_tagged` (overwrite off), `duplicate` (the same image listed again, overwrite off). Rows with neither tags nor a caption are in no count. Clears the library-health cache, as every tag write does.

#### POST /api/tags/export-batch
Export one same-name sidecar per selected image. Text modes write `.txt`; `json` writes `.json`.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `image_ids` | int[] | required | Images to export (min 1) |
| `output_folder` | string | required | Output directory |
| `prefix` | string | "" | Optional Class Token prepended only to training-caption modes (`caption_tags`, `caption_merged`) |
| `blacklist` | string[] | `[]` | Tags excluded from tag/caption outputs |
| `content_mode` | string | `tags` | `tags`, `prompt`, `negative`, `prompt_negative`, `a1111`, `caption_tags`, `caption_merged`, or `json` |
| `overwrite_policy` | string | `unique` | `unique` keeps each sidecar's image-matched name and reports a per-image error if that name is already taken — it never renames to `{stem}_2`, which would pair the caption with no image (in `beside_image` mode a caption already sitting next to the image is skipped instead of erroring). `skip` leaves existing sidecars untouched. `overwrite` replaces sidecars |
| `image_types` | object | `{}` | v3.5.0 (caption editor): per-image caption type `{image_id: "booru"\|"nl"\|"both"}`. `nl`/`both` fold the stored (or overridden) natural-language sentence into the caption; absent keys mean `booru` and reproduce the pre-v3.5.0 output byte-for-byte |
| `image_nl_overrides` | object | `{}` | v3.5.0 (caption editor): per-image edited NL sentence `{image_id: text}`. An explicit empty string suppresses the stored sentence |
| `nl_sidecar` | bool | `false` | v3.5.0 (diffusion-pipe split export): additionally write each image's natural-language caption to a `{stem}{suffix}.txt` twin beside the tag sidecar. Only valid for `tags`/`template` content modes (400 otherwise). The twin is single-line with the trigger (template trigger, else `prefix`) injected up front; images without NL text get no twin. Under `unique` policy a clash on the twin fails that row atomically (no half-pairs) |
| `nl_sidecar_suffix` | string | `"_nl"` | Filename suffix for the NL twin (`[A-Za-z0-9._-]+`) |
| `training_purpose` | string | `""` | v3.5.0 (P2-19): purpose-aware filtering on the stored tag rows before rendering — `style` drops style/artist tags, `character` drops character-name tags when a trigger (template trigger or `prefix`) is present. Same semantics as Smart Tag's purpose filter; `""` disables |
| `dedupe_implications` | bool | `false` | v3.5.0 (P2-18): collapse danbooru implication parents when a more specific child is present (`cat_ears` drops `animal_ears`, transitive). Table: bundled `backend/assets/danbooru_implications.csv` + optional `data/danbooru_implications.csv` drop-in |

Mode rules: `prompt`, `negative`, `prompt_negative`, `a1111`, and `json` preserve the stored Prompt / generation data and ignore `prefix`. `tags` exports only tags after blacklist filtering. `caption_tags` writes optional Class Token + AI caption + Tags. `caption_merged` writes optional Class Token + AI caption + Prompt + Tags as one LoRA-training caption line. `image_types` / `image_nl_overrides` apply only in `template` and `tags` modes (the same gate as `/api/dataset/export`) and are also accepted by `POST /api/tags/export-combined`.

Response includes `status` (`ok`, `partial`, or `error`), `exported`, `skipped`, numeric `errors`/`error_count`, `error_messages`, `total`, `content_mode`, `overwrite_policy`, and `nl_sidecars_written` (count of `{stem}_nl.txt` twins; 0 when `nl_sidecar` is off). `overwrite_policy=skip` returns `partial` when existing sidecars are intentionally left untouched. `overwrite_policy=unique` returns `partial` (or `error` if nothing was exported) when a name clash is reported: `error_messages` names the taken sidecar and the source image that already owns it.

v3.5.0: the response also carries a `validation` block — a trainer-consumability report over every written sidecar: `{checked, ok, warnings: [{code, count, examples, message}]}`. Warning codes: `unpaired_sidecar` (caption filename no longer matches its image, e.g. an `overwrite`-mode `_2` de-dup rename), `empty_caption`, `multiline_caption` (kohya-style trainers read only the first line; not raised for the by-design multi-line modes `prompt_negative`/`a1111`/`json`/`prompt_nl`), `missing_trigger` (template mode with a configured trigger), and `conflicting_ratings` (two different rating tokens in one caption). `examples` lists at most 3 filenames per code.

#### POST /api/tags/export-batch/start
Run the same sidecar export as a background job so a large selection does not block the request. Accepts the same body as `POST /api/tags/export-batch`. This is a coarse background wrap (no mid-run cancel). Response includes `status` and `message`.

#### GET /api/tags/export-batch/progress
Return the current export-job progress. Fields: `status` (`idle`/`running`/`done`/`error`), `step`, `current`, `total`, `current_item`, `message`, `operation: "export"`, and `result` — the full `export_tags_batch` payload (`exported`, `skipped`, `errors`, `content_mode`, `overwrite_policy`, …) once finished.

#### POST /api/tags/export-batch/reset
Reset a stuck or finished export job back to `idle`.

#### POST /api/tags/fix-ratings
Clean up duplicate rating tags in existing database.

### Sorting

#### POST /api/validate-path
Validate folder path.

#### POST /api/scan
Start folder scan. The default scan path is single-pass streaming: progress reports discovered/imported work as it walks the directory and does not pre-count the entire folder tree before import. Exact up-front totals are intentionally not part of the default request contract for large or network-backed libraries.

#### GET /api/scan/progress
Get scan progress.
The payload includes step-oriented fields such as `step`, `current_item`, `started_at`, `updated_at`, `recent_errors`, `metadata_pending`, `attention_required`, `attention_message`, `stalled_seconds`, `diagnostics_available`, and `diagnostics_endpoint`. When `attention_required=true`, clients should show a visible stalled-scan warning and offer diagnostics copy/open actions instead of leaving the user with a frozen-looking progress bar. Corrupt / truncated files are reported by filename and excluded from the normal library. `message` is a bilingual display string kept for API compatibility; clients localise from `message_key` (`syncing_index`, `counting_before`, `scanning`, `processing`, `counting`, `counted`, `cleanup`, `library_ready_metadata`, `library_ready_import`, `reading_details`, `importing_details`, `skipped_unreadable`, `cancelling`, `cancelled`, `done`, `error`, `aborted`) plus the existing counters, `message_item` (the file name behind `processing` / `skipped_unreadable`), `missing_text_notice` (true on a done state when most imported images stored no text), `message_detail` (on `error`: the English text of a scan error raised by the app itself; empty for unexpected errors), `message_detail_code` and `message_detail_args` (a stable reason code with its parameters: `library_root_persist_failed` {path}, `scan_root_inaccessible` {path, reason}, `missing_cleanup_unverifiable` {path}, `folder_not_found` {path}, `not_a_directory` {path}, `folder_is_link` {path}; clients show their own sentence for a known code and `message_detail` otherwise). `POST /api/scan` also returns `message_key: "started"`.

#### POST /api/scan/acknowledge
Atomically claim and clear the exact completed manual scan observed by the client. The JSON request body requires positive integer `run_id` and `source` set to `"manual"`. Returns `409` when that identity is no longer the pending terminal result; callers that lose this claim must not repeat completion side effects.

#### POST /api/scan/cancel
Cancel the exact active scan task observed by the client. The JSON request body requires positive integer `run_id` and `source` (`manual`, `library_auto_refresh`, or `library_rescan`). Returns `409` if a newer or different scan owns the active state.

#### POST /api/scan/reset
Reset stuck scan progress.

#### POST /api/move
Move or copy selected images synchronously. Request body includes `image_ids`, `destination_folder`, and optional `operation` (`move` or `copy`, default `move`). Returns the per-image `results` once complete; kept for small selections and existing integrations.

#### POST /api/move/start
Start a background move/copy job for the same request body as `/api/move`, returning immediately so the UI can show a progress bar. Responds `409` if a move job is already running. Use this for large selections where the synchronous endpoint would block.

#### GET /api/move/progress
Get background move/copy progress: `running`, `total`, `processed`, `moved`, `copied`, `errors`, `step`, `message`, and the final per-image `results` when done. Progress is guarded by a run-id epoch so a newly started job never reports a stale previous job's state. `message` is a bilingual display string kept for API compatibility; clients localise from `message_key` (`starting`, `processing`, `done`, `cancelling`, `cancelled`, `no_images`, `error`) and the counters (`current`, `total`, `moved`, `errors`, `operation`). The start response carries `message_key: "started"`.

#### POST /api/move/cancel
Cooperatively cancel an in-flight background move/copy. The worker checks the cancel flag at per-image boundaries, finishes any file already mid-write, and reports `status: "cancelled"` with partial counts.

#### POST /api/move/reset
Reset stuck background move progress.

#### POST /api/batch-move
Move all images matching filters. JSON filter payloads accept `prompt_match_mode` (`exact` or `contains`, default `exact`) alongside `prompts`.

#### GET /api/batch-move/progress
Get batch move progress. `message` is a bilingual display string kept for API compatibility; clients localise from `message_key` (`starting`, `processing`, `done`, `cancelling`, `cancelled`, `no_images`, `error`) and the counters (`current`, `total`, `moved`, `errors`, `operation`). The start response carries `message_key: "started"`.

#### POST /api/batch-move/cancel
Cooperatively cancel an in-flight batch move/copy. The worker checks the cancel flag at chunk and per-image boundaries, finishes any image already mid-write, and reports `status: "cancelled"` with the partial counts so the UI can show "Cancelled at X/N" instead of pinning the progress bar at the last running message.

#### POST /api/batch-move/reset
Reset stuck batch move progress.

#### POST /api/sort/start
Start manual sort session. Preferred clients send a JSON body with `generators`, `tags`, `ratings`, `checkpoints`, `loras`, `prompts`, `prompt_match_mode`, `artist`, `search`, size/aesthetic filters, `folders`, `operation_mode`, and `replace_existing`; this avoids URL/query-length limits for large filter scopes. Legacy query-string parameters remain supported, including `prompt_match_mode=exact|contains`. If an unfinished session exists, the default response is HTTP 409; pass `replace_existing=true` only after the user explicitly chooses to discard saved progress. `exclude_sorted=true` leaves out pictures Auto-Separate (`/api/batch-move`) or an earlier Manual Sort already copied or moved (recorded in `sorted_images`, migration 051); the response's `excluded_sorted` says how many were left out. The default (`false`) queues every match.

#### POST /api/sort/scope-count
Count what a session with the same body would queue, without starting one. Returns `{"total", "sorted", "remaining"}`: `total` pictures match the filters, `sorted` of them were already copied or moved by Auto-Separate or Manual Sort, and `remaining` is what `exclude_sorted=true` queues. Uses the same filter path as `/api/sort/start`, so the Manual Sort setup count equals the queue length.

#### GET /api/sort/current
Get current sort image. Every session answer (here and from `/api/sort/action`) carries `library_id`, the library the session's images belong to (the one saved session is shared by every library; null without a session), and `library_mixed`: true when the images belong to more than one library (then `library_id` is null). Manual Sort asks before resuming a session that is not the open library's.

#### POST /api/sort/action
Perform `move`, `skip`, or `undo`. A slot `move` (copy or move) records the picture in `sorted_images`; `undo` takes that record back (or restores the one it replaced). An `undo` answer names what it took back: `undone_action`, `undone_image_id`, `undone_filename`, and for a move `undone_operation` (`copy` or `move`).

#### POST /api/sort/set-folders
Set manual sort folders.

#### GET /api/sort/folders
Get manual sort folders.

#### DELETE /api/sort/session
Clear current sort session.

#### DELETE /api/clear-gallery
Clear all image records.

#### GET /api/analytics
Get analytics. Optional query params: `facet=checkpoints|loras|tags`, `q=<text>`, `limit=<n>` return a searched facet subset; search runs across the full indexed facet before applying `limit`.

#### GET /api/stats
Get database stats. This endpoint is a bounded dashboard summary: `top_tags`, `checkpoints`, and `loras` are capped top-N facet arrays for initial UI hydration, not exhaustive library dictionaries. Full Library-tab facet browsing should use the paginated/searchable analytics endpoints instead of assuming `/api/stats` contains every unique tag/model in a huge library.

Response includes generator facets and metadata-resolution state:

```json
{
  "total_images": 5000,
  "generators": [{"generator": "unknown", "count": 120}],
  "metadata_status": {"pending": 120, "complete": 4880},
  "metadata_pending": 120,
  "metadata_resolving": true,
  "scan_status": "running",
  "scan_step": "metadata",
  "scan_library_ready": true
}
```

`metadata_pending > 0`, or `scan_status` running/cancelling while `scan_library_ready` is false, means generator bucket counts are provisional. Clients must label WebUI/Forge/etc. counts as resolving instead of presenting zeroes as final.

#### GET /api/library-health
Get a read-only library quality and archive-readiness audit. This endpoint never moves, deletes, rewrites, or scans image files; it only aggregates indexed database records.

Query params:

- `sample_limit` — optional integer `1..25`, default `8`; caps sample rows per section.

Response includes:

```json
{
  "summary": {
    "total_images": 5000,
    "metadata_ready_percent": 93.4,
    "tagged_percent": 88.1,
    "quality_score": 84.5,
    "actionable_count": 320
  },
  "issue_counts": {
    "unreadable": 3,
    "missing_text": 120,
    "sd_missing_checkpoint": 14,
    "unattributed_sd_metadata": 2,
    "missing_dimensions": 0,
    "missing_file_size": 0,
    "untagged": 240,
    "missing_embedding": 4800,
    "missing_aesthetic": 4800,
    "metadata_pending": 0,
    "metadata_error": 3
  },
  "statistics": {
    "missing_prompt": 4180,
    "missing_negative_prompt": 4390,
    "missing_checkpoint": 4302,
    "unknown_generator": 4180
  },
  "duplicate_filenames": {
    "groups": 12,
    "images": 28,
    "samples": [{"filename": "00001.png", "count": 3}]
  },
  "top_folders": [],
  "issue_samples": [],
  "recommendations": []
}
```

`issue_counts` is the issue vocabulary — every key is a claim that something is wrong that the user can do something about. Every member is declared in `db_facets.ISSUE_VOCABULARY` together with the remedy that names its action, or with a recorded reason for being reported without one; the invariant is enforced at import and tested in `backend/tests/test_library_health_issue_vocabulary.py`. Which keys carry consequence is per key, and clients must not assume all of them do:

| Key | Feeds `actionable_count` | Costs `quality_score` | Notes |
|-----|--------------------------|-----------------------|-------|
| `unreadable` | yes | yes | Priced for the whole `reparse_or_reconnect` union. |
| `missing_text` | yes | yes | |
| `sd_missing_checkpoint` | yes | yes | |
| `unattributed_sd_metadata` | yes | yes | |
| `missing_dimensions` | yes | yes | Priced for the whole `incomplete_scan_record` union. |
| `untagged` | yes | yes | |
| `missing_file_size` | no | via `missing_dimensions` | Second facet of one incomplete scan record. |
| `metadata_error` | no | via `unreadable` | Every unreadable row is also one of these. |
| `metadata_pending` | no | no | A running import, not a defect. |
| `missing_embedding` | no | no | Optional coverage; complement is `summary.embedding_percent`. |
| `missing_aesthetic` | no | no | Optional coverage; complement is `summary.aesthetic_percent`. |

`summary.actionable_count` counts **images**, not issues: rows matching any actionable key or sharing a filename with another row, each counted once. It can never exceed `summary.total_images`. `summary.quality_score` deducts per remedy over the distinct rows that remedy visits, so every deduction is a number a `recommendations` entry also carries, and a row broken in two ways one action fixes costs once.

`statistics` holds counts that are true but are not defects: `missing_prompt`, `missing_negative_prompt`, `missing_checkpoint` and `unknown_generator` say how much of the library carries real SD generation provenance, which stays at or near 100% forever for images Stable Diffusion never made. Three have a narrower actionable counterpart covering only the rows something can still be done for — `issue_counts.missing_text` (neither a prompt nor a sidecar caption: the set the L3 recovery job can change), `issue_counts.sd_missing_checkpoint` (readable rows a generator actually claimed that still record no model name), and `issue_counts.unattributed_sd_metadata` (readable rows that record generation data against no generator at all, which today's parser cannot produce, so the attribution is stale and a re-parse derives one). `unknown_generator` counts every readable row with no generator recorded — `''`, NULL or `'unknown'`, whitespace trimmed — which is the same predicate `unattributed_sd_metadata` is built from, so that key really is a subset of it. `'others'` is excluded from both: it is the parser's complete verdict that text was found and no detector claimed it. Do not render a `statistics` key as an issue or attach a fix to one.

Each entry in `recommendations` carries `{kind, severity, count}`, and `count` is the number of **distinct rows** the action visits, never the sum of the issue counters it covers: `reparse_or_reconnect` spans `unreadable` and `metadata_error` (largely the same rows, since marking a row unreadable also sets `metadata_status = 'error'`; a readable image whose metadata parse failed is in `metadata_error` alone), and `incomplete_scan_record` spans `missing_dimensions` and `missing_file_size`.

Clients should present this as guidance, not as an automatic cleanup operation. Use it to decide whether to re-import, re-parse, tag, or avoid flattening archives with duplicate filenames.

#### GET /api/system-info
Get local hardware summary and tagger runtime recommendation.

#### GET /api/system/ai-jobs
Get a live snapshot of the AI runtime scheduler (tiered semaphore). Returns `active`, `vram_active`, `cpu_active`, `cpu_pool_size`, and a `jobs` list of `{ label, tier }` for currently running AI work (tagging, censor detection, CLIP embedding). VRAM-tier work is mutually exclusive; CPU-tier work runs on a bounded pool so concurrent CPU jobs no longer serialize behind GPU work.

#### POST /api/browse-folder
List subdirectories for folder picker flows.

### Collections

#### GET /api/collections
List all collections, including the built-in **Favorites** collection. Each item includes `id`, `name`, `slug`, and `count`.

#### POST /api/collections
Create a collection from a `name`. The name is slugified and a numeric suffix is appended if the slug already exists, so creation never collides.

#### PATCH /api/collections/{collection_id}
Rename a collection. The display `name` changes while the stable `slug` is preserved so existing references keep working.

#### DELETE /api/collections/{collection_id}
Delete a collection. The built-in Favorites collection is protected and returns `400`.

#### GET /api/collections/{collection_id}/images
List the image ids that are members of the collection.

#### POST /api/collections/{collection_id}/items
Set collection membership for one image. Body carries `image_id` and a `member` flag (add when true, remove when false). Uses the reference model — no image files are copied. Returns `{ "member": bool }`.

#### POST /api/collections/{collection_id}/items/bulk
Set collection membership for many images in one call. Body carries either `image_ids` (explicit list) or `selection_token` (a token from `POST /api/images/selection-token` covering a filtered scope), plus a `member` flag. Favorites membership is diverted to the path-anchored favorites store. Returns `{ "success": bool, "added": int, "removed": int, "requested": int }`.

#### POST /api/collections/pinned
Store pictures as a hidden "show only these" set. JSON body `{"image_ids": [..], "purpose": "view"}` (at least one id, no upper limit; `purpose` is `view`, the default, or `token`). Returns `{"collection_id": 12, "count": 80}`; `count` is how many of the ids exist in the active library (duplicates, unknown ids and other libraries' pictures are left out). The set is an ordinary collection row with a `~pin-` slug: it is not listed by `GET /api/collections`, and the Gallery opens it with the existing `collection_id` filter, so listing, counting, selection tokens, bulk actions, Auto-Separate and Manual Sort all see exactly those pictures with no second filter. Hidden sets are not collections: `PATCH`, `DELETE`, `GET .../images` and `POST .../items[/bulk]` on `/api/collections/{id}` answer 404 for them, and `GET /api/collections` does not list them. A `view` set (`~pin-`) is what the Gallery opens; only the newest 8 per library are kept. A `token` set (`~tok-`) stands behind a selection token handed to another tool that pages through it lazily (Censor), so views never prune it; it is dropped 30 days after it was made.

#### DELETE /api/collections/pinned/{collection_id}
`{"deleted": true}`; `false` when there is no such hidden set in the active library (an ordinary collection is never deleted here).

#### GET /api/collections/pinned/{collection_id}
`{"exists": true, "collection_id": 12, "count": 80}`; `exists: false` (count 0, status 200) when the set was pruned or deleted, belongs to another library (`X-SD-Library-Id`), or is an ordinary collection. The Style Map banner uses it to say a set is no longer available instead of silently showing the whole Gallery.

#### GET /api/collections/favorites/ids
List the ids of all favorited images (plus `count`) for fast client-side heart-state hydration.

#### POST /api/collections/favorites
Set the favorite state of one image. Body carries `image_id` and `favorited` (default `true`; pass `false` to unfavorite). Returns `{ "favorited": bool }`.

### Entry Page

#### GET /api/entry/summary
Aggregate stats for the v4.0 mission entry page in one call: `library_total`, `added_today`, `unviewed` (images indexed after the `last_seen` watermark the client stored from a previous call's `server_now`), activity `streak_days` / `today_touched` (fed by the `activity_log` daily counters), and the deterministic daily ★5 `hero` pick (`hero_seed` query param offsets the pick for 换一张; `null` when no image is rated ★5).

#### GET /api/entry/hero-pool
Image ids for the entry page's slideshow / film-strip display modes (v3.5.0). Query: `limit` (1–200, default 60). Returns `{ids, starred, total}` — ★5-rated images first (the same pool the daily hero draws from), then the newest library images, so a fresh install with zero ratings still gets a living wall. The client renders them via the thumbnail endpoint.

### Model Manager

#### GET /api/models/status
Get local model/runtime readiness status.

A model the program's own folder lacks is served from a trusted copy when one
is recorded (`/api/models/sources/detect` keeps them in `CONFIG_DIR/model_sources.json`;
a ComfyUI install or a Hugging Face cache the user trusted). The own folder
always wins. Each card then carries `source`
(`{"kind": "comfyui"|"hf_cache"|"folder", "root", "path", "verify", "is_network", "size_bytes"}`,
`null` when the program's own file is used), the `wd14` card also `variant_sources`
(`{variant: source}`), and `path` points at the external file. The recorded file
is compared with the disk (size and mtime; a folder model by the sum of its
files) on every call. When it is gone or changed the card is `missing` with
`message_key` `models.external.gone` / `models.external.changed`,
`message_params` `{source, kind, path}` and a `message` that names the path; the loader
never picks another file instead. A file that is no longer under a trusted
folder is ignored. Files on a network path are not touched on this request
(served as recorded).

#### GET /api/models/mirror
Get the current download mirror preference.

#### POST /api/models/mirror
Set the download mirror preference (auto, hf-mirror, modelscope).

#### GET /api/models/trusted-folders
Trusted model folders (Model Center), the ComfyUI-style `extra_model_paths`
of this app: model files in them load exactly like files in the program's own
`models/` folders, full-pickle formats (a YOLO `.pt`, a generic torch `.pth`)
included. Stored in app settings; only this API changes the list (the request
guard keeps other sites and rebound hostnames away from it).

**Response:**
```json
{
  "folders": [
    {"path": "I:\\ComfyUI\\models", "kind": "local", "exists": true},
    {"path": "\\\\nas\\share\\models", "kind": "network", "exists": false}
  ],
  "program_folders": ["L:\\sd-image-sorter\\models", "L:\\sd-image-sorter\\data\\models"]
}
```

`program_folders` are the roots that are always allowed (`PROJECT_ROOT/models`,
`DATA_DIR/models`, then the configured `*_MODEL_DIR` settings as set, nothing
is created). A file is "inside" a root by resolved path semantics
(`is_relative_to`), never by string prefix. A network folder's `exists` is
`null`: it is never probed, so an offline NAS costs nothing (local files are
judged against local roots only; a network path is compared purely, by
`\\server\share` rules, against the trusted network folders).

#### POST /api/models/trusted-folders
Add a folder: `{"path": "...", "confirm": false}`. A local folder must exist
(400 otherwise). A network folder must be a well-formed `\\server\share\...`
(any slash spelling; `\\?\`, `\\.\`, `\??\`, `server@port` forms and an empty
share are 400) and is stored as written, never probed. A mapped network drive
(`Z:\models` pointing at `\\nas\share\models`) is stored as the share it
resolves to, so files on that drive are matched by the same share rule and the
list never has to touch the drive again. A very broad local folder (a drive
root, the home folder or its parent, `SystemRoot`, `Program Files`,
`ProgramData` or any folder inside them) answers
`400 {"error", "type": "ConfirmationRequired", "needs_confirm": true, "reason": "drive_root"|"share_root"|"home"|"users_root"|"system"}`
(`share_root`: a whole network share, e.g. a drive mapped to `\\nas\share`; on
Linux `/usr`, `/etc`, `/bin`, `/lib`, `/var` guard their subfolders while
`/opt` and `/srv` only guard themselves, so `/opt/ComfyUI/models` needs no
confirmation). A settings file that exists but cannot be read or parsed is
never overwritten in place: a file that cannot be read (locked by another
program) makes the change answer `503` with the reason and leaves the file as
it is; a file that is empty, not JSON or not an object (a power cut mid-write)
is kept as `app-settings.json.corrupt-<stamp>` beside it (warning logged) and
the change is saved into a fresh file. Every write goes through a temp file
that is flushed and fsync'ed before it replaces the settings file. `POST`/`DELETE`
here and `POST /api/disk/settings` answer `503 {"error": <reason>}` when the
write fails. `<reason>` is a short bilingual sentence without a path or an
errno (the page shows it as written; the path and errno go to the server
log): "The settings file is in use by another program. Close it and try
again." or "The settings file could not be read, so this change was not
saved.". The file is read as UTF-8 (a BOM is accepted); a file in another
encoding (GBK, UTF-16) counts as damaged and is set aside like invalid JSON.
`POST /api/disk/settings` fails only when the limit could not be saved; a
cleanup or stats failure after a successful save answers `200` with
`limit_cleanup_warning` (a short sentence) and an empty `limit_cleanup`.
until the same request is sent with `"confirm": true` (Model Center shows the
reason and asks). Duplicates (case-insensitive for UNC) are ignored. Answers
the same payload as `GET`.

Only this program's own page may change the list: a request with
`Sec-Fetch-Site` other than `same-origin`, or with an `Origin` on another port
than the socket's, is `403` ("信任清单只能在本程序的模型中心里修改"); another
local web app may still read it, and a non-browser client without `Origin` may
change it.

#### DELETE /api/models/trusted-folders
Remove a folder: `{"path": "..."}`; 404 when it is not in the list. Same
own-page rule as `POST`. Answers the same payload as `GET`.

Where the trusted folders apply (SEC1b / SEC1c):

- `/api/artists/identify`, `identify-batch`, `/api/style-map/vectors/start`
  with `model_source=local`: a `.pth`/`.pt` without `class_mapping.csv` beside
  it needs the full unpickler; that fallback runs only for a file inside the
  program's models folders or a trusted folder, elsewhere the safe load's
  failure is reported with the fix (trust the folder, add
  `class_mapping.csv`, or use `.onnx`).
- `/api/censor/detect` and `/api/censor/media/start` `model_path`: the file
  must lie inside those roots (400 otherwise); `/api/censor/models` probes a
  `.pt` for its class names only inside them.
- Any model-file path (artists, censor, custom tagger `.onnx` and its
  `tags_path`): a network path, in any spelling pathlib or Win32 reads as UNC
  (`\\s\x`, `//s/x`, `\/s/x`, `/\s\x`, `\??\UNC\...`, `..` collapsed), is
  refused before the file is touched unless it lies inside a trusted network
  folder. The checks run in this order: network rule, extension, allowed
  roots (all without touching the file), then the file checks, so a file
  outside the roots gets the same answer whether it exists or not. The YOLO
  load point itself (`censor.CensorDetector._load_with_ultralytics`) refuses
  a `.pt` outside the roots, whoever calls it. Library, export and move
  folders are not affected.

#### GET /api/models/download-progress
Get active model download progress (bytes downloaded, total size).

#### GET /api/models/sources/detect
Pinned models that already exist elsewhere on this PC, so the Model Center can
use them instead of downloading a second copy. Read-only: nothing in a ComfyUI
install or a Hugging Face cache is ever written; the chosen matches and the
drive-scan result are saved in `CONFIG_DIR/model_sources.json`.

Roots come from the trusted-folder list (`/api/models/trusted-folders`, in
list order), `COMFYUI_PATH`, Comfy Desktop's fixed install folders, the cached
depth-2 drive scan, and the Hugging Face caches (`HF_HUB_CACHE`,
`HF_HOME/hub`, the user's global `~/.cache/huggingface/hub` and each ComfyUI
install's `models/hub`).

`SD_IMAGE_SORTER_MODEL_SOURCE_DISCOVERY=0` (also `false`, `no`, `off`) switches
off the *automatic* finding: `COMFYUI_PATH` (and the untrusted-network hint for
it), the fixed install folders, the drive scan (no background thread starts,
`scan.status` stays `never`) and every Hugging Face cache location. Folders in
the trusted list, and the `models/hub` of a trusted ComfyUI, are still read.
The Playwright server (`tests/e2e/playwright.config.ts`) and the pytest suite
(`conftest.py`) set it, so the machine they run on, and its ComfyUI, cannot
change what Model Center shows or make the tests scan the user's drives.

A match is **adopted** (listed in `matches`, saved for the loaders) only when
`model_roots.is_under_allowed_model_root` accepts its path: the program's own
models folders or a trusted folder, the same rule the loaders apply, so a card
that says "ready" never points at a file the loader would refuse. Models found
in roots that are not trusted (an auto-detected ComfyUI, the global HF cache)
are returned as `suggestions`, one row per folder that would have to be
trusted, so the Model Center can ask "found ComfyUI with 8.5 GB usable, add
it?".

The request thread never touches a network path. Every root, every
`extra_model_paths` folder and every candidate folder is walked from the drive
root one component at a time with `lstat` + `readlink` (local metadata only):
a symlink or junction whose target is a network location (UNC in any spelling
including `\\?\UNC\...`, a mapped or removable drive, a Linux network mount)
turns a *trusted* entry into a pending network root and drops everything else
(`COMFYUI_PATH`, `HF_HUB_CACHE`, probed and cached roots, yaml folders). A
link to a local folder is followed; the root or folder is then reported by its
real path, which is the folder the user would have to trust. Network roots are
judged by the background job that also runs the drive scan; their cached
result is served with `network_pending: false` and `network_scanned_at`, or
`network_pending: true` while there is none, and a pending root without a
cached result starts a new background generation on its own when no job is
running (a NAS trusted later). The drive scan runs once per process on a
background thread; `rescan=1` only starts it again (never inline) and the
response carries the cache plus `scan.status = "running"`.

Response shape:

```json
{
  "sources": [
    {"path": "I:\\ComfyUI-aki-v1.6\\ComfyUI", "kind": "comfyui", "origin": "trusted",
     "is_network": false, "version": "0.36.0", "trusted": true, "model_count": 4,
     "network_pending": false, "network_scanned_at": null}
  ],
  "matches": [
    {"model_id": "wd14", "variant": "wd-eva02-large-tagger-v3",
     "path": "I:\\...\\wd-eva02-large-tagger-v3.onnx", "source": "I:\\ComfyUI-aki-v1.6\\ComfyUI",
     "folder": "I:\\ComfyUI-aki-v1.6\\ComfyUI", "source_kind": "comfyui", "origin": "trusted",
     "verify": "size", "size_bytes": 1260435999, "total_bytes": 1260744467, "mtime_ns": 0,
     "companions": ["I:\\...\\wd-eva02-large-tagger-v3.csv"], "notes": ["hash_skipped_large"],
     "trusted_rank": 0, "is_network": false, "trusted": true}
  ],
  "suggestions": [
    {"root": "C:\\Users\\me\\.cache\\huggingface\\hub", "kind": "hf_cache", "origin": "hf_default",
     "version": null,
     "models": [{"model_id": "florence2", "variant": "base", "verify": "revision", "size_bytes": 468554144}],
     "reusable_bytes": 468554144}
  ],
  "suggested_reusable_bytes": 468554144,
  "rejected": [
    {"model_id": "tipo", "variant": null, "path": "I:\\...\\TIPOv2-1B-A200M-Q8_0.gguf",
     "source": "I:\\ComfyUI-aki-v1.6\\ComfyUI", "reason": "version_mismatch", "detail": "..."}
  ],
  "reusable_bytes": 6780000000,
  "scan": {"status": "done", "scanned_at": 1790000000.0, "error": null, "completed_generation": 1,
           "roots": ["I:\\ComfyUI-aki-v1.6\\ComfyUI"]}
}
```

A ComfyUI folder given in `COMFYUI_PATH` that is on the network and not trusted
is never read, but `sources` lists it with `network_not_trusted: true`
(`trusted: false`, `model_count: 0`, `network_pending: false`; a pure string
check, nothing touches the network) so the Model Center can offer to trust it.
A recorded match that `detect` stops finding moves to `lost` in the index so the
card can keep saying its file is gone; a network match whose background result
is not in yet is kept as it was.

`kind`: `comfyui` | `hf_cache` | `folder`. `origin`: `trusted` | `env` | `probe` |
`scan` | `hf_default` | `comfyui_hub`. `folder` is the folder a suggestion would
ask the user to trust: the root, an `extra_model_paths` folder outside it, or
the real target of a junction/symlink inside it. Suggestions hold one copy per
model: models already adopted from a trusted place are not offered again, a
model found in several untrusted folders is offered once (best copy), and the
program's own `DATA_DIR/hf` cache is never offered. `suggested_reusable_bytes`
is the deduplicated total across all suggestion rows.
`verify` (strongest first): `sha` (SHA-256
equals the pin; files up to 500 MB on local disks, digests cached by size and
mtime), `revision` (Hugging Face snapshot folder named after the pinned commit
with every required file present), `size` (byte size equals the pin: big files
and network/removable drives), `name` (file name only, as the existing loaders
already accept: privacy YOLO by the `wenaka` convention, the aesthetic
backbone). `size_bytes` is the primary file; `total_bytes` adds its companion
files (tags csv, class mapping, samples) and is what `reusable_bytes` sums.
One match per `(model_id, variant)` is kept: trusted-list order,
then `sha`/`revision` over `size` over `name`, then local disk over network.
`rejected.reason`: `size_mismatch`, `sha_mismatch`, `missing_companion`,
`companion_mismatch`, `incomplete`, `version_mismatch` (another build, e.g. an
older TIPO; never adopted), `unverified` (a YOLO file whose classes were not
checked; listed as a candidate only), `unreadable` (the file could not be
opened or hashed; the other candidates are still judged). `scan.status`:
`never` | `running` | `done` | `error`; `running` while any scan generation is
still going, and an older generation never overwrites a newer result. Only the
WD14 runtime family of taggers is matched (OppaiOracle is not). The
`CONFIG_DIR/model_sources.json` index is quarantined as `.bak` when it cannot
be parsed, discarded when its `version` is not the one this build writes, and
a malformed cached network result is logged and treated as pending; the
endpoint keeps answering in every case.

#### GET /api/models/bulk-bundle
Inventory of models available to the selectable bulk-download flow. Florence-2
Base and Lucida are recommended defaults for local captions and training masks;
CL Tagger v2 is listed as optional and is never selected by default because its
official Hugging Face repository is gated.

Returns each model with its current ready/missing status and estimated
download size, recommendation/default-selection flags, feature key, and
restart/auth requirements. `pending_total_bytes` includes all missing entries;
`recommended_pending_total_bytes` and `optional_pending_total_bytes` split the
estimate for the initial selection. The frontend uses these fields to render a
checkbox confirmation dialog before sequential preparation.

Response shape:

```json
{
  "items": [
    {
      "id": "wd14",
      "label": "WD14 Tagger (default swinv2-tagger-v3)",
      "size_bytes": 467664896,
      "status": "ready",
      "name": "WD14 Tagger",
      "group": "tagger",
      "variant": "wd-swinv2-tagger-v3",
      "feature_key": "tagging",
      "recommended": true,
      "optional": false,
      "default_selected": true,
      "gated_download": false,
      "requires_auth": false,
      "restart_after_install": false
    },
    {
      "id": "cl-tagger-v2",
      "label": "CL Tagger v2 (gated optional tagger)",
      "size_bytes": 2899102924,
      "status": "missing",
      "name": "CL Tagger v2",
      "group": "Tagging",
      "variant": "v2_00",
      "feature_key": "tagging",
      "recommended": false,
      "optional": true,
      "default_selected": false,
      "gated_download": true,
      "requires_auth": true,
      "auth_url": "https://huggingface.co/cella110n/cl_tagger_v2",
      "restart_after_install": true
    }
  ],
  "pending_total_bytes": 7807402393,
  "recommended_pending_total_bytes": 4964309469,
  "optional_pending_total_bytes": 2899102924,
  "all_total_bytes": 10712412393,
  "excluded": [
    {"id": "censor-legacy", "reason": "Privacy YOLO remains opt-in."},
    {"id": "toriigate", "reason": "Heavy alternative captioner."},
    {"id": "oppai-oracle", "reason": "Alternative tagger."}
  ]
}
```

#### GET /api/models/plan
Read-only preview of what preparing a model would install. Query: `model_id`. Returns `{model_id, packages, restart_likely}`: `packages` lists the Python requirements still missing for that model's feature; `restart_likely` is true when one of them is already imported in this process or when Windows will swap torch for its CUDA build (ToriiGate, SAM3). Models without an optional dependency group return an empty list. Nothing is installed or downloaded; the first-use confirm uses it to say "ready once downloaded" or "one restart afterwards".

#### POST /api/models/prepare
Starts model/runtime preparation in a background worker.

The request returns immediately with HTTP 200:

```json
{
  "status": "downloading",
  "model_id": "sam3",
  "message": "Download started in background."
}
```

Poll `GET /api/models/download-progress` and read `prepare_result` for completion, warnings, or actionable errors.

Structured errors can include:

- `error`
- `error_type`
- `message`
- `provider`
- `manual_steps`
- `target_dir`
- `external_url`

`UnsupportedPlatformRuntime` keeps macOS core/ONNX features available while providing persistent steps for unsupported Torch or SAM3 runtimes.

### Censor

#### POST /api/censor/media/list
Body `{"folder": "..."}`. GIFs and videos directly in the folder:
`{gifs: [paths], videos: [paths], video_ready}`; `video_ready` says whether the
optional ffmpeg component (Model Center card `video-ffmpeg`) is installed.

#### POST /api/censor/media/start
Auto-censor every GIF (and, with `include_videos` and ffmpeg ready, every
video) in `folder` into `output_folder` (default: the `video-censor` folder
under the output root, see Output folders; outputs
are `<name>_censored.gif` / `.mp4`, never replacing a file). Detector settings
mirror `/api/censor/detect` (`model_type` nudenet / legacy / both,
`model_path`, `confidence`, `target_classes`, `face_guard`, `shape`,
`expand_percent`; a named `model_path` follows the detect rule, i.e. it must
lie inside the program's models folders or a trusted model folder and a
network path outside one is 400 before the file is touched) plus `style`
(mosaic / blur / black), `block_size` (0 =
Auto), `detect_every` (run the detector on every Nth frame) and `hold` (keep
the last regions that many frames after they vanish). Returns the job snapshot
with `job_id`. Jobs run one at a time in the background.

#### GET /api/censor/media/jobs/{job_id}
Job snapshot: `{status, files: [{name, status, frames_done, frames_total,
censored_frames, output, error}], done, total}`; status is queued, running,
done, done_with_errors or cancelled.

#### POST /api/censor/media/jobs/{job_id}/reveal/{index}
Show that file's output in the OS file manager.

#### POST /api/censor/media/jobs/{job_id}/cancel
Stop after the current frame; unfinished files are marked skipped.

#### POST /api/censor/detect
Run censor detection.

`face_guard` (default `true`) drops pussy / anus / breasts detections that lie
mostly (>= 50%) on a face found by the anime face model, when that model is
installed; penis and cum are never dropped. The response carries
`face_guard: {active, faces, dropped}`.

`shape` is `precise` (default: model outline, else box), `box`, `ellipse`
(plain boxes become an inscribed ellipse) or `fit` (plain boxes are traced
with GrabCut; an ellipse where the trace fails, with a warning).
`expand_percent` (0-100, default 0) grows every region by that share of its
own size; returned boxes and polygons are the grown ones.

`model_type` accepts `legacy`, `nudenet`, `sam3`, or `both`. Every successful
response includes `warnings: string[]`. In `both` mode, one detector may fail
while the other still returns usable detections; that partial result remains
HTTP 200 and `warnings` names the failed detector and cause. If neither
detector completes, the endpoint returns a non-2xx actionable error containing
both failure causes. A clean run with zero detections remains a successful
response with `warnings: []`.

Optional `upright` (bool, default false): when true the image's EXIF orientation is applied first, so boxes, masks (including cached masks) and the reported `image_width`/`image_height` are in the upright frame a browser shows (the V4 and V3.5 editors send it). Omitted keeps the file's raw pixel frame.

#### POST /api/censor/preview
Preview censoring.
Opaque previews return JPEG data URLs. Sources with transparency return PNG data URLs so alpha survives; the MIME prefix always matches the encoded bytes.

#### POST /api/censor/save
Save censored output to disk.
The decoded source format determines the output bytes and extension: JPEG stays `.jpg`, WebP stays `.webp`, and unsupported source formats are saved as PNG. PNG/WebP alpha is preserved.

#### POST /api/censor/save-data
Save edited base64 canvas output.

All three save routes (`save-data`, `save-original`, `save-operations`) accept a blank `output_folder`, which means the `censor` folder under the output root (see Output folders), and `name_conflict: error|unique|skip` (default `error`). Without `allow_overwrite`, `error` refuses an existing name (409), `skip` leaves the existing file and returns `skipped: true`, and `unique` saves under the first free `name`, `name_2`, `name_3`, ... (the name is claimed atomically, so concurrent saves never share it). Responses carry `output_path`, `filename`, `warnings`, `skipped`, `overwrote_existing`, `overwrote_indexed_path`, `reconciled_image_id`.


#### POST /api/censor/save-original
Save an image the user did not edit, read straight from its source file (reorder-and-rename exports from the censor queue). Body: `{original_image_id, filename, output_folder, metadata_option: keep|minimal|strip, output_format: original|png|jpg|jpeg|webp, allow_overwrite}`. With `output_format: original` and `metadata_option: keep` the source file is copied byte for byte; otherwise it is re-encoded on the server. An existing target is not replaced unless `allow_overwrite` is true (409). Does not count toward the censor activity stat. Returns the same shape as `/api/censor/save-data`.

#### POST /api/censor/save-operations
Save a non-destructive edit operation list on top of the original image.

#### POST /api/censor/refine-mask
Refine mask with SAM3.

Optional `sam3_confidence` (float 0.0–1.0): rejects low-confidence refinements — applied as both the mask score threshold and the text-prompt presence gate. Omitted = legacy thresholds. Rejected boxes return `status: "fallback"` (bounding-box censor).

Optional `upright` (bool, default false): when true the image's EXIF orientation is applied first, so boxes, masks (including cached masks) and the reported `image_width`/`image_height` are in the upright frame a browser shows (the V4 and V3.5 editors send it). Omitted keeps the file's raw pixel frame.

#### POST /api/censor/batch-refine-mask
Refine multiple masks with SAM3.

Accepts the same optional `sam3_confidence` at the batch level (the censor editor's confidence slider sends this); each item may override it with its own `sam3_confidence`. Optional batch-level `upright` (see `refine-mask`) applies to every item; an item may also set its own.

#### POST /api/censor/segment-text
Segment via text prompt with SAM3.

Body: `image_id` (int), `text_prompt` (string), optional `presence_threshold` (float 0.0–1.0). The presence gate defaults to a looser explicit-text value, decoupled from the stricter 0.5 auto-detect gate, so deliberately-typed prompts are not silently rejected; pass `presence_threshold` to override (higher = stricter recall).

Optional `upright` (bool, default false): when true the image's EXIF orientation is applied first, so boxes, masks (including cached masks) and the reported `image_width`/`image_height` are in the upright frame a browser shows (the V4 and V3.5 editors send it). Omitted keeps the file's raw pixel frame.

#### POST /api/censor/remove-background
Remove the image background with SAM3 foreground detection.

Body: `image_id` (int), `fill_mode` (`transparent`, `white`, or `black`), optional `edge_threshold` (float 0.0–1.0). Returns a base64 preview image; transparent mode returns PNG data with an alpha channel.

#### GET /api/censor/mask-cache/{mask_ref}
Retrieve a cached mask image by reference.

#### GET /api/censor/models
List available censor backends.

Returns the installed legacy model files, whether they look like privacy-part detectors or fixed-class general object models, the capabilities the UI should explain to users, and the backend the UI should recommend by default.

### Similarity

#### POST /api/similarity/embed
Start embedding generation.

#### GET /api/similarity/progress
Get embedding progress.
The response also includes richer counters and recent issue details:

- `embedded`
- `skipped`
- `unreadable`
- `failed`
- `recent_issues`

#### GET /api/similarity/search/{image_id}
Find similar images by image ID.

#### POST /api/similarity/search-text
Semantic text-to-image search (v3.5.x, competitive roadmap #1). Body: `{query (1-512 chars), limit?: 100, threshold?: 0.0, offset?: 0, collection_id?}`. Embeds the natural-language query with the CLIP TEXT tower paired with the image-embedding model (`Qdrant/clip-ViT-B-32-text`, the same ViT-B/32 checkpoint and 512-dim space as the stored embeddings; text ONNX ~243 MB, vision+text pair ~580 MB) and ranks embedded images by cosine. Cross-modal scores run far lower than image-image scores (matches ≈ 0.2-0.35), so the default threshold is 0.0 = pure top-k ranking. Requires images to be embedded (`POST /api/similarity/embed`). 503 while the text model is unavailable. Returns the upload-search shape plus `query`: `{query, results, count, total, has_more, offset, limit}`.

#### POST /api/similarity/search-upload
Find similar images by uploaded file.

#### GET /api/similarity/duplicates
Find near-duplicate pairs.

#### GET /api/similarity/stats
Get embedding statistics.

#### GET /api/similarity/model-status
Get local CLIP runtime readiness and the preferred local model path. Includes `message_key` (an i18n key such as `models.clip.missingModel`) alongside the English `message` so the frontend can localize the status detail.

#### GET /api/similarity/compare
Compute the CLIP cosine similarity (0.0-1.0) between two stored, embedded images (query params `id_a`, `id_b`).

#### GET /api/similarity/near/{image_id}
Return the top-K most similar images to one image (highest cosine first, no threshold, ANN-accelerated) — a one-click "find this image's closest matches" action.

### Prompt Lab

#### GET /api/prompts/categories
Get categories.

#### GET /api/prompts/category/{name}
Get one category.

#### POST /api/prompts/categorize
Categorize prompt terms.

#### POST /api/prompts/recategorize
Re-categorize prompt terms.

#### GET /api/prompts/sets
Get tag sets.

#### POST /api/prompts/sets
Create or update a prompt set.

#### DELETE /api/prompts/sets/{set_ref}
Delete a prompt set.

#### GET /api/prompts/exclusions
Get exclusion rules.

#### POST /api/prompts/exclusions
Create or update an exclusion rule.

#### DELETE /api/prompts/exclusions/{rule_ref}
Delete an exclusion rule.

#### POST /api/prompts/generate
Generate one or more prompts.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `character` | string | null | Character tag |
| `outfit` | string | null | Outfit category or tag |
| `pose` | string | null | Pose category or tag |
| `expression` | string | null | Expression category or tag |
| `angle` | string | null | Camera angle |
| `background` | string | null | Background type |
| `style` | string | null | Art style |
| `artist` | string | null | Artist style |
| `body` | string | null | Body features |
| `quality_preset` | string | "high" | Quality level (high/medium/low/none) |
| `count_tag` | string | "1girl" | Character count tag |
| `nsfw` | bool | false | Include NSFW tags |
| `include_negative` | bool | true | Generate negative prompt |
| `seed` | int | null | Random seed for reproducibility |
| `count` | int | 1 | Number of prompts to generate (1-20) |
| `categories` | object | {} | Manual Prompt Lab slots: `{<category>: {tags, weight, locked}}` |
| `tag_sets` | array | [] | Tag set ids/names to apply: required members always, optional members drawn by their weight from the seeded generator (also with `categories`; the slot tags themselves are kept as given) |

Response: `positive_prompt`, `negative_prompt`, `prompt` (alias of `positive_prompt`), `tags_used`, `exclusions_applied`, `warnings` and `random_part` (false when nothing was drawn, e.g. slots only: then the seed and `count` cannot change the prompt) describe the first generated prompt, plus `count` (prompts actually generated) and `prompts` (array of per-prompt objects with the same fields, length == `count`). With a fixed `seed` and `count > 1`, prompt slot `i` uses `seed + i`, so the batch is varied but reproducible.

#### POST /api/prompts/validate
Validate prompt conflicts.

#### GET /api/prompts/presets
List presets.

#### POST /api/prompts/presets
Create preset.

#### DELETE /api/prompts/presets/{preset_id}
Delete preset.

#### GET /api/prompts/stats
Get Prompt Lab statistics.

#### GET /api/prompts/compare
Compare prompt generation options.

### Artists

Only a `confidence_level` of `high` is an identification; everything below it is an unconfirmed suggestion. Roughly two thirds of a typical Danbooru-sourced library falls outside the model's artist vocabulary entirely.

**Confidence tiers.** Measured on 250 ground-truth images against the shipped Kaloscope weights:

| `confidence_level` | top-1 score | measured precision | out-of-vocabulary share |
|---|---|---|---|
| `high` | >= 0.20 | 92% | 6% |
| `low` | 0.03 - 0.20 | 28% | 65% |
| `none` | < 0.03 | 2% | 97% |

Only the `high` tier ever puts a real name in `artist` (and in the `artist_predictions` table). The `low` tier returns the guess in `candidate_artist` for the user to confirm. The request-level `threshold` can only tighten this — it cannot make the backend assert a guess.

#### POST /api/artists/identify
Identify artist for one image.

**Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `image_id` | int | required | Image ID to identify |
| `threshold` | float | 0.03 | Extra confidence floor (0.0-1.0); tightens only |
| `top_k` | int | 5 | Number of top predictions to return (1-20) |
| `model_source` | string | `huggingface` | `huggingface`, `modelscope` or `local` |
| `model_path` | string | null | Local checkpoint, read only when `model_source=local` (ignored, set to null, for `huggingface`/`modelscope`): must end in `.pth`, `.pt` or `.onnx` and, if a network (UNC) path, lie inside a trusted model folder (both checked before the file is touched), and must exist; 400 otherwise. The existence check runs in the threadpool, not while the request body is parsed, so a trusted NAS that is offline delays only this request (about one SMB timeout), never the rest of the app. A `.pth`/`.pt` without `class_mapping.csv` beside it loads only from the program's models folders or a trusted folder (see `/api/models/trusted-folders`) |

**Response:**
```json
{
  "image_id": 1,
  "artist": "greg_rutkowski",
  "confidence": 0.78,
  "confidence_level": "high",
  "candidate_artist": "greg_rutkowski",
  "out_of_vocabulary_likely": false,
  "vocabulary_size": 39261,
  "advisory": "Confident match. ...",
  "top_predictions": [
    {"artist": "greg_rutkowski", "confidence": 0.78},
    {"artist": "alphonse_mucha", "confidence": 0.45}
  ],
  "model_loaded": true
}
```

A low-confidence result instead returns `"artist": "undefined"`, `"confidence_level": "low"`, and the guess in `candidate_artist`.

#### POST /api/artists/identify-batch
Start batch identification.

**Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `image_ids` | int[] | required | List of image IDs |
| `threshold` | float | 0.03 | Extra confidence floor; tightens only |
| `top_k` | int | 5 | Number of predictions per image |
| `model_source`, `model_path` | | | Same rules as `POST /api/artists/identify` |

Each `results[]` entry carries `artist`, `confidence`, `confidence_level`, and `candidate_artist`.

#### GET /api/artists/batch-progress
Get identification progress.
The response includes step-oriented status fields such as `message`, `current_item`, `started_at`, and `updated_at` for frontend diagnostics. `message` is an English display string kept for API compatibility; clients localise from `message_key` (`preparing`, `loading_runtime`, `identifying`, `identifying_item`, `done`, `error`) and the counters, and `message_detail` carries the raw error text for `error`.

#### GET /api/artists/models
List artist models.


#### GET /api/artists/diagnostics
Get Kaloscope / LSNet runtime diagnostics for the frontend banner.

#### GET /api/artists/stats
Get artist stats. `undefined_count`, `low_confidence_count` and `confident_count` are disjoint and sum to `identified_images`. `artist_counts` / `artist_stats` cover only confident rows; `low_confidence_artist_counts` holds the rest, including labels written before tiering existed.

#### GET /api/artists/images/{artist_name}
List images associated with an artist prediction. Each entry carries a `confidence_level` derived from its stored confidence, so pre-tiering labels are still marked as suspect.
Only images of the current library (`X-SD-Library-Id`) are listed and counted in `total`, the same scope as `GET /api/artists/stats`.

#### GET /api/artists/list
Get the loaded model's artist list. `vocabulary_loaded` is false (and `artists` empty) until a real label source is loaded.

#### GET /api/artists/vocabulary
Check whether specific artists exist in the loaded model's answer set.

**Parameters:** repeat `name` per artist, e.g. `?name=ko_yu&name=sakura_shiori`.

**Response:**
```json
{"vocabulary_size": 39261, "vocabulary_loaded": true, "known": {"ko_yu": true, "sakura_shiori": false}}
```

An artist that is absent can never be predicted, so every identification over their images will name somebody else.

#### DELETE /api/artists/clear
Clear the artist predictions of the current library's images (`X-SD-Library-Id`); other libraries keep theirs. Returns `message` and `cleared` (rows removed). 409 while a batch runs.

### Style Map

Style vectors are the 2048-d feature the Kaloscope 2.0 classifier scores from
(the `head.bn` output of the LSNet model), stored per image in
`image_style_vectors` as an L2-normalised float16 blob together with the
weights version (`model_version`) and the pixel digest (`content_fingerprint`)
they were computed from. Two spaces have an index job: `kaloscope` and `csd`
(the 768-d style embedding of CSD-ViT-L, an optional 2.44 GB model prepared in
the Model Center as `csd`; license CC-BY-4.0, pinned to one Hugging Face
commit and checked by SHA-256; it needs torch and open_clip, the Aesthetic
runtime group). CLIP vectors stay in `images.embedding` (see Similarity) and
are not copied. A picture has at most one row per space, so the spaces never
overwrite each other.

The extraction job is a background task (see Background Tasks): one job at a
time, scoped to the current library (`X-SD-Library-Id`). It processes only
images that have no vector for the space, or whose vector came from other
weights or other pixels (a rescan recorded a different fingerprint). It can be
paused, resumed and cancelled between images. The model must already be
prepared in the Model Center; the job never downloads anything, and a model
that is not Kaloscope (ONNX / transformers) or fails to load ends the job with
`step: "error"` before any image is touched.

`model_version` is `kaloscope:<checkpoint>:head.bn` for the pinned official
weights, or `kaloscope-local:<sha256[:16]>:head.bn` for a local `model_path`
(a local copy whose digest matches the pinned file shares the official name).
For `csd` it is `csd:vit-l-14:<sha256[:12]>` of the pinned file; `model_source`
and `model_path` are ignored there. A `csd` job never writes artist predictions
(`with_artist` is ignored) and ends with `step: "error"` and an explaining
message when the CSD model is not prepared or does not fit the GPU.

#### POST /api/style-map/vectors/start
Start style-vector extraction for the pending images of the current library.

**Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `space` | string | `kaloscope` | Vector space: `kaloscope` or `csd` |
| `image_ids` | int[] | null | Restrict the job to these images (1-5,000,000 positive IDs); omit for the whole library |
| `selection_token` | string | null | Restrict the job to the current Gallery filter: a token from `POST /api/images/selection-token`, decoded and expanded on the server (the style map page sends this, so no id list travels). Exclusive with `image_ids` |
| `model_source` | string | `huggingface` | `huggingface`, `modelscope` or `local` (same contract as `/api/artists/identify`) |
| `model_path` | string | null | Local checkpoint, `.pth`/`.pt`/`.onnx`; required (and must exist) when `model_source` is `local`, ignored (null) otherwise. Any other file name, or a network path outside a trusted model folder, is 400 before the file is looked at; a `.pth`/`.pt` without `class_mapping.csv` loads only from the program's models folders or a trusted folder |
| `use_gpu` | bool | null | `null` = the Style Finder default (`ARTIST_USE_GPU`); `false` forces CPU |
| `with_artist` | bool | `true` | Also write the Style Finder's artist prediction (`artist_predictions`, same model, threshold and row format as `/api/artists/identify`) from the same forward pass, in the same transaction as the vector; `false` writes vectors only. Only pictures the job actually runs the model for get a prediction: a picture whose stored vector still fits (`kept`) is not re-identified, so to add predictions for an already indexed library use the Style Finder page's batch (`POST /api/artists/identify-batch`). A picture the job does run overwrites its existing prediction row with `threshold` and `top_k` 5 (the Style Finder page sends a fixed `top_k` of 5) |
| `threshold` | float | `0.03` | Confidence floor for the stored artist prediction, 0.0-1.0 (same field and range as `/api/artists/identify-batch`). The style map page sends the Style Finder page's slider value, so the index writes the rows an identify-batch at that setting would write: above 0.20 it decides whether a confident match is stored by name or as `undefined`. Ignored when `with_artist` is `false` |

**Response:**
```json
{"status": "started", "total": 128, "space": "kaloscope"}
```

`status` is `idle` with `total: 0` when nothing is pending (no job is queued).

**Errors:** 409 when a job is already running; 400 for an unknown `space`,
empty or non-positive `image_ids`, `image_ids` together with
`selection_token`, an invalid `selection_token`, a `threshold` outside
0.0-1.0, a `local` source without a `model_path`, or a `model_path` that is
not a `.pth`/`.pt`/`.onnx` file, is missing or cannot be read.

#### GET /api/style-map/vectors/progress
Poll the running (or last) job.

**Response:**
```json
{
  "running": true,
  "paused": false,
  "space": "kaloscope",
  "total": 128,
  "processed": 40,
  "written": 37,
  "kept": 2,
  "errors": 1,
  "step": "extracting",
  "message": "Extracting img_0041.png",
  "current_item": "img_0041.png",
  "started_at": 1790747286.3,
  "updated_at": 1790747304.6,
  "recent_issues": ["img_0007.png: Image file not found for image 7"]
}
```

`written` counts vectors stored by the model in this run, `kept` counts images
whose stored vector was confirmed still valid without running the model (the
scan had forgotten the fingerprint but the pixels were unchanged), `errors`
counts images that failed (one bad image never stops the batch; the last ten
reasons are in `recent_issues`). `step` is one of `idle`, `queued`,
`loading_runtime`, `extracting`, `done`, `cancelled`, `error`; a run in which
every image failed ends as `error`, not `done`.

#### POST /api/style-map/vectors/pause
Pause the running job after the current image. Returns `{"status": "paused"}`
or `{"status": "not_running"}`.

#### POST /api/style-map/vectors/resume
Resume a paused job. Returns `{"status": "resumed"}` or `{"status": "not_running"}`.

#### POST /api/style-map/vectors/cancel
Cancel the running job after the current image (also while paused, or before
the worker has loaded the model). Returns `{"status": "cancelled"}` or
`{"status": "not_running"}`.

#### GET /api/style-map/vectors/stats
Coverage of one space over the current library's readable images. Builds no
model.

**Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `space` | string | `kaloscope` | Vector space: `kaloscope` or `csd` (400 otherwise) |
| `model_source` | string | `huggingface` | `huggingface`, `modelscope` or `local`: the user's Style Finder model setting |
| `model_path` | string | null | Local checkpoint, `.pth`/`.pt`/`.onnx` (required and must exist when `model_source` is `local`, 400 otherwise; any other file name is 400 before the file is looked at; ignored unless `model_source` is `local`). A local file names its own vector version, so a local-model user's vectors are not counted as `other_version` |

**Response:**
```json
{
  "space": "kaloscope",
  "model_version": "kaloscope:448-90.13/best_checkpoint.pth:head.bn",
  "images": 12853,
  "vectors": 50,
  "pending": 12803,
  "stale": 0,
  "other_version": 0
}
```

`pending` = images the next `start` would process; `stale` = vectors whose
fingerprint no longer matches the image row (or the row has none);
`other_version` = vectors computed by different weights.

#### GET /api/style-map/points
One 3-D point per picture of the current Gallery filter, for the style map.

**Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `space` | string | `kaloscope` | `kaloscope` (style vectors of the weights the user's Style Finder settings name: the official ones, or a local checkpoint), `clip` (`images.embedding`, the Similarity index) or `csd` (the CSD style index; one pinned model, so no model settings apply) |
| `selection_token` | string | null | A token from `POST /api/images/selection-token`: the whole Gallery filter contract, the same one `selection-ids`, `count` and the bulk actions read. Omit it for the whole current library (`X-SD-Library-Id`) |
| `refresh` | bool | false | Recompute even when a cached layout exists (the result replaces the cache entry) |
| `model_source` | string | `huggingface` | The user's Style Finder model setting (`huggingface`, `modelscope`, `local`); the page sends the same settings the Style Finder uses, in the `kaloscope` space only |
| `model_path` | string | null | Local checkpoint, `.pth`/`.pt`/`.onnx` (required and must exist when `model_source` is `local`, 400 otherwise; any other file name is 400 before the file is looked at). Read only when `space` is `kaloscope` and `model_source` is `local`, ignored otherwise. It names its own vector version, so the map shows the vectors of the weights the user runs; maps of other weights are separate cache entries |

**Response:**
```json
{
  "status": "ok",
  "space": "kaloscope",
  "method": "pca",
  "model_version": "kaloscope:448-90.13/best_checkpoint.pth:head.bn",
  "total_images": 12853,
  "missing_vectors": 120,
  "unlocatable": [4021, 9877],
  "merged_away": 431,
  "explained_variance": [0.0557, 0.0395, 0.0285],
  "points_layout": ["id", "x", "y", "z", "members"],
  "points": [[17, -0.412, 0.088, 0.301, 1], [23, 0.155, -0.720, 0.044, 3]],
  "umap": {
    "status": "queued",
    "points": 12302,
    "min_points": 21,
    "params": {"n_neighbors": 15, "min_dist": 0.1, "metric": "cosine", "input_dim": 64, "random_state": 0},
    "queued_at": 1790000000.0
  },
  "map_id": "3f1c9a7e5b2d4c6a8e0f1a2b3c4d5e6f",
  "cached": false
}
```

`map_id` is the handle of this cached map (a digest of its cache key: library,
space, weights, filter set and vector version). `regions` and `colors`
accept it and then read that map directly, without running the filter query
again, so a picture arriving meanwhile (a scan, the index job) cannot turn
their answer into another map or a recompute; once the map is evicted (the
newest 8 are kept) or the handle is sent under another library, they answer
`not_started` and the page asks for `points` again.

`points` is a compact array (about 30 bytes per point): the representative
picture's `id`, its coordinates scaled to [-1, 1] and rounded to 3 decimals
(the three principal axes when `method` is `pca`, the UMAP embedding when it
is `umap`), and `members`, how many pictures the point stands for.

`method` is `pca` until the optional UMAP layout is ready. UMAP (umap-learn,
the Model Center card `style-map-umap`, install group `umap`, ~90 MB) makes
pictures placed together really look alike (measured kNN recall@10 0.38 vs
0.12 for the principal axes on the owner's library). Because a fit takes
seconds to a minute and its first use in a process pays a 15-20 s import and
JIT cost, the PCA map is returned at once and the fit runs in the background:
`umap.status` is `unavailable` (not installed; `umap.install` names the card
and packages), `too_few_points` (fewer representatives than `min_points`;
the map stays PCA), `queued`, `computing`, `ready` (`source` is `memory` or
`disk`, `elapsed_s` the fit time) or `failed` (`error`; `refresh=true`
retries). Poll `layout-status` or `points` again; once ready, `points`
carry the UMAP coordinates and `method` is `umap` (`explained_variance`
still describes the principal axes). The fit uses only the representatives
(after the near-duplicate merge, without the unlocatable pictures),
projected on the first `params.input_dim` principal axes, with a fixed
`random_state`, so the same data gives the same map. Ready layouts are kept
in memory and on disk under `state/style-map/` (the newest 4 per library and
space, 64 MB in all), keyed by the same cache key plus `params`, so a restart
does not refit; one fit runs at a time and further maps queue behind it. Pictures linked by cosine > 0.95 form one connected group (single
linkage: every member has such a link to some other member, so a member and
the representative can be further apart than 0.95); the representative is the
smallest id of the group and `merged_away` counts the pictures folded away.
`unlocatable` lists the pictures whose unit vector is dominated by one
component (> 0.5, a few broken renders the model answers with a single huge
activation); they are not placed and do not take part in the fit.
`missing_vectors` counts pictures of the filter that have no vector for this
space (run `vectors/start`, or the Similarity index for `clip`). The three
axes are fitted on every placeable picture of the filter and
`explained_variance` is the share of variance on each; `points` carries the
coordinates of the representatives. `status` is `ok`, `empty` (the filter
matches nothing) or `no_vectors` (nothing placeable); the last two return an
empty `points`.

The layout is cached per (library, space, model version, the sorted list of
filtered picture ids, vector version). The vector version is the row count,
the sum of image ids and the latest `updated_at` of the space's vectors
(written with millisecond precision, so a rewrite inside the same second is
seen; `clip` uses count, sum and max of the embedded ids). A picture entering
or leaving the filter changes the id list; `refresh=true` bypasses the cache.
`cached` says whether the response came from the cache. One layout is
computed at a time; a concurrent request for the same map waits for it and
then reuses it. The `kaloscope` map follows the weights named by
`model_source`/`model_path` (the Style Finder settings); each set of weights
has its own map and cache.

**Errors:** 400 for an unknown `space`, an invalid `selection_token`, or a
`model_path` that is not a `.pth`/`.pt`/`.onnx` file, is missing or cannot be
read (`kaloscope` space with `model_source=local` only).

#### GET /api/style-map/layout-status
The `umap` field of `points` for the same `space`, `selection_token`,
`model_source` and `model_path`, without computing the PCA map:
`{"space", "method", "umap"}` where `method` is `umap` once the layout is
ready and `pca` otherwise. Before `points` ran for this filter (in this
process, or in an earlier one that left the layout on disk) `umap.status` is
`not_started`. Cheap enough to poll every few seconds while a layout is
`queued` or `computing`.

**Parameters:** `space`, `selection_token`, `model_source`, `model_path` as for `points`.

**Errors:** 400 for an unknown `space`, an invalid `selection_token`, or a
`model_path` that is not a `.pth`/`.pt`/`.onnx` file, is missing or cannot be
read (`kaloscope` space with `model_source=local` only).

#### GET /api/style-map/regions
Regions of the map `points` last returned for the same `space` and
`selection_token`: a fixed-seed k-means (k = round(sqrt(n/30)) clamped to
6..12) on the coordinates the page shows (the UMAP layout once `ready`,
the PCA axes before; `method` says which). Each region carries its centre,
`size` (points), `members_total` (pictures including merged near-duplicates),
1-2 `representatives` (image ids nearest the centre, the second one visibly
different), `tagged` (points the tagger has seen) and two kinds of labels:

- `tags`: WD14 style tags from a fixed whitelist (rendering / medium words
  such as `monochrome`, `sketch`, `pixel_art`), counted over the region's
  TAGGED points only. A (region, tag) pair is tested when at least 4 points
  carry the tag and the region has at least 10 tagged points; the
  hypergeometric tail p (computed with `math.lgamma`, no scipy) of every
  tested pair of the map goes through a Benjamini-Hochberg correction and the
  label needs `q` < 0.01 plus an effect: `ratio` (region rate / map rate)
  >= 3, or `rate` >= 0.6 with `rate` at least 0.25 above the map's (for a
  style that is a large share of the whole map, where the ratio cannot reach
  3). At most two per region, ordered by `q`.
- `artists`: the Style Finder's confident tier only (`artist_predictions`
  with confidence >= 0.20, never `undefined`). The region needs at least 5
  confident points and at least 5% of its points confident (`high_total`);
  then an artist is reported when it covers >= 25% of those with at least 3
  points; at most two.

Regions of most libraries carry no label (a region without a distinctive
style tag or a dominant artist is normal); the representatives are the label
then. `status` is `not_started` until `points` ran for this map in this
process. Cached in memory per layout key and method together with a label
version (row counts and newest ids of `tags` and `artist_predictions`), so a
tagging run or a Style Finder batch after the map was built is picked up on
the next request (`cached` is `true` only on an unchanged repeat); dropped
whenever the layout is. One computation per map runs at a time.

**Parameters:** `space`, `selection_token`, `model_source`, `model_path` as for `points`; `refresh=true`
recomputes even when the cache is current; `map_id` (the handle a `points`
answer carried, 32 hex characters, 400 otherwise) names that cached map
directly instead of locating it from the filter (`not_started` once it is
evicted or belongs to another library).

**Response:**
```json
{
  "status": "ok", "space": "kaloscope", "method": "umap",
  "model_version": "kaloscope-2.0:sha256:...",
  "k": 8, "seed": 0, "algo_version": 1,
  "regions": [
    {"id": 3, "center": [0.12, -0.41, 0.08], "size": 412, "members_total": 430,
     "representatives": [1021, 877], "tagged": 240,
     "tags": [{"tag": "monochrome", "count": 12, "tagged": 240, "rate": 0.05, "ratio": 4.1, "p": 0.00021, "q": 0.0025}],
     "artists": [{"artist": "modare", "count": 3, "high_total": 4, "share": 0.75}]}
  ],
  "cached": false
}
```

**Errors:** 400 for an unknown `space`, an invalid `selection_token`, or a
`model_path` that is not a `.pth`/`.pt`/`.onnx` file, is missing or cannot be
read (`kaloscope` space with `model_source=local` only).

#### GET /api/style-map/axes
What the two ends of each axis of the map stand for, so the page can name the
directions of the cloud. The map is the one `points` returned (named by
`map_id`), on the coordinates the page shows: `layout=pca` (the default) reads
the PCA axes, `layout=umap` the ready UMAP fit (`layout_not_ready` while it is
queued, computing or gone). UMAP axes have no fixed direction (a refit may
rotate or flip them), so the page tells the user that only distances mean
something there; the labels here are still true for the layout shown.

Per axis `x`, `y`, `z` and per end (`low` = the smallest coordinates, `high` =
the largest):

- `representatives`: 3 image ids from the outer 10% of the axis, nearest the
  median of that tenth (so a far outlier is never picked) and visibly
  different from each other (cosine of the PCA features below 0.9, as for the
  regions). Merged near-duplicates are represented by their representative
  point; every point counts once.
- `tags`: up to 3 STYLE tags that separate the outer 20% at this end from the
  outer 20% at the other end. Only tags of the style list
  (`backend/services/style_axis_tags.py`: medium and technique, colour
  treatment, rendering, art style; each one a WD14 general tag of a shipped
  tagger) are compared; subject, clothing, pose, composition, rating,
  character and meta tags never label an axis. The statistics are the regions' own
  (hypergeometric tail over TAGGED pictures only, one Benjamini-Hochberg
  correction over every admissible test of the map, `q` < 0.01, `ratio` >= 3
  or `rate` >= 0.6 with a `gain` of at least 0.25 over `other_rate`), and the tag
  must describe a real share of the end (`rate` >= 0.25 and `gain` >= 0.15, so a
  tag on 6% of one end and none of the other names nothing); a tag is
  admissible when at least 4 pictures of the end carry it and both ends have
  at least 10 tagged pictures. Tag counts are taken on at most 4000 pictures
  per end, evenly spread over the end's ranks (smaller maps are counted
  whole). A tag row counts whatever its source (tagger, sidecar, manual), and a
  picture is tagged when it has any tag row. The page names the tags from its
  language packs (`stylemap.tag.<tag>`), English when there is none.
- `size` (points in the end) and `tagged` (of those, with any tag).

`weak` is `true` when no style tag separates the two ends of the axis (an axis
that only separates what is drawn has no style difference to name): the page
then says so and never invents a label.
`strength` is the largest `gain` (rate at the labelled end minus rate at the
other end) among the reported tags, 0 when `weak`. Maps with fewer than 30
points are `weak` on every axis.

`status` is `not_started` when the map is unknown, evicted or belongs to
another library (`axes` is then empty), `empty` for a map without points.
Cached in memory per layout key, layout and label version (the `tags` and
`artist_predictions` fingerprint the regions use), so a tagging run after the
map was built is picked up on the next request (`cached` is `true` only on an
unchanged repeat); dropped whenever the layout is.

**Parameters:** `space`, `selection_token`, `model_source`, `model_path` as for `points`, plus:

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `map_id` | string | null | The handle the `points` answer carried (32 hex characters, 400 otherwise); the page always sends it |
| `layout` | string | `pca` | `pca` or `umap`: the coordinates the page shows (400 otherwise) |

**Response:**
```json
{
  "status": "ok", "space": "kaloscope", "layout": "pca",
  "model_version": "kaloscope-2.0:sha256:...",
  "algo_version": 3, "points": 1447,
  "axes": {
    "x": {"weak": false, "strength": 0.62,
          "low":  {"representatives": [88, 91, 412], "size": 289, "tagged": 289,
                   "tags": [{"tag": "monochrome", "count": 190, "tagged": 289, "rate": 0.657, "other_rate": 0.038, "gain": 0.619, "ratio": 17.3, "q": 1e-40}]},
          "high": {"representatives": [3, 17, 25], "size": 289, "tagged": 289, "tags": []}},
    "y": {"weak": true, "strength": 0.0, "low": {"...": "..."}, "high": {"...": "..."}},
    "z": {"...": "..."}
  },
  "cached": false
}
```

**Errors:** 400 for an unknown `space`, an invalid `map_id` or `layout`, an
invalid `selection_token`, or a `model_path` that is not a
`.pth`/`.pt`/`.onnx` file, is missing or cannot be read (`kaloscope` space with
`model_source=local` only).

#### POST /api/style-map/custom-axes
Re-lays the map along axes the user defines with example pictures (slice S4g).
Per axis (`x`, `y`, `z`; `null` or absent = not defined) two groups of examples,
`a` (the low end, the page's left box) and `b` (the high end, the right box), at least 2
each, no upper limit (5,000 + 5,000 examples on a 50k-point map cost about 6 s,
the same as a handful: leave-one-out is computed in closed form, O(n x D)):

```json
{"space": "kaloscope", "map_id": "...", "layout": "pca",
 "axes": {"x": {"a": [12, 40, 77], "b": [5, 9, 31]}, "y": null, "z": null}}
```

The direction is `normalize(mean(unit vectors of b) - mean(unit vectors of a))`
in the space's style-vector space; a picture's coordinate is its unit vector
dotted with it, zero halfway between the two groups' mean scores, divided by
the largest |coordinate| of the map (the PCA layout's scale, so the grid looks
the same). The undefined axes keep the layout `layout` names (`pca`, or the
ready `umap` fit) with every custom coordinate regressed out (Gram-Schmidt on
the coordinate columns) and are scaled back to peak 1, so a custom axis is not
repeated on the others. Coordinates are computed from the pictures' stored
vectors in chunks (nothing like the PCA map's covariance matrix is built).

**Response:**
```json
{
  "status": "ok", "space": "kaloscope", "layout": "pca", "model_version": "...",
  "ids": [3, 8, 9], "coords": [[0.12, -0.4, 0.07], [0.9, 0.1, -0.2], [-0.6, 0.3, 0.5]],
  "axes": {
    "x": {"applied": true, "reason": null, "a_used": [12, 40, 77], "b_used": [5, 9, 31],
          "missing_ids": [], "agree": 6, "total": 6, "separable": true},
    "y": null, "z": null
  },
  "warnings": [{"code": "axes_parallel", "axes": ["x", "y"], "cos": 0.94}]
}
```

`ids` and `coords` are in the order of the `points` answer of the same map (the
representatives). Per defined axis: `agree` / `total` is leave-one-out
agreement (each example is left out, the direction and zero are recomputed from
the rest, and it must still fall on its own side); `separable` is true when at
least 80% agree (the page tells the user the two groups are hard to tell apart
otherwise). `missing_ids` are examples outside the current library
(`X-SD-Library-Id`) or without a vector in this space; they are ignored, and an
end left with fewer than 2 usable examples leaves the axis not applied
(`applied: false`, `reason: "too_few_examples"`; `identical_ends` when the two
groups have the same mean). `warnings` lists defined axes whose directions
have |cos| above 0.9. `status` is `not_started` for an unknown, evicted or
other-library map and `layout_not_ready` for `umap` before its fit is done
(`ids`, `coords` empty).

**Parameters:** `model_source`, `model_path` as query parameters (as for
`points`).

**Errors:** 400 for an unknown `space` / `layout` / axis name, an invalid
`map_id`, a picture that is in both boxes of an axis, a box with fewer than 2 example
pictures, or a malformed axis (not an object, `a`/`b` not lists, an item that
is not a whole number: a string, `null`, a bool or a fraction); the message
names the axis.

#### GET /api/style-map/colors
One colour value per point of the map `points` last returned for the same
`space` and `selection_token`, in point order (`ids` are the representatives
of that map; a merged near-duplicate group shows its representative's own
value). The page colours the dots it already holds from this answer: the
layout is never refetched for a colour change, and this answer is never part
of the cached points payload (tagging, scoring or a Style Finder batch change
it; it is read fresh on every call).

**Parameters:** `space`, `selection_token`, `model_source`, `model_path` as for `points`, plus:

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `by` | string | `generator` | `generator` (`images.generator`), `folder` (the directory of `images.path`), `artist` (the Style Finder's stored prediction, `artist_predictions`; `undefined` means no data), `aesthetic_score` (LAION), `aesthetic_waifu` (Waifu Scorer), `aesthetic_anime` (deepghs anime aesthetic) |
| `map_id` | string | null | The handle the `points` answer carried (32 hex characters, 400 otherwise): names that cached map directly, no filter query (the page always sends it). `not_started` once the map is evicted or the handle is sent under another library; without it the map is located from the filter again |

**Response:**
```json
{
  "status": "ok", "space": "kaloscope", "model_version": "kaloscope-2.0:sha256:...",
  "by": "generator", "kind": "category",
  "ids": [17, 23, 41],
  "values": [0, 1, null],
  "legend": [{"key": "comfyui", "label": "comfyui", "count": 304}, {"key": "nai", "label": "nai", "count": 116}],
  "range": null,
  "missing": 1
}
```

`kind` is `category` for `generator`, `folder` and `artist`: `values` are
indexes into `legend`, which lists the 12 largest categories by picture count
(ties by key) and, when more exist, one last entry with key `__other__`
holding the rest (its `count` is their total; the page names it). A folder's
`key` is its full path with `/` separators and its `label` the last segment
(the page shows the label and puts the key in the tooltip). `kind` is `scale`
for the three aesthetic fields: `values` are the scores themselves (rounded
to 3 decimals), `legend` is empty and `range` is `[min, max]` over the
scored pictures (`null` when none is scored). In both kinds a picture
without a value is `null` (the page draws it grey) and `missing` counts them.
`status` is `not_started` (empty arrays) until `points` ran for this map in
this process (the page then asks for `points` again, once per user action).
A 50k-point map answers in about 380-560 KB (categories at the low end,
scores at the high end); with `map_id` the answer is the value read and the
JSON alone (about 0.15 s), without it the filter query that locates the map
adds roughly 0.25 s.

**Errors:** 400 for an unknown `space` or `by`, an invalid `selection_token`,
or a `model_path` that is not a `.pth`/`.pt`/`.onnx` file, is a network path
outside a trusted model folder, is missing or cannot be read (`kaloscope`
space with `model_source=local` only).


#### POST /api/style-map/members
Expand the dots of the map into every picture they stand for. The map shows
one representative per near-duplicate group (`members` in `points` is the
group size); a box selection must act on the whole group. JSON body:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `space` | string | `kaloscope` | `kaloscope`, `clip` or `csd` |
| `map_id` | string | null | The handle of the map the page shows (32 hex characters, 400 otherwise) |
| `selection_token` | string | null | Locates the map from the filter when no `map_id` is sent |
| `rep_ids` | integer[] | required | Points (representatives) of the map; no size limit |

`model_source` / `model_path` are query parameters as for `points`.

**Response:**
```json
{"status": "ok", "space": "kaloscope", "ids": [10, 11, 12, 20]}
```

`ids` lists every member of the given representatives (the representatives
included), group by group in map order, ids ascending inside a group. An id
that is not a representative of this map expands to nothing. The table is
the one the map was computed with, kept beside the cached layout:
`status: "not_started"` (empty `ids`) when the map is not cached in this
process (evicted, restarted) or the handle is sent under another library
(`X-SD-Library-Id`); nothing is read across libraries.

#### POST /api/style-map/query
Drop a picture on the Style Map and find the nearest pictures of the current
library: `multipart/form-data` with one `file` (an image of at most 50 MB,
read into memory and never stored; a larger body is refused with 413 before
it is parsed, whether or not it declares a `Content-Length`). The answer is
placed on the map `points` last returned: the layout is not recomputed.

**Parameters (query string):** `space`, `selection_token`, `model_source`,
`model_path`, `use_gpu` as for `points`, plus:

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `map_id` | string | null | The handle of the map the page shows (32 hex characters, 400 otherwise); `not_started` once that map is evicted or the handle is sent under another library |
| `k` | integer | 20 | Neighbours to return (1-100) |

`kaloscope` compares Kaloscope style vectors of the library with the dropped
picture's (the first call loads the model: about 7-15 s, then about 0.1 s);
`csd` does the same with CSD style vectors (the first call loads the 2.4 GB
model, about 10 s; `use_gpu` applies); `clip` reuses the Similar page's upload
search.

**Response:**
```json
{
  "status": "ok",
  "query": {"x": 0.412, "y": -0.208, "z": 0.133},
  "neighbors": [
    {"id": 17, "score": 0.87, "x": 0.43, "y": -0.2, "z": 0.12, "weak": false, "in_filter": true, "located": true, "merged": false, "filename": "a.png"},
    {"id": 23, "score": 0.41, "x": 0.43, "y": -0.2, "z": 0.12, "weak": false, "in_filter": true, "located": true, "merged": true, "filename": "b.png"},
    {"id": 41, "score": 0.12, "x": null, "y": null, "z": null, "weak": true, "in_filter": false, "located": false, "merged": false, "filename": "c.png"}
  ],
  "weak_threshold": 0.32,
  "model_version": "kaloscope-2.0:sha256:..."
}
```

`query` is the similarity-weighted centre of the three nearest neighbours that
have a position on the map (`null` when none has). A neighbour outside the
current Gallery filter is listed with `in_filter: false` and no coordinates. A picture that is in the filter but has no dot (its style vector is unusable, so it is in `unlocatable` of `points`) has `in_filter: true`, `located: false` and no coordinates; `located` is true exactly when `x`/`y`/`z` are set. A
neighbour that is a member of a merged near-duplicate dot has
`merged: true` and sits on that dot (looked up in the map's group table,
the same one `members` expands). `weak` marks a score below `weak_threshold`: 0.5 for
`clip` (the Similar page's threshold), 0.32 for `kaloscope` (an empirical
value from a 529-picture library, where a random pair's 95th percentile and
each picture's nearest-other 5th percentile both sit near 0.32) and 0.65 for
`csd` (300 pictures of a real library: a random pair's median is 0.64, a
picture's best other match has a 5th percentile of 0.69, and photos and
wallpapers top out at 0.42).
`status: "not_started"` (`query: null`, no neighbours, no model run) when the
map is not cached in this process.

**Errors:** 400 for an empty or unreadable picture, one without a usable style
vector, an unknown `space`, a malformed `map_id` or `selection_token`, or a
`model_path` refused as for `points`; 409 while another AI job holds the
runtime; 413 for a file over 50 MB; 503 when the Kaloscope or CSD model is
not prepared (the message says how to prepare it).

#### GET /api/style-map/near
The nearest pictures of one LIBRARY picture on the map: the same answer as
`POST /api/style-map/query`, ranked by the picture's stored vector (Kaloscope
style vector or CLIP embedding), so nothing is uploaded and no model runs.

**Parameters (query string):** `image_id` (required), `space`, `map_id`,
`selection_token`, `k` (1-100, default 20), `model_source`, `model_path` as
for `query`.

**Response:** the `query` body without the picture itself in `neighbors`, plus

```json
{
  "status": "ok",
  "query": {"x": 0.412, "y": -0.208, "z": 0.133},
  "self": {"id": 17, "filename": "a.png", "in_filter": true, "located": true, "merged": false, "x": 0.412, "y": -0.208, "z": 0.133},
  "neighbors": [ ... ]
}
```

`self` says where the picture is: on its own dot, on its group's dot
(`merged: true`, looked up in the map's group table), in the filter without a
dot (`in_filter: true`, `located: false`) or outside the current Gallery
filter (`in_filter: false`, no coordinates). `query` is the picture's own dot
(`null` when it has none). `status: "no_vector"` (no neighbours, `self` with
only `id` and `filename`) when the picture has no vector in this space;
`status: "not_started"` (`self: null`) when the map is not cached in this
process or the handle is sent under another library. 404 for an unknown
picture; 400 for a malformed `map_id`.

#### POST /api/style-map/locate
Find pictures of the map by a Gallery search. The search is the Gallery's own
filter contract: the page parses the search box with the Gallery grammar
(`tag:`, `prompt:`, free text over file names ...), creates a token with
`POST /api/images/selection-token` and sends it here. JSON body:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `space` | string | `kaloscope` | `kaloscope` or `clip` |
| `map_id` | string | null | The handle of the map the page shows |
| `selection_token` | string | null | Locates the map from the filter when no `map_id` is sent |
| `search_token` | string | required | A selection token of the search (400 when invalid) |
| `limit` | integer | 50 | Results to return, 1-50 |

**Response:**
```json
{
  "status": "ok",
  "space": "kaloscope",
  "total": 3,
  "results": [
    {"id": 17, "filename": "a.png", "x": 0.43, "y": -0.2, "z": 0.12, "merged": false},
    {"id": 23, "filename": "b.png", "x": 0.43, "y": -0.2, "z": 0.12, "merged": true}
  ],
  "outside_filter": 0,
  "without_data": 0
}
```

The matches are intersected with every picture the map's dots stand for
(merged members included, newest first). `total` counts all matches on the
map, `results` holds at most `limit`. A merged picture shares its
representative's position. When nothing is on the map, `outside_filter`
counts matches that the current Gallery filter keeps off it and
`without_data` matches that have no style data yet, so the page can say why.
`status: "not_started"` (no results) when the map is not cached in this
process or the handle is sent under another library.

### Obfuscation

Output is always a PNG, so generation metadata survives the protect/restore
round trip for every source format (PNG tEXt, plus JPEG/WebP/TIFF EXIF
`UserComment`, `ImageDescription`, and XMP) and in both compatibility modes.
Harvested EXIF/XMP text is re-keyed to the PNG chunk the reader expects
(`parameters`, `prompt`, or `Comment`), or carried under `UserComment` when it
matches none of those, so nothing is dropped. In the protected copy the value is
encrypted with the same scheme as the reference site; `preserve_metadata: false`
still strips everything.

#### POST /api/obfuscate/encode
Encode image with obfuscation algorithm. The result reports `metadata_preserved`
and `metadata_chunks_carried` (how many text values actually moved across).

#### POST /api/obfuscate/decode
Decode obfuscated image. Same result fields as encode.

#### POST /api/obfuscate/batch
Run encode/decode in batch mode.

#### POST /api/obfuscate/preview
Generate obfuscation preview.

### Chat disguise

A chat disguise is one PNG that shows a cover as its still picture and the real
picture(s) as its APNG animation: chat-list thumbnails show the cover, opening
the image plays the real picture. Pixels are scrubbed by default (no metadata,
no prompt hidden in pixel bits). Disguises made here are remembered by SHA-256,
so a library scan does not restore them; a scan restores received disguises
beside the original as `<name>_real.png` (see `scan_folder(restore_disguised)`).

#### POST /api/disguise/make
Multipart form. `sources` is a JSON list in frame order of `{"image_id": n}`
(library image) or `{"file_index": n}` (index into the uploaded `files`); several
sources make one animation. `cover_kind` is `upload` (with `cover_file`),
`default`, `text` (`cover_text`, `cover_background`, `cover_foreground`), `blur`,
or `mosaic` (censor detections of the first library source; `detect_model_type`,
`detect_model_path`, `detect_confidence`, `detect_targets`). Options: `frame_ms`,
`max_side` (0 keeps the size, default 1600), `scrub`, `canvas_background`,
`output_folder` (default `<data>/disguise/output`), `output_name`, and
`output_format` (`disguise`, or `gif` for a plain looping GIF with no cover). An existing
file is never replaced (`name_2.png`). Returns `{status: "ok", token, file_url,
output_path, file_name, cover_preview, width, height, real_frames, bytes}`, or
`{status: "needs_cover", reason}` (`no_default_cover`, `no_upload`,
`nothing_detected`, `detector_unavailable`, `not_in_library`) with nothing written.

#### GET /api/disguise/result/{token}
Serve a made disguise file by the token `make` returned (404 once unknown).

#### POST /api/disguise/copy
Body `{"tokens": [...]}`. Put the made files on the clipboard as files (Windows
CF_HDROP), so pasting into a chat sends the APNG byte for byte. 501 on other
platforms, 409 when another program holds the clipboard.

#### POST /api/disguise/reveal
Body `{"token": "..."}`. Show a made disguise in the OS file manager with the
file selected (Explorer `/select,`, macOS `open -R`, Linux opens the folder).

#### POST /api/disguise/restore
Upload a disguise (`file`); returns its real picture as PNG, or an ordinary
looping APNG for a pack. 400 when the upload is not a disguise.

#### GET /api/disguise/default-cover/info
`{"exists": false}` or `{"exists": true, "version": <mtime ns>}`; the page asks this
instead of requesting a possibly missing image.

#### GET /api/disguise/default-cover
The saved default cover (PNG), or 404.

#### PUT /api/disguise/default-cover
Upload (`file`) and save the default cover (scrubbed like any output).

#### DELETE /api/disguise/default-cover
Remove the saved default cover. Returns `{status, removed}`.

### Aesthetic

#### GET /api/aesthetic/status
Get aesthetic scorer availability and scored count. Returns `{ "available", "message", "scored_count", "outdated_count", "missing_extra_count", "to_score_count" }`. `to_score_count` is what `POST /api/aesthetic/score-all` would process in the current library: images with no LAION score, `outdated_count` images whose score came from a build older than `aesthetic.AESTHETIC_SCORE_VERSION` (before the QuickGELU fix), and, once an optional model is installed (Waifu Scorer V3 head, deepghs anime grade), `missing_extra_count` images that already have a current LAION score but lack that model's score. A model file that fails to load stops counting until it is prepared again.

#### POST /api/aesthetic/score/{image_id}
Score a single image. Returns `{ "image_id", "aesthetic_score", "aesthetic_waifu", "aesthetic_anime", "aesthetic_anime_pct", "aesthetic_anime_grade" }`. `aesthetic_waifu` (0-10) is `null` unless the Waifu Scorer V3 head is installed; it comes from the same CLIP pass. The `aesthetic_anime*` fields are `null` unless the deepghs anime aesthetic model is installed: `aesthetic_anime` is its continuous score (worst 0 ... masterpiece 6), `aesthetic_anime_pct` its percentile among the model's reference samples (0-1), and `aesthetic_anime_grade` the grade read from that percentile (`masterpiece` >= 0.95, `best` >= 0.85, `great` >= 0.75, `good` >= 0.5, `normal` >= 0.25, `low` >= 0.1, else `worst`). Gallery rows and `GET /api/images/{id}` carry these fields too.

#### POST /api/aesthetic/score-all
Start batch aesthetic scoring.

#### POST /api/aesthetic/cancel
Cancel the running aesthetic scoring batch.

#### GET /api/aesthetic/progress
Get batch aesthetic scoring progress.

#### POST /api/similarity/cancel
Cancel the running similarity embedding batch.

#### POST /api/artists/batch-cancel
Cancel the running artist batch identification.

#### POST /api/resolve-drop
Resolve dropped filenames or folder name to a filesystem path.

#### POST /api/import-files
Import uploaded image files directly into the gallery.

### Support

#### GET /api/support/diagnostics
Return a copyable support diagnostics payload for stalled scans and troubleshooting. The payload includes app/version/runtime flags, scan progress snapshots, and a redacted tail of the backend log; local paths inside log lines are redacted before returning to the browser.

#### POST /api/support/open-log
Open the configured rotating backend support log in the operating system file manager. The endpoint does not accept a user-supplied path; it only opens the app-controlled `LOG_FILE_PATH` location so the scan dialog can offer an "Open log file" action. If no OS opener is available, it returns `opened=false` with the log path instead of failing with a server error. The JSON response includes both the raw local `path` for local clipboard use and `path_redacted` for display, so frontend UI must display the redacted value and only copy the raw path on explicit user action.

### Updates

#### GET /api/updates/status
Get update status for current version/channel.

Key response fields:

| Field | Type | Description |
|-------|------|-------------|
| `updater_enabled` | boolean | Whether the local updater is available |
| `package_root` | string | Package root that would receive managed app files |
| `data_root` | string | Protected runtime/user data root; never update-managed |
| `update_root` | string | Protected updater workspace root |
| `current_version` | string | Currently running app version |
| `latest_version` | string | Latest version reported by the selected channel |
| `has_update` | boolean | Whether a compatible newer update asset is available |
| `update_unavailable_reason` | string/null | Human-readable reason when a newer release exists but no compatible asset is available |
| `channel_api_url` | string | Release metadata URL used by the update check |
| `channel_web_url` | string | Human-facing release page URL |
| `download_url_prefix` | string | Optional proxy prefix used for release asset downloads |

#### GET /api/updates/channel
Get active update channel configuration.

#### POST /api/updates/channel/proxy
Set custom update channel proxy configuration.

#### DELETE /api/updates/channel
Reset update channel to default.

#### POST /api/updates/restart
Restart the app without applying an update. Feature setup uses this after an install replaced an already-loaded module. Body: `{reason: string, force?: bool}` (`reason` max 200 chars, may be empty). Without `force`, a restart while work is running returns `{status: "busy", jobs, boot_id}` and does nothing; `jobs` lists plain ids (`scan`, `tagging`, `captions`, `aesthetic`, `file_moves`, `background_jobs`, `model_setup`, `ai`) so the page can ask the user, and `force: true` restarts anyway. Otherwise returns `{status, launcher, mode?, boot_id}` where `status` is `scheduled` or `unsupported` and `boot_id` identifies the process being restarted. A scheduled restart stops this process gracefully after the response. When the launcher runs a restart loop (`SD_IMAGE_SORTER_RESTART_LOOP=1`, set by `run.bat`, `run.sh` and the portable launchers), `mode` is `in_place`: the process exits with code 75 and the launcher starts it again in the same console and on the same port. Otherwise `update_worker.py` relaunches the launcher. `unsupported` does not exit.

#### GET /api/updates/boot-id
Return `{boot_id}`, a value that changes every time the server starts. After `POST /api/updates/restart`, the page polls this until the id differs from the one it was given, then reloads.

#### POST /api/updates/apply
Apply a downloaded update package. Body: `{force_check?: bool, relaunch?: bool, check_busy?: bool}` (defaults `true`, `true`, `false`). With `check_busy: true`, an install while work is running returns `{status: "busy", jobs, boot_id}` (the same ids as `POST /api/updates/restart`) before anything is downloaded or scheduled, so the page can ask the user; sending it again with `check_busy: false` installs anyway. Without the flag the endpoint installs as before (older clients; V4 and V3.5 send it).

When an update is scheduled, response includes `pending_manifest` and `restart_required`. The updater validates archive entries and the package manifest before copying files, and rejects protected runtime paths such as `data/`, `update/downloads/`, `update/logs/`, `update/state/`, `update/worker/`, and `update/backups/`.

### Output folders

#### GET /api/output-folders
Return `{root, builtin_root, custom_root, folders: {censor, publish, video-censor}}`: the folder each save flow writes into when its folder field is left blank. `builtin_root` is `<program root>/output` (or `SD_IMAGE_SORTER_OUTPUT_DIR`), protected from the updater like `data/`; `custom_root` is the folder chosen in Settings (`""` = none); `root` is the one in use.

#### PATCH /api/output-folders
Body: `{root}`. Stores the Settings choice in `app-settings.json` (`output_root`); an empty `root` goes back to the built-in folder. An invalid folder or a symlink returns 400 and nothing is stored. Returns the same shape as GET.

#### POST /api/output-folders/reveal
Body: `{path}`. Opens the OS file manager on a file a save flow (censor save, publish set) wrote or skipped while this server runs, with the file selected. Any other path, or a file that no longer exists, returns 404; 501 when no file manager is available.

### Disk

#### GET /api/disk/cache-status
Report sizes of cache directories the user can safely clean, informational sizes for preserved directories (models, settings, user data), cache settings, and the local Python runtime environment. Expensive folders are scanned with a small time/file budget so Feature Setup does not hang on huge old installs; when a size is incomplete, `size_complete` is `false` and `size_bytes` may be `null`. `tmp`, `thumbnails`, `pip_cache`, and `cache` are always the app-owned `data/tmp`, `data/thumbnails`, `data/pip-cache`, and `data/cache`; external `SD_IMAGE_SORTER_TMP_DIR`, `SD_IMAGE_SORTER_THUMBNAIL_DIR`, `PIP_CACHE_DIR`, or `SD_IMAGE_SORTER_CACHE_DIR` values are ignored for one-click cleanup. Size reporting does not follow symlinks, so external targets are not counted as app-reclaimable bytes. Response shape: `{safe_to_clean: [{key, label_key, path, size_bytes, size_complete, exists}], preserved: [{key, label_key, path, size_bytes, size_complete}], settings: {thumbnail_cache_max_mb}, thumbnail_cache: {file_count, total_size_bytes, total_size_mb, max_size_bytes, max_size_mb, limit_enabled}, runtime_environment: {runtime_kind, runtime_path, runtime_rebuild_target, venv_path, venv_exists, venv_size_bytes, venv_size_complete, rebuild_core_pending, rebuild_marker_path}}`.

#### POST /api/disk/settings
Persist disk/cache settings and apply safe cleanup immediately. Body: `{thumbnail_cache_max_mb: number}` where `0` disables persistent thumbnail writes and values above `0` cap regeneratable thumbnail files. Returns `{settings, thumbnail_cache, limit_cleanup}`.

#### POST /api/disk/runtime/rebuild-core
Schedule a safe lightweight Python environment rebuild for the next launcher start. This writes a marker under `data/state`; the running backend does **not** delete its own active Python runtime. On the next `run.bat` / `run.sh`, the launcher removes only `backend/venv`, clears `backend/.requirements_hash`, and reinstalls the selected dependency mode. On generated `run-portable.bat`, the launcher clears only embedded Python's pip-installed `Lib/site-packages` and `Scripts` directories, then reinstalls core dependencies. `data/`, `images.db`, settings, caches, downloaded models, and the embedded Python base files are left untouched. Returns `{scheduled, restart_required, runtime_environment}`.

#### POST /api/disk/cleanup
Wipe the contents of whitelisted cache directories. Body: `{keys: ["tmp" | "pip_cache" | "thumbnails" | "cache"]}`. Strict whitelist enforced server-side; unknown keys are rejected. Returns `{cleaned: [{key, freed_bytes}], errors: [{key, error}]}` with partial-failure reporting.

### Tags Library Bulk Operations

Added in v3.2.1. Tag-Master-inspired bulk operations on the DB tags table. Every mutation accepts exactly one scope source (`image_ids`, `selection_token`, or `filters`) and `dry_run=true` to preview affected counts and up to 5 sample before/after pairs before committing.

Every non-dry-run operation is atomic across its full resolved scope, including
all internal ID chunks. If preparing or writing any image fails, the API returns
a non-2xx response whose `error` explains that all changes were rolled back;
no undo-journal entry is created and clients must not render an applied result.

Repeated IDs in an explicit `image_ids` scope are normalized to one logical
image so progress, affected counts, and undo journals remain exact.

Successful applied responses include `op_id`, `undo_available`, and
`warnings: [{code, message}]`. The undo journal is bounded by both image
count and serialized bytes. If that limit is exceeded, or persisting the
journal fails after the tag transaction commits, the endpoint still returns
HTTP 200 because the tag changes were applied; `undo_available` is false and
`warnings` explicitly explains why undo is unavailable.

#### GET /api/tags/bulk/state
Report the current bulk-operation counters as `{running, operation, total, completed, errors}`. This endpoint does not provide cancellation, capability flags, or a separate completion summary.

#### POST /api/tags/bulk/find-replace
Rename a tag across N images. Body: `{image_ids|selection_token|filters, find, replace, case_sensitive, regex, dry_run}`. Empty `replace` removes the tag. `regex: true` (QW-3, opt-in) treats `find` as a whole-tag fullmatch pattern and lets `replace` use backrefs (`\1`); invalid patterns or replacement backreferences return 400.

#### POST /api/tags/bulk/add
Append tags to a selection. Body: `{image_ids|selection_token|filters, tags: string[], confidence, dry_run}`. Existing tags are kept. Request tags are trimmed and deduplicated case-insensitively before preview counts and persistence, and `confidence` applies to every newly added tag.

#### POST /api/tags/bulk/remove
Delete specified tags from a selection. Body: `{image_ids|selection_token|filters, tags: string[], case_sensitive, dry_run}`.

#### POST /api/tags/bulk/cleanup
Drop tags below a confidence threshold and deduplicate by case-insensitive tag name keeping the highest-confidence copy. Body: `{image_ids|selection_token|filters, min_confidence, dedupe, dry_run}`.


#### GET /api/tags/bulk/ops

List the most recent applied bulk tag operations from the undo journal (v3.5.x FE-2s). Query: `limit` (default 20, max 100). Returns `{ops: [{id, operation, created_at, scope_source, params, images_affected, undo_available, undone_at}]}`. Dry runs are never journaled.

#### POST /api/tags/bulk/undo/{op_id}

Undo one journaled bulk operation. Body: `{force}`. Restores each affected image's full pre-op tag rows (provenance included). Images whose tag set changed since the op are conflicts: skipped and reported in `skipped_conflicts` unless `force=true`. Undo is one-shot per op and is itself journaled when the bounded redo journal can be saved. Returns `{op_id, operation, restored, skipped_conflicts, redo_op_id, redo_available, warnings}`; `redo_op_id` is non-null only when `redo_available=true`. If Undo succeeds but its redo journal exceeds a limit or cannot be persisted, the endpoint still returns HTTP 200, marks the original operation undone, and reports the lost redo capability in `warnings`. Returns 404 for unknown ids and 409 when already undone, the original operation has no journal, or persisted journal data is invalid.
#### GET /api/tags/export-presets
List built-in tag/caption export presets used by the LoRA training template engine (Anima Tags+NL, Anima Tags-only, Illustrious / Pony, NoobAI, FLUX, Kohya SD1.5, Custom).

#### POST /api/tags/export-preview
Render sample caption files without writing to disk. Body: `{image_ids, preset_id|template_override, options}`. Returns rendered captions keyed by image id plus the resolved template variables. v3.5.0 (preview unification): pass `content_mode` (any real export mode, plus optional `prefix` and `normalize_tag_underscores`) to render through `build_sidecar_content` — the exact engine `/api/tags/export-batch` writes with — so the preview can never drift from the exported sidecar. Omit `content_mode` (or send `template`) for the template-designer path. Also accepts `training_purpose` and `dedupe_implications` (P2-19/P2-18) so the preview mirrors those export filters on both the native and template paths. Each result row also carries `nl_source`, the text the Dataset Maker's natural-language box starts from: the stored `nl_caption`, else a pre-split fused `ai_caption`, never the image's own tag list (a booru-only Smart Tag `ai_caption`: nearly every comma segment is one of that image's tag names or the trigger). The same rule decides the `{nl_caption}` template slot and the `nl_caption` / `tags_nl` / `prompt_nl` content modes; the Dataset Maker reports each refusal as the `nl_fallback_is_tag_list` caption advisory. Each result row also reports `blacklist_leaks` — blacklisted terms that still appear in the final rendered text (underscore/space folded, word-bounded), i.e. features that leaked back in through NL prose after the tag rows were pruned (SEP-2).

#### POST /api/tags/export-combined
Build a single combined export bundle for the current selection across multiple presets. Body: `{image_ids|selection_token, presets: [{preset_id|template, options}], filename_template}`. Returns `{token, total_files}` — pass the token to the download endpoint below.

#### GET /api/tags/export-combined/download/{token}
Stream the combined export as a `.zip`. The token is single-use and expires after a short window. Used by the v3.2.1+ multi-preset export flow.

### Color Analysis

Added in v3.2.1. The color analyzer extracts dominant colors, brightness, saturation, temperature, and distribution shape; persisted in 7 indexed DB columns added by migration 010.

#### GET /api/colors/missing-count
How many indexed images still need color analysis (used to gate the "Analyze All" button). Returns `{missing: int, total: int}` where `total` is the total number of readable images (added in v3.2.1 follow-up so the tagger Color tab can show "Analyzed X of Y").

#### GET /api/colors/progress
Live progress for a running batch backfill: `{state, total, completed, failed, current_path, started_at}`.

#### POST /api/colors/analyze
Start a batch color-analysis job. Body: `{image_ids?: int[], limit?: int}` where `image_ids` is optional and `limit` is `1..50000` (default `5000`). When `image_ids` is omitted, the backend analyzes images missing color data up to `limit`. Returns immediately with `{status, total}`; poll `/api/colors/progress`.

#### POST /api/colors/analyze-single/{image_id}
Compute color data for one image synchronously. Returns the persisted analysis payload (dominant colors, brightness, saturation, temperature, distribution).

#### POST /api/colors/cancel
Request a cooperative cancel of the running color-analysis job. Completed images are kept; in-flight work stops at the next image boundary.

### VLM Captioning

Added in v3.2.1. Multi-provider Vision Language Model captioning pipeline alongside WD14 / Camie / PixAI / ToriiGate taggers. See `vlm_providers/` for the provider implementations.

#### GET /api/vlm/providers
List supported VLM providers (`openai_compat`, `anthropic`, `gemini`, `vertex`) with capability flags.

#### POST /api/vlm/detect-provider
Auto-detect provider from a pasted endpoint URL. Body: `{endpoint}`. Returns the inferred `provider` key plus suggested defaults.

#### GET /api/vlm/settings
Return the saved VLM configuration (provider, endpoint, model, prompt preset, output format, concurrency, retries, proxy). Also returns `captioner_ready` and `captioner_problem`: whether Smart Tag's natural-language captioner (`natural_language_mode=vlm`) would pass the same check `/api/smart-tag/start` applies, and why not. The Smart Tag dialog uses them to turn captioning off by default and to stop a run before any model download.

#### POST /api/vlm/settings
Persist the VLM configuration. Body: full settings payload (secrets handled server-side). Returns the saved settings minus secrets.

#### POST /api/vlm/test
Test the current VLM credentials and endpoint with a tiny probe image. Returns `{ok, latency_ms, sample_caption, error}`.

#### POST /api/vlm/probe-concurrency
Probe concurrent VLM health-check capacity and optionally persist the stable worker count.

#### POST /api/vlm/models
List available models for the configured provider (calls provider's `models` API or falls back to a curated list).

#### GET /api/vlm/presets
List built-in system-prompt presets (general LoRA NL, Anima/FLUX detailed, single-sentence, character LoRA, NSFW-tolerant, danbooru, hybrid).

#### POST /api/vlm/caption
Caption a single indexed image. Body: `{image_id, tags?}`. Returns
`{caption, tags, tokens_used, retries_used, error, error_type, model, output_format, dropped_tags}`.
Caption fields and accepted VLM tags are committed atomically. If the tag gate,
existing-tag read, or SQLite write fails, HTTP 500 includes the affected `image_id`
and root cause; the prior caption and tags remain unchanged.

#### POST /api/vlm/caption-batch
Start a concurrency-controlled batch caption job. Body: `{image_ids|filter, concurrency, retries, retry_delay, output_format, prompt_preset?}`.
While another AI job is running the batch is queued instead of rejected — see the AI job queue notes under `POST /api/tag/start` (v3.4.2). The cancel endpoint also removes queued VLM entries.
An image increments `completed` only after its caption and accepted tags commit
in one SQLite transaction. Persistence failures increment `failed`, retain the
image ID and concrete database error, and never count as completed.
Provider token usage remains counted even when local persistence fails.

#### GET /api/vlm/caption-batch/progress
Live progress includes `{running, total, completed, failed, tokens_used, current_image, active_requests,
api_ok, api_error, api_status, errors: [{image_id, error, error_type}]}` (errors capped at 50). Persistence failures use `error_type: "persistence"`.

#### GET /api/vlm/caption-batch/debug-chat
Return recent sanitized VLM request/response debug events for the user-facing API Chat view. API keys, service-account JSON, image bytes, endpoint userinfo, query strings, and fragments are redacted.

#### POST /api/vlm/caption-batch/cancel
Cooperative cancel; completed captions persist, in-flight requests stop after the next response boundary.

#### GET /api/vlm/local-models/recommended
Return the curated list of one-click downloadable Ollama vision models (Gemma 3/4, Qwen 2.5/3 VL, MiniCPM-V) with size, minimum VRAM, and NSFW tolerance flags.

#### POST /api/vlm/local-models/pull
Trigger an Ollama `pull` for the selected model. Body: `{model_id}`. Returns a job acknowledgement; poll `/api/vlm/local-models/pull/progress`.

#### GET /api/vlm/local-models/pull/progress
Live progress for the running Ollama pull: `{state, model_id, total_bytes, completed_bytes, status, error}`.

#### POST /api/vlm/local-models/delete
Delete an installed Ollama model. Body: `{model_id}`. Returns the updated installed list.

#### POST /api/vlm/local-models/start-ollama
Auto-start the local Ollama server when it is installed but not running. Useful first-launch helper; returns `{started, already_running, error}`.

### Dataset Maker

The Dataset tab (📦) drives a focused LoRA dataset preparation workflow.

#### GET /api/dataset/trainers

Return the verified Dataset Maker trainer contracts, including supported wire values, capabilities, and strict option bounds.

#### POST /api/dataset/review-queue

Build a typed review queue from the submitted Dataset Maker scope and its stored caption, tag, score, mask, and duplicate evidence. The response includes a scope fingerprint, issue rows, and evidence-availability summaries without modifying source images.

#### POST /api/dataset/readiness/start

Validate the exact requested export settings and queue a read-only Dataset Readiness job. Returns HTTP 202 with a durable `dataset_readiness` bulk-job snapshot; poll `GET /api/bulk-jobs/{job_id}` for progress and the final report.

Two optional fields (same on `POST /api/dataset/export`) change what counts as a blocker. `skip_blocked_items: true` turns per-item problems (unreadable source, empty or failed caption, missing subject-crop / bucket / trainer mask, a source that vanished before a beside-image write) into `Skipped:` warnings, and the export re-runs the check and leaves exactly those items out (`skipped` in the result). Name collisions, writes onto a source file and "no pairs left" still block. It is refused with HTTP 400 for verified trainer packages, because a skipped item makes the package incomplete. `allow_empty_captions: true` writes an empty `.txt` instead of flagging an empty caption. The report summary adds `skippable_items` and `empty_caption_items`. With `overwrite_policy: "skip"` an output that already exists is a warning (`existing_output_skipped`), not a blocker.

#### POST /api/dataset/package-verifications

Verify an existing Dataset Export Package v2 against its manifest and expected run id. The typed result reports `complete`, `incomplete`, `invalid`, or `missing`, together with checked counts and concrete integrity issues.

#### GET /api/dataset/projects

List active persistent Dataset Maker projects.

#### GET /api/dataset/projects/archived

List archived persistent Dataset Maker projects.

#### POST /api/dataset/projects

Create a named Dataset Maker project from validated Library and local items plus its typed settings. Returns the persisted project at revision 1.

#### GET /api/dataset/projects/{project_id}

Return one persistent Dataset Maker project, including its current revision, state, items, settings, and captured local-source identity.

#### PUT /api/dataset/projects/{project_id}

Replace an active project's name, items, and settings using the required `expected_revision`. Stale revisions fail with HTTP 409 instead of overwriting newer edits.

An item with `keep_as_saved: true` is stored exactly as the saved project already has it: a Library image that no longer exists stays marked missing, and a local file keeps its captured identity (nothing is re-read or re-linked). Only entries the saved project already contains are accepted; anything else is a validation error. Without the flag, a changed local file still fails with HTTP 409.

`settings.watermark_removal` is persisted with Dataset Project settings. It uses the same `{enabled, method, radius, padding_percent, regions}` shape as Dataset export; existing projects receive the disabled default through migration 041. Enabled cleanup is restricted to folder + copy output without a verified trainer package, and source images are never modified.

#### POST /api/dataset/projects/{project_id}/archive

Archive an active project using the required `expected_revision` and return the incremented project revision.

#### POST /api/dataset/projects/{project_id}/restore

Restore an archived project using the required `expected_revision`. A conflicting active project name fails with HTTP 409.

#### DELETE /api/dataset/projects/{project_id}

Delete a project using the required `expected_revision`. The response identifies the deleted project; stale revisions fail with HTTP 409.

#### POST /api/annotations/projects/{project_id}/training-captions/head

Resolve the current training-caption head for a Library or project-local subject at the required project revision.

#### GET /api/annotations/projects/{project_id}/training-captions/heads

Page through the current training-caption heads for a project. Query parameters include `expected_project_revision`, `limit`, and optional `after_subject_id`.

#### POST /api/annotations/projects/{project_id}/training-captions/revisions

Append an immutable manual training-caption revision and advance its subject head using `expected_project_revision` and `expected_head_generation` conflict checks.

#### GET /api/annotations/projects/{project_id}/subjects/{subject_id}/training-captions/revisions

Page through one subject's immutable training-caption history. Query parameters include `expected_project_revision`, `limit`, and optional `before_revision_id`.

#### POST /api/annotations/projects/{project_id}/subjects/{subject_id}/training-captions/restore

Restore a selected immutable revision as the subject's active caption using project-revision and head-generation conflict checks.

#### POST /api/dataset/export
Combined image-and-caption export for LoRA training datasets. Renames every image according to the supplied pattern, copies (or moves) it to the output folder, and writes the matching `.txt` caption sidecar with the same stem. Optional `mask_export` (`"none"` default | `"onetrainer"` | `"kohya"`, v3.5.x Phase 4): also exports stored training masks — OneTrainer writes `<stem>-masklabel.png` beside each exported image, kohya writes `mask/<stem>.png` (a `conditioning_data_dir` layout). Images without a stored mask count in `masks_missing`, never fail (no mask = train the whole image); successful copies count in `masks_written`. Both counters ride the response. Optional `trainer_config: "kohya_toml"` (+ `trainer_repeats` 1-1000 default 10, `trainer_batch` 1-64 default 2, `trainer_resolution` 256-4096 default 1024) drops a ready `dataset_config.toml` into the output folder — one subset with explicit `num_repeats` (kohya's config method ignores folder-name repeats, per `docs/config_README-en.md`), `caption_extension` matching the export, `class_tokens` from the trigger, and `conditioning_data_dir = <output>/mask` when kohya-style masks were written (`docs/masked_loss_README.md`). Optional `trainer_keep_tokens` (0-50, default 0) additionally emits `shuffle_caption = true` + `keep_tokens = N` on the subset (official config example) so the trigger and leading common tags stay first while the rest shuffle. `trainer_config_path` rides the response; folder mode only.

Optional `subject_crop` is one structured object: `{enabled, alpha_threshold, padding_percent, background_mode, solid_color}`. Omitting it is identical to `enabled=false` and preserves the byte-for-byte copy path. When enabled, `alpha_threshold` (1-255) determines only the subject bounding box, `padding_percent` (0-100) expands each side and clamps to the source, and the exported mask retains its original soft alpha values. `background_mode` is `keep_background`, `transparent_rgba`, or `solid_color`; transparent output is restricted to PNG, WebP, and TIFF, so JPEG fails explicitly. The exact crop box is applied to both image and mask before either image or caption is written. This opt-in mode requires folder output, `image_op="copy"`, positive indexed Library image IDs, a readable non-empty size-matching stored mask, `mask_export != "none"`, and `trainer_config="none"`. Local paths, scan tokens, beside-image output, moves, missing/empty/mismatched masks, and verified trainer packages fail explicitly instead of falling back or skipping. Source files are never modified.

Optional `bucket_resize` is `{enabled, subject_aware, alpha_threshold}` and defaults to `{false, false, 128}`. When enabled, `trainer_resolution` becomes the bucket base resolution and must be a multiple of 64 from 256 through 4096. The exporter scales the canonical SDXL 1024 bucket table, chooses the closest aspect ratio deterministically, center-crops by default, and resizes with LANCZOS. `subject_aware=true` instead positions the crop from stored training-mask pixels whose alpha is at least `alpha_threshold`; lower soft-alpha noise is ignored only for bounding-box planning, while the exported soft mask remains unchanged. The exporter normalizes EXIF Orientation and applies the same geometry to the stored mask. Any exported mask receives the exact same crop and target size as its image. Transformed image, caption, and optional mask files are fully encoded before their final paths are published, with existing files restored if row publication fails. This preprocessing is optional and is not required for Kohya, which already performs aspect-ratio bucketing during training; its added value is producing pre-sized pixels and mask-aware framing before training. Bucket preprocessing requires folder output, `image_op="copy"`, positive indexed Library image IDs, `trainer_config="none"`, and no scan-token/local-path sources. Verified Package v2, beside-image output, and moves fail before outputs are written. Source files and caption text remain unchanged.

Optional `watermark_removal` is `{enabled, method, radius, padding_percent, regions}` and defaults to `{enabled: false, method: "telea", radius: 3, padding_percent: 0, regions: []}`. It is a manual, CPU-only inpainting step: each region is `{x, y, width, height}` in basis points of the visual image (`0..10000`), with at most eight rectangles. The exporter applies the selected OpenCV method after EXIF orientation normalization and before subject crop or bucket geometry, and writes only the copied output image. The `watermark` tag is metadata and is never treated as a pixel mask. Enabling this option requires folder output, `image_op="copy"`, and `trainer_config="none"`; missing OpenCV/NumPy or an invalid region fails the row with an actionable error. It does not claim to detect arbitrary watermarks automatically.

Optional `folder_layout` (`"flat"` default | `"kohya"`) and `kohya_concept` (string, at most 80 characters, default `""`) choose where the pairs land. `"kohya"` writes everything (images, captions, masks, `export_manifest.json`, any trainer config) into `<output_folder>/<trainer_repeats>_<kohya_concept>/`, the folder name kohya-ss sd-scripts' folder method reads repeats from; an empty concept becomes `dataset`. The concept must already be one safe folder name (no whitespace, path separators, `<>:"|?*`, control characters, or leading/trailing dot) or the request fails with 422; the Dataset Maker composes it from the trigger word, then the project name. Readiness, the preview, the start response, the result's `output_folder` and a kohya `dataset_config.toml` `image_dir` all use that subfolder. Both export manifests record the layout (`settings.folder_layout` = `{layout, output_root, subfolder, repeats}`; Package v2 `options.folder_layout`). The export preview accepts the same two fields plus `trainer_repeats`.

`DatasetExportResponse.warnings` is always an array. A completed overwrite whose obsolete backup could not be deleted returns a structured `backup_cleanup_failed` warning with `{code, message, backup_path, error_type, error}`. The exported row remains valid; the retained backup path is shown so the user can verify the new output and remove that backup manually. This condition is never hidden as a log-only success.

Pattern variables: `{filename}`, `{index}`, `{index:03d}` (0-padded counter), `{trigger}`, `{generator}`, `{ext}`, `{date}`.

Accepts either gallery-source items (`image_ids`), small-gallery local items (`image_paths`), or both. `image_overrides` keys may be either `str(image_id)` or absolute paths; both forms map to per-image caption overrides.

Per-image natural-language type (two-box caption editor): `image_types` maps `str(image_id)`/abs-path → `"booru"` | `"nl"` | `"both"`, and `image_nl_overrides` maps the same keys → the user's edited natural-language sentence. After the booru caption is rendered (override or fresh template), an `nl`/`both` entry folds in the natural-language sentence (`both` = tags then sentence; `nl` = sentence only). Images with no `image_types` entry behave exactly as before (booru only) — fully back-compatible for every other caller. Compose applies only to booru-ish content modes (`template`, `tags`); NL-aware modes (`tags_nl`, `nl_caption`, `prompt_nl`) already emit the sentence and are left untouched.

Body:
```json
{
  "image_ids": [1, 2, 3],
  "image_paths": ["C:/dataset/local_001.png"],
  "output_folder": "C:/training/my-lora",
  "naming_pattern": "{trigger}_{index:03d}",
  "trigger": "my_subject",
  "image_op": "copy",
  "overwrite_policy": "unique",
  "blacklist": ["watermark"],
  "common_tags": ["masterpiece", "best_quality"],
  "normalize_tag_underscores": true,
  "image_overrides": {"42": "user-edited caption for this image", "C:/dataset/local_001.png": "caption for the local item"},
  "image_types": {"42": "both", "7": "nl"},
  "image_nl_overrides": {"42": "a girl stands in a sunny field"},
  "subject_crop": {"enabled": false, "alpha_threshold": 1, "padding_percent": 0, "background_mode": "keep_background", "solid_color": "#000000"},
  "bucket_resize": {"enabled": true, "subject_aware": true, "alpha_threshold": 128},
  "watermark_removal": {"enabled": false, "method": "telea", "radius": 3, "padding_percent": 0, "regions": []},
  "trainer_resolution": 1024
}
```

Returns `{status, exported, skipped, error_count, output_folder, items[], total_items, items_truncated, error_messages[]}` where `status` is one of `ok` / `partial` / `failed` / `cancelled`. Per-image results in `items[]` show the source path, destination paths, and any error or skip reason; large responses cap `items[]` and expose the full count through `total_items`.

---

#### POST /api/dataset/export-preview

Preview Dataset Maker export sidecars without writing files. Runs the same caption-assembly engine as `/api/dataset/export` (blacklist removal, common-tag injection, trigger-word prepend, underscore normalization, per-image overrides) but returns the preview rows in-memory instead of touching disk. Used by the Dataset Maker Step C "preview" pane and the renamed-pair chip.

Body matches `/api/dataset/export` minus `image_op` (the preview never moves/copies files); it additionally accepts `limit` (1–500, default 72) bounding how many rows are returned. The same `dataset_scan_tokens` source is supported, so large folder previews page through the manifest the same way export does.

The preview wire contract also accepts and echoes the same validated `subject_crop`, `bucket_resize`, and `watermark_removal` settings through the shared payload model, but it does not transform or write pixels.

Returns `{total, returned, items_truncated, content_mode, output_mode, sidecar_extension, items[]}`. Each `items[]` entry carries `{index, image_id, abs_path, filename, thumbnail_url, output_image_name, output_caption_name, output_image_path, output_caption_path, caption, ai_caption, nl_caption, skipped_reason, error}`. `caption` is the fully-rendered booru-tag line; `nl_caption` is the raw natural-language sentence for the two-box editor. `output_image_path` / `output_caption_path` are empty strings when no output folder is supplied.

---

#### POST /api/dataset/output-folder-status

Count what an export folder already holds, so the Dataset Maker confirm can warn before a second export mixes two datasets in one folder. Body: `{output_folder}`. Read-only and not recursive. Returns `{exists, file_count, image_count, caption_count, has_export_manifest, other_kohya_folders}`; a folder that does not exist yet returns `exists: false` and zeros. When the folder is a kohya concept folder (`<repeats>_<name>`), `other_kohya_folders` lists the other `<repeats>_<name>` folders beside it that hold an export manifest (at most 10): kohya trains all of them, so an earlier export with other repeats or another trigger would train the same pictures twice. Returns `400` for a path that cannot be read as a folder.

---

#### POST /api/dataset/export/start

Start the same dataset export as a background job so large queues can show progress and be cancelled without blocking the browser request. Body is the same as `/api/dataset/export`.

Returns `{status: "started", job_id, total, output_folder, message}`. Poll `GET /api/bulk-jobs/{job_id}` and cancel with `POST /api/bulk-jobs/{job_id}/cancel`; the shared job result carries the export progress or terminal `DatasetExportResponse`. If another dataset export is already running, returns `409`.

---

#### POST /api/dataset/folder-scan

Scan a folder for images and return per-image metadata for the Dataset Maker session WITHOUT registering the images in the main library DB. This is the "small gallery" entry point: a user can curate a LoRA training set straight from a folder, run audit and export against it, and the gallery's main image index stays untouched.

Body:
```json
{
  "folder_path": "C:/source-photos/character-shoot",
  "recursive": false,
  "limit": 5000
}
```

Returns `{folder_path, items[], total_files_seen, skipped_unreadable, truncated, scan_token, offset, next_offset, has_more, page_size}`. Each item carries `{ds_id, abs_path, filename, width, height, mtime, size, thumb_b64, scan_index, source_kind, sidecar_capability}` where `thumb_b64` is a JPEG-encoded base64 string for direct rendering and `ds_id` is a stable session id derived from `sha1(abs_path)`. `scan_token` / `next_offset` / `has_more` / `page_size` form the paging contract: for folders larger than one page, the frontend re-POSTs with `scan_token` + `offset` to fetch subsequent pages without rescanning. Scan-token manifests persist under `data/dataset-scans/` and are garbage-collected after 7 days of inactivity on app startup.

---

#### GET /api/dataset/local-thumbnail

Return a WebP thumbnail for a local-source Dataset Maker item that is NOT in the main library DB. Used by the small-gallery flow when the inline base64 thumb from `/api/dataset/folder-scan` is not enough (full-resolution preview, large folder lazy-load).

Query params: `path` (URL-encoded absolute path), `size` (int, default 256, max 4096). The endpoint is gated by a Dataset Maker session allowlist: the path must have been surfaced by a prior `/api/dataset/folder-scan`, `/api/dataset/upload-files`, or scan-token manifest iteration, otherwise the endpoint returns `403`. This closes the arbitrary-host-file read hole — a path the user never imported is not thumbnail-readable. Returns `image/webp` bytes; `404` if the file is gone or is a symlink. Headers `X-Thumbnail-Cache` (`HIT` / `MISS` / `BYPASS`) and `X-Thumbnail-Placeholder: UNREADABLE` (for the placeholder fallback) are set on every response.

---

#### POST /api/dataset/audit

LoRA-trainer readiness audit. Wraps existing aesthetic + perceptual-hash + tag-presence + dimension checks into a single per-image report. Every threshold is optional — leaving it `null` skips that axis entirely so the user can ask for a fast "what's untagged?" pass without paying the AI inference cost.

Body:
```json
{
  "image_ids": [1, 2, 3],
  "image_paths": ["C:/dataset/local_001.png"],
  "dataset_scan_tokens": [{"scan_token": "abc123...", "exclude_paths": []}],
  "aesthetic_max": 4.5,
  "phash_max": 5,
  "dim_min": 512,
  "enable_aesthetic": true,
  "enable_phash": true,
  "enable_untagged": true,
  "extra_tag_counts": {"C:/dataset/local_001.png": 5},
  "item_limit": 5000
}
```

Returns `{summary, items[], items_truncated, items_returned, duplicate_groups[]}`. `summary` aggregates `{total, low_quality_count, duplicate_pairs, untagged_count, small_count, missing_count, avg_aesthetic, near_duplicate_check_limited, near_duplicate_checked, near_duplicate_attempted, near_duplicate_hashes, near_duplicate_failed, near_duplicate_unavailable_count, near_duplicate_error}`. The `near_duplicate_*` fields describe the perceptual-hash pass: `near_duplicate_check_limited` is `true` when the dataset exceeded the O(N²) near-duplicate cap (5000 images), at which point only exact-hash duplicate groups are reported. Each `items[]` row carries `{image_id, abs_path, filename, width, height, tag_count, aesthetic_score, phash_hex, flags}` where `flags` is a list drawn from `low_quality` / `untagged` / `small` / `missing`. `duplicate_groups[]` clusters images whose perceptual-hash hamming distance is `<= phash_max`; each group is `{phash_hex, image_ids[], abs_paths[]}`. `near_duplicate_full: true` compares every pair even above the 5000-image cap (slower). `item_limit` caps `items[]` (default 5000, max 50000); `items_truncated` / `items_returned` flag when the per-row list was trimmed even though the summary still reflects the full set.

---

#### POST /api/dataset/character-purity

Start a background CCIP character-purity analysis over a Dataset Maker selection (roadmap #9, v1). CCIP (deepghs/ccip_onnx, `ccip-caformer-24-randaug-pruned`, pure onnxruntime — no dghs-imgutils dependency) embeds every gallery image, runs the LEARNED pairwise comparator (`model_metrics.onnx`, not raw cosine), anchors the set on its **medoid** (minimum total difference = the most typical image) and ranks every image by distance-to-medoid. Images above `threshold` (default 0.178, the variant's published operating point; LOWER = same character) are flagged as suspected outliers. **Advisory only**: nothing is moved, deleted, or edited — the result is a review list. Known caveats surfaced in the UI: multi-character images confuse the model, and chibi/style variance legitimately raises distances.

Body: `{"image_ids": [1, 2, 3], "threshold": 0.178}` (`threshold` optional, 0–1). Requires at least 2 unique gallery ids (`400` otherwise), and the model files must already be prepared (`400` with a prepare hint if missing). Returns `{status: "started", job_id, total, message}`; `409` if another analysis is already running. Nonexistent ids and unreadable images count in the result's `failed`, never crash the job.

---

#### GET /api/dataset/character-purity/progress

Live progress for the active character-purity job. Optional query: `job_id` (`404` on mismatch). Returns `{status, job_id, step, current, total, extracted, failed, result, message, message_key, message_args, started_at, updated_at}`. `message` is an English/bilingual display string kept for API compatibility; clients localise from `message_key` (`starting`, `extracting`, `embedding`, `comparing`, `done`, `too_few`, `cancelling`, `cancelled`, `failed`) and `message_args` (`embedding` `{done, total}`, `comparing` `{count}`, `done` `{outliers}`, `failed` `{detail}` with the raw error text). `POST /api/dataset/character-purity` also returns `message_key: "started"`. Terminal statuses: `done` / `failed` / `cancelled`. On `done`, `result` is `{medoid_image_id, items: [{image_id, distance, outlier}], threshold, extracted, failed}` with `items` ranked worst-first (largest distance-to-medoid first).

---

#### POST /api/dataset/character-purity/cancel

Request cooperative cancellation of the active character-purity job. Optional body: `{job_id}` (`404` on mismatch). Returns `{status: "cancelling", job_id, message}` while a job is active, or the current terminal/idle status otherwise.

---

#### GET /api/dataset/character-purity/status

CCIP model availability for the Dataset Maker character-purity card. Returns `{available, model_dir, missing_files[], default_threshold, preparing, prepare_error, download: {active, filename, downloaded, total}}`. v1 deliberately uses this dataset-scoped status endpoint instead of a Model Center registry entry (the registry couples each model to health aggregation, prepare branches, and bundle-sync tests).

---

#### POST /api/dataset/character-purity/prepare

Download the two CCIP ONNX files (`model_feat.onnx` ~143 MB + `model_metrics.onnx`, HuggingFace repo `deepghs/ccip_onnx`) into `data/models/ccip/ccip-caformer-24-randaug-pruned/` in a background thread. Honours the shared Download Source setting via the hf-mirror endpoint order; downloads are size-verified against `Content-Length` plus a per-file sanity floor. Returns `{status: "started"|"ready", model_dir}`; `409` if a download is already running. Progress and failures surface through the status endpoint.

---

#### POST /api/dataset/vocab

Returns the union of tags across the supplied Dataset Maker session, sorted by descending frequency. Combines DB-source tags (read from `image_ids`) and local-source caption text (`path_caption_overrides`, split by comma). Backs the Dataset Maker "Tag Vocabulary" side panel for adding current tags to common tags or blacklist.

Body:
```json
{
  "image_ids": [1, 2, 3],
  "path_caption_overrides": {"C:/dataset/local_001.png": "my_oc, masterpiece, blue_hair"},
  "top_n": 300
}
```

Returns `{vocab: [{tag, count, sample_image_id}], total_unique_tags}` ordered by descending count then alphabetical.

---

#### POST /api/dataset/upload-files

Upload image files directly into the Dataset Maker session via multipart form data. Files are saved to a persistent temp directory (`data/dataset-uploads/`) and the response returns the same item shape as `/api/dataset/folder-scan` so the frontend can feed them into `addLocalItems()`.

Form data: `files` — one or more image files (PNG, JPG, WebP, etc.)

Returns `{items[], skipped_unreadable}`. Each item carries `{ds_id, abs_path, filename, width, height, mtime, size, thumb_b64}`.

---

#### POST /api/dataset/translate

Translate a list of Dataset Maker caption / tag strings for human review (typically English → Chinese). Translation output is advisory only — the frontend never writes it back into training captions unless the user explicitly asks. Two provider modes:

- `provider_mode: "vlm"` (**default**) — uses the configured VLM endpoint (Settings → VLM) with a strict JSON-array translation prompt. Returns 400 if no VLM endpoint is configured. `prompt` optionally overrides the translation instruction.
- any other `provider_mode` value (the frontend sends `"external"`) — uses no-key web translation providers selected via `external_provider`: a single provider name, or a fallback chain keyword — `auto` / `free` / `auto_global` (global chain: google_free → mymemory_free → bing_free → itranslate_free → ...) or `auto_cn` / `mainland` / `china` / `physton` (mainland chain: baidu_free → alibaba_free → sogou_free → ...). Chain keywords try providers in order until one returns non-empty output; a single named provider fails fast without fallback.

Body:
```json
{
  "texts": ["1girl, solo, looking_at_viewer"],
  "mode": "tags",
  "source_lang": "en",
  "target_lang": "zh-CN",
  "provider_mode": "external",
  "external_provider": "auto",
  "prompt": null
}
```

Field notes: `texts` max 200 items. `mode: "tags"` (default) splits comma-separated tag lists, dedupes tokens, and translates unique terms through an on-disk translation cache; other values translate whole lines — but inputs that all look like tag lists are auto-treated as tags. `external_provider` is ignored in VLM mode; `prompt` is ignored in external mode. `source_lang` defaults to `en` (`auto` accepted).

Returns `{translations: [...]}` — same length and order as `texts` — plus provider metadata. VLM mode adds `provider_mode: "vlm"`, `provider`, `model`, `tokens_used`. External mode adds `provider_mode: "external"`, `provider` (the provider that actually succeeded), `source_lang`, `target_lang`, `mode`, `cache_hits`, `cache_misses`, `unique_terms`. There are no per-item `provider`/`error` fields: failures are HTTP errors — 400 when no VLM endpoint is configured, 502 with detail `{error, error_type, provider}` (and `model` in VLM mode) when the provider — or every provider in an auto chain — fails or returns empty output.

Supported external provider names (`*_free` aliases and spelling variants accepted): `google_free`, `mymemory_free`, and `baidu_free`-style Baidu tag lookup run on built-in HTTP clients; `bing_free`, `itranslate_free`, `lingvanex_free`, `modernmt_free`, `systran_free`, `translatecom_free`, `argos_free`, `papago_free`, `reverso_free`, `translateme_free`, `elia_free`, `judic_free`, `alibaba_free`, `sogou_free`, `qqtransmart_free`, `qqfanyi`, `youdao_free`, `iciba_free`, `cloudyi_free`, `caiyun_free` require the optional `translators` runtime (auto-installed on first use). Two keyed providers also exist: `bing` (env `SD_IMAGE_SORTER_TRANSLATE_BING_KEY` / `..._BING_REGION`) and `custom` (env `SD_IMAGE_SORTER_TRANSLATE_CUSTOM_URL` / `..._CUSTOM_KEY` / `..._CUSTOM_KEY_HEADER`).

---

#### POST /api/smart-tag/start

"Smart Tag" wizard: runs a local tagger (WD14 / OppaiOracle / Camie / PixAI) and a natural-language captioner in one pipeline, strips noise tags (`masterpiece` / `score_9` / `anime` / ...), and writes a clean LoRA-ready caption per image. Returns immediately with the job snapshot; progress is polled via `/api/smart-tag/progress`.

Body:
```json
{
  "image_ids": [1, 2, 3],
  "image_paths": ["C:/dataset/local_001.png"],
  "training_purpose": "style",
  "caption_profile": "krea2_long_nl",
  "trigger_word": "myloratrigger",
  "merge_strategy": "replace",
  "auto_strip_noise": true,
  "skip_existing": true,
  "enable_wd14": true,
  "enable_vlm": true,
  "natural_language_mode": "vlm",
  "tagger_model": "",
  "use_gpu": true,
  "general_threshold": 0.35,
  "character_threshold": 0.85
}
```

`natural_language_mode` accepts `vlm` (the configured API/local LLM),
`toriigate` (the local ToriiGate captioner), or `florence2` (the optional local
Florence-2 Base captioner). Florence-2 is not a booru tagger, is never
included in tag voting, and must be prepared from the application-pinned
Hugging Face revision in Model Manager. Local captioner modes run after the
booru phase and fail explicitly if their required caption cannot be generated;
they do not silently fall back to another caption source.

`training_purpose` accepts `style` / `character` / `general` / `concept` (plus aliases `style_lora` / `character_lora` / `concept_lora` / `nsfw` / `nsfw_lora`). Each picks a different VLM prompt: STYLE describes medium / lighting / composition only, CHARACTER describes pose / framing / mood and explicitly avoids hair / eye / signature outfit, GENERAL covers full subject / pose / clothing / scene.

`caption_profile` is optional and currently accepts only `krea2_long_nl`. The
Krea profile keeps the long natural-language system, plain, and tag-grounded
prompts instead of replacing them with the shorter training-purpose prompt;
omitting it or sending `null` preserves the existing behavior. It is valid only
when `enable_vlm=true` and `natural_language_mode="vlm"`; every other
combination returns HTTP 400. Unknown values return the application's normalized
HTTP 400 validation payload with
`body.caption_profile` in `details[].field`. Job snapshots expose the resolved
value as `settings.caption_profile`.

Since v3.4.2 a busy AI runtime (another Smart Tag, gallery tagging, or VLM batch run) queues the job instead of returning 409 — see the AI job queue notes under `POST /api/tag/start`. 409 remains only for validation errors and the fail-closed case where a sibling job's status could not be determined. The progress snapshot includes `pipeline_queue` while entries are waiting.

#### GET /api/smart-tag/progress

Poll the active or named Smart Tag job. With no `job_id` query param, returns the active job
(or `{"status": "idle", "active": false}` if none is running). Job statuses are
`queued`, `running`, `completed`, `warning`, `failed`, and `cancelled`: zero successes with
one or more failures ends as `failed`; mixed successes and failures ends as `warning`; only
a failure-free run ends as `completed`. Snapshots include `total`, `processed`, `succeeded`,
`failed`, `message`, `message_key`, `message_args`, `last_caption_preview`, `caption_result_count`, and tail-capped
`errors: [{image_id, error}]`; `image_id` is a numeric DB ID string or a local source path.

`message` is an English display string kept for API compatibility; clients localise from `message_key` (`cancel_requested`, `smart_tagging`, `smart_tagging_vlm`, `tagging_batch`, `phase1`, `phase1_progress`, `phase2`, `cancelled`, `resolving`, `no_images`, `taggers_sequential`, `loading_tagger`, `loading_tagger_n`, `tagging_model`, `captioner_after_booru`, `loading_vlm`, `loading_captioner`, `consensus`, `consensus_vlm`, `captioning_progress`, `processing_progress`, `vram_refresh`, `memory_critical`, `ram_high`, `done`, `done_warning`, `failed_all`, `failed_caption_profile`, `booru_saved_caption_failed`, `failed`, plus `queued_unknown` / `queued_start_failed` on queue-id lookups), the counters (`succeeded`, `failed`, `skipped`, `total`, `processed`) and `message_args` (a small object such as `{"model": "..."}`; `failed`, `failed_all`, `failed_caption_profile` and `booru_saved_caption_failed` carry the raw provider error as `detail`; every message after a caption model fell back from the GPU to the CPU also carries `device_note: "cpu_fallback"`).

For DB-backed images, caption fields, tag rows, and raw tag-score rows commit in
one SQLite transaction. A failed append read or write is reported as an image
failure and leaves all prior rows unchanged.

`queue_id` (optional query param, additive; V4 slice 6m2): the run queued at that
AI-queue place (`queue_id` from the queued `POST /api/smart-tag/start` answer, which
also carries the entry's `enqueued_at`). A job started from a queue entry records it
as `settings.queue_id` and `settings.queue_enqueued_at`. The answer is that job's
snapshot while it runs and after it ended, for as long as the backend keeps finished
Smart Tag jobs (the newest few); `{"status": "queued"}` while the entry still waits;
`{"status": "failed", "message"}` when it could not start; and
`{"status": "unknown", "found": false}` when the backend no longer knows the entry
(it restarted, or the finished job was dropped). Every answer by `queue_id` carries
`found` and `queue_id`. A queue id can name another entry after the backend restarts: compare
`settings.queue_enqueued_at` with the `enqueued_at` you were given. Without
`queue_id` nothing changes (V3.5 never sends it).

#### GET /api/smart-tag/results

Returns paginated persisted path-source captions, including completed work from `completed`,
`warning`, and `cancelled` terminal jobs. Query params: `job_id`, `offset`, `limit`. Each row
contains `path`, legacy `caption`, and independent `booru_text` / `nl_text` channels. Historical rows return empty channel strings rather than guessing. Gallery captions write directly to SQLite.
Missing, unreadable, malformed, schema-invalid, or truncated result stores return HTTP 500
with the `job_id`, result path, and concrete cause. Clients preserve existing edits and
must not render a success state when the page cannot be read.

#### POST /api/smart-tag/tagged-count

Count how many library images of a planned run already have tags (`tagged_at` set). Body: `{ "image_ids": [int, ...], "selection_token": "..." }` (both optional; path sources are never skipped, so they are not sent). Returns `{ "checked", "already_tagged" }`. With `skip_existing` on, `/start` drops those images entirely (no tags, no natural-language caption, no trigger word), so the Smart Tag dialog asks this first and lets the user skip or process them. 400 for an invalid selection token.

#### POST /api/smart-tag/cancel

Request cancellation of the active Smart Tag job. The worker stops at the next image boundary;
already committed gallery captions and path results remain available. Returns 404 when no job is active.

Optional query params `job_id` and `queue_id` name one run: its queue entry is removed while it
waits (`status: "queue_cleared"`, `removed_queued: 1`), and its job (named, or started from that
queue entry) is cancelled when it is the active one. Other queued Smart Tag runs stay queued. 404
when that run is neither queued nor running. Without either param the active run is cancelled and
every queued Smart Tag run is removed (older clients).

---

Use `/docs` for interactive exploration. Contract drift is checked by `backend/tests/test_api_docs_contract.py`, and `scripts/export_openapi.py` exports a stable sorted OpenAPI JSON schema without starting the server.
