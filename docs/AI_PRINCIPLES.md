# AI Principles For This Repo

**Updated:** 2026-05-01
**Purpose:** Give future AI agents a local decision framework so they do not overwrite deliberate product choices with generic "best practice" cleanup.

## Why This Exists

This repo has places where a design, wording, workflow, or data behavior may look unusual on first read.

Sometimes that is because:

- the user explicitly wanted it that way
- the workflow protects a real user habit
- the local product constraint matters more than generic elegance
- a "cleaner" change would quietly break mental models or reintroduce an old bug

This file exists to make future AI work less arrogant and more correct.

## Decision Order

When making decisions, use this order of authority:

1. Explicit user instruction in the current task
2. `AGENTS.md`
3. `docs/AI_DECISION_LOG.md`
4. Existing documented project invariants and architecture docs
5. Existing product behavior that is clearly intentional
6. Generic engineering/design best practices

If generic best practice conflicts with local intent, local intent wins unless there is a real bug, real user harm, or explicit approval to change it.

## Evidence Tiers

Not all history sources are equally authoritative.

### Tier 1. Shipped or currently enforced truth

Use this tier for active decisions:

- current code
- current tests / E2E coverage
- `CHANGELOG.md`
- release notes
- public GitHub commit / release pages that match the repo state

If a rule is backed by Tier 1 evidence, future AI should treat it as active product behavior unless a newer decision supersedes it.

### Tier 2. Documented design intent

Useful, but not automatically equal to shipped truth:

- `.plans/`
- hardening specs
- architecture notes that describe intended direction

Use Tier 2 to guide unfinished work or explain why something is heading a certain way.

Do not use Tier 2 to silently overwrite conflicting Tier 1 behavior.

### Tier 3. Weak or inaccessible context

Examples:

- remembered chat history without a saved local record
- paraphrased issue discussions with no link or file
- second-hand summaries that cannot be checked

Tier 3 can suggest where to investigate next, but it is not binding evidence.

If you cannot verify it, do not record it as an active repo decision.

## Document Boundaries

Use the three AI docs for different jobs.

### `docs/AI_PRINCIPLES.md`

Use this file for:

- high-level repo decision rules
- product-level priorities
- stable UX / workflow philosophy
- evidence rules

Do not use this file for:

- temporary QA checklists
- current test counts
- one-off release to-dos
- speculative future debt

### `docs/AI_DECISION_LOG.md`

Use this file for:

- concrete intentional defaults
- non-obvious workflow semantics
- path / save / overwrite / scope / data invariants
- repo-local choices another AI might otherwise "correct"

### `docs/TECHNICAL_DEBT_NOTES.md`

Use this file for:

- confirmed structural debt
- debt that is intentionally deferred
- audit targets that still need validation

Do not treat technical debt notes as active product behavior unless the same rule is also supported by current code or a decision-log entry.

## User-Provided Product And UX Principles

Source: explicit user instruction in this repo workflow on 2026-04-27.

These are direct local product preferences, not generic design advice.

### 1. The product must work for both power users and complete beginners

Do not assume the user knows code, paths, runtimes, or model jargon.

Keep workflows understandable for beginners without dumbing the product down for advanced users.

### 2. End-to-end local workflow matters

Prefer keeping the main SD workflow inside this app:

- scan
- view
- tag
- sort
- censor
- find similar
- generate prompts

Do not casually push users into external tools for steps this product already covers or clearly intends to cover.

### 3. Comfort beats raw speed, but stability is mandatory

The app should feel comfortable and predictable to use.

Do not chase speed by making the workflow harsher, less clear, or easier to crash.

If two solutions are both stable, prefer the one that feels better to use.

### 4. Desktop-first bilingual layout is intentional

Target environments are desktop and laptop usage, especially:

- English
- `zh-CN`
- smaller desktop screens such as `1366x768`
- larger desktop screens

Do not distort the UI around mobile-first assumptions if that harms desktop workflows.

Check that long English strings do not break layout.

Technical keywords may remain in English when translating them would reduce accuracy or make the UI worse.

### 5. Functional controls should dominate space, not explanations

Useful controls should get the prime visible space.

Descriptions, warnings, and model help text should stay compact unless the user is actively drilling into details.

### 6. Progressive disclosure beats always-expanded explanation blocks

Show the minimum needed first.

Let users open details, advanced options, and secondary explanations when they need them.

Do not let explanation-heavy UI crowd out the actual work surface.

### 7. Settings that do not need visual context can move out of the main work area

If a setting does not require looking at the image or live workspace while adjusting it, a popup, modal, drawer, or secondary panel is usually better than permanent inline occupation.

### 8. Dangerous actions must be harder to misclick than common actions

Clear, delete, overwrite, and similar dangerous actions should be separated from common actions.

Save, export, continue, and other common productive actions should be easy to find and use.

### 9. Compact icon actions are allowed, but only when the meaning is truly obvious

Icon-only or emoji-first buttons are acceptable when they genuinely save space and remain obvious across English and Chinese UI.

When using compact/icon-only actions, provide accessible labels such as tooltip text, `title`, or equivalent screen-reader-friendly naming.

Do not force text labels everywhere if the icon is already self-explanatory, but do not hide meaning behind cute icons either.

### 10. Do not remove existing features without explicit approval

When reorganizing the UI, move, regroup, collapse, or progressively disclose features if needed.

Do not silently delete existing capability just to make the interface cleaner.

### 11. Package-local self-updates must stay user-controlled and state-preserving

For this product, in-app updates are a manual convenience workflow, not a silent app-store style mechanism.

Keep these rules aligned unless the user explicitly changes product direction:

- do not auto-check for updates on startup
- do not auto-download or auto-apply updates without an explicit user action
- preserve package-local user/runtime state such as `data/`, downloaded models, caches, and updater working files
- keep advanced update-channel override as an opt-in path for advanced users or forks, not as forced complexity for normal users
- if the default GitHub update path is unreachable, say so honestly and tell the user to use VPN rather than pretending there is a seamless default mirror

### 12. Heavy local AI must be resource-aware, not blanket-disabled

For local model features, stability and speed are both product requirements.

Prefer targeted resource controls:

- shared gates for heavyweight model load/inference critical sections
- chunked preprocessing/search instead of whole-library or whole-batch memory spikes
- GPU headroom checks and CPU fallback only when GPU is unsafe
- explicit payload/pixel budgets for large image edits

Do not make every workflow slower, disable GPU by default, or serialize cheap metadata/UI work just to hide a crash bug in one heavy AI path.

## Core Principles

### 1. Preserve deliberate local intent

If something looks non-standard but works, do not assume it is wrong just because you can imagine a cleaner pattern.

### 2. Do not silently normalize special workflows

Do not "simplify", "modernize", "clean up", or "make more standard" a workflow unless you can explain:

- what problem the current workflow causes
- why the new workflow is better for this product specifically
- what behavior or user habit will change

### 3. Stability beats cleverness

When a change touches library identity, file lifecycle, sort order, save behavior, path resolution, or persisted session state, prefer the safer and more explicit approach.

### 4. User mental model beats abstract purity

If a technically neat change makes the product harder to predict, it is probably the wrong change.

### 5. Explain non-obvious choices

If you make or preserve a decision that another AI might later "correct", record it in `docs/AI_DECISION_LOG.md`.

### 6. Supersede, do not erase

If an old decision is no longer valid, do not quietly rewrite history.

Add a new log entry that says:

- what changed
- why the previous decision is no longer correct
- what replaces it

### 7. Separate bug fixes from preference changes

Before changing behavior, classify the work:

- bug fix
- workflow change
- data-model change
- refactor
- cleanup

Do not smuggle a preference change inside a bug fix.

### 8. Evidence before redesign

Do not redesign because something "feels better".

Use at least one of:

- a user complaint
- a reproducible bug
- a documented inconsistency
- a measured performance issue
- an invariant that is currently too easy to violate

If a design doc and current shipped behavior disagree, record the mismatch explicitly instead of quietly rewriting the current behavior to match the doc.

### 9. Migration risk is real work

If a decision touches schema semantics, saved sessions, path identity, file overwrite behavior, or API contracts, treat migration risk as part of the change, not as an afterthought.

### 10. If uncertain, preserve behavior first

When context is incomplete, preserving known working behavior is usually safer than "improving" it.

## Historical Repo-Specific Principles

These are not abstract style rules.

They are patterns that show up repeatedly in release history, validation notes, and shipped fixes.

### A. Truthful UX beats optimistic UX

This repo repeatedly corrected UI that sounded nicer than reality:

- clipboard import pretending metadata was safe
- model/runtime surfaces hiding actual fallback backend
- progress reporting hiding what was skipped, unreadable, or still running
- format warnings implying JPG/WebP behave like PNG
- model capability wording implying more than the real detector can do

If the choice is between a flattering UI and an honest UI, choose the honest UI.

### B. Do not silently switch important user intent

This repo has repeated design pressure toward explicitness.

Do not silently change:

- selected model
- execution route
- download source/provider
- metadata mode
- output path
- task scope
- destructive target set

If a switch is necessary, surface it and ask.

### C. Preserve power-user scale

This product explicitly serves users with huge SD libraries.

Do not "fix" performance or safety by quietly weakening:

- total library size support
- metadata extraction richness
- advanced model support
- paging/streaming behavior
- precomputed fast-search architecture

Safety limits should protect a crash-prone operation, not shrink the product into a toy.

### D. Broken inputs should be quarantined, not normalized into normal workflows

If an image is corrupt, truncated, missing, or unreadable, the product direction is to mark it clearly and keep it out of normal workflows by default.

Do not let bad inputs silently behave like good inputs just to keep the UI looking smooth.

### E. Early usefulness beats blocked completeness

For long-running tasks like scan/import, the historical direction is:

- make the library usable earlier
- keep the remaining work going in background
- tell the user clearly what is still happening

Do not block the whole workflow waiting for perfect completeness if safe progressive usability is possible.

### F. Original-file workflows and browser-upload workflows are not equivalent

This repo already learned the hard way that browser clipboard/upload paths can be lossy.

Do not pretend:

- clipboard import is equivalent to original-file access
- dragged browser blobs preserve the same metadata guarantees as source files
- all output formats preserve metadata equally

When the path is lossy, say so clearly.

### G. Local-first is a product assumption, not an incidental implementation detail

This app is intentionally local-first and local-only in its current product shape.

Do not casually redesign around:

- cloud upload assumptions
- account/login assumptions
- remote-service dependency for core workflows
- network-first security semantics that ignore the local-only product context

If the product direction changes, that should be an explicit product decision, not an accidental refactor side effect.

### H. Routers translate HTTP; services own lifecycle and side effects

Backend routers should stay thin. They may parse request/response contracts, convert domain errors into HTTP responses, and schedule framework background tasks.

Do not put these in routers when a service can own them:

- background job progress dictionaries or locks
- model inventory and preparation workflows
- external download / archive validation side effects
- domain decisions that need non-HTTP tests

If a route needs compatibility state for old callers, expose it through a service-owned seam instead of creating a second router-owned lifecycle.

### I. Archive intake must be bounded before extraction

Any code that downloads, validates, or extracts zip/tar archives must reject unsafe paths, excessive entry counts, and excessive uncompressed size before writing payload files.

This applies even for local-first or release-owned flows:

- update archives
- model/runtime bundles
- third-party GitHub/HuggingFace/Civitai assets
- future import/export package formats

Do not rely on `extractall()` plus string-prefix checks for safety. Prefer `Path.relative_to()`/normalized archive names and small, testable extraction helpers.

### J. Dynamic UI text owns its translation binding

Static `data-i18n` belongs to static copy. Runtime state-owned labels must either update their `data-i18n` key to the active state or remove the static binding before writing generated text.

This matters because `ui-refresh.js` replays global translations after DOM mutations. A stale key can make visible text lie even when aria/title/state already changed.

Examples that must preserve this rule:

- move/copy action buttons
- queue/filter summaries generated from current state
- progress/status labels that are not a single static translation key

## What Future AI Must Not Do

- Do not remove a special option because it looks redundant without checking why it exists.
- Do not rename user-facing behavior to something broader or cleaner if the underlying scope is narrower.
- Do not convert workflow-specific logic into generic logic if the workflow-specific constraint is the whole point.
- Do not replace local product decisions with framework fashion.
- Do not assume unusual wording is accidental if it matches actual behavior better than the generic alternative.
- Do not change data semantics casually just because the current field names are messy.

## When You Must Write A Decision Log Entry

Add or update `docs/AI_DECISION_LOG.md` when you:

- preserve a non-obvious UX or workflow choice
- introduce a product-specific exception to a generic pattern
- change save / overwrite / move / copy semantics
- change selection / filter / sort semantics
- change path identity or path normalization rules
- change schema meaning or field interpretation
- add an invariant another AI might otherwise violate later

## Minimum Quality Bar For A Decision

A valid recorded decision should answer:

- what was decided
- why it was decided
- what future AI should not "fix"
- what evolution is still allowed
- where in the code this matters

## Pre-Decision Checklist

Before making a major product, UX, architecture, or data decision:

1. Read `AGENTS.md`
2. Read this file
3. Read `docs/AI_DECISION_LOG.md`
4. Read the relevant architecture / invariant docs
5. State the current invariant or workflow you are about to touch
6. State why the change is necessary
7. Decide whether this needs a new log entry

## Short Rule

For this repo, "better" is not "more generic".

For this repo, "better" means:

- safer for real user workflows
- more truthful about what the app actually did and can actually do
- more consistent with local intent
- more explicit when a workflow is destructive, lossy, or being redirected
- still viable for very large SD libraries
- less likely to reintroduce the same class of bug
- easier for the next AI to understand without guessing
