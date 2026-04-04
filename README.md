# SD Image Sorter (AI 图像筛选管理器)

[English](#english) | [简体中文](#简体中文)

---

<a name="english"></a>

# 🎨 SD Image Sorter

A powerful image management tool for Stable Diffusion users. Automatically extract metadata, tag images with AI, filter, sort, and organize your AI-generated artwork with a premium glassmorphism UI.

![Version](https://img.shields.io/badge/version-2.1.0-purple)
![Python](https://img.shields.io/badge/python-3.9+-blue)
![License](https://img.shields.io/badge/license-MIT-green)

---

### 🤔 Sound familiar?

> - 😵 Tons of images — some have metadata, some don't, and you can't tell them apart
> - 🔍 Want to filter by specific tags / prompts / models, but existing tools just can't do it
> - 📚 Want to build a local tags/prompts library from your own image collection
> - 🔳 Auto-censor always misjudges, only draws rigid rectangles, and you can't manually tweak it
> - 🧹 Want to batch-strip metadata, or selectively keep it after censoring
>
> **Give this tasty tool a try! 🍜**

---

## 📸 Screenshots

| Gallery View | Manual Sort | Censor Edit |
|:------------:|:-----------:|:-----------:|
| ![Gallery](docs/screenshots/gallery_view.png) | ![Manual Sort](docs/screenshots/manual_sort.png) | ![Censor Edit](docs/screenshots/censor_edit.png) |

## 🎬 Demo

| Gallery Navigation | Manual Sort Flow |
|:------------------:|:----------------:|
| ![Gallery Demo](docs/screenshots/gallery_demo.gif) | ![Manual Sort Demo](docs/screenshots/manual_sort_demo.gif) |

---

## ✨ Features

### 🖼️ Gallery Management
- **Multi-source support**: ComfyUI, NovelAI, WebUI/Forge, and unknown formats
- **Metadata extraction**: Automatically reads prompts, settings, checkpoints, and LoRAs
- **Advanced filtering**: Filter by generator, tags, ratings, checkpoints, LoRAs, prompts, or dimensions
- **Smart sorting**: Sort by date, name, prompt length, tag count, or rating

### 🏷️ AI Tagging (WD14 Tagger)
- **High-accuracy models**: EVA02-Large, SwinV2, ConvNeXt, etc.
- **Dual thresholds**: Separate recognition sensitivity for general vs. character tags
- **Rating classification**: Predicts General, Sensitive, Questionable, or Explicit

### 📁 Image Organization & Sorting
- **Auto-Separate**: Bulk move images matching filters to specific destination folders
- **Manual Sort**: Fast, "game-like" sorting using **WASD** keys
- **Undo Support**: Instantly revert sorting actions

### 🔳 Censor Edit (V2)
- **Multi-Model Detection**: Choose between Legacy YOLO, NudeNet v3, or both
- **Smart Defaults**: If the local Wenaka privacy model exists, the app auto-picks it so most users can leave the legacy model path blank
- **AI Detection**: Privacy-focused Wenaka YOLO, NudeNet v3, or both can be used from the UI
- **Clear Capability Split**: Wenaka is treated as the fast fixed-class privacy detector, the local YOLO26/YOLOv8 files are shown as fixed-class general segmentation test models, and SAM3 is the prompt-guided precision tool
- **Multiple Styles**: Mosaic, blur, black bar, or white bar
- **Precision Tools**: Manual brush, eraser, clone stamp, and SAM3 text-prompt segmentation for pro users when the GPU runtime is ready
- **Batch Processing**: Queue-based workflow with batch save and rename
- **Safer Failure Handling**: Unreadable files no longer poison the gallery or break the censor queue
- **Runtime Feedback**: The banner now tells you which local models are actually ready, which workflow is recommended for normal users, and what each model can really do

### 🔍 Similar Images (NEW)
- **Visual Search**: Find similar images by visual content using CLIP embeddings
- **Duplicate Detection**: Identify near-duplicate images in your library
- **Upload Search**: Upload any image to find similar ones in your collection
- **Adjustable Threshold**: Fine-tune similarity sensitivity
- **Clearer Runtime Feedback**: Missing model/dependency issues now surface as actionable errors instead of silent empty results
- **Local-First CLIP**: The app prefers the local `models/clip` cache when it exists and shows its status in the Similar tab

### 🧪 Prompt Lab (NEW)
- **Smart Generation**: Generate random prompts with intelligent tag selection
- **Exclusion Rules**: Automatic prevention of conflicting tags (e.g., "from_behind" excludes "looking_at_viewer")
- **Tag Sets**: Pre-built outfit combinations (School Uniform, Swimsuit, etc.)
- **Category Browser**: Explore your library's tags by category
- **Built-in Fallback Pools**: Still usable even when your own tag library is sparse
- **Negative Prompt**: Auto-generate quality-focused negative prompts

### 🎨 Artist Identification (NEW)
- **LSNet-style Classification**: Identify the artist/style of your images
- **Confidence Threshold**: Images below threshold labeled as "undefined"
- **Batch Processing**: Identify all images with progress tracking
- **Artist Filtering**: Filter gallery by identified artist
- **Statistics**: View top artists and their image counts
- **Default Backend**: Now targets `Kaloscope2.0`
- **Runtime Diagnostics**: The Artist tab now tells you whether Kaloscope, the LSNet runtime, and Windows `triton` support are actually ready

---

## 🚀 Quick Start

### Prerequisites
- **Python 3.9+**
- **RAM**: 4GB minimum for the base app, 8GB+ recommended for most AI features, 16GB+ recommended for Artist ID
- **Disk Space**: ~2GB for the app/runtime, plus optional model downloads
- **Windows** (Recommended) or Linux/Mac

### Installation & Run

1. **Clone/Download** the repository:
   ```bash
   git clone https://github.com/peter119lee/sd-image-sorter.git
   cd sd-image-sorter
   ```

2. **Run the app**:
   - **Windows**: Double-click `run.bat`
   - **Linux/Mac**: Run `chmod +x run.sh && ./run.sh`

3. **Access UI**: Open `http://localhost:8000` in your browser.

*The first run will automatically set up a virtual environment and install dependencies. Later launches also re-check `backend/requirements.txt` and refresh new or missing dependencies automatically.*

The launcher also prints a local model readiness summary, and the `Censor`, `Similar`, and `Artist ID` tabs show user-facing health banners in the browser.

> [!TIP]
> **No Python installed?** Use the [`bundled-python`](https://github.com/peter119lee/sd-image-sorter/tree/bundled-python) branch — it auto-downloads Python for you!

> [!NOTE]
> Model licensing and redistribution are separate from runtime auto-download behavior. If you plan to ship GitHub Release archives, read [THIRD_PARTY_MODELS.md](THIRD_PARTY_MODELS.md) before bundling any weights.

> [!TIP]
> **Want the least confusing setup?** Start with the release asset `sd-image-sorter-v2.1.0-portable-core-models.zip`, then read [docs/RELEASE_PACKS.md](docs/RELEASE_PACKS.md) and [models/README.md](models/README.md) only if you want optional large-model extras.

---

## 🧰 Hardware Guide

### Does it support weak hardware?

**Yes, partly.**

- **Works well on weak hardware**: Gallery, metadata parsing, filters, Auto-Separate, Manual Sort, Prompt Lab
- **Works on weak hardware but may be slow**: WD14 tagging, basic censor detection, Similar/CLIP embedding generation
- **Not recommended for weak hardware**: Artist ID with `Kaloscope2.0`
- **Currently not supported on weak hardware / CPU-only machines**: `SAM3`

In this README, **weak hardware** means something like:

- 4 CPU cores
- 8GB RAM
- integrated graphics or an older GPU
- SATA SSD or even HDD

That class of machine can still use the app, but you should stay on the lighter workflows and avoid the largest optional models.

### Recommended hardware by feature

| Feature | Weak hardware support | Minimum usable hardware | Recommended hardware | Notes |
|:--------|:----------------------|:------------------------|:---------------------|:------|
| Gallery / metadata / filters | Yes | 2-4 CPU cores, 4GB RAM | 4+ cores, 8GB RAM, SSD | This is mostly file I/O and SQLite work. SSD helps a lot on large libraries. |
| Scan folder / large library indexing | Yes, but slower | 4 CPU cores, 4GB RAM, SSD preferred | 6+ cores, 8-16GB RAM, SSD | Very large libraries benefit more from SSD and CPU than from GPU. |
| Auto-Separate / Manual Sort | Yes | 4GB RAM | 8GB RAM, SSD | These workflows are light unless you combine them with AI tagging or censoring. |
| Prompt Lab | Yes | 4GB RAM | 8GB RAM | Mostly database + frontend work. |
| WD14 tagging (`wd-swinv2-tagger-v3`) | Yes, but slower | 4 CPU cores, 8GB RAM | 6+ CPU cores, 16GB RAM, optional NVIDIA GPU with 6GB+ VRAM | This is the best default model for normal and weaker machines. CPU mode works. |
| WD14 tagging (`wd-eva02-large-tagger-v3`) | Not ideal for weak hardware | 16GB RAM | 16-32GB RAM, optional NVIDIA GPU with 8GB+ VRAM | Higher accuracy, but much heavier than `wd-swinv2-tagger-v3`. |
| Censor detection: Wenaka / NudeNet | Yes | 4 CPU cores, 8GB RAM | 6+ cores, 8-16GB RAM, optional GPU with 4GB+ VRAM | Good low-end route. On weaker machines, use one detector at a time if `both` feels too slow. |
| Censor detection: YOLO26 / YOLOv8 compatibility models | Yes, but only as advanced tests | 4 CPU cores, 8GB RAM | 6+ cores, 8-16GB RAM | These are fixed-class general models in the current local setup, not free-text privacy detectors. |
| Similar Images / CLIP embeddings | Yes, but first build can be slow | 4 CPU cores, 8GB RAM, SSD strongly recommended | 6+ CPU cores, 16GB RAM, SSD | The current CLIP path is local-first and CPU-friendly, but full-library embedding still takes time on big collections. |
| Artist ID (`Kaloscope2.0`) | Technically possible on some CPU systems, but not weak-hardware-friendly | 16GB RAM, fast SSD, Windows users also need `triton-windows` | 8+ CPU cores, 32GB RAM, fast SSD, NVIDIA GPU with 8GB+ VRAM recommended | Treat this as an advanced optional feature, not a baseline feature. |
| SAM3 text/box refinement | No for CPU-only or weak hardware | CUDA-capable NVIDIA GPU required | NVIDIA GPU with 10GB+ VRAM and 16GB+ system RAM recommended | In the current verified setup, SAM3 is treated as GPU-only. |

### Verified local model sizes

These are the currently verified file sizes from the local `models/` folder, so users can estimate disk needs more realistically:

| Model | Current verified size |
|:------|:----------------------|
| `wd-swinv2-tagger-v3` | ~445.8 MB |
| `wd-eva02-large-tagger-v3` | ~1202.0 MB |
| `Qdrant-clip-ViT-B-32-vision` | ~335.4 MB |
| `wenaka_yolov8s-seg.onnx` | ~45.7 MB |
| `yolo26s-seg.onnx` | ~40.0 MB |
| `yolov8s-seg.onnx` | ~45.3 MB |
| `NudeNet 320n.onnx` | ~11.6 MB |
| `Kaloscope2.0 best_checkpoint.pth` | ~2801.8 MB |
| `SAM3 sam3.pt` | ~3290.2 MB |

### Low-end hardware advice

If you are setting this up for non-technical users or a weaker PC:

- Start with **Gallery**, **Manual Sort**, and **Prompt Lab**
- Use **`wd-swinv2-tagger-v3`**, not the larger EVA02 model
- For censoring, prefer the default Wenaka route or `NudeNet v3` alone before trying heavier combinations
- Expect the first **CLIP embedding** build to take time on large libraries
- Treat **Artist ID** and **SAM3** as optional extras, not must-have defaults
- Put the project and models on an **SSD** whenever possible

## 🧭 Censor Model Guide

### Which censor model should normal users pick?

| Option | Input | Output | Best for | Who should use it |
|:-------|:------|:-------|:---------|:------------------|
| `both` | No prompt required | Detection boxes from Wenaka + NudeNet | Best default balance of convenience and recall | Most users |
| `legacy` + auto-picked Wenaka | Fixed privacy-part labels | Fast privacy-part boxes | Quick privacy workflows | Users who want the simplest privacy-only route |
| `nudenet` | No prompt required | Built-in NSFW/body-part boxes | Fast body-region detection without custom setup | Users who want one simple detector |
| `legacy` + `yolo26s` / `yolov8s` | Fixed built-in object classes | General segmentation results | Compatibility tests and advanced experiments | Pro users only |
| `SAM3` text/box refine | Text prompt or box prompt | Pixel-accurate masks | Precision cleanup after coarse detection | Pro users with CUDA GPU |

### Why keep the normal `yolov8s` / `yolo26s` files if Wenaka already exists?

- `wenaka_yolov8s-seg` is the real privacy-part route and should be treated as the normal censor workflow.
- The local `yolov8s-seg` and `yolo26s-seg` files are kept for **advanced compatibility and segmentation testing**.
- In the currently verified local setup, those general files are **fixed-class models**, not open-text detectors and not privacy-part specialists.
- They are still useful when a pro user wants to compare outputs, verify ONNX/PT loading, or test non-privacy segmentation behavior.
- They are **not** the recommended path for ordinary privacy censoring, so the UI hides them behind **Show advanced legacy models** by default.

### How to use `NudeNet`

1. Open **Censor Edit** and add one or more images to the queue.
2. In the detection panel, set **Model Type** to `nudenet`.
3. Ignore the privacy quick-checkboxes and the text prompt box for this route.
4. Click **Detect Current** or **Detect All**.
5. Review the boxes, then use brush/eraser/clone tools if you want manual cleanup.
6. Save with your preferred output format and metadata option.

`NudeNet` is meant to be simple: it uses its own built-in NSFW/body-region labels and does not rely on free-text prompting.

### Pro text prompt: what it really does

- **Advanced Precision (Pro)** is the SAM3 route.
- The text box is for **text-prompt segmentation on the current image**, not for Wenaka, NudeNet, or the general YOLO models.
- In the current verified setup, SAM3 still needs a **CUDA-capable NVIDIA GPU**.
- If SAM3 is unavailable, you can still type in the box on the current build, but the text prompt path will not become a working segmentation route until the SAM3 runtime is actually ready.

### Artist ID log note on Windows

- `SkaFn failed; falling back to PyTorchSkaFn` is usually a **fallback note**, not a hard failure.
- If the Artist tab still returns predicted artists, then the Kaloscope pipeline is working and the runtime simply fell back to the slower PyTorch path.
- If no artist results appear, then check the Artist banner for missing runtime files, missing `timm`, or missing `triton-windows`.

---

## 📖 Complete Tutorial (Playback Teaching Guide)

This section provides a step-by-step walkthrough of every feature in the SD Image Sorter.

### 🔹 Step 1: Launching the Application

1. **Start the server**:
   - Double-click `run.bat` (Windows) or run `./run.sh` (Linux/Mac)
   - Wait for the message: `Application startup complete`
   
2. **Open the web interface**:
   - Navigate to `http://localhost:8000` in your browser
   - You'll see the main Gallery view with the glassmorphism UI

### 🔹 Step 2: Scanning Your Image Folder

1. Click the **📂 Scan Folder** button in the top navigation bar
2. In the modal that appears:
   - Enter the **absolute path** to your image folder (e.g., `D:\AI_Images`)
   - Supported formats include **PNG / JPG / JPEG / WebP / GIF / BMP**
3. Click **Start Scan**
4. Watch the progress bar as images are indexed
5. Once complete, images appear in the gallery grid

> **💡 Tip**: Images from different generators (ComfyUI, NovelAI, WebUI/Forge) are automatically detected based on their metadata format. Unreadable files are skipped and counted as scan errors instead of polluting the library.

### 🔹 Step 3: AI Tagging with WD14 Tagger

1. Click the **🏷️ Tag Images** button
2. In the tagging modal:
   - **Select a model** (recommended: `wd-swinv2-tagger-v3`)
   - Adjust **General Threshold** (default: 0.35) - higher = fewer tags
   - Adjust **Character Threshold** (default: 0.85) - for character recognition
3. Click **Start Tagging**
4. The progress shows which image is being processed
5. Tags and ratings will be added to each image

> **💡 Tip**: The first run downloads the model (~500MB). Subsequent runs are faster.

### 🔹 Step 4: Understanding the Gallery Interface

#### Generator Tabs
Located below the header, these filter images by their source:
- **All** - Shows all scanned images
- **Forge** - Images from Forge/WebUI
- **WebUI** - Automatic1111 WebUI images  
- **NovelAI** - NovelAI generated images
- **ComfyUI** - ComfyUI workflow images
- **Unknown** - Images without recognizable metadata

#### Image Grid
- **Hover** over an image to see a quick preview tooltip
- **Click** an image to open the detail view
- **Right-click** opens context menu with options

#### Gallery Tools
- **🎲 Random** - Jump to a random image
- **Sort dropdown** - Sort by: Newest, Oldest, Filename, Prompt Length, Tag Count, Rating
- **View toggles** - Switch between Grid and Single image view

### 🔹 Step 5: Using the Filter System

Click the **Filters** section in the left sidebar to expand filter options:

#### 5.1 Rating Filter
Filter by content rating (assigned by AI tagging):
- **General** - Safe for work content
- **Sensitive** - Mildly suggestive
- **Questionable** - More suggestive content
- **Explicit** - Adult content

#### 5.2 Tag Filter
1. Type a tag name in the search box (e.g., "1girl", "blue_hair")
2. Select tags from the autocomplete dropdown
3. Multiple tags can be combined (AND logic)
4. Click the **X** to remove a tag filter

#### 5.3 Checkpoint Filter
1. Expand the **Checkpoints** section
2. Click a checkpoint name to filter images using that model
3. Shows count of images per checkpoint

#### 5.4 LoRA Filter
1. Expand the **LoRAs** section
2. Click a LoRA name to filter images using it
3. Multiple LoRAs can be selected

#### 5.5 Prompt Filter
1. Enter keywords in the **Prompts** search box
2. Filters images containing that text in their prompt
3. Uses substring matching (e.g., "girl" matches "1girl", "girls")

#### 5.6 Dimension & Aspect Ratio Filter
Click the **More Filters** button to access:
- **Min/Max Width**: Filter by pixel width range
- **Min/Max Height**: Filter by pixel height range
- **Aspect Ratio**: Portrait, Landscape, or Square

#### Clearing Filters
- Click **Clear All Filters** to reset all filter selections
- Individual filters can be removed by clicking them again

### 🔹 Step 6: Auto-Separate (Batch Move)

Navigate to the **Auto-Separate** tab:

1. Set your **Source** path (or use currently filtered images)
2. Set your **Destination** folder path
3. Configure filter criteria (same as Gallery filters)
4. Click **Start Separation**
5. Images matching the criteria are moved to the destination

> **⚠️ Warning**: This operation moves files. Use with caution.

### 🔹 Step 7: Manual Sort (WASD Sorting)

Navigate to the **Manual Sort** tab for rapid keyboard-based sorting:

#### Setup
1. Set up to **4 destination folders** for W, A, S, D keys:
   - **W slot**: e.g., `D:\Sorted\Best`
   - **A slot**: e.g., `D:\Sorted\Good`
   - **S slot**: e.g., `D:\Sorted\OK`
   - **D slot**: e.g., `D:\Sorted\Delete`
2. Click **🎮 Start Sorting**

#### Controls
| Key | Action |
|:---:|:-------|
| `W` | Move image to W-slot folder |
| `A` | Move image to A-slot folder |
| `S` | Move image to S-slot folder |
| `D` | Move image to D-slot folder |
| `Space` | Skip current image (keep in place) |
| `Z` | Undo last action |
| `Esc` | Exit sorting mode |

#### Workflow
1. Image displays in full view
2. Press W/A/S/D to move, Space to skip
3. Next image automatically loads
4. Press Z anytime to undo
5. Progress counter shows remaining images

### 🔹 Step 8: Censor Edit (Privacy Masking)

Navigate to the **Censor Edit** tab:

#### Adding Images to Queue
1. In Gallery, select images using checkboxes
2. Click **🔳 Censor Edit** in the floating action bar
3. Images are added to the Censor Edit queue

#### AI Auto-Detection
1. Check the model banner at the top of the tab
2. For most users, keep **Model Type** on `both`
3. Leave the legacy YOLO path empty unless you are testing a custom local model
4. Adjust **Confidence threshold** if needed
5. Click **🎯 Detect Current** for single image
6. Click **🎯 Detect All** to process entire queue

> **💡 Tip**: If the banner says `Legacy default: wenaka_yolov8s-seg.onnx (Privacy-part detector)`, the recommended privacy model is already wired up.

#### Manual Editing Tools
| Tool | Hotkey | Description |
|:-----|:------:|:------------|
| Brush | `B` | Paint censor areas with selected style |
| Pen | `P` | Precise thin line censoring |
| Eraser | `E` | Remove censor marks (restore original) |
| Clone Stamp | `G` | Clone from another area |

#### Brush Settings
- **Size**: Adjust with `[` and `]` keys, or slider
- **Style**: Mosaic, Blur, Black Bar, White Bar

#### Canvas Controls
- **Zoom**: `Ctrl + Scroll` or zoom buttons
- **Pan**: Click and drag when zoomed in
- **Undo**: `Ctrl + Z`

#### Navigation
- `A` / `D` - Previous / Next image in queue
- Queue panel shows all images with processing status

#### Saving
1. Review all censored images
2. Click **💾 Save Current** for single image
3. Click **💾 Save All Processed** for batch save
4. Choose output folder and naming convention

### 🔹 Step 9: Similar Images (NEW)

Navigate to the **Similar** tab to find visually similar images:

#### Generate Embeddings (First Time)
1. Check the Similar tab health banner first
2. Click **Generate Embeddings** to create visual fingerprints for all images
3. Wait for the background process to complete (progress shown in UI)
4. This uses CLIP AI model and prefers the local `models/clip` cache when present

#### Find Similar Images
1. **By Image ID**: Enter an image ID from your gallery
2. **By Upload**: Drag & drop any image to find similar ones
3. Adjust the **Similarity Threshold** (default: 0.5)
4. Results show visually similar images from your library

#### Find Duplicates
1. Click the **Duplicates** sub-tab
2. Set threshold (default: 0.95 for near-duplicates)
3. Click **Find Duplicates** to scan your library
4. Review pairs with similarity scores

### 🔹 Step 10: Prompt Lab (NEW)

Navigate to the **Prompt Lab** tab to generate random prompts:

#### Browse Your Tags
1. The **Category Browser** shows tags from your library
2. Categories: quality, meta, character, body, outfit, pose, expression, etc.
3. Use the search box to filter tags

#### Generate Random Prompts
1. Click **🎲 Randomize** to generate a new random prompt
2. The system intelligently picks tags respecting exclusion rules
3. View generated positive and negative prompts

#### Use Tag Sets
1. Select a **Tag Set** from the dropdown (e.g., "School Uniform", "Swimsuit")
2. Click **Apply** to add the outfit tags
3. Tag sets ensure coherent outfit combinations

#### Slot Builder
- Each category has a **slot** showing the selected tag
- **Lock** 🔒 a slot to keep it during randomization
- **Weight** adjusts selection probability
- **Clear** removes the selection

### 🔹 Step 11: Artist Identification (NEW)

Navigate to the **Artist ID** tab to identify artists/styles in your images:

#### Configure Settings
1. Read the runtime banner first
2. Leave **Model Source** on HuggingFace unless you intentionally use a custom mirror or local model
3. Set **Confidence Threshold**: Images below this will be labeled "undefined"

#### Identify Artists
1. If the banner says Kaloscope is ready, click **Identify All Images** to analyze your library
2. Or select images in Gallery, then click **Identify Selected**
3. Watch the progress bar during batch processing
4. If the banner reports missing runtime pieces, follow [models/artist/README.md](models/artist/README.md) first

#### Explore Results
1. Browse identified artists in the results grid
2. Click an artist card to see their image count
3. Use **View in Gallery** to filter by that artist

---

## ⌨️ Complete Keyboard Shortcuts

### Gallery View
| Keys | Action |
|:-----|:-------|
| `Arrow Keys` | Navigate between images |
| `Enter` | Open selected image details |
| `Escape` | Close modals/detail view |

### Manual Sort Mode
| Keys | Action |
|:-----|:-------|
| `W / A / S / D` | Move to assigned folder |
| `Space` | Skip current image |
| `Z` | Undo last action |
| `Escape` | Exit sorting mode |

### Censor Edit Mode
| Keys | Action |
|:-----|:-------|
| `A / D` | Previous / Next image |
| `B` | Brush tool |
| `P` | Pen tool |
| `E` | Eraser tool |
| `G` | Clone stamp tool |
| `[ / ]` | Decrease / Increase brush size |
| `Ctrl + Z` | Undo last stroke |
| `Ctrl + Scroll` | Zoom canvas |

---

## 🔧 Advanced Configuration

### Environment Variables
Create a `.env` file in the `backend` folder:

```env
# Server settings
HOST=0.0.0.0
PORT=8000

# Database path (default: ./database.db)
DATABASE_PATH=./database.db

# Models cache directory
MODELS_CACHE=./models
```

### API Endpoints

The backend provides a REST API for programmatic access:

| Endpoint | Method | Description |
|:---------|:------:|:------------|
| `/api/images` | GET | List images with filters |
| `/api/images/{id}` | GET | Get single image details |
| `/api/analytics` | GET | Get statistics and tag counts |
| `/api/tags` | GET | List all available tags |
| `/api/scan` | POST | Scan a folder for images |
| `/api/tag` | POST | Run AI tagging on images |
| `/api/move` | POST | Move images to folder |
| `/api/similarity/stats` | GET | Get embedding statistics |
| `/api/similarity/model-status` | GET | Get local CLIP runtime readiness details |
| `/api/similarity/embed` | POST | Generate embeddings for all images |
| `/api/similarity/search/{id}` | GET | Find similar images by ID |
| `/api/similarity/duplicates` | GET | Find near-duplicate image pairs |
| `/api/prompts/generate` | POST | Generate a random prompt |
| `/api/prompts/rules` | GET | List tag exclusion rules |
| `/api/prompts/tag-sets` | GET | List available tag sets |
| `/api/censor/detect` | POST | Run AI detection on an image |
| `/api/censor/models` | GET | List available detection models |
| `/api/artists/identify` | POST | Identify artist for single image |
| `/api/artists/identify-batch` | POST | Batch identify artists |
| `/api/artists/diagnostics` | GET | Get Kaloscope / LSNet runtime diagnostics |
| `/api/artists/stats` | GET | Get identification statistics |
| `/api/artists/list` | GET | List known artists |

### Filter Parameters
When querying `/api/images`:
- `generators` - Comma-separated generator names
- `rating` - general, sensitive, questionable, explicit
- `tags` - Comma-separated tag names
- `checkpoint` - Checkpoint name
- `loras` - Comma-separated LoRA names
- `prompt` - Text search in prompts
- `min_width`, `max_width` - Width range
- `min_height`, `max_height` - Height range
- `aspect_ratio` - portrait, landscape, square

---

## 🛠️ Troubleshooting

### Common Issues

**Q: Images don't show after scanning**
- Ensure the path is absolute (e.g., `D:\Images` not `Images`)
- Supported image formats are PNG / JPG / JPEG / WebP / GIF / BMP
- Unreadable files are skipped during scan and reported as scan errors
- Look for errors in the terminal console

**Q: Tagging is slow**
- First run downloads the model (~500MB)
- GPU acceleration requires CUDA-compatible GPU
- Reduce batch size in settings for less memory usage

**Q: Similar search returns empty or says the image has no embedding**
- Run **Generate Embeddings** in the Similar tab first
- Check the Similar tab model banner first
- The first embedding run may need to download model assets
- Missing dependency/model issues are now reported directly in the progress/error message

**Q: Censor Edit detects the wrong things or finds nothing**
- First check the Censor tab banner
- If the installed legacy model says `General object segmentation`, it is only a compatibility model
- For privacy workflows, use the Wenaka privacy model or keep `Model Type` on `both`
- Leave the legacy model path blank unless you are intentionally testing a custom file

**Q: Why is the normal `yolov8s` still there if Wenaka exists?**
- Because it is kept for advanced compatibility and segmentation testing
- In the current verified local setup, `yolov8s-seg` and `yolo26s-seg` are general fixed-class models
- They are not the normal privacy workflow and not open-text prompt detectors
- Ordinary users should leave **Show advanced legacy models** turned off

**Q: How should I use NudeNet?**
- Switch `Model Type` to `nudenet`
- Ignore the text prompt box and privacy quick-checkboxes for this route
- Click `Detect Current` or `Detect All`
- Review the returned boxes and then save or manually clean up the result

**Q: The Advanced Precision text box is visible. What is it for?**
- It is for the SAM3 text-prompt path, not for Wenaka, NudeNet, or general YOLO models
- The current build keeps the input editable, but the actual segmentation route still depends on SAM3 being ready
- If SAM3 is unavailable on your machine, the text prompt will not become a working segmentation feature yet

**Q: Artist Identification keeps returning `undefined`**
- This feature is still experimental and respects a confidence threshold
- Check the Artist tab runtime banner before changing anything else
- First use may need to download the Kaloscope checkpoint
- Kaloscope also requires an external LSNet runtime checkout (`comfyui-lsnet` or `lsnet-test`)
- On Windows, install `triton-windows`
- If the model cannot load, the app now reports the error explicitly instead of pretending the run succeeded

**Q: The log says `SkaFn failed; falling back to PyTorchSkaFn`. Is Artist ID broken?**
- Usually no
- On Windows, that message normally means the runtime fell back away from Triton
- If artist predictions still show up in the UI, the feature is working, just on the fallback path
- If predictions do not show up, then treat it as a setup problem and check the Artist diagnostics banner

**Q: SAM3 is installed but still says unavailable**
- In the current verified setup, SAM3 is treated as GPU-only
- The checkpoint can be present locally while the feature still reports unavailable on a CPU-only machine
- This is expected right now, not a silent failure

**Q: Filters show wrong counts**
- Click "Clear All Filters" and re-apply
- Run "Fix Rating Tags" in settings if rating counts seem off
- Refresh the page after major database operations

**Q: Manual Sort undo doesn't work**
- Undo only works within the current sorting session
- Files that were already moved manually cannot be undone

---

## 📁 Project Structure

```
sd-image-sorter/
├── backend/
│   ├── main.py               # FastAPI application entry
│   ├── database.py           # SQLite database operations
│   ├── image_manager.py      # Image metadata handling
│   ├── metadata_parser.py    # SD metadata extraction
│   ├── tagger.py             # WD14 AI tagging
│   ├── censor.py             # Censor detection (ONNX)
│   ├── model_health.py       # Local model discovery and readiness reporting
│   ├── nudenet_detector.py   # NudeNet v3 detector
│   ├── sam3_refiner.py       # SAM3 mask refinement
│   ├── similarity.py         # CLIP embedding search
│   ├── prompt_generator.py   # Random prompt generator
│   ├── artist_identifier.py  # LSNet artist identification
│   ├── tag_rules.py          # Tag categorization rules
│   ├── routers/              # API route modules
│   │   ├── images.py         # Image CRUD endpoints
│   │   ├── tags.py           # Tag management
│   │   ├── sorting.py        # Sorting operations
│   │   ├── censor.py         # Censor edit endpoints
│   │   ├── similarity.py     # Similarity search endpoints
│   │   ├── prompts.py        # Prompt generation endpoints
│   │   └── artists.py        # Artist identification endpoints
│   └── utils/
│       └── path_validation.py  # Security utilities
├── frontend/
│   ├── index.html            # Main HTML template
│   ├── css/
│   │   ├── styles.css        # Glassmorphism styling
│   │   ├── censor-v2.css     # Censor editor styles
│   │   ├── new-views.css     # Similar/Prompt Lab styles
│   │   └── ui-refresh.css    # UI refresh and polish
│   └── js/
│       ├── app.js            # Main application logic
│       ├── gallery.js        # Gallery interactions
│       ├── virtual-gallery.js # Virtual scrolling
│       ├── autosep.js        # Auto-separate tab
│       ├── manual-sort.js    # WASD manual sorting
│       ├── censor-edit.js    # Censor editor
│       ├── similar.js        # Similar images tab
│       ├── prompt-lab.js     # Prompt lab tab
│       ├── artist-ident.js   # Artist identification tab
│       ├── i18n.js           # Language bootstrap
│       ├── guide.js          # In-app guide overlays
│       ├── guide-translations.js # Guide localization
│       ├── lang/             # English / Chinese UI strings
│       └── audio.js          # Sound effects
├── models/                   # Downloaded AI models + local model guides
├── run.bat                   # Windows launcher
├── run.sh                    # Linux/Mac launcher
└── README.md                 # This file
```

---

## 🤝 Contributing

Contributions are welcome! Please:
1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Submit a pull request

---

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

---

<br>

<a name="简体中文"></a>

# 🎨 SD Image Sorter (AI 图像筛选管理器)

专为 Stable Diffusion 用户设计的图像管理工具，具备极简玻璃拟态 UI。支持自动元数据提取、AI 打标、智能过滤和极速排序。

---

### 🤔 如果你正在烦恼...

> - 😵 一大堆图片有些有元数据、有些没有，完全分不清楚
> - 🔍 想快速过滤特定的 tags / prompts / models，却发现现有工具做不到  
> - 📚 想基于自己的图库建立本地 tags/prompts 资料库
> - 🔳 想自动打码却发现 YOLO 总是误判 / 自动打出来的码只有死板的长方形，又不能手动细修
> - 🧹 想批量清除图片的元数据 / 或者打完码后想选择性保留原始元数据
>
> **那就来试试这个顶级美味吧！🍜**

---

## 📸 软件截图

| 画廊视图 | 手动排序 | 打码编辑 |
|:--------:|:--------:|:--------:|
| ![Gallery](docs/screenshots/gallery_view.png) | ![Manual Sort](docs/screenshots/manual_sort.png) | ![Censor Edit](docs/screenshots/censor_edit.png) |

## 🎬 演示动画

| 画廊导航 | 手动排序流程 |
|:--------:|:------------:|
| ![Gallery Demo](docs/screenshots/gallery_demo.gif) | ![Manual Sort Demo](docs/screenshots/manual_sort_demo.gif) |

---

## ✨ 功能特性

### 🖼️ 画廊管理
- **全面兼容**: 支持 ComfyUI, NovelAI, WebUI/Forge 等多种生成工具
- **深度解析**: 自动读取正反向提示词、采样参数、模型信息及 LoRA
- **精准过滤**: 支持按生成器、标签、内容分级、模型、LoRA、尺寸组合筛选
- **智能排序**: 支持按时间、提示词长度、标签密度或分级排序

### 🏷️ AI 自动打标 (WD14 Tagger)
- **多模型矩阵**: 集成 EVA02-Large, SwinV2 等高精度打标模型
- **双重阈值**: 针对通用内容与角色特征分别定义识别灵敏度
- **安全评级**: 自动识别并标注内容分级（General 到 Explicit）

### 📁 自动化整理与排序
- **自动分类 (Auto-Separate)**: 将符合过滤条件的图片一键归集到指定文件夹
- **快捷手动排序**: 独创"WASD"键位操作，像玩游戏一样快速分类图片
- **撤销机制**: 实时撤销误操作，排序流程更安全

### 🔳 隐私打码 (Censor Edit V2)
- **多模型支持**: 可选 Legacy YOLO、NudeNet v3 或两者并用
- **默认更省心**: 如果本地有 Wenaka 隐私模型，程序会自动选它，普通用户不需要手填 Legacy 模型路径
- **智能识别**: 可直接在前端切换 Wenaka 隐私 YOLO、NudeNet v3，或两者并用
- **能力拆分更清楚**: Wenaka 走固定隐私类的快速检测，本地 YOLO26/YOLOv8 文件会明确标成固定类通用分割测试模型，SAM3 则是文本提示精细分割工具
- **多样化处理**: 提供马赛克、模糊、纯色遮盖等多种打码方式
- **精细修补**: 内置画笔、橡皮擦、仿制图章，并为专业用户补上 SAM3 文本提示分割入口
- **批量导出**: 队列化工作流，支持批量重命名与保存
- **更稳健**: 坏图不会再污染图库或把打码队列直接拖崩
- **状态提示更诚实**: 页面会直接告诉你本地实际可用的模型、推荐模式、当前默认隐私模型，以及各模型的真实输入/输出能力

### 🔍 相似图片 (NEW)
- **视觉搜索**: 使用 CLIP 嵌入向量查找视觉相似的图片
- **重复检测**: 识别图库中的近似重复图片
- **上传搜索**: 上传任意图片查找相似图片
- **可调阈值**: 微调相似度敏感度
- **错误提示更明确**: 缺模型或缺依赖时会直接给出可操作提示，不再默默返回空结果

### 🧪 提示词工坊 (NEW)
- **智能生成**: 生成随机提示词，自动遵守排除规则
- **排除规则**: 自动防止冲突标签（如 "from_behind" 排除 "looking_at_viewer"）
- **标签套装**: 预设服装组合（校服、泳装等）
- **分类浏览**: 按类别浏览图库标签
- **内置兜底分类池**: 即使自己的标签库很少，也能直接开始生成
- **负向提示词**: 自动生成质量优化的负向提示词

### 🎨 画师识别 (NEW)
- **LSNet 风格分类**: 识别图片的画师/风格
- **置信度阈值**: 低于阈值的图片标记为 "undefined"
- **批量处理**: 带进度追踪的批量识别
- **画师过滤**: 按识别出的画师过滤图库
- **统计数据**: 查看热门画师及其图片数量
- **默认后端**: 现已指向 `Kaloscope2.0`
- **运行时诊断**: Artist 页面会直接告诉你 Kaloscope、LSNet runtime、Windows `triton` 支持是否真的就绪

---

## 🚀 快速开始

### 环境要求
- **Python 3.9+**
- **内存**: 基础功能最低 4GB，多数 AI 功能建议 8GB+，画师识别建议 16GB+
- **磁盘空间**: 程序与运行环境约 2GB，外加可选模型下载空间
- **Windows** (推荐) 或 Linux/Mac

### 安装与运行

1. **获取代码**:
   ```bash
   git clone https://github.com/peter119lee/sd-image-sorter.git
   cd sd-image-sorter
   ```

2. **启动程序**:
   - **Windows**: 双击 `run.bat`
   - **Linux/Mac**: 运行 `chmod +x run.sh && ./run.sh`

3. **访问界面**: 使用浏览器打开 `http://localhost:8000`

*首次启动会自动创建虚拟环境并安装依赖；之后启动时也会自动检查 `backend/requirements.txt`，如果依赖有变化会自动补装。*

启动器现在还会打印本地模型就绪摘要，浏览器里的 `Censor`、`Similar`、`Artist ID` 页面也会显示用户看得懂的状态条。

> [!TIP]
> **没有安装 Python?** 使用 [`bundled-python`](https://github.com/peter119lee/sd-image-sorter/tree/bundled-python) 分支 — 自动下载 Python!

> [!NOTE]
> 模型“可以自动下载”不等于“可以放心打包进 GitHub Releases 再分发”。如果你准备发布整包，请先阅读 [THIRD_PARTY_MODELS.md](THIRD_PARTY_MODELS.md)。

> [!TIP]
> **想最省事开用？** 直接从 release 下载 `sd-image-sorter-v2.1.0-portable-core-models.zip`，需要时再看 [docs/RELEASE_PACKS.md](docs/RELEASE_PACKS.md) 和 [models/README.md](models/README.md) 补大模型。

---

## 🧰 硬件指南

### 弱硬件能不能用？

**能用，但不是所有功能都适合。**

- **很适合弱硬件**：图库、元数据解析、筛选、自动分类、手动排序、提示词工坊
- **弱硬件能跑但会比较慢**：WD14 打标、基础打码检测、Similar / CLIP 向量生成
- **不建议弱硬件主打使用**：`Kaloscope2.0` 画师识别
- **当前不适合弱硬件 / 纯 CPU 机器**：`SAM3`

这里说的**弱硬件**，大致可以理解为：

- 4 核 CPU
- 8GB 内存
- 核显或比较老的独显
- SATA SSD，甚至机械硬盘

这类机器依然能把软件用起来，但应该优先走轻量路线，不要默认把所有大模型功能都开满。

### 按功能看的推荐硬件

| 功能 | 弱硬件支持情况 | 最低可用配置 | 推荐配置 | 说明 |
|:-----|:---------------|:-------------|:---------|:-----|
| 图库 / 元数据 / 筛选 | 支持 | 2-4 核 CPU，4GB 内存 | 4 核以上 CPU，8GB 内存，SSD | 这部分主要吃文件读写和 SQLite，SSD 提升很明显。 |
| 扫描文件夹 / 大图库建索引 | 支持，但会慢 | 4 核 CPU，4GB 内存，最好有 SSD | 6 核以上 CPU，8-16GB 内存，SSD | 大图库更吃 CPU 和磁盘，不太吃 GPU。 |
| 自动分类 / 手动排序 | 支持 | 4GB 内存 | 8GB 内存，SSD | 本身很轻，除非你同时叠加 AI 打标或打码。 |
| 提示词工坊 | 支持 | 4GB 内存 | 8GB 内存 | 主要是数据库和前端逻辑。 |
| WD14 打标（`wd-swinv2-tagger-v3`） | 支持，但会慢 | 4 核 CPU，8GB 内存 | 6 核以上 CPU，16GB 内存，可选 NVIDIA 6GB+ 显存 | 这是更适合普通用户和弱硬件的默认打标模型，CPU 模式可用。 |
| WD14 打标（`wd-eva02-large-tagger-v3`） | 不适合弱硬件 | 16GB 内存 | 16-32GB 内存，可选 NVIDIA 8GB+ 显存 | 精度更高，但比 `wd-swinv2-tagger-v3` 重很多。 |
| 打码检测：Wenaka / NudeNet | 支持 | 4 核 CPU，8GB 内存 | 6 核以上 CPU，8-16GB 内存，可选 4GB+ 显存 | 这是低配机器也比较适合的路线。觉得 `both` 太慢时，可以一次只开一个检测器。 |
| 打码检测：YOLO26 / YOLOv8 通用兼容模型 | 支持，但更偏高级测试 | 4 核 CPU，8GB 内存 | 6 核以上 CPU，8-16GB 内存 | 当前本地这两份是固定类通用模型，不是开放文本隐私检测器。 |
| 相似图片 / CLIP 向量 | 支持，但首次建库会慢 | 4 核 CPU，8GB 内存，强烈建议 SSD | 6 核以上 CPU，16GB 内存，SSD | 当前 CLIP 路线偏本地优先、CPU 友好，但大图库第一次建向量仍然会花时间。 |
| 画师识别（`Kaloscope2.0`） | 某些 CPU 机器理论上能跑，但完全不算弱硬件友好 | 16GB 内存，快速 SSD，Windows 还要 `triton-windows` | 8 核以上 CPU，32GB 内存，快速 SSD，建议 NVIDIA 8GB+ 显存 | 这个应当视为高级可选功能，不应该当成基础默认功能。 |
| SAM3 文本 / 框精修 | 不支持纯 CPU 弱硬件路线 | 必须有支持 CUDA 的 NVIDIA 显卡 | 建议 NVIDIA 10GB+ 显存，16GB+ 系统内存 | 以当前实测接法，SAM3 仍按 GPU-only 对待。 |

### 当前实测本地模型体积

下面这些是我按当前 `models/` 目录实际文件大小整理出来的，方便用户估算磁盘空间：

| 模型 | 当前实测大小 |
|:-----|:-------------|
| `wd-swinv2-tagger-v3` | 约 445.8 MB |
| `wd-eva02-large-tagger-v3` | 约 1202.0 MB |
| `Qdrant-clip-ViT-B-32-vision` | 约 335.4 MB |
| `wenaka_yolov8s-seg.onnx` | 约 45.7 MB |
| `yolo26s-seg.onnx` | 约 40.0 MB |
| `yolov8s-seg.onnx` | 约 45.3 MB |
| `NudeNet 320n.onnx` | 约 11.6 MB |
| `Kaloscope2.0 best_checkpoint.pth` | 约 2801.8 MB |
| `SAM3 sam3.pt` | 约 3290.2 MB |

### 给弱硬件用户的实际建议

如果你是给普通人装，或者机器配置不强，建议直接照这个思路用：

- 先用 **图库**、**手动排序**、**提示词工坊**
- WD14 优先选 **`wd-swinv2-tagger-v3`**，不要先上 EVA02-Large
- 打码优先走默认 Wenaka 路线，或者单独用 `NudeNet v3`
- **CLIP** 首次建向量要有心理准备，大图库会比较慢
- **Artist ID** 和 **SAM3** 视为可选增强功能，不要当必备默认项
- 能放到 **SSD** 就尽量放 SSD

## 🧭 打码模型怎么选

### 普通用户该选哪条路线？

| 选项 | 输入 | 输出 | 最适合做什么 | 适合谁 |
|:-----|:-----|:-----|:-------------|:-------|
| `both` | 不用填提示词 | Wenaka + NudeNet 的检测框 | 方便、稳、召回更高 | 大多数用户 |
| `legacy` + 自动选中的 Wenaka | 固定隐私部位标签 | 快速隐私部位框 | 快速隐私打码 | 想走最简单隐私主流程的人 |
| `nudenet` | 不用填提示词 | 内置 NSFW / 身体部位框 | 不想额外设置的身体区域检测 | 想单独用一个简单检测器的人 |
| `legacy` + `yolo26s` / `yolov8s` | 固定内置类别 | 通用分割结果 | 兼容性测试和高级实验 | 只建议专业用户 |
| `SAM3` 文本 / 框精修 | 文本提示或框提示 | 像素级 mask | 粗检测之后做精修 | 有 CUDA 显卡的专业用户 |

### 明明有 Wenaka，为什么还保留普通 `yolov8s` / `yolo26s`？

- `wenaka_yolov8s-seg` 才是真正的隐私部位主路线，普通打码应该优先走它。
- 本地 `yolov8s-seg` 和 `yolo26s-seg` 保留下来，是给**高级兼容性 / 分割测试**用的。
- 按当前这份已经实测过的本地接法，它们是**固定类模型**，不是开放文本检测器，也不是隐私专用模型。
- 它们的价值主要在于：专业用户可以比较输出、验证 ONNX/PT 加载、测试非隐私类分割行为。
- 所以界面默认把它们藏在 **Show advanced legacy models** 后面，不让普通用户误选。

### `NudeNet` 怎么用？

1. 打开 **Censor Edit**，先把图片加进队列。
2. 在检测面板把 **Model Type** 切到 `nudenet`。
3. 这条路线不用看隐私快捷复选框，也不用看文本提示框。
4. 直接点 **Detect Current** 或 **Detect All**。
5. 看返回的框够不够，用画笔 / 橡皮 / 仿制图章手修也可以。
6. 最后按你要的输出格式和元数据策略保存。

`NudeNet` 的定位就是省事：它走自己内置的 NSFW / 身体区域标签，不靠自由文本提示。

### Pro 文本框到底是干嘛的？

- **Advanced Precision (Pro)** 这块是给 SAM3 用的。
- 这个文本框对应的是**当前图片的文本提示分割**，不是给 Wenaka、NudeNet、通用 YOLO 用的。
- 以当前这套已经实测过的接法，SAM3 仍然需要 **支持 CUDA 的 NVIDIA 显卡**。
- 如果 SAM3 还没 ready，你现在这版依然可以在输入框里打字，但文本提示这条分割能力本身还不会真正变成可用路线。

### Windows 下 Artist ID 那条日志是什么意思？

- `SkaFn failed; falling back to PyTorchSkaFn` 通常只是 **fallback 提示**，不等于功能直接坏掉。
- 如果 Artist 页面还能正常给出画师结果，说明 Kaloscope 这条链路是通的，只是退回了较慢的 PyTorch 路径。
- 如果结果根本不出来，再去看 Artist 页面状态条，检查 runtime、`timm`、`triton-windows` 有没有缺。

---

## 📖 完整使用教程

### 🔹 第1步：扫描图片入库
1. 点击顶部导航栏的 **📂 Scan Folder**
2. 输入图片所在文件夹的绝对路径（例如 `D:\AI_Images`）
3. 支持格式：**PNG / JPG / JPEG / WebP / GIF / BMP**
4. 点击 **Start Scan**，程序将扫描并建立本地索引数据库

> **提示**：无法读取的坏图会被跳过，并计入扫描错误数，不会再把后续图库、相似图或打码流程拖坏。

### 🔹 第2步：AI 自动打标
1. 点击 **🏷️ Tag Images**
2. 选择推荐模型 `wd-swinv2-tagger-v3`
3. 调整识别阈值（通用标签：0.35，角色标签：0.85）
4. 点击 **Start Tagging**

### 🔹 第3步：使用筛选器
展开左侧 **Filters** 面板：
- **评级过滤**: General / Sensitive / Questionable / Explicit
- **标签过滤**: 输入标签名称搜索
- **模型过滤**: 点击 Checkpoint 名称筛选
- **LoRA过滤**: 点击 LoRA 名称筛选
- **提示词过滤**: 输入关键词搜索提示词
- **尺寸过滤**: 设置宽度/高度范围，或选择横竖比

### 🔹 第4步：极速手动分类
1. 切换至 **Manual Sort** 标签页
2. 为 **W/A/S/D** 四个槽位选择目标路径
3. 点击 **🎮 Start Sorting** 开启排序
4. 敲击 **W/A/S/D** 移动图片，**空格** 跳过，**Z** 撤销

### 🔹 第5步：隐私打码编辑
1. 在画廊中选中图片，点击浮动栏的 **🔳 Censor Edit**
2. 先看页面顶部模型状态条
3. 普通用户直接把 **Model Type** 留在 `both`
4. Legacy 模型路径留空即可，让程序自动选择本地推荐隐私模型
5. 点击 **🎯 Detect Current** 自动识别敏感点
6. 使用工具栏进行精修后，点击 **💾 Save All Processed** 批量保存

### 🔹 第6步：相似图片搜索 (NEW)
1. 切换至 **Similar** 标签页
2. 先看顶部 CLIP 状态条，确认本地模型是否就绪
3. 首次使用需点击 **Generate Embeddings** 生成视觉特征
4. 输入图片 ID 或上传图片搜索相似内容
5. 切换至 **Duplicates** 子标签可查找重复图片

### 🔹 第7步：提示词工坊 (NEW)
1. 切换至 **Prompt Lab** 标签页
2. 左侧浏览分类标签库；如果你自己的标签库还不多，也会自动显示内置基础分类
3. 点击 **🎲 Randomize** 生成随机提示词
4. 选择 **Tag Set** 套用预设服装组合
5. 生成的提示词可直接复制使用

### 🔹 第8步：画师识别 (NEW)
1. 切换至 **Artist ID** 标签页
2. 先看顶部 Kaloscope 状态条
3. 设置置信度阈值（默认 0.35，低于此值标记为 "undefined"）
4. 如果状态条显示 ready，再点击 **Identify All Images** 批量识别
5. 浏览识别出的画师列表
6. 点击画师卡片查看详情

---

## 🛠️ 故障排查

### 常见问题

**Q: 扫描后图片没有显示**
- 确认填写的是绝对路径，例如 `D:\Images`
- 支持格式为 PNG / JPG / JPEG / WebP / GIF / BMP
- 坏图会被跳过，并在扫描结果里计入错误数
- 查看启动终端里的错误信息

**Q: 打标很慢**
- 首次运行需要下载模型（约 500MB）
- GPU 加速需要可用的 CUDA 环境
- 如果机器内存偏紧，优先使用默认推荐模型

**Q: 相似图片为空，或者提示没有 embedding**
- 先到 Similar 标签页点击 **Generate Embeddings**
- 先确认 Similar 页面顶部状态条显示本地 CLIP 已就绪
- 首次 embedding 可能需要下载模型资源
- 如果缺依赖或模型加载失败，界面现在会直接给出错误提示

**Q: 打码识别不准，或者完全没识别到**
- 先看 Censor 页顶部状态条
- 如果当前 Legacy 模型被标成 `General object segmentation`，那只是通用兼容模型，不是推荐隐私模型
- 隐私打码优先使用 Wenaka 那个 `Privacy-part detector`
- 不确定时把 `Model Type` 留在 `both`，并把 Legacy 自定义路径留空

**Q: 明明有 Wenaka，为什么还看得到普通 `yolov8s`？**
- 因为它是保留给高级兼容性 / 分割测试用的
- 按当前实测接法，`yolov8s-seg` 和 `yolo26s-seg` 都是通用固定类模型
- 它们不是普通隐私打码主流程，也不是开放文本检测器
- 普通用户保持 **Show advanced legacy models** 关闭就好

**Q: `NudeNet` 应该怎么用？**
- 把 `Model Type` 切到 `nudenet`
- 不用管文本提示框，也不用管隐私快捷复选框
- 直接点 `Detect Current` 或 `Detect All`
- 看框够不够，再决定要不要手修和保存

**Q: `Advanced Precision` 那个输入框是干嘛的？**
- 它是给 SAM3 文本提示路线用的，不是给 Wenaka、NudeNet、通用 YOLO 用的
- 当前版本已经修掉了输入焦点被全局快捷键抢走的问题
- 但真正能不能拿它做文本分割，仍然取决于 SAM3 runtime 有没有 ready

**Q: 画师识别一直是 `undefined`**
- 这是实验性功能，本身受置信度阈值影响
- 先确认 Artist 页顶部状态条是否 ready
- 首次使用可能需要下载 Kaloscope 检查点
- Kaloscope 还需要额外的 LSNet runtime 仓库（`comfyui-lsnet` 或 `lsnet-test`）
- Windows 环境建议安装 `triton-windows`
- 如果模型无法加载，程序现在会明确提示错误，而不是假装成功

**Q: 日志里写 `SkaFn failed; falling back to PyTorchSkaFn`，是不是 Artist 坏了？**
- 通常不是
- 这在 Windows 上一般表示 runtime 没走 Triton，而是退回到 PyTorch fallback
- 只要 UI 里还能正常出现画师预测结果，这条链路就是通的，只是跑在 fallback 路径
- 如果 UI 里根本没有结果，那才把它当成环境问题，去看 Artist 诊断条

**Q: SAM3 明明下载了，但界面还是说不可用**
- 当前这套经过实测的接法里，SAM3 仍然按 GPU-only 对待
- 也就是说：模型文件在本地，不代表 CPU 机器就能直接 refine
- 这是当前已知限制，不是静默失败

---

## 📁 项目结构

```
sd-image-sorter/
├── backend/
│   ├── main.py               # FastAPI 应用入口
│   ├── database.py           # SQLite 数据库操作
│   ├── image_manager.py      # 图片扫描与元数据处理
│   ├── metadata_parser.py    # SD 元数据解析
│   ├── tagger.py             # WD14 AI 打标
│   ├── censor.py             # 打码检测（ONNX）
│   ├── model_health.py       # 本地模型发现与就绪状态报告
│   ├── nudenet_detector.py   # NudeNet v3 检测器
│   ├── sam3_refiner.py       # SAM3 掩码细化
│   ├── similarity.py         # CLIP 相似图搜索
│   ├── prompt_generator.py   # 随机提示词生成
│   ├── artist_identifier.py  # 画师识别
│   ├── tag_rules.py          # 标签分类规则
│   ├── routers/              # API 路由模块
│   │   ├── images.py         # 图片相关接口
│   │   ├── tags.py           # 标签管理
│   │   ├── sorting.py        # 分类与排序
│   │   ├── censor.py         # 打码编辑接口
│   │   ├── similarity.py     # 相似图接口
│   │   ├── prompts.py        # 提示词接口
│   │   └── artists.py        # 画师识别接口
│   └── utils/
│       └── path_validation.py # 路径安全工具
├── frontend/
│   ├── index.html            # 主页面模板
│   ├── css/
│   │   ├── styles.css        # 主玻璃拟态样式
│   │   ├── censor-v2.css     # 打码编辑器样式
│   │   ├── new-views.css     # Similar / Prompt Lab 等新视图样式
│   │   └── ui-refresh.css    # UI 细节刷新
│   └── js/
│       ├── app.js            # 主应用逻辑
│       ├── gallery.js        # 画廊交互
│       ├── virtual-gallery.js # 虚拟滚动
│       ├── autosep.js        # 自动分类页
│       ├── manual-sort.js    # WASD 手动排序
│       ├── censor-edit.js    # 打码编辑器
│       ├── similar.js        # 相似图片页
│       ├── prompt-lab.js     # 提示词工坊
│       ├── artist-ident.js   # 画师识别页
│       ├── i18n.js           # 多语言入口
│       ├── guide.js          # 页面引导层
│       ├── guide-translations.js # 引导翻译
│       ├── lang/             # 中英文界面文案
│       └── audio.js          # 音效
├── models/                   # 下载后的 AI 模型与本地模型说明
├── run.bat                   # Windows 启动脚本
├── run.sh                    # Linux / Mac 启动脚本
└── README.md                 # 本说明文件
```

---

## ⌨️ 快捷键指南

| 场景 | 按键 | 动作 |
|:-----|:-----|:-----|
| **手动排序** | `W / A / S / D` | 移动到指定槽位 |
| | `空格` | 跳过当前图片 |
| | `Z` | 撤销上一步操作 |
| **打码编辑** | `A / D` | 切换上/下一张 |
| | `B / P` | 画笔 / 铅笔工具 |
| | `E` | 橡皮擦 (恢复原图) |
| | `G` | 仿制图章 |
| | `[ / ]` | 调整笔触大小 |
| | `Ctrl+Z` | 撤销编辑 |
| | `Ctrl+滚轮` | 画布缩放 |

---

## 📄 开源协议

本项目基于 MIT 协议开源 - 详见 [LICENSE](LICENSE) 文件。

---

## 💡 小贴士 (Tips & Hints)

> [!TIP]
> **拖拽读图**: 看到喜欢的图片？直接从 Gallery 拖拽到 ComfyUI 就能读取工作流啦！

> [!TIP]  
> **精细修正**: 在 Censor Edit 打码后，如果自动检测多画了一些区域，用 Eraser 工具 (`E` 键) 擦掉即可恢复原图。

> [!TIP]
> **批量工作流**: 在 Censor Edit 中可以拖动重新排列图片顺序 → 批量重命名 → 决定要不要保留元数据 → 最后一键导出，超级方便！

> [!TIP]
> **快捷键加速**: 熟练使用 `WASD` + `Space` + `Z` 组合，手动排序的速度堪比打游戏！

---

## 🙏 Special Thanks

This project wouldn't be possible without these amazing contributors and their inspiring work:

| Contributor | Contribution |
|:------------|:-------------|
| **[Antigravity](https://github.com/peter119lee)** & **Claude Opus 4.5 (Thinking)** | 💻 Core development & AI-assisted coding |
| **[Wenaka2004](https://github.com/Wenaka2004/auto-censor)** | 💡 Auto-censor concept inspiration |
| **Wenaka2004** | 🎯 [YOLO detection model](https://civitai.com/models/1736285?modelVersionId=1965032) |
| **[Spawner1145](https://github.com/spawner1145/comfyui-lsnet)**, **DraconicDragon**, **heathcliff01** | 🎨 LSNet artist identification inspiration |
| **[SmilingWolf](https://huggingface.co/SmilingWolf/wd-eva02-large-tagger-v3)** | 🏷️ WD14 Tagger models |
| **[Receyuki](https://github.com/receyuki/stable-diffusion-prompt-reader)** | 📖 Prompt reader concept inspiration |

---

## 🐛 Feedback & Contributions

Got ideas? Found a bug? We'd love to hear from you!

- 📝 **Issues**: [Report bugs or request features](../../issues)
- 🔧 **Pull Requests**: Contributions are always welcome!
- 💬 **Discussion**: Feel free to start a conversation in Issues

---

*Made with ❤️ for the Stable Diffusion community*
