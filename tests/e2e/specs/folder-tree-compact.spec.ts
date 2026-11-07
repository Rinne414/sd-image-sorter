import { expect, test } from '../fixtures/click-ledger'

/**
 * The sidebar folder tree shows a chain of folders with one sub-folder each as
 * one row (C:/…/Local/pictures), the way an IDE compacts them, instead of ten
 * rows walking down C: > Users > User > AppData. A folder that holds pictures
 * of its own is never merged into the one below it. The row still filters,
 * expands and keeps the full path in its tooltip.
 */

test.use({ viewport: { width: 1366, height: 768 } })

const CHAIN = 'C:/Users/me/AppData/Local/Temp/walk/pictures'
const FOLDERS = [`${CHAIN}/cats`, `${CHAIN}/dogs`, 'D:/art/own-images', 'D:/art/own-images/sub']

async function openTree(page: import('@playwright/test').Page, lang: 'en' | 'zh-CN') {
  await page.route('**/api/folders', (route) => route.fulfill({ json: { folders: FOLDERS } }))
  await page.addInitScript((value) => {
    localStorage.setItem('sd-image-sorter-lang', value)
    localStorage.setItem('sd-sorter-entry-skip-session', '1')
    localStorage.setItem('aurora-entry-skip', '1')
  }, lang)
  await page.goto('/')
  await page.waitForFunction(() => document.documentElement.dataset.appReady === '1')
  await expect(page.locator('#folder-tree .folder-row').first()).toBeVisible()
}

for (const lang of ['en', 'zh-CN'] as const) {
  test(`a chain of single-child folders is one row that still filters and expands (${lang})`, async ({ page }) => {
    await openTree(page, lang)
    const rows = page.locator('#folder-tree .folder-row-open')

    // C: ... pictures is one row, folded like any branch; opening it shows its two children.
    const chainRow = page.locator(`#folder-tree .folder-row-open[data-path="${CHAIN}"]`)
    await expect(chainRow).toHaveCount(1)
    await expect(chainRow).toHaveAttribute('title', CHAIN)
    await expect(chainRow.locator('.folder-row-name')).toHaveText('C:/…/walk/pictures')
    await expect(page.locator('#folder-tree .folder-row-open[data-path="C:/Users"]')).toHaveCount(0)
    const toggle = page.locator(`#folder-tree [data-action="toggle"][data-path="${CHAIN}"]`)
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(page.locator(`#folder-tree .folder-row-open[data-path="${CHAIN}/cats"]`)).toHaveCount(0)
    await toggle.click()
    await expect(page.locator(`#folder-tree .folder-row-open[data-path="${CHAIN}/cats"]`)).toBeVisible()
    await expect(page.locator(`#folder-tree .folder-row-open[data-path="${CHAIN}/dogs"]`)).toBeVisible()

    // D:/art/own-images has pictures of its own, so it is not merged into its child.
    await expect(page.locator('#folder-tree .folder-row-open[data-path="D:/art"]')).toHaveCount(0)
    const ownRow = page.locator('#folder-tree .folder-row-open[data-path="D:/art/own-images"]')
    await expect(ownRow.locator('.folder-row-name')).toHaveText('D:/art/own-images')
    expect(await rows.count()).toBeLessThanOrEqual(6)

    // Folding again hides the children; opening brings them back.
    await toggle.click()
    await expect(page.locator(`#folder-tree .folder-row-open[data-path="${CHAIN}/cats"]`)).toHaveCount(0)
    await toggle.click()
    await expect(page.locator(`#folder-tree .folder-row-open[data-path="${CHAIN}/cats"]`)).toBeVisible()

    // Filtering by the row sends the chain's last folder.
    const request = page.waitForRequest((req) => req.url().includes('/api/images') && req.url().includes('folder='))
    await chainRow.click()
    expect(decodeURIComponent((await request).url())).toContain(`folder=${CHAIN}`)
    await expect(chainRow).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('#folder-tree-browsing')).toContainText(CHAIN)
  })

  test(`a folder filter set from inside a chain highlights the chain row (${lang})`, async ({ page }) => {
    await openTree(page, lang)
    // A saved scope on a folder above the row's last folder (a link, a restored filter).
    await page.evaluate(() => {
      const tree = (window as any).FolderTreeUI
      tree._active = 'C:/Users/me/AppData'
      tree._renderTree()
    })
    const chainRow = page.locator(`#folder-tree .folder-row-open[data-path="${CHAIN}"]`)
    await expect(chainRow).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('#folder-tree .folder-row.is-active')).toHaveCount(1)
  })
}
