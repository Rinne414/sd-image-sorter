import { expect, test } from '../fixtures/click-ledger'

/**
 * The "What next?" banner after an import, a tagging run or an Auto-Separate
 * run draws its buttons with the app's line icons. Its buttons used to glue a
 * coloured emoji onto the label as text, the last emoji in that flow.
 */

test('next-step buttons draw sprite icons, not glyph text', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await page.addInitScript(() => {
    localStorage.setItem('sd-image-sorter-lang', 'en')
    localStorage.setItem('aurora-entry-skip', '1')
  })
  await page.goto('/')
  await page.waitForFunction(() => document.documentElement.dataset.appReady === '1')

  await page.evaluate(() => (window as any).App.showPipelineNextStep({
    icon: 'i-tag',
    title: 'Tagged 3 images. What next?',
    actions: [
      { icon: 'i-folders', label: 'Organize', action: 'view:sorting' },
      { icon: 'i-package', label: 'Dataset', action: 'view:dataset' },
    ],
  }))

  const buttons = page.locator('#pipeline-next-step .pns-actions button')
  await expect(buttons).toHaveCount(2)
  await expect(buttons.nth(0).locator('svg.icon use')).toHaveAttribute('href', '#i-folders')
  await expect(buttons.nth(1).locator('svg.icon use')).toHaveAttribute('href', '#i-package')
  await expect(buttons.nth(0)).toHaveText('Organize')
  await expect(buttons.nth(1)).toHaveText('Dataset')
})
