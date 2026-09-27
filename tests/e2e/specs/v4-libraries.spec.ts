import { expect, test, type Page } from '../fixtures/click-ledger'

import { cleanupImages, dbPath, openLibrary, pageOverflow, runBackendScript, seedImages } from '../fixtures/v4-seed'
import { PY_DELETE_IMAGES } from '../fixtures/e2e-db'

/**
 * V4 libraries on the real backend: create (and switch), move picks into
 * another library, rename, delete with its inline confirmation.
 *
 * Needs the V4 build: `cd frontend-v4 && npm ci && npm run build`.
 */

test.describe.configure({ mode: 'serial' })

const TOKEN = 'v4libtoken'
const PREFIX = 'v4lib-'
const COUNT = 4
const DIR = 'v4-lib'

function dropTestLibraries(): void {
  runBackendScript(`
${PY_DELETE_IMAGES}
import sqlite3
with sqlite3.connect(${JSON.stringify(dbPath)}) as conn:
    ids = [r[0] for r in conn.execute("SELECT id FROM libraries WHERE name LIKE 'V4 e2e%' AND id != 'main'")]
    for lid in ids:
        delete_images(conn, "library_id = ?", (lid,))
        conn.execute("DELETE FROM libraries WHERE id = ?", (lid,))
    conn.commit()
print("ok")
`)
}

test.beforeAll(() => {
  dropTestLibraries()
  seedImages({ prefix: PREFIX, token: TOKEN, count: COUNT, dir: DIR })
})

test.afterAll(() => {
  dropTestLibraries()
  cleanupImages(PREFIX, [DIR])
})

async function openLibraryMenu(page: Page) {
  await page.getByTestId('library-switch').click()
  return page.getByRole('menu')
}

test('create, move picks in, rename and delete a library', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await openLibrary(page, TOKEN, COUNT)
  const count = page.getByTestId('result-count')

  // new library: created and switched to at once
  let menu = await openLibraryMenu(page)
  await menu.getByRole('menuitem', { name: 'New library…' }).click()
  const dialog = page.getByTestId('libraries-dialog')
  await expect(dialog).toBeInViewport()
  expect(await pageOverflow(page)).toBeLessThanOrEqual(0)
  await dialog.getByLabel('Name of the new library').fill('V4 e2e lib')
  await dialog.getByRole('button', { name: 'Create and switch' }).click()
  await expect(dialog.getByTestId('library-row').filter({ hasText: 'V4 e2e lib' })).toContainText('in use')
  await page.keyboard.press('Escape')
  await expect(count).toHaveText('0 images')

  // back to the main library; move two picks over
  menu = await openLibraryMenu(page)
  await menu.getByRole('menuitemradio', { name: /Main library/ }).click()
  await expect(count).toHaveText(`${COUNT} images`)
  await page.locator('[data-testid="gallery-scroller"]:not([aria-busy])').waitFor()
  const tiles = page.getByTestId('tile')
  await tiles.nth(0).click({ modifiers: ['Control'] })
  await tiles.nth(1).click({ modifiers: ['Control'] })
  await page.getByTestId('selection-bar').getByRole('button', { name: 'More' }).click()
  await page.getByRole('menuitem', { name: 'Move to another library…' }).click()
  const move = page.getByTestId('move-library-dialog')
  await expect(move.getByRole('radio', { name: /V4 e2e lib/ })).toBeChecked()
  await move.getByRole('button', { name: 'Move 2' }).click()
  await expect(count).toHaveText(`${COUNT - 2} images`)
  await expect(page.getByTestId('selection-bar')).toHaveCount(0)

  // manage: it holds the two; rename it; delete it (records go, the rest stays)
  menu = await openLibraryMenu(page)
  await menu.getByRole('menuitem', { name: 'Manage libraries…' }).click()
  const row = dialog.getByTestId('library-row').filter({ hasText: 'V4 e2e lib' })
  await expect(row).toContainText('2 images')
  await row.getByRole('button', { name: 'Rename' }).click()
  // while renaming, the name is in the input, not in the row's text
  const renameInput = dialog.getByRole('textbox', { name: 'Rename' })
  await renameInput.fill('V4 e2e renamed')
  await renameInput.press('Enter')
  const renamed = dialog.getByTestId('library-row').filter({ hasText: 'V4 e2e renamed' })
  await expect(renamed).toBeVisible()
  await renamed.getByRole('button', { name: 'Delete library…' }).click()
  await expect(renamed).toContainText('Its 2 image records')
  await renamed.getByRole('button', { name: 'Delete this library' }).click()
  await expect(dialog.getByTestId('library-row').filter({ hasText: 'V4 e2e' })).toHaveCount(0)
  // the main library cannot be deleted
  await expect(dialog.getByTestId('library-row').filter({ hasText: 'Main library' }).getByRole('button', { name: 'Delete library…' })).toHaveCount(0)
})

/** Open V4 on the library page with this library stored as the open one (once per page). */
async function openWithStoredLibrary(page: Page, libraryId: string, lang: 'en' | 'zh-CN') {
  await page.addInitScript(
    ([id, l]) => {
      if (sessionStorage.getItem('v4lib-stored')) return
      sessionStorage.setItem('v4lib-stored', '1')
      localStorage.setItem('sd-image-sorter-lang', l)
      localStorage.setItem('sd-v4-update-autocheck', '0')
      localStorage.setItem('sd-library-workspace-v1', JSON.stringify({ v: 2, currentId: id }))
    },
    [libraryId, lang] as const,
  )
  const res = await page.goto('/v4/#/library', { waitUntil: 'domcontentloaded' })
  expect(res?.status(), 'V4 is not built: run npm run build in frontend-v4').toBe(200)
}

const storedLibrary = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('sd-library-workspace-v1') || '{}').currentId)

test('6b-fix2: the open library deleted in another window: back in this one, V4 moves to one that exists, says so, and names main from then on', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  const made = await page.request.post('/api/libraries', { data: { name: 'V4 e2e gone' } })
  expect(made.ok()).toBe(true)
  const gone: string = (await made.json()).library.id
  await openWithStoredLibrary(page, gone, 'en')
  const rail = page.getByTestId('library-switch')
  await expect(rail).toContainText('V4 e2e gone')

  // another window (a second V4 tab, or V3.5) deletes it
  expect((await page.request.delete(`/api/libraries/${encodeURIComponent(gone)}`)).ok()).toBe(true)
  // coming back to this window reads the list again; the first gallery request after it names main
  const next = page.waitForRequest((r) => new URL(r.url()).pathname === '/api/images')
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(page.getByText('The library that was open is gone (perhaps deleted in another window or in V3.5). Now showing “Main library”.')).toBeVisible()
  expect((await next).headers()['x-sd-library-id']).toBe('main')
  await expect(rail).toContainText('Main library')
  expect(await storedLibrary(page)).toBe('main')
})

test('6b-fix2: a stale library stored at launch: V4 opens one that exists and says so, in Chinese too', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  const next = page.waitForRequest((r) => new URL(r.url()).pathname === '/api/images' && r.headers()['x-sd-library-id'] === 'main')
  await openWithStoredLibrary(page, 'lib_never_existed', 'zh-CN')
  await expect(page.getByText('之前打开的图库已经不在了（可能在别的窗口或旧版界面里删掉了），现在打开的是「主图库」。')).toBeVisible()
  await next
  await expect(page.getByTestId('library-switch')).toContainText('主图库')
  expect(await storedLibrary(page)).toBe('main')
})
