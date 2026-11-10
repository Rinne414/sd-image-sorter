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

test('the dialog lists the library folders by short name; a click fills the path', async ({ page }) => {
  // Walkthrough 2026-11-09: a beginner had to copy a full path from a folder
  // row's tooltip; the recent destinations sat in a list that only shows after typing.
  const ROOT = 'D:/library/pictures'
  await page.route('**/api/folders', (route) => route.fulfill({
    json: { folders: [`${ROOT}/daily`, `${ROOT}/scenery`, `${ROOT}/works/2026-05`], counts: { [`${ROOT}/daily`]: 18, [`${ROOT}/scenery`]: 11, [`${ROOT}/works/2026-05`]: 22 } },
  }))
  await page.setViewportSize({ width: 1366, height: 768 })
  await openMoveDialog(page, { [MOVES_KEY]: JSON.stringify(['E:/picked']) })

  const list = page.locator('#input-modal-folder-choices')
  await expect(list.locator('.folder-choices-head')).toHaveText(['最近用过', '图库里的文件夹'])
  await expect(list.locator('.folder-choice')).toHaveText(['E:/picked', 'daily18', 'scenery11', 'works/2026-05' + '22'])
  await expect(page.locator('#btn-input-ok')).toBeInViewport()

  // Typing narrows the list; a click fills the field with the full path.
  await page.locator('#input-modal-field').fill('scen')
  await expect(list.locator('.folder-choice:visible')).toHaveText(['scenery11'])
  await list.locator('.folder-choice', { hasText: 'scenery' }).click()
  await expect(page.locator('#input-modal-field')).toHaveValue(`${ROOT}/scenery`)
  await expect(list.locator('.folder-choice.is-chosen')).toHaveCount(1)
})

test('a finished move offers Undo, which asks the server to put the files back', async ({ page }) => {
  // Power-user walkthrough 2026-11-09: a move to the wrong folder had no way back.
  const TOKEN = '0123456789abcdef0123456789abcdef'
  await page.setViewportSize({ width: 1920, height: 1080 })
  await openMoveDialog(page, { [MOVES_KEY]: JSON.stringify(['D:/sorted/best']) })
  await page.route('**/api/move/start', (route) =>
    route.fulfill({
      json: { status: 'done', operation: 'move', run_token: TOKEN, results: [{ id: 1, success: true }] },
    }))
  let undoBody: unknown = null
  await page.route('**/api/batch-move/undo', async (route) => {
    undoBody = route.request().postDataJSON()
    await route.fulfill({ json: { status: 'started', total: 1, run_token: TOKEN, operation: 'undo' } })
  })
  await page.route('**/api/batch-move/progress', (route) =>
    route.fulfill({
      json: { status: 'done', run_token: TOKEN, run_kind: 'undo', moved: 1, errors: 0, recent_errors: [] },
    }))

  await page.locator('#btn-input-ok').click()
  await page.locator('#confirm-modal.visible #btn-confirm-ok').click()

  const undo = page.locator('#toast-container .toast .toast-action-btn')
  await expect(undo).toHaveText('撤销')
  // Readable in today's look: it was white text on the pale accent.
  const colours = await undo.evaluate((el) => {
    const style = getComputedStyle(el)
    return { background: style.backgroundColor, color: style.color }
  })
  expect(colours.background).toBe('rgba(0, 0, 0, 0)')
  await undo.click()

  await expect(page.locator('#toast-container .toast.success .toast-message')).toHaveText('已撤销：1 张图片回到原来的位置。')
  expect(undoBody).toEqual({ run_token: TOKEN })
})

test('a move that changed nothing offers no Undo', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await openMoveDialog(page, { [MOVES_KEY]: JSON.stringify(['D:/sorted/best']) })
  await page.locator('#btn-input-ok').click()
  await page.locator('#confirm-modal.visible #btn-confirm-ok').click()
  await expect(page.locator('#toast-container .toast.success')).toBeVisible()
  await expect(page.locator('#toast-container .toast .toast-action-btn')).toHaveCount(0)
})
