import { expect, test, type Page } from '../fixtures/click-ledger'

/**
 * Vopus (/vopus/): a library whose folder was renamed has rows but no files.
 * The listing reports how many rows it skipped (missing_skipped); the empty
 * gallery must say the files cannot be found and offer Find Moved Files,
 * not "no images yet" (same rule as classic, commit 4fab0353).
 *
 * Needs the V4 build: `cd frontend-v4 && npm ci && npm run build`.
 */

async function openEmptyLibrary(page: Page, lang: 'en' | 'zh-CN', missingSkipped: number) {
  await page.addInitScript((value) => {
    localStorage.setItem('sd-image-sorter-lang', value)
    localStorage.setItem('sd-v4-update-autocheck', '0')
    const prefs = JSON.parse(localStorage.getItem('sd-v4-prefs') || '{}')
    localStorage.setItem('sd-v4-prefs', JSON.stringify({ ...prefs, startPage: 'library' }))
  }, lang)
  await page.route('**/api/images**', async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname !== '/api/images') return route.fallback()
    await route.fulfill({
      json: { images: [], total: 0, has_more: false, next_cursor: null, next_offset: null, ...(missingSkipped ? { missing_skipped: missingSkipped } : {}) },
    })
  })
  await page.route('**/api/images/missing-summary**', (route) =>
    route.fulfill({
      json: {
        total: missingSkipped,
        clearable_total: missingSkipped,
        blocked_total: 0,
        groups: missingSkipped
          ? [{ location: 'D:/old/pics', reason: 'folder_deleted', clearable: true, count: missingSkipped, user_work_total: 0, sample_filenames: ['a.png'] }]
          : [],
        groups_truncated: false,
        suggested_search_folder: 'D:/old',
      },
    }),
  )
  const res = await page.goto('/vopus/', { waitUntil: 'domcontentloaded' })
  expect(res?.status(), 'V4 is not built: run npm run build in frontend-v4').toBe(200)
}

for (const [lang, title, findLabel] of [
  ['en', 'The images of this library cannot be found on disk', 'Find them in another folder…'],
  ['zh-CN', '这个图库的图都找不到原文件', '在别的文件夹里找回…'],
] as const) {
  test(`an empty gallery with skipped rows says the files cannot be found and offers Find Moved Files (${lang})`, async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 })
    await openEmptyLibrary(page, lang, 3)
    const notice = page.getByTestId('library-files-missing')
    await expect(notice).toBeVisible()
    await expect(notice).toContainText(title)
    await expect(notice).toContainText('3')
    await expect(page.getByTestId('library-empty')).toHaveCount(0)
    await notice.getByRole('button', { name: findLabel }).click()
    await expect(page.getByTestId('missing-dialog')).toBeVisible()
  })
}

test('a really empty library still says no images yet and offers the import', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await openEmptyLibrary(page, 'en', 0)
  await expect(page.getByTestId('library-empty')).toContainText('This library has no images yet')
  await expect(page.getByTestId('library-files-missing')).toHaveCount(0)
})
