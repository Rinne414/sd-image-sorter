import { expect, test, type Page } from '../fixtures/click-ledger'

/**
 * Characterization pins for the Dataset Maker "classic script" family
 * (dataset-maker.js + part2 + part3 + pipeline + local-import + cleanups),
 * ahead of the by-feature module split.
 *
 * SCOPE of THIS file: queue add/remove/reorder + multi-select,
 * caption-editing surfaces this family owns (whole-tag vs substring
 * find/replace, dedupe, tag-pill removal, revert), and the pipeline tab
 * flow (tab switch, queue view mode, queue caption filter).
 *
 * NOT here (already pinned elsewhere — do not duplicate):
 *   - _setActive side-effect chain, _buildQueueItem DOM contract,
 *     _buildExportPayload id/path/manifest split, caption-split NL box,
 *     confidence pills, Separation Console lazy hooks
 *     → tests/e2e/specs/dataset-editor-core.spec.ts
 *   - export/preview wire-format key set + FE-4 missing-builder error
 *     → tests/e2e/specs/dataset-payload-contract.spec.ts
 *
 * Pins encode CURRENT behavior verbatim, quirks included. Each pinned
 * quirk is called out inline and listed in the step-0 report.
 */

test.describe.configure({ mode: 'serial' })

async function stubDatasetRoutes(page: Page) {
  await page.route('**/api/image-thumbnail/**', (route) => route.fulfill({ status: 204 }))
  await page.route('**/api/dataset/local-thumbnail**', (route) => route.fulfill({ status: 204 }))
  await page.route('**/api/tags/export-preview', (route) => route.fulfill({ json: { results: [] } }))
  await page.route('**/api/dataset/export-preview', (route) =>
    route.fulfill({ json: { total: 0, returned: 0, items: [] } }))
  await page.route('**/api/dataset/vocab', (route) => route.fulfill({ json: { vocab: [] } }))
  await page.route('**/api/prompts/categorize', (route) => route.fulfill({ json: { results: [] } }))
}

/**
 * Seed a deterministic gallery-source queue and open the Dataset view so
 * DM.init() runs (binds toolbar/tabs/prune, renders the queue).
 * Waits for the LAST module in the ordered chain (caption-split defines
 * _captionTypeFor) so every DM patch layer is installed first.
 */
async function seedQueue(page: Page) {
  await stubDatasetRoutes(page)
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.waitForFunction(() => typeof (window as any).DatasetMaker?._captionTypeFor === 'function')
  await page.evaluate(() => {
    const dm = (window as any).DatasetMaker
    dm.imageIds = [701, 702, 703, 704]
    dm.meta.set(701, { filename: 'a.png', width: 1024, height: 1024 })
    dm.meta.set(702, { filename: 'b.png', width: 1024, height: 1024 })
    dm.meta.set(703, { filename: 'c.png', width: 1024, height: 1024 })
    dm.meta.set(704, { filename: 'd.png', width: 1024, height: 1024 })
    dm.captions.set(701, '1girl, smile')
    dm.captions.set(702, '')
    dm.captionEdits.set(703, '1girl, hat')
    // 704 stays fully untagged (no captions entry at all).
    ;(window as any).App.switchView('dataset')
    dm._setActive(701)
  })
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('sd-image-sorter-lang', 'en'))
})

// ---------------------------------------------------------------------------
// Queue add / remove / reorder / multi-select
// ---------------------------------------------------------------------------

test('addImageIds dedups, rejects non-positive ids, and returns the new count', async ({ page }) => {
  await seedQueue(page)
  const result = await page.evaluate(async () => {
    const dm = (window as any).DatasetMaker
    dm.imageIds = []
    dm.captions.clear()
    dm.captionEdits.clear()
    const first = await dm.addImageIds([501, 502, 501, -3, 0, 'x', 502], { switchView: false, showToast: false })
    const afterFirst = [...dm.imageIds]
    const second = await dm.addImageIds([502, 503], { switchView: false, showToast: false })
    return { first, afterFirst, second, afterSecond: [...dm.imageIds] }
  })
  // -3 / 0 / 'x' are dropped (id must be finite and > 0); 501 & 502 dedup.
  expect(result.first).toBe(2)
  expect(result.afterFirst).toEqual([501, 502])
  // 502 already present, only 503 is new.
  expect(result.second).toBe(1)
  expect(result.afterSecond).toEqual([501, 502, 503])
})

test('_removeImageById drops the id from every state map and re-homes activeId', async ({ page }) => {
  await seedQueue(page)
  const result = await page.evaluate(() => {
    const dm = (window as any).DatasetMaker
    dm._setActive(702)
    // NL/type maps must be dropped too (leak fixed after the 2026-07 pin
    // sweep: deterministic local ids resurfaced stale entries on re-import).
    dm.nlCaptions.set(701, 'a girl on a hill')
    dm.nlEdits.set(701, 'a girl on a hill, edited')
    dm.captionType.set(701, 'nl')
    // Remove a non-active middle image (no confirm prompt requested).
    dm._removeImageById(701)
    const afterMiddle = {
      ids: [...dm.imageIds],
      hasCap: dm.captions.has(701),
      leaked: dm.nlCaptions.has(701) || dm.nlEdits.has(701) || dm.captionType.has(701),
      active: dm.activeId,
    }
    // Remove the ACTIVE image → activeId moves to the neighbour at the same index.
    dm._removeImageById(702)
    return { afterMiddle, afterActive: { ids: [...dm.imageIds], active: dm.activeId } }
  })
  expect(result.afterMiddle.ids).toEqual([702, 703, 704])
  expect(result.afterMiddle.hasCap).toBe(false)
  expect(result.afterMiddle.leaked).toBe(false)
  expect(result.afterMiddle.active).toBe(702)
  expect(result.afterActive.ids).toEqual([703, 704])
  // 702 was at index 0; the neighbour promoted to active is 703.
  expect(result.afterActive.active).toBe(703)
})

test('queue multi-select: ctrl toggles one, shift selects a range, select-all / clear', async ({ page }) => {
  await seedQueue(page)
  const result = await page.evaluate(() => {
    const dm = (window as any).DatasetMaker
    dm._queueSelection.clear()
    dm._toggleQueueSelection(701)
    const afterToggleOn = [...dm._queueSelection]
    dm._toggleQueueSelection(701)
    const afterToggleOff = [...dm._queueSelection]
    // Ctrl+click semantics: individual add.
    dm._handleMultiSelectClick(702, { shiftKey: false })
    // Shift+click from the last-clicked (702) to 704 selects the inclusive range.
    dm._handleMultiSelectClick(704, { shiftKey: true })
    const afterShiftRange = [...dm._queueSelection].sort((a, b) => a - b)
    dm._selectAllQueue()
    const afterSelectAll = [...dm._queueSelection].sort((a, b) => a - b)
    dm._clearQueueSelection()
    const afterClear = [...dm._queueSelection]
    return { afterToggleOn, afterToggleOff, afterShiftRange, afterSelectAll, afterClear }
  })
  expect(result.afterToggleOn).toEqual([701])
  expect(result.afterToggleOff).toEqual([])
  expect(result.afterShiftRange).toEqual([702, 703, 704])
  expect(result.afterSelectAll).toEqual([701, 702, 703, 704])
  expect(result.afterClear).toEqual([])
})

test('_removeSelectedImages removes the selected set (confirm accepted)', async ({ page }) => {
  await seedQueue(page)
  const result = await page.evaluate(() => {
    const dm = (window as any).DatasetMaker
    window.confirm = () => true
    dm._queueSelection = new Set([701, 703])
    dm._removeSelectedImages()
    return { ids: [...dm.imageIds], selection: [...dm._queueSelection] }
  })
  expect(result.ids).toEqual([702, 704])
  expect(result.selection).toEqual([])
})

// ---------------------------------------------------------------------------
// Caption-editing surfaces owned by this family
// ---------------------------------------------------------------------------

test('find/replace defaults to whole-tag rename; substring mode edits inside tags (pinned quirk)', async ({ page }) => {
  await seedQueue(page)
  await page.locator('#dataset-tab-workbench').click()
  await page.evaluate(() => {
    const dm = (window as any).DatasetMaker
    dm.imageIds = [801]
    dm.captions.clear()
    dm.captionEdits.clear()
    dm.captions.set(801, 'long_hair, hair')
    dm._setActive(801)
    // Caption action scope = all queued images.
    const scope = document.getElementById('dataset-caption-scope') as HTMLSelectElement
    if (scope) { scope.value = 'all'; scope.dispatchEvent(new Event('change', { bubbles: true })) }
    // Find/Replace lives inside a collapsed <details> card — open it.
    const details = document.getElementById('dataset-step-findreplace') as HTMLDetailsElement
    if (details) details.open = true
  })

  // QUIRK 1: default (whole-tag) matches whole comma tokens after folding
  // underscore<->space + case, so "long hair" renames the "long_hair" token
  // but leaves the standalone "hair" token untouched.
  await page.evaluate(() => {
    ;(document.getElementById('dataset-find-input') as HTMLInputElement).value = 'long hair'
    ;(document.getElementById('dataset-replace-input') as HTMLInputElement).value = 'curly hair'
    ;(document.getElementById('dataset-find-substring') as HTMLInputElement).checked = false
  })
  await page.locator('#btn-dataset-find-replace').click()
  await expect
    .poll(() => page.evaluate(() => (window as any).DatasetMaker.captionEdits.get(801)))
    .toBe('curly hair, hair')

  // QUIRK 2: substring mode edits every occurrence of the raw substring,
  // including inside other tags.
  await page.evaluate(() => {
    ;(document.getElementById('dataset-find-input') as HTMLInputElement).value = 'hair'
    ;(document.getElementById('dataset-replace-input') as HTMLInputElement).value = 'HAIR'
    ;(document.getElementById('dataset-find-substring') as HTMLInputElement).checked = true
  })
  await page.locator('#btn-dataset-find-replace').click()
  await expect
    .poll(() => page.evaluate(() => (window as any).DatasetMaker.captionEdits.get(801)))
    .toBe('curly HAIR, HAIR')
})

test('dedupe tags folds space, case AND underscores (pin flipped from the quirk)', async ({ page }) => {
  // Pin FLIPPED 2026-07-12: the original behavior kept "long_hair" as a
  // distinct tag because the dedupe key folded whitespace but not
  // underscores, while find/replace and the export underscore_to_space
  // option treat "long_hair" == "long hair". The key now folds underscores
  // too, so dedupe agrees with the rest of the pipeline.
  await seedQueue(page)
  await page.locator('#dataset-tab-workbench').click()
  await page.evaluate(() => {
    const dm = (window as any).DatasetMaker
    dm.imageIds = [811]
    dm.captions.clear()
    dm.captionEdits.clear()
    // "Long Hair" (key "long hair") collapses with "long hair" AND with
    // "long_hair"; "1girl" collapses with "1girl". First spelling wins.
    dm.captionEdits.set(811, '1girl, 1girl, Long Hair, long hair, long_hair')
    dm._setActive(811)
    const scope = document.getElementById('dataset-caption-scope') as HTMLSelectElement
    if (scope) { scope.value = 'all'; scope.dispatchEvent(new Event('change', { bubbles: true })) }
    // The dedupe button lives inside the collapsed Step-4 <details> card.
    const details = document.getElementById('dataset-step-cleanup') as HTMLDetailsElement
    if (details) details.open = true
  })
  await page.locator('#btn-dataset-dedupe-tags').click()
  await expect
    .poll(() => page.evaluate(() => (window as any).DatasetMaker.captionEdits.get(811)))
    .toBe('1girl, Long Hair')
})

test('removing a tag pill drops that tag from the active caption textarea', async ({ page }) => {
  await seedQueue(page)
  await page.locator('#dataset-tab-workbench').click()
  await page.evaluate(() => {
    const dm = (window as any).DatasetMaker
    dm.captionEdits.set(701, '1girl, smile, hat')
    dm._setActive(701)
  })
  const pills = page.locator('#dataset-tag-pills-wrap button')
  await expect(pills).toHaveCount(3)
  await pills.filter({ hasText: 'hat' }).click()
  // _removeTag rewrites the textarea immediately (captionEdits follows via
  // the debounced input handler).
  await expect(page.locator('#dataset-editor-textarea')).toHaveValue('1girl, smile')
})

test('revert caption deletes the manual edit and restores the backend caption', async ({ page }) => {
  await seedQueue(page)
  await page.locator('#dataset-tab-workbench').click()
  await page.evaluate(() => {
    const dm = (window as any).DatasetMaker
    dm.captions.set(701, '1girl, smile')
    dm.captionEdits.set(701, '1girl, smile, EDITED')
    dm._setActive(701)
  })
  await expect(page.locator('#dataset-editor-textarea')).toHaveValue('1girl, smile, EDITED')
  await page.locator('#btn-dataset-revert-caption').click()
  await expect(page.locator('#dataset-editor-textarea')).toHaveValue('1girl, smile')
  expect(await page.evaluate(() => (window as any).DatasetMaker.captionEdits.has(701))).toBe(false)
})

// ---------------------------------------------------------------------------
// Pipeline tab flow
// ---------------------------------------------------------------------------

test('tab clicks and _setPipelineTab drive data-active-tab + aria-selected together', async ({ page }) => {
  await seedQueue(page)
  await page.locator('#dataset-tab-workbench').click()
  await expect(page.locator('.dataset-maker')).toHaveAttribute('data-active-tab', 'workbench')
  await expect(page.locator('#dataset-tab-workbench')).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('#dataset-tab-import')).toHaveAttribute('aria-selected', 'false')

  // Programmatic switch keeps the same DOM attributes in sync.
  await page.evaluate(() => (window as any).DatasetMaker._setPipelineTab('export'))
  await expect(page.locator('.dataset-maker')).toHaveAttribute('data-active-tab', 'export')
  await expect(page.locator('#dataset-tab-export')).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('#dataset-tab-workbench')).toHaveAttribute('aria-selected', 'false')
})

test('queue view-mode buttons toggle grid/list and persist the choice', async ({ page }) => {
  await seedQueue(page)
  // The queue pane (with the mode buttons) is only shown on the workbench tab.
  await page.locator('#dataset-tab-workbench').click()
  await page.locator('[data-dataset-queue-mode="list"]').click()
  await expect(page.locator('#dataset-queue-list')).toHaveClass(/dataset-queue-list-mode/)
  await expect(page.locator('[data-dataset-queue-mode="list"]')).toHaveAttribute('aria-pressed', 'true')
  expect(await page.evaluate(() => localStorage.getItem('sd-image-sorter-dataset-queue-mode'))).toBe('list')

  await page.locator('[data-dataset-queue-mode="grid"]').click()
  await expect(page.locator('#dataset-queue-list')).toHaveClass(/dataset-queue-grid-mode/)
  expect(await page.evaluate(() => localStorage.getItem('sd-image-sorter-dataset-queue-mode'))).toBe('grid')
})

test('queue caption filter renders only tagged / untagged / all items', async ({ page }) => {
  await seedQueue(page)
  const setFilter = async (value: string) => {
    await page.evaluate((v) => {
      const sel = document.getElementById('dataset-queue-caption-filter') as HTMLSelectElement
      sel.value = v
      sel.dispatchEvent(new Event('change', { bubbles: true }))
    }, value)
  }
  const items = page.locator('#dataset-queue-list .dataset-queue-item')

  await setFilter('all')
  await expect(items).toHaveCount(4)
  await setFilter('tagged')
  // 701 ("1girl, smile") and 703 (captionEdits "1girl, hat") are tagged.
  await expect(items).toHaveCount(2)
  await setFilter('untagged')
  // 702 (empty caption) and 704 (no caption at all) are untagged.
  await expect(items).toHaveCount(2)
})
