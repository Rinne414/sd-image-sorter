import { expect, test, type Page } from '@playwright/test'

import { cleanupImages, dbPath, openLibrary, pageOverflow, runBackendScript, seedImages } from '../fixtures/v4-seed'

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
import sqlite3
with sqlite3.connect(${JSON.stringify(dbPath)}) as conn:
    ids = [r[0] for r in conn.execute("SELECT id FROM libraries WHERE name LIKE 'V4 e2e%' AND id != 'main'")]
    for lid in ids:
        conn.execute("DELETE FROM images WHERE library_id = ?", (lid,))
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
