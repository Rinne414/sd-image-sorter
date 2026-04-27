# E2E and New User Setup Design

## Goal

Validate the v3.1.0 release-hardening work with real Playwright E2E checks, then make the app understandable for new users who do not know which models must be installed, where to install them, or which feature to try first.

## Product principles

- Preserve power-user workflows: huge libraries, precomputed similarity indexing, custom models, isolated destructive task scopes, detector-plus-refiner censor pipeline.
- Do not hide advanced features to protect beginners.
- Beginners must not hit dead-end buttons or generic model errors.
- Missing models, missing indexes, auth walls, and format limitations must explain exactly what is missing and how to fix it.
- Model downloads must not silently pull multi-GB files without a clear size/source warning.
- Download source and mirror selection must be explicit; the app must not silently switch Hugging Face, hf-mirror, ModelScope, Civitai, or custom paths.

## E2E validation design

### Baseline smoke

Run the existing Playwright E2E suite against the release-hardening worktree.

The E2E runner should verify:

- App starts and page loads without critical JavaScript errors.
- Gallery, Auto-Separate, Manual Sort, Censor, Similar, Reader, Prompt Lab, Artist ID, and Model Manager can be opened.
- Scan modal, folder browser, filter modal, select mode, and model setup entry points are visible.
- Browse/folder buttons do not double-trigger on rapid clicks.

If Playwright cannot start because the worktree lacks `backend/venv`, run it with `PW_BACKEND_PYTHON` pointing at the same Python interpreter that already passed backend tests, or create a local worktree venv if needed. This is test-environment setup, not product behavior.

### Changed-flow regression

Add or extend Playwright specs for the release-hardening changes:

- Obfuscation, Censor save, and Reader metadata save do not silently overwrite existing output files.
- Censor save defaults to stripping metadata, and keep-metadata shows the warning.
- Censor missing YOLO/SAM3 states show exact install guidance.
- Censor mobile settings can be opened and closed.
- Similarity missing embeddings shows indexing guidance and does not fall back to slow full-library search.
- Auto-Separate and Manual Sort display saved task scope and resync actions.
- Gallery quick select and delete selected show destructive confirmation with count/examples/permanent-delete wording.
- Reader metadata editor is enabled only for trusted library images and warns that unsupported hidden metadata may be discarded.

### New-user readiness checks

Add E2E checks for empty/new-user state:

- Fresh localStorage and empty DB show a clear first-step path.
- User can identify the first three actions within the UI:
  1. scan a folder,
  2. set up AI models for AI features,
  3. try safe workflows without model dependencies.
- Model Manager / Setup Center is discoverable without knowing about the small existing lower-left button.
- Disabled feature buttons have nearby `Fix this` or `Set up model` actions that open the correct setup card.
- All missing-model states mention the exact model, destination folder, accepted extensions, and rescan action.

E2E should mock model status/download responses for multi-GB models or login-required sources. It should not actually download large model files.

## Setup Center design

Add an in-app **Setup Center / Model Setup Wizard** that explains setup by user goal, not by internal model name.

### Entry points

The Setup Center should be reachable from:

- Gallery empty state: `Set up AI models`.
- A visible top/nav/side entry labeled `Setup` or `Setup Center`.
- Censor missing YOLO/SAM3 disabled states via `Fix this`.
- Similarity missing embeddings via `Start indexing` and setup explanation.
- Tagging missing model/runtime messages.
- Artist ID missing model/experimental banner.

The existing Model Manager can remain as an advanced/details view, but it must not be the only discoverable entry point.

### Goal-first wizard sections

The first screen should answer: `What do you want to do?`

Sections:

- **Scan and browse images** — no model required.
- **Tag images** — needs a tagger model such as WD14, ToriiGate, PixAI, or Camie.
- **Censor images** — needs YOLO; SAM3 is optional for refinement/text-guided segmentation.
- **Find similar images** — needs embeddings/indexing first; not the same as downloading a model.
- **Identify artists** — experimental; needs an artist model or supported fallback.
- **Read/edit metadata** — no model required; edited metadata saving is PNG-first and may discard unsupported hidden metadata.

### Model cards

Each model/setup card should include:

- Status: installed, missing, downloading, needs manual download, blocked by login, or experimental.
- Human explanation: one sentence saying why the model is needed.
- Required features: which UI actions depend on it.
- Size/time hint where known.
- Destination folder.
- Accepted filenames/extensions.
- Available sources.
- Actions.

Available sources should be explicit and model-specific:

- Hugging Face when supported.
- hf-mirror when Hugging Face can be mirrored, with explanation that it maps through `HF_ENDPOINT=https://hf-mirror.com`.
- ModelScope when the model has an existing supported ModelScope source.
- Civitai/manual when automatic download is blocked by login/auth wall.
- Manual install when auto-download is not supported.

The UI should not guess unknown direct download URLs. It may show known source pages, known repository IDs, or manual steps already represented in backend model status/config.

Actions:

- Download / Prepare when backend auto-download is supported.
- Use hf-mirror and retry when Hugging Face is available and mirror use is explicit.
- Open source page when a safe external source URL is already known.
- Copy destination folder.
- Rescan models.
- Show manual steps.

### No-dead-end gating

Feature buttons should not look runnable when prerequisites are guaranteed missing.

Required behavior:

- Censor detect/auto-censor buttons requiring YOLO show disabled/guided state with `Fix this`.
- SAM3 refine/text-guided buttons requiring SAM3 show disabled/guided state with `Fix this`.
- Similarity search blocks cleanly until embeddings/indexing are ready and offers `Start indexing`.
- Tagging model missing/runtime blocked state links to the relevant setup card.
- Artist ID remains clearly labeled experimental and links to model setup.
- Reader metadata edit states explain that no AI model is needed but PNG is the supported edited-metadata format.

### Beginner wording

Use short, direct language:

- `YOLO finds the parts of the image to censor. Auto Censor cannot run until YOLO is installed.`
- `SAM3 is optional. It improves existing detection boxes or segments from text prompts.`
- `Similarity search needs an index first. Click Start indexing once; search is fast after that.`
- `If Hugging Face is slow or blocked, choose hf-mirror and retry.`
- `If Civitai requires login, open the source page, download manually, then put the file here and click Rescan.`

All user-facing strings added for this work must exist in English and Chinese language files.

## Backend contract design

Prefer extending existing model endpoints instead of creating a second model system.

Extend `/api/models/status` and/or `/api/models/censor/setup-status` with frontend-ready fields when available:

- `purpose`
- `required_for`
- `size_hint`
- `sources[]`
  - `id`
  - `label`
  - `type`: huggingface, hf-mirror, modelscope, civitai, manual
  - `url` only when already known and safe to expose
  - `auto_download_supported`
  - `requires_login`
- `destination_folder`
- `accepted_extensions`
- `manual_steps`
- `can_auto_download`
- `blocked_reason`

Do not hardcode arbitrary or guessed URLs. Use existing config, existing model manager metadata, known README/model docs, or explicit source definitions in code.

## Frontend design

Add a Setup Center modal/panel that reuses current glassmorphism style and existing i18n/confirm/toast patterns.

State flow:

1. Load setup status from model endpoints plus similarity stats/progress.
2. Render goal cards and model cards.
3. Clicking `Fix this` from a feature opens Setup Center focused on the relevant card.
4. Clicking `Download/Prepare` calls existing prepare endpoint.
5. Clicking `Use hf-mirror and retry` explicitly selects the mirror for that action or shows exact env/config instructions if runtime switching is not supported.
6. Clicking `Rescan models` reloads setup status.

Avoid large refactors. Add small helpers if needed for rendering setup cards, source labels, and actions.

## Testing design

### Playwright

Add E2E specs for:

- Setup Center discoverability from empty Gallery and nav/topbar.
- Missing YOLO/SAM3 setup card content and button gating.
- Model source options render for mocked Hugging Face / hf-mirror / ModelScope / manual responses.
- Civitai/login-required response renders manual steps instead of generic crash.
- Similarity missing-index setup guidance.
- Release-hardening changed flows: overwrite confirmations, saved scopes, delete selected confirmation, browse no duplicate trigger.

Use mocked API routes for model status and prepare responses. Do not download real model files.

### Backend

Add focused tests for model setup metadata fields if backend endpoints are extended.

### Frontend checks

Run `node --check` on modified JS files and existing backend tests after changes.

### Manual smoke

After E2E passes, manually smoke:

- First-run empty state.
- Setup Center navigation.
- Censor missing model guidance.
- Similarity indexing guidance.
- Model Manager advanced/details access.

## Acceptance criteria

- A new user with empty DB and missing models can understand the first three steps without reading README.
- Every model-dependent disabled feature explains what is missing and offers a direct setup path.
- Model cards list supported sources and manual install destinations clearly.
- No feature silently switches download source, route, or model path.
- No multi-GB download begins without source/size warning.
- Existing power-user features remain available.
- Playwright E2E results are reported with pass/fail/blockers and artifacts where available.
