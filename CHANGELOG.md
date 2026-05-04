# Changelog

All notable changes to SD Image Sorter will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [3.1.0] - 2026-05-04

### About This Release / 关于这一版
v3.1.0 was driven by real user feedback and a focused tech-debt pass. Almost every fix below either resolves a concrete issue reported by users running the portable build on real hardware, or pays down accumulated complexity that was making the app harder to use and harder to ship safely. **A huge thank you to everyone who shared logs, screenshots, and step-by-step reproductions — this release exists because of you.**

v3.1.0 完全由真实用户反馈和一轮聚焦的技术债务清理推动。下面几乎每一项修复，要么是来自用户在真机上跑 portable 包时报告的具体问题，要么是在偿还过去积累下来的复杂度——那些让 app 越来越难用、越来越难安全发版的东西。**衷心感谢每一位分享日志、截图、复现步骤的用户——这一版完全是因为你们才存在的。**

### Added
- Reader is no longer just for viewing. Users can now edit prompt, negative prompt, seed, sampler, steps, CFG, size, model, and LoRA fields, then save the result as a new image directly from the app.
- Reader save now lets users choose the output format (`png` / `webp` / `jpg`) and save location more directly, including images that were uploaded through the browser.
- Folder scan now becomes usable earlier: the library can appear first, while the remaining images and metadata continue loading in the background.
- SAM3 Pro Segmentation is available as an experimental option in the censor editor, alongside the existing Wenaka / NudeNet privacy detectors.

### Fixed
- Reader overwrite is now safer and less annoying. If the user saves to the same path, the app asks first instead of failing once before asking.
- Reader confirmation text no longer gets overwritten while the dialog is open.
- Desktop navigation no longer hides the Reader tab too aggressively on normal desktop screens.
- WSL / Linux runs now handle old Windows drive paths (`L:\...`) properly, so affected libraries no longer lose thumbnails just because the backend is running in WSL.
- Scan progress is clearer during large imports. Users now see that the app is still importing in the background instead of feeling like the scan froze.
- JPG / WebP warnings now explain the metadata limitations honestly instead of implying they behave like PNG.
- SAM3 Pro censor no longer paints a giant box over the whole image when a prompt isn't actually present (e.g. asking for "exposed genitalia" on a clothed image). A presence-probability gate plus a max-mask-area cap rejects the whole-body false-positive collapse the model used to fall back to. Previously selectable concepts that genuinely *are* present (breasts, nipples, buttocks) keep working and recover small detections that the old score-only threshold accidentally filtered out.
- Windows first launch no longer misreads a freshly installed CUDA PyTorch wheel through the old already-imported CPU `torch` module, which previously could trigger repeated multi-GB CUDA wheel downloads before falling back with a misleading warning.

### Documentation
- README now states realistic first-launch disk-space and network-traffic budgets, including CUDA runtimes, pip cache, and on-demand AI model sizes.

### Known Limitations
- **SAM3 Pro Segmentation is experimental.** The text-prompted detection path is significantly weaker than its ComfyUI counterpart (which uses box-prompted refinement). Recall on anime/SD images is low and bounding boxes are often coarse. **Recommended workflow: keep NudeNet (default) or Wenaka YOLOv8 for primary censoring.** SAM3 is best treated as an opt-in experiment until a future release lands a hybrid NudeNet→SAM3 refine pipeline.

### Validation
- Reader save / overwrite flow passed real browser validation end-to-end.
- Scan and metadata regression tests passed after the v3.1.0 scan-experience updates.
- SAM3 presence-gate regression verified on real anime/SD test images (no whole-body false positives on absent prompts; small-region recall preserved).

## [3.0.6] - 2026-04-20

### Fixed
- ComfyUI prompt extraction now follows `SamplerCustomAdvanced → CFGGuider` chains, `JoinStringMulti` nodes, and capital-`S` `String` nodes.
- Aesthetic scoring no longer freezes the system at ~1000 images. Added periodic `torch.cuda.empty_cache()` + `gc.collect()`, explicit PIL image closing, and batched commits.
- Disabled LoRAs (`on: false`) in rgthree Power Lora Loader are now excluded from the LoRA list and filter.
- Censor save as JPG/WebP now preserves SD metadata by converting PNG text chunks to EXIF UserComment. Parser also reads ComfyUI JSON back from EXIF UserComment in JPEG/WebP files.
- Gallery empty state no longer shows a duplicate camera-icon message alongside the styled card.
- Artist ID progress bar no longer stuck on "Starting..." — removed blocking overlay and fixed `data-i18n` attribute that kept overwriting dynamic progress text.
- Artist confidence threshold value no longer disappears after language refresh.
- Manual Sort now shows a confirmation dialog before starting a sort session.

### Added
- LoRA weights (`strength_model` / `strength_clip`) are now extracted and displayed next to each LoRA name in the image detail modal.
- VAE and CLIP/Text Encoder models are now extracted from ComfyUI workflows and shown in the Model Assets section.
- Version strings synced to `3.0.6`.

## [3.0.5] - 2026-04-20

### Fixed
- Removed the stale "launch-time GPU confirmation" product semantics from the tagger flow. The UI and E2E suite now match the real behaviour: automatic hardware clamps stay active without a separate confirmation modal.
- Tightened the Censor workspace sidebar sizing so the queue header and Queue Manager button stay readable without squeezing the canvas workspace.
- Folder scan now performs a real two-pass streaming walk: one cheap count pass for truthful progress totals, then a second processing pass without materializing the full file list in memory.
- Synced release-facing version strings to `3.0.5` across the API metadata, README download links, and the model-download User-Agent.
- Playwright startup paths now fall back across Windows and POSIX virtualenv layouts instead of hardcoding one platform-specific Python path.

## [3.0.4] - 2026-04-19

### Fixed
- Reader clipboard capture now tells the truth: clipboard images may lose SD PNG metadata in the browser, the button arms the `Ctrl+V` capture flow instead of relying on `navigator.clipboard.read()`, and metadata-lost clipboard results no longer silently look like successful parses.
- `POST /api/models/prepare` for `censor-legacy` now returns a structured `409 Conflict` auth-wall response instead of a generic `500`. The payload includes `error`, `type`, `message`, `manual_steps`, and `provider`, and the model manager renders the result as a warning instead of a server crash.
- `POST /api/models/prepare` for `censor-legacy` now also returns a structured non-500 `ModelPreparationFailed` response when Civitai serves a bad archive or extraction fails, instead of leaking `BadZipFile` / generic server-crash semantics.
- Folder scan now performs a real image decode verification, so corrupt and truncated files are reported as errors, named in scan progress, and kept out of manual sort / tagging / similarity flows.
- Single-image move now re-validates file readability, so truncated images are rejected instead of being treated as successful moves just because the file still exists.
- Similarity embedding progress now reports `skipped`, `unreadable`, and `failed` separately, including recent filenames / image ids instead of a vague `1 failed`, and similarity search / duplicate results now exclude rows already marked unreadable.

## [3.0.3] - 2026-04-18

### Fixed
- `run-portable.bat`, `run.bat`, and `run.sh` now honour `SD_IMAGE_SORTER_PORT` when printing the "Open browser" URL and when auto-opening the browser. Previously the launchers hardcoded `http://localhost:8487`, so users who overrode the port were silently routed to the wrong URL while the server bound the correct one.
- `/api/models/prepare` for `censor-legacy` no longer 500s on fresh installs. Two fixes: (1) Civitai metadata + archive requests now use a realistic browser `User-Agent` header (the old default `Python-urllib/x.y` was rejected with HTTP 403), target the new `civitai.red` domain, and fall back to a pinned direct-download URL when the API path misbehaves. (2) Civitai additionally gates NSFW model downloads behind account login; unauthenticated requests get an HTML sign-in page instead of the zip, which used to surface as a cryptic `BadZipFile`. The backend now detects the sign-in page (Content-Type `text/html` or invalid zip) and raises a clear manual-download guide pointing at the Civitai page and the local `models/yolo/` directory. The app cannot bypass Civitai's auth wall — this is a Civitai policy change.
- `/api/artists/diagnostics` now reports `available:true` when the HuggingFace / ModelScope fallback has already loaded a working artist model at runtime, matching the behaviour of `/api/artists/identify`. Adds `runtime_loaded`, `runtime_backend`, and `runtime_error` fields so the UI can distinguish "Kaloscope files missing but fallback loaded" from "nothing loaded".

### Added
- ToriiGate first-use now emits an explicit `~5 GB from HuggingFace` progress message before the model download starts, so users on slow or metered connections are not surprised by a silent multi-gigabyte fetch. Subsequent runs show a short "Loading ToriiGate on GPU/CPU" message instead.

## [3.0.2] - 2026-04-18

### Fixed
- NVIDIA VRAM total is no longer clamped at 4095 MB on Windows when `torch.cuda` is unavailable. `hardware_monitor.py` now overlays `nvidia-smi --query-gpu` results on top of WMI's 32-bit `AdapterRAM` readout.
- Dual-NVIDIA rigs match each card to its own VRAM by device name instead of by enumeration index, so WMI PnP order and nvidia-smi NVML order disagreeing no longer swaps VRAM between cards.
- Tagger batch-size recommendation now reflects actual VRAM (e.g., RTX 3090 picks batch size 32 instead of 8).

### Added
- Regression tests in `backend/tests/test_hardware_monitor.py` covering the WMI cap override, the degraded fallback when nvidia-smi is unavailable, dual-NVIDIA name-match ordering, and the guarantee that Intel/AMD devices never receive nvidia-smi overlays.

## [2.1.0] - 2026-04-04

### Added
- Local model readiness reporting in the launcher and browser UI
- Portable release packaging script with core-model, artist-runtime, and split large-model assets
- User-facing release and model setup guides
- Artist diagnostics endpoint and Similar CLIP status endpoint

### Changed
- Default artist backend switched from `cafe_style` to `Kaloscope2.0`
- Censor Edit now auto-selects the recommended Wenaka privacy model when it exists locally
- Legacy YOLO support now distinguishes privacy-part models from general compatibility models
- README and third-party model policy rewritten around the real verified model pipeline

### Fixed
- Kaloscope runtime path now works with `comfyui-lsnet` / `lsnet-test` layouts
- Local CLIP model path is preferred correctly for similarity search
- NudeNet box normalization is corrected for frontend/backend integration
- General YOLO `.onnx` / `.pt` compatibility is validated instead of assuming Wenaka-only outputs

## [2.0.0] - 2024-03-XX

### Added
- **Favorites Workflow**: New favorites gallery with copy-to-favorites functionality
- **Upgraded Gallery Preview**: Improved image preview with keyboard navigation
- **SAM3 Mask Refinement**: Pixel-precise segmentation for censoring
- **CLIP Similarity Search**: Find similar images and detect duplicates
- **Prompt Lab**: Intelligent prompt generation with tag categorization
- **Artist Identification**: Experimental artist/style classification (LSNet-based)
- **Thumbnail Cache**: Persistent disk-based thumbnail cache with WebP compression
- **Service Layer Refactoring**: Dependency injection pattern for all routers
- **Path Validation Security**: Comprehensive directory traversal prevention

### Changed
- Refactored all routers to use service layer pattern
- Improved metadata parser to handle more ComfyUI workflow variations
- Enhanced thumbnail generation with configurable sizes
- Updated UI with glassmorphism design improvements

### Fixed
- SQL injection prevention in all database queries
- Path traversal vulnerabilities in file operations
- Memory leaks in AI model loading
- Race conditions in background tasks

### Security
- Added `utils/path_validation.py` for comprehensive path security
- Parameterized all SQL queries
- Added input validation at API layer

## [1.5.0] - 2024-02-XX

### Added
- YOLOv8 detection for NSFW content
- NudeNet integration for body part detection
- Manual sort session with WASD keyboard controls
- Auto-separate feature for batch image organization
- WebP metadata extraction support

### Changed
- Improved ComfyUI workflow parsing
- Enhanced tag import/export functionality

### Fixed
- Unicode handling in prompts
- Memory usage with large image libraries
- Database locking issues

## [1.4.0] - 2024-01-XX

### Added
- WD14 tagger integration (ONNX Runtime)
- Multiple tagger model support (EVA02, ViT, Swin, ConvNeXt)
- Tag confidence filtering
- Batch tagging with progress tracking

### Changed
- Migrated to ONNX Runtime for AI models
- Improved database schema with indexes

## [1.3.0] - 2023-12-XX

### Added
- Forge generator detection
- NovelAI metadata parsing
- ComfyUI workflow extraction
- WebUI/A1111 parameter parsing

### Changed
- Unified metadata parser architecture

## [1.2.0] - 2023-11-XX

### Added
- Gallery view with generator tabs
- Advanced filtering (generator, tags, dimensions)
- Image detail modal with metadata display

### Changed
- Redesigned frontend with glassmorphism theme

## [1.1.0] - 2023-10-XX

### Added
- SQLite database for image metadata
- Folder scanning with metadata extraction
- Basic image grid view

### Changed
- Initial FastAPI backend structure

## [1.0.0] - 2023-09-XX

### Added
- Initial release
- Basic image serving
- Simple HTML frontend
