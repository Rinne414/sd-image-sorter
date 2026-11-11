import type { Route } from '@playwright/test'

import { expect, test, type Page } from '../fixtures/click-ledger'
import { seedPictures } from '../fixtures/seed-library'

/**
 * Data safety: an action that names its pictures acts on those pictures.
 *
 * A set opened in the Gallery ("New pictures", a described set, the rejected
 * ones...) arrives with "all matching" selected. "Rejected to the recycle bin"
 * after a Keep / Reject session names the rejected pictures only; it used to
 * trash the whole selected set instead, kept pictures included, because the
 * delete took the active selection over the ids it was given.
 */

let SET: number[] = []

test.beforeAll(async ({ request }) => {
  // Real pictures and a real "all matching" selection; only the two destructive requests are stood in for.
  await seedPictures(request, 'delete-explicit-ids', 5)
  const found = await (await request.get('/api/images', { params: { search: 'delete-explicit-ids-seed', limit: 20 } })).json()
  SET = (found.images as Array<{ id: number }>).map((image) => image.id).sort((a, b) => a - b)
  expect(SET).toHaveLength(5)
})

async function mockLibrary(page: Page) {
  const deletes: Array<Record<string, unknown>> = []
  const removes: Array<Record<string, unknown>> = []
  // Every way the program starts or follows a delete or a remove (direct, started job, bulk job).
  const standIn = (seen: Array<Record<string, unknown>>) => async (route: Route) => {
    if (route.request().method() === 'POST') seen.push(route.request().postDataJSON())
    await route.fulfill({ json: { status: 'done', deleted: 0, removed: 0, failed: [], results: [] } })
  }
  await page.route('**/api/images/delete-selected**', standIn(deletes))
  await page.route('**/api/images/remove-selected**', standIn(removes))
  return { deletes: () => [...deletes], removes: () => [...removes] }
}

/** The Gallery on a pinned set, which arrives with "all matching" selected. */
async function openSelectedSet(page: Page) {
  await page.setViewportSize({ width: 1366, height: 768 })
  await page.addInitScript(() => {
    localStorage.setItem('aurora-entry-skip', '1')
    localStorage.setItem('sd-image-sorter-lang', 'en')
  })
  await page.goto('/')
  await expect(page.locator('#gallery-grid .gallery-item').first()).toBeVisible()
  await page.evaluate((ids) => (window as any).GalleryPin.open(ids, { source: 'new' }), SET)
  await expect(page.locator('#gallery-pin-banner-title')).toHaveText('5 new pictures')
  await expect.poll(() => page.evaluate(() => (window as any).getSelectedGalleryCount())).toBe(SET.length)
  expect(await page.evaluate(() => (window as any).App.AppState.selectionScope)).toBe('filtered')
}

test('"Rejected to the recycle bin" trashes the rejected pictures, not the whole selected set', async ({ page }) => {
  const library = await mockLibrary(page)
  await openSelectedSet(page)

  // What the cull's finish line does with its two rejects (manual-sort/cull.js offerCullFileActions).
  await page.evaluate((two) => (window as any).App.deleteGalleryImagesByIds(two), [SET[1], SET[3]])

  const confirm = page.locator('#confirm-modal.visible')
  // The question names two files, not the five of the set.
  await expect(confirm).toContainText('Move 2 image files to the Recycle Bin?')
  await confirm.locator('#btn-confirm-ok').click()
  await expect.poll(() => library.deletes().length).toBe(1)
  const sent = library.deletes()[0]
  expect(sent.image_ids).toEqual([SET[1], SET[3]])
  expect(sent.selection_token).toBeUndefined()
})

test('removing named records does the same, and the selection bar still acts on the whole selection', async ({ page }) => {
  const library = await mockLibrary(page)
  await openSelectedSet(page)

  await page.evaluate((one) => (window as any).App.removeGalleryImagesByIds(one), [SET[2]])
  const confirm = page.locator('#confirm-modal.visible')
  await confirm.locator('#btn-confirm-ok').click()
  await expect.poll(() => library.removes().length).toBe(1)
  expect(library.removes()[0].image_ids).toEqual([SET[2]])
  expect(library.removes()[0].selection_token).toBeUndefined()

  // The selection's own action is unchanged: it means the selection, all five.
  await page.evaluate(() => (window as any).deleteSelectedGalleryImages())
  await expect(page.locator('#confirm-modal.visible')).toContainText('Move 5 image files to the Recycle Bin?')
  await page.locator('#confirm-modal.visible #btn-confirm-ok').click()
  await expect.poll(() => library.deletes().length).toBe(1)
  expect(typeof library.deletes()[0].selection_token).toBe('string')
  expect(library.deletes()[0].image_ids).toBeUndefined()
})

test('after one finish-line action the others are offered again', async ({ page }) => {
  await mockLibrary(page)
  await openSelectedSet(page)
  await page.evaluate(([kept, rejected]) => (window as any).offerCullFileActions(kept, rejected), [[SET[0]], [SET[1], SET[3]]])
  const line = page.locator('#pipeline-next-step')
  await expect(line.locator('.pns-title')).toHaveText('Kept 1, rejected 2. No file was touched yet.')
  await expect(line.locator('.pns-actions button')).toHaveText(['Move the kept to a folder...', 'Look at the rejected', 'Rejected to the recycle bin'])

  await line.getByRole('button', { name: 'Look at the rejected' }).click()
  await expect(page.locator('#gallery-pin-banner-title')).toHaveText('2 you rejected')
  // The line is back with what is still to do; the rejects were not forgotten.
  await expect(line.locator('.pns-title')).toHaveText('Kept 1, rejected 2. Anything else for them?')
  await expect(line.locator('.pns-actions button')).toHaveText(['Move the kept to a folder...', 'Rejected to the recycle bin'])

  // And the bin takes the two rejects, although the set on screen is fully selected.
  await line.getByRole('button', { name: 'Rejected to the recycle bin' }).click()
  await expect(page.locator('#confirm-modal.visible')).toContainText('Move 2 image files to the Recycle Bin?')
  await page.locator('#confirm-modal.visible #btn-confirm-cancel').click()
  await expect(line.locator('.pns-actions button')).toHaveText(['Move the kept to a folder...'])
})
