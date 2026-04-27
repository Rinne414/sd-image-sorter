# AI Decision Log

**Updated:** 2026-04-27
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
