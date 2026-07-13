import { expect, test, type Page } from '../fixtures/click-ledger'

/**
 * Characterization pins for the manual-sort.js god-file (3,731 lines) — "step 0"
 * of a later VERBATIM decomposition (mirrors the shipped app.js / gallery.js /
 * censor / dataset splits).
 *
 * manual-sort.js is the WASD keyboard "rhythm sort" workbench: slot (WASD folder
 * sort), A/B Showdown (bracket) and Keep/Reject (cull) modes, session setup,
 * undo/redo, presets, cooldown, focus (zen) mode, and the gallery-scope filter
 * bundle. Structurally it is the app.js model, NOT the gallery.js model:
 *   - top-level classic-script `function` declarations (global identity) +
 *     lexical `const`s (ManualSortState, KEY_MAP, DIRECTION_MAP, the storage-key
 *     constants) shared through the global lexical env;
 *   - it builds NO facade and seals nothing — its ENTIRE cross-module contract is
 *     six `window.*` exports (ManualSortState, updateManualSortFilterSummary,
 *     maybeAdoptManualSortFiltersFromGallery, refreshManualSortScopeCount,
 *     createTouchControls, redoLastAction) + a DOMContentLoaded → initManualSort
 *     boot. `window._switchSortingSub` (the nav entry) lives in index.html, not
 *     here, and calls two of those exports.
 *
 * These pins lock the OBSERVABLE setup-screen + window-surface behavior that a
 * verbatim cut/move most endangers (a dropped export, a const that lands in a
 * file loaded too late, a function moved past its caller). They MUST pass before
 * AND after the split. The full LIVE flows (real image moves, undo, bracket
 * winner routing, cull tallies) are already covered by manual-regression.spec.ts
 * and are deliberately NOT duplicated here.
 *
 * Deliberately pinned quirks (each has a loud comment):
 *   - copy is the operation-mode default and a corrupt stored value falls back to
 *     'copy' at RUNTIME, never 'move' (safety invariant, Principle #11);
 *   - the filter-summary writer strips each span's `data-i18n` so a later
 *     I18n.applyToDOM can't reset the localized scope back to "All"/"None";
 *   - focus (zen) preference paints the button but is NOT applied to <html> on the
 *     setup screen (zen is a stage-only affordance).
 *
 * The isolated e2e DB starts empty (0-count galleries are legitimate) and the
 * suite storageState seeds aurora-entry-skip=1 so we land straight in the app.
 * None of these pins need seeded images or a server session.
 */

test.describe.configure({ mode: 'serial' })

type ManualWin = typeof window & {
  App: any
  ManualSortState: any
  // Called in this spec, so typed callable; the others are only `typeof`-probed.
  updateManualSortFilterSummary: () => void
  _switchSortingSub: (sub: string) => void
  maybeAdoptManualSortFiltersFromGallery: unknown
  refreshManualSortScopeCount: unknown
  createTouchControls: unknown
  redoLastAction: unknown
}

/**
 * Load the app and land on the Manual Sort setup screen.
 *
 * Per-test localStorage seeds MUST be registered before navigation, so callers
 * pass them here (addInitScript runs before the page's own scripts). Readiness =
 * app boot flag (dataset.appReady) plus the manual-sort window exports present;
 * page.goto waits for `load`, which fires after every DOMContentLoaded handler
 * (both the app boot and initManualSort), so the setup controls are wired.
 */
async function gotoManualSetup(page: Page, seeds?: Record<string, string>): Promise<void> {
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
    const w = window as ManualWin
    return (
      document.documentElement.dataset.appReady === '1' &&
      !!w.ManualSortState &&
      typeof w.updateManualSortFilterSummary === 'function' &&
      typeof w.App?.switchView === 'function' &&
      typeof w._switchSortingSub === 'function'
    )
  })
  // Sorting view → Manual Sort sub-view (the real nav path other modules use).
  await page.evaluate(() => {
    const w = window as ManualWin
    w.App.switchView('sorting')
    w._switchSortingSub('manual')
  })
  await expect(page.locator('#view-manual')).toBeVisible()
  await expect(page.locator('#sort-setup')).toBeVisible()
}

// ---------------------------------------------------------------------------
// 1. Cross-module window surface — the ENTIRE public contract of the file.
//    A verbatim split must keep every one of these attached, or _switchSortingSub
//    and the app/*.js summary hooks silently break.
// ---------------------------------------------------------------------------

test('manual-sort.js publishes its full cross-module window surface', async ({ page }) => {
  await gotoManualSetup(page)
  const probe = await page.evaluate(() => {
    const w = window as ManualWin
    const s = w.ManualSortState || {}
    return {
      stateIsObject: !!w.ManualSortState && typeof w.ManualSortState === 'object',
      // Exported functions consumed by app/selection.js, app/filter-summary.js,
      // app/filter-modal-data.js and the index.html sorting-sub-tab nav.
      exportTypes: {
        updateManualSortFilterSummary: typeof w.updateManualSortFilterSummary,
        maybeAdoptManualSortFiltersFromGallery: typeof w.maybeAdoptManualSortFiltersFromGallery,
        refreshManualSortScopeCount: typeof w.refreshManualSortScopeCount,
        createTouchControls: typeof w.createTouchControls,
        redoLastAction: typeof w.redoLastAction,
      },
      // Defined in index.html inline, but the manual view integrates through it.
      switchSortingSubType: typeof w._switchSortingSub,
      // ManualSortState keys the split must not lose (read by resume/apply paths).
      hasOperationMode: 'operationMode' in s,
      hasMode: 'mode' in s,
      hasActive: 'active' in s,
      foldersIsObject: !!s.folders && typeof s.folders === 'object',
      collectionSlotsIsObject: !!s.collectionSlots && typeof s.collectionSlots === 'object',
    }
  })

  expect(probe.stateIsObject).toBe(true)
  expect(probe.exportTypes).toEqual({
    updateManualSortFilterSummary: 'function',
    maybeAdoptManualSortFiltersFromGallery: 'function',
    refreshManualSortScopeCount: 'function',
    createTouchControls: 'function',
    redoLastAction: 'function',
  })
  expect(probe.switchSortingSubType).toBe('function')
  expect(probe.hasOperationMode).toBe(true)
  expect(probe.hasMode).toBe(true)
  expect(probe.hasActive).toBe(true)
  expect(probe.foldersIsObject).toBe(true)
  expect(probe.collectionSlotsIsObject).toBe(true)
})

// ---------------------------------------------------------------------------
// 2. Copy is the operation-mode default (safety invariant, Principle #11).
// ---------------------------------------------------------------------------

test('operation mode defaults to copy with the copy radio pre-checked', async ({ page }) => {
  // No manual_sort_operation_mode_v1 seed → the init fallback must resolve copy.
  await gotoManualSetup(page)

  const mode = await page.evaluate(() => (window as ManualWin).ManualSortState.operationMode)
  expect(mode).toBe('copy')

  await expect(page.locator('input[name="manual-sort-operation"][value="copy"]')).toBeChecked()
  await expect(page.locator('input[name="manual-sort-operation"][value="move"]')).not.toBeChecked()
})

// ---------------------------------------------------------------------------
// 3. A corrupt stored operation mode falls back to copy at RUNTIME. The
//    release-build test pins the source string; this pins the actual init path
//    (a corrupt localStorage value must never silently choose the destructive
//    'move' branch).
// ---------------------------------------------------------------------------

test('a corrupt saved operation mode resolves to copy, never move', async ({ page }) => {
  await gotoManualSetup(page, { manual_sort_operation_mode_v1: 'not-a-real-mode' })

  const mode = await page.evaluate(() => (window as ManualWin).ManualSortState.operationMode)
  expect(mode).toBe('copy')
  await expect(page.locator('input[name="manual-sort-operation"][value="copy"]')).toBeChecked()
  await expect(page.locator('input[name="manual-sort-operation"][value="move"]')).not.toBeChecked()
})

// ---------------------------------------------------------------------------
// 4. An explicitly saved 'move' IS honored — proving the copy fallback above is
//    a real decision through normalizeManualSortOperationMode, not a hardcode.
// ---------------------------------------------------------------------------

test('an explicitly saved move mode is honored on load', async ({ page }) => {
  await gotoManualSetup(page, { manual_sort_operation_mode_v1: 'move' })

  const mode = await page.evaluate(() => (window as ManualWin).ManualSortState.operationMode)
  expect(mode).toBe('move')
  await expect(page.locator('input[name="manual-sort-operation"][value="move"]')).toBeChecked()
  await expect(page.locator('input[name="manual-sort-operation"][value="copy"]')).not.toBeChecked()
})

// ---------------------------------------------------------------------------
// 5. Toggling the operation radio drives ManualSortState + persists + relabels
//    the execution-mode helper. (manual-regression checks the radio as SETUP but
//    never asserts the state/persistence/summary wiring.)
// ---------------------------------------------------------------------------

test('choosing an operation radio updates state, summary text, and persists', async ({ page }) => {
  await gotoManualSetup(page)

  const copyText = (await page.locator('#manual-sort-execution-mode').textContent())?.trim() || ''

  await page.locator('input[name="manual-sort-operation"][value="move"]').check({ force: true })
  const afterMove = await page.evaluate(() => ({
    mode: (window as ManualWin).ManualSortState.operationMode,
    stored: localStorage.getItem('manual_sort_operation_mode_v1'),
  }))
  expect(afterMove.mode).toBe('move')
  expect(afterMove.stored).toBe('move')
  const moveText = (await page.locator('#manual-sort-execution-mode').textContent())?.trim() || ''
  // Language-independent: the summary line must change when the mode changes.
  expect(moveText).not.toBe(copyText)
  expect(moveText.length).toBeGreaterThan(0)

  await page.locator('input[name="manual-sort-operation"][value="copy"]').check({ force: true })
  const afterCopy = await page.evaluate(() => ({
    mode: (window as ManualWin).ManualSortState.operationMode,
    stored: localStorage.getItem('manual_sort_operation_mode_v1'),
  }))
  expect(afterCopy.mode).toBe('copy')
  expect(afterCopy.stored).toBe('copy')
})

// ---------------------------------------------------------------------------
// 6. The workbench mode switch (slot / bracket / cull) is tri-state exclusive,
//    persists the choice, moves aria-selected, and relabels the Start button.
//    (manual-regression checks is-active + intro visibility; the persistence,
//    aria-selected, tri-state exclusivity, and relabel are unpinned.)
// ---------------------------------------------------------------------------

test('the workbench mode switch is exclusive, persists, and relabels start', async ({ page }) => {
  await gotoManualSetup(page)

  // Read the whole Start button, not #sort-start-label: ui-refresh.js may rebuild
  // the button into <span>🎮</span><span class="ui-label">…</span>, dropping the
  // #sort-start-label id (the very quirk setManualSortSelectedMode guards). The
  // button always exists and always carries the per-mode label.
  const startBtn = page.locator('#btn-start-sorting')
  const slotLabel = (await startBtn.textContent())?.trim() || ''

  // → A/B Showdown (bracket)
  await page.locator('.sort-mode-btn[data-sort-mode="bracket"]').click()
  await expect(page.locator('.sort-mode-btn[data-sort-mode="bracket"]')).toHaveClass(/is-active/)
  await expect(page.locator('.sort-mode-btn[data-sort-mode="bracket"]')).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('.sort-mode-btn[data-sort-mode="slot"]')).toHaveAttribute('aria-selected', 'false')
  await expect(page.locator('.folder-config.sort-slot-only')).toBeHidden()
  await expect(page.locator('#sort-bracket-intro')).toBeVisible()
  await expect(page.locator('#sort-cull-intro')).toBeHidden()
  const bracketLabel = (await startBtn.textContent())?.trim() || ''
  expect(bracketLabel).not.toBe(slotLabel)
  expect(await page.evaluate(() => localStorage.getItem('manual_sort_mode_v1'))).toBe('bracket')

  // → Keep/Reject (cull)
  await page.locator('.sort-mode-btn[data-sort-mode="cull"]').click()
  await expect(page.locator('.sort-mode-btn[data-sort-mode="cull"]')).toHaveClass(/is-active/)
  await expect(page.locator('#sort-cull-intro')).toBeVisible()
  await expect(page.locator('#sort-bracket-intro')).toBeHidden()
  await expect(page.locator('.folder-config.sort-slot-only')).toBeHidden()
  expect(await page.evaluate(() => localStorage.getItem('manual_sort_mode_v1'))).toBe('cull')

  // → back to slot (WASD): folder config returns, bracket/cull intros hide.
  await page.locator('.sort-mode-btn[data-sort-mode="slot"]').click()
  await expect(page.locator('.sort-mode-btn[data-sort-mode="slot"]')).toHaveClass(/is-active/)
  await expect(page.locator('.folder-config.sort-slot-only')).toBeVisible()
  await expect(page.locator('#sort-bracket-intro')).toBeHidden()
  await expect(page.locator('#sort-cull-intro')).toBeHidden()
  expect(await page.evaluate(() => localStorage.getItem('manual_sort_mode_v1'))).toBe('slot')
})

// ---------------------------------------------------------------------------
// 7. A slot's destination type toggle swaps the folder input for the collection
//    <select> (refreshManualSortSlotUi + initManualSortSlotControls). Not touched
//    by any live-flow test.
// ---------------------------------------------------------------------------

test('a slot type toggle swaps the folder input for the collection select', async ({ page }) => {
  await gotoManualSetup(page)

  // refreshManualSortSlotUi drives `element.hidden` for both nodes. Originally
  // only the JS `.hidden` PROPERTY could be pinned because
  // `.slot-folder-target { display:flex }` overrode its `[hidden]` attribute
  // (the pin sweep's BUG-1); the CSS guard fix landed with this strengthened
  // pin, so REAL visibility is asserted for both nodes now.
  const collectionSelectW = page.locator('.slot-collection-select[data-key="w"]')
  const folderTargetW = page.locator('.slot-target[data-key="w"] .slot-folder-target')
  const readHidden = () =>
    page.evaluate(() => {
      const target = document.querySelector('.slot-target[data-key="w"]')
      return {
        folder: (target?.querySelector('.slot-folder-target') as HTMLElement | null)?.hidden ?? null,
        collection: (target?.querySelector('.slot-collection-select') as HTMLElement | null)?.hidden ?? null,
      }
    })

  // Default: folder-typed slot — folder target shown, collection select hidden.
  expect(await readHidden()).toEqual({ folder: false, collection: true })
  await expect(collectionSelectW).toBeHidden()

  await page.locator('input[name="slot-type-w"][value="collection"]').check({ force: true })
  expect(await readHidden()).toEqual({ folder: true, collection: false })
  await expect(collectionSelectW).toBeVisible()
  // BUG-1 regression pin: the folder input must REALLY disappear (the
  // display:flex rule used to beat [hidden] and kept it on screen).
  await expect(folderTargetW).toBeHidden()

  await page.locator('input[name="slot-type-w"][value="folder"]').check({ force: true })
  expect(await readHidden()).toEqual({ folder: false, collection: true })
  await expect(collectionSelectW).toBeHidden()
  // Choosing 'folder' clears any collection id for the slot.
  const slotW = await page.evaluate(() => (window as ManualWin).ManualSortState.collectionSlots.w)
  expect(slotW).toBeNull()
})

// ---------------------------------------------------------------------------
// 8. Named presets restore into the <select> on load (getManualSortPresets +
//    populateManualSortPresetSelect, built with DOM methods because the security
//    hook blocks innerHTML). Not covered by any flow test.
// ---------------------------------------------------------------------------

test('a saved preset appears in the preset select and enables delete', async ({ page }) => {
  const preset = {
    name: 'PinPreset Alpha',
    mode: 'slot',
    operationMode: 'copy',
    filters: {},
    collectionSlots: { w: null, a: null, s: null, d: null },
    folders: {},
  }
  await gotoManualSetup(page, { manual_sort_presets_v1: JSON.stringify([preset]) })

  const select = page.locator('#sort-preset-select')
  await expect(select.locator('option[value="PinPreset Alpha"]')).toHaveCount(1)
  await expect(page.locator('#btn-sort-preset-delete')).toBeEnabled()
})

// ---------------------------------------------------------------------------
// 9. Focus (zen) preference paints the button but is NOT applied to <html> on the
//    setup screen — zen is a stage-only affordance (init calls applyManualSortZen
//    then clearManualSortZen).
// ---------------------------------------------------------------------------

test('a saved zen preference lights the button but does not collapse chrome in setup', async ({ page }) => {
  await gotoManualSetup(page, { manual_sort_zen_v1: '1' })

  await expect(page.locator('#btn-sort-zen')).toHaveAttribute('aria-pressed', 'true')
  const hasZenClass = await page.evaluate(() => document.documentElement.classList.contains('sort-zen'))
  expect(hasZenClass).toBe(false)
})

// ---------------------------------------------------------------------------
// 10. The opt-in action cooldown restores from localStorage (initManualSortCooldownControls).
//     Default OFF; a saved value enables the toggle, reveals the row, and seeds
//     ManualSortState.actionCooldownMs.
// ---------------------------------------------------------------------------

test('a saved action cooldown restores the toggle, slider, row, and state', async ({ page }) => {
  await gotoManualSetup(page, { manual_sort_cooldown_ms_v1: '500' })

  await expect(page.locator('#manual-sort-cooldown-toggle')).toBeChecked()
  await expect(page.locator('#manual-sort-cooldown-ms')).toHaveValue('500')
  await expect(page.locator('#manual-sort-cooldown-row')).toBeVisible()
  const cd = await page.evaluate(() => (window as ManualWin).ManualSortState.actionCooldownMs)
  expect(cd).toBe(500)
})

// ---------------------------------------------------------------------------
// 11. The filter-summary writer reflects the saved scope AND strips data-i18n so
//     a later I18n.applyToDOM cannot reset the localized value back to
//     "All"/"None" (updateManualSortFilterSummary, an exported entrypoint).
// ---------------------------------------------------------------------------

test('the filter summary reflects saved tags and strips data-i18n defaults', async ({ page }) => {
  await gotoManualSetup(page, {
    manual_sort_filter_state_v1: JSON.stringify({
      generators: ['comfyui', 'nai', 'webui', 'forge', 'unknown'],
      ratings: ['general', 'sensitive', 'questionable', 'explicit'],
      tags: ['pin_tag_alpha', 'pin_tag_beta'],
      checkpoints: [],
      loras: [],
      prompts: [],
      artist: null,
      search: '',
      sortBy: 'newest',
      limit: 0,
    }),
  })

  // Force a summary write (also runs in init; this is the exported entrypoint).
  await page.evaluate(() => (window as ManualWin).updateManualSortFilterSummary())

  const tagsSpan = page.locator('#manual-sort-summary-tags')
  await expect(tagsSpan).toContainText('pin_tag_alpha')
  await expect(tagsSpan).toContainText('pin_tag_beta')
  // The data-i18n attribute must be stripped so languageChanged can't reset it.
  const probe = await page.evaluate(() => {
    const tags = document.getElementById('manual-sort-summary-tags')
    const generators = document.getElementById('manual-sort-summary-generators')
    return {
      tagsHasI18n: tags?.hasAttribute('data-i18n') ?? true,
      generatorsHasI18n: generators?.hasAttribute('data-i18n') ?? true,
    }
  })
  expect(probe.tagsHasI18n).toBe(false)
  expect(probe.generatorsHasI18n).toBe(false)
})
