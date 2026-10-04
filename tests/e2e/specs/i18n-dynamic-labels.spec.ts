import { expect, test, type Page } from '../fixtures/click-ledger'

/**
 * Any DOM change under #app re-applies every [data-i18n] text (ui-refresh's
 * MutationObserver). A label code sets at runtime must either carry its own
 * key or be locked, or the next mutation silently puts the static text back.
 * Walkthroughs (2026-10-04) found this class several times; these pin the
 * labels that were still exposed.
 */

test.use({ viewport: { width: 1366, height: 768 } })

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('sd-image-sorter-lang', 'en')
    localStorage.setItem('sd-sorter-entry-skip-session', '1')
  })
  await page.goto('/')
  await page.waitForFunction(() => document.documentElement.dataset.appReady === '1')
})

async function mutateDom(page: Page): Promise<void> {
  await page.evaluate(() => document.getElementById('app')!.appendChild(document.createElement('div')))
  await page.waitForTimeout(400)
}

test('the global loading message survives a DOM change, and defaults to the translation', async ({ page }) => {
  const message = page.locator('#global-loading-msg')
  await page.evaluate(() => (window as any).showGlobalLoading('Preparing 3 files'))
  await mutateDom(page)
  await expect(message).toHaveText('Preparing 3 files')

  await page.evaluate(() => { (window as any).hideGlobalLoading(); (window as any).showGlobalLoading() })
  await expect(message).toHaveText('Loading...')
  await page.evaluate(() => (window as any).hideGlobalLoading())
})

test('the model picker keeps its LoRA title through a DOM change', async ({ page }) => {
  await page.evaluate(() => (window as any).openModelSelect('lora'))
  await mutateDom(page)
  await expect(page.locator('#model-select-title')).toHaveText('Select LoRAs')
})

test('a filter modal opened with its own wording keeps it through a DOM change', async ({ page }) => {
  await page.evaluate(() => (window as any).openFilterModal({
    titleText: 'Edit smart folder',
    applyButtonText: 'Save folder',
  }))
  await mutateDom(page)
  await expect(page.locator('#filter-modal-title')).toHaveText('Edit smart folder')
  await expect(page.locator('#btn-apply-modal-filters')).toHaveText(/^Save folder/)
})

test('the tagger advanced hint keeps the custom-model sentence through a DOM change', async ({ page }) => {
  await page.evaluate(() => {
    const select = document.getElementById('tag-model-select') as HTMLSelectElement
    select.value = 'custom'
    ;(window as any).syncTagAdvancedUi()
  })
  await mutateDom(page)
  await expect(page.locator('#tag-advanced-options-hint')).toContainText('when using a custom local model')
})

test('Clear in a filter group shows 0 ticked instead of the full count', async ({ page }) => {
  await page.evaluate(() => (window as any).openFilterModal())
  const count = page.locator('#filter-modal-count-ratings')
  await expect(count).toHaveText(/^\d+\/\d+$/)
  await page.locator('.btn-group-action[data-group="modal-rating-filters"][data-action="clear"]').click()
  await expect(count).toHaveText(/^0\//)
  await page.locator('.btn-group-action[data-group="modal-rating-filters"][data-action="select-all"]').click()
  const total = (await count.textContent())!.split('/')[1]
  await expect(count).toHaveText(`${total}/${total}`)
})
