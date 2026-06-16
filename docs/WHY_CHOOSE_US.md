# Why SD Image Sorter?

## Positioning

**SD Image Sorter — The Only Image Manager Built for AI Artists**

Unlike general-purpose image managers that treat AI-generated images like photos, SD Image Sorter is designed from the ground up for Stable Diffusion workflows. It understands your metadata, speaks your language, and provides tools that match how AI artists actually work.

## What Makes Us Different

### 1. Deep SD Metadata Understanding

**SD Image Sorter:**
- Natively reads ComfyUI, NovelAI, WebUI, Forge metadata without conversion
- Extracts prompts, negative prompts, seeds, steps, CFG, samplers, models, LoRAs, VAEs automatically
- Preserves metadata when editing and re-exporting images
- Filters by checkpoint, LoRA, aspect ratio, generation parameters

**Allusion / TagStudio / DigiKam / Hydrus:**
- Treat SD images as generic files with arbitrary tags
- Require manual tagging or custom parsing scripts
- No awareness of AI generation context or workflows

### 2. AI-First Feature Set

**SD Image Sorter:**
- WD14 family auto-tagging (7 models: ViT, SwinV2, ConvNeXt, EVA02, Camie, PixAI, ToriiGate)
- CLIP similarity search for finding duplicates and near-matches
- VLM captioning with 5 providers (OpenAI, Anthropic, Gemini, Vertex, Ollama)
- Prompt Lab: reverse-engineer prompts from your own library
- Artist identification: experimental style recognition
- Aesthetic scoring: local beauty ranking
- LoRA training export with template engine (7 presets, 14 variables)

**Allusion:**
- Basic tagging
- No AI features

**TagStudio:**
- Manual tagging only
- No AI features

**DigiKam:**
- Face detection (photo-centric)
- No SD-specific AI features

**Hydrus:**
- Manual tags
- Some third-party AI integrations exist but not first-party

### 3. Workflow Speed

**SD Image Sorter:**
- WASD keyboard-driven manual sorting (4-way split + skip + undo)
- Auto-Separate: filter + preview + action in one 3-pane view
- Manual Sort multi-mode: Slot Mode (4-way), Bracket Mode (ranking), Cull Mode (keep/delete)
- Background job queue with live progress tracking
- Batch operations on thousands of images

**Allusion:**
- Click-and-drag sorting
- Slower for large batches

**TagStudio:**
- Manual organization
- No keyboard-first workflows

**DigiKam:**
- Traditional photo manager UI
- Slower for bulk operations

**Hydrus:**
- Powerful but complex UI
- Steep learning curve

### 4. Deployment & Privacy

**SD Image Sorter:**
- Single-file portable launcher (Windows: zip, Linux: tarball)
- No installation, no dependencies, no account
- 100% local, zero cloud upload
- Models run on your machine

**Allusion:**
- Traditional installer
- Local-first

**TagStudio:**
- Python required
- Local-first

**DigiKam:**
- Full KDE stack required
- Local-first

**Hydrus:**
- Complex setup
- Local-first but heavy

### 5. SD-Specific Tools

**SD Image Sorter:**
- Censor Editor: YOLO/NudeNet detection + brush tools + batch queue
- Image Reader: drag-drop metadata extraction without importing
- Image Obfuscate: password-protected sharing
- Collections system with folder tree navigation
- Star ratings (1-5 stars)
- Library roots: multiple folder hierarchies

**Allusion / TagStudio / DigiKam / Hydrus:**
- None of these are SD-specific
- General image editing or viewing only

## Competitive Comparison

| Feature | SD Image Sorter | Allusion | TagStudio | DigiKam | Hydrus |
|---------|----------------|----------|-----------|---------|--------|
| **SD Metadata** | Native ComfyUI/NAI/WebUI/Forge | ❌ | ❌ | ❌ | ❌ |
| **AI Auto-Tagging** | WD14 family (7 models) | ❌ | ❌ | Face detect only | Via plugins |
| **VLM Captioning** | 5 providers + Ollama | ❌ | ❌ | ❌ | ❌ |
| **CLIP Similarity** | ✅ | ❌ | ❌ | ❌ | ✅ (third-party) |
| **Keyboard Sorting** | WASD 4-way + multi-mode | ❌ | ❌ | ❌ | ❌ |
| **Censor Tools** | YOLO + brush + batch | ❌ | ❌ | ❌ | ❌ |
| **Prompt Lab** | ✅ Reverse-engineer prompts | ❌ | ❌ | ❌ | ❌ |
| **LoRA Export** | Template engine + presets | ❌ | ❌ | ❌ | ❌ |
| **Deployment** | Portable single-file | Installer | Python required | Full KDE stack | Complex setup |
| **Learning Curve** | Low-Medium | Low | Medium | Medium | High |
| **Large Libraries** | 50k+ tested | Unknown | Slower | Good | Good |
| **Privacy** | 100% local | Local | Local | Local | Local |

## When to Choose SD Image Sorter

✅ **Choose SD Image Sorter if you:**
- Generate images with Stable Diffusion, ComfyUI, NovelAI, or similar tools
- Have thousands to tens of thousands of AI-generated images
- Want fast keyboard-driven sorting workflows
- Need AI auto-tagging, similarity search, and metadata filtering
- Want a portable, zero-setup, local-first tool
- Need to prepare datasets for LoRA training
- Want to batch-censor images for sharing

❌ **Consider alternatives if you:**
- Primarily work with photos (not AI art) → DigiKam
- Need a simple, minimal UI with no AI features → Allusion
- Want maximum control and complexity → Hydrus
- Need a lightweight tagging-only tool → TagStudio

## Real-World Use Cases

### Dataset Curation
- Scan 50k generations
- Auto-tag with WD14
- Filter by tags + rating + model
- Export to LoRA training folders with template captions

### Portfolio Sorting
- Import all outputs from last month
- WASD manual sort: best / portfolio / archive / delete
- CLIP similarity to find duplicates
- Star-rate favorites

### Safe Sharing
- Select explicit images
- Censor Editor: auto-detect + manual brush
- Batch queue processing
- Export censored versions to share folder

### Prompt Mining
- Scan your best 1000 images
- Prompt Lab reverse-engineers common patterns
- Copy reusable prompt snippets
- Apply to new generations

## Bottom Line

**SD Image Sorter is not trying to be a universal image manager. It is purpose-built for people who generate AI art and need a fast, local, metadata-aware tool to manage thousands of outputs without clicking through menus or learning arcane tag syntax.**

If you generate AI images and your folder is chaos, this tool exists to fix that problem specifically.
