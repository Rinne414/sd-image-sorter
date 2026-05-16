# SD Image Sorter API Documentation

**Version:** 3.2.0
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
| `sort_by` | string | `newest` | `newest`, `oldest`, `name_asc`, `name_desc`, `generator`, `generator_desc`, `prompt_length`, `prompt_length_asc`, `tag_count`, `tag_count_asc`, `rating`, `rating_desc`, `character_count`, `character_count_asc`, `random`, `file_size`, `file_size_asc`, `aesthetic`, `aesthetic_asc` |
| `limit` | int | 100 | Max images per page |
| `cursor` | string | - | Opaque cursor token from the previous page; pass it back unchanged |
| `min_width` | int | - | Minimum width in pixels |
| `max_width` | int | - | Maximum width in pixels |
| `min_height` | int | - | Minimum height in pixels |
| `max_height` | int | - | Maximum height in pixels |
| `prompts` | string | - | Comma-separated prompt terms (AND logic) |
| `aspect_ratio` | string | - | `square`, `landscape`, `portrait` |

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

#### GET /api/images/{image_id}
Get one image with its tags.

#### GET /api/image-file/{image_id}
Serve the original image file.

#### GET /api/image-thumbnail/{image_id}
Serve a thumbnail for the image.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `size` | int | 256 | Max dimension in pixels (1-4096) |

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

#### POST /api/images/selection-ids
Resolve the full ordered ID set for the current filtered result set.

This is the compatibility endpoint for callers that need one complete response. For large filtered selections, prefer the token/chunk pair below unless `sortBy` is `random`.

#### POST /api/images/selection-token
Create a stateless token for chunked filtered-selection ID retrieval.

Request body is the same filter payload as `selection-ids`, plus optional `chunkSize` (`1..10000`, default `2000`) and `excludedImageIds` (`0..10000`) for inverted filtered-selection scopes.

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

#### GET /api/tagger/models
Get available tagger models and runtime guidance. Each model item includes default thresholds, GPU/runtime guidance, and Custom profile metadata such as `custom_profile_supported`, `custom_metadata_format`, and `custom_tags_file_hint`.

#### POST /api/tag/start
Start background tagging (alias for POST /api/tag).

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

Mode rules: `prompt`, `negative`, `prompt_negative`, `a1111`, and `json` preserve the stored Prompt / generation data and ignore `prefix`. `tags` exports only tags after blacklist filtering. `caption_tags` writes optional Class Token + AI caption + Tags. `caption_merged` writes optional Class Token + AI caption + Prompt + Tags as one LoRA-training caption line.

Response includes `status` (`ok`, `partial`, or `error`), `exported`, `skipped`, numeric `errors`/`error_count`, `error_messages`, `total`, `content_mode`, and `overwrite_policy`. `overwrite_policy=skip` returns `partial` when existing sidecars are intentionally left untouched.

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
Move or copy selected images. Request body includes `image_ids`, `destination_folder`, and optional `operation` (`move` or `copy`, default `move`).

#### POST /api/batch-move
Move all images matching filters.

#### GET /api/batch-move/progress
Get batch move progress.

#### POST /api/batch-move/cancel
Cooperatively cancel an in-flight batch move/copy. The worker checks the cancel flag at chunk and per-image boundaries, finishes any image already mid-write, and reports `status: "cancelled"` with the partial counts so the UI can show "Cancelled at X/N" instead of pinning the progress bar at the last running message.

#### POST /api/batch-move/reset
Reset stuck batch move progress.

#### POST /api/sort/start
Start manual sort session. Preferred clients send a JSON body with `generators`, `tags`, `ratings`, `checkpoints`, `loras`, `prompts`, `artist`, `search`, size/aesthetic filters, `folders`, `operation_mode`, and `replace_existing`; this avoids URL/query-length limits for large filter scopes. Legacy query-string parameters remain supported. If an unfinished session exists, the default response is HTTP 409; pass `replace_existing=true` only after the user explicitly chooses to discard saved progress.

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

#### POST /api/browse-folder
List subdirectories for folder picker flows.

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

#### POST /api/censor/batch-refine-mask
Refine multiple masks with SAM3.

#### POST /api/censor/segment-text
Segment via text prompt with SAM3.

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
Generate prompt.

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
| `quality_preset` | string | "high" | Quality level (high/medium/low) |
| `count_tag` | string | "1girl" | Character count tag |
| `nsfw` | bool | false | Include NSFW tags |
| `include_negative` | bool | true | Generate negative prompt |
| `seed` | int | null | Random seed for reproducibility |

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

---

Use `/docs` for interactive exploration. Contract drift is checked by `backend/tests/test_api_docs_contract.py`, and `scripts/export_openapi.py` exports a stable sorted OpenAPI JSON schema without starting the server.
