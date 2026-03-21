# SD Image Sorter — Major Feature & UI Overhaul Plan

## Research Findings Summary

| Original Request | Reality | Action |
|---|---|---|
| SAM3 | **Confirmed**: Meta's SAM 3 (Segment Anything with Concepts), 848M params, DETR+SAM2 tracker | Use SAM3 for pixel-precise mask refinement |
| YOLO26 | **Confirmed**: Ultralytics YOLO26 (v8.4.0+), dual-head NMS-free architecture | Use YOLO26-seg for detection + segmentation |
| LSNet | Two variants exist, neither suitable for this use case | **Skip** — SAM3 + NudeNet covers it |
| FastEmbed | Confirmed viable. ONNX-based CLIP embeddings by Qdrant | Use for image similarity search |

---

## Phase 1: Backend — Censor Detection Upgrade (Task #4)

### Current State
- Single YOLOv8 model (`wenaka_yolov8s-seg.onnx`, 47.9 MB)
- Returns bounding boxes only, censoring uses rectangular regions
- No precise segmentation masks

### Target State
Add **three-tier detection** while keeping backward compatibility:

#### 1A. Upgrade YOLO to YOLO26-seg ✅
- `pip install ultralytics>=8.4.0`
- YOLO26 dual-head architecture (NMS-free end-to-end + one-to-many)
- Variants: yolo26n-seg (~2.7M params), yolo26s-seg, yolo26m-seg, yolo26l-seg, yolo26x-seg
- Auto-downloads weights, segmentation masks natively
- Keep existing YOLOv8 model as fallback option
- **Created**: `yolo26_detector.py`

#### 1B. Add NudeNet v3 detector ✅
- `pip install nudenet>=3.0.0`
- ONNX-based, 20-class body part detection (breast, genitalia, buttocks, etc.)
- More granular than generic YOLO for NSFW-specific censoring
- CPU-compatible, ~320x320 input
- **Created**: `nudenet_detector.py`

#### 1C. Add SAM 3 for precise mask refinement ✅
- Meta's SAM 3 (Segment Anything with Concepts), 848M params
- DETR-based detector + SAM2 tracker architecture
- Open-vocabulary segmentation via text prompts
- Takes bounding box from YOLO26/NudeNet → outputs pixel-precise mask
- Text-prompt support for semantic selection (e.g. "breasts", "face")
- Requires Python 3.12+, PyTorch 2.7+, CUDA 12.6+
- Falls back gracefully to bounding-box censoring if unavailable
- **Created**: `sam3_refiner.py`

#### New Files ✅
```
backend/
├── censor.py              # Modified: multi-model detection support
├── nudenet_detector.py    # New: NudeNet v3 wrapper ✅
├── yolo26_detector.py     # New: YOLO26 wrapper ✅
├── sam3_refiner.py        # New: SAM3 mask refinement ✅
├── routers/censor.py      # Modified: multi-backend detect, SAM3 endpoints ✅
```

#### New API Endpoints ✅
```
POST /api/censor/detect        # Modified: accept model_type param (yolo26/nudenet/both/legacy) ✅
POST /api/censor/refine-mask   # New: SAM3 refine bbox → precise mask ✅
POST /api/censor/segment-text  # New: SAM3 open-vocabulary text segmentation ✅
GET  /api/censor/models        # New: list available detection backends ✅
```

#### Database Changes
None — detection results are transient (not stored).

---

## Phase 2: Backend — Image Similarity Search (Task #6)

### Architecture
- FastEmbed generates 512-dim CLIP embeddings per image
- Embeddings stored in SQLite as BLOB (2048 bytes per image)
- Cosine similarity search via NumPy (fast for <100K images)
- Lazy computation: embeddings generated during scan or on-demand

#### New File
```
backend/
└── similarity.py          # New: FastEmbed wrapper + similarity index
```

#### Database Changes
```sql
ALTER TABLE images ADD COLUMN embedding BLOB;  -- 512-dim float32 = 2048 bytes
CREATE INDEX idx_images_has_embedding ON images(embedding IS NOT NULL);
```

#### New API Endpoints
```
POST /api/similarity/embed       # Batch embed images (background task)
GET  /api/similarity/progress    # Embedding progress
GET  /api/similarity/search/{id} # Find images similar to image ID
POST /api/similarity/search-upload # Find similar by uploading an image
GET  /api/similarity/duplicates  # Find near-duplicate pairs above threshold
```

#### New Router
```
backend/routers/similarity.py   # New router for similarity endpoints
```

---

## Phase 3: Backend — Intelligent Prompt/Tag System (Task #8)

### 3A. Tag Categorization

Auto-categorize existing WD14 tags into semantic groups using a built-in mapping:

| Category | Examples | Source |
|---|---|---|
| `character` | Character names | WD14 `character` category |
| `artist` | Artist names | Prompt prefix `artist:` or WD14 match |
| `outfit` | school_uniform, bikini, dress | WD14 `general` + keyword mapping |
| `pose` | standing, sitting, lying, from_behind | WD14 `general` + keyword mapping |
| `body` | breasts, blue_eyes, long_hair | WD14 `general` + keyword mapping |
| `expression` | smile, blush, open_mouth | WD14 `general` + keyword mapping |
| `background` | outdoors, classroom, beach | WD14 `general` + keyword mapping |
| `action` | holding, running, kissing | WD14 `general` + keyword mapping |
| `style` | realistic, anime_coloring, sketch | WD14 `general` + keyword mapping |
| `quality` | masterpiece, best_quality, highres | Prompt keyword detection |
| `meta` | 1girl, solo, multiple_girls | WD14 `general` + keyword mapping |
| `rating` | general, sensitive, questionable, explicit | WD14 `rating` category |

#### Database Changes
```sql
-- Tag category mapping (built-in + user-customizable)
CREATE TABLE tag_categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tag TEXT NOT NULL UNIQUE,
    category TEXT NOT NULL,          -- outfit, pose, body, etc.
    subcategory TEXT,                -- e.g. outfit->top, outfit->bottom
    is_user_defined INTEGER DEFAULT 0
);

-- Tag sets (tags that should appear together)
CREATE TABLE tag_sets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,              -- e.g. "school uniform set"
    description TEXT,
    category TEXT NOT NULL           -- outfit, style, etc.
);

CREATE TABLE tag_set_members (
    set_id INTEGER NOT NULL,
    tag TEXT NOT NULL,
    weight REAL DEFAULT 1.0,        -- probability weight within set
    is_required INTEGER DEFAULT 1,  -- must appear when set is chosen
    FOREIGN KEY (set_id) REFERENCES tag_sets(id)
);

-- Tag exclusion rules (mutual exclusivity)
CREATE TABLE tag_exclusions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rule_name TEXT NOT NULL,         -- e.g. "back_view_excludes_eyes"
    description TEXT
);

CREATE TABLE tag_exclusion_conditions (
    exclusion_id INTEGER NOT NULL,
    condition_tag TEXT NOT NULL,     -- when this tag is present...
    condition_type TEXT DEFAULT 'present',  -- present/absent
    FOREIGN KEY (exclusion_id) REFERENCES tag_exclusions(id)
);

CREATE TABLE tag_exclusion_targets (
    exclusion_id INTEGER NOT NULL,
    excluded_tag TEXT NOT NULL,      -- ...this tag should not appear
    excluded_category TEXT,          -- OR entire category excluded
    FOREIGN KEY (exclusion_id) REFERENCES tag_exclusions(id)
);
```

### 3B. Built-in Semantic Rules

Pre-populate with common-sense rules:

**Exclusion Rules:**
- `from_behind` / `facing_away` → exclude: `eye_color` tags, `looking_at_viewer`, direct facial expressions
- `closed_eyes` → exclude: `eye_color` tags, `glowing_eyes`
- `nude` → exclude: specific outfit tags (but not accessories)
- `1boy` alone → exclude: `breasts`, `female` body descriptors
- `monochrome` / `greyscale` → exclude: hair_color, eye_color descriptors

**Tag Sets (outfits that go together):**
- "School uniform": `school_uniform, pleated_skirt, white_shirt, sailor_collar, neckerchief`
- "Bikini": `bikini, bikini_top, bikini_bottom` (can vary pieces)
- "Maid": `maid, maid_headdress, apron, frilled_apron`
- "Chinese dress": `china_dress, side_slit, mandarin_collar`

**Weighted Groups (pick-one):**
- Pose: standing (40%), sitting (25%), lying (15%), kneeling (10%), crouching (10%)
- Expression: smile (30%), blush (20%), open_mouth (15%), closed_eyes (10%), ...
- Camera angle: from_above (20%), from_below (15%), from_side (15%), from_behind (10%), portrait (40%)

### 3C. Random Prompt Generator

The generator works in layers:

```
1. Pick character (optional) → loads character-specific tags
2. Pick outfit set → adds all required tags from set
3. Pick pose → adds pose tag, applies exclusion rules
4. Pick expression → filtered by exclusions from pose
5. Pick background/setting
6. Pick camera angle → more exclusion filtering
7. Pick quality tags
8. Pick style/artist (optional)
9. Assemble → respect ordering conventions
10. Generate negative prompt (from quality preset)
```

#### New Files
```
backend/
├── prompt_generator.py      # New: tag categorization + random generation
├── tag_rules.py             # New: built-in rules and mappings
└── routers/prompts.py       # New: prompt generation endpoints
```

#### New API Endpoints
```
GET  /api/prompts/categories          # List all tag categories
GET  /api/prompts/category/{name}     # Tags in a category
POST /api/prompts/categorize          # Auto-categorize uncategorized tags
GET  /api/prompts/sets                # List tag sets
POST /api/prompts/sets                # Create/edit tag set
GET  /api/prompts/exclusions          # List exclusion rules
POST /api/prompts/exclusions          # Create/edit exclusion rule
POST /api/prompts/generate            # Generate random prompt
POST /api/prompts/validate            # Check prompt for rule violations
```

---

## Phase 4: Major UI Redesign (Task #9)

### 4A. Gallery — Virtual Scrolling

Replace the current full-DOM render with a virtual scroll implementation:

```javascript
class VirtualGallery {
    constructor(container, itemHeight, columns) {
        this.container = container;
        this.scrollContainer = document.createElement('div');
        this.viewport = document.createElement('div');
        // Only render visible rows + buffer
        this.bufferRows = 3;
        this.visibleItems = new Map(); // id -> DOM node
    }

    render() {
        const scrollTop = this.scrollContainer.scrollTop;
        const viewportHeight = this.scrollContainer.clientHeight;
        const startRow = Math.floor(scrollTop / this.rowHeight) - this.bufferRows;
        const endRow = Math.ceil((scrollTop + viewportHeight) / this.rowHeight) + this.bufferRows;
        // Create/destroy items as they enter/leave viewport
        // Use transform: translateY() for positioning
    }
}
```

**Key behaviors:**
- Container has full scrollable height via spacer div
- Only ~50-80 image tiles exist in DOM at any time
- Smooth scrolling with 3-row buffer above/below viewport
- Maintain existing IntersectionObserver for thumbnail lazy-loading
- Selection state preserved in data (not DOM)

### 4B. Manual Sort — Full Preview Strip Redesign

Replace the 16-item sliding window with a **minimap + filmstrip**:

```
┌──────────────────────────────────────────────┐
│                    Main Image                 │
│                                               │
│  W (folder)                      D (folder)  │
│                                               │
│  A (folder)           S (folder)             │
│                                               │
├──────────────────────────────────────────────┤
│ Progress: ████████░░░░░░░░░░ 127/500 (25%)   │
├──────────────────────────────────────────────┤
│ ◄ [thumb][thumb][CURRENT][thumb][thumb] ►    │
│      122   123    124     125   126          │
│              ▼ Minimap ▼                      │
│ ░░░░░████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  │
│  (click anywhere on minimap to jump)         │
└──────────────────────────────────────────────┘
```

**Key changes:**
- **Progress bar** showing % complete + count
- **Thumbnails rendered once**, not rebuilt on every keypress
- Only the `.current` class moves; no innerHTML replacement
- **Minimap**: thin strip showing all images as colored pixels
  - Green = sorted to folder, Gray = pending, Blue = skipped, Red = current
  - Click on minimap to jump to any position
- **Keyboard shortcuts enhanced**: Number keys 1-4 as aliases for WASD, arrow keys to browse without sorting
- **Batch skip**: Hold Shift+Space to skip 10 images at once
- Image zoom: Scroll wheel or +/- keys while sorting

### 4C. Censor Queue Optimization

- Replace `renderQueue()` full re-append with targeted DOM updates
- Only move nodes when actual order changes (track previous order)
- Use CSS `order` property instead of DOM reordering for drag preview
- Add virtual scrolling to queue sidebar when >50 items

### 4D. New Tabs/Views

Add three new navigation tabs:

```
Gallery | Auto-Separate | Manual Sort | Censor | Similar | Prompt Lab
```

**Similar View** (`view-similar`):
- Select an image → show grid of similar images with similarity score
- Upload external image for comparison
- Duplicate finder: show near-duplicate pairs
- Threshold slider for similarity sensitivity

**Prompt Lab View** (`view-prompt-lab`):
- Left panel: Category browser (tree view of tag categories)
  - Click category → see all tags, frequency, example images
  - Drag tags to prompt builder
- Center panel: Prompt builder
  - Slot-based UI: [Character] [Outfit] [Pose] [Expression] [Background] [Style]
  - Each slot shows selected tag(s) or "Random"
  - Visual indicators for conflicts/exclusions (red underline)
  - Generate button → fills random values respecting rules
  - Copy to clipboard button
- Right panel: Preview
  - Show example images matching current prompt (from library)
  - Tag relationship graph (which tags co-occur)
- Bottom panel: Rule editor
  - View/edit exclusion rules
  - Create new tag sets
  - Test rules in real-time

### 4E. General UI Improvements

1. **Responsive CSS**: Add media queries for tablet/mobile widths
2. **Fix CSS nesting**: Move all rules out of the `*` selector block
3. **Sidebar toggle**: Collapsible gallery sidebar for more canvas space
4. **Dark/light theme toggle**: CSS custom property switching
5. **Keyboard shortcuts help**: Press `?` to show shortcut overlay
6. **Toast improvements**: Stack multiple toasts, auto-dismiss with progress
7. **Loading states**: Skeleton screens instead of blank areas during load
8. **Image info overlay**: Hover to see prompt/generator/dimensions on thumbnail

---

## Phase 5: File Organization (Code Cleanup)

### Frontend Restructure
```
frontend/
├── index.html              # Slim: just layout skeleton + script/css imports
├── css/
│   ├── variables.css       # CSS custom properties, theme
│   ├── layout.css          # Grid, flexbox, responsive breakpoints
│   ├── components.css      # Buttons, modals, forms, badges
│   ├── gallery.css         # Gallery-specific styles
│   ├── sort.css            # Manual sort styles
│   ├── censor.css          # Censor editor styles
│   ├── similar.css         # Similarity view styles
│   └── prompt-lab.css      # Prompt lab styles
├── js/
│   ├── app.js              # Core: API layer, state, view switching
│   ├── gallery.js          # Virtual scroll gallery
│   ├── autosep.js          # Auto-separate (mostly unchanged)
│   ├── manual-sort.js      # Redesigned sort with minimap
│   ├── censor-edit.js      # Optimized censor editor
│   ├── similar.js          # New: similarity search UI
│   ├── prompt-lab.js       # New: prompt generator UI
│   ├── virtual-scroll.js   # New: shared virtual scroll component
│   └── audio.js            # Sound effects (unchanged)
```

### Backend Restructure
```
backend/
├── main.py                 # Entry point (unchanged)
├── database.py             # Add new tables for tags/prompts
├── metadata_parser.py      # Already improved (99.8%)
├── image_manager.py        # Add embedding support
├── tagger.py               # Unchanged
├── censor.py               # Modified: multi-model support
├── similarity.py           # New: FastEmbed wrapper
├── prompt_generator.py     # New: intelligent prompt generation
├── tag_rules.py            # New: built-in tag categorization rules
├── yolo26_detector.py        # New: YOLO26 wrapper ✅
├── nudenet_detector.py     # New: NudeNet v3 wrapper ✅
├── sam3_refiner.py          # New: SAM3 mask refinement (text-guided) ✅
├── routers/
│   ├── images.py           # Unchanged
│   ├── tags.py             # Unchanged
│   ├── sorting.py          # Unchanged
│   ├── censor.py           # Modified: new model endpoints
│   ├── similarity.py       # New: similarity endpoints
│   └── prompts.py          # New: prompt generation endpoints
└── utils/
    └── path_validation.py  # Unchanged
```

---

## Implementation Order

| Step | What | Dependencies | Estimated Files Changed |
|------|------|-------------|------------------------|
| 1 | Database schema migration (new tables) | None | database.py |
| 2 | FastEmbed similarity backend | Step 1 | similarity.py, routers/similarity.py |
| 3 | Tag categorization engine | Step 1 | tag_rules.py, prompt_generator.py |
| 4 | Prompt generator backend | Step 3 | prompt_generator.py, routers/prompts.py |
| 5 | NudeNet + YOLO26 detection | None | yolo26_detector.py, nudenet_detector.py, routers/censor.py ✅ |
| 6 | SAM3 mask refinement | Step 5 | sam3_refiner.py, routers/censor.py ✅ |
| 7 | CSS restructure + fix nesting | None | All CSS files |
| 8 | Virtual scroll gallery | Step 7 | virtual-scroll.js, gallery.js |
| 9 | Manual sort redesign | Step 7 | manual-sort.js |
| 10 | Similar view UI | Steps 2, 8 | similar.js, index.html |
| 11 | Prompt Lab UI | Steps 3, 4, 8 | prompt-lab.js, index.html |
| 12 | Censor editor upgrades | Steps 5, 6 | censor-edit.js |
| 13 | General UI polish | All above | Various |

---

## Requirements / Dependencies

```
# New pip packages
fastembed>=0.4.0      # ONNX-based CLIP embeddings
nudenet>=3.0.0        # NSFW body part detection
ultralytics>=8.4.0    # YOLO26 (detection + segmentation)

# Optional (SAM3 - GPU-only, manual install)
# git clone https://github.com/facebookresearch/sam3.git && pip install -e .
# Requires Python 3.12+, PyTorch 2.7+, CUDA 12.6+
```

## Risk Assessment

| Risk | Mitigation |
|------|-----------|
| SAM3 GPU requirement | Optional — falls back to bounding-box censoring. Manual install. |
| FastEmbed model download (330MB) | Lazy download on first use, show progress |
| Large DB with embeddings | 100K images × 2KB = 200MB — acceptable for SQLite |
| Virtual scroll complexity | Simple row-based approach, not pixel-perfect |
| Tag rule maintenance | Ship sensible defaults, let users customize |
| CSS refactor breaks things | Incremental: fix nesting first, then split files |
