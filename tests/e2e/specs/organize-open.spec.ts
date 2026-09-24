import fs from 'node:fs'
import { expect, test } from '../fixtures/click-ledger'

/**
 * Organizing a big library without silent caps: claims and moves go out in
 * batches instead of stopping at 500 / 5000, the prompt export download has
 * every selected image (the preview alone is capped), and exporting with
 * nothing selected offers the current filter results.
 */

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('sd-image-sorter-lang', 'en')
    localStorage.setItem('sd-sorter-entry-skip-session', '1')
  })
})

test('claiming and moving send every image in batches', async ({ page }) => {
  const claimSizes: number[] = []
  const moveSizes: number[] = []
  await page.route('**/api/libraries/claim-paths', async (route) => {
    const body = route.request().postDataJSON() as { paths: string[] }
    claimSizes.push(body.paths.length)
    await route.fulfill({ json: { status: 'ok', moved: body.paths.length } })
  })
  await page.route('**/api/libraries/move-images', async (route) => {
    const body = route.request().postDataJSON() as { image_ids: number[] }
    moveSizes.push(body.image_ids.length)
    await route.fulfill({ json: { status: 'ok', moved: body.image_ids.length } })
  })
  await page.goto('/')
  const result = await page.evaluate(async () => {
    const workspace = (window as any).LibraryWorkspace
    const paths = Array.from({ length: 4500 }, (_, index) => `C:/set/img-${index}.png`)
    const ids = Array.from({ length: 4500 }, (_, index) => index + 1)
    const claimed = await workspace.claimPaths(paths, 'main')
    const moved = await workspace.moveImagesToLibrary(ids, 'other', 'Other')
    return { claimed: claimed?.moved, moved: moved?.moved }
  })
  expect(claimSizes).toEqual([2000, 2000, 500])
  expect(moveSizes).toEqual([2000, 2000, 500])
  expect(result).toEqual({ claimed: 4500, moved: 4500 })
})

test('the prompt export download has every selected image, not only the preview', async ({ page }) => {
  await page.route('**/api/images/export-data', async (route) => {
    const body = route.request().postDataJSON() as { image_ids: number[] }
    await route.fulfill({
      json: {
        images: body.image_ids.map((id) => ({ id, prompt: `prompt ${id}`, tags: [] })),
        missing_ids: [],
      },
    })
  })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.evaluate(() => {
    ;(window as any).App.setSelectionState({
      selectionMode: true,
      selectedIds: new Set(Array.from({ length: 2501 }, (_, index) => index + 1)),
      scope: 'filtered',
      filterKey: 'full-download-test',
    })
  })
  await page.evaluate(async () => { await (window as any).App.showExportModal() })
  await expect(page.locator('#export-text')).toHaveValue(/first 2000 of 2501 selected images/)

  const downloadPromise = page.waitForEvent('download')
  await page.locator('#btn-download-export').click()
  const download = await downloadPromise
  const content = fs.readFileSync(await download.path(), 'utf8')
  const prompts = content.split('\n\n').filter((line) => line.startsWith('prompt '))
  expect(prompts).toHaveLength(2501)
  expect(content).not.toContain('The preview shows')
})

test('exporting with nothing selected offers the current filter results', async ({ page }) => {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.evaluate(() => {
    ;(window as any).App.setSelectionState({ selectionMode: true, selectedIds: new Set(), scope: 'visible' })
    ;(window as any).showBatchExportModal()
  })
  await expect(page.locator('#confirm-modal.visible')).toBeVisible()
  await expect(page.locator('#confirm-message')).toContainText('Nothing is selected')
})
