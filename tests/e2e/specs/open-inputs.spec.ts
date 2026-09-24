import { expect, test } from '../fixtures/click-ledger'

/**
 * Inputs accept what users actually paste or type instead of refusing it:
 * a path copied with Explorer's "Copy as path" keeps its quotes, and batch
 * rename may start numbering at 0.
 */

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('sd-image-sorter-lang', 'en')
    localStorage.setItem('sd-sorter-entry-skip-session', '1')
  })
})

test('a quoted path pasted into a folder field loses its quotes, a search keeps them', async ({ page }) => {
  await page.goto('/')
  await page.locator('#btn-scan').click()
  await expect(page.locator('#scan-modal.visible')).toBeVisible()

  const folder = page.locator('#scan-folder-path')
  await folder.fill('"D:\\Pictures\\Set 01"')
  await expect(folder).toHaveValue('D:\\Pictures\\Set 01')
  await expect(page.locator('#scan-folder-feedback')).not.toContainText(/unsupported|不支持/i)

  await page.keyboard.press('Escape')
  const search = page.locator('#gallery-search-input')
  if (await search.count()) {
    await search.fill('"exact phrase"')
    await expect(search).toHaveValue('"exact phrase"')
  }
})

test('batch rename can start numbering at 0', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => {
    const state = (window as any).__CENSOR_STATE__
    state.queue = [
      { id: 1, originalFilename: 'a.png', outputFilename: 'a.png', editOperations: [] },
      { id: 2, originalFilename: 'b.png', outputFilename: 'b.png', editOperations: [] },
    ]
  })
  await page.evaluate(() => (window as any).App.switchView('censor'))
  await page.locator('#btn-batch-rename').click()
  await page.locator('#rename-use-original').uncheck()
  await page.locator('#rename-base').fill('set')
  await page.locator('#rename-start').fill('0')
  await page.locator('#rename-start').dispatchEvent('input')
  await page.evaluate(() => (window as any).applyBatchRename())

  const names = await page.evaluate(() => (window as any).__CENSOR_STATE__.queue.map((item: any) => item.outputFilename))
  expect(names).toEqual(['set_000.png', 'set_001.png'])
})
