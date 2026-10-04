import { expect, test } from '../fixtures/click-ledger'

/**
 * The "what next?" banner after an import / tagging / sort belongs to the
 * moment that step finished. Walkthroughs (2026-10-04) found it still on
 * screen pages later, covering the censor canvas and the sort slots and
 * offering the page the user was already on. Leaving the page closes it.
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

test('switching to another page closes the next-step banner', async ({ page }) => {
  const banner = page.locator('#pipeline-next-step')
  await page.evaluate(() => (window as any).App.showPipelineNextStep({
    title: 'Imported 3 images. What next?',
    actions: [{ label: 'Censor Edit', action: 'view:censor' }],
  }))
  await expect(banner).toBeVisible()

  await page.evaluate(() => (window as any).App.switchView('gallery'))
  await expect(banner).toBeVisible()

  await page.evaluate(() => (window as any).App.switchView('censor'))
  await expect(banner).toBeHidden()
})

test('the banner action still takes the user to the next page', async ({ page }) => {
  const banner = page.locator('#pipeline-next-step')
  await page.evaluate(() => (window as any).App.showPipelineNextStep({
    title: 'Imported 3 images. What next?',
    actions: [{ label: 'Censor Edit', action: 'view:censor' }],
  }))

  await banner.getByRole('button', { name: 'Censor Edit' }).click()

  await expect(page.locator('#view-censor.active')).toBeVisible()
  await expect(banner).toBeHidden()
})

test('starting a manual sort closes an Auto-Separate banner on the same page', async ({ page }) => {
  const banner = page.locator('#pipeline-next-step')
  await page.evaluate(() => (window as any).App.switchView('sorting'))
  await page.evaluate(() => (window as any).App.showPipelineNextStep({ title: 'Sorting done. What next?', actions: [] }))
  await expect(banner).toBeVisible()

  await page.evaluate(() => (window as any).activateSortingUi('slot'))

  await expect(banner).toBeHidden()
})

test('a model download asks with a plain button, not the red destructive one', async ({ page }) => {
  await page.evaluate(() => { (window as any).featureInstallConfirm('Download model', 'About 12 MB.') })
  await expect(page.locator('#confirm-modal.visible')).toBeVisible()
  await expect(page.locator('#btn-confirm-ok')).not.toHaveClass(/danger/)
  await page.locator('#btn-confirm-cancel').click()
})

test('a long slot folder shows its folder name, with the full path as tooltip', async ({ page }) => {
  const long = 'C:/Users/me/AppData/Local/Temp/claude/some/very/deep/place/sorted-keepers'
  await page.evaluate((path) => localStorage.setItem('sort-folder-w', path), long)
  await page.reload()
  await page.waitForFunction(() => document.documentElement.dataset.appReady === '1')
  await page.evaluate(() => (window as any).App.switchView('sorting'))
  await page.evaluate(() => (window as any)._switchSortingSub?.('manual'))
  const field = page.locator('.folder-path-input[data-key="w"]')
  await expect(field).toBeVisible()
  await expect(field).toHaveValue(long)
  await expect(field).toHaveAttribute('title', long)
  await expect.poll(() => field.evaluate((input: HTMLInputElement) => input.scrollLeft)).toBeGreaterThan(0)
})

test('the Select Images button says Done Selecting while selecting, and keeps saying it', async ({ page }) => {
  const button = page.locator('#btn-toggle-select')
  await button.click()
  await expect(button).toHaveAttribute('aria-pressed', 'true')
  await expect(button).toContainText('Done Selecting')
  // Any DOM change re-applies data-i18n texts; the label must survive it.
  await page.evaluate(() => document.body.appendChild(document.createElement('div')))
  await page.waitForTimeout(400)
  await expect(button).toContainText('Done Selecting')
  await button.click()
  await expect(button).toContainText('Select Images')
})
