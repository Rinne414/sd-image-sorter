import { expect, test } from '../fixtures/click-ledger'

/**
 * The sidebar folder tree unfolds single-child chains so an imported folder
 * is visible without clicking through every level. Walkthroughs (2026-10-04)
 * saw only a collapsed "C:" after importing: the unfolding ran once, at the
 * first load, when a fresh library had no folders yet, and never again.
 */

test.use({ viewport: { width: 1366, height: 768 } })

const DEEP = 'C:/Users/me/AppData/Local/Temp/walk/imgs'
const SECOND = 'D:/art/sets/2026/october'

test('folders imported after an empty start are unfolded down to the folder', async ({ page }) => {
  let folders: string[] = []
  await page.route('**/api/folders', async (route) => {
    await route.fulfill({ json: { folders } })
  })
  await page.addInitScript(() => {
    localStorage.setItem('sd-image-sorter-lang', 'en')
    localStorage.setItem('sd-sorter-entry-skip-session', '1')
  })
  await page.goto('/')
  await page.waitForFunction(() => document.documentElement.dataset.appReady === '1')
  await expect(page.locator('#folder-tree .folder-tree-empty')).toBeVisible()

  folders = [DEEP]
  await page.evaluate(() => (window as any).FolderTreeUI.refresh())
  await expect(page.locator('#folder-tree')).toContainText('imgs')
  await expect(page.locator('#folder-tree').getByText('imgs', { exact: true })).toBeVisible()

  folders = [DEEP, SECOND]
  await page.evaluate(() => (window as any).FolderTreeUI.refresh())
  await expect(page.locator('#folder-tree').getByText('october', { exact: true })).toBeVisible()
  await expect(page.locator('#folder-tree').getByText('imgs', { exact: true })).toBeVisible()
})
