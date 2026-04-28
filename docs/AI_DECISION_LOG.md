# AI Decision Log

**Updated:** 2026-04-28
**Purpose:** Preserve deliberate local decisions so future AI agents do not silently undo them.

## How To Use This File

1. Read this before changing UX wording, workflow behavior, data semantics, save behavior, path handling, or major defaults.
2. Add a new entry when a decision is intentional and another AI might otherwise "correct" it later.
3. Do not rewrite old entries just to make the file look clean.
4. If a decision changes, add a new entry and mark the older one as superseded.

## What Belongs Here

This file is for durable repo-local decisions that future AI is likely to misread or undo without help.

Good candidates:

- non-obvious defaults
- save / overwrite / move / copy semantics
- selection / filter / scope semantics
- path or data invariants
- product-specific UX rules that differ from generic convention
- local product assumptions that materially affect implementation choices

## What Does Not Belong Here

Do not use this file for:

- ordinary bug fixes with no lasting semantic rule
- temporary workarounds
- one-off release chores
- raw TODO lists
- current test counts
- speculative ideas not yet reflected in current behavior
- generic advice like "write cleaner code" or "improve performance"

If something is only a suspected future problem, it belongs in `docs/TECHNICAL_DEBT_NOTES.md`, not here.

## Admission Bar

Before adding an ADR here, be able to answer all of these:

1. What exact local behavior or rule is being preserved?
2. Why is another AI likely to "fix" it incorrectly later?
3. What evidence supports it?
4. What kind of future changes are still allowed?

If you cannot answer those questions clearly, do not add the ADR yet.

## Entry Format

Use this structure for future entries:

### ADR-AI-YYYYMMDD-XX: Short Title
- Status: active / superseded / deprecated
- Area: frontend UX / backend workflow / data model / architecture / release / etc.
- Evidence tier: `explicit user instruction` / `Tier 1` / `Tier 1 + Tier 2`
- Decision:
- Why:
- Do not "improve" this by:
- Allowed evolution:
- Evidence:
- Last verified:
- Related files:
- Supersedes:
- Validation:

## Current Records

### ADR-AI-20260427-01: Copy mode is a first-class workflow, not a redundant duplicate of move
- Status: active
- Area: sorting workflow / file lifecycle
- Evidence tier: explicit user instruction + Tier 1
- Decision:
  Keep copy as an explicit first-class operation in sorting flows instead of treating move as the only "real" operation.
- Why:
  Some users need to sort into other folders without disturbing originals or their date-based library workflow. Removing or downplaying copy would push the product toward technically simpler behavior that is worse for real usage.
- Do not "improve" this by:
  Removing copy mode, collapsing copy into move, or treating copy as an unnecessary extra because move looks cleaner.
- Allowed evolution:
  Safer defaults, clearer wording, better explanation of when copy should be used, and better post-action refresh behavior.
- Evidence:
  Current sorting flows expose explicit move vs copy behavior; current user feedback explicitly asked for copy support because move-only handling was insufficient; sorting regression fixes and tests now cover this workflow.
- Last verified:
  2026-04-27 against current workspace behavior and sorting regression coverage.
- Related files:
  `backend/services/sorting_service.py`
  `frontend/js/manual-sort.js`
  `frontend/js/autosep.js`
  `backend/tests/test_routers/test_sorting.py`
- Supersedes:
  None
- Validation:
  Covered by sorting tests and recent copy/move regression fixes.

### ADR-AI-20260427-02: Derived state validity depends on pixel content, not container metadata churn
- Status: active
- Area: backend data lifecycle
- Evidence tier: Tier 1
- Decision:
  Use metadata-independent pixel fingerprints (`content_fingerprint`) to decide whether tags, embeddings, AI captions, aesthetic scores, and artist predictions should be preserved or cleared.
- Why:
  Metadata-only rewrites should not destroy expensive derived data, while true pixel changes must invalidate stale derived state. Using file timestamps or container rewrites alone is too blunt and causes real regressions.
- Do not "improve" this by:
  Clearing derived data on every rescan/save/reparse just because file metadata changed, or by treating all same-path rewrites as equivalent.
- Allowed evolution:
  Centralize the policy further, improve docs, add more invariant tests, or improve fingerprinting implementation.
- Evidence:
  Current code now uses `content_fingerprint`; recent regression fixes corrected both over-clearing and under-clearing derived data when files were rewritten.
- Last verified:
  2026-04-27 against current workspace code and regression coverage.
- Related files:
  `backend/database.py`
  `backend/image_manager.py`
  `backend/image_fingerprint.py`
  `backend/services/image_service.py`
  `backend/services/censor_service.py`
- Supersedes:
  Any older implicit "mtime/size alone decides staleness" behavior.
- Validation:
  Database, image manager, images, tags, sorting, and prompts/censor/similarity/artists regression suites.

### ADR-AI-20260427-03: Saving over an indexed file must reconcile the library row immediately
- Status: active
- Area: save / overwrite workflow
- Evidence tier: Tier 1
- Decision:
  If a save target path already belongs to an indexed library item, refresh that indexed row immediately after save.
- Why:
  Otherwise the UI can keep stale metadata or stale derived state even though the file on disk changed. This rule is workflow-critical and must not depend on the feature author remembering it ad hoc.
- Do not "improve" this by:
  Assuming a later scan will clean things up, or by limiting refresh logic to one feature such as Reader only.
- Allowed evolution:
  Centralize overwrite reconciliation into a shared save helper used by all features.
- Evidence:
  The same bug family had to be fixed in more than one feature path, and current code now explicitly reconciles indexed rows after overwrite saves.
- Last verified:
  2026-04-27 against current workspace code and save-flow regression coverage.
- Related files:
  `backend/services/image_service.py`
  `backend/services/censor_service.py`
  `backend/image_manager.py`
  `backend/database.py`
- Supersedes:
  Feature-local assumptions that overwrite save does not need immediate library reconciliation.
- Validation:
  Reader save tests plus Censor Edit overwrite regression tests.

### ADR-AI-20260427-04: "Select Visible" wording is intentional because the behavior is visible-scope, not global-scope
- Status: active
- Area: gallery UX semantics
- Evidence tier: Tier 1
- Decision:
  The gallery bulk-selection button should describe visible-scope behavior, not broad "select all" behavior.
- Why:
  The implementation operates on visible rendered gallery items. Labeling that action as "Select All" misleads users and future contributors about the true scope.
- Do not "improve" this by:
  Renaming it to "Select All" unless the actual selection semantics are changed to match.
- Allowed evolution:
  Make scope even clearer, document visible vs filtered vs full-library selection, or redesign the selection model explicitly.
- Evidence:
  A real UI text regression changed the label while the behavior remained visible-only; current code and markup still reflect visible-scope selection.
- Last verified:
  2026-04-27 against current workspace UI text and selection logic.
- Related files:
  `frontend/index.html`
  `frontend/js/gallery.js`
  `frontend/js/app.js`
  `frontend/js/ui-refresh.js`
- Supersedes:
  The accidental label drift introduced by UI refresh text binding.
- Validation:
  Manual verification plus code inspection of visible-scope selection logic.

### ADR-AI-20260427-19: Gallery selection scope must stay explicit when visible-scope and loaded-scope actions differ
- Status: active
- Area: gallery UX semantics / frontend state
- Evidence tier: Tier 1
- Decision:
  Keep gallery selection scope explicit in the sidebar: visible-scope buttons stay labeled as visible actions, and shift-range selection is treated as loaded-result scope rather than silently pretending it means the whole filtered result set.
- Why:
  The gallery already mixes two real scopes today: DOM-visible bulk actions and loaded-result range selection. If the UI hides that distinction, future pagination or virtualization work will quietly reintroduce wrong-scope bugs.
- Do not "improve" this by:
  Collapsing everything back into generic "selected" wording, renaming visible-scope actions to global-scope wording, or pretending shift-range covers the full filtered result list when it only covers loaded rows.
- Allowed evolution:
  Add a true filtered/all-matching selection mode later, but only if the UI and state contract continue to say exactly which scope each action uses.
- Evidence:
  Current code now routes gallery selection changes through `SelectionStore`, the sidebar shows explicit scope copy, and range selection still operates on `AppState.images` while the visible-action buttons operate on rendered gallery items.
- Last verified:
  2026-04-27 against current workspace selection logic, sidebar copy, and E2E coverage.
- Related files:
  `frontend/js/stores/selection-store.js`
  `frontend/js/gallery.js`
  `frontend/js/app.js`
  `frontend/index.html`
- Supersedes:
  None
- Validation:
  Gallery selection E2E coverage plus manual code inspection of visible vs loaded scope paths.

### ADR-AI-20260427-20: True filtered selection must resolve from the backend result set, not the loaded thumbnail subset
- Status: active
- Area: gallery UX semantics / frontend-backend contract
- Evidence tier: Tier 1
- Decision:
  When Gallery selection scope is `filtered`, the frontend must resolve the ID set through `POST /api/images/selection-ids` and treat it as a distinct contract from `visible` DOM selection or `loaded` shift-range selection.
- Why:
  The loaded gallery page is only a slice of the filtered result set. If filtered selection is inferred from `AppState.images` or pruned against the currently loaded page on every refresh, batch actions silently target the wrong files.
- Do not "improve" this by:
  Pretending filtered selection can be reconstructed from loaded thumbnails, pruning filtered selections against the current page after every reload, or renaming visible-scope actions to broad "select all" wording.
- Allowed evolution:
  Recompute filtered selection automatically when filters change, add a future whole-library scope, or optimize the backend ID-resolution path, as long as filtered selection remains an explicit backend-resolved contract.
- Evidence:
  Current code now exposes `POST /api/images/selection-ids`, `SelectionStore` carries a filtered-selection `filterKey`, the sidebar exposes a dedicated "Select Filtered" action, and same-filter reloads no longer silently drop off-page IDs.
- Last verified:
  2026-04-28 against current workspace code, targeted backend router tests, and local Playwright browser runs; WSL fallback now prefers a local POSIX Python before a Windows `python.exe`, and missing Chromium shared libraries can be bootstrapped from repo-local runtime packages.
- Related files:
  `backend/routers/images.py`
  `backend/services/image_service.py`
  `backend/tests/test_routers/test_images.py`
  `frontend/js/stores/selection-store.js`
  `frontend/js/app.js`
  `frontend/js/gallery.js`
  `frontend/index.html`
  `tests/e2e/playwright.config.ts`
  `tests/e2e/scripts/run-playwright.mjs`
  `tests/e2e/specs/smoke.spec.ts`
- Supersedes:
  None
- Validation:
  Backend router tests for `/api/images/selection-ids` pass; local Playwright browser runs now pass for `should load the main page` and `filtered selection should resolve all matching ids and survive same-filter reloads`.

### ADR-AI-20260428-21: Image time semantics are split, but `created_at` remains a compatibility alias
- Status: active
- Area: data model / sorting semantics
- Evidence tier: Tier 1
- Decision:
  `images.library_order_time` is now the stable gallery ordering key, `images.source_file_mtime` tracks the current file modification time, and `created_at` remains only as a deprecated compatibility alias that mirrors `library_order_time`.
- Why:
  The old single-field model mixed stable library chronology with mutable file time. That made rescans, copies, and future timeline/sort work too easy to misread. The split preserves existing gallery chronology while finally giving file-time semantics their own field.
- Do not "improve" this by:
  Reusing `source_file_mtime` as the default gallery sort key, treating `created_at` like real file creation time again, or dropping the compatibility alias before all callers are migrated.
- Allowed evolution:
  Move more code and docs off `created_at`, eventually remove the alias in a later compatibility-breaking pass, and add explicit UI wording for file-time-based views if the product needs them.
- Evidence:
  The schema now includes `library_order_time` and `source_file_mtime`; default image ordering and cursor pagination now use `library_order_time`; scan/rescan/copy writes preserve `library_order_time` while updating `source_file_mtime`; router/database/image-manager regressions cover the split.
- Last verified:
  2026-04-28 against current workspace code and targeted backend regression coverage.
- Related files:
  `backend/migrations/004_image_time_semantics.py`
  `backend/migrations/_schema_common.py`
  `backend/database.py`
  `backend/image_manager.py`
  `backend/routers/images.py`
  `backend/tests/test_database.py`
  `backend/tests/test_image_manager.py`
  `backend/tests/test_routers/test_images.py`
  `backend/tests/test_routers/test_sorting.py`
- Supersedes:
  The older implicit assumption recorded in debt notes that `created_at` still carried mixed live semantics.
- Validation:
  `backend/tests/test_database.py`, `backend/tests/test_image_manager.py`, `backend/tests/test_routers/test_images.py`, and `backend/tests/test_routers/test_sorting.py` pass with the new split semantics.

### ADR-AI-20260427-05: Truthful UI and runtime reporting is a product rule
- Status: active
- Area: UX semantics / runtime reporting
- Evidence tier: Tier 1
- Decision:
  User-facing status, warnings, and capability descriptions should report real behavior, real limitations, and actual runtime state, even when that is less flattering than a smoother-looking generic message.
- Why:
  Release history repeatedly fixed misleading UX: Reader clipboard metadata safety, tagger runtime fallback visibility, model capability wording, progress detail for skipped/unreadable/failed states, and JPG/WebP metadata honesty. This is not random polish; it is a recurring product stance.
- Do not "improve" this by:
  Hiding fallback state, overclaiming metadata preservation, implying unsupported model capabilities, or collapsing detailed failure states into vague "done/failed" language.
- Allowed evolution:
  Better wording, cleaner presentation, and stronger docs are welcome as long as they stay honest about actual behavior.
- Evidence:
  Current release notes, changelog entries, and code paths repeatedly encode truthful-runtime and truthful-limitation messaging across Reader, Tagger, Similarity, and Censor flows.
- Last verified:
  2026-04-27 against current docs, code, and existing release history.
- Related files:
  `frontend/js/image-reader.js`
  `frontend/js/app.js`
  `frontend/js/censor-edit.js`
  `backend/model_health.py`
  `backend/routers/models.py`
  `backend/routers/images.py`
  `backend/routers/tags.py`
- Supersedes:
  Any "looks successful enough" presentation that hides real limitations or runtime fallback.
- Validation:
  Release notes, progress docs, and multiple regression/E2E validations around truthful runtime/status reporting.

### ADR-AI-20260427-06: Reader clipboard import is intentionally treated as a lossy browser path
- Status: active
- Area: Reader workflow / metadata semantics
- Evidence tier: Tier 1
- Decision:
  Original-file access paths remain the metadata-safe Reader flow. Clipboard/browser paths are intentionally treated as potentially lossy and must warn accordingly.
- Why:
  Browser clipboard handling does not guarantee preservation of SD PNG metadata. Past versions looked like successful parses even when metadata had already been dropped, which misled users.
- Do not "improve" this by:
  Pretending clipboard import is equivalent to original-file loading, suppressing metadata-loss warnings, or reintroducing API/UI wording that implies metadata safety where the browser cannot guarantee it.
- Allowed evolution:
  Better warnings, better follow-up save behavior, or clearer distinction between source-file and browser-upload paths.
- Evidence:
  Current Reader UI, release notes, and architecture docs all distinguish original-file paths from lossy browser clipboard/import paths.
- Last verified:
  2026-04-27 against current Reader code and cited release/docs history.
- Related files:
  `frontend/js/image-reader.js`
  `backend/routers/images.py`
  `backend/services/image_service.py`
  `README.md`
- Supersedes:
  Older UI semantics that made clipboard import look metadata-safe.
- Validation:
  Browser validation and release review notes for Reader clipboard behavior.

### ADR-AI-20260427-07: Unreadable images are quarantined from normal workflows
- Status: active
- Area: library health / workflow gating
- Evidence tier: Tier 1
- Decision:
  Corrupt, truncated, missing, or otherwise unreadable images should be marked as such and excluded from normal scan/sort/tag/similarity flows by default.
- Why:
  Letting broken rows keep participating as if they were healthy creates cascading bugs, fake successes, stale embeddings, and user confusion.
- Do not "improve" this by:
  Silently letting unreadable files flow through normal operations just because the path still exists, or by reusing stale derived data from previously readable states.
- Allowed evolution:
  Better visibility, repair actions, rescan tools, or richer diagnostics for unreadable rows.
- Evidence:
  Current code, release notes, and regression coverage all treat unreadable-image quarantine as deliberate product behavior.
- Last verified:
  2026-04-27 against current workspace code and referenced release/test material.
- Related files:
  `backend/image_manager.py`
  `backend/database.py`
  `backend/services/sorting_service.py`
  `backend/services/tagging_service.py`
  `backend/similarity.py`
- Supersedes:
  Older behavior where existence-on-disk was treated as enough for continued participation.
- Validation:
  Scan, sorting, similarity, and image-manager regression coverage.

### ADR-AI-20260427-08: Large-library workflows must not be weakened by convenience limits
- Status: active
- Area: scale / performance / product direction
- Evidence tier: Tier 1 + Tier 2
- Decision:
  Safety and performance changes must preserve viability for very large SD libraries. Limits should be scoped to one risky request or one risky operation, not used as a shortcut to reduce product capability.
- Why:
  Historical release design explicitly targets power users with 1TB / 100k-image libraries. The repo repeatedly rejected "small arbitrary limits" and "fake fixes" that only make demos look cleaner.
- Do not "improve" this by:
  Quietly capping library usage, skipping metadata extraction to look faster, inflating progress with inaccurate totals, or replacing precomputed fast paths with slow brute-force fallbacks.
- Allowed evolution:
  Streaming, paging, bounded work, early library usability, cache improvements, and scoped safety guards that do not weaken real workflows.
- Evidence:
  Current scan and similarity direction in code/release notes aligns with hardening-spec language that explicitly protects large-library workflows.
- Last verified:
  2026-04-27 against current workspace behavior, release history, and hardening design notes.
- Related files:
  `backend/image_manager.py`
  `backend/services/sorting_service.py`
  `backend/services/similarity_service.py`
  `backend/routers/images.py`
  `frontend/js/app.js`
- Supersedes:
  Any future temptation to solve performance by shrinking supported workflow scale.
- Validation:
  Release-hardening design rules, scan validation, and large-library oriented release notes.

### ADR-AI-20260427-09: Long scans should become usable earlier instead of blocking on total completeness
- Status: active
- Area: scan/import UX
- Evidence tier: Tier 1
- Decision:
  For long scans, the product direction is to expose a usable library earlier and continue remaining metadata work in the background, with clear user-facing status.
- Why:
  Users with large libraries care more about "the app is usable and clearly still working" than about waiting for every last metadata field before anything appears.
- Do not "improve" this by:
  Reverting to all-or-nothing scan blocking, or by faking completeness while hidden work continues without explanation.
- Allowed evolution:
  Better background progress, more honest staging, faster placeholder import, and safer metadata backfill.
- Evidence:
  Current release notes and scan-progress work explicitly frame early library usability and background continuation as intended behavior.
- Last verified:
  2026-04-27 against current release notes, progress docs, and scan code direction.
- Related files:
  `backend/image_manager.py`
  `frontend/js/app.js`
  `backend/services/sorting_service.py`
- Supersedes:
  Older scan behavior that made users wait too long before anything felt available.
- Validation:
  v3.1.0 scan/browser validation and regression notes.

### ADR-AI-20260427-10: Service-layer architecture is intentional; do not dump new business rules back into routers
- Status: active
- Area: backend architecture
- Evidence tier: Tier 1
- Decision:
  The backend's service-layer direction is intentional. Routers should stay as API/domain entry points, while substantial workflow logic belongs in services or shared backend modules.
- Why:
  The project explicitly moved toward service-layer architecture in v2.0.0 and current architecture docs still describe services as the business-logic layer. Reversing that direction makes cross-feature consistency and testing worse.
- Do not "improve" this by:
  Shoving new workflow logic directly into routers just because it is faster in one patch, unless the change is truly trivial glue code.
- Allowed evolution:
  Extract more shared logic out of routers, improve service boundaries, and document invariants more clearly.
- Evidence:
  Current backend structure and historical release docs consistently describe routers as thin entry points over a service layer.
- Last verified:
  2026-04-27 against current repo structure and architecture docs.
- Related files:
  `backend/services/`
  `backend/routers/`
  `docs/architecture.md`
- Supersedes:
  None
- Validation:
  Current repo architecture and historical release documentation.

### ADR-AI-20260427-11: Local-first / local-only is a real product assumption
- Status: active
- Area: product shape / security context / UX expectations
- Evidence tier: Tier 1
- Decision:
  Treat this app as a local-first, local-only tool unless the user explicitly changes product direction.
- Why:
  The README, API docs, and security docs all frame the product around "your images stay on your machine" and local execution without accounts or cloud upload. Many current tradeoffs, warnings, and security assumptions depend on that product shape.
- Do not "improve" this by:
  Sneaking in cloud-centric assumptions, account/login requirements, remote dependency for core workflows, or security/UX changes that only make sense if the app is network-exposed by default.
- Allowed evolution:
  Better documentation, optional remote integrations clearly marked as optional, and explicit product decisions if the app ever grows beyond local-only use.
- Evidence:
  Current product docs and security/architecture docs all treat local-only operation as the default product contract.
- Last verified:
  2026-04-27 against current README, API docs, and security architecture docs.
- Related files:
  `README.md`
  `docs/API.md`
  `docs/SECURITY_ARCHITECTURE.md`
  `backend/main.py`
- Supersedes:
  None
- Validation:
  Current product documentation and architecture/security assumptions.

### ADR-AI-20260427-12: Automatic hardware clamps are the real tagger GPU semantics
- Status: active
- Area: tagging workflow / hardware safety / runtime UX
- Evidence tier: Tier 1
- Decision:
  GPU tagging runs should start directly under automatic hardware safety limits. A separate "are you sure you want GPU?" confirmation step is not part of the intended product behavior.
- Why:
  The repo explicitly removed the old confirmation-modal semantics because safety is now enforced by runtime VRAM/RAM clamps, session refresh, and truthful runtime reporting. Reintroducing a launch confirm would make the UX less truthful without adding real protection.
- Do not "improve" this by:
  Bringing back a GPU start confirmation modal, defaulting `allow_unsafe_acceleration` to true, or hiding target-vs-actual runtime fallback state.
- Allowed evolution:
  Better hardware summaries, clearer runtime fallback wording, more telemetry, and better model-specific guidance.
- Evidence:
  Current Tagger code defaults unsafe acceleration off; release notes and smoke tests explicitly confirm there is no separate GPU confirm modal.
- Last verified:
  2026-04-27 against current tagger code, release notes, and smoke/E2E coverage.
- Related files:
  `frontend/js/app.js`
  `backend/routers/tags.py`
  `backend/services/tagging_service.py`
  `tests/e2e/specs/smoke.spec.ts`
- Supersedes:
  Older launch-time GPU confirmation semantics.
- Validation:
  Current smoke/E2E assertions verify GPU start paths do not show the confirm modal and keep unsafe acceleration disabled.

### ADR-AI-20260427-13: Auto-Separate and Manual Sort keep explicit saved scopes; Gallery is not a live binding
- Status: active
- Area: sorting workflow / scope semantics
- Evidence tier: Tier 1 + Tier 2
- Decision:
  Auto-Separate and Manual Sort maintain their own saved filter scopes. Gallery filters may be copied in on first use or explicit resync, but later Gallery changes must not silently retarget these workflows.
- Why:
  These tools can move or copy large sets of files. Silent scope drift after the user has already configured a workflow is dangerous and breaks predictability. The current UI deliberately surfaces saved scope, sync time, mismatch, and resync actions.
- Do not "improve" this by:
  Making these workflows live-bind to Gallery filters, silently overwriting saved scope on each open, or hiding the saved-vs-live mismatch state because it looks simpler.
- Allowed evolution:
  Clearer scope badges, better previews, named scope presets, or better sync controls.
- Evidence:
  Current UI and JS state logic implement saved-vs-resynced scope behavior, and the hardening design explicitly preserves isolated task filter scopes.
- Last verified:
  2026-04-27 against current UI code, scope-state logic, and referenced design/test notes.
- Related files:
  `frontend/index.html`
  `frontend/js/autosep.js`
  `frontend/js/manual-sort.js`
  `tests/e2e/specs/manual-regression.spec.ts`
  `tests/e2e/specs/smoke.spec.ts`
- Supersedes:
  Any older assumption that sorting sub-tools should always mirror the current Gallery filters automatically.
- Validation:
  Current UI copy, scope-status logic, and regression/E2E coverage around saved scope and explicit resync behavior.

### ADR-AI-20260427-14: Destructive file actions should confirm before execution; backend conflicts are the fallback, not the primary UX
- Status: active
- Area: destructive workflow safety / overwrite UX
- Evidence tier: Tier 1 + Tier 2
- Decision:
  When the client can predict a destructive or side-effecting action in advance, it should confirm first with the user. Backend `409` / validation responses remain the safety net, not the main confirmation flow.
- Why:
  This repo repeatedly fixed "fail first, then ask" or "just do it" behavior around moving files and overwriting outputs. Predictable destructive actions should disclose action mode, target path, and relevant scope before side effects begin.
- Do not "improve" this by:
  Sending the destructive request first and using the first backend conflict as pseudo-confirmation, auto-running move/copy workflows without confirmation, or hiding target/scope details to keep the modal shorter.
- Allowed evolution:
  Richer previews, better confirmation wording, per-item overwrite choices, or clearer dry-run summaries.
- Evidence:
  Current Reader, Manual Sort, and Auto-Separate flows confirm before destructive actions; release work and tests explicitly checked this.
- Last verified:
  2026-04-27 against current UI code, Reader live tests, sorting regressions, and release-progress notes.
- Related files:
  `frontend/js/manual-sort.js`
  `frontend/js/autosep.js`
  `frontend/js/image-reader.js`
  `tests/e2e/specs/manual-regression.spec.ts`
  `tests/e2e/specs/reader-live.spec.ts`
- Supersedes:
  Older fail-then-confirm UX around same-path overwrite, plus any assumption that file-moving workflows can start without an explicit preflight confirmation.
- Validation:
  Reader live tests assert overwrite confirmation appears before any `409`, and sorting regressions assert move/copy execution shows confirmation modals first.

### ADR-AI-20260427-15: UI should stay desktop-first, compact, bilingual, and feature-retentive
- Status: active
- Area: frontend UX / layout policy / feature surface
- Evidence tier: explicit user instruction
- Decision:
  Optimize the UI primarily for desktop/laptop usage in English and `zh-CN`, keep functional controls more prominent than explanatory text, use progressive disclosure for secondary settings/help, and do not remove existing features without explicit approval.
- Why:
  This product is a computer tool for real workflows, not a mobile-first marketing page. Users need dense but understandable controls, strong bilingual layout behavior, and retained capability. A cleaner-looking UI that hides or deletes power features is the wrong direction for this repo.
- Do not "improve" this by:
  Rebuilding screens around mobile-first assumptions, letting long English labels break layouts, replacing usable controls with oversized explanation blocks, or removing existing features just to simplify a screen.
- Allowed evolution:
  Better grouping, better iconography, more compact dialogs, clearer advanced/basic separation, and safer relocation of secondary controls.
- Evidence:
  Explicit user instruction in the current task on 2026-04-27.
- Last verified:
  2026-04-27 from current task instructions and aligned principle updates.
- Related files:
  `frontend/index.html`
  `frontend/css/styles.css`
  `frontend/css/censor-v2.css`
  `frontend/js/app.js`
  `frontend/js/censor-edit.js`
  `frontend/js/manual-sort.js`
  `frontend/js/autosep.js`
- Supersedes:
  None
- Validation:
  Future UI work should be checked against desktop small-screen behavior, bilingual layout stability, icon accessibility, and feature retention.

### ADR-AI-20260427-16: In-app updates must never manage package-local user data or updater runtime state
- Status: active
- Area: release / updater safety / package-local data
- Evidence tier: explicit user instruction + Tier 1
- Decision:
  The in-app updater may replace only release-managed application files. It must never overwrite or delete `data/` or updater runtime folders such as `update/downloads`, `update/logs`, `update/state`, `update/worker`, and `update/backups`.
- Why:
  This product ships as a self-contained package that users keep in one folder. Their database, favorites, downloaded models, caches, thumbnails, and update working state all live inside that package. One-click updates are only acceptable if they preserve that state by design, not by luck.
- Do not "improve" this by:
  Turning the updater into a full reinstall, broadening manifests to include runtime folders, or trusting packaging alone to keep user data safe.
- Allowed evolution:
  Add stronger validation, better logs, more recovery tooling, or richer release-channel support, but keep the rule that runtime state is outside updater ownership.
- Evidence:
  Current update-service/update-worker code, release-pack docs, and updater regression tests explicitly protect package-local runtime and user-data paths.
- Last verified:
  2026-04-27 against current workspace updater code and tests.
- Related files:
  `backend/update_worker.py`
  `backend/services/update_service.py`
  `scripts/build_release_packages.py`
  `docs/RELEASE_PACKS.md`
- Supersedes:
  Any implicit assumption that a full-package fallback may safely overwrite the whole extracted folder tree.
- Validation:
  `backend/tests/test_update_worker.py` protected-path regression coverage plus release-build manifest exclusion tests.

### ADR-AI-20260427-17: Update checks are manual, GitHub-default, and advanced-channel override is opt-in
- Status: active
- Area: update UX / release channel semantics
- Evidence tier: explicit user instruction + Tier 1
- Decision:
  The app should only check for updates when the user clicks the update button. It should not auto-check on startup and should not auto-apply updates without explicit confirmation. The default update channel remains GitHub Releases, while custom channel/proxy settings are an advanced opt-in path for advanced users and fork maintainers.
- Why:
  The intended product behavior is "one-click when I choose" rather than background updater behavior. Ordinary users should not be forced into channel/proxy setup just because GitHub can be blocked in some regions. At the same time, advanced users still need a supported override path.
- Do not "improve" this by:
  Adding startup auto-checks, silent background updates, mandatory proxy/channel setup UI for everyone, or replacing honest GitHub/VPN guidance with a fake built-in default mirror story.
- Allowed evolution:
  Clearer update status UI, better channel diagnostics, better wording around VPN/channel override, and more advanced override options behind an explicitly advanced path.
- Evidence:
  Current frontend only checks when the update buttons are clicked; current README and release-pack docs tell ordinary users to use the update button and enable VPN if GitHub is unreachable; current backend keeps custom channel override available through config instead of forcing it into the normal user flow.
- Last verified:
  2026-04-27 against current frontend update flow, updater service behavior, README, and release-pack docs.
- Related files:
  `frontend/js/app.js`
  `backend/services/update_service.py`
  `backend/routers/updates.py`
  `README.md`
  `docs/RELEASE_PACKS.md`
  `backend/tests/test_update_service.py`
- Supersedes:
  None
- Validation:
  `backend/tests/test_update_service.py`, `backend/tests/test_routers/test_updates.py`, unsafe archive-entry validation tests, and current click-triggered frontend update flow.

### ADR-AI-20260427-18: LoRA library filtering uses exact normalized names, not substring search
- Status: active
- Area: filter semantics / metadata assets
- Evidence tier: Tier 1
- Decision:
  Filtering by selected LoRAs should match the normalized LoRA name exactly after stripping path, extension, and weight syntax. It should not use substring matching such as `%girl%`.
- Why:
  LoRA names are identity-like asset names. Substring matching makes common short names dangerous: `girl` can match `school_girl`, and `detail` can match unrelated `add_detail` variants. The `image_loras` junction table exists to make normalized asset-name matching explicit and indexable.
- Do not "improve" this by:
  Replacing exact `image_loras.lora_name = ?` filtering with broad `LIKE` search for selected LoRA filters. If fuzzy LoRA discovery is needed, add a separate search/discovery mode instead of changing the filter contract.
- Allowed evolution:
  Add aliases, explicit fuzzy search UI, or richer LoRA asset metadata, but keep selected-filter execution exact unless the UI clearly says otherwise.
- Evidence:
  Current `backend/database.py` normalizes LoRA names with `normalize_lora_name()` and filters against `image_loras` by exact lowercase normalized name.
- Last verified:
  2026-04-27 against current database filter implementation and regression tests.
- Related files:
  `backend/database.py`
  `backend/tests/test_database.py`
  `frontend/js/gallery.js`
- Supersedes:
  The previous substring `LIKE` implementation in `_apply_lora_filter()`.
- Validation:
  `backend/tests/test_database.py` covers exact LoRA filters for both stored LoRA arrays and inline `<lora:name:weight>` prompt tags.

### ADR-AI-20260427-20: Stale scan placeholder rows are quarantined on startup instead of silently staying pending
- Status: active
- Area: scan lifecycle / data recovery
- Evidence tier: Tier 1
- Decision:
  Any `images.metadata_status = "pending"` row that survives into a fresh app startup is treated as a stale interrupted-scan placeholder. Startup repair must convert it into a recoverable `error` / unreadable row instead of leaving it in a forever-pending readable state.
- Why:
  Once the process is gone, there is no in-flight metadata worker left that can finish that placeholder. Leaving it pending creates a blind spot for derived-state invalidation and misreports library health. Quarantining it is more truthful, while keeping its recoverable fingerprint/derived data lets a later rescan restore the row safely if the source file did not actually change.
- Do not "improve" this by:
  Auto-marking stale pending rows as `complete`, silently leaving them readable forever, or pretending a later background worker still exists when the scan already died.
- Allowed evolution:
  Add richer repair UI, startup diagnostics, or explicit rescan helpers, but keep the rule that stale pending placeholders are no longer considered healthy rows after restart.
- Evidence:
  Current `database.init_db()` now repairs stale pending rows on startup, and scan logic already reparses non-`complete` rows on the next truthful rescan.
- Last verified:
  2026-04-27 against current startup repair code and regression coverage.
- Related files:
  `backend/database.py`
  `backend/image_manager.py`
  `backend/tests/test_database.py`
- Supersedes:
  The accidental old behavior where interrupted placeholder rows could remain `pending` indefinitely.
- Validation:
  `backend/tests/test_database.py::test_init_quarantines_stale_pending_rows_without_erasing_recoverable_derived_state`

### ADR-AI-20260427-21: Release bootstrap and update downloads should use checksum validation when the repo controls the artifact channel
- Status: active
- Area: release / updater integrity
- Evidence tier: Tier 1
- Decision:
  External runtime/bootstrap downloads used by release packaging must be pinned by SHA-256, and release-built update assets should expose a checksum manifest so the in-app updater can validate archives when that manifest is present.
- Why:
  Size-only validation is not enough for bootstrap Python, `get-pip.py`, or shipped update archives. This repo already controls the release-builder output, so it should use that control to make drift and tampering fail loudly instead of silently succeeding.
- Do not "improve" this by:
  Reverting to naked `urlretrieve()` downloads, keeping updater validation at size-only when a checksum manifest exists, or treating checksum assets as optional decoration with no enforcement path.
- Allowed evolution:
  Stronger signing, detached signatures, or richer manifest metadata are welcome later, but the baseline checksum guard should stay in place.
- Evidence:
  `scripts/build_release_packages.py` now pins Python embed / `get-pip.py` downloads by SHA-256 and emits a release-manifest asset; `backend/services/update_service.py` can now consume that manifest to validate downloaded archives.
- Last verified:
  2026-04-27 against current release-builder code, updater code, and regression coverage.
- Related files:
  `scripts/build_release_packages.py`
  `backend/services/update_service.py`
  `backend/tests/test_release_build.py`
  `backend/tests/test_update_service.py`
- Supersedes:
  The older size-only / trust-the-URL release bootstrap behavior.
- Validation:
  `backend/tests/test_release_build.py` checksum tests and `backend/tests/test_update_service.py` manifest/checksum download tests.

### ADR-AI-20260428-22: Cross-generator checkpoint filters must use `checkpoint_normalized`, while raw `checkpoint` stays display-only
- Status: active
- Area: metadata asset semantics / gallery filters / prompt stats
- Evidence tier: Tier 1
- Decision:
  Image rows now persist both raw `checkpoint` and derived `checkpoint_normalized`. Raw `checkpoint` remains the per-image display value, while gallery filters, analytics facets, free-text checkpoint search, and prompt-stat checkpoint grouping must compare on `checkpoint_normalized`.
- Why:
  Different generators report the same model in incompatible forms: path prefixes, file extensions, and WebUI-style hash suffixes such as `model.safetensors [abc12345]`. Using raw `checkpoint` as both display text and identity key fragments one logical model into multiple silent filter buckets. Splitting display from identity fixes the contract without hiding the original metadata string.
- Do not "improve" this by:
  Going back to raw `checkpoint` equality for filters/facets, dropping the raw field from image payloads, or broadening checkpoint matching into fuzzy substring behavior that makes one model accidentally match another.
- Allowed evolution:
  Add richer checkpoint display labels, alias tables, or generator-specific normalization rules later, but keep the rule that cross-generator filter/search/facet semantics use the normalized key.
- Evidence:
  The schema now includes `images.checkpoint_normalized`; DB writes backfill and maintain it; gallery/image payloads expose both raw and normalized checkpoint fields; analytics and prompt stats group by `checkpoint_normalized`; checkpoint search and filter queries now compare on the normalized field.
- Last verified:
  2026-04-28 against current workspace code plus targeted backend regression coverage.
- Related files:
  `backend/utils/model_names.py`
  `backend/migrations/005_checkpoint_normalization.py`
  `backend/database.py`
  `backend/services/sorting_service.py`
  `backend/routers/prompts.py`
  `backend/routers/images.py`
  `backend/tests/test_database.py`
  `backend/tests/test_routers/test_images.py`
  `backend/tests/test_routers/test_sorting.py`
  `backend/tests/test_routers/test_prompts_censor_similarity_artists.py`
  `frontend/js/app.js`
  `frontend/js/gallery.js`
- Supersedes:
  The old implicit behavior where raw mixed generator checkpoint strings also doubled as the filter/facet identity key.
- Validation:
  `backend/tests/test_database.py`, `backend/tests/test_routers/test_images.py`, `backend/tests/test_routers/test_sorting.py`, and `backend/tests/test_routers/test_prompts_censor_similarity_artists.py` all pass with the new contract.

### ADR-AI-20260428-23: Manual Sort session persistence belongs to package-local runtime state (`data/state`), with legacy-path migration
- Status: active
- Area: runtime state / sorting session persistence
- Evidence tier: Tier 1
- Decision:
  Persist Manual Sort session payloads at `data/state/sort-session.json` by default (`SD_IMAGE_SORTER_SORT_SESSION_FILE` override supported). On startup, still read legacy `backend/sort_session.json` if present, then migrate to the new runtime path.
- Why:
  Session persistence is runtime/user state, not source-code-adjacent app code. Keeping it under `backend/` made release/update ownership blurry and depended on packaging exclusions instead of runtime-boundary contract.
- Do not "improve" this by:
  Moving session persistence back beside backend source files, or dropping legacy-path compatibility immediately.
- Allowed evolution:
  Move to richer session schema/versioning, add multi-session support, or relocate state under a new runtime directory as long as runtime ownership and migration behavior remain explicit.
- Evidence:
  Sorting service now writes to the config-driven runtime state path and keeps compatibility load/migration logic for legacy persisted sessions.
- Last verified:
  2026-04-28 against current sorting service and config behavior.
- Related files:
  `backend/config.py`
  `backend/services/sorting_service.py`
  `backend/update_worker.py`
  `scripts/build_release_packages.py`
- Supersedes:
  The older implicit behavior that persisted session state under `backend/sort_session.json`.
- Validation:
  Targeted sorting-session restore tests and runtime-path verification in current workspace.

### ADR-AI-20260428-24: Release builder and detached updater must share manifest/runtime-protection constants
- Status: active
- Area: release/update operability contract
- Evidence tier: Tier 1
- Decision:
  Packaging and updater flows must reuse the same manifest relative paths and runtime-protected prefix definitions, instead of duplicating string literals in separate modules.
- Why:
  Copy-maintained constants drift silently and only explode during publish/update. The detached worker is the enforcement boundary; the builder should derive its exclusions and manifest naming from that same contract.
- Do not "improve" this by:
  Reintroducing hardcoded `update/package-manifest.json` / `update/installed-manifest.json` string copies in the release builder, or bypassing updater-owned runtime protection prefixes in packaging logic.
- Allowed evolution:
  Move this contract to a dedicated shared module later, as long as builder/updater continue to share one source of truth.
- Evidence:
  `scripts/build_release_packages.py` now imports manifest/runtime-protection constants from `backend/update_worker.py` and uses them for skip and manifest generation paths.
- Last verified:
  2026-04-28 against current release-builder and updater code.
- Related files:
  `scripts/build_release_packages.py`
  `backend/update_worker.py`
  `backend/tests/test_release_build.py`
  `backend/tests/test_update_worker.py`
- Supersedes:
  Prior duplicated manifest/runtime protection literals across builder and updater.
- Validation:
  Release-builder and updater unit tests in current workspace.

### ADR-AI-20260428-25: `/api/images` cursor pagination is an opaque API contract, not an image-ID contract
- Status: active
- Area: API contract / pagination invariants
- Evidence tier: Tier 1
- Decision:
  `GET /api/images` must expose `next_cursor` as an opaque token that clients pass back unchanged. Backend pagination may still accept legacy integer image IDs for backward compatibility, but frontend and external callers must not parse, synthesize, or rely on cursor internals.
- Why:
  Treating `cursor` as a bare image ID made pagination fragile when the anchor row disappeared between requests. The stable contract is the `(sort_value, id)` boundary encoded into the cursor token; that lets newest/oldest pagination continue even after deletes while keeping clients decoupled from storage details.
- Do not "improve" this by:
  Switching frontend code or docs back to integer cursor assumptions, regenerating cursor strings on the client, or downgrading service-layer parsing to `int(cursor)`.
- Allowed evolution:
  Change cursor token schema/version later, provided the token remains opaque to clients and legacy integer acceptance is retired only with an explicit compatibility decision.
- Evidence:
  Shared cursor helpers now live in `backend/utils/pagination_cursor.py`; image service decodes API cursors before calling the DB layer; DB pagination uses stored sort boundaries when available; router/API docs describe the token as opaque; regressions cover malformed tokens, deleted anchor rows, and frontend passthrough behavior.
- Last verified:
  2026-04-28 against current workspace code plus targeted backend and Playwright regression coverage.
- Related files:
  `backend/utils/pagination_cursor.py`
  `backend/services/image_service.py`
  `backend/database.py`
  `backend/routers/images.py`
  `backend/db_repos/repositories/base.py`
  `backend/db_repos/repositories/image_repo.py`
  `docs/API.md`
  `backend/tests/test_database.py`
  `backend/tests/test_api_errors.py`
  `backend/tests/test_routers/test_images.py`
  `tests/e2e/specs/smoke.spec.ts`
- Supersedes:
  The older implicit contract where `cursor` / `next_cursor` were treated as raw image IDs.
- Validation:
  Targeted pagination regression tests in `backend/tests/test_database.py`, `backend/tests/test_api_errors.py`, `backend/tests/test_routers/test_images.py`, and `tests/e2e/specs/smoke.spec.ts`.

### ADR-AI-20260428-26: Tag import writes must reuse the shared tag writer contract
- Status: active
- Area: derived-state invariants / tag import semantics
- Evidence tier: Tier 1
- Decision:
  Any feature that writes final tags into the library, including JSON tag import flows, must route through the shared DB tag-writer contract (`db.add_tags()` / `db.add_tags_batch()`) instead of hand-writing tag SQL in the caller.
- Why:
  The shared tag writer owns more than `tags` rows. It also owns `tagged_at`, tag-cache invalidation, and `content_fingerprint` backfill needed to keep derived-state invalidation rules consistent with scan/tag/save flows. When import logic writes tags directly, the system stops having one owner for those invariants.
- Do not "improve" this by:
  Reintroducing per-feature `DELETE FROM tags` / `INSERT` / `UPDATE images SET tagged_at ...` SQL in import/export/service code, or by treating tag import as a harmless special case because it is "just data restore."
- Allowed evolution:
  Move the shared writer behind a repository/service abstraction later, provided tag import still reuses one canonical write path and payload normalization stays outside the DB helper.
- Evidence:
  `TaggingService.import_tags()` now normalizes duplicate tag payloads and delegates the final write to `db.add_tags_batch()` instead of maintaining its own tag/`tagged_at` SQL path.
- Last verified:
  2026-04-28 against current workspace code and targeted backend regression coverage.
- Related files:
  `backend/services/tagging_service.py`
  `backend/database.py`
  `backend/tests/test_tagging_service.py`
  `backend/tests/test_database.py`
  `backend/tests/test_routers/test_tags.py`
- Supersedes:
  The older implicit behavior where import-tag writes were allowed to bypass the shared tag writer as long as the endpoint appeared to work.
- Validation:
  Targeted import-tag regressions in `backend/tests/test_tagging_service.py`, `backend/tests/test_database.py`, and `backend/tests/test_routers/test_tags.py`.

### ADR-AI-20260428-27: Reader overwrite confirmation and gallery refresh must use canonical pre-save library identity
- Status: active
- Area: reader save semantics / indexed-path UX contract
- Evidence tier: Tier 1
- Decision:
  Reader metadata-save overwrite checks must compare the requested output path against the canonical original source path when one exists, not against the upload temp path. After save succeeds, gallery refresh intent must be decided against the pre-save indexed source identity (plus currently loaded gallery image paths), not against the post-save path after Reader retargets itself to the new output file.
- Why:
  Reader uploads can have both a browser temp path and an original indexed library path. The temp path is not the library identity users care about for overwrite confirmation. Separately, once save succeeds Reader intentionally retargets its current source to the saved file; if refresh logic compares against that new path, every save starts looking like an indexed overwrite and causes unnecessary gallery reloads.
- Do not "improve" this by:
  Falling back to temp-upload-path overwrite checks when a canonical original path is known, or by moving the refresh comparison after Reader has already overwritten its source identity with the saved output path.
- Allowed evolution:
  Move this decision into a more explicit Reader save-state model later, as long as overwrite confirmation remains based on canonical original identity and gallery refresh stays limited to real indexed-path overwrites.
- Evidence:
  Reader now uses `_getCanonicalSourcePathForOverwrite()` for client-side overwrite confirmation and `_markGalleryRefreshForIndexedOverwrite(savedOutputPath, previousOriginalSourcePath)` to preserve the pre-save comparison identity while still retargeting Reader to the saved file afterward.
- Last verified:
  2026-04-28 against current workspace code plus targeted Playwright smoke coverage.
- Related files:
  `frontend/js/image-reader.js`
  `tests/e2e/specs/smoke.spec.ts`
- Supersedes:
  The older implicit behavior where Reader overwrite checks could compare against temp upload paths and gallery refresh intent could drift with post-save state mutation.
- Validation:
  Targeted Reader save-path smoke coverage in `tests/e2e/specs/smoke.spec.ts`, including indexed overwrite confirmation and save-as-new non-refresh behavior.
