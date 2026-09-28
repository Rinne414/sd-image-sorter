import { expect, test, type Page } from '../fixtures/click-ledger'
import { resizeAndSettleUiScale } from '../fixtures/ui-scale'

/**
 * The move/copy dialog offers the user's own last destinations (V3.5 3-7).
 *
 * It used to prefill the last IMPORT folder, which is usually where the
 * images already are, and had no way to browse. Now the field starts with the
 * last move/copy destination, offers the recent ones, has a Browse button,
 * and a move no longer changes the recent import folders.
 */

test.describe.configure({ mode: 'serial' })

const SHOT_DIR = '../../.tmp/v35-fix'
const VIEWPORTS = [
  { width: 1366, height: 768 },
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 },
] as const
const IMPORTS_KEY = 'sd-image-sorter-recent-folders'
const MOVES_KEY = 'sd-image-sorter-recent-move-destinations'

async function openMoveDialog(page: Page, seeds: Record<string, string>) {
  await page.addInitScript((entries) => {
    if (sessionStorage.getItem('move-dest-seeded')) return
    sessionStorage.setItem('move-dest-seeded', '1')
    localStorage.setItem('sd-image-sorter-lang', 'zh-CN')
    for (const [key, value] of Object.entries(entries)) localStorage.setItem(key, value)
  }, seeds)
  await page.route('**/api/browse-folder', async (route) => {
    const body = (route.request().postDataJSON() || {}) as { path?: string }
    const inside = body.path === 'C:/picked'
    await route.fulfill({
      json: inside
        ? { current: 'C:/picked', parent: 'C:/', subdirs: [] }
        : { current: 'C:/', parent: null, subdirs: [{ name: 'picked', path: 'C:/picked', has_children: true }] },
    })
  })
  await page.route('**/api/move/start', (route) =>
    route.fulfill({ json: { status: 'done', results: [{ id: 1, success: true }] } }))
  await page.goto('/')
  await page.waitForFunction(() => document.documentElement.dataset.appReady === '1'
    && typeof (window as any).moveOrCopyGalleryImages === 'function')
  await page.evaluate(() => { void (window as any).moveOrCopyGalleryImages([1], 'move', { source: 'context' }) })
  await expect(page.locator('#input-modal.visible')).toBeVisible()
}

test('the dialog does not prefill the import folder and has a Browse button', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await openMoveDialog(page, { [IMPORTS_KEY]: JSON.stringify(['C:/imports/where-images-are']) })

  await expect(page.locator('#input-modal-field')).toHaveValue('')
  const browse = page.locator('#btn-input-browse')
  for (const viewport of VIEWPORTS) {
    await resizeAndSettleUiScale(page, viewport)
    await expect(browse).toBeInViewport()
    await expect(page.locator('#btn-input-ok')).toBeInViewport()
    await page.screenshot({ path: `${SHOT_DIR}/move-destination-${viewport.width}.png` })
  }

  await browse.click()
  await page.locator('#input-modal-folder-browser .folder-browser-item', { hasText: 'picked' }).click()
  await expect(page.locator('#input-modal-folder-browser .folder-browser-path')).toHaveText('C:/picked')
  await page.locator('#input-modal-folder-browser #folder-browser-select').click()
  await expect(page.locator('#input-modal-field')).toHaveValue('C:/picked')

  await page.locator('#btn-input-ok').click()
  await page.locator('#confirm-modal.visible #btn-confirm-ok').click()
  await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), MOVES_KEY)).toBe(JSON.stringify(['C:/picked']))
  expect(await page.evaluate((key) => localStorage.getItem(key), IMPORTS_KEY)).toBe(JSON.stringify(['C:/imports/where-images-are']))
})

test('the dialog starts from the last move destination and offers the recent ones', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await openMoveDialog(page, {
    [IMPORTS_KEY]: JSON.stringify(['C:/imports/where-images-are']),
    [MOVES_KEY]: JSON.stringify(['D:/sorted/best', 'D:/sorted/keep']),
  })

  await expect(page.locator('#input-modal-field')).toHaveValue('D:/sorted/best')
  await expect(page.locator('#input-modal-suggestions option')).toHaveCount(2)
  await expect(page.locator('#input-modal-suggestions option').nth(1)).toHaveAttribute('value', 'D:/sorted/keep')
})
