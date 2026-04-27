# Release Hardening Design

## Goal

Prepare SD Image Sorter for the next public release by fixing the current release blockers without weakening large-library Stable Diffusion workflows. The app must remain useful for power users with 1TB / 100k-image libraries while becoming safer, clearer, and more noob-friendly.

## Scope and execution shape

This is one release-hardening design executed in waves so cross-cutting rules stay consistent while implementation remains reviewable.

### Wave 1 — Backend safety and correctness

- Harden obfuscation output path validation.
- Add upload, base64, image pixel, and metadata text guards.
- Validate custom/local model paths without removing pro workflows.
- Fix pagination/count correctness for prompt, LoRA, aesthetic, cursor, and offset paths.
- Improve backend-side save/error paths used by censor and reader workflows.

### Wave 2 — Censor UX and model setup

- Default censor saves to strip metadata.
- Preserve keep-metadata as an explicit warned option.
- Fix censor image loading race with latest-request-wins behavior.
- Add mobile settings access.
- Clarify detector, SAM3 refinement, text-guided segmentation, and auto-censor flows.
- Add missing YOLO/SAM3 setup guidance and prevent dead-end runnable buttons.
- Prevent silent route/model switching.

### Wave 3 — Gallery, sorting, reader, and similarity workflow clarity

- Improve similarity missing-index and indexing-running states.
- Make Auto-Separate and Manual Sort saved task scopes explicit.
- Remove browse duplicate triggering.
- Add Gallery select-mode delete selected image files.
- Add quick select methods for selection-heavy workflows.
- Add Single Image Reader metadata editing with save-as-new and format conversion.

### Wave 4 — First scan performance

- Investigate scan bottlenecks first.
- Prefer semantics-preserving improvements: batch DB work, skip unchanged files, bounded parsing, and clearer progress stages.
- Do not make scanning fast by silently dropping metadata extraction.

## Shared product and safety rules

- Do not remove advanced functionality for simplicity.
- Do not add small arbitrary limits that weaken real SD workflows.
- Necessary limits must be high enough for real use, scoped to a single crash-prone operation, and explained in user-facing errors.
- Preserve support for huge libraries by paging and streaming correctly, not by loading everything into memory.
- Do not silently mutate selected model, route, output path, metadata mode, or task scope.
- Any operation that could overwrite an original image or existing output file must ask for explicit confirmation first.
- Default destructive or privacy-sensitive workflows toward safer behavior: save as new file, strip metadata, require clear confirmation.
- Preserve these architectures:
  - precomputed similarity embeddings,
  - isolated Auto-Separate and Manual Sort task filter scopes,
  - detector-plus-refiner censor pipeline,
  - advanced custom model support.

## Backend safety design

### Obfuscation and image output paths

Create or consolidate a shared output path validator used by obfuscation, censor save, and reader metadata save endpoints.

The validator must:

- Validate the parent folder using the existing safe path patterns.
- Resolve and canonicalize the final output path.
- Ensure the resolved parent remains the validated parent.
- Allow Windows paths, Chinese paths, spaces, external drives, and normal user-selected folders.
- Restrict output extensions to real image formats: `.png`, `.jpg`, `.jpeg`, `.webp`.
- Reject final output paths that are symlinks.
- Reject output parent mismatches after resolution.
- Return structured information about whether the output file already exists.

Overwrite behavior:

- Existing output files are not an automatic backend error if the request explicitly permits overwrite.
- Default requests should not overwrite.
- Any UI path that targets an existing file, especially the original image path, must ask the user to confirm before sending an overwrite-enabled request.
- Confirmation must show the target filename/path and state that the file will be replaced.

### Upload, base64, image pixel, and metadata guards

Use separate guard types instead of one tiny global limit.

- **Compressed upload byte limit**: apply to uploaded file bodies. Use streaming/chunked reads to temp files or bounded buffers where practical.
- **Decoded base64 byte limit**: estimate decoded size before decoding and reject oversized payloads before memory expansion.
- **Decoded image pixel limit**: check image dimensions early with Pillow and reject decompression-bomb-scale inputs with a clear error.
- **Metadata text chunk limit**: guard individual text chunks before `json.loads()` or expensive parsing. Oversized metadata should be skipped gracefully during scans and surfaced as a metadata warning, not crash or freeze the scan.

These limits protect one request or one image from crashing the local app. They must not limit total library size, number of images, or the ability to scan huge folders.

### Custom/local model path validation

Preserve custom model support with stronger validation.

Model path validation must check:

- allowed extensions per model/runtime type,
- file exists,
- path is a file,
- path is not a symlink,
- sane file-size/runtime compatibility where practical,
- path is inside a trusted root or was explicitly acknowledged through a setup flow.

Trusted roots:

- project `models/` folder,
- user-configured custom model folders if present or added simply.

API requests must not silently load arbitrary local model files outside trusted roots. If a pro user needs an external model root, the UI should guide them to configure or acknowledge it explicitly.

### Pagination and count correctness

Preserve `limit` as a per-request page size for infinite scroll. It is not a user library cap.

Fix requirements:

- Unfiltered Gallery pagination reaches page 2 correctly.
- `prompt_terms` page 1 and page 2 do not repeat incorrectly.
- `loras` page 1 and page 2 do not repeat incorrectly.
- Aesthetic min/max filters affect total count.
- `has_more` becomes false at the correct time.
- Cursor pagination remains correct for newest/oldest paths.
- Offset fallback remains correct for sorts that do not support cursor pagination.

Performance approach:

- Prefer pushing filters into SQL when feasible.
- If post-filtering is still required, use deterministic paged candidate expansion that respects offset and does not fetch the entire library.
- Do not increase browser/API batch size as a fake fix.

## Censor UX and model setup design

### Metadata privacy default

Censor save defaults to **Strip All Metadata**.

`Keep metadata` remains available, but selecting it shows blunt warnings:

- English: `Original prompt/model/seed metadata may be preserved.`
- Chinese: `原始 prompt、模型、seed 等 metadata 可能會被保留。`

If the chosen save target exists or is the original image path, the UI must ask for explicit overwrite confirmation before saving.

### Censor image loading race

`loadCanvasImage()` should use latest-request-wins behavior.

- Each queue click or keyboard navigation creates a request token or pending image id.
- The UI may show pending selection intentionally, but committed selection and canvas state must finalize only for the newest successful load.
- Older loads must not replace the canvas or selected state after a newer request exists.
- Preserve canvas history, queue selection, keyboard navigation, save flow, and save-all behavior.

### Mobile and narrow settings access

On narrow screens, add a visible Settings button for the censor editor.

- Toggle the right settings sidebar with `.mobile-visible` or equivalent existing class.
- Add backdrop and Escape close if consistent with existing modal/sidebar patterns.
- Keep desktop layout unchanged.
- Ensure brush size, detection settings, SAM3/refinement settings, and save options are reachable.
- Add English and Chinese wording.

### Detector, SAM3, and auto-censor workflow

Keep the detector-plus-refiner architecture. Split the UI into explicit actions:

1. Detect regions.
2. Refine Existing Detection Boxes / 精修已有检测框.
3. Text-guided SAM3 segmentation.
4. One-click auto censor.

Behavior rules:

- Refine Existing Detection Boxes requires existing boxes.
- If no boxes exist, explain that this action only refines existing detection boxes and tell the user to use Detect first or One-click Auto Censor.
- SAM3-only text-guided segmentation, if available, must be presented as a separate mode with honest tradeoffs, not a replacement for detector-first workflows.
- Buttons requiring unavailable models/runtimes must be disabled or guided with clear inline help.
- Quick Auto Censor must not silently switch route/model. If the selected route is unsuitable, block execution and offer an explicit action: `Switch to recommended privacy route and continue`.

### Model setup guidance

Add an in-app model status/setup panel for censor models.

It should show:

- YOLO installed/missing/path,
- SAM3 installed/missing/path,
- other detector/refiner status where applicable,
- accepted filenames/extensions,
- exact destination folder,
- Open models folder action where possible,
- Rescan models action,
- one-click download only where legally and technically possible.

Auto-censor should be disabled or guided when required detector models are missing. Disabled tooltip/help must say exactly what model is missing and how to install it.

## Single Image Reader metadata editor

Add an Edit metadata mode in the Single Image Reader.

Editable fields should include common SD metadata fields where present:

- prompt,
- negative prompt,
- seed,
- model/checkpoint,
- sampler,
- steps,
- CFG scale,
- size,
- LoRA text/metadata.

Save behavior:

- Default action is **Save as new image**.
- Suggested filename: `original.metadata-edited.<ext>`.
- Support output format selection: PNG, WebP, JPG/JPEG.
- PNG and WebP should preserve rich metadata where supported.
- JPG/JPEG may have limited metadata support; UI must state which fields may not be preserved fully.
- Output uses the shared output path validator.
- If target path exists or equals the original image path, require explicit overwrite confirmation with filename/path and replacement warning.

Backend endpoints should support:

- reading normalized metadata fields,
- validating edited metadata payloads,
- saving a new image with updated metadata and optional format/quality settings,
- returning clear partial-support warnings for formats with limited metadata capability.

## Gallery, sorting, and similarity design

### Similarity prerequisite guidance

Preserve precomputed embeddings.

States:

- Missing embeddings: show `Similarity search needs indexing first`, current status, and a one-click Start indexing action.
- Indexing running: disable search, show progress/stage and skipped/unreadable/failed counts.
- Index complete: keep fast local search behavior.

Do not add slow per-query full-library similarity computation as a fallback.

### Auto-Separate and Manual Sort task scopes

Preserve dedicated saved task filter scopes.

UI must show:

- `Using saved Auto-Separate scope`,
- `Using saved Manual Sort scope`,
- `Synced from current Gallery filters at <time>`.

Actions:

- Use current Gallery filters,
- Resync from Gallery,
- Keep using saved task scope.

Previews and execution summaries must show which scope is used. The app must not silently inherit or fork Gallery filter state.

### Browse duplicate triggering

Centralize browse folder click handling in JS.

- Remove duplicate inline handlers or guard them.
- Preserve folder browser UX.
- Prevent duplicate requests and flicker.

### Gallery delete selected image files

Add a Gallery select-mode button labeled `Delete selected image files`.

Safety behavior:

- Visually separate it from ordinary actions.
- Confirm before deleting.
- Confirmation shows count and example filenames.
- Prefer moving to OS trash/recycle bin if supported.
- If permanent delete is used, say clearly that files will be deleted from disk permanently.
- Do not confuse removing from DB with deleting actual files.
- After success, update database, clear/update frontend selection, and refresh gallery state.
- Partial failures show filename plus error summary.

### Quick select methods

Add quick selection methods where selection is used, starting with Gallery:

- Select all visible/loaded,
- Deselect all,
- Invert visible,
- Shift-click range.

If Select all filtered results is added, it must be explicit about total count and must not silently select huge destructive target sets. Massive destructive actions need an additional confirmation.

## First scan performance design

Investigate before optimizing.

Measure or inspect time spent in:

- directory traversal,
- PIL open/verify,
- metadata parsing,
- hashing,
- thumbnail generation if any,
- DB inserts/updates,
- per-image commits,
- accidental model/tagging work,
- duplicate work on unchanged files.

Initial safe improvements:

- Batch DB inserts/updates in transactions.
- Skip unchanged files using path + mtime + size cache where reliable.
- Use bounded parallel metadata parsing only if thread/process safety is clear.
- Add scan progress stages: discovering files, reading metadata, updating database, finished.
- Add clear ETA/counts where practical.

If a quick index plus deep metadata mode is introduced, the UI must explain the tradeoff and allow pro users to retain full metadata extraction. It must not silently remove metadata functionality.

## Tests and verification

### Backend tests

Add focused failing tests before implementation where practical:

- Obfuscation/output validation: valid output, invalid extension, symlink rejection, existing-file behavior, original overwrite confirmation behavior.
- Upload/base64/metadata guards: oversized upload, oversized decoded base64, oversized decoded pixels, oversized metadata chunk.
- Model path validation: invalid extension, missing file, symlink, valid project model path, valid custom configured root.
- Pagination: unfiltered page 2, prompt page 1/page 2, LoRA page 1/page 2, aesthetic total count, has_more false, cursor newest/oldest, offset fallback.
- Metadata editor: read normalized metadata, save-as-new, format conversion warnings, safe output path, no silent overwrite.
- Gallery delete backend: trash/permanent delete behavior, DB sync, partial failure where practical.

### Frontend tests and helpers

Where frontend test coverage is limited, extract small helpers or add narrow tests for:

- latest-request-wins selection state,
- route switch confirmation state,
- saved task scope display state,
- similarity missing-index and indexing-running state,
- metadata editor overwrite confirmation state.

### Manual smoke checklist

Run manual checks for UI-heavy flows:

- Censor rapid queue clicks.
- Censor rapid left/right keyboard navigation.
- Switching while image loads.
- Edit image, switch away, switch back.
- Save all.
- Missing YOLO/SAM3 setup guidance.
- SAM3 refine with no boxes.
- Quick Auto Censor unsafe route prompt.
- Reader metadata edit and save-as PNG/WebP/JPG.
- Reader attempted overwrite of original image, confirm and cancel.
- Gallery select visible, invert, shift range, delete selected confirm, partial failure UI.
- Similarity no embeddings, indexing running, index complete search.
- Auto-Separate/Manual Sort saved scope wording and resync.

### CI and review gates

- Run targeted `pytest` for touched backend areas.
- Run JS syntax check if available.
- Run `python scripts/run_ci.py` before final review if practical.
- Because UI changes are included, start the app and do browser smoke testing before claiming completion. If full browser testing is not possible, state exactly what was not verified.
- Use code review after implementation.
- Use Python review for backend Python changes.
- Use security review for path, upload, model, delete, and overwrite-related changes.
- Use build-error resolver for failing build/test issues; do not bypass hooks.

## Open implementation notes

- Do not perform a broad frontend file split as part of this work unless a small extraction is needed for testability.
- Prefer focused changes in existing large files.
- Keep UI wording available in English and Chinese.
- Preserve existing global APIs/events unless all callers are intentionally migrated.
