# SD Image Sorter API Documentation

**Version:** 3.5.0
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
- **Artist Identification**: Experimental artist/style classification

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

A lightweight in-memory rate limit is applied to API requests. Static files and image-serving endpoints are exempt.

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
| `sort_by` | string | `newest` | `newest`, `oldest`, `name_asc`, `name_desc`, `generator`, `generator_desc`, `prompt_length`, `prompt_length_asc`, `tag_count`, `tag_count_asc`, `rating`, `rating_desc`, `character_count`, `character_count_asc`, `random`, `file_size`, `file_size_asc`, `aesthetic`, `aesthetic_asc`, `brightness`, `brightness_asc`, `saturation`, `saturation_asc`, `brightness_skew`, `brightness_skew_asc`, `user_rating`, `user_rating_asc` |
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
| `brightness_distribution` | string | - | `left_heavy`, `right_heavy`, `middle_heavy`, `edge_heavy`, `balanced`; requires color analysis data |
| `folder` | string | - | v3.3.2: absolute directory path; restricts results to that folder **and all subfolders** (recursive, case-insensitive). Forward- or back-slashes accepted. Composes with every other filter. |
| `has_metadata` | bool | - | v3.3.2: tri-state "has SD generation parameters" filter. Omit for all images; `true` keeps only images with a known generator **or** a non-empty prompt; `false` keeps only images with neither (e.g. plain PNGs). Distinct from `metadata_status` (parse-pipeline state). Composes with every other filter. |
| `no_caption` | bool | - | v3.5.0: `true` keeps only images with no AI caption and no NL caption (both empty/NULL) — the "still needs captioning" workflow chip. |
| `aesthetic_unscored` | bool | - | v3.5.0: `true` keeps only images with no aesthetic score yet (`aesthetic_score IS NULL`); takes precedence over `min_aesthetic`/`max_aesthetic` when set. Backs the filter modal's 未评分 tier. |
| `min_saturation` | float | - | v3.5.0: minimum average saturation, `0..255`; requires color analysis data |
| `max_saturation` | float | - | v3.5.0: maximum average saturation, `0..255`; requires color analysis data |
| `seed` | int | - | v3.5.0: exact generation seed match (extracted from metadata). Powers the toolbar `seed:` search key. |

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
List durable bulk background jobs, newest first. Query param `active_only=true` hides finished (`done`/`error`/`cancelled`) jobs. Response: `{ "jobs": [ ... ] }`.

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

Each item carries the review row plus candidates enriched from the live images table (`image_id`, current `path`, `file_size`, `source_mtime_ns`, `still_missing`) and `found_exists` for the discovered file. Candidate ids deleted since the run are omitted.

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
        { "image_id": 3, "path": "D:/old/same.png", "file_size": 2048, "source_mtime_ns": 1700000000000000000, "still_missing": true }
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

#### POST /api/image-metadata/save-edited
Save an image copy with edited metadata fields.

#### POST /api/open-folder
Open an image's containing folder in the host file explorer.

#### POST /api/parse-image
Parse uploaded image metadata without inserting into library DB.

### Tags

#### GET /api/tags
Get all tags with counts.

#### GET /api/generators
Get generators with counts.

#### GET /api/tags/library
Get tag library. Optional query params: `sort_by=frequency|alphabetical`, `q=<text>`, `limit=<n>`. Search runs across the full tag table before applying `limit`.

#### GET /api/prompts/library
Get prompt token library. Optional query params: `q=<text>`, `limit=<n>`. Search runs across the full prompt-token index before applying `limit`.

#### GET /api/loras/library
Get LoRA library. Optional query params: `q=<text>`, `limit=<n>`. Search runs across the full LoRA index before applying `limit`.

#### GET /api/checkpoints/library
Get the checkpoint (base model) library for the Library tab's Checkpoints facet. Returns `{ "checkpoints": [{ "name", "count" }], "total" }` aggregated across the full indexed library.

#### GET /api/tagger/models
Get available tagger models and runtime guidance. Each model item includes default thresholds, GPU/runtime guidance, and Custom profile metadata such as `custom_profile_supported`, `custom_metadata_format`, and `custom_tags_file_hint`.

#### POST /api/tag/start
Start background tagging (alias for POST /api/tag).

**AI job queue (v3.4.2):** gallery tagging, Smart Tag, and VLM caption batches share one runtime. Starting any of them while another AI job is running no longer returns 409 — the job is enqueued (FIFO) and auto-starts when the current job finishes (including after an error or cancel). The start endpoint then returns `{"status": "queued", "pipeline_queued": true, "queue_id": "qN", "queue_position": N, "queue_length": N, "message": ..., "pipeline_owner": ..., "pipeline_mode": ...}` instead of the started-now shape. Re-submitting an identical request while it is already last in the queue returns the same shape with `"duplicate": true` instead of enqueueing twice. The queue is in-memory and does not survive a server restart. 409 is still returned for the fail-closed case (a sibling job's status could not be determined) and for validation errors. Each kind's cancel endpoint also removes that kind's queued entries (`removed_queued` count in the response).

#### POST /api/tag
Start background tagging.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `image_ids` | int[] \| null | null | Specific images (`null` + `retag_all=false` = all untagged) |
| `threshold` | float | 0.35 | Threshold for general tags after score normalization |
| `character_threshold` | float | 0.85 | Threshold for character tags after score normalization |
| `retag_all` | bool | false | Re-tag already tagged images when no explicit `image_ids` are supplied |
| `model_name` | string \| null | default tagger | Built-in tagger model name, or the selected Custom profile when `model_path` is used |
| `model_path` | string \| null | null | Local Custom ONNX model path; must exist and end in `.onnx`. User-supplied files are never deleted or re-downloaded by the repair path |
| `tags_path` | string \| null | null | Optional local tag metadata path for Custom ONNX only; requires `model_path`. If supplied, it must exist and match the selected profile extension. If omitted, the tagger auto-detects profile-specific metadata next to the model: WD14/PixAI use `selected_tags.csv`; Camie uses `camie-tagger-v2-metadata.json` or `metadata.json` |
| `custom_profile` | string \| null | null | Custom ONNX profile: `wd14`, `camie-tagger-v2`, or `pixai-tagger-v0.9`. `toriigate-0.5` is rejected because ToriiGate is not ONNX |
| `use_gpu` | bool | true | Request GPU runtime when available |
| `allow_unsafe_acceleration` | bool | false | Reserved unsafe acceleration override |
| `batch_size` | int \| null | null | Optional user override for runtime chunk size. If omitted, Custom ONNX starts conservatively |

#### GET /api/tag/progress
Get tagging progress.
The response now includes truthful runtime fields so the UI can distinguish target mode from the backend that actually ran:

- `runtime_backend_target`
- `runtime_backend_actual`
- `runtime_backend_reason`
- `memory_pressure_warning`

**v3.4.2:** the progress snapshot additionally carries `pipeline_queue`: `{"total_queued": N, "queued": [{"queue_id", "kind", "position", "enqueued_at"}], "last_start_error"}` so pollers can render "Queued #N" before the job starts. The same field appears on the Smart Tag and VLM batch progress endpoints.

#### GET /api/tags/pipeline-queue
Read-only snapshot of the shared AI-job FIFO queue across all kinds — gallery tagging / smart-tag / VLM / aesthetic (v3.5.0, Aurora Phase 3). Returns the same shape as the `pipeline_queue` field above, standalone: `{"total_queued": N, "queued": [{"queue_id", "kind", "position", "enqueued_at"}], "last_start_error"}`. Powers the gallery action bar's live AI-queue indicator without polling a job-specific progress endpoint. No side effects.

#### POST /api/tag/reset
Reset stuck tagging task.

#### POST /api/tag/cancel
Cancel the active tagging task.

#### GET /api/tags/export
Export all tag data as JSON.

#### POST /api/tags/import
Import tag data from JSON.

#### POST /api/tags/export-batch
Export one same-name sidecar per selected image. Text modes write `.txt`; `json` writes `.json`.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `image_ids` | int[] | required | Images to export (min 1) |
| `output_folder` | string | required | Output directory |
| `prefix` | string | "" | Optional Class Token prepended only to training-caption modes (`caption_tags`, `caption_merged`) |
| `blacklist` | string[] | `[]` | Tags excluded from tag/caption outputs |
| `content_mode` | string | `tags` | `tags`, `prompt`, `negative`, `prompt_negative`, `a1111`, `caption_tags`, `caption_merged`, or `json` |
| `overwrite_policy` | string | `unique` | `unique` creates non-colliding filenames, `skip` leaves existing sidecars untouched, `overwrite` replaces sidecars |
| `image_types` | object | `{}` | v3.5.0 (caption editor): per-image caption type `{image_id: "booru"\|"nl"\|"both"}`. `nl`/`both` fold the stored (or overridden) natural-language sentence into the caption; absent keys mean `booru` and reproduce the pre-v3.5.0 output byte-for-byte |
| `image_nl_overrides` | object | `{}` | v3.5.0 (caption editor): per-image edited NL sentence `{image_id: text}`. An explicit empty string suppresses the stored sentence |

Mode rules: `prompt`, `negative`, `prompt_negative`, `a1111`, and `json` preserve the stored Prompt / generation data and ignore `prefix`. `tags` exports only tags after blacklist filtering. `caption_tags` writes optional Class Token + AI caption + Tags. `caption_merged` writes optional Class Token + AI caption + Prompt + Tags as one LoRA-training caption line. `image_types` / `image_nl_overrides` apply only in `template` and `tags` modes (the same gate as `/api/dataset/export`) and are also accepted by `POST /api/tags/export-combined`.

Response includes `status` (`ok`, `partial`, or `error`), `exported`, `skipped`, numeric `errors`/`error_count`, `error_messages`, `total`, `content_mode`, and `overwrite_policy`. `overwrite_policy=skip` returns `partial` when existing sidecars are intentionally left untouched.

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
The payload includes step-oriented fields such as `step`, `current_item`, `started_at`, `updated_at`, `recent_errors`, `metadata_pending`, `attention_required`, `attention_message`, `stalled_seconds`, `diagnostics_available`, and `diagnostics_endpoint`. When `attention_required=true`, clients should show a visible stalled-scan warning and offer diagnostics copy/open actions instead of leaving the user with a frozen-looking progress bar. Corrupt / truncated files are reported by filename and excluded from the normal library.

#### POST /api/scan/cancel
Cancel the active scan task.

#### POST /api/scan/reset
Reset stuck scan progress.

#### POST /api/move
Move or copy selected images synchronously. Request body includes `image_ids`, `destination_folder`, and optional `operation` (`move` or `copy`, default `move`). Returns the per-image `results` once complete; kept for small selections and existing integrations.

#### POST /api/move/start
Start a background move/copy job for the same request body as `/api/move`, returning immediately so the UI can show a progress bar. Responds `409` if a move job is already running. Use this for large selections where the synchronous endpoint would block.

#### GET /api/move/progress
Get background move/copy progress: `running`, `total`, `processed`, `moved`, `copied`, `errors`, `step`, `message`, and the final per-image `results` when done. Progress is guarded by a run-id epoch so a newly started job never reports a stale previous job's state.

#### POST /api/move/cancel
Cooperatively cancel an in-flight background move/copy. The worker checks the cancel flag at per-image boundaries, finishes any file already mid-write, and reports `status: "cancelled"` with partial counts.

#### POST /api/move/reset
Reset stuck background move progress.

#### POST /api/batch-move
Move all images matching filters. JSON filter payloads accept `prompt_match_mode` (`exact` or `contains`, default `exact`) alongside `prompts`.

#### GET /api/batch-move/progress
Get batch move progress.

#### POST /api/batch-move/cancel
Cooperatively cancel an in-flight batch move/copy. The worker checks the cancel flag at chunk and per-image boundaries, finishes any image already mid-write, and reports `status: "cancelled"` with the partial counts so the UI can show "Cancelled at X/N" instead of pinning the progress bar at the last running message.

#### POST /api/batch-move/reset
Reset stuck batch move progress.

#### POST /api/sort/start
Start manual sort session. Preferred clients send a JSON body with `generators`, `tags`, `ratings`, `checkpoints`, `loras`, `prompts`, `prompt_match_mode`, `artist`, `search`, size/aesthetic filters, `folders`, `operation_mode`, and `replace_existing`; this avoids URL/query-length limits for large filter scopes. Legacy query-string parameters remain supported, including `prompt_match_mode=exact|contains`. If an unfinished session exists, the default response is HTTP 409; pass `replace_existing=true` only after the user explicitly chooses to discard saved progress.

#### GET /api/sort/current
Get current sort image.

#### POST /api/sort/action
Perform `move`, `skip`, or `undo`.

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
    "missing_prompt": 120,
    "untagged": 240,
    "unreadable": 3
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

#### GET /api/collections/favorites/ids
List the ids of all favorited images (plus `count`) for fast client-side heart-state hydration.

#### POST /api/collections/favorites
Set the favorite state of one image. Body carries `image_id` and `favorited` (default `true`; pass `false` to unfavorite). Returns `{ "favorited": bool }`.

### Entry Page

#### GET /api/entry/summary
Aggregate stats for the v4.0 mission entry page in one call: `library_total`, `added_today`, `unviewed` (images indexed after the `last_seen` watermark the client stored from a previous call's `server_now`), activity `streak_days` / `today_touched` (fed by the `activity_log` daily counters), and the deterministic daily ★5 `hero` pick (`hero_seed` query param offsets the pick for 换一张; `null` when no image is rated ★5).

### Model Manager

#### GET /api/models/status
Get local model/runtime readiness status.

#### GET /api/models/mirror
Get the current download mirror preference.

#### POST /api/models/mirror
Set the download mirror preference (auto, hf-mirror, modelscope).

#### GET /api/models/download-progress
Get active model download progress (bytes downloaded, total size).

#### GET /api/models/bulk-bundle
Inventory of models that the "Download all recommended models" button covers.

Returns each model with its current ready/missing status and estimated
download size, plus the total bytes the button would fetch if pressed
right now. The frontend uses this to render the confirmation dialog
showing how much disk space is needed before bulk download.

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
      "variant": "wd-swinv2-tagger-v3"
    }
  ],
  "pending_total_bytes": 7807402393,
  "ready_count": 1,
  "pending_count": 5
}
```

#### POST /api/models/prepare
Prepare or download a model/runtime.

For `model_id = "censor-legacy"`, a Civitai login wall now returns a structured `409 Conflict` instead of a generic `500`.
The JSON payload includes:

- `error`
- `type`
- `message`
- `provider`
- `manual_steps`
- `external_url`

### Censor

#### POST /api/censor/detect
Run censor detection.

#### POST /api/censor/preview
Preview censoring.

#### POST /api/censor/save
Save censored output to disk.

#### POST /api/censor/save-data
Save edited base64 canvas output.

#### POST /api/censor/save-operations
Save a non-destructive edit operation list on top of the original image.

#### POST /api/censor/refine-mask
Refine mask with SAM3.

Optional `sam3_confidence` (float 0.0–1.0): rejects low-confidence refinements — applied as both the mask score threshold and the text-prompt presence gate. Omitted = legacy thresholds. Rejected boxes return `status: "fallback"` (bounding-box censor).

#### POST /api/censor/batch-refine-mask
Refine multiple masks with SAM3.

Accepts the same optional `sam3_confidence` at the batch level (the censor editor's confidence slider sends this); each item may override it with its own `sam3_confidence`.

#### POST /api/censor/segment-text
Segment via text prompt with SAM3.

Body: `image_id` (int), `text_prompt` (string), optional `presence_threshold` (float 0.0–1.0). The presence gate defaults to a looser explicit-text value, decoupled from the stricter 0.5 auto-detect gate, so deliberately-typed prompts are not silently rejected; pass `presence_threshold` to override (higher = stricter recall).

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

#### POST /api/similarity/search-upload
Find similar images by uploaded file.

#### GET /api/similarity/duplicates
Find near-duplicate pairs.

#### GET /api/similarity/stats
Get embedding statistics.

#### GET /api/similarity/model-status
Get local CLIP runtime readiness and the preferred local model path.

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
| `tag_sets` | array | [] | Tag set ids/names to apply |

Response: `positive_prompt`, `negative_prompt`, `prompt` (alias of `positive_prompt`), `tags_used`, `exclusions_applied`, and `warnings` describe the first generated prompt, plus `count` (prompts actually generated) and `prompts` (array of per-prompt objects with the same fields, length == `count`). With a fixed `seed` and `count > 1`, prompt slot `i` uses `seed + i`, so the batch is varied but reproducible.

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

> **Warning: Experimental Feature**
>
> Artist identification is experimental. It uses a predefined label list and may not accurately identify all artists. The feature is provided for exploration purposes and should not be relied upon for critical workflows.

#### POST /api/artists/identify
Identify artist for one image.

**Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `image_id` | int | required | Image ID to identify |
| `threshold` | float | 0.35 | Minimum confidence threshold (0.0-1.0) |
| `top_k` | int | 5 | Number of top predictions to return (1-20) |

**Response:**
```json
{
  "image_id": 1,
  "artist": "greg_rutkowski",
  "confidence": 0.78,
  "top_predictions": [
    {"artist": "greg_rutkowski", "confidence": 0.78},
    {"artist": "alphonse_mucha", "confidence": 0.45}
  ],
  "model_loaded": true,
  "experimental": true
}
```

#### POST /api/artists/identify-batch
Start batch identification.

**Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `image_ids` | int[] | required | List of image IDs |
| `threshold` | float | 0.35 | Minimum confidence threshold |
| `top_k` | int | 5 | Number of predictions per image |

#### GET /api/artists/batch-progress
Get identification progress.
The response includes step-oriented status fields such as `message`, `current_item`, `started_at`, and `updated_at` for frontend diagnostics.

#### GET /api/artists/models
List artist models.


#### GET /api/artists/diagnostics
Get Kaloscope / LSNet runtime diagnostics for the frontend banner.

#### GET /api/artists/stats
Get artist stats.

#### GET /api/artists/images/{artist_name}
List images associated with an artist prediction.

#### GET /api/artists/list
Get known artist list.

#### DELETE /api/artists/clear
Clear artist predictions.

### Obfuscation

#### POST /api/obfuscate/encode
Encode image with obfuscation algorithm.

#### POST /api/obfuscate/decode
Decode obfuscated image.

#### POST /api/obfuscate/batch
Run encode/decode in batch mode.

#### POST /api/obfuscate/preview
Generate obfuscation preview.

### Aesthetic

#### GET /api/aesthetic/status
Get aesthetic scorer availability and scored count.

#### POST /api/aesthetic/score/{image_id}
Score a single image.

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

#### POST /api/updates/apply
Apply a downloaded update package.

When an update is scheduled, response includes `pending_manifest` and `restart_required`. The updater validates archive entries and the package manifest before copying files, and rejects protected runtime paths such as `data/`, `update/downloads/`, `update/logs/`, `update/state/`, `update/worker/`, and `update/backups/`.

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

Added in v3.2.1. Tag-Master-inspired bulk operations on the DB tags table. Every mutation accepts `dry_run=true` to preview affected counts and up to 5 sample before/after pairs before committing.

#### GET /api/tags/bulk/state
Report bulk-operation backend state (cancellable in-flight job, last completion summary, capability flags). Useful for the mass tag editor UI to gate destructive actions.

#### POST /api/tags/bulk/find-replace
Rename a tag across N images. Body: `{find, replace, scope, dry_run}`. Empty `replace` removes the tag. Returns `{affected_images, samples, committed}`.

#### POST /api/tags/bulk/add
Append tags to a selection. Body: `{image_ids|filter, tags: [{tag, confidence}], dedupe, dry_run}`. Existing tags are kept; the new confidence wins only when explicitly requested.

#### POST /api/tags/bulk/remove
Delete specified tags from a selection. Body: `{image_ids|filter, tags, case_sensitive, dry_run}`.

#### POST /api/tags/bulk/cleanup
Drop tags below a confidence threshold and deduplicate by case-insensitive tag name keeping the highest-confidence copy. Body: `{image_ids|filter, min_confidence, dedupe, dry_run}`.

#### GET /api/tags/export-presets
List built-in tag/caption export presets used by the LoRA training template engine (Anima Tags+NL, Anima Tags-only, Illustrious / Pony, NoobAI, FLUX, Kohya SD1.5, Custom).

#### POST /api/tags/export-preview
Render up to 20 sample caption files for a given preset without writing to disk. Body: `{image_ids, preset_id|template, options}`. Returns rendered captions keyed by image id plus the resolved template variables.

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
Return the saved VLM configuration (provider, endpoint, model, prompt preset, output format, concurrency, retries, proxy).

#### POST /api/vlm/settings
Persist the VLM configuration. Body: full settings payload (secrets handled server-side). Returns the saved settings minus secrets.

#### POST /api/vlm/test
Test the current VLM credentials and endpoint with a tiny probe image. Returns `{ok, latency_ms, sample_caption, error}`.

#### POST /api/vlm/models
List available models for the configured provider (calls provider's `models` API or falls back to a curated list).

#### GET /api/vlm/presets
List built-in system-prompt presets (general LoRA NL, Anima/FLUX detailed, single-sentence, character LoRA, NSFW-tolerant, danbooru, hybrid).

#### POST /api/vlm/caption
Caption a single image. Body: `{image_id, override_settings?}`. Returns `{caption, tokens_used, latency_ms}`.

#### POST /api/vlm/caption-batch
Start a concurrency-controlled batch caption job. Body: `{image_ids|filter, concurrency, retries, retry_delay, output_format, prompt_preset?}`.
While another AI job is running the batch is queued instead of rejected — see the AI job queue notes under `POST /api/tag/start` (v3.4.2). The cancel endpoint also removes queued VLM entries.

#### GET /api/vlm/caption-batch/progress
Live progress for the running batch: `{state, total, completed, failed, tokens_used, current_image, started_at, errors: [{image_id, error, type}]}` (errors list capped at 50).

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

#### POST /api/dataset/export
Combined image-and-caption export for LoRA training datasets. Renames every image according to the supplied pattern, copies (or moves) it to the output folder, and writes the matching `.txt` caption sidecar with the same stem.

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
  "image_nl_overrides": {"42": "a girl stands in a sunny field"}
}
```

Returns `{status, exported, skipped, error_count, output_folder, items[], total_items, items_truncated, error_messages[]}` where `status` is one of `ok` / `partial` / `failed` / `cancelled`. Per-image results in `items[]` show the source path, destination paths, and any error or skip reason; large responses cap `items[]` and expose the full count through `total_items`.

---

#### POST /api/dataset/export-preview

Preview Dataset Maker export sidecars without writing files. Runs the same caption-assembly engine as `/api/dataset/export` (blacklist removal, common-tag injection, trigger-word prepend, underscore normalization, per-image overrides) but returns the preview rows in-memory instead of touching disk. Used by the Dataset Maker Step C "preview" pane and the renamed-pair chip.

Body matches `/api/dataset/export` minus `image_op` (the preview never moves/copies files); it additionally accepts `limit` (1–500, default 72) bounding how many rows are returned. The same `dataset_scan_tokens` source is supported, so large folder previews page through the manifest the same way export does.

Returns `{total, returned, items_truncated, content_mode, output_mode, sidecar_extension, items[]}`. Each `items[]` entry carries `{index, image_id, abs_path, filename, thumbnail_url, output_image_name, output_caption_name, output_image_path, output_caption_path, caption, ai_caption, nl_caption, skipped_reason, error}`. `caption` is the fully-rendered booru-tag line; `nl_caption` is the raw natural-language sentence for the two-box editor. `output_image_path` / `output_caption_path` are empty strings when no output folder is supplied.

---

#### POST /api/dataset/export/start

Start the same dataset export as a background job so large queues can show progress and be cancelled without blocking the browser request. Body is the same as `/api/dataset/export`.

Returns `{status: "started", job_id, total, output_folder, message}`. If another dataset export is already running, returns `409`.

---

#### GET /api/dataset/export/progress

Live progress for the active dataset export job. Optional query: `job_id`.

Returns `{status, job_id, step, current, total, exported, skipped, errors, current_item, recent_errors, output_folder, items_truncated, result, message}`. Terminal progress uses `status: "done"`, `"cancelled"`, or `"failed"`; when available, `result` is the same summary shape returned by `/api/dataset/export`.

---

#### POST /api/dataset/export/cancel

Request cooperative cancellation for the active dataset export job. Optional body: `{job_id}`.

The worker finishes the current image pair, then stops before the next image and reports a `cancelled` result with the number already exported.

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

Returns `{summary, items[], items_truncated, items_returned, duplicate_groups[]}`. `summary` aggregates `{total, low_quality_count, duplicate_pairs, untagged_count, small_count, missing_count, avg_aesthetic, near_duplicate_check_limited, near_duplicate_checked, near_duplicate_attempted, near_duplicate_hashes, near_duplicate_failed, near_duplicate_unavailable_count, near_duplicate_error}`. The `near_duplicate_*` fields describe the perceptual-hash pass: `near_duplicate_check_limited` is `true` when the dataset exceeded the O(N²) near-duplicate cap (5000 images), at which point only exact-hash duplicate groups are reported. Each `items[]` row carries `{image_id, abs_path, filename, width, height, tag_count, aesthetic_score, phash_hex, flags}` where `flags` is a list drawn from `low_quality` / `untagged` / `small` / `missing`. `duplicate_groups[]` clusters images whose perceptual-hash hamming distance is `<= phash_max`; each group is `{phash_hex, image_ids[], abs_paths[]}`. `item_limit` caps `items[]` (default 5000, max 50000); `items_truncated` / `items_returned` flag when the per-row list was trimmed even though the summary still reflects the full set.

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

"Smart Tag" wizard: runs a local tagger (WD14 / OppaiOracle / Camie / PixAI) and a VLM in one pipeline, strips noise tags (`masterpiece` / `score_9` / `anime` / ...), and writes a clean LoRA-ready caption per image. Returns immediately with the job snapshot; progress is polled via `/api/smart-tag/progress`.

Body:
```json
{
  "image_ids": [1, 2, 3],
  "image_paths": ["C:/dataset/local_001.png"],
  "training_purpose": "style",
  "trigger_word": "myloratrigger",
  "merge_strategy": "replace",
  "auto_strip_noise": true,
  "skip_existing": true,
  "enable_wd14": true,
  "enable_vlm": true,
  "tagger_model": "",
  "use_gpu": true,
  "general_threshold": 0.35,
  "character_threshold": 0.85
}
```

`training_purpose` accepts `style` / `character` / `general` / `concept` (plus aliases `style_lora` / `character_lora` / `concept_lora` / `nsfw` / `nsfw_lora`). Each picks a different VLM prompt: STYLE describes medium / lighting / composition only, CHARACTER describes pose / framing / mood and explicitly avoids hair / eye / signature outfit, GENERAL covers full subject / pose / clothing / scene.

Since v3.4.2 a busy AI runtime (another Smart Tag, gallery tagging, or VLM batch run) queues the job instead of returning 409 — see the AI job queue notes under `POST /api/tag/start`. 409 remains only for validation errors and the fail-closed case where a sibling job's status could not be determined. The progress snapshot includes `pipeline_queue` while entries are waiting.

#### GET /api/smart-tag/progress

Poll the active or named Smart Tag job. With no `job_id` query param, returns the active job (or `{"status": "idle", "active": false}` if none is running). Snapshot contains `total`, `processed`, `succeeded`, `failed`, `message`, `last_caption_preview`, and a tail-capped `errors[]` list.

#### GET /api/smart-tag/results

Returns paginated path-source caption results for a completed Smart Tag job, used by Dataset Maker local-folder imports. Query params: `job_id`, `offset`, `limit`. Gallery-source captions are written directly to the DB and do not need this endpoint.

#### POST /api/smart-tag/cancel

Request cancellation of the active Smart Tag job. The worker stops at the next image boundary. Returns 404 when no job is active.

---

Use `/docs` for interactive exploration. Contract drift is checked by `backend/tests/test_api_docs_contract.py`, and `scripts/export_openapi.py` exports a stable sorted OpenAPI JSON schema without starting the server.
