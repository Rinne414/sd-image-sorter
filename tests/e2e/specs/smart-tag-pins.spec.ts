import { expect, test, type Page } from '../fixtures/click-ledger'

/**
 * Characterization pins for the smart-tag.js god-file (1,246 lines) — "step 0" of a
 * later decomposition (mirrors the shipped gallery.js, app.js, image-reader.js,
 * similar.js, censor, dataset, autosep, manual-sort, prompt-lab, v321-ui splits).
 *
 * ASSEMBLY SHAPE / VERDICT (recorded so the split picks the right pattern):
 *   smart-tag.js is a SINGLE strict-mode IIFE — `(function () { 'use strict'; ... })()`
 *   — that publishes exactly ONE global:
 *
 *       window.SmartTag = { open, openScoped, close, run, cancel }
 *
 *   It holds genuine CLOSURE-PRIVATE module state (progressTimer, activeJobId,
 *   pipelineQueuedSince, taggerModelCatalog, taggerModelDefault, pendingExplicitScope,
 *   pollFailureCount) shared across ~40 top-level helper functions. NONE of those
 *   helpers or state vars are reachable from page.evaluate — only the 5 window.SmartTag
 *   methods + the DOM they mutate are observable. So every pin below drives the module
 *   through window.SmartTag + the #smart-tag-modal DOM with route-mocked /api/* — never
 *   by poking internals.
 *
 *   Unlike queue-solitaire.js's do-NOT-split exemption (which overrides window.open /
 *   window.close builtins and would const-redeclare on unwrap), smart-tag.js overrides
 *   NO builtins and its closure state is ordinary. It IS splittable — by extracting the
 *   helper families into files that share one classic-script closure (the censor /
 *   autosep precedent), keeping the single `window.SmartTag = {...}` publish at the end.
 *   The future split should keep the per-file `'use strict'` directive (image-reader
 *   precedent), since this file is strict.
 *
 * RUNTIME CONSUMERS the split MUST keep working (grep-verified as the only ones):
 *   - frontend/js/v321/tagger-tabs.js  -> window.SmartTag.openScoped({ imageIds }) and
 *                                          window.SmartTag.open()
 *   - frontend/js/dataset/events.js    -> window.SmartTag.open()
 *   backend/tests/test_frontend_contract.py additionally pins literal substrings of this
 *   file (vlm_grounding / toriigate_grounding / image_paths: sources.imagePaths /
 *   selection_token: sources.selectionToken / dataset_scan_token: sources.datasetScanToken /
 *   /api/smart-tag/results / model?.default_threshold). Those literals must survive the
 *   split verbatim; this spec pins the RUNTIME behaviour behind them.
 *
 * No models are downloaded and no DB is seeded: /api/tagger/models, /api/smart-tag/*,
 * and /api/vlm/* are all route-mocked. This MUST pass before AND after the refactor.
 */

test.describe.configure({ mode: 'serial' })
test.use({ viewport: { width: 1366, height: 768 } })

type PathCaptionResult = {
  path: string
  caption: string
  booru_text: string
  nl_text: string
}

type SmartTagDatasetMaker = {
  captionEdits: Map<number, string>
  nlEdits: Map<number, string>
}

declare global {
  interface Window {
    DatasetMaker: SmartTagDatasetMaker
  }
}

/**
 * The route-mock baseline every pin starts from. Registered in beforeEach; individual
 * pins re-register (page.route wins by most-recent registration) to override.
 *
 * The tagger catalog deliberately carries TWO booru models with DISTINCT model-specific
 * defaults (so the threshold/max-tags default pin can tell them apart) plus one
 * natural-language model (so the booru-only filter is observable).
 */
async function installBaseMocks(page: Page): Promise<void> {
  await page.route('**/api/tagger/models', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        default: 'model-a',
        models: [
          {
            name: 'model-a',
            recommended: true,
            best_for: 'A best',
            default_threshold: 0.35,
            default_character_threshold: 0.85,
            default_copyright_threshold: 0.4,
            default_max_tags_per_image: 40,
            runtime_safety_tier: 'stable',
          },
          {
            name: 'model-b',
            best_for: 'B best',
            default_threshold: 0.5,
            default_character_threshold: 0.7,
            default_copyright_threshold: 0.6,
            default_max_tags_per_image: 25,
            runtime_safety_tier: 'stable',
          },
          // Natural-language model: excluded from BOTH booru <select>s by
          // isBooruTaggerModel (role !== 'natural_language' && backend !== 'toriigate').
          {
            name: 'torii-nl',
            smart_tag_role: 'natural_language',
            runtime_backend: 'toriigate',
            best_for: 'NL captions',
          },
        ],
      }),
    }))
  // Idle progress: resumeActiveSmartTagJob() finds nothing to re-attach.
  await page.route('**/api/smart-tag/progress**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'idle' }) }))
  // A configured cloud endpoint -> the "Ollama required" banner stays hidden.
  await page.route('**/api/vlm/settings', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ endpoint: 'https://example.invalid/v1', use_vertex: false }),
    }))
  await page.route('**/api/vlm/local-models/recommended', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ollama_installed: false, ollama_running: false }),
    }))
}

/** Land on the app and wait for the SmartTag surface + the modal helpers to exist. */
async function gotoSmartTag(page: Page): Promise<void> {
  await page.goto('/')
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() => {
    const w = window as any
    return !!w.SmartTag
      && typeof w.SmartTag.open === 'function'
      && typeof w.SmartTag.openScoped === 'function'
      && typeof w.showModal === 'function'
  })
}

/** Open the modal scoped to an explicit id set and wait for both taggers to populate. */
async function openScopedAndReady(page: Page, imageIds: number[]): Promise<void> {
  await page.evaluate((ids) => (window as any).SmartTag.openScoped({ imageIds: ids }), imageIds)
  await expect(page.locator('#smart-tag-modal')).toHaveClass(/visible/)
  // Two booru models -> two options in tagger-1 (the NL model is filtered out).
  await expect(page.locator('#smart-tag-tagger-1 option')).toHaveCount(2)
}

async function openDatasetAndReady(page: Page): Promise<void> {
  await page.evaluate(() => (window as any).SmartTag.open())
  await expect(page.locator('#smart-tag-modal')).toHaveClass(/visible/)
  await expect(page.locator('#smart-tag-tagger-1 option')).toHaveCount(2)
}

async function seedLocalCaptionItems(
  page: Page,
  items: Array<{ id: number; path: string; booru: string; nl: string }>,
): Promise<void> {
  await page.evaluate((seedItems) => {
    const dm = (window as any).DatasetMaker
    dm.imageIds = seedItems.map((item) => item.id)
    dm.activeId = seedItems[0]?.id ?? null
    dm.localItemPaths.clear()
    dm.captions.clear()
    dm.captionEdits.clear()
    dm.nlCaptions.clear()
    dm.nlEdits.clear()
    for (const item of seedItems) {
      dm.localItemPaths.set(item.id, item.path)
      dm.captions.set(item.id, item.booru)
      dm.nlCaptions.set(item.id, item.nl)
      dm.captionType.set(item.id, 'both')
    }
  }, items)
}

async function installCompletedPathJob(
  page: Page,
  jobId: string,
  mergeStrategy: 'replace' | 'append',
  results: Array<Partial<PathCaptionResult>>,
): Promise<void> {
  await page.route('**/api/smart-tag/start', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ job_id: jobId, status: 'running', active: true, total: results.length }),
    }))
  await page.route('**/api/smart-tag/progress**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        job_id: jobId,
        status: 'completed',
        active: false,
        total: results.length,
        processed: results.length,
        succeeded: results.length,
        failed: 0,
        caption_result_count: results.length,
        settings: { merge_strategy: mergeStrategy, enable_vlm: true, natural_language_mode: 'vlm' },
      }),
    }))
  await page.route('**/api/smart-tag/results**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        job_id: jobId,
        offset: 0,
        limit: 1000,
        total: results.length,
        results,
        has_more: false,
      }),
    }))
}

test.beforeEach(async ({ page }) => {
  await installBaseMocks(page)
  await gotoSmartTag(page)
})

// ---------------------------------------------------------------------------
// 1. Public surface — the window.SmartTag other modules depend on.
// ---------------------------------------------------------------------------

test('window.SmartTag exposes exactly {open, openScoped, close, run, cancel} as functions and is unsealed', async ({ page }) => {
  const probe = await page.evaluate(() => {
    const S = (window as any).SmartTag
    return {
      isObject: S !== null && typeof S === 'object',
      keys: Object.keys(S).sort(),
      allFns: ['open', 'openScoped', 'close', 'run', 'cancel'].every((k) => typeof S[k] === 'function'),
      sealed: Object.isSealed(S),
      identity: (window as any).SmartTag === S,
    }
  })

  expect(probe.isObject).toBe(true)
  expect(probe.keys).toEqual(['cancel', 'close', 'open', 'openScoped', 'run'])
  expect(probe.allFns).toBe(true)
  // Not sealed: a future split can rebuild the publish object incrementally.
  expect(probe.sealed).toBe(false)
  expect(probe.identity).toBe(true)
})

// ---------------------------------------------------------------------------
// 2. open()/close() lifecycle — .visible toggle + progress reset on close.
// ---------------------------------------------------------------------------

test('open() shows the modal via window.showModal and close() hides it, resets the progress UI, and re-enables Run', async ({ page }) => {
  await page.evaluate(() => (window as any).SmartTag.open())
  await expect(page.locator('#smart-tag-modal')).toHaveClass(/visible/)
  // Progress region hidden until a job starts; Run is a real button.
  await expect(page.locator('#smart-tag-progress')).toBeHidden()
  await expect(page.locator('#btn-smart-tag-run')).toBeVisible()

  // Simulate a mid-run UI state, then close and confirm the reset seam runs.
  await page.evaluate(() => {
    const fill = document.getElementById('smart-tag-progress-fill') as HTMLElement
    const txt = document.getElementById('smart-tag-progress-text') as HTMLElement
    fill.style.width = '55%'
    txt.textContent = 'Tagging 5/10'
    ;(document.getElementById('smart-tag-progress') as HTMLElement).hidden = false
    ;(document.getElementById('btn-smart-tag-run') as HTMLButtonElement).disabled = true
    ;(window as any).SmartTag.close()
  })

  await expect(page.locator('#smart-tag-modal')).not.toHaveClass(/visible/)
  const after = await page.evaluate(() => ({
    hidden: (document.getElementById('smart-tag-progress') as HTMLElement).hidden,
    width: (document.getElementById('smart-tag-progress-fill') as HTMLElement).style.width,
    text: (document.getElementById('smart-tag-progress-text') as HTMLElement).textContent,
    runDisabled: (document.getElementById('btn-smart-tag-run') as HTMLButtonElement).disabled,
  }))
  expect(after.hidden).toBe(true)
  expect(after.width).toBe('0%')
  expect(after.text).toBe('')
  expect(after.runDisabled).toBe(false)
})

// ---------------------------------------------------------------------------
// 3. openScoped's one-shot Gallery scope wins over Dataset Maker and clears on close.
// ---------------------------------------------------------------------------

test('openScoped scope overrides the Dataset Maker count/suffix and is cleared by close (one-shot)', async ({ page }) => {
  // Seed a Dataset Maker gallery id so the unscoped open has a non-zero baseline.
  await page.evaluate(() => {
    const dm = (window as any).DatasetMaker
    if (dm) dm.imageIds = [555]
  })

  // Unscoped open reflects Dataset Maker: count 1, "in Dataset Maker" wording.
  await page.evaluate(() => (window as any).SmartTag.open())
  await expect(page.locator('#smart-tag-image-count')).toHaveText('1')
  const dmSuffix = (await page.locator('#smart-tag-image-count-suffix').textContent())?.toLowerCase() ?? ''
  expect(dmSuffix).toContain('dataset maker')
  await page.evaluate(() => (window as any).SmartTag.close())

  // Scoped open wins outright: count 3, "selected images" wording.
  await page.evaluate(() => (window as any).SmartTag.openScoped({ imageIds: [10, 11, 12] }))
  await expect(page.locator('#smart-tag-image-count')).toHaveText('3')
  const scopedSuffix = (await page.locator('#smart-tag-image-count-suffix').textContent())?.toLowerCase() ?? ''
  expect(scopedSuffix).toContain('selected')
  expect(scopedSuffix).not.toContain('dataset maker')

  // close() clears the one-shot scope; the next plain open falls back to Dataset Maker.
  await page.evaluate(() => (window as any).SmartTag.close())
  await page.evaluate(() => (window as any).SmartTag.open())
  await expect(page.locator('#smart-tag-image-count')).toHaveText('1')
  const backSuffix = (await page.locator('#smart-tag-image-count-suffix').textContent())?.toLowerCase() ?? ''
  expect(backSuffix).toContain('dataset maker')
})

// ---------------------------------------------------------------------------
// 4. Tagger catalog populate — booru-only filter, leading "Off", recommended/best_for.
// ---------------------------------------------------------------------------

test('the tagger selects list only booru models, Tagger 2 leads with an empty "Off" option, and text carries recommended + best_for', async ({ page }) => {
  await openScopedAndReady(page, [10])

  const t1 = await page.locator('#smart-tag-tagger-1 option').evaluateAll((els) =>
    els.map((el) => ({ value: (el as HTMLOptionElement).value, text: el.textContent ?? '' })))
  // Only the two booru models (torii-nl is filtered out).
  expect(t1.map((o) => o.value)).toEqual(['model-a', 'model-b'])
  // Recommended + best_for surfaced directly in the visible option text.
  expect(t1[0].text).toContain('model-a')
  expect(t1[0].text).toContain('A best')
  expect(t1[0].text.toLowerCase()).toContain('recommended')
  expect(t1[1].text).toContain('B best')
  expect(t1[1].text.toLowerCase()).not.toContain('recommended')

  const t2 = await page.locator('#smart-tag-tagger-2 option').evaluateAll((els) =>
    els.map((el) => (el as HTMLOptionElement).value))
  // Tagger 2 = leading "Off" (empty value) + the two booru models.
  expect(t2).toEqual(['', 'model-a', 'model-b'])

  // Default selection follows the catalog default.
  await expect(page.locator('#smart-tag-tagger-1')).toHaveValue('model-a')
  await expect(page.locator('#smart-tag-tagger-2')).toHaveValue('')
})

// ---------------------------------------------------------------------------
// 5. Model-specific threshold + max-tags defaults on populate and on tagger change.
// ---------------------------------------------------------------------------

test('untouched threshold + max-tags inputs adopt the selected model\'s catalog defaults, and re-adopt on tagger change', async ({ page }) => {
  await openScopedAndReady(page, [10])

  // model-a defaults applied on populate (copyright 0.4 proves the catalog default beat
  // the static HTML value="0.35"; trailing-zero trim yields "0.4").
  await expect(page.locator('#smart-tag-general-threshold')).toHaveValue('0.35')
  await expect(page.locator('#smart-tag-character-threshold')).toHaveValue('0.85')
  await expect(page.locator('#smart-tag-copyright-threshold')).toHaveValue('0.4')
  await expect(page.locator('#smart-tag-max-tags')).toHaveValue('40')

  // Switching the primary tagger re-applies that model's defaults (inputs untouched).
  await page.locator('#smart-tag-tagger-1').selectOption('model-b')
  await expect(page.locator('#smart-tag-general-threshold')).toHaveValue('0.5')
  await expect(page.locator('#smart-tag-character-threshold')).toHaveValue('0.7')
  await expect(page.locator('#smart-tag-copyright-threshold')).toHaveValue('0.6')
  await expect(page.locator('#smart-tag-max-tags')).toHaveValue('25')
})

// ---------------------------------------------------------------------------
// 6. syncSmartTagVoteUi — consensus gate, no-duplicate Tagger 2, section enable/disable.
// ---------------------------------------------------------------------------

test('consensus mode unlocks only with two distinct taggers, Tagger 2 cannot mirror Tagger 1, and unchecking Booru disables its section', async ({ page }) => {
  await openScopedAndReady(page, [10])

  // Single tagger -> consensus (Tag merge mode) is disabled.
  await expect(page.locator('#smart-tag-consensus-mode')).toBeDisabled()
  // Tagger 2's model-a option is disabled because it equals Tagger 1.
  const t2AOptionDisabled = await page.evaluate(() => {
    const sel = document.getElementById('smart-tag-tagger-2') as HTMLSelectElement
    return Array.from(sel.options).find((o) => o.value === 'model-a')?.disabled
  })
  expect(t2AOptionDisabled).toBe(true)

  // Pick a second, distinct tagger -> consensus unlocks.
  await page.locator('#smart-tag-tagger-2').selectOption('model-b')
  await expect(page.locator('#smart-tag-consensus-mode')).toBeEnabled()

  // Unchecking the Booru section marks it disabled and disables its selects.
  await page.locator('#smart-tag-enable-wd14').uncheck()
  await expect(page.locator('#smart-tag-booru-section')).toHaveClass(/is-disabled/)
  await expect(page.locator('#smart-tag-tagger-1')).toBeDisabled()
})

// ---------------------------------------------------------------------------
// 7. readForm/run — single-tagger POST payload shape.
// ---------------------------------------------------------------------------

test('run() posts the single-tagger payload with tagger_model set, consensus_min 1, model-default thresholds, and no taggers array', async ({ page }) => {
  let startPayload: any = null
  await page.route('**/api/smart-tag/start', (route) => {
    startPayload = route.request().postDataJSON()
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ job_id: 'pin-single', status: 'completed', active: false, total: 3, processed: 3, succeeded: 3, failed: 0 }),
    })
  })

  await openScopedAndReady(page, [10, 11, 12])
  // Booru-only run (uncheck NL so the payload is a clean single-tagger booru job).
  await page.locator('#smart-tag-enable-vlm').uncheck()
  await page.locator('#btn-smart-tag-run').click()

  await expect.poll(() => startPayload).not.toBeNull()
  expect(startPayload).toMatchObject({
    image_ids: [10, 11, 12],
    training_purpose: 'general',
    merge_strategy: 'replace',
    enable_wd14: true,
    enable_vlm: false,
    consensus_min: 1,
    tagger_model: 'model-a',
    general_threshold: 0.35,
    character_threshold: 0.85,
    copyright_threshold: 0.4,
    max_tags_per_image: 40,
  })
  // Single tagger -> no consensus taggers array.
  expect(startPayload.taggers).toBeUndefined()
  expect(startPayload.caption_profile).toBeUndefined()
})

test('Krea 2 target model posts the explicit long-NL caption profile', async ({ page }) => {
  let startPayload: any = null
  const item = { id: -900, path: 'C:/dataset/krea2-profile.png', booru: 'portrait', nl: 'A portrait.' }
  await page.route('**/api/smart-tag/start', (route) => {
    startPayload = route.request().postDataJSON()
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ job_id: 'pin-krea2-profile', status: 'running', active: true, total: 1 }),
    })
  })

  await seedLocalCaptionItems(page, [item])
  await page.evaluate(() => {
    const select = document.getElementById('dataset-target-model') as HTMLSelectElement
    select.value = 'krea2'
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await openDatasetAndReady(page)
  await page.locator('#btn-smart-tag-run').click()

  await expect.poll(() => startPayload).not.toBeNull()
  expect(startPayload.image_paths).toEqual([item.path])
  expect(startPayload.caption_profile).toBe('krea2_long_nl')
})

test('Krea 2 total caption failure surfaces the provider recovery action in an error toast', async ({ page }) => {
  const providerError = "Model 'qwen3-vl:8b' exhausted the caption budget. Use qwen3-vl:8b-instruct."
  const jobMessage = `Caption profile 'krea2_long_nl' failed for all 1 image(s). Provider error: ${providerError}`
  const item = { id: -906, path: 'C:/dataset/krea2-failed.png', booru: 'portrait', nl: 'A portrait.' }

  await page.route('**/api/smart-tag/start', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ job_id: 'pin-krea2-failed', status: 'running', active: true, total: 1 }),
    }))
  await page.route('**/api/smart-tag/progress**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        job_id: 'pin-krea2-failed',
        status: 'failed',
        active: false,
        total: 1,
        processed: 1,
        succeeded: 0,
        failed: 1,
        caption_result_count: 0,
        message: jobMessage,
        errors: [{ image_id: item.path, error: providerError }],
        settings: {
          enable_vlm: true,
          natural_language_mode: 'vlm',
          caption_profile: 'krea2_long_nl',
        },
      }),
    }))

  await seedLocalCaptionItems(page, [item])
  await page.evaluate(() => {
    const select = document.getElementById('dataset-target-model') as HTMLSelectElement
    select.value = 'krea2'
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await openDatasetAndReady(page)
  await page.locator('#btn-smart-tag-run').click()

  const errorToast = page.locator('#toast-container .toast.error')
  await expect(errorToast).toHaveCount(1)
  await expect(errorToast).toContainText('Smart Tag failed')
  await expect(errorToast).toContainText('qwen3-vl:8b-instruct')
  await expect(errorToast).toContainText(item.path)
  const errorText = await errorToast.textContent()
  expect(errorText?.split(providerError)).toHaveLength(2)
  await expect(page.locator('#toast-container .toast.success')).toHaveCount(0)
})

test('malformed path results leave caption edits unchanged and never report success', async ({ page }) => {
  const items = [
    {
      id: -921,
      path: 'C:/dataset/atomic-valid-first.png',
      booru: 'original_tag',
      nl: 'Original first sentence.',
    },
    {
      id: -922,
      path: 'C:/dataset/atomic-malformed-second.png',
      booru: 'second_original_tag',
      nl: 'Original second sentence.',
    },
  ]
  await seedLocalCaptionItems(page, items)
  await page.evaluate(() => {
    const dm = (window as any).DatasetMaker
    dm.captionEdits.set(-921, 'user_booru_draft')
    dm.nlEdits.set(-921, 'User natural-language draft.')
    ;(window as any).__smartTagToasts = []
    ;(window as any).showToast = (message: string, type: string) => {
      ;(window as any).__smartTagToasts.push({ message, type })
    }
  })
  await installCompletedPathJob(page, 'pin-path-atomic-failure', 'replace', [
    {
      path: items[0].path,
      caption: 'new combined caption',
      booru_text: 'new_tag',
      nl_text: 'A replacement sentence that must not be committed.',
    },
    {
      path: items[1].path,
      caption: 'malformed combined caption',
      booru_text: 'malformed_tag',
    },
  ])
  await openDatasetAndReady(page)
  await page.locator('#btn-smart-tag-run').click()

  await expect.poll(() => page.evaluate(() => (window as any).__smartTagToasts.length)).toBe(1)
  const state = await page.evaluate(() => {
    const dm = (window as any).DatasetMaker
    return {
      booruEdits: [...dm.captionEdits.entries()],
      nlEdits: [...dm.nlEdits.entries()],
      toasts: (window as any).__smartTagToasts,
    }
  })
  expect(state.booruEdits).toEqual([[-921, 'user_booru_draft']])
  expect(state.nlEdits).toEqual([[-921, 'User natural-language draft.']])
  expect(state.toasts).toHaveLength(1)
  expect(state.toasts[0].type).toBe('error')
  expect(state.toasts[0].message).toContain('Smart Tag result 1')
  expect(state.toasts[0].message).toContain('booru_text, and nl_text strings')
})

test('path result read failures surface the backend cause and never report success', async ({ page }) => {
  const item = {
    id: -926,
    path: 'C:/dataset/result-file-missing.png',
    booru: 'original_tag',
    nl: 'Original natural-language caption.',
  }
  const serverError = "Cannot read Smart Tag caption results: job_id='pin-path-read-failure'"
  await seedLocalCaptionItems(page, [item])
  await installCompletedPathJob(page, 'pin-path-read-failure', 'replace', [
    {
      path: item.path,
      caption: 'replacement combined caption',
      booru_text: 'replacement_tag',
      nl_text: 'Replacement natural-language caption.',
    },
  ])
  await page.route('**/api/smart-tag/results**', (route) =>
    route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: serverError, type: 'HTTPException' }),
    }))

  await openDatasetAndReady(page)
  await page.locator('#btn-smart-tag-run').click()

  const errorToast = page.locator('#toast-container [role="alert"].error')
  await expect(errorToast).toHaveCount(1)
  await expect(errorToast).toContainText('captions were generated but could not be applied')
  await expect(errorToast).toContainText(serverError)
  await expect(page.locator('#toast-container [role="alert"].success')).toHaveCount(0)
  const edits = await page.evaluate(() => ({
    booru: [...window.DatasetMaker.captionEdits.entries()],
    nl: [...window.DatasetMaker.nlEdits.entries()],
  }))
  expect(edits).toEqual({ booru: [], nl: [] })
})

test('warning terminal applies successful path captions and reports the first image failure', async ({ page }) => {
  const item = {
    id: -931,
    path: 'C:/dataset/partial-warning.png',
    booru: 'prior_tag',
    nl: 'Prior natural-language caption.',
  }
  await seedLocalCaptionItems(page, [item])
  await installCompletedPathJob(page, 'pin-path-warning', 'replace', [
    {
      path: item.path,
      caption: 'replacement combined caption',
      booru_text: 'new_tag',
      nl_text: 'The successful caption remains usable.',
    },
  ])
  await page.route('**/api/smart-tag/progress**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        job_id: 'pin-path-warning',
        status: 'warning',
        active: false,
        total: 2,
        processed: 2,
        succeeded: 1,
        failed: 1,
        caption_result_count: 1,
        errors: [{ image_id: '42', error: 'database is locked' }],
        settings: { merge_strategy: 'replace', enable_vlm: true, natural_language_mode: 'vlm' },
      }),
    }))

  await openDatasetAndReady(page)
  await page.locator('#btn-smart-tag-run').click()

  await expect.poll(() => page.evaluate(() => {
    const dm = window.DatasetMaker
    return [dm.captionEdits.get(-931), dm.nlEdits.get(-931)]
  })).toEqual(['new_tag', 'The successful caption remains usable.'])
  const warningToast = page.locator('#toast-container [role="alert"].warning')
  await expect(warningToast).toHaveCount(1)
  await expect(warningToast).toContainText('1 ok, 1 failed')
  await expect(warningToast).toContainText('Image #42: database is locked')
  await expect(page.locator('#toast-container [role="alert"].success')).toHaveCount(0)
})

test('cancelled terminal applies completed path captions and uses an informational toast', async ({ page }) => {
  const item = {
    id: -941,
    path: 'C:/dataset/cancelled-with-result.png',
    booru: 'prior_tag',
    nl: 'Prior natural-language caption.',
  }
  await seedLocalCaptionItems(page, [item])
  await installCompletedPathJob(page, 'pin-cancelled-toast', 'replace', [
    {
      path: item.path,
      caption: 'replacement combined caption',
      booru_text: 'completed_tag',
      nl_text: 'This caption finished before cancellation.',
    },
  ])
  await page.route('**/api/smart-tag/progress**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        job_id: 'pin-cancelled-toast',
        status: 'cancelled',
        active: false,
        total: 2,
        processed: 1,
        succeeded: 1,
        failed: 0,
        caption_result_count: 1,
        settings: { merge_strategy: 'replace', enable_vlm: true, natural_language_mode: 'vlm' },
      }),
    }))

  await openDatasetAndReady(page)
  await page.locator('#btn-smart-tag-run').click()

  await expect.poll(() => page.evaluate(() => {
    const dm = window.DatasetMaker
    return [dm.captionEdits.get(-941), dm.nlEdits.get(-941)]
  })).toEqual(['completed_tag', 'This caption finished before cancellation.'])
  const infoToast = page.locator('#toast-container [role="alert"].info')
  await expect(infoToast).toHaveCount(1)
  await expect(infoToast).toContainText('Smart Tag cancelled')
  await expect(page.locator('#toast-container [role="alert"].success')).toHaveCount(0)
})

test('Dataset Krea profile is omitted when ToriiGate captioning is selected', async ({ page }) => {
  let startPayload: any = null
  const item = { id: -901, path: 'C:/dataset/krea2-toriigate.png', booru: 'portrait', nl: 'A portrait.' }
  await page.route('**/api/smart-tag/start', (route) => {
    startPayload = route.request().postDataJSON()
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ job_id: 'pin-krea2-toriigate', status: 'running', active: true, total: 1 }),
    })
  })

  await seedLocalCaptionItems(page, [item])
  await page.evaluate(() => {
    const select = document.getElementById('dataset-target-model') as HTMLSelectElement
    select.value = 'krea2'
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await openDatasetAndReady(page)
  await page.locator('#smart-tag-nl-mode').selectOption('toriigate')
  await page.locator('#btn-smart-tag-run').click()

  await expect.poll(() => startPayload).not.toBeNull()
  expect(startPayload).toMatchObject({
    image_paths: [item.path],
    enable_vlm: true,
    natural_language_mode: 'toriigate',
  })
  expect(startPayload.caption_profile).toBeUndefined()
})

test('Dataset Krea profile is omitted when natural-language captioning is disabled', async ({ page }) => {
  let startPayload: any = null
  const item = { id: -902, path: 'C:/dataset/krea2-vlm-disabled.png', booru: 'portrait', nl: 'A portrait.' }
  await page.route('**/api/smart-tag/start', (route) => {
    startPayload = route.request().postDataJSON()
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ job_id: 'pin-krea2-vlm-disabled', status: 'running', active: true, total: 1 }),
    })
  })

  await seedLocalCaptionItems(page, [item])
  await page.evaluate(() => {
    const select = document.getElementById('dataset-target-model') as HTMLSelectElement
    select.value = 'krea2'
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await openDatasetAndReady(page)
  await page.locator('#smart-tag-enable-vlm').uncheck()
  await page.locator('#btn-smart-tag-run').click()

  await expect.poll(() => startPayload).not.toBeNull()
  expect(startPayload).toMatchObject({
    image_paths: [item.path],
    enable_vlm: false,
    natural_language_mode: 'vlm',
  })
  expect(startPayload.caption_profile).toBeUndefined()
})

test('Gallery-scoped Smart Tag does not inherit the selected Krea 2 Dataset caption profile', async ({ page }) => {
  let startPayload: any = null
  await page.route('**/api/smart-tag/start', (route) => {
    startPayload = route.request().postDataJSON()
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ job_id: 'pin-krea2-gallery', status: 'running', active: true, total: 1 }),
    })
  })

  await seedLocalCaptionItems(page, [
    { id: -904, path: 'C:/dataset/krea2-gallery-guard.png', booru: 'portrait', nl: 'A portrait.' },
  ])
  await page.evaluate(() => {
    const select = document.getElementById('dataset-target-model') as HTMLSelectElement
    select.value = 'krea2'
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await openScopedAndReady(page, [10])
  await page.locator('#btn-smart-tag-run').click()

  await expect.poll(() => startPayload).not.toBeNull()
  expect(startPayload.image_ids).toEqual([10])
  expect(startPayload.caption_profile).toBeUndefined()
})

test('path-source NL-only writeback persists the session, refreshes export, and preserves Booru', async ({ page }) => {
  const item = {
    id: -905,
    path: 'C:/dataset/nl-only-writeback.png',
    booru: '1girl, red_hair',
    nl: 'Old natural-language caption.',
  }
  await seedLocalCaptionItems(page, [item])
  await page.evaluate(() => {
    const dm = (window as any).DatasetMaker
    dm.captionType.set(-905, 'nl')
    const calls = { scheduleSaveSession: 0, refreshExportPreview: 0 }
    const scheduleSaveSession = dm._scheduleSaveSession.bind(dm)
    const refreshExportPreview = dm._refreshExportPreview.bind(dm)
    ;(window as any).__smartTagWritebackCalls = calls
    dm._scheduleSaveSession = () => {
      calls.scheduleSaveSession += 1
      return scheduleSaveSession()
    }
    dm._refreshExportPreview = () => {
      calls.refreshExportPreview += 1
      return refreshExportPreview()
    }
  })
  await installCompletedPathJob(page, 'pin-path-nl-only', 'replace', [
    {
      path: item.path,
      caption: 'legacy combined caption must not enter the Booru editor',
      booru_text: '',
      nl_text: 'A red-haired person looks toward the camera in soft daylight.',
    },
  ])
  await openDatasetAndReady(page)
  await page.locator('#smart-tag-enable-wd14').uncheck()
  await page.locator('#btn-smart-tag-run').click()

  await expect.poll(() => page.evaluate(() => {
    const dm = (window as any).DatasetMaker
    const calls = (window as any).__smartTagWritebackCalls
    const exportPayload = dm._buildExportPayload()
    const path = 'C:/dataset/nl-only-writeback.png'
    return {
      booruOriginal: dm.captions.get(-905),
      booruEditPresent: dm.captionEdits.has(-905),
      nlEdit: dm.nlEdits.get(-905),
      sessionSaveScheduled: calls.scheduleSaveSession > 0,
      exportPreviewRefreshed: calls.refreshExportPreview > 0,
      exportType: exportPayload.image_types[path],
      exportNl: exportPayload.image_nl_overrides[path],
      exportHasBooruOverride: Object.prototype.hasOwnProperty.call(exportPayload.image_overrides, path),
    }
  })).toEqual({
    booruOriginal: '1girl, red_hair',
    booruEditPresent: false,
    nlEdit: 'A red-haired person looks toward the camera in soft daylight.',
    sessionSaveScheduled: true,
    exportPreviewRefreshed: true,
    exportType: 'nl',
    exportNl: 'A red-haired person looks toward the camera in soft daylight.',
    exportHasBooruOverride: false,
  })
})

test('path-source replace writes Booru and natural language into separate Dataset Maker channels', async ({ page }) => {
  const items = [
    { id: -901, path: 'C:/dataset/replace-both.png', booru: 'old_tag', nl: 'Old sentence.' },
    { id: -902, path: 'C:/dataset/replace-booru.png', booru: 'old_booru', nl: 'Keep this NL sentence.' },
    { id: -903, path: 'C:/dataset/replace-nl.png', booru: 'keep_this_tag', nl: 'Old NL sentence.' },
  ]
  await seedLocalCaptionItems(page, items)
  await installCompletedPathJob(page, 'pin-path-replace', 'replace', [
    {
      path: items[0].path,
      caption: 'legacy combined caption must not enter either editor',
      booru_text: '1girl, red_hair',
      nl_text: 'A red-haired person stands outside.',
    },
    {
      path: items[1].path,
      caption: 'legacy combined caption must not enter either editor',
      booru_text: 'blue_eyes',
      nl_text: '',
    },
    {
      path: items[2].path,
      caption: 'legacy combined caption must not enter either editor',
      booru_text: '',
      nl_text: 'A person looks toward the camera.',
    },
  ])
  await openDatasetAndReady(page)
  await page.locator('#smart-tag-merge').selectOption('replace')
  await page.locator('#btn-smart-tag-run').click()

  await expect.poll(() => page.evaluate(() => {
    const dm = (window as any).DatasetMaker
    return {
      both: [dm.captionEdits.get(-901), dm.nlEdits.get(-901)],
      booruOnly: [dm.captionEdits.get(-902), dm.nlEdits.get(-902) ?? dm.nlCaptions.get(-902)],
      nlOnly: [dm.captionEdits.get(-903) ?? dm.captions.get(-903), dm.nlEdits.get(-903)],
    }
  })).toEqual({
    both: ['1girl, red_hair', 'A red-haired person stands outside.'],
    booruOnly: ['blue_eyes', 'Keep this NL sentence.'],
    nlOnly: ['keep_this_tag', 'A person looks toward the camera.'],
  })
})

test('path-source append preserves channel separators, skips exact duplicates, and leaves absent channels untouched', async ({ page }) => {
  const items = [
    { id: -911, path: 'C:/dataset/append-both.png', booru: '1girl, red_hair', nl: 'A person stands outside.' },
    { id: -912, path: 'C:/dataset/append-same.png', booru: 'blue_eyes', nl: 'The subject is smiling.' },
    { id: -913, path: 'C:/dataset/append-booru.png', booru: 'solo', nl: 'Preserve this sentence.' },
  ]
  await seedLocalCaptionItems(page, items)
  await installCompletedPathJob(page, 'pin-path-append', 'append', [
    {
      path: items[0].path,
      caption: 'legacy combined caption must not enter either editor',
      booru_text: 'blue_eyes',
      nl_text: 'The subject looks toward the camera.',
    },
    {
      path: items[1].path,
      caption: 'legacy combined caption must not enter either editor',
      booru_text: 'blue_eyes',
      nl_text: 'The subject is smiling.',
    },
    {
      path: items[2].path,
      caption: 'legacy combined caption must not enter either editor',
      booru_text: 'outdoors',
      nl_text: '',
    },
  ])
  await openDatasetAndReady(page)
  await page.locator('#smart-tag-merge').selectOption('append')
  await page.locator('#btn-smart-tag-run').click()

  await expect.poll(() => page.evaluate(() => {
    const dm = (window as any).DatasetMaker
    return {
      both: [dm.captionEdits.get(-911), dm.nlEdits.get(-911)],
      same: [dm.captionEdits.get(-912) ?? dm.captions.get(-912), dm.nlEdits.get(-912) ?? dm.nlCaptions.get(-912)],
      booruOnly: [dm.captionEdits.get(-913), dm.nlEdits.get(-913) ?? dm.nlCaptions.get(-913)],
    }
  })).toEqual({
    both: ['1girl, red_hair, blue_eyes', 'A person stands outside. The subject looks toward the camera.'],
    same: ['blue_eyes', 'The subject is smiling.'],
    booruOnly: ['solo, outdoors', 'Preserve this sentence.'],
  })
})

// ---------------------------------------------------------------------------
// 8. readForm/run — dual-tagger AND consensus payload shape.
// ---------------------------------------------------------------------------

test('run() with two taggers + AND emits a per-model taggers array, consensus_min 2, skip categories, and clears tagger_model', async ({ page }) => {
  let startPayload: any = null
  await page.route('**/api/smart-tag/start', (route) => {
    startPayload = route.request().postDataJSON()
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ job_id: 'pin-dual', status: 'completed', active: false, total: 3 }),
    })
  })

  await openScopedAndReady(page, [10, 11, 12])
  await page.locator('#smart-tag-enable-vlm').uncheck()
  await page.locator('#smart-tag-tagger-2').selectOption('model-b')
  await page.locator('#smart-tag-consensus-mode').selectOption('and')
  await page.locator('#btn-smart-tag-run').click()

  await expect.poll(() => startPayload).not.toBeNull()
  expect(startPayload.tagger_model).toBe('')
  expect(startPayload.consensus_min).toBe(2)
  expect(startPayload.consensus_skip_categories).toEqual(['character', 'copyright'])
  expect(startPayload.taggers).toHaveLength(2)
  // Each tagger carries ITS OWN catalog-default thresholds (not the displayed inputs).
  expect(startPayload.taggers[0]).toMatchObject({
    model: 'model-a', general_threshold: 0.35, character_threshold: 0.85, copyright_threshold: 0.4, weight: 1,
  })
  expect(startPayload.taggers[1]).toMatchObject({
    model: 'model-b', general_threshold: 0.5, character_threshold: 0.7, copyright_threshold: 0.6, weight: 1,
  })
})

// ---------------------------------------------------------------------------
// 9. runSmartTag guard — empty sources -> warning, no POST.
// ---------------------------------------------------------------------------

test('run() with no images anywhere short-circuits before any /api/smart-tag/start POST', async ({ page }) => {
  let startCalled = false
  await page.route('**/api/smart-tag/start', (route) => {
    startCalled = true
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
  })

  const threw = await page.evaluate(async () => {
    // Force every source to empty: no Dataset Maker ids, no gallery selection/token.
    const w = window as any
    if (w.DatasetMaker) w.DatasetMaker.imageIds = []
    if (w.AppFilterAccess) {
      w.AppFilterAccess.getActiveSelectionToken = () => null
      w.AppFilterAccess.getSelectionTotal = () => 0
      w.AppFilterAccess.getSelectedImageIds = () => []
    }
    try {
      await w.SmartTag.run()
      return false
    } catch {
      return true
    }
  })

  expect(threw).toBe(false)
  // Give any (wrongly) issued POST a beat to land.
  await page.waitForTimeout(200)
  expect(startCalled).toBe(false)
})

// ---------------------------------------------------------------------------
// 10. runSmartTag guard — both engines off -> warning, no POST (even with images).
// ---------------------------------------------------------------------------

test('run() with a valid scope but both Booru and NL disabled short-circuits before POST', async ({ page }) => {
  let startCalled = false
  await page.route('**/api/smart-tag/start', (route) => {
    startCalled = true
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
  })

  await openScopedAndReady(page, [10])
  await page.locator('#smart-tag-enable-wd14').uncheck()
  await page.locator('#smart-tag-enable-vlm').uncheck()
  await page.locator('#btn-smart-tag-run').click()

  await page.waitForTimeout(200)
  expect(startCalled).toBe(false)
})

// ---------------------------------------------------------------------------
// 11. Destructive-replace confirm — >100 images in replace mode gates the POST.
// ---------------------------------------------------------------------------

test('replace mode over 100 images requires window.confirm; declining blocks the POST, accepting allows it', async ({ page }) => {
  let startCalls = 0
  await page.route('**/api/smart-tag/start', (route) => {
    startCalls += 1
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ job_id: 'pin-confirm', status: 'completed', active: false }),
    })
  })

  const manyIds = Array.from({ length: 101 }, (_, i) => i + 1)
  await openScopedAndReady(page, manyIds)
  await page.locator('#smart-tag-enable-vlm').uncheck() // booru-only, merge stays "replace"
  await expect(page.locator('#smart-tag-image-count')).toHaveText('101')

  // Decline the overwrite confirm -> no POST.
  await page.evaluate(() => { (window as any).confirm = () => false })
  await page.locator('#btn-smart-tag-run').click()
  await page.waitForTimeout(200)
  expect(startCalls).toBe(0)

  // Accept -> the POST fires.
  await page.evaluate(() => { (window as any).confirm = () => true })
  await page.locator('#btn-smart-tag-run').click()
  await expect.poll(() => startCalls).toBe(1)
})

// ---------------------------------------------------------------------------
// 12. AI job queue — pipeline_queued start renders the queued state and keeps polling.
// ---------------------------------------------------------------------------

test('a pipeline_queued start response shows the progress region with the queue position instead of failing', async ({ page }) => {
  await page.route('**/api/smart-tag/start', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ pipeline_queued: true, queue_position: 2, duplicate: false }),
    }))

  await openScopedAndReady(page, [10, 11, 12])
  await page.locator('#smart-tag-enable-vlm').uncheck()

  // Read the queued UI synchronously right after run() resolves, before the 1s poll.
  const queued = await page.evaluate(async () => {
    await (window as any).SmartTag.run()
    return {
      hidden: (document.getElementById('smart-tag-progress') as HTMLElement).hidden,
      text: (document.getElementById('smart-tag-progress-text') as HTMLElement).textContent ?? '',
      cancelHidden: (document.getElementById('btn-smart-tag-cancel-job') as HTMLElement).hidden,
    }
  })

  expect(queued.hidden).toBe(false)
  // Queued copy carries the position number (locale-agnostic check).
  expect(queued.text).toContain('2')
  // The Stop button becomes available for a queued job.
  expect(queued.cancelHidden).toBe(false)
})

// ---------------------------------------------------------------------------
// 13. cancelSmartTag — POSTs cancel; a 404 (already finished) resolves without throwing.
// ---------------------------------------------------------------------------

test('cancel() posts to /api/smart-tag/cancel and swallows a 404 job-already-finished without throwing', async ({ page }) => {
  let cancelCalls = 0
  let cancelStatus = 200
  await page.route('**/api/smart-tag/cancel', (route) => {
    cancelCalls += 1
    route.fulfill({
      status: cancelStatus,
      contentType: 'application/json',
      body: JSON.stringify(cancelStatus === 200 ? { cancelled: true } : { detail: 'no active job' }),
    })
  })

  await openScopedAndReady(page, [10])

  // 200 path: resolves cleanly.
  const firstThrew = await page.evaluate(async () => {
    try { await (window as any).SmartTag.cancel(); return false } catch { return true }
  })
  expect(firstThrew).toBe(false)
  expect(cancelCalls).toBe(1)

  // 404 path: still resolves (surfaced as an info toast, not a throw).
  await page.evaluate(() => { (window as any).__setCancel404 = true })
  cancelStatus = 404
  const secondThrew = await page.evaluate(async () => {
    try { await (window as any).SmartTag.cancel(); return false } catch { return true }
  })
  expect(secondThrew).toBe(false)
  expect(cancelCalls).toBe(2)
})

// ---------------------------------------------------------------------------
// 14. Ollama warning banner — a cloud endpoint hides it; unconfigured + no Ollama shows it.
// ---------------------------------------------------------------------------

test('the Ollama-required banner stays hidden with a configured cloud endpoint and appears when unconfigured with no Ollama', async ({ page }) => {
  // Base mocks: endpoint present -> banner hidden after open.
  await openScopedAndReady(page, [10])
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const b = document.getElementById('smart-tag-ollama-warning') as HTMLElement | null
        return b ? b.hidden : 'absent-or-hidden'
      }))
    .not.toBe(false) // hidden===true OR the banner was never created (both mean "not shown")

  // Now remove the endpoint AND report Ollama unavailable, then re-trigger the probe.
  await page.route('**/api/vlm/settings', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ endpoint: '', use_vertex: false }) }))
  await page.route('**/api/vlm/local-models/recommended', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ollama_installed: false, ollama_running: false }) }))

  // Toggling the NL enable checkbox re-runs refreshOllamaWarning.
  await page.locator('#smart-tag-enable-vlm').uncheck()
  await page.locator('#smart-tag-enable-vlm').check()

  await expect(page.locator('#smart-tag-ollama-warning')).toBeVisible()
})
