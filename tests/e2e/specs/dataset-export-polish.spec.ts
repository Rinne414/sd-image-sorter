import { expect, test, type Page } from '../fixtures/click-ledger'
import { markModelsReady } from '../fixtures/model-status'

/**
 * Dataset Maker / Smart Tag polish found in a 1366x768 walkthrough:
 *
 *  12. Smart Tag says it finished, with counts, where the user is looking,
 *      and its progress is visible without scrolling;
 *  13. the export header count follows the set after a reject + Z restore;
 *  14. a red token count says why and what to do;
 *  15. workbench layout: the zoom bar clears the editor title, the step rail
 *      never covers the setup fields, the tag colour legend starts folded
 *      and remembers, and the export tab opens at its top.
 *
 * Every backend route the page touches is stubbed; no model is downloaded.
 */

test.use({ viewport: { width: 1366, height: 768 } })

async function stubCommonRoutes(page: Page): Promise<void> {
  await page.route('**/api/image-thumbnail/**', (route) => route.fulfill({ status: 204 }))
  await page.route('**/api/dataset/local-thumbnail**', (route) => route.fulfill({ status: 204 }))
  await page.route('**/api/dataset/vocab', (route) => route.fulfill({ json: { vocab: [] } }))
  await page.route('**/api/prompts/categorize', (route) => route.fulfill({ json: { results: [] } }))
  await page.route('**/api/tags/export-preview', (route) => route.fulfill({ json: { results: [] } }))
  await page.route('**/api/smart-tag/progress**', (route) => route.fulfill({ json: { status: 'idle' } }))
}

async function openDatasetMaker(page: Page, ids: number[]): Promise<void> {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.waitForFunction(() => typeof (window as any).DatasetMaker?._captionTypeFor === 'function')
  await page.evaluate(() => (window as any).App.switchView('dataset'))
  await page.waitForFunction(() => {
    const dm = (window as any).DatasetMaker
    return dm?._trainerContractState?.status === 'ready' && dm?._pendingProjectSettings === null
  })
  await page.evaluate((imageIds) => {
    const dm = (window as any).DatasetMaker
    dm.imageIds = imageIds
    for (const id of imageIds) {
      dm.meta.set(id, { filename: `walk-${id}.png`, width: 1024, height: 1024 })
      dm.captions.set(id, '1girl, solo')
    }
    dm._renderQueue()
    dm._updateCount()
  }, ids)
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('sd-image-sorter-lang', 'en')
  })
  await stubCommonRoutes(page)
})

// ---------------------------------------------------------------------------
// 13. Export header count after reject + Z restore
// ---------------------------------------------------------------------------

test('the export header count follows the set after a reject is undone', async ({ page }) => {
  const ids = Array.from({ length: 25 }, (_, index) => 1001 + index)
  await openDatasetMaker(page, ids)
  // The import flows announce a membership change; seed the same way.
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('dataset:changed')))
  const line = page.locator('#dataset-steps-line')
  await expect(line).toContainText('25 images')

  await page.evaluate(() => {
    const dm = (window as any).DatasetMaker
    dm._setPipelineTab('workbench')
    dm._setActive(1005)
    dm._dropImageForReview(1005)
  })
  await expect(line).toContainText('24 images')
  await page.evaluate(() => (window as any).DatasetMaker._undoReviewDrop())
  await expect(line).toContainText('25 images')
})

// ---------------------------------------------------------------------------
// 14. Red token count explains itself
// ---------------------------------------------------------------------------

test('an over-budget token count says why and what to do', async ({ page }) => {
  await openDatasetMaker(page, [991])
  const longCaption = Array.from({ length: 40 }, (_, index) => `long_descriptive_tag_${index}`).join(', ')
  await page.evaluate((caption) => {
    const dm = (window as any).DatasetMaker
    dm._setPipelineTab('workbench')
    dm._setActive(991)
    const box = document.getElementById('dataset-editor-textarea') as HTMLTextAreaElement
    box.value = caption
    ;(window as any).SeparationConsole._updateTokenCounter()
  }, longCaption)

  const counter = page.locator('#dataset-token-counter')
  await expect(counter).toHaveClass(/dataset-token-counter-over/)
  const note = page.locator('#dataset-token-counter-note')
  await expect(note).toBeVisible()
  await expect(note).toContainText('75')
  await expect(note).toContainText('max_token_length')
  await expect(counter).toHaveAttribute('title', /75-token/)

  await page.evaluate(() => {
    const box = document.getElementById('dataset-editor-textarea') as HTMLTextAreaElement
    box.value = '1girl, solo'
    ;(window as any).SeparationConsole._updateTokenCounter()
  })
  await expect(counter).not.toHaveClass(/dataset-token-counter-over/)
  await expect(note).toBeHidden()
})
