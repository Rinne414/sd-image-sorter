# Changelog

All notable changes to SD Image Sorter will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
