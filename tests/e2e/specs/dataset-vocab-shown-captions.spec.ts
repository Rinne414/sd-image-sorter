import { expect, test, type Page } from '../fixtures/click-ledger'

/**
 * Issue #5: the Tag Vocabulary counts the caption the user sees — an imported
 * .txt, a rendered gallery caption, or the user's edit of either — instead of
 * only edited rows (folder imports showed 0 / 0) or raw DB tags (gallery edits
 * were ignored). /api/dataset/vocab is NOT stubbed: the real backend counts.
 */

async function openDataset(page: Page) {
  await page.route('**/api/image-thumbnail/**', (route) => route.fulfill({ status: 204 }))
  await page.route('**/api/dataset/local-thumbnail**', (route) => route.fulfill({ status: 204 }))
  await page.route('**/api/tags/export-preview', (route) => route.fulfill({ json: { results: [] } }))
  await page.route('**/api/dataset/export-preview', (route) =>
    route.fulfill({ json: { total: 0, returned: 0, items: [] } }))
  await page.route('**/api/prompts/categorize', (route) => route.fulfill({ json: { results: [] } }))
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.waitForFunction(() => typeof (window as any).DatasetMaker?._captionTypeFor === 'function')
  await page.evaluate(() => (window as any).App.switchView('dataset'))
  await page.locator('#dataset-tab-workbench').click()
}

async function openVocabPanel(page: Page) {
  await page.evaluate(() => {
    ;(document.getElementById('dataset-step-cleanup') as HTMLDetailsElement).open = true
  })
  await page.locator('#dataset-vocab-panel > summary').click()
}

async function vocabCounts(page: Page) {
  return page.locator('#dataset-vocab-list .dataset-vocab-tag').evaluateAll((rows) =>
    Object.fromEntries(rows.map((row) => [
      row.querySelector('.dataset-vocab-tag-label')?.textContent ?? '',
      Number(row.querySelector('.dataset-vocab-tag-count')?.textContent ?? 0),
    ])))
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('sd-image-sorter-lang', 'en'))
})

test('vocabulary counts folder-imported .txt captions before anything is edited', async ({ page }) => {
  await openDataset(page)
  await page.evaluate(() => {
    const dm = (window as any).DatasetMaker
    dm.addLocalItems([
      { ds_id: 'ds:0a1b2c3d4e5f61', abs_path: 'C:/e2e-vocab/a.png', filename: 'a.png', sidecar_caption: '1girl, smile' },
      { ds_id: 'ds:0a1b2c3d4e5f62', abs_path: 'C:/e2e-vocab/b.png', filename: 'b.png', sidecar_caption: '1girl, hat' },
    ], { switchView: false, showToast: false })
  })
  await openVocabPanel(page)

  await expect(page.locator('#dataset-vocab-count')).toHaveText('3 / 3')
  expect(await vocabCounts(page)).toEqual({ '1girl': 2, smile: 1, hat: 1 })

  // An edit replaces the imported caption in the count, it is not added to it.
  await page.evaluate(() => {
    const dm = (window as any).DatasetMaker
    const localId = dm.imageIds.find((id: number) => dm.localItemPaths.get(id) === 'C:/e2e-vocab/b.png')
    dm.captionEdits.set(localId, 'solo, hat')
  })
  await page.locator('#btn-dataset-vocab-refresh').click()
  await expect.poll(() => vocabCounts(page)).toEqual({ '1girl': 1, smile: 1, solo: 1, hat: 1 })
})

test('vocabulary counts the gallery captions shown in the editor, edits included', async ({ page }) => {
  await openDataset(page)
  await page.evaluate(() => {
    const dm = (window as any).DatasetMaker
    dm.imageIds = [701, 702, 703]
    for (const id of dm.imageIds) dm.meta.set(id, { filename: `img_${id}.png`, width: 512, height: 512 })
    dm.captions.set(701, '1girl, smile')
    dm.captions.set(702, '')
    dm.captions.set(703, '1girl, smile')
    dm.captionEdits.set(703, '1girl, hat')
    dm._renderQueue()
  })
  await openVocabPanel(page)

  await expect(page.locator('#dataset-vocab-count')).toHaveText('3 / 3')
  expect(await vocabCounts(page)).toEqual({ '1girl': 2, smile: 1, hat: 1 })
})
