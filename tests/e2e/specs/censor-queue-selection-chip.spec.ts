import { expect, test } from '../fixtures/click-ledger'

/**
 * Censor queue toolbar: the selection count sits as a fourth column beside
 * All / None / Filter. "1 selected" wrapped to two lines at every desktop width
 * (the column is 66-98 px, the words need about 80) and the row grew to 58 px
 * against 28 px buttons. It shows a check and the number, one line, with the
 * words as its tooltip and accessible name.
 */

test('the selection count stays on one line beside All / None / Filter at every width', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('sd-image-sorter-lang', 'en'))
  await page.route('**/api/image-thumbnail/**', (route) => route.fulfill({ status: 204 }))
  await page.goto('/')
  await page.waitForFunction(() => document.documentElement.dataset.appReady === '1' && !!(window as any).__CENSOR_STATE__)
  await page.evaluate(() => {
    const w = window as any
    w.EntryPage?.hide?.()
    w.App.switchView('censor')
    const state = w.__CENSOR_STATE__
    state.queue = Array.from({ length: 140 }, (_, i) => ({ id: 9000 + i, originalFilename: `img-${i}.png` }))
    state.selectedItems = new Set([9000])
    w.renderQueue?.()
  })

  const chip = page.locator('#queue-selection-count')
  await expect(chip).toHaveText('1')
  await expect(chip).toHaveAttribute('title', '1 selected')
  await expect(chip).toHaveAttribute('aria-label', '1 selected')

  for (const [width, height] of [[1366, 768], [1920, 1080], [2560, 1440]] as const) {
    await page.setViewportSize({ width, height })
    for (const selected of [1, 140]) {
      await page.evaluate((n) => {
        const w = window as any
        w.__CENSOR_STATE__.selectedItems = new Set(w.__CENSOR_STATE__.queue.slice(0, n).map((item: { id: number }) => item.id))
        w.renderQueue?.()
      }, selected)
      const geometry = await page.evaluate(() => {
        const chipBox = document.getElementById('queue-selection-count')!.getBoundingClientRect()
        const button = document.getElementById('btn-queue-filter')!.getBoundingClientRect()
        const el = document.getElementById('queue-selection-count')!
        return { chipHeight: chipBox.height, buttonHeight: button.height, overflow: el.scrollWidth - el.clientWidth, top: chipBox.top, buttonTop: button.top }
      })
      // One line: no taller than the buttons beside it, nothing cut off, same row.
      expect(geometry.chipHeight, `${width}px, ${selected} selected`).toBeLessThanOrEqual(geometry.buttonHeight + 1)
      expect(geometry.overflow, `${width}px, ${selected} selected`).toBeLessThanOrEqual(0)
      expect(Math.abs(geometry.top - geometry.buttonTop)).toBeLessThan(4)
    }
    await page.locator('.queue-btn-rows').screenshot({ path: test.info().outputPath(`queue-toolbar-${width}.png`) })
  }
})
