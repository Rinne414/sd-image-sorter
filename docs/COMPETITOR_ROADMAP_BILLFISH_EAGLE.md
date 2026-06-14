# SD Image Sorter Competitive Roadmap: Billfish / Eagle

Date: 2026-06-13

This is a product and engineering roadmap. Do not copy this text into end-user UI.

## Source Baseline

- Eagle official support exposes a broad asset-manager surface: Browser Extension, Duplicate Check, Batch Rename, Tag Selection, File Selection, Quick Switch, Inspector, Filter, Smart Folders, Plugin API, and Web API.
  Source: https://en.eagle.cool/support/article/smart-folders
- Billfish official help describes a classic four-region asset manager: top bar for library/import/toolbox/settings, left sidebar for folder and tag trees, center toolbar/filter/material grid, and right inspector for file info, color extraction, tags, notes, and ratings.
  Source: https://www.billfish.cn/help
- Billfish official extension page emphasizes capture workflows: drag-to-save, right-click capture, Alt+right-click quick capture, batch page image capture, region screenshot, visible screenshot, full-page scrolling screenshot, custom shortcut, custom screenshot format, and custom destination folder.
  Source: https://www.billfish.cn/extension
- Billfish official home positions the product around large material libraries, multi-type asset support, web inspiration capture, multidimensional management, fast search/preview, image-content recognition search, reverse image search, and intelligent tools.
  Source: https://www.billfish.cn/

## Competitive Thesis

SD Image Sorter should not become a generic Eagle clone. The winning position is:

1. Match the basic asset-manager expectations well enough that users do not miss Eagle/Billfish for everyday organization.
2. Beat them for AI-image workflows: Stable Diffusion metadata, generator-aware filtering, prompt/model/LoRA extraction, dataset creation, Smart Tag, local/cloud VLM captioning, and training-export quality.
3. Keep the workflow local-first and predictable for large private libraries.

## Current Position

Strengths:

- AI-native metadata: generator, prompt, checkpoint, LoRA, dimensions, tags, NL captions, VLM output.
- Dataset Maker is a real differentiator, especially with Smart Tag, trigger words, caption cleanup, and export.
- Local-first library and existing folder tree are closer to AI-image hoarder workflows than cloud-first design tools.
- Existing tools already cover censor editing, similar image search, prompt helper, style/artist finder, batch tagging, VLM captioning, and collection workflows.

Weaknesses versus Eagle/Billfish:

- Import/capture is weaker: no browser extension, no watched folders, no screenshot/web capture, no drag-to-destination capture.
- Organization parity is incomplete: collections, folders, tags, filters, and mass tag editing exist but are not consistently surfaced where users expect them.
- Search is too metadata-oriented and not yet a unified command/search experience.
- Duplicate management is not first-class enough as a library hygiene workflow.
- Navigation and overflow bugs have repeatedly damaged perceived polish.
- Right-side inspector/editor patterns vary across views, so users relearn similar operations.

## Product Principles

- Put functions where users expect them from the current task, not where the implementation happens to live.
- Every long row must have a deterministic overflow strategy: pinned primary action, scroll rail or More fallback, never silent clipping.
- Every completed background job must refresh the affected UI automatically.
- Prefer one shared component for repeated patterns: popovers, rails, inspectors, selection actions, import cards, and progress banners.
- Do not hide AI-native advantages behind generic labels.
- Do not delete or remove features without an explicit migration and user approval.

## Roadmap

### v3.4.x: Polish And Trust Recovery

Goal: stop recurring low-level UX regressions and make the current feature set feel reliable.

- Navigation: direct Prompt Helper / Style Finder when space allows; More fallback when needed; no clipped top-bar buttons in English or Chinese.
- Generator filters: pin All; scroll all other generators horizontally; keep Others reachable and explain what it groups.
- Popovers: all coordinate-based menus use the shared viewport-safe positioner.
- Dataset Maker: Step 1 import choices are visually clear; Step 2 spends primary space on image/caption editing; Split is usable.
- Smart Tag: visible from AI Auto Tagging and Dataset Maker; both routes open the same modal with correct scope.
- Mass Tag Editor: entry points set the expected scope automatically.
- Scan and maintenance jobs: refresh affected folder/tree/filter/stat views when complete.
- Tests: add regression coverage for top bar overflow, generator rail reachability, Smart Tag entry, Dataset Step 1/2 geometry, and popup clamping.

### v3.5: Asset-Manager Parity

Goal: users should not need Eagle/Billfish for normal library organization.

- Unified command/search bar:
  - Search filenames, folders, tags, generator, checkpoint, LoRA, prompt text, NL caption, dimensions, rating, and collection.
  - Offer quick actions: add tag, add to collection, open folder, run Smart Tag, find similar, export captions.
- Smart folders / saved filters:
  - Save any filter as a live folder.
  - Support generator/checkpoint/LoRA/tag/rating/date/dimension/missing-caption/tagged-state rules.
  - Show counts and refresh after scans/tagging.
- Duplicate and near-duplicate workspace:
  - Exact duplicate, same basename, same metadata, CLIP near-duplicate, and perceptual hash groups.
  - Review choices: keep best, merge tags/captions, add to collection, delete/move to quarantine.
- Folder/tag tree parity:
  - Fast tree search.
  - Drag selected images to folder/tag/collection.
  - Right-click tag/folder actions: rename, merge, delete, find usages, mass replace.
- Inspector consistency:
  - One right-side pattern for metadata, tags, notes, rating, colors, generator, prompt, and actions.
  - Same fields appear in Gallery preview, Reader, Dataset Maker, and selection panel when applicable.
- Import hygiene:
  - Scan presets, recent paths, post-scan actions, auto-create collection from scan, conflict summary.
  - Clear imported/skipped/duplicate/missing-file counts.

### v3.6: Pro Workflow Advantage

Goal: surpass generic asset managers for AI-image production.

- Browser / clipboard capture MVP:
  - Local companion endpoint or extension to send image URL/file/screenshot into SD Image Sorter.
  - Capture source URL, page title, timestamp, and optional note.
  - Let users choose destination collection/folder/tag on capture.
- Watch folders:
  - Monitor ComfyUI / WebUI / Forge / NovelAI export directories.
  - Auto-scan new images, extract metadata, apply source collection, optionally Smart Tag.
- AI metadata enrichment:
  - Batch prompt normalization.
  - Negative prompt cleanup.
  - Character/style/concept tagging profiles.
  - Local/cloud VLM queue presets.
- Dataset workbench upgrades:
  - Dataset versioning.
  - Caption diff history.
  - Rule-based caption cleanup preview.
  - Export profiles for Kohya, Diffusers, Flux/SDXL style workflows.
- Model-aware organization:
  - Group by checkpoint/LoRA/model hash.
  - Detect missing local model references.
  - Link images to model cards and training datasets.

### v4.0: Differentiators

Goal: become the strongest local-first AI-image library and dataset manager.

- Visual semantic search:
  - Text-to-image search across local CLIP/embedding index.
  - "Find images like this prompt" and "Find prompt like this image."
- Training dataset quality cockpit:
  - Coverage analysis by character, outfit, pose, background, angle, style, rating.
  - Detect overrepresented tags and underrepresented concepts.
  - Suggest caption fixes before export.
- Workflow automation:
  - Saved pipelines: watch folder -> scan -> Smart Tag -> collection -> dataset audit -> export.
  - Per-pipeline logs and rollback.
- Plugin/API layer:
  - Import/export plugins.
  - Scriptable actions for power users.
  - External tool hooks for ComfyUI / A1111 / training scripts.
- Multi-library strategy:
  - Multiple local libraries.
  - Move/copy collections between libraries.
  - Optional portable project bundles for sharing datasets.

## Immediate Backlog Candidates

High priority:

- Add E2E tests for English/Chinese top-bar overflow at 1366, 1920, and 2560 widths.
- Add a reusable horizontal rail component for generator tabs and future tag/filter chips.
- Create saved filters as the first step toward smart folders.
- Promote duplicate/near-duplicate cleanup as a visible hygiene workflow.
- Normalize right-side inspector actions across Gallery, Reader, and Dataset Maker.

Medium priority:

- Browser capture design spike.
- Watch-folder technical spike.
- Unified command/search UI prototype.
- Dataset versioning data model.

Low priority:

- Plugin API before the internal workflow surfaces are stable.
- Cloud collaboration features; they are not the current core advantage.

## Non-Goals / Avoid

- Do not copy Eagle/Billfish UI one-to-one. Their workflows target general design assets; this project targets AI-image libraries and LoRA/dataset workflows.
- Do not add more top-level buttons without an overflow plan.
- Do not make Smart Tag feel like a hidden Dataset-only feature.
- Do not make generic collection/folder/tag features compete with AI metadata; they should work together.
- Do not ship "fake" categories, empty filters, or buttons that only work for one hidden data shape.

## Success Metrics

- A new user can scan a folder, filter by generator, tag/caption a selection, add to a collection, and export a dataset without reading documentation.
- Top navigation and generator rail do not clip at 1366px in English or Chinese.
- Background job completion refreshes the relevant visible UI without manual reload.
- Users can answer "what should I clean next?" from duplicate, missing-caption, low-quality, and dataset-audit views.
- AI-image-specific workflows remain faster than doing the same work in Eagle/Billfish plus separate scripts.
