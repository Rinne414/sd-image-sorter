import { expect, test, type Page } from '../fixtures/click-ledger'

/**
 * deepghs anime aesthetic (2026-09-28): an optional grade from masterpiece to
 * worst plus the picture's rank among the model's reference pictures. The
 * preview shows it and the gallery sorts by it.
 */

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('sd-image-sorter-lang', 'en')
    localStorage.setItem('sd-sorter-entry-skip-session', '1')
  })
})

async function openGallery(page: Page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await expect(page.locator('#view-gallery')).toBeVisible()
  await expect.poll(() => page.evaluate(() => (window as any).App.AppState?.isLoading === false)).toBe(true)
  await expect(page.locator('#gallery-grid .gallery-item').first()).toBeVisible({ timeout: 20_000 })
}

async function injectDetail(page: Page, fields: Record<string, unknown>) {
  await page.route(
    (url) => /\/api\/images\/\d+$/.test(url.pathname),
    async (route) => {
      const response = await route.fetch()
      const body = await response.json()
      body.image = { ...body.image, ...fields }
      await route.fulfill({ response, json: body })
    },
  )
}

for (const viewport of [
  { width: 1366, height: 768 },
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 },
]) {
  test(`the preview shows the anime grade and its rank at ${viewport.width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport)
    await injectDetail(page, {
      aesthetic_score: 6.1,
      aesthetic_waifu: 7.4,
      aesthetic_anime: 4.56,
      aesthetic_anime_pct: 0.823,
      aesthetic_anime_grade: 'great',
    })
    await openGallery(page)

    await page.locator('#gallery-grid .gallery-item').first().click()
    await expect(page.locator('#image-modal.visible')).toBeVisible({ timeout: 10_000 })

    const grade = page.locator('#modal-anime-item')
    await expect(grade).toHaveText('Anime grade: great · top 18%')
    await expect(grade).toBeInViewport()
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow).toBeLessThanOrEqual(0)
    await page.screenshot({ path: testInfo.outputPath(`anime-grade-preview-${viewport.width}.png`) })
  })
}

test.describe('at 1366px', () => {
  test.use({ viewport: { width: 1366, height: 768 } })

  test('the best-ranked grade still reads as top 1%', async ({ page }) => {
    await injectDetail(page, { aesthetic_anime: 5.9, aesthetic_anime_pct: 0.998, aesthetic_anime_grade: 'masterpiece' })
    await openGallery(page)

    await page.locator('#gallery-grid .gallery-item').first().click()
    await expect(page.locator('#modal-anime-item')).toHaveText('Anime grade: masterpiece · top 1%')
  })

  test('a picture without a grade shows no grade row', async ({ page }) => {
    await injectDetail(page, { aesthetic_anime: null, aesthetic_anime_pct: null, aesthetic_anime_grade: null })
    await openGallery(page)

    await page.locator('#gallery-grid .gallery-item').first().click()
    await expect(page.locator('#modal-filename')).not.toHaveText('')
    await expect(page.locator('#modal-anime-item')).toBeHidden()
  })

  test('the gallery sorts by the anime grade both ways', async ({ page }) => {
    await openGallery(page)
    const sort = page.locator('#gallery-sort')
    await expect(sort.locator('option[value="aesthetic_anime"]')).toHaveText('Anime Grade')
    const sortOf = (url: string) => {
      const parsed = new URL(url)
      return parsed.pathname === '/api/images' ? parsed.searchParams.get('sort_by') : null
    }

    const bestFirst = page.waitForResponse((r) => sortOf(r.url()) === 'aesthetic_anime')
    await sort.selectOption('aesthetic_anime')
    expect((await bestFirst).status()).toBe(200)

    const worstFirst = page.waitForResponse((r) => sortOf(r.url()) === 'aesthetic_anime_asc')
    await page.locator('#sort-reverse-btn').click()
    expect((await worstFirst).status()).toBe(200)
  })
})
