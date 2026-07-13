import { expect, test, type Page } from '../fixtures/click-ledger'

/**
 * Characterization pins for the autosep.js god-file (1,978 lines) — "step 0" of a
 * later VERBATIM decomposition (mirrors the shipped app.js / gallery.js / censor /
 * dataset / manual-sort splits).
 *
 * autosep.js is the Auto-Separate tab: a filter → preview → batch copy/move
 * workbench (left = filter editor + saved configs + gallery-scope sync; center =
 * match preview grid + overflow modal; right = destination + file-action mode +
 * Run CTA), plus a settings modal and a background move/copy progress poller.
 *
 * Structurally it is the app.js model, NOT the gallery.js model:
 *   - top-level classic-script `function` declarations (so they are reachable as
 *     `window.<name>` globals) + top-level lexical `const`/`let` module state
 *     (AutoSepState, DEFAULT_AUTOSEP_SETTINGS, the AUTOSEP_*_KEY storage keys,
 *     _previewRequestId, autosepMoveController) that is NOT on `window`;
 *   - it builds NO facade and seals nothing. Its ENTIRE cross-module contract is
 *     FIVE `window.*` exports published mid/end-of-file:
 *       window.updateAutoSepSummary            (@1462)
 *       window.invalidateAutoSepPreview        (@1463)
 *       window.maybeAdoptAutoSepFiltersFromGallery (@1464)
 *       window.updateAutoSepActionUi           (@1465)
 *       window.executeAutoSeparateWithProgress (@1977)
 *     plus a DOMContentLoaded → initAutoSeparate boot. The nav entry
 *     `window._switchSortingSub('autosep')` lives in index.html (not here) and
 *     calls maybeAdoptAutoSepFiltersFromGallery.
 *
 * These pins lock the OBSERVABLE window-surface + workbench behavior a verbatim
 * cut/move most endangers: a dropped export, a helper that stops being a reachable
 * global, a state field lost by the serializer, a persistence write that lands in
 * the wrong split file. They MUST pass before AND after the split. The DB-heavy
 * LIVE flows (real preview fetch, batch move/copy, overflow paging) run against a
 * mocked API in smoke.spec.ts / the audit specs and are deliberately NOT
 * duplicated here.
 *
 * Deliberately pinned quirks (each has a loud comment):
 *   - copy is the file-action default and a corrupt stored value falls back to
 *     'copy' at RUNTIME, never 'move' (safety invariant, Principle #11);
 *   - serializeAutoSepFilters ALWAYS emits the full v3.3.x gallery-scope shape
 *     (the exact field set the backend contract test_frontend_contract.py:1736
 *     pins) with default/normalized values, even from a partial input;
 *   - updateAutoSepSummary strips each span's `data-i18n` so a later
 *     I18n.applyToDOM can't reset the localized scope back to "All"/"None";
 *   - maybeAdoptAutoSepFiltersFromGallery is a ONE-SHOT: it copies the gallery
 *     filters + marks the scope synced on first entry, then no-ops.
 *
 * The isolated e2e DB starts empty (0-count galleries are legitimate) and the
 * suite storageState seeds aurora-entry-skip=1 so nav lands straight in the app.
 * None of these pins need seeded images or a server session.
 */

test.describe.configure({ mode: 'serial' })

type AutoSepWin = typeof window & {
  App: any
  // The 5 window.* exports = autosep.js's ENTIRE cross-module contract. Consumed
  // by app/filter-modal-data.js, app/filter-summary.js, app/selection.js,
  // ui-refresh.js, and the index.html sorting-sub-tab nav.
  updateAutoSepSummary: () => void
  invalidateAutoSepPreview: () => void
  maybeAdoptAutoSepFiltersFromGallery: () => boolean
  updateAutoSepActionUi: () => void
  executeAutoSeparateWithProgress: (...args: unknown[]) => unknown
  // Top-level classic-script function declarations ALSO become window props
  // (app.js model). The verbatim split must keep them reachable as globals.
  serializeAutoSepFilters: (filters: unknown) => Record<string, unknown>
  getAutoSepOperationMode: () => string
  updateAutoSepPreview: () => Promise<void>
  normalizeAutoSepOperationMode: (mode: unknown) => string
  initAutoSeparate: () => void
  // AutoSepState is a lexical `const` — deliberately NOT leaked to window
  // (UNLIKE manual-sort's window.ManualSortState). Pinned below.
  AutoSepState?: unknown
  _switchSortingSub: (sub: string) => void
}

/**
 * Boot the app and wait for readiness WITHOUT navigating to Auto-Separate.
 *
 * Per-test localStorage seeds MUST be registered before navigation, so callers
 * pass them here (addInitScript runs before the page's own scripts). Readiness =
 * the app boot flag (dataset.appReady, set in app.js) plus the autosep window
 * exports + reachable helper globals present. The 5 exports + the function-decl
 * globals are published at autosep.js parse time, so they exist by `load`.
 */
async function bootApp(page: Page, seeds?: Record<string, string>): Promise<void> {
  if (seeds) {
    await page.addInitScript((entries: Record<string, string>) => {
      for (const [key, value] of Object.entries(entries)) {
        localStorage.setItem(key, value)
      }
    }, seeds)
  }
  await page.goto('/')
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() => {
    const w = window as AutoSepWin
    return (
      document.documentElement.dataset.appReady === '1' &&
      typeof w.maybeAdoptAutoSepFiltersFromGallery === 'function' &&
      typeof w.serializeAutoSepFilters === 'function' &&
      typeof w.getAutoSepOperationMode === 'function' &&
      typeof w.App?.switchView === 'function' &&
      typeof w._switchSortingSub === 'function'
    )
  })
}

/**
 * Boot + open the Sorting view's Auto-Separate sub-tab (the real nav path other
 * modules use). `_switchSortingSub('autosep')` also fires the one-shot
 * maybeAdoptAutoSepFiltersFromGallery, so tests that pin the adopt itself use
 * bootApp() instead and call it explicitly.
 */
async function gotoAutosep(page: Page, seeds?: Record<string, string>): Promise<void> {
  await bootApp(page, seeds)
  await page.evaluate(() => {
    const w = window as AutoSepWin
    w.App.switchView('sorting')
    w._switchSortingSub('autosep')
  })
  await expect(page.locator('.autosep-shell')).toBeVisible()
}

const OPERATION_COPY = 'input[name="autosep-operation-mode-main"][value="copy"]'
const OPERATION_MOVE = 'input[name="autosep-operation-mode-main"][value="move"]'

// ---------------------------------------------------------------------------
// 1. Cross-module window surface — the ENTIRE public contract of the file. A
//    verbatim split must keep every export attached AND keep the helper
//    function-declarations reachable as globals, or the app/*.js summary hooks,
//    ui-refresh.js action-label hook, and the _switchSortingSub nav break
//    silently. Also pins that AutoSepState stays PRIVATE (a const, not window).
// ---------------------------------------------------------------------------

test('autosep.js publishes its window surface and keeps AutoSepState private', async ({ page }) => {
  await gotoAutosep(page)
  const probe = await page.evaluate(() => {
    const w = window as AutoSepWin
    return {
      exports: {
        updateAutoSepSummary: typeof w.updateAutoSepSummary,
        invalidateAutoSepPreview: typeof w.invalidateAutoSepPreview,
        maybeAdoptAutoSepFiltersFromGallery: typeof w.maybeAdoptAutoSepFiltersFromGallery,
        updateAutoSepActionUi: typeof w.updateAutoSepActionUi,
        executeAutoSeparateWithProgress: typeof w.executeAutoSeparateWithProgress,
      },
      // Classic-script function declarations reachable as globals; the app.js-model
      // split keeps their identity (a helper moved to autosep/<x>.js is still a
      // window global, callable from any sibling file at runtime).
      globals: {
        serializeAutoSepFilters: typeof w.serializeAutoSepFilters,
        getAutoSepOperationMode: typeof w.getAutoSepOperationMode,
        normalizeAutoSepOperationMode: typeof w.normalizeAutoSepOperationMode,
        initAutoSeparate: typeof w.initAutoSeparate,
      },
      // Lexical const — NOT a window property (autosep does not export its state).
      stateNotOnWindow: typeof w.AutoSepState === 'undefined',
      switchSortingSub: typeof w._switchSortingSub,
    }
  })

  expect(probe.exports).toEqual({
    updateAutoSepSummary: 'function',
    invalidateAutoSepPreview: 'function',
    maybeAdoptAutoSepFiltersFromGallery: 'function',
    updateAutoSepActionUi: 'function',
    executeAutoSeparateWithProgress: 'function',
  })
  expect(probe.globals).toEqual({
    serializeAutoSepFilters: 'function',
    getAutoSepOperationMode: 'function',
    normalizeAutoSepOperationMode: 'function',
    initAutoSeparate: 'function',
  })
  expect(probe.stateNotOnWindow).toBe(true)
  expect(probe.switchSortingSub).toBe('function')
})

// ---------------------------------------------------------------------------
// 2. Copy is the file-action default (safety invariant, Principle #11). No
//    autosep_settings_v1 seed → DEFAULT_AUTOSEP_SETTINGS.operationMode='copy'.
// ---------------------------------------------------------------------------

test('file-action mode defaults to copy with the copy radio pre-checked', async ({ page }) => {
  await gotoAutosep(page)

  const mode = await page.evaluate(() => (window as AutoSepWin).getAutoSepOperationMode())
  expect(mode).toBe('copy')

  await expect(page.locator(OPERATION_COPY)).toBeChecked()
  await expect(page.locator(OPERATION_MOVE)).not.toBeChecked()
})

// ---------------------------------------------------------------------------
// 3. A corrupt stored file-action mode falls back to copy at RUNTIME. The
//    release-build test pins the SOURCE string; this pins the actual init path
//    (a corrupt localStorage value must never silently choose destructive 'move').
// ---------------------------------------------------------------------------

test('a corrupt saved operation mode resolves to copy, never move', async ({ page }) => {
  await gotoAutosep(page, { autosep_settings_v1: JSON.stringify({ operationMode: 'not-a-real-mode' }) })

  const mode = await page.evaluate(() => (window as AutoSepWin).getAutoSepOperationMode())
  expect(mode).toBe('copy')
  await expect(page.locator(OPERATION_COPY)).toBeChecked()
  await expect(page.locator(OPERATION_MOVE)).not.toBeChecked()
})

// ---------------------------------------------------------------------------
// 4. An explicitly saved 'move' IS honored — proving the copy fallback above is
//    a real decision through normalizeAutoSepOperationMode, not a hardcode.
// ---------------------------------------------------------------------------

test('an explicitly saved move mode is honored on load', async ({ page }) => {
  await gotoAutosep(page, { autosep_settings_v1: JSON.stringify({ operationMode: 'move' }) })

  const mode = await page.evaluate(() => (window as AutoSepWin).getAutoSepOperationMode())
  expect(mode).toBe('move')
  await expect(page.locator(OPERATION_MOVE)).toBeChecked()
  await expect(page.locator(OPERATION_COPY)).not.toBeChecked()
})

// ---------------------------------------------------------------------------
// 5. Toggling the file-action radio drives the mode, persists it inside
//    autosep_settings_v1, and rewrites the action settings summary. (The DOM
//    integration check clicks the radio but never asserts the state/persist/
//    summary wiring the split's setAutoSepOperationMode owns.)
// ---------------------------------------------------------------------------

test('choosing a file-action radio updates mode, persists, and rewrites the summary', async ({ page }) => {
  await gotoAutosep(page)

  const summary = page.locator('#autosep-settings-summary')
  const before = (await summary.textContent())?.trim() || ''

  await page.locator(OPERATION_MOVE).check({ force: true })
  const afterMove = await page.evaluate(() => ({
    mode: (window as AutoSepWin).getAutoSepOperationMode(),
    stored: JSON.parse(localStorage.getItem('autosep_settings_v1') || '{}').operationMode,
  }))
  expect(afterMove.mode).toBe('move')
  expect(afterMove.stored).toBe('move')
  const moveText = (await summary.textContent())?.trim() || ''
  // Language-independent: the "Action mode: …" line must change with the mode.
  expect(moveText).not.toBe(before)
  expect(moveText.length).toBeGreaterThan(0)

  await page.locator(OPERATION_COPY).check({ force: true })
  const afterCopy = await page.evaluate(() => ({
    mode: (window as AutoSepWin).getAutoSepOperationMode(),
    stored: JSON.parse(localStorage.getItem('autosep_settings_v1') || '{}').operationMode,
  }))
  expect(afterCopy.mode).toBe('copy')
  expect(afterCopy.stored).toBe('copy')
})

// ---------------------------------------------------------------------------
// 6. Toggling a boolean setting checkbox persists it into autosep_settings_v1
//    and rewrites the action settings summary (setAutoSepBooleanSetting, persist).
//    confirmBeforeMove defaults ON; unchecking it must persist false. The custom
//    checkbox is toggled by clicking the visible `.checkbox-custom` (force-clicking
//    the real input fails — the styled overlay intercepts the hit; team pitfall).
// ---------------------------------------------------------------------------

test('toggling a setting checkbox persists it and rewrites the settings summary', async ({ page }) => {
  await gotoAutosep(page)

  const confirmBox = page.locator('#autosep-confirm-move-main')
  const confirmToggle = page.locator('label:has(#autosep-confirm-move-main) .checkbox-custom')
  const summary = page.locator('#autosep-settings-summary')
  await expect(confirmBox).toBeChecked()
  const before = (await summary.textContent())?.trim() || ''

  await confirmToggle.click()
  await expect(confirmBox).not.toBeChecked()
  const storedOff = await page.evaluate(
    () => JSON.parse(localStorage.getItem('autosep_settings_v1') || '{}').confirmBeforeMove,
  )
  expect(storedOff).toBe(false)
  const afterOff = (await summary.textContent())?.trim() || ''
  expect(afterOff).not.toBe(before)

  await confirmToggle.click()
  await expect(confirmBox).toBeChecked()
  const storedOn = await page.evaluate(
    () => JSON.parse(localStorage.getItem('autosep_settings_v1') || '{}').confirmBeforeMove,
  )
  expect(storedOn).toBe(true)
})

// ---------------------------------------------------------------------------
// 7. serializeAutoSepFilters ALWAYS emits the full v3.3.x gallery-scope shape
//    with default/normalized values, even from a partial input. This is the
//    round-trip the backend contract (test_frontend_contract.py:1736) pins by
//    string — the split must move the serializer verbatim so every field name
//    survives and "Copy from Gallery" keeps counting the exact set the move
//    touches.
// ---------------------------------------------------------------------------

test('serializeAutoSepFilters fills the full scope shape and normalizes aliases', async ({ page }) => {
  await gotoAutosep(page)

  const out = await page.evaluate(() => {
    const w = window as AutoSepWin
    return {
      empty: w.serializeAutoSepFilters({}),
      snakeAlias: w.serializeAutoSepFilters({ tag_mode: 'or', prompt_match_mode: 'contains' }),
      camel: w.serializeAutoSepFilters({ tagMode: 'or', promptMatchMode: 'exact' }),
      bogus: w.serializeAutoSepFilters({ tagMode: 'weird', promptMatchMode: 'nope', folder: '  D:\\pin  ' }),
    }
  })

  // Defaults from an empty input.
  expect(out.empty.generators).toEqual(['comfyui', 'nai', 'webui', 'forge', 'unknown'])
  expect(out.empty.ratings).toEqual(['general', 'sensitive', 'questionable', 'explicit'])
  expect(out.empty.tags).toEqual([])
  expect(out.empty.tagMode).toBe('and')
  expect(out.empty.promptMatchMode).toBe('exact')
  expect(out.empty.folder).toBeNull()
  expect(out.empty.hasMetadata).toBeNull()

  // Every v3.3.x gallery-scope key the backend contract pins by name must be a
  // key of the serialized object (presence, not just a truthy value).
  const scopeKeys = [
    'excludePrompts', 'excludeColors', 'minUserRating', 'brightnessMin', 'brightnessMax',
    'colorTemperature', 'brightnessDistribution', 'collectionId', 'hasMetadata',
  ]
  // The per-item exclude group + the core filter keys must also survive.
  const coreKeys = [
    'excludeTags', 'excludeGenerators', 'excludeRatings', 'excludeCheckpoints', 'excludeLoras',
    'checkpoints', 'loras', 'prompts', 'artist', 'search', 'minWidth', 'maxWidth', 'minHeight',
    'maxHeight', 'aspectRatio', 'minAesthetic', 'maxAesthetic',
  ]
  for (const key of [...scopeKeys, ...coreKeys]) {
    expect(Object.prototype.hasOwnProperty.call(out.empty, key)).toBe(true)
  }

  // Normalization: snake_case aliases, camelCase, unknowns → safe defaults,
  // folder trimmed.
  expect(out.snakeAlias.tagMode).toBe('or')
  expect(out.snakeAlias.promptMatchMode).toBe('contains')
  expect(out.camel.tagMode).toBe('or')
  expect(out.camel.promptMatchMode).toBe('exact')
  expect(out.bogus.tagMode).toBe('and')
  expect(out.bogus.promptMatchMode).toBe('exact')
  expect(out.bogus.folder).toBe('D:\\pin')
})

// ---------------------------------------------------------------------------
// 8. invalidateAutoSepPreview zeroes the visible match count and clears the
//    preview list back to its empty state (the synchronous half of the
//    preview-invalidation contract every filter edit relies on). Auto-preview
//    defaults OFF, so no debounced re-fetch runs and the count stays 0.
// ---------------------------------------------------------------------------

test('invalidateAutoSepPreview zeroes the match count and clears the preview list', async ({ page }) => {
  await gotoAutosep(page)

  // Seed a fake non-zero count into the stat node, then prove invalidate resets it.
  await page.evaluate(() => {
    const stat = document.querySelector('#autosep-preview .stat-number')
    if (stat) stat.textContent = '99'
  })
  await page.evaluate(() => (window as AutoSepWin).invalidateAutoSepPreview())

  await expect(page.locator('#autosep-preview .stat-number')).toHaveText('0')
  await expect(page.locator('#autosep-preview-list .autosep-preview-item')).toHaveCount(0)
  await expect(page.locator('#autosep-preview-list .autosep-preview-empty')).toHaveCount(1)

  // DEAD-1 regression pin (fix landed with this assertion), two parts —
  // earlier serial tests persist autosep filters, so this is asserted
  // environment-independently instead of via a real no-filters preview:
  // (1) the guidance branch itself renders;
  await page.evaluate(() => {
    ;(window as AutoSepWin & { renderAutoSepPreviewList: (i: unknown[], t: number, r?: string | null) => void })
      .renderAutoSepPreviewList([], 0, 'no-filters')
  })
  await expect(
    page.locator('#autosep-preview-list .autosep-preview-empty--no-filters'),
  ).toHaveCount(1)
  // (2) updateAutoSepPreview actually FORWARDS the reason (the bug was that
  // no caller ever passed it): clear the persisted filter state so this page
  // is genuinely filter-less (AutoSepState is a lexical const — invisible to
  // evaluate — so the no-filters condition is forced via storage + reload),
  // wrap the renderer, run a real preview, and assert 'no-filters' arrives.
  await page.evaluate(() => localStorage.removeItem('autosep_filter_state_v1'))
  await gotoAutosep(page)
  const captured = await page.evaluate(async () => {
    const w = window as AutoSepWin & {
      renderAutoSepPreviewList: (i: unknown[], t: number, r?: string | null) => void
    }
    const original = w.renderAutoSepPreviewList
    let seen: string | null | undefined = 'never-called'
    w.renderAutoSepPreviewList = (images, total, reason) => {
      seen = reason ?? null
      original(images, total, reason)
    }
    try {
      await w.updateAutoSepPreview()
    } finally {
      w.renderAutoSepPreviewList = original
    }
    return seen
  })
  // The forwarding is the pin; whether the guidance NODE renders depends on
  // the library being empty (with images present the grid correctly shows) —
  // part (1) above already pins the branch's rendering.
  expect(captured).toBe('no-filters')
})

// ---------------------------------------------------------------------------
// 9. maybeAdoptAutoSepFiltersFromGallery is a ONE-SHOT: with no saved filter
//    state it copies the current gallery filters into autosep_filter_state_v1,
//    marks the scope synced (autosep_scope_meta_v1.lastSyncedAt), and returns
//    true; a second call returns false. This is the seam _switchSortingSub
//    ('autosep') depends on — boot WITHOUT nav so the auto-run has not consumed it.
// ---------------------------------------------------------------------------

test('maybeAdoptAutoSepFiltersFromGallery adopts gallery filters once then no-ops', async ({ page }) => {
  await bootApp(page)

  const beforeSaved = await page.evaluate(() => localStorage.getItem('autosep_filter_state_v1'))
  expect(beforeSaved).toBeNull()

  const first = await page.evaluate(() => (window as AutoSepWin).maybeAdoptAutoSepFiltersFromGallery())
  expect(first).toBe(true)

  const afterFirst = await page.evaluate(() => ({
    saved: localStorage.getItem('autosep_filter_state_v1'),
    scope: localStorage.getItem('autosep_scope_meta_v1'),
  }))
  expect(afterFirst.saved).not.toBeNull()
  const savedFilters = JSON.parse(afterFirst.saved as string)
  // The persisted state IS a serializeAutoSepFilters() payload (full scope shape).
  expect(Array.isArray(savedFilters.generators)).toBe(true)
  expect(Object.prototype.hasOwnProperty.call(savedFilters, 'hasMetadata')).toBe(true)
  const scopeMeta = JSON.parse(afterFirst.scope as string)
  expect(scopeMeta.lastSyncedAt).toBeTruthy()

  const second = await page.evaluate(() => (window as AutoSepWin).maybeAdoptAutoSepFiltersFromGallery())
  expect(second).toBe(false)
})

// ---------------------------------------------------------------------------
// 10. A saved config (autosep_configs_v1) restores into the config <select> on
//     load (loadAutoSepConfigs + renderAutoSepConfigControls, built with DOM
//     methods) and selecting it enables Delete. The <select> is driven via
//     evaluate + a dispatched 'change' (the render/enable handler binds 'change').
// ---------------------------------------------------------------------------

test('a saved config restores into the config select and enables delete', async ({ page }) => {
  const config = {
    id: 'pin-cfg-1',
    name: 'Pin Config Alpha',
    filters: {},
    destination: 'D:\\pinned',
    savedAt: new Date().toISOString(),
  }
  await gotoAutosep(page, { autosep_configs_v1: JSON.stringify([config]) })

  const select = page.locator('#autosep-config-select')
  await expect(select.locator('option', { hasText: 'Pin Config Alpha' })).toHaveCount(1)

  await page.evaluate(() => {
    const sel = document.getElementById('autosep-config-select') as HTMLSelectElement
    sel.value = 'pin-cfg-1'
    sel.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await expect(page.locator('#btn-autosep-delete-config')).toBeEnabled()
})

// ---------------------------------------------------------------------------
// 11. updateAutoSepSummary reflects the saved scope AND strips each span's
//     data-i18n so a later I18n.applyToDOM (languageChanged) cannot reset the
//     localized value back to "All"/"None". Seeding autosep_filter_state_v1 sets
//     hasSavedFilterState=true, so the nav-time adopt no-ops and the seed survives.
// ---------------------------------------------------------------------------

test('the filter summary renders saved tags and strips data-i18n defaults', async ({ page }) => {
  await gotoAutosep(page, {
    autosep_filter_state_v1: JSON.stringify({
      generators: ['comfyui', 'nai', 'webui', 'forge', 'unknown'],
      ratings: ['general', 'sensitive', 'questionable', 'explicit'],
      tags: ['pin_tag_alpha', 'pin_tag_beta'],
      checkpoints: [],
      loras: [],
      prompts: [],
      artist: null,
      search: '',
    }),
  })

  // Force a summary write (also runs in init; this is the exported entrypoint).
  await page.evaluate(() => (window as AutoSepWin).updateAutoSepSummary())

  const tagsSpan = page.locator('#autosep-summary-tags')
  await expect(tagsSpan).toContainText('pin_tag_alpha')
  await expect(tagsSpan).toContainText('pin_tag_beta')

  const probe = await page.evaluate(() => ({
    tags: document.getElementById('autosep-summary-tags')?.hasAttribute('data-i18n') ?? true,
    generators: document.getElementById('autosep-summary-generators')?.hasAttribute('data-i18n') ?? true,
  }))
  expect(probe.tags).toBe(false)
  expect(probe.generators).toBe(false)
})
