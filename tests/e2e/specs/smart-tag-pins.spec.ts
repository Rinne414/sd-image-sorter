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
