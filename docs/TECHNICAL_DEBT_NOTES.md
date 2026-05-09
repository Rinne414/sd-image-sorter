# SD Image Sorter - Technical Debt Notes

**Updated:** 2026-05-04
**Purpose:** Record confirmed structural debt found during recent stability fixes, and provide a reusable prompt for deeper whole-repo debt audits.

## Scope

This file is not a full architecture review.

It records:

- debt that was directly observed while fixing real user-facing bugs
- debt that is not an immediate blocker today, but is likely to produce the same class of bugs again
- audit targets worth validating across the whole repo
- a prompt for another AI to audit debt across the whole software, not just the move/copy/save flows

## Debt Entry Format

Use this structure for future confirmed-debt entries:

### Debt-XX: Short Title
- Status: open / mitigated / partially mitigated / closed
- Type: data model / architecture / state / UX contract / performance / operability / docs / release / etc.
- Impact: critical / high / medium / low
- Risk if ignored:
- Related files:
- Observed problem:
- Why this is debt:
- Better long-term shape:
- Revisit trigger:
- Deferred because:

## Confirmed Debt From Recent Fixes

### Debt-01: `created_at` field has mixed semantics
- Status: mitigated
- Type: data model debt
- Impact: high
- Risk if ignored:
  Future work can still regress if contributors keep treating the deprecated `created_at` alias like a true file-time field instead of migrating to the explicit split fields.
- Related files:
  `backend/database.py`
  `backend/image_manager.py`
  `backend/services/sorting_service.py`
  `backend/routers/images.py`
- Observed problem:
  The field name originally read like "image creation time", but the product relied on it as a stable library ordering key.
- Why this is debt:
  The primary semantic ambiguity is now fixed in schema and ordering logic, but the deprecated alias can still mislead future callers if they skip the new fields.
- Better long-term shape:
  Keep using `library_order_time` for stable chronology and `source_file_mtime` for current file time, then remove `created_at` once compatibility callers are gone.
- Revisit trigger:
  Revisit before removing the compatibility alias or introducing user-facing file-time/timeline features.
- Deferred because:
  The split is shipped, but the compatibility alias remains intentionally until all callers and docs stop depending on `created_at`.

### Debt-02: Derived-state invalidation rules are cross-cutting and easy to miss
- Status: partially mitigated
- Type: consistency debt
- Impact: high
- Risk if ignored:
  One new save/import/edit path can bypass the invariant and leave stale tags, embeddings, captions, scores, or artist predictions behind.
- Related files:
  `backend/database.py`
  `backend/image_manager.py`
  `backend/image_fingerprint.py`
  `backend/services/image_service.py`
  `backend/services/censor_service.py`
  `backend/services/tagging_service.py`
  `backend/similarity.py`
  `backend/services/aesthetic_service.py`
  `backend/services/artist_service.py`
  `backend/services/derived_state_service.py`
- Observed problem:
  The app stores derived data such as tags, embeddings, AI captions, aesthetic scores, and artist predictions. Whether these should be cleared depends on whether pixel content really changed.
  Recent fixes confirmed that non-scan entry points can still bypass shared derived-state helpers: `TaggingService.import_tags()` had drifted into hand-written tag SQL before being pulled back onto `db.add_tags_batch()`. A 2026-04-28 hardening pass moved similarity / aesthetic / artist feature-local fingerprint writes behind `backend/services/derived_state_service.py`, but DB-owned scan/tag/copy/metadata writes still remain in `database.py`.
- Why this is debt:
  This is a system invariant, but historically it was enforced by scattered entry-point behavior. The same bug family can come back through a different route.
  The highest-risk feature-local writers are now behind a shared helper, but the remaining DB-owned writes still make the content-change policy too broad and easy to alter accidentally.
- Better long-term shape:
  Define one canonical "content changed" policy, route all mutation flows through it, and move the remaining DB-owned writer/invalidation split behind a lower-level shared module that does not create service/database circular imports.
- Revisit trigger:
  Revisit before adding any new save/export/edit path, scan lifecycle change, or external-file reconciliation path.
- Deferred because:
  The mitigation (`content_fingerprint`) exists, feature-local derived writes are now guarded, but full consolidation still needs a lower-level DB-safe owner for scan/tag/copy/metadata invalidation.

### Debt-03: Indexed-path overwrite refresh is still entry-point dependent
- Status: partially mitigated
- Type: lifecycle debt
- Impact: high
- Risk if ignored:
  A future feature can overwrite an indexed file successfully on disk but leave stale DB metadata and stale UI state because the author forgot the library-reconcile step or forgets to expose explicit overwrite intent.
- Related files:
  `backend/services/image_service.py`
  `backend/services/censor_service.py`
  `backend/image_manager.py`
  `backend/database.py`
  `frontend/js/image-reader.js`
  `frontend/js/censor-edit.js`
- Observed problem:
  If a feature saves over a file path that is already indexed in the library, the library row must be refreshed immediately. Reader and Censor now share explicit overwrite/reconcile behavior for the main save paths, but this had to be repaired separately in Reader and Censor Edit flows.
- Why this is debt:
  Every feature author currently has to remember a hidden rule instead of using one enforced shared path.
- Better long-term shape:
  Centralize "save file and reconcile indexed row" into one reusable service path.
- Revisit trigger:
  Revisit before adding any new save/export workflow or any feature that can target existing indexed paths.
- Deferred because:
  The immediate bugs were fixed, but the abstraction boundary is still missing.

### Debt-04: Manual sort session persistence is pragmatic, but not a clean state model
- Status: partially mitigated
- Type: state management debt
- Impact: medium
- Risk if ignored:
  Future additions to undo/redo/history/scope can drift between backend memory, persisted JSON, and frontend `localStorage`, causing restore-only bugs that are hard to notice early.
- Related files:
  `backend/services/sorting_service.py`
  `frontend/js/manual-sort.js`
- Observed problem:
  Backend keeps the current sort session in memory, persistence uses a JSON file, and the frontend also stores related mode/filter/scope state in `localStorage`.
- Why this is debt:
  The model is workable, but split across three layers. Correctness depends on restore logic staying aligned with current semantics.
- Better long-term shape:
  Define a single session schema and lifecycle contract, clarify which state is authoritative on backend vs frontend, and test restore rules as invariants.
- Revisit trigger:
  Revisit before adding richer history, persistent sessions across app restarts, multi-session support, or expanded undo/redo.
- Deferred because:
  Session persistence is now moved into package-local runtime state (`data/state`) with legacy-path migration support, but session lifecycle remains single-session and still spans backend persisted JSON plus frontend local storage state.

### Debt-05: Gallery selection semantics are not explicit enough
- Status: mitigated
- Type: UX contract + state-model debt
- Impact: medium
- Risk if ignored:
  Pagination, virtualization, or new batch features can reintroduce selection bugs because "visible", "loaded", "filtered", and "whole library" are different scopes.
- Related files:
  `frontend/index.html`
  `frontend/js/gallery.js`
  `frontend/js/app.js`
  `frontend/js/ui-refresh.js`
- Observed problem:
  The UI exposes concepts like selection mode, visible selection, invert visible, and batch actions. A recent bug showed that even the button label could drift from actual behavior.
- Why this is debt:
  Selection bugs reappear whenever the UI stops saying which scope is authoritative, or when frontend code starts inferring full filtered selection from only the currently loaded page.
- Better long-term shape:
  Define selection scope explicitly, document whether actions operate on visible items, loaded items, filtered results, or all matched rows, and align UI copy with that contract.
- Revisit trigger:
  Revisit before changing pagination/virtualization, adding "select all matching" style features, or broadening batch actions.
- Deferred because:
  The current pass now includes `SelectionStore`, explicit `visible` / `loaded` / `filtered` scope copy, a compatibility `POST /api/images/selection-ids` path, the preferred immediate `selection-token` / `selection-chunk` path for large filtered-result selection, and token-page export previews for filtered selections. The remaining debt is durable snapshot semantics if filtered selection/export becomes resumable or backgrounded.

### Debt-06: Path normalization is critical and still discipline-based
- Status: partially mitigated
- Type: platform compatibility debt
- Impact: high
- Risk if ignored:
  One bypassed helper can create duplicate records, stale lookups, broken source resolution, or mixed WSL/Windows path bugs.
- Related files:
  `backend/database.py`
  `backend/image_manager.py`
  `backend/routers/images.py`
  `backend/services/image_service.py`
  `backend/utils/source_paths.py`
- Observed problem:
  This product runs in environments where Windows paths, WSL paths, relative paths, and normalized indexed paths can mix. Several recent bugs were caused or amplified by inconsistent path identity.
- Why this is debt:
  Correctness still depends on developers consistently using the same normalization helpers. This is more convention than enforced boundary.
- Better long-term shape:
  Tighten path identity behind fewer public helpers and fewer direct path writes.
- Revisit trigger:
  Revisit before changing file serving, source-path storage, scan/import identity rules, or any WSL/Windows interop path.
- Deferred because:
  Recent fixes improved normalization and source-path resolution, but the abstraction is still not narrow enough to make misuse difficult.

### Debt-08: Frontend bilingual error/copy behavior is still entry-point dependent
- Status: partially mitigated
- Type: UX contract + frontend architecture debt
- Impact: high
- Risk if ignored:
  Future release polish can easily regress into mixed-language toasts, English fallback errors, or untranslated hover/help text even when the main UI looks translated.
- Related files:
  `frontend/index.html`
  `frontend/js/app.js`
  `frontend/js/autosep.js`
  `frontend/js/manual-sort.js`
  `frontend/js/censor-edit.js`
  `frontend/js/similar.js`
  `frontend/js/artist-ident.js`
  `frontend/js/prompt-lab.js`
  `frontend/js/modules/utils/errors.js`
  `frontend/js/lang/en.js`
  `frontend/js/lang/zh-CN.js`
- Observed problem:
  This release-hardening pass had to patch many separate modules just to stop common user flows from leaking English through toasts, empty states, progress text, confirm copy, hover titles, and generic error formatting.
- Why this is debt:
  The bilingual UX contract is real product behavior, but it is enforced by scattered per-feature strings and ad hoc overrides rather than one narrow translation/error path.
- Better long-term shape:
  Centralize user-facing toast/error helpers, define one policy for fallback text, and add a repeatable audit for hardcoded user-facing English in HTML attributes and JS strings.
- Revisit trigger:
  Revisit before larger UI refresh work, before adding new frontend tools/views, or before release-polish passes that touch multiple tabs.
- Deferred because:
  The Censor editor now routes its main strings through the shared language packs, but the broader frontend still has multiple ad hoc string paths and has not been collapsed behind one global toast/error policy.

### Debt-09: Censor layout ownership is split across multiple CSS layers
- Status: partially mitigated
- Type: frontend layout debt
- Impact: high
- Risk if ignored:
  Small UI text or control changes can re-break the Censor status/footer/sidebar layout, especially on tighter desktop screens, because the same shell is being steered by competing CSS layers.
- Related files:
  `frontend/css/styles.css`
  `frontend/css/censor-v2.css`
  `frontend/css/ui-refresh.css`
  `frontend/index.html`
- Observed problem:
  The recent Censor footer/status-bar fix required override-style surgery because multiple stylesheets currently own the same layout surface with different assumptions about height, separators, wrapping, and sidebar behavior.
- Why this is debt:
  Layout stability depends too much on cascade order and local overrides instead of one clearly owned Censor layout system.
- Better long-term shape:
  Pick one stylesheet as the owner of the Censor shell layout, push shared tokens into variables, and remove duplicate selector ownership for the same structural elements.
- Revisit trigger:
  Revisit before adding more Censor controls, changing sidebar density, or doing a broader desktop layout pass.
- Deferred because:
  The immediate user-visible breakage was fixed without taking on a risky full CSS consolidation during release work.

### Debt-10: Release/update path ownership rules are still duplicated across packaging and updater layers
- Status: mitigated
- Type: release + operability debt
- Impact: medium
- Risk if ignored:
  A future package-local folder change can drift between release packing rules, manifest generation, updater protection rules, and docs. That can cause rejected updates, missing files in release assets, or confusing "why did this update refuse/apply differently?" failures.
- Related files:
  `scripts/build_release_packages.py`
  `backend/update_worker.py`
  `docs/RELEASE_PACKS.md`
  `backend/tests/test_release_build.py`
  `backend/tests/test_update_worker.py`
- Observed problem:
  The release builder decides which paths are excluded from public assets, while the detached update worker separately decides which package-local paths are protected from replacement/deletion. Both layers currently encode the same ownership boundary in different places.
- Why this is debt:
  The current safety story is much better than before because the worker now hard-blocks protected runtime paths and tests cover key cases, but the rule itself is still copy-maintained instead of defined once. Adding a new package-local runtime directory would require coordinated edits across build script, updater logic, tests, and docs.
- Better long-term shape:
  Define one shared "release-managed vs user/runtime-managed" contract that packaging, updater validation, and docs can derive from, or generate/update those surfaces from one canonical source.
- Revisit trigger:
  Revisit before adding new package-local runtime directories, changing portable package layout, or expanding updater asset types/channels.
- Deferred because:
  The immediate string-literal duplication between builder and updater is removed by sharing updater-owned manifest/protection constants, but broader release-pipeline redesign is still intentionally deferred.


### Debt-11: Thumbnail generation is still not scan-aware
- Status: partially mitigated
- Type: performance / UX contract
- Impact: medium
- Risk if ignored:
  On very large folders or slow mounted drives, thumbnail requests triggered by the visible gallery can still compete with metadata parsing for disk and CPU. Users may perceive this as "scan is slow" even when the scan backend is progressing correctly.
- Related files:
  `frontend/js/app.js`
  `frontend/js/gallery.js`
  `backend/thumbnail_cache.py`
  `backend/services/image_service.py`
  `backend/image_manager.py`
- Observed problem:
  Current scan behavior now limits the first library-ready gallery refresh to a small preview page and avoids repeated gallery reloads while metadata continues. However, thumbnail generation itself still uses the normal async executor path and has no knowledge that a scan is active.
- Why this is debt:
  The product promise is a comfortable first-use scan experience for noob users with 10,000-100,000 images. Fixed preview limiting reduces the immediate thumbnail storm, but it is not a complete scheduling policy for mixed scan + thumbnail workloads.
- Better long-term shape:
  Add scan-aware thumbnail backpressure, such as a bounded thumbnail semaphore, lower thumbnail concurrency while scan status is running, or a background thumbnail warmup that starts only after metadata parsing has drained.
- Revisit trigger:
  Revisit when testing on a real 10,000+ image Windows/WSL folder, when users report gallery thumbnails slowing active scans, or before adding automatic thumbnail prewarming.
- Deferred because:
  The current pass fixed the confirmed database lookup bottleneck and reduced scan-time gallery work without risking a broader image-serving scheduler change during release hardening.


### Debt-12: Trash / Recycle Bin behavior still needs real OS matrix validation
- Status: open
- Type: file lifecycle / operability / platform compatibility
- Impact: medium
- Risk if ignored:
  The Gallery “Move to Trash” action may behave differently on Windows portable Python, macOS, Linux desktop sessions, and WSL-mounted drives. If a platform lacks a supported trash implementation, users could see failures that are technically safe but confusing.
- Related files:
  `backend/services/image_service.py`
  `backend/routers/images.py`
  `backend/requirements.in`
  `backend/tests/test_routers/test_images.py`
- Observed problem:
  Current code intentionally uses `send2trash` and does not fall back to permanent deletion. Tests cover success/failure by monkeypatching the trash mover, but this session did not run a real Windows Recycle Bin, macOS Trash, Linux freedesktop trash, or WSL-mounted-drive matrix.
- Why this is debt:
  The new product semantic is correct, but recoverable deletion is a platform integration behavior. Unit tests cannot prove the exact OS trash target that end users will see.
- Better long-term shape:
  Add a small manual/automated platform QA checklist for Windows portable, Windows path from WSL if supported, macOS, and Linux. Surface a clearer failure message that tells users their OS trash integration is unavailable and that no permanent delete was performed.
- Revisit trigger:
  Revisit before release packaging, after any file-deletion refactor, or if users report “Move to Trash” failures on WSL/network/external drives.
- Deferred because:
  The current code blocks permanent deletion and reports per-file failures, which is the safe release-hardening behavior. Full OS trash matrix validation requires real platform runs outside the current targeted unit tests.

### Debt-13: Scan count pass needs real large-folder timing validation
- Status: open
- Type: performance / release validation
- Impact: medium
- Risk if ignored:
  The scan UX now counts image files before import so ETA has a real denominator. On normal local folders this should be cheap, but on very slow network drives, external disks, or WSL-mounted paths, the extra directory walk could delay first thumbnails more than expected.
- Related files:
  `backend/image_manager.py`
  `backend/services/sorting_service.py`
  `frontend/js/app.js`
  `backend/tests/test_routers/test_sorting.py`
- Observed problem:
  Current code deliberately trades one lightweight filename/stat pass for truthful ETA. Unit tests prove the progress contract, but this session did not run a real 100,000-image Windows/WSL timing matrix.
- Why this is debt:
  The product target includes users with 10,000-100,000 images. The count pass is the right user-facing behavior, but the acceptable cost must be verified on the same disks and mounts those users actually use.
- Better long-term shape:
  Add release QA measurements for local SSD, HDD/external drive, WSL-mounted drive, and network folder. If counting is too slow on any target, replace the double walk with a counted path spool or a hybrid count/import scheduler that keeps the same stable-total progress contract.
- Revisit trigger:
  Revisit before release packaging, after real 100,000-image timing tests, or if users report a long pause before first thumbnails.
- Deferred because:
  The current change fixes the confirmed fake-ETA problem and adds contract tests. Real disk timing requires the user's Windows/WSL environment and representative large folders.


## Quick Debt Reductions Applied On 2026-04-27

These do not close the major structural debts from the whole-repo audit, but they reduce small confirmed drift without risky rewrites.

- LoRA selected filters now use exact normalized `image_loras.lora_name = ?` matching instead of substring `LIKE`, and cross-generator checkpoint filtering/faceting now uses a dedicated normalized key instead of raw mixed generator strings.
- Aspect-ratio validation now imports one shared backend constant instead of copy-maintaining the same list in image and sorting services.
- Update archives are validated for unsafe member names before staging, and the detached worker uses platform-independent archive-entry path checks.
- Release package default version now follows `backend/app_info.py` instead of a hardcoded script-local value.
- Production and test dependencies are split into `backend/requirements.txt` and `backend/requirements-dev.txt`, and this hardening pass now also adds `requirements.in` / `requirements-dev.in` plus compiled lock outputs; cross-platform lock maintenance still remains open.
- Gallery large-card labels moved into the main i18n packs for the visible card metadata touched in this cleanup.
- Test-client DB setup now uses a real temporary SQLite path instead of brittle sibling-name path swapping inside `backend/tests/conftest.py`.
- Canonical image SELECT column lists in `backend/database.py` now derive from one shared field source instead of four independently maintained string constants.
- `run.bat` no longer probes a machine-specific `D:\Anaconda\python.exe` path before falling back to general user-install or PATH-based Python discovery.

## Quick Debt Reductions Applied On 2026-04-28

- Manual Sort persisted session moved from `backend/sort_session.json` into package-local runtime state (`data/state/sort-session.json` by default), with startup compatibility migration from the legacy path.
- Release builder now reuses updater-owned constants for manifest-relative paths and runtime-protected prefixes, reducing copy-maintained release/update contract drift.
- Core docs (`README.md`, `AGENTS.md`, `docs/API.md`, `docs/architecture.md`) were aligned to current runtime defaults: `127.0.0.1:8487`, package-local `data/` runtime paths, and currently mounted router surface.

## Whole-Repo Audit Status Refresh (2026-04-27)

This refresh aligns the long audit report with the current shipped workspace after the structural hardening pass completed in this session.

- TD-01 Path normalization: partially mitigated.
  Indexed DB-key lookups in the scan/reconcile path now use normalized indexed paths instead of raw `abspath()` keys, and folder-scope matching, tag-import path lookup, plus repository-layer `find_by_path()` now also reuse the shared equivalent-path helpers. There is still no single `PathIdentity` boundary for every DB-facing path touchpoint.
- TD-02 Derived-state invalidation: partially mitigated.
  The core invalidation rule still lives in `database.py`, overwrite/save entry points now share `backend/services/indexed_file_mutation_service.py`, and stale interrupted `metadata_status='pending'` rows are now quarantined on startup so they do not remain permanent blind spots. The broader content-fingerprint semantics still are not fully centralized.
- TD-03 Schema migration/versioning: partially mitigated.
  A real `schema_version` table and numbered migrations now exist, failed future migrations are guarded by explicit savepoint-based rollback coverage, and representative upgrade tests now cover fresh DBs, unversioned legacy DBs, and a versioned DB with a still-pending backfill migration. Historical downgrade policy and larger future schema redesigns still need explicit rollout discipline.
- TD-04 Frontend mega-state: partially mitigated.
  `FilterStore` now owns the main filter write boundary, `SelectionStore` makes scope more explicit, and `censor-edit.js` now uses the shared i18n packs instead of its own bilingual helper stack. `app.js` and `censor-edit.js` still remain large multi-responsibility modules.
- TD-05 Dependency reproducibility: partially mitigated.
  `requirements.in` / `requirements-dev.in`, compiled lock outputs, GitHub Actions CI, coverage reporting, and a lock-freshness guard now exist. Cross-platform lock maintenance still needs ongoing care.
- TD-06 `created_at` mixed semantics: mitigated.
  The schema now separates `library_order_time` from `source_file_mtime`, default ordering uses `library_order_time`, and `created_at` is reduced to a compatibility alias. The remaining cleanup is future alias removal, not unresolved mixed live semantics.
- TD-07 Router/service boundary leakage: partially mitigated.
  Router service getter/setter boilerplate now shares `ServiceProvider`, and Tagging/Sorting compatibility state no longer creates services at import time. Older service-layer `HTTPException` usage remains intentionally deferred because broad exception migration is a Dangerous Refactor.
- TD-08 Manual sort session persistence split-brain: partially mitigated.
  Persisted session storage now lives under package-local runtime state with legacy-path migration, but broader multi-layer session-state ownership is still not unified.
- TD-09 Selection semantics ambiguity: partially mitigated.
  `SelectionStore` now owns explicit `visible` / `loaded` / `filtered` scope state, `selection-token` / `selection-chunk` resolves true filtered-result selection in backend sort order without one giant response, `POST /api/images/selection-ids` remains as compatibility and `random` fallback, same-filter reloads no longer silently prune off-page IDs against the loaded thumbnail slice, changing Gallery filters now clears stale `filtered` selections, filter modal apply/reset commits through `FilterStore`, and scope-narrowing Gallery operations now drop out-of-scope IDs instead of relabeling them.
- TD-10 Cross-generator checkpoint semantics: partially mitigated.
  LoRA exact matching is fixed, image rows now persist `checkpoint_normalized`, gallery/search/filter analytics now group and match by that normalized key, and raw `checkpoint` stays available for per-image display. The remaining gap is making NAI/no-LoRA semantics more explicit in UI copy instead of leaving them implicit.

## Larger Structural Reductions Applied On 2026-04-27

- SQLite schema initialization now runs through a numbered migration runner backed by `schema_version` and `backend/migrations/` instead of inline `PRAGMA table_info` startup patching inside `database.init_db()`.
- Migration policy is now documented next to the code in `backend/migrations/README.md`, including unique increasing versions, per-migration savepoint rollback, and the current forward-only/no-automatic-downgrade stance.
- Reader metadata save, Censor save/save-data/save-operations, and Obfuscate encode/decode writes now converge through `backend/services/indexed_file_mutation_service.py` for indexed overwrite reconciliation.
- Folder-scope lookup and tag-import path matching now reuse the shared indexed-path equivalence helpers instead of each caller hand-rolling Windows/WSL slash and drive-letter rules.
- Startup repair now quarantines stale interrupted `pending` scan rows so they do not survive restarts as readable invalidation blind spots.
- Frontend filter writes now have an explicit boundary via `frontend/js/stores/filter-store.js`, and the main touched modules no longer directly assign into `AppState.filters.*`.
- `frontend/js/censor-edit.js` no longer keeps its own `tText()` / `tKey()` / `tFormat()` bilingual helper stack; the editor now routes its main strings through the shared language packs via one thin `censorT()` wrapper.
- GitHub Actions now covers Linux full CI and Windows path/migration/update risk areas, the backend suite now emits coverage output, and CI fails when compiled lock metadata drifts from the checked-in source inputs.
- Release bootstrap downloads now use pinned SHA-256 validation, the release builder emits a checksum manifest asset, and the updater can validate downloaded archives against that manifest when present.
- API docs now have an OpenAPI/export contract guard: `docs/API.md` endpoint headings must match FastAPI `/api/*` routes, app version must match `backend/app_info.py`, and update contract fields are pinned in tests.
- Feature-local similarity, aesthetic, and artist derived-state image writes now use `backend/services/derived_state_service.py`; a writer allowlist prevents silent reintroduction of scattered `content_fingerprint` SQL.
- Gallery filtered selection now invalidates on filter-key changes, and the filter modal commits through `FilterStore`, reducing the chance of destructive actions applying to stale result semantics.
- Release/update packaging now rejects downloaded update archives without `update/package-manifest.json` and validates managed paths before apply; the release builder also filters protected runtime paths even if staging is polluted.
- Prompt and LoRA library counts now read from maintained normalized indexes (`image_prompt_tokens`, `image_loras`) instead of scanning every image row and reparsing prompt/LoRA text in Python.

- Censor save/save-data/save-operations now default to no overwrite, require explicit `allow_overwrite=true` to replace an existing output file, and return indexed-overwrite reconcile signals so the frontend can mark Gallery state stale.
- Gallery scope-narrowing selection operations now discard stale/out-of-scope IDs, so the visible/loaded/filtered selection label no longer silently lies before destructive actions.
- Downloaded update archive manifest discovery now matches only rootless or single-payload-root `update/package-manifest.json`, rejecting multiple real manifests and ignoring fake suffix matches such as `badupdate/package-manifest.json`.

## Suggested Follow-Up Work

These are not "drop everything now" items.

They are the next reasonable debt-reduction steps if the goal shifts from bug fixing to structural hardening.

1. Separate library-order time from source/content time in the schema.
2. Keep shrinking the derived-state invalidation surface so future write paths cannot bypass the shared reconcile helper.
3. Extend indexed overwrite reconciliation coverage to any future save/export feature instead of letting new entry points drift back into one-off refresh logic.
4. Define one manual-sort session contract covering backend memory, persisted JSON, and frontend storage.
5. Define and document gallery selection scopes explicitly.
6. Tighten path identity behind fewer public helpers and fewer direct path writes until every DB-facing lookup/write has one obvious path boundary.
7. Centralize the release/update ownership contract for package-local runtime paths instead of copy-maintaining it across scripts, updater code, tests, and docs.
8. Expand migration coverage with representative legacy-database upgrade matrices and document downgrade policy before the next schema semantics change.
9. Keep the compiled dependency locks reproducible across release environments, especially the Windows-heavy optional stacks.
10. Split the largest frontend state modules only behind explicit selection/filter/scope contracts and regression coverage.

## Audit Targets Suggested But Not Yet Confirmed As Debt

These are worth auditing, but they are not recorded here as confirmed debt yet.

Do not promote them to confirmed debt without direct verification.

### Audit Target A: Obfuscation engine parity
- Status: unverified
- Priority: high
- Why audit:
  Drift between frontend JS and backend/Python obfuscation logic would create silent output inconsistency.
- Likely failure mode:
  Users get different obfuscation output depending on route, engine, or save path and only discover it after comparing results.
- Verify when:
  Before major obfuscation refactors, output-format changes, or performance work.
- Candidate files:
  `backend/obfuscation.py`
  `backend/routers/obfuscation.py`
  `frontend/js/image-obfuscate.js`
  `frontend/js/obfuscate-engine.js`

### Audit Target B: Visible i18n gaps
- Status: unverified
- Priority: medium
- Why audit:
  Partial translation breaks trust, and long English fallback strings can damage compact desktop layouts.
- Likely failure mode:
  Mixed-language UI, broken labels, or clipped controls in one language but not the other.
- Verify when:
  Before larger UI refresh work or release polishing.
- Candidate files:
  `frontend/index.html`
  `frontend/js/lang/en.js`
  `frontend/js/lang/zh-CN.js`
  `frontend/js/guide-translations.js`

### Audit Target C: Desktop small-screen layout pressure
- Status: unverified
- Priority: high
- Why audit:
  This repo is desktop-first, not mobile-first. Long English strings, helper text, and crowded toolbars can break functional layout.
- Likely failure mode:
  Important controls get pushed off-screen or crowded out on `1366x768` while still looking fine on larger monitors.
- Verify when:
  Before UI layout refactors or release screenshots/demo prep.
- Candidate files:
  `frontend/index.html`
  `frontend/css/styles.css`
  `frontend/css/new-views.css`
  `frontend/css/ui-refresh.css`
  `frontend/css/censor-v2.css`

### Audit Target D: Schema / constant drift
- Status: unverified
- Priority: high
- Why audit:
  Drift between code-level schema constants and actual DB read/write assumptions causes subtle API and data bugs.
- Likely failure mode:
  Less-common query paths return stale/missing fields or silently stop matching the real schema.
- Verify when:
  Before schema migrations, query refactors, or image-row shape changes.
- Candidate files:
  `backend/database.py`
  `backend/routers/images.py`
  `backend/services/image_service.py`

### Audit Target E: Large-image client performance
- Status: unverified
- Priority: medium
- Why audit:
  Local-only tools still need practical high-resolution performance. UX can become unusable long before a formal crash happens.
- Likely failure mode:
  4K workflows become laggy, canvas interactions stutter, or browser memory spikes enough to make the tool feel broken.
- Verify when:
  Before major Censor / Reader / Obfuscation client-side processing changes.
- Candidate files:
  `frontend/js/censor-edit.js`
  `frontend/js/image-reader.js`
  `frontend/js/image-obfuscate.js`
  `frontend/js/obfuscate-engine.js`

## Prompt For Another AI To Audit Debt Across The Whole Software

Use the prompt below as-is, or adjust the output format if needed.

```text
You are auditing technical debt in the whole SD Image Sorter codebase.

Repository context:
- Local web app
- FastAPI backend
- Vanilla HTML/CSS/JS frontend
- SQLite database
- Main areas: gallery, metadata parsing, tagging, sorting, censor editor, similarity, prompts, artist identification, packaging/release scripts

Your job:
- Find structural debt, not just obvious bugs
- Cover the whole software, not only move/copy/save flows
- Prioritize debt that can cause future regressions, hidden inconsistency, maintainability collapse, UX confusion, performance cliffs, or release risk

What counts as debt:
- data model ambiguity
- duplicated business rules
- hidden invariants enforced in scattered places
- backend/frontend contract drift
- global state abuse
- overgrown files or modules with too many responsibilities
- feature-specific patches where a shared abstraction is missing
- fragile persistence/session models
- unclear selection/filter/sort semantics
- platform/path/runtime assumptions that are easy to violate
- test coverage holes around important invariants
- docs drift from actual behavior
- dependency/version/runtime deprecation risk
- release/build/update pipeline fragility

What not to do:
- do not spend most of the report on cosmetic style complaints
- do not rewrite code
- do not produce a vague “needs refactor” summary
- do not focus only on security unless it is genuinely debt with structural impact

Audit instructions:
1. Read project docs first:
   - AGENTS.md
   - README.md
   - docs/architecture.md
   - docs/API.md
   - docs/IMPROVEMENT_PLAN.md
   - .plans/sd-image-sorter-release/docs/architecture.md
   - .plans/sd-image-sorter-release/docs/invariants.md
2. Then inspect both backend and frontend broadly.
3. Trace at least these cross-cutting themes end to end:
   - path identity and source resolution
   - scan/import/rescan/update lifecycle
   - derived state invalidation for tags/embeddings/captions/scores/predictions
   - sort/filter/selection semantics
   - save/export/edit flows that can overwrite indexed files
   - manual sort session persistence and restore
   - API contract consistency between frontend calls and backend responses
   - large-file and large-library performance behavior
   - release/update/build packaging assumptions
4. Distinguish:
   - confirmed debt
   - likely debt needing quick validation
   - non-issues
5. Prefer concrete evidence with file paths and functions.

Required output format:

# Executive Summary
- 5 to 10 lines only

# Top Debts
For each item:
- Title
- Type: data model / architecture / state / UX contract / performance / testability / operability / docs / dependency / release
- Severity: critical / high / medium / low
- Confidence: high / medium / low
- Why it is debt
- Evidence
- Likely failure modes
- Suggested direction, not full implementation

# Debt Map By Area
- Backend
- Frontend
- Database
- API contracts
- UX/workflow semantics
- Tooling/release/update
- Tests/docs

# Cross-Cutting Invariants That Need To Be Made Explicit
- list the rules the codebase currently depends on but does not express cleanly

# Quick Wins
- low-risk debt reductions that can be done without destabilizing product behavior

# Dangerous Refactors
- debt that should only be addressed with migrations, staged rollout, or broad regression coverage

Quality bar:
- be direct
- avoid filler
- do not confuse bugs with structural debt
- do not mark something as confirmed debt unless you can point to real evidence
```

## Phase 6 Structural Debt Reductions Applied On 2026-04-28

- Scan/import/rescan pending-row lifecycle now has same-runtime interruption cleanup: cancelled or failed scans remove new unresolved placeholders and quarantine unresolved updated placeholders instead of waiting for a restart.
- `preserve_derived_state=True` no longer overrides content identity. It only preserves derived state for readable, complete rows with explicit matching `content_fingerprint`; unreadable/error rows and pixel changes clear tags, captions, embeddings, scores, and artist predictions.
- Artist prediction writes now use `derived_state_service.write_artist_prediction(s)()` in both single and batch paths; feature-local direct `artist_predictions` SQL is guarded by contract tests.
- Migration 006 freezes its prompt-token tokenizer and no longer imports mutable runtime `database` helpers; migration contract tests now block that class of drift.
- Obfuscation encode/decode/batch save now matches Reader/Censor overwrite semantics: no implicit overwrite, HTTP 409 by default, explicit `allow_overwrite=true`, and indexed reconcile signals on success.
- Manual Sort resume now displays server-owned session context (remaining count, move/copy mode, saved folders) and warns that setup preferences may differ from the active saved session.
- `window.App.AppState` writes from feature modules are blocked by a static contract; `window.App` is sealed after creation, Censor uses a named `window.CensorEdit.addToQueue` bridge, and Reader/Censor use narrow refresh APIs instead of feature-local global mutation.
- Large synchronous operations have guardrails or chunk paths: filtered-result selection above 10,000 requires confirmation and now fetches preferred non-random selections via immediate token/chunk pages, filtered export previews can page by `selection_token` instead of sending giant explicit ID payloads, preview text still caps at 2,000 images / 200,000 chars, and duplicate search refuses synchronous O(N²) work above `DUPLICATE_SYNC_MAX_EMBEDDINGS`.
- `save_and_reconcile_checked()` now owns overwrite preflight and indexed-row reconciliation result metadata for Reader, Censor, and Obfuscation, with contract tests blocking feature-local overwrite helpers.
- Release package manifests now declare `model_artifact_policy`, exclude accidental non-doc model payloads from default app manifests, and document auto-download / optional model asset assumptions.
- SQLite datetime writes now register an explicit adapter, removing Python 3.12 default-adapter deprecation risk without changing the stored string shape.

### Remaining staged work after this slice

- Durable server-side selection/export snapshots are still needed if filtered selection or export becomes resumable, cancelable, or backgrounded across scan/import/delete/update mutations.
- Full export still needs a streamed/downloadable backend job for truly large libraries; the current fix makes preview paging sane, not full archival export.
- Duplicate search still needs a background/ANN/LSH workflow for very large embedding sets; the current limit prevents synchronous CPU/RAM cliffs.
- Filter/facet option rendering still needs a searchable/paged facet API for huge tag/checkpoint/LoRA libraries.
- Censor's auxiliary non-proxy canvas/filter/metadata-strip paths still need full migration into the backend operation pipeline for very large images.
- Optional model pack artifact smoke still needs real release-asset extraction/install coverage; the manifest now states policy, but it does not prove every external model archive is valid.

## Dependency / Release Debt Reduced On 2026-04-28

- Confirmed release blocker fixed: `backend/requirements.txt` had Linux CUDA/NVIDIA/Triton wheels pinned without platform markers, while Windows and portable launchers install that same file. Those pins are now Linux-only, `uvloop` is non-Windows, macOS uses resolvable ONNX Runtime/OpenCV/PyTorch pins, `triton-windows` uses a published post-release pin, and a release-build regression test guards the shared requirements marker policy.
- Confirmed dev-onboarding blocker fixed: `backend/requirements-dev.txt` had drifted behind the runtime lock and kept stale/unmarked platform wheels. It now mirrors the runtime platform split, refreshes its embedded input hash, and has the same marker regression test coverage.
- Confirmed release-build smoke blockers fixed: the release builder now prunes excluded directory trees before walking them, so `backend/venv` / `artifacts` cannot create a packaging-time performance cliff; `get-pip.py` is pinned to an immutable upstream commit instead of mutable `bootstrap.pypa.io/get-pip.py`; bootstrap download cache now stays under staging and is deleted before the publishable asset list is complete.
- Remaining debt: the repo still uses generated cross-platform requirements locks that require manual marker preservation. A staged future improvement should split runtime constraints/locks per platform or regenerate locks in CI for Windows, Linux, and macOS instead of relying on manual lockfile surgery.

## Small Review Bugs Fixed On 2026-04-28

- Selection state now enforces `selectionToken/filterKey => filtered scope` in the shared store instead of relying on every Gallery action to remember to clear stale token state.
- Manual Sort resume banner no longer renders a null visible session and leaves stale copy on screen; resume failure restores the previous saved-session snapshot only when one exists.
- Migration 003 no longer imports live `database` helpers; its LoRA extraction backfill is frozen inside the migration with contract tests.

## P0 User Smoke Fixes Applied On 2026-04-28

- Gallery selection semantics are no longer collapsed: filtered-all, visible-only, and invert actions now have separate controls and tests.
- Selected Gallery file operations now exist in the Gallery panel: `Move Selected...` and `Copy Selected...` call the existing `/api/move` backend contract instead of forcing users into Auto-Separate/Manual Sort.
- Destructive selected deletion is no longer the default cleanup path: `Remove from Gallery` and the Delete key delete only DB rows through `/api/images/remove-selected`; `Delete Files from Disk...` remains explicit and dangerous.
- Manual Sort start no longer silently overwrites or nudges users to discard unfinished progress. Backend requires `replace_existing=true`; frontend Start resumes a saved session by default, and restarting from the first image requires discarding the saved session first.
- Forge detection now uses structured Forge signals and Forge-style version fields without scanning arbitrary prompt text, reducing WebUI/Forge bucket drift and avoiding `forge` prompt-word false positives for newly parsed or re-parsed images.
- Batch tag export response shape now has explicit `status`, `error_count`, and `error_messages`, closing the frontend/backend contract drift that made partial exports hard to report correctly.

### Remaining staged work after the user smoke fixes

- Pro-grade prompt/tag export has the core mode contract now: prompt-only, negative-only, prompt+negative, A1111/Forge block, tags, caption+tags, merged caption, JSON sidecars, CSV/JSONL modal formats, and sidecar overwrite policy. Remaining debt is filename templates/presets and streamed/background full-library export.
- Auto-Separate execution-critical settings are now visible near the run button: move/copy, confirmation, and destination memory. Remaining debt is polishing preset ergonomics, not hidden destructive semantics.
- Quick-import generator counts now expose `metadata_pending`, `scan_status`, and `scan_library_ready` through `/api/stats`; the UI labels unresolved generator buckets as resolving while metadata is pending or scan import is not library-ready. Remaining debt is historical rows that need explicit reparse/rescan when old parser logic already saved the wrong generator.
- Existing already-indexed Forge rows may require reparse/rescan to move buckets if they were previously saved as `webui`; the parser fix improves new or re-parsed metadata, not historical rows automatically.
- Local Playwright still depends on either host Chromium shared libraries or the wrapper's `.tools` runtime package cache being present. The touched smoke slice passes through the wrapper, but a clean WSL workspace without system libs still needs the local `.deb` cache before browser tests can run.

## Audit Debt Reduced On 2026-04-29

- E2E false-green risk is now guarded: `tests/e2e/specs/` exists with real specs, and `backend/tests/test_release_build.py` fails if it becomes an empty shell again.
- Portable Python compatibility is guarded: launcher scripts require Python 3.12+, release embed Python is 3.12.8, and tests assert the embed minor matches the compiled requirements header.
- PNG metadata parsing no longer relies on unbounded zlib output; compressed text chunks use capped streaming decompression, and oversized chunk reads are bounded by `_MAX_PNG_CHUNK_BYTES`.
- Aesthetic and Artist background state now lives in services, not router-level dictionaries. Future background jobs should follow service-owned state with thin router adapters.
- Model manager logic now has `ModelService`; inventory building, Privacy YOLO download/zip validation, and prepare-model branches no longer live in `routers/models.py`.
- Frontend i18n no longer has a translation-to-`innerHTML` sink; `data-i18n-html` remains only as a legacy text-only alias.
- The old hardcoded purple CSS accent has been moved behind CSS variables across `frontend/css/*.css`; this reduces theme drift but does not merge `styles.css`, `ui-refresh.css`, and `censor-v2.css` ownership.
- CI now runs dependency security audit through `scripts/run_ci.py`, GitHub Actions has a `macos-latest` dependency/import/release-guard job, and frontend JavaScript syntax is checked with `node --check` before E2E.
- Remote archive intake is now bounded in the touched release/model paths: Privacy YOLO zip, LSNet artist runtime zip, and update zip/tar validation reject unsafe paths, too many entries, and excessive uncompressed size.
- LSNet artist runtime downloads are pinned to a GitHub commit zip, and the Windows update worker no longer uses `os.kill(pid, 0)` for PID liveness checks.
- Manual Sort minimap preview now requests only remaining preview slots and slices backend responses so the 1000-image cap cannot overshoot.
- Dynamic frontend labels now avoid stale translation replay: Auto-Separate updates the active move/copy label key, Queue Solitaire removes static `data-i18n` before generated summaries, and Manual Sort wraps the resume click handler instead of passing the DOM event as a session payload.
- `pip-audit` is now in the compiled dev lock; `scripts/security_check.py` still keeps a disposable temp-venv fallback for externally managed or incomplete Python installations.
- Aesthetic predictor lazy loading now uses a singleton lock, matching the heavy-model patterns in tagger/similarity and preventing duplicate CLIP/head loads under concurrent requests.
- Numeric environment variables now route through typed config readers with explicit `Invalid <ENV>: expected ...` startup errors instead of raw `int()` / `float()` tracebacks.
- ToriiGate downloads are pinned to HuggingFace revision `667e771497abcfa38637e1d308cb495beb68d803` instead of the moving `main` ref, and its CUDA memory fraction uses the shared env parser.
- `/api/open-folder` now has a Pydantic request body model, so the OpenAPI contract reflects the expected `image_id` payload while preserving the existing 400 response for missing IDs.
- Queue Solitaire marquee selection now tears down its document-level mouse listeners when the workspace closes, reducing cross-view listener residue without introducing a full frontend lifecycle refactor.
- Gallery preview zoom handlers now have an explicit close-path cleanup hook, and Reader/Obfuscator/Queue Solitaire local initializers are idempotent so repeated exported `init()` calls do not stack duplicate UI listeners.
- Censor dynamic helper text now drops stale static `data-i18n` bindings before writing runtime model-status copy, and scan completion no longer forces an extra gallery image reload after the library-ready refresh already populated the gallery.
- `scripts/run_ci.py` now normalizes Linux/WSL `TMPDIR`/`TEMP`/`TMP` to `/tmp` for subprocesses, avoiding pytest capture crashes caused by inherited Windows temp paths.
- File move/copy consistency is now protected for ordinary DB failures: move restores the file when SQLite path update fails, copy deletes the copied file when indexed-state insertion fails, and copied row/tags/derived state are written in one transaction.
- Router service lifecycle boilerplate now uses shared `ServiceProvider`; simple routers no longer carry per-file `_service = None` / `get_*` / `set_*` clones, and Tagging/Sorting compatibility state is lazy instead of constructing services at import time.
- The dead `GALLERY_MAX_LIMIT` config/env knob was removed; gallery request limits are enforced by the images router/service contracts (`le=1000` / `LIMIT_MAX`) instead of a disconnected config constant.
- Interrupted-scan metadata recovery now uses the database-owned stale-metadata error constant directly from `image_manager.py`, removing the last alias left from the duplicated error-message quick win.
- The audit's proposed deletion of `backend/db_repos/` was rejected: current tests and ADR-AI-20260428-25 still use it as a repository/path-equivalence seam, so the debt is partial adoption rather than dead code.
- The audit's `nudenet_detector.py` singleton deletion quick win was rejected: `_nudenet_instance` backs `get_nudenet_detector()` and is imported by censor/model-service paths, so deleting it would break runtime callers.

### Still Intentionally Deferred

- Frontend God-file decomposition (`app.js`, `censor-edit.js`, `gallery.js`) remains risky and should be done only behind broader E2E coverage. Local listener cleanup is improved, but a full view lifecycle/teardown model is still intentionally deferred.
- CSS ownership is still split across several large files; variables are aligned, but selector duplication and `!important` debt remain.
- Archive-size budgets are conservative guardrails, not a full artifact provenance system; full portable release package smoke and model-asset install smoke are still missing.
- Several older services still raise FastAPI `HTTPException`; this pass fixed the audit-named Aesthetic/Artist path and added ModelService, not a whole-service-layer exception migration.
- macOS browser E2E is still missing; the new macOS job is only dependency import plus release guard coverage.
- `ui-refresh.js` still uses a broad MutationObserver to replay static translations. Dynamic UI code must keep using explicit i18n ownership until a narrower refresh contract/helper exists.
- File move/copy operations still are not truly atomic across process crashes between filesystem and SQLite steps; the current mitigation handles normal DB exceptions with compensation, but a durable recovery journal is still deferred.
- CI release guard tests now avoid ignored local `AGENTS.md` and the indexed file mutation contract initializes an isolated test DB, removing two clean-checkout-only GitHub Actions failures.
- Service-layer `HTTPException` usage remains in older services; this pass intentionally avoided the dangerous broad exception migration.
- CI Playwright E2E no longer depends on ignored `tests/e2e/storage/onboarding-complete.json` or ignored `.tmp` dataset builders; fixtures are inline or generated from tracked scripts before browser tests run.
- CI E2E now avoids private local media assumptions for artist and manual move/sort tests, and scan progress now emits a terminal `total_final=true` metadata event after metadata backfill drains.

### Debt-14: Missing-file repair has no ambiguous/conflict review UI yet

- Status: open
- Type: UX / data safety / large-library workflow debt
- Impact: medium
- Risk if ignored:
  Users who moved folders containing duplicate filenames, or who already scanned the new location before running repair, may see “needs review” / “already in gallery” counts but cannot resolve those cases inside the app yet. They may need to narrow the search folder or manually remove duplicate records, which is safe but not smooth.
- Related files:
  `backend/services/image_service.py`
  `backend/routers/images.py`
  `frontend/index.html`
  `frontend/js/app.js`
- Observed problem:
  The first implementation intentionally refuses ambiguous reconnects and refuses to reconnect a missing row onto a found path that is already indexed by another row. The result payload keeps only a short sample of updated rows and counts ambiguous/conflict candidates; it does not expose a full candidate-review table, merge flow, or manual per-image confirmation UI.
- Why this is debt:
  Refusing ambiguous auto-repair and duplicate-path auto-merge is the correct safety behavior, but users still need a follow-up path when duplicate filenames are common or when they scanned the new location first. Without a review/merge UI, the workflow is incomplete for some real moved-folder cases.
- Better long-term shape:
  Store or return paginated ambiguous/conflict candidates, show old path and possible new paths or existing gallery rows, allow the user to pick a match or merge/remove a duplicate per image, and update paths only after explicit confirmation. Keep this separate from automatic safe reconnects.
- Revisit trigger:
  Revisit before publishing this as a headline “repair moved files” feature, or when real testing shows many ambiguous matches in common SD output folders.
- Deferred because:
  The current user request required a non-blocking safe background repair first. Adding a review table is larger UI work and should be driven by real ambiguous-match test data rather than guessed layouts.


### Debt-15: E2E TypeScript files have no local typecheck command

- Status: open
- Type: test tooling / frontend QA gap
- Impact: low to medium
- Risk if ignored:
  Playwright tests can still run, but TypeScript-only mistakes in `tests/e2e/**/*.ts` are not caught by a fast typecheck step. Some mistakes will only appear when a specific browser test executes.
- Related files:
  `package.json`
  `tests/e2e/package.json`
  `tests/e2e/tsconfig.json`
  `tests/e2e/specs/smoke.spec.ts`
- Observed problem:
  Running `npx tsc --noEmit --project tests/e2e/tsconfig.json` does not invoke a project-installed TypeScript compiler. It prints npm's placeholder message: "This is not the tsc command you are looking for". The current E2E package has Playwright and Node types but no `typescript` dev dependency or typecheck script.
- Why this is debt:
  The repo has TS-based E2E tests and release-critical browser flows. Runtime Playwright coverage is valuable but slower and narrower than a typecheck pass for catching test-source drift.
- Better long-term shape:
  Add `typescript` to the E2E dev dependencies, add an `npm --prefix tests/e2e run typecheck` script, and include it in the local/CI verification path if runtime cost stays acceptable.
- Revisit trigger:
  Revisit before relying on newly added or refactored E2E test helpers as release gates.
- Deferred because:
  The current task was product wording and export/right-click UX. The affected browser flows were validated with targeted Playwright tests, so adding a new Node dependency and lockfile change was kept separate.

### Debt-16: AI runtime guard is coarse and not yet a real scheduler

- Status: partially mitigated
- Type: runtime stability / performance debt
- Impact: high
- Risk if ignored:
  The current guard prevents the worst RAM/VRAM pileups, but long model jobs can still make other heavyweight AI tasks wait without priority, progress fairness, or model residency decisions. Future contributors may also add new large-model entry points and forget to use the guard.
- Related files:
  `backend/ai_runtime_guard.py`
  `backend/aesthetic.py`
  `backend/tagger.py`
  `backend/similarity.py`
  `backend/censor.py`
  `backend/nudenet_detector.py`
  `backend/model_health.py`
  `backend/sam3_refiner.py`
  `backend/toriigate_tagger.py`
  `backend/artist_identifier.py`
- Observed problem:
  Aesthetic scoring, older tagger flows, censor detector variants, artist identification, model-health probes, and similarity search could crash or freeze the computer when large model loads, GPU inference, and memory-heavy preprocessing/search overlapped. The mitigation now serializes heavyweight critical sections and checks CUDA headroom, but it is intentionally a safety gate rather than a full resource scheduler.
- Why this is debt:
  A coarse gate is much safer than uncoordinated large-model execution, but it cannot optimize queue order, reserve model-specific VRAM precisely, reuse loaded models based on pressure, or provide user-visible scheduling. New AI features still need code review discipline to opt in.
- Better long-term shape:
  Add a central AI job scheduler with model/device budgets, priority, cancellation, timeout/progress reporting, per-runtime VRAM estimates, and an allowlist test that fails when a new large-model owner bypasses the guard.
- Revisit trigger:
  Revisit before adding another heavyweight local model, enabling concurrent background AI jobs by default, or exposing multi-GPU / GPU-priority settings.
- Deferred because:
  The immediate user-facing blocker was computer crashes. The current guard fixes the root crash class without globally slowing normal browsing, scanning, sorting, or cheap metadata operations.

### Debt-17: Similarity search is bounded and chunked but still linear-scan

- Status: partially mitigated
- Type: performance / scalability debt
- Impact: medium to high
- Risk if ignored:
  Very large libraries will no longer build one giant embedding matrix, but every search still scans all candidate embeddings in chunks. Latency will grow with library size, and duplicate search remains a bounded synchronous all-pairs style workflow.
- Related files:
  `backend/similarity.py`
  `backend/services/similarity_service.py`
  `backend/tests/test_resource_safety.py`
- Observed problem:
  Previous similarity search loaded all matching embeddings with `fetchall()` and built a full NumPy matrix, which risked OOM on large libraries. The fix changed search-by-id and search-by-upload to DB `fetchmany()` chunks plus a bounded top-k heap.
- Why this is debt:
  Chunking removes the crash-shaped memory spike, but it does not create an index. Large-library speed will eventually need an approximate nearest-neighbor or persisted vector-index strategy.
- Better long-term shape:
  Add a local ANN index or SQLite-compatible vector index with content-fingerprint invalidation, background rebuilds, and safe fallback to chunked exact search when the index is missing or stale.
- Revisit trigger:
  Revisit when libraries above tens/hundreds of thousands of images become common test targets, or when similarity latency becomes a visible UX blocker.
- Deferred because:
  The urgent requirement was to stop computer-crashing memory spikes while preserving correctness and acceptable speed. A vector index needs separate design and invalidation work.

### Debt-18: Large-image edit paths still need deeper crop-first auditing

- Status: partially mitigated
- Type: memory / image-processing debt
- Impact: medium
- Risk if ignored:
  The most dangerous censor save-operation paths now have budgets and cached-mask crop application, but future brush/filter/mask operations could reintroduce full-canvas temporary allocations on very large images.
- Related files:
  `backend/services/censor_service.py`
  `backend/censor.py`
  `frontend/js/censor-edit.js`
- Observed problem:
  Censor save operations accepted large operation lists, large inline masks, many stroke/polygon points, and full-image filters without enough server-side resource budgeting. Cached masks were also expanded as full-image alpha masks before application.
- Why this is debt:
  The new limits stop unbounded payloads and crop cached masks, but the image editor has many operation types and client/server surfaces. A full memory-profile pass should confirm every operation uses the smallest affected region possible.
- Better long-term shape:
  Define per-operation memory budgets, prefer bbox/crop transforms for every localized edit, add stress tests for high-resolution images, and show user-friendly “too large for this operation” errors rather than risking process or machine instability.
- Revisit trigger:
  Revisit before adding new censor tools, batch-edit features, or high-resolution export paths.
- Deferred because:
  The immediate crash-risk fixes covered the known high-risk server paths and were validated by resource-safety tests; a full image-editor memory audit is larger than this stability slice.

### Debt-19: SAM3 Model Manager E2E fixture stale after `transformers.Sam3Model` switch

- Status: open
- Type: test infrastructure / fixture
- Impact: low
- Risk if ignored:
  Two Playwright tests (`SAM3 prepare shows byte progress and refreshes the card after completion` and the cascading `no model card shows Downloaded badge - only Ready or Missing`) stay red in CI. A persistent red wall masks future real regressions in the same area.
- Related files:
  `tests/e2e/specs/model-manager.spec.ts`
  `tests/e2e/playwright.config.ts`
  `backend/services/model_service.py`
  `backend/model_health.py`
- Observed problem:
  The earlier SAM3 backend used the `sam3==0.1.3` package which expected a single weight file. After the `transformers.Sam3Model.from_pretrained(directory)` switch, `get_sam3_checkpoint_path()` only returns a path when the directory contains both `config.json` and `model.safetensors` (and tokenizer files at runtime). The Playwright fixture still creates a single 32 MB stub `sam3-model.safetensors` file and points `SD_IMAGE_SORTER_SAM3_URLS` at a `file://` URL of that file. After the prepare flow downloads the stub, `health.censor.sam3.checkpoint_path` stays `None` and the model card path never updates. The follow-up test then fails with a Windows `EBUSY` because the stub `.tmp` file from the previous test is still locked.
- Why this is debt:
  Tests should reflect production model layout. Stale fixtures hide real regressions and add noise that trains the team to ignore CI failures. Real users are unaffected because ModelScope delivers a complete checkpoint directory.
- Better long-term shape:
  The fixture should produce a full stub bundle — `config.json` + `model.safetensors` + minimum tokenizer files — packaged as a single archive that the prepare flow extracts into the canonical directory layout. Alternatively, refactor the prepare flow to accept either a single `.safetensors` file or a directory and synthesize missing config files from a built-in template.
- Revisit trigger:
  Next time the SAM3 prepare flow or `get_sam3_checkpoint_path()` is touched, OR before the v3.2 release pass.
- Deferred because:
  Confirmed zero real-user impact (real ModelScope download delivers a complete directory). v3.1.0 publish was the priority and the failure was reproducible only against the stub fixture.

### Debt-20: Auto censor model dropdown labels do not reflect the actually-selected file

- Status: open
- Type: UX contract / user comprehension
- Impact: low
- Risk if ignored:
  Users who download a recommended legacy YOLO file (Wenaka, or any custom `.pt` / `.onnx`) and place it in `data/models/yolo/` see only the generic "YOLO" option in the auto-censor model selector. They cannot tell which file the auto path will use without expanding the Advanced Model Picker, and have already filed at least one report ("why is Wenaka missing?") because of this. Real-user trust signal is weaker than it should be.
- Related files:
  `frontend/index.html` (`#censor-model-type` select around the auto-censor sidebar)
  `frontend/js/censor-edit.js` (`populateCensorModelSelect`, `updateDetectionModelInputs`, `updateSelectedLegacyModelHelp`)
  `frontend/js/lang/en.js` and `frontend/js/lang/zh-CN.js` (`censor.legacyYolo` strings)
- Observed problem:
  The auto censor model-type `<select>` exposes generic options `YOLO / NudeNet / SAM3 / Both`. The currently active legacy file is exposed only inside the collapsed Advanced Model Picker `<details>` section. New users who placed a Wenaka file at the expected path assume the dropdown should show "Wenaka" and conclude the model is missing.
- Why this is debt:
  Surface-level labels hide the actually-selected file. The auto path's job is to be opinionated and obvious — the UI fails the second job today.
- Better long-term shape:
  Append the active legacy file name in parentheses on the `YOLO` and `Both` options (and ideally also display it as a single-line status under the dropdown), e.g. `YOLO (wenaka_yolov8s-seg.onnx)` or `YOLO (custom: my_finetune.pt)`. The label must update dynamically when the user picks a different file in the Advanced Model Picker — i.e., the parenthesized name must always reflect the truly-selected legacy file, not be hard-coded to "Wenaka".
- Revisit trigger:
  Next user-facing release that touches the censor sidebar or detect modal layout.
- Deferred because:
  v3.1.0 publish window was prioritized; the underlying behaviour is correct (Wenaka is detected and recommended automatically), so this is a clarity-only follow-up rather than a regression.

### Debt-21: Optional AI dependency groups are not fully locked per group

- Status: open
- Type: dependency reproducibility / bandwidth control
- Impact: medium
- Risk if ignored:
  Feature Setup can install optional packages with broad version specs such as `torch>=2.0.0`, `fastembed>=0.4.0`, or `ultralytics>=8.4.0`. This preserves lightweight first launch, but the exact download size and transitive dependencies can drift over time and may differ from the full runtime lock.
- Related files:
  `backend/optional_dependencies.py`
  `backend/services/model_service.py`
  `backend/requirements.txt`
  `backend/requirements-core.txt`
- Observed problem:
  The core lock is intentionally small and the full AI lock remains available, but per-feature optional installs are not yet backed by separate lock files such as `requirements-clip.txt`, `requirements-censor.txt`, or `requirements-sam3.txt`. The helper now refuses system-Python installs unless explicitly overridden and skips satisfied packages with minimum-version checks, but it still asks pip to resolve broad specs at Prepare time.
- Why this is debt:
  Lightweight startup solved the immediate bandwidth/storage complaint. For release-grade reproducibility, optional feature groups should also be pinned so a Prepare click downloads a predictable dependency set.
- Better long-term shape:
  Add feature-scoped optional lock files or a locked mapping generated from the same source as `requirements.txt`, then make `optional_dependencies.py` install from those locks. Keep the UI restart reminder because runtime package installs can still require a fresh Python process.
- Revisit trigger:
  Before publishing a release that heavily promotes Feature Setup / Prepare, or when users report optional Prepare downloading unexpected packages.
- Deferred because:
  The urgent user-impacting problem was default first-run size and DB bloat. Implementing, compiling, and testing separate cross-platform optional locks is larger and should be handled as a dedicated dependency packaging pass.
