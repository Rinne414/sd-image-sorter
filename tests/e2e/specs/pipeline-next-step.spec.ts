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
