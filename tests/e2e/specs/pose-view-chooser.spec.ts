import { expect, test, type Page } from '@playwright/test'

/**
 * Find by pose or camera angle: the chooser lists the library's own tags of
 * those kinds; pressing one filters the Gallery, several can be on together,
 * and it says which pictures it cannot know.
 */

const MOCK_IMAGE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#789"/></svg>'

async function mockLibrary(page: Page, list: Record<string, unknown>): Promise<{ tagQueries: () => Array<string | null> }> {
  const tagQueries: Array<string | null> = []
  const images = Array.from({ length: 8 }, (_, index) => ({
    id: 6001 + index, filename: `pose-${index + 1}.png`, path: `/mock/pose-${index + 1}.png`, prompt: 'mock',
  }))
  await page.route(/\/api\/image-(thumbnail|file)\/\d+/, async (route) => {
    await route.fulfill({ status: 200, contentType: 'image/svg+xml', body: MOCK_IMAGE_SVG })
  })
  await page.route('**/api/images**', async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname !== '/api/images') {
      await route.continue()
      return
    }
    tagQueries.push(url.searchParams.get('tags'))
    const total = url.searchParams.get('tags') ? 3 : images.length
    await route.fulfill({ json: { images: images.slice(0, total), total, has_more: false, next_cursor: null } }).catch(() => {})
  })
  await page.route('**/api/images/missing-summary**', async (route) => {
    await route.fulfill({ json: { total: 0, clearable_total: 0, groups: [] } })
  })
  await page.route('**/api/tags/pose-view', async (route) => {
    await route.fulfill({ json: list })
  })
  return { tagQueries: () => [...tagQueries] }
}

async function openChooser(page: Page) {
  await page.setViewportSize({ width: 1366, height: 768 })
  await page.addInitScript(() => localStorage.setItem('aurora-entry-skip', '1'))
  await page.goto('/')
  await expect(page.locator('#gallery-grid .gallery-item').first()).toBeVisible()
  await pressSidebarRow(page)
  await expect(page.locator('#pose-view-modal')).toHaveClass(/visible/)
}

/** The row lives in the sidebar's Filters section, which starts folded in the default look. */
async function pressSidebarRow(page: Page) {
  const row = page.locator('#btn-pose-view')
  if (!(await row.isVisible())) {
    await page.locator('.sidebar-section', { has: row }).locator('.sidebar-section-toggle, .sidebar-title, h3, [aria-expanded]').first().click()
  }
  await row.click()
}

test('pressing pose and angle tags filters the Gallery, and the chooser says what it cannot know', async ({ page }) => {
  const library = await mockLibrary(page, {
    view: [{ tag: 'from_above', count: 39, name: null }, { tag: 'cowboy_shot', count: 20, name: null }],
    pose: [{ tag: 'sitting', count: 59, name: null }],
    untagged: 12,
  })
  await openChooser(page)
  const modal = page.locator('#pose-view-modal')

  await expect(modal.locator('.pose-view-group-title')).toHaveText(['Camera angle and framing', 'Pose'])
  await expect(modal.locator('.pose-view-tag')).toHaveCount(3)
  await expect(modal.locator('.pose-view-note')).toContainText('12 pictures have no tags yet')
  await expect(modal.locator('#pose-view-clear')).toBeHidden()

  await modal.locator('.pose-view-tag[data-tag="from_above"]').click()
  await modal.locator('.pose-view-tag[data-tag="sitting"]').click()
  await expect.poll(() => page.evaluate(() => (window as any).App.AppState.filters.tags)).toEqual(['from_above', 'sitting'])
  await expect.poll(() => library.tagQueries().at(-1)).toBe('from_above,sitting')
  await expect(modal.locator('.pose-view-tag[aria-pressed="true"]')).toHaveCount(2)
  await expect(modal.locator('.pose-view-status')).toHaveText('2 chosen, 3 pictures match')

  // Pressing one again takes it off.
  await modal.locator('.pose-view-tag[data-tag="sitting"]').click()
  await expect.poll(() => page.evaluate(() => (window as any).App.AppState.filters.tags)).toEqual(['from_above'])

  await modal.locator('#pose-view-done').click()
  await expect(modal).not.toHaveClass(/visible/)
  // The sidebar row stays lit while one of its tags filters the Gallery.
  await expect(page.locator('#btn-pose-view')).toHaveAttribute('aria-pressed', 'true')

  await pressSidebarRow(page)
  await modal.locator('#pose-view-clear').click()
  await expect.poll(() => page.evaluate(() => (window as any).App.AppState.filters.tags)).toEqual([])
  await page.keyboard.press('Escape')
  await expect(modal).not.toHaveClass(/visible/)
  await expect(page.locator('#btn-pose-view')).toHaveAttribute('aria-pressed', 'false')
})

test('a library with no such tags says how to get them', async ({ page }) => {
  await mockLibrary(page, { view: [], pose: [], untagged: 8 })
  await openChooser(page)

  await expect(page.locator('.pose-view-empty')).toContainText('no pose or camera-angle tags yet')
  await expect(page.locator('#pose-view-tag-now')).toBeVisible()
})
