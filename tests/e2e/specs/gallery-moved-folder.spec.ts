import { expect, test, type Page } from '@playwright/test'

/**
 * A folder renamed outside the app, then the page reloaded.
 *
 * The listing marks the rows it cannot find while it runs, so the missing-files
 * summary (asked about 1.5 s after load) could be read before the marking, say
 * 0, and be cached for a minute. The gallery then showed "No images yet" with no
 * banner, telling the user to import again. Now the listing says how many rows it
 * skipped, the card and the banner follow at once, and Find Moved Files opens
 * with the folder to search already filled in (never started by itself).
 */

const SKIPPED = 60
const SEARCH_FOLDER = 'D:/output'
/** Longer than the summary's 1.5 s first look, so the summary is read mid-load. */
const SLOW_LISTING_MS = 2600

async function mockMovedFolder(page: Page) {
  let marked = false
  let startedSearches = 0
  await page.route('**/api/images/missing-summary**', (route) =>
    route.fulfill({
      json: marked
        ? {
            total: SKIPPED,
            clearable_total: SKIPPED,
            blocked_total: 0,
            user_work_total: 0,
            location_total: 1,
            suggested_search_folder: SEARCH_FOLDER,
            groups: [{ location: 'D:/output/testing', count: SKIPPED, reason: 'folder_deleted', clearable: true, user_work_total: 0 }],
          }
        : { total: 0, clearable_total: 0, blocked_total: 0, user_work_total: 0, location_total: 0, groups: [], suggested_search_folder: '' },
    }),
  )
  await page.route('**/api/images/reconnect-missing/start', (route) => {
    startedSearches += 1
    return route.fulfill({ json: { status: 'started' } })
  })
  await page.route('**/api/validate-path', (route) => route.fulfill({ json: { valid: true } }))
  await page.route('**/api/images**', async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname !== '/api/images') return route.fallback()
    await new Promise((resolve) => setTimeout(resolve, SLOW_LISTING_MS))
    marked = true
    await route.fulfill({ json: { images: [], total: 0, has_more: false, next_cursor: null, missing_skipped: SKIPPED } })
  })
  return { startedSearches: () => startedSearches }
}

async function open(page: Page, lang: 'en' | 'zh-CN') {
  await page.addInitScript((l) => {
    localStorage.setItem('sd-image-sorter-lang', l)
    localStorage.setItem('aurora-entry-skip', '1')
    // Any moment the onboarding card is on screen is a flash of "no images yet".
    ;(window as unknown as { __onboardingSeen: number }).__onboardingSeen = 0
    setInterval(() => {
      const card = document.getElementById('gallery-empty-state')
      const visible = !!card && card.style.display !== 'none'
      const title = card?.querySelector('h3')?.getAttribute('data-i18n')
      if (visible && title === 'gallery.noImages') (window as unknown as { __onboardingSeen: number }).__onboardingSeen += 1
    }, 40)
  }, lang)
  await page.goto('/')
  await expect(page.locator('#view-gallery')).toBeVisible()
}

for (const lang of ['en', 'zh-CN'] as const) {
  test(`a renamed folder: the card and banner say the files are missing, never "no images yet" (${lang})`, async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 768 })
    await mockMovedFolder(page)
    await open(page, lang)

    await expect(page.locator('#gallery-unreadable-banner')).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('#gallery-empty-state')).toBeVisible()
    await expect(page.locator('#gallery-empty-state h3')).toHaveAttribute('data-i18n', 'gallery.allMissingTitle')
    await expect(page.locator('#gallery-empty-state h3 + p')).toContainText(String(SKIPPED))
    expect(await page.evaluate(() => (window as unknown as { __onboardingSeen: number }).__onboardingSeen)).toBe(0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0)
  })

  test(`Find Moved Files opens with the folder to search filled in, and starts nothing (${lang})`, async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 768 })
    const mock = await mockMovedFolder(page)
    await open(page, lang)

    await expect(page.locator('#gallery-unreadable-banner')).toBeVisible({ timeout: 15_000 })
    await page.locator('#gallery-unreadable-banner-cta').click()
    await expect(page.locator('#reconnect-modal')).toBeVisible()
    await expect(page.locator('#reconnect-folder-path')).toHaveValue(SEARCH_FOLDER)
    expect(mock.startedSearches()).toBe(0)

    // What the user typed is theirs: opening again keeps it.
    await page.locator('#reconnect-folder-path').fill('E:/elsewhere')
    await page.locator('#btn-cancel-reconnect').click()
    await page.locator('#gallery-unreadable-banner-cta').click()
    await expect(page.locator('#reconnect-folder-path')).toHaveValue('E:/elsewhere')
  })
}
