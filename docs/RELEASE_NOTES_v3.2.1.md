# SD Image Sorter v3.2.1 Release Notes

**Released**: 2026-05-18

This release is the biggest behind-the-scenes upgrade since v3.0: the Tagger sidebar now opens up to **any** vision-language model (cloud or local), the export pipeline gets a real LoRA-training template engine, and the gallery learns to filter and sort by **color** — not just metadata.

---

## TL;DR

- **VLM captioning** with OpenAI / Anthropic / Gemini / Vertex AI / Ollama, with proxy support, retry, and NSFW handling.
- **One-click Ollama deployment** for Gemma 3/4, Qwen 2.5/3 VL, MiniCPM-V — including NSFW-tolerant variants.
- **VLM as danbooru tagger** mode: a hosted VLM can now also produce structured tags, not just NL captions.
- **Export template engine** with 7 LoRA training presets (Anima, IL/Pony, NoobAI, FLUX, Kohya, Custom).
- **Color-based filter & sort** in the gallery (brightness, saturation, color temperature, distribution shape).
- **Mass tag editor** (Tag-Master inspired) with dry-run previews.

---

## What's New

### 1. Multi-provider VLM (Vision Language Model) captioning

The Tagger sidebar now contains a complete VLM pipeline that works alongside (or independently from) the existing WD14 / Camie / PixAI / ToriiGate taggers.

**Supported providers** (auto-detected from the endpoint URL):
- **OpenAI-compatible**: OpenAI, Ollama, vLLM, LMStudio, OpenRouter, Volcengine Ark, any `/v1/chat/completions` endpoint
- **Anthropic**: Claude 3.5 / 4 (Sonnet, Opus, Haiku) — vision-capable
- **Google Gemini**: public AI Studio API + Vertex AI (service-account JSON for enterprise)
- **Local via Ollama**: one-click downloads of recommended vision models

**Reliability features**:
- User-configurable retry count + backoff
- NSFW-refusal detection: when a model refuses, automatically retries with a "relaxed" prompt
- Mid-batch cancel — completed work is preserved
- Per-image error tracking with error type tags (`timeout`, `connection`, `auth`, `rate_limit`, `nsfw_refused`, etc.)
- Token usage and success/failed counters in the progress UI

**HTTP / HTTPS / SOCKS proxy support**: drop a proxy URL into VLM Settings and every API call routes through it. Useful for restricted regions where the upstream provider is blocked.

**Vertex AI** for users who can't use the public Gemini key: configure with project ID, region, and a service-account JSON (paste content or file path). Access tokens cached for ~50 minutes.

### 2. One-click local VLM deployment via Ollama

VLM Settings includes a curated list of recommended vision models with size and minimum-VRAM requirements:

| Model | Size | Min VRAM | NSFW OK |
|---|---:|---:|:---:|
| MiniCPM-V 4.6 | 1.6 GB | 3 GB | — |
| Gemma 3 4B | 3.0 GB | 4 GB | — |
| Qwen3-VL 8B | 5.0 GB | 6 GB | ✓ |
| MiniCPM-V 4.5 | 5.9 GB | 8 GB | — |
| Gemma 4 27B (MoE A4B) | 16 GB | 12 GB | — |
| **Gemma 4 26B Heretic (uncensored)** | 16 GB | 12 GB | ✓ |
| Qwen 2.5 VL 7B | 4.7 GB | 6 GB | ✓ |
| Qwen3-VL 32B | 20 GB | 24 GB | ✓ |

Click "Download" → app pulls via Ollama with live progress.
Click "Use This" → endpoint and model fields auto-populate.
If Ollama is installed but not running, the app starts it automatically.
If Ollama is missing, the app shows the platform-specific install command.

Any other model (custom finetune, hosted API, paid cloud service) can still be used by typing the endpoint manually — manual entry is the primary path, the recommended list is just a convenience layer.

### 3. VLM as danbooru-tag generator

VLM doesn't have to output natural language — it can output structured tags too.

New `output_format` setting:
- `nl_caption` (default) — VLM writes 2-4 sentences of natural language description, stored in `ai_caption`
- `danbooru_tags` — VLM outputs comma-separated danbooru tags, parsed and stored in the tags table
- `both` — hybrid `<NL>...</NL><TAGS>...</TAGS>` format that produces both at once

Two new prompt presets in the dropdown:
- **Danbooru Tags (VLM as tagger)** — VLM mimics WD14 output style
- **Hybrid (NL + Tags)** — both at the same time with XML markers

This means users without a GPU can use a hosted VLM as their primary tagger, or pair WD14 with VLM-refined tags for higher quality.

### 4. 5 prompt presets for LoRA training

Built-in system prompts tuned for different training styles:

| Preset | Best for |
|---|---|
| LoRA Training (NL caption) | Standard 2-4 sentence NL caption |
| Anima / FLUX (Detailed NL) | Long descriptive NL with spatial details |
| Short Caption | Single-sentence summary |
| Character LoRA Training | Skips fixed character features (hair color, eye color), focuses on scene-specific details |
| NSFW-Tolerant (Local Models) | For local models — uses anatomical terms, no moral warnings |

Each preset has a system prompt + user prompt + an alternate "with tags as context" prompt (used when the local tagger has already produced danbooru tags and the VLM should complement, not duplicate them).

### 5. Export template engine for LoRA training

The export system now supports 7 LoRA training presets, each tuned for a specific base model:

| Preset | Format | Notes |
|---|---|---|
| **Anima (Tags + NL)** | `{quality}, {safety}, {count}, {trigger}, {nl_caption}, {tags:filtered}` | Underscores → spaces, preserves `score_N` |
| **Anima (Tags only)** | Same minus `{nl_caption}` | Pure danbooru with quality prefix |
| **Illustrious / Pony** | `{trigger}, {tags:filtered}, {append}` | Standard underscore format |
| **NoobAI** | `{trigger}, {rating}, {tags:filtered}, {append}` | Rating tag in front |
| **FLUX (NL only)** | `{trigger}. {nl_caption}` | Pure NL with period-separated trigger |
| **Kohya SD 1.5** | `{trigger}, {tags:filtered}` | Classic SD 1.5 format |
| **Custom** | User-defined template | Full control |

**Tag processing pipeline** (in fixed order): blacklist → replace → max-N → append.

**14 template variables**: `{trigger}`, `{tags}`, `{tags:N}`, `{tags:filtered}`, `{nl_caption}`, `{prompt}`, `{negative}`, `{rating}`, `{count}` (auto-extracted from tags), `{characters}`, `{general}`, `{quality}`, `{safety}`, `{append}`.

**New content modes**: `nl_caption` (natural language only), `prompt_nl` (original prompt + NL caption), `template` (uses the engine).

**Live preview API**: `POST /api/tags/export-preview` renders captions for up to 20 sample images at once so users can see what they'll get before committing.

> The frontend export modal redesign with per-image edit + thumbnail will follow in a UI polish release. The backend API is stable in v3.2.1, so external scripts and the existing batch export already work with the new presets.

### 6. Color-based gallery filter and sort

The gallery now understands what the images look like, not just what's tagged on them.

**Migration 010** adds 7 new columns to the `images` table:
- `dominant_colors` — JSON array of top 5 hex colors with percentages
- `avg_brightness` — 0-255 (HSV V channel)
- `color_temperature` — `warm` / `cool` / `neutral`
- `color_saturation` — 0-255 (HSV S channel)
- `brightness_histogram` — JSON 16-bucket histogram
- `brightness_skew` — third moment (negative = dark-heavy, positive = bright-heavy)
- `brightness_distribution` — `left_heavy` / `right_heavy` / `middle_heavy` / `edge_heavy` / `balanced`

Indexes on brightness, temperature, distribution, and skew for fast filtering.

**New sort options** (asc + desc): `brightness`, `saturation`, `brightness_skew` (the "Dark→Bright distribution" sort).

**New filter parameters** in `/api/images`: `brightness_min`, `brightness_max`, `color_temperature`, `brightness_distribution`.

**Histogram shape classification** distinguishes:
- `edge_heavy` → line art, sketches, B&W comics (high contrast, both ends of histogram)
- `middle_heavy` → typical photos, anime cels
- `left_heavy` → dark-dominant scenes (night, shadows)
- `right_heavy` → bright-dominant (overexposed, white backgrounds, sketches)
- `balanced` → otherwise

**Performance**: ~5-15ms per image on a 64×64 thumbnail. Negligible vs metadata parsing.

**Backfill for existing libraries**: `POST /api/colors/analyze` runs batch color analysis on images that don't have data yet. Concurrency-controlled, cancelable, progress polling. Use `/api/colors/missing-count` to see how many images need analysis.

> Frontend filter pills and a "color UI" panel will follow in a UI polish release.

### 7. Mass tag editor (Tag-Master inspired)

Four new bulk tag operations on the persistent DB tags (separate from export-time substitution which happens in the template engine):

- `POST /api/tags/bulk/find-replace` — rename a tag across N images (e.g., `school_uniform` → `serafuku`). Empty replace = remove.
- `POST /api/tags/bulk/add` — append tags with a confidence override; deduplicates against existing tags.
- `POST /api/tags/bulk/remove` — delete specified tags, optional case-sensitive.
- `POST /api/tags/bulk/cleanup` — remove tags below a confidence threshold, plus optional case-insensitive dedupe (keeps highest-confidence copy).

Every operation supports `dry_run=True` to preview before committing. The response includes:
- `affected_images`: count
- `total_tags_added` / `total_tags_removed`: counts
- `sample_changes`: up to 5 entries showing the actual before/after for spot-checking

Useful for cleaning up WD14 mistakes across an entire library, normalizing tag vocabulary, or migrating between tag namespaces.

---

## API Reference (new endpoints)

### VLM
- `GET  /api/vlm/providers` — list provider types
- `POST /api/vlm/detect-provider` — auto-detect provider from endpoint URL
- `GET  /api/vlm/presets` — list 7 prompt presets
- `GET  /api/vlm/settings` — current config (api_key + service_account masked)
- `POST /api/vlm/settings` — save config
- `POST /api/vlm/test` — test connection + fetch model list
- `POST /api/vlm/models` — explicit model list fetch
- `POST /api/vlm/caption` — caption a single image
- `POST /api/vlm/caption-batch` — start batch
- `GET  /api/vlm/caption-batch/progress` — poll progress
- `POST /api/vlm/caption-batch/cancel` — stop batch
- `GET  /api/vlm/local-models/recommended` — list recommended Ollama models
- `POST /api/vlm/local-models/pull` — start downloading via Ollama
- `GET  /api/vlm/local-models/pull/progress` — poll download progress
- `POST /api/vlm/local-models/delete` — remove a local model
- `POST /api/vlm/local-models/start-ollama` — start Ollama service

### Color analysis
- `POST /api/colors/analyze` — start batch color analysis
- `GET  /api/colors/progress` — poll
- `POST /api/colors/cancel` — stop
- `GET  /api/colors/missing-count` — how many images haven't been analyzed
- `POST /api/colors/analyze-single/{image_id}` — analyze one image synchronously

### Mass tag editor
- `POST /api/tags/bulk/find-replace` — rename a tag across N images
- `POST /api/tags/bulk/add` — bulk add
- `POST /api/tags/bulk/remove` — bulk remove
- `POST /api/tags/bulk/cleanup` — drop low-confidence + dedupe
- `GET  /api/tags/bulk/state` — current op state

### Export template engine
- `GET  /api/tags/export-presets` — list 7 LoRA presets + 14 template variables
- `POST /api/tags/export-preview` — render captions for up to 20 sample images

### `/api/images` query parameters (new)
- `brightness_min` / `brightness_max` (0-255)
- `color_temperature` = `warm` | `cool` | `neutral`
- `brightness_distribution` = `left_heavy` | `right_heavy` | `middle_heavy` | `edge_heavy` | `balanced`
- `sort_by` adds: `brightness`, `brightness_asc`, `saturation`, `saturation_asc`, `brightness_skew`, `brightness_skew_asc`

---

## Migration Notes

- **DB schema**: migration 010 adds 7 nullable color columns. Existing libraries continue working unchanged. Color filters won't return rows for images with NULL color data; run `/api/colors/analyze` to backfill.
- **VLM settings file**: `data/config/vlm-settings.json` is created on first save. Sensitive fields (`api_key`, `service_account_json`) are stored in plaintext locally; treat the file as a secret.
- **Optional dependencies**:
  - **Vertex AI** requires `google-auth` (`pip install google-auth`)
  - **SOCKS proxy** requires `httpx[socks]` (`pip install 'httpx[socks]'`)
  - The app shows a helpful error if either is missing rather than silently failing.

---

## Known Limitations

- Frontend UI for the new export template engine (per-image edit, thumbnail preview) is a follow-up — backend APIs are stable.
- Frontend UI for color filter pills and mass tag editor is a follow-up — backend APIs are stable.
- Color extraction is currently opt-in for existing libraries (not auto-run on every gallery open). Trigger via `/api/colors/analyze` once.
- VLM proxy / Vertex auth UI in the settings modal lives under "Advanced Settings" — not surfaced by default.
