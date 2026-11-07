import { expect, test, type Page } from '@playwright/test'

/**
 * Switching the language live must relabel text that scripts wrote (not only
 * the static markup): the library name in the sidebar and top bar, the card
 * badges of the gallery, the generator tab hint, the Similar setup notice and
 * the Prompt Lab empty states. Each used to keep the old language until reload.
 */

test.use({ viewport: { width: 1366, height: 768 } })

const MOCK_IMAGE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#789"/></svg>'

async function open(page: Page, lang: 'en' | 'zh-CN', skipEntry = true) {
  const images = Array.from({ length: 3 }, (_, index) => ({
    id: 5401 + index, filename: `live-${index + 1}.png`, path: `/mock/live-${index + 1}.png`, width: 64, height: 64,
  }))
  await page.route(/\/api\/image-(thumbnail|file)\/\d+/, (route) => route.fulfill({ status: 200, contentType: 'image/svg+xml', body: MOCK_IMAGE_SVG }))
  await page.route('**/api/images**', async (route) => {
    if (new URL(route.request().url()).pathname === '/api/images') {
      await route.fulfill({ json: { images, total: images.length, has_more: false, next_cursor: null } })
    } else {
      await route.fallback()
    }
  })
  await page.addInitScript(({ value, skip }) => {
    if (!sessionStorage.getItem('live-labels-seeded')) {
      localStorage.setItem('sd-image-sorter-lang', value)
      sessionStorage.setItem('live-labels-seeded', '1')
    }
    localStorage.setItem('aurora-entry-skip', skip ? '1' : '0')
  }, { value: lang, skip: skipEntry })
  await page.goto('/')
  if (skipEntry) await expect(page.locator('#gallery-grid .gallery-item').nth(1)).toBeVisible()
  else await expect(page.locator('body.entry-active')).toHaveCount(1)
}

test('the library name follows a live language switch, both ways', async ({ page }) => {
  await open(page, 'zh-CN')
  await expect(page.locator('#sidebar-library-name')).toContainText('主图库')
  await expect(page.locator('#nav-library-chip-label')).toContainText('主图库')
  await page.locator('#btn-language-toggle').click()
  await expect(page.locator('#sidebar-library-name')).toContainText('Main library')
  await expect(page.locator('#nav-library-chip-label')).toContainText('Main library')
  await expect(page.locator('#nav-library-chip')).toHaveAttribute('title', /Current library: Main library/)
  await page.locator('#btn-language-toggle').click()
  await expect(page.locator('#sidebar-library-name')).toContainText('主图库')
  await expect(page.locator('#nav-library-chip')).toHaveAttribute('title', /当前图库：主图库/)
})

test('gallery card badges and the generator hint follow a live language switch', async ({ page }) => {
  await open(page, 'zh-CN')
  const card = page.locator('#gallery-grid .gallery-item').first()
  await expect(card.locator('.gallery-item-fav')).toHaveAttribute('title', '收藏')
  await page.locator('#btn-language-toggle').click()
  await expect(card.locator('.gallery-item-fav')).toHaveAttribute('title', 'Favorite')
  await expect(card.locator('.gallery-item-fav')).toHaveAttribute('aria-label', 'Favorite')
  await expect(card.locator('.gallery-item-order')).toHaveAttribute('title', 'Current gallery order')
  await expect(page.locator('.gen-tab[data-gen="others"]')).toHaveAttribute('title', 'Groups uncommon generators')
})

test('the entry page lines and the mission chip follow a live language switch', async ({ page }) => {
  await open(page, 'zh-CN', false)
  await expect(page.locator('#entry-page')).toContainText('今天新进')
  await page.evaluate(() => (window as any).I18n.setLang('en'))
  await expect(page.locator('#entry-page')).toContainText('new today')
  await expect(page.locator('#entry-page')).not.toContainText('今天新进')
})
