# SD Image Sorter - Technical Debt Notes

**Updated:** 2026-04-27
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
- Status: open
- Type: data model debt
- Impact: high
- Risk if ignored:
  Future work on sorting, import, duplicate handling, and timeline-like features can silently reintroduce date/order regressions because the field name encourages the wrong assumptions.
- Related files:
  `backend/database.py`
  `backend/image_manager.py`
  `backend/services/sorting_service.py`
  `backend/routers/images.py`
- Observed problem:
  The field name reads like "image creation time", but parts of the product also rely on it as a stable library ordering key.
- Why this is debt:
  Developers will make different assumptions from the field name. Bug fixes become local patches instead of one clear policy.
- Better long-term shape:
  Split semantics explicitly: keep one field for stable library insertion/order behavior and another for source-file or parsed-image time.
- Revisit trigger:
  Revisit before changing default sort semantics, library timelines, duplicate handling, or broader rescan/import policy.
- Deferred because:
  This needs a schema migration and a deliberate sort-policy decision. Changing it casually is higher risk than the bug fixes we were doing.

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
- Observed problem:
  The app stores derived data such as tags, embeddings, AI captions, aesthetic scores, and artist predictions. Whether these should be cleared depends on whether pixel content really changed.
- Why this is debt:
  This is a system invariant, but historically it was enforced by scattered entry-point behavior. The same bug family can come back through a different route.
- Better long-term shape:
  Define one canonical "content changed" policy, route all mutation flows through it, and document it in architecture/invariants docs.
- Revisit trigger:
  Revisit before adding any new save/export/edit path, scan lifecycle change, or external-file reconciliation path.
- Deferred because:
  The mitigation (`content_fingerprint`) exists, but the rule still spans multiple layers and entry points instead of living behind one narrow abstraction.

### Debt-03: Indexed-path overwrite refresh is still entry-point dependent
- Status: open
- Type: lifecycle debt
- Impact: high
- Risk if ignored:
  A future feature can overwrite an indexed file successfully on disk but leave stale DB metadata and stale UI state because the author forgot the library-reconcile step.
- Related files:
  `backend/services/image_service.py`
  `backend/services/censor_service.py`
  `backend/image_manager.py`
  `backend/database.py`
  `frontend/js/image-reader.js`
  `frontend/js/censor-edit.js`
- Observed problem:
  If a feature saves over a file path that is already indexed in the library, the library row must be refreshed immediately. This had to be repaired separately in Reader and Censor Edit flows.
- Why this is debt:
  Every feature author currently has to remember a hidden rule instead of using one enforced shared path.
- Better long-term shape:
  Centralize "save file and reconcile indexed row" into one reusable service path.
- Revisit trigger:
  Revisit before adding any new save/export workflow or any feature that can target existing indexed paths.
- Deferred because:
  The immediate bugs were fixed, but the abstraction boundary is still missing.

### Debt-04: Manual sort session persistence is pragmatic, but not a clean state model
- Status: open
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
  Current behavior is serviceable and recent review did not uncover a direct release-blocking bug worth destabilizing the session system for.

### Debt-05: Gallery selection semantics are not explicit enough
- Status: open
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
  The current model still depends heavily on rendered DOM visibility instead of one explicit selection-scope contract.
- Better long-term shape:
  Define selection scope explicitly, document whether actions operate on visible items, loaded items, filtered results, or all matched rows, and align UI copy with that contract.
- Revisit trigger:
  Revisit before changing pagination/virtualization, adding "select all matching" style features, or broadening batch actions.
- Deferred because:
  The current user-facing bug was corrected, but the deeper selection contract has not been formalized yet.

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

## Suggested Follow-Up Work

These are not "drop everything now" items.

They are the next reasonable debt-reduction steps if the goal shifts from bug fixing to structural hardening.

1. Separate library-order time from source/content time in the schema.
2. Extract one canonical "content changed vs metadata changed" policy into a single reusable service/helper boundary.
3. Centralize indexed-file overwrite reconciliation instead of repairing it per feature.
4. Define one manual-sort session contract covering backend memory, persisted JSON, and frontend storage.
5. Define and document gallery selection scopes explicitly.
6. Tighten path identity behind fewer public helpers and fewer direct path writes.

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
