import { expect, test, type Page } from '../fixtures/click-ledger'

/**
 * Characterization pins for the Dataset Maker "classic script" family —
 * PART 2: local folder-import (dataset-maker-local-import.js), LoRA-type
 * pruning (dataset-maker-cleanups.js), the export confirm-modal summary,
 * and the naming-preset preview (dataset-maker-part3.js).
 *
 * Companion to dataset-maker-pins.spec.ts (queue + caption + tab flow) and
 * complementary to the already-shipped editor-core / payload-contract specs.
 * Pins encode CURRENT behavior verbatim; pinned quirks are called out inline.
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

async function seedDataset(page: Page) {
  await stubDatasetRoutes(page)
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.waitForFunction(() => typeof (window as any).DatasetMaker?._captionTypeFor === 'function')
  await page.evaluate(() => {
    const dm = (window as any).DatasetMaker
    dm.imageIds = [701]
    dm.meta.set(701, { filename: 'a.png', width: 1024, height: 1024 })
    dm.captions.set(701, '1girl, smile')
    ;(window as any).App.switchView('dataset')
    dm._setActive(701)
  })
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('sd-image-sorter-lang', 'en'))
})

// ---------------------------------------------------------------------------
// Local folder-import
// ---------------------------------------------------------------------------

test('isLocalId + _dsIdToNumericId map ds_id -> a stable negative id', async ({ page }) => {
  await seedDataset(page)
  const r = await page.evaluate(() => {
    const dm = (window as any).DatasetMaker
    const a = dm._dsIdToNumericId('ds:1a2b3c4d5e6f7aa')
    const b = dm._dsIdToNumericId('ds:1a2b3c4d5e6f7aa')
    return {
      a, b,
      negIsLocal: dm.isLocalId(a),
      posIsLocal: dm.isLocalId(5),
      zeroIsLocal: dm.isLocalId(0),
    }
  })
  expect(r.a).toBe(r.b) // deterministic hash of the ds_id
  expect(r.a).toBeLessThan(0) // local ids are always negative
  expect(r.negIsLocal).toBe(true)
  expect(r.posIsLocal).toBe(false)
  // QUIRK: isLocalId uses `< 0`, so id 0 is treated as NON-local.
  expect(r.zeroIsLocal).toBe(false)
})

test('addLocalItems assigns negative ids, tags source=local, and dedups by ds_id', async ({ page }) => {
  await seedDataset(page)
  const r = await page.evaluate(() => {
    const dm = (window as any).DatasetMaker
    dm.imageIds = []
    dm.localItemPaths.clear()
    dm.localItemDsIds.clear()
    dm.captions.clear()
    dm.captionEdits.clear()
    const items = [
      { ds_id: 'ds:aaaaaaaaaaaaa', abs_path: 'C:/a.png', filename: 'a.png', width: 512, height: 512 },
      { ds_id: 'ds:bbbbbbbbbbbbb', abs_path: 'C:/b.png', filename: 'b.png', width: 512, height: 512 },
    ]
    const added1 = dm.addLocalItems(items, { switchView: false, showToast: false })
    const ids = [...dm.imageIds]
    const added2 = dm.addLocalItems(items, { switchView: false, showToast: false })
    return {
      added1,
      count: ids.length,
      allNegative: ids.every((id: number) => id < 0),
      pathsTracked: ids.every((id: number) => !!dm.localItemPaths.get(id)),
      srcLocal: ids.every((id: number) => (dm.meta.get(id) || {}).source === 'local'),
      added2,
      finalCount: dm.imageIds.length,
    }
  })
  expect(r.added1).toBe(2)
  expect(r.count).toBe(2)
  expect(r.allNegative).toBe(true)
  expect(r.pathsTracked).toBe(true)
  expect(r.srcLocal).toBe(true)
  // Same ds_id -> same numeric id -> already-seen, nothing new added.
  expect(r.added2).toBe(0)
  expect(r.finalCount).toBe(2)
})

test('_getLogicalDatasetCount = loaded non-manifest items + (manifest total - excluded)', async ({ page }) => {
  await seedDataset(page)
  const count = await page.evaluate(() => {
    const dm = (window as any).DatasetMaker
    dm.imageIds = [901, 902] // two loaded gallery ids (not manifest-backed)
    dm.meta.set(901, { filename: 'x.png' })
    dm.meta.set(902, { filename: 'y.png' })
    dm.localManifestTokens.clear()
    dm.localManifestTokens.set('tok', {
      scan_token: 'tok',
      folder_path: 'C:/x',
      total: 10,
      excludedPaths: new Set(['C:/x/skip.png']),
    })
    return dm._getLogicalDatasetCount()
  })
  // 2 loaded + (10 - 1 excluded) = 11
  expect(count).toBe(11)
})

test('beside_image output mode forces output_folder="" and image_op="copy" (pinned quirk)', async ({ page }) => {
  await seedDataset(page)
  const payload = await page.evaluate(() => {
    const dm = (window as any).DatasetMaker
    dm.imageIds = [901]
    dm.meta.set(901, { filename: 'a.png', width: 1024, height: 1024 })
    dm.localManifestTokens.clear()
    // Set a folder + a MOVE op that beside_image must override.
    ;(document.getElementById('dataset-output-folder') as HTMLInputElement).value = 'C:/out'
    ;(document.getElementById('dataset-image-op') as HTMLInputElement).value = 'move'
    const beside = document.querySelector('input[name="dataset-output-mode"][value="beside_image"]') as HTMLInputElement
    beside.checked = true
    beside.dispatchEvent(new Event('change', { bubbles: true }))
    return dm._buildExportPayload()
  })
  expect(payload.output_mode).toBe('beside_image')
  expect(payload.output_folder).toBe('')
  expect(payload.image_op).toBe('copy')
})

// ---------------------------------------------------------------------------
// LoRA-type pruning (cleanups)
// ---------------------------------------------------------------------------

async function readPruneChecks(page: Page): Promise<Record<string, boolean>> {
  return page.evaluate(() => {
    const out: Record<string, boolean> = {}
    document.querySelectorAll('#dataset-lora-prune-cats input[type="checkbox"]').forEach((el) => {
      out[(el as HTMLInputElement).dataset.cat as string] = (el as HTMLInputElement).checked
    })
    return out
  })
}

test('selecting a LoRA type ticks its preset categories; a manual tick flips it to "custom"', async ({ page }) => {
  await seedDataset(page)
  await page.evaluate(() => {
    const sel = document.getElementById('dataset-lora-type') as HTMLSelectElement
    sel.value = 'style'
    sel.dispatchEvent(new Event('change', { bubbles: true }))
  })
  const styleChecks = await readPruneChecks(page)
  // style preset = style, artist, meta, quality, rating.
  for (const cat of ['style', 'artist', 'meta', 'quality', 'rating']) {
    expect(styleChecks[cat]).toBe(true)
  }
  for (const cat of ['character', 'body', 'outfit', 'expression', 'pose', 'action', 'angle', 'background']) {
    expect(styleChecks[cat]).toBe(false)
  }

  // Ticking one more category no longer matches the "style" preset -> "custom".
  await page.evaluate(() => {
    const body = document.querySelector('#dataset-lora-prune-cats input[data-cat="body"]') as HTMLInputElement
    body.checked = true
    body.dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect(await page.evaluate(() => (document.getElementById('dataset-lora-type') as HTMLSelectElement).value)).toBe('custom')
  expect((await readPruneChecks(page)).body).toBe(true)
})

test('clear button unticks every prune category and sets the type to "custom"', async ({ page }) => {
  await seedDataset(page)
  await page.locator('#dataset-tab-workbench').click()
  // Prune controls live inside the collapsed Step-4 <details> card.
  await page.evaluate(() => {
    const details = document.getElementById('dataset-step-cleanup') as HTMLDetailsElement
    if (details) details.open = true
  })
  // Start from a preset with several ticks (character is the default type).
  await page.evaluate(() => {
    const sel = document.getElementById('dataset-lora-type') as HTMLSelectElement
    sel.value = 'character'
    sel.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await page.locator('#btn-dataset-lora-prune-clear').click()
  const checks = await readPruneChecks(page)
  expect(Object.values(checks).some(Boolean)).toBe(false)
  expect(await page.evaluate(() => (document.getElementById('dataset-lora-type') as HTMLSelectElement).value)).toBe('custom')
})

// ---------------------------------------------------------------------------
// Export confirm modal + naming preview
// ---------------------------------------------------------------------------

test('confirm modal surfaces empty-caption, small-image, and few-image warnings', async ({ page }) => {
  await seedDataset(page)
  await page.evaluate(() => {
    const dm = (window as any).DatasetMaker
    dm.imageIds = [901, 902, 903]
    dm.captions.clear()
    dm.captionEdits.clear()
    dm.meta.set(901, { filename: 'x.png', width: 1024, height: 1024 })
    dm.meta.set(902, { filename: 'y.png', width: 300, height: 300 }) // small + untagged
    dm.meta.set(903, { filename: 'z.png', width: 1024, height: 1024 })
    dm.captions.set(901, '1girl')
    dm.captions.set(903, '1girl')
    const folder = document.getElementById('dataset-output-folder') as HTMLInputElement
    folder.value = 'C:/out'
    folder.dispatchEvent(new Event('input', { bubbles: true }))
    dm._updateExportEnabled()
  })
  await page.locator('#dataset-tab-export').click()
  await page.locator('#btn-dataset-export').click()

  const summary = page.locator('#dataset-confirm-summary')
  await expect(page.locator('#dataset-confirm-modal')).toBeVisible()
  await expect(summary).toContainText('have empty captions') // 902 untagged
  await expect(summary).toContainText('under 512 px') // 902 small
  await expect(summary).toContainText('15-50 images') // only 3 images total (< 10)
})

test('renumber naming drops the orphan underscore when the trigger is empty (MED-5 quirk)', async ({ page }) => {
  await seedDataset(page)
  await page.locator('#dataset-tab-export').click()
  await page.evaluate(() => {
    const dm = (window as any).DatasetMaker
    dm.imageIds = [901]
    dm.meta.set(901, { filename: 'a.png', width: 1024, height: 1024 })
    const renumber = document.querySelector('input[name="dataset-naming-preset"][value="renumber"]') as HTMLInputElement
    renumber.checked = true
    renumber.dispatchEvent(new Event('change', { bubbles: true }))
    const trig = document.getElementById('dataset-trigger') as HTMLInputElement
    trig.value = ''
    trig.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const preview = page.locator('#dataset-naming-preview')
  await expect(preview).toContainText('001.') // e.g. "001.png  +  001.txt"
  await expect(preview).not.toContainText('_001') // no orphan leading underscore
  expect(await page.evaluate(() => (window as any).DatasetMaker._effectivePattern())).toBe('{index:03d}')

  // With a trigger, the pattern regains the "{trigger}_" prefix.
  await page.evaluate(() => {
    const trig = document.getElementById('dataset-trigger') as HTMLInputElement
    trig.value = 'char'
    trig.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await expect(preview).toContainText('char_001')
  expect(await page.evaluate(() => (window as any).DatasetMaker._effectivePattern())).toBe('{trigger}_{index:03d}')
})
