import fs from 'node:fs'
import path from 'node:path'

import { expect, test, type Page } from '../fixtures/click-ledger'
import { createTestImage } from '../fixtures/test-helpers'

// The spec may be the first of its shard, so the gallery may be empty:
// seed one picture of its own and scan it before any test opens the grid.
const fixtureDir = path.join(__dirname, '..', '..', '..', '.tmp', 'manual-test', 'aesthetic-waifu')

test.beforeAll(async ({ request }) => {
  fs.mkdirSync(fixtureDir, { recursive: true })
  await createTestImage(fixtureDir, 'aesthetic-waifu-seed.png', { generator: 'nai', prompt: 'seed picture' })
  const response = await request.post('/api/scan', { data: { folder_path: fixtureDir, recursive: true } })
  expect(response.ok()).toBeTruthy()
  await expect.poll(async () => {
    const progress = await (await request.get('/api/scan/progress')).json()
    return String(progress.status || '')
  }, { timeout: 60_000 }).toBe('done')
})

/**
 * Waifu Scorer V3 (2026-09-28): an optional anime aesthetic score from the
 * same CLIP pass as the LAION score. The preview shows it, the gallery sorts
 * by it, and the Aesthetic tab says when a run only adds it.
 */

test.use({ viewport: { width: 1366, height: 768 } })

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

for (const viewport of [
  { width: 1366, height: 768 },
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 },
]) {
test(`the preview shows the Waifu score next to the aesthetic score at ${viewport.width}px`, async ({ page }, testInfo) => {
  await page.setViewportSize(viewport)
  await page.route(
    (url) => /\/api\/images\/\d+$/.test(url.pathname),
    async (route) => {
      const response = await route.fetch()
      const body = await response.json()
      body.image = { ...body.image, aesthetic_score: 6.1, aesthetic_waifu: 7.456 }
      await route.fulfill({ response, json: body })
    },
  )
  await openGallery(page)

  await page.locator('#gallery-grid .gallery-item').first().click()
  await expect(page.locator('#image-modal.visible')).toBeVisible({ timeout: 10_000 })

  const waifu = page.locator('#modal-waifu-item')
  await expect(waifu).toBeVisible()
  await expect(waifu).toContainText('Waifu: 7.46 / 10')
  await expect(waifu).toBeInViewport()
  await expect(page.locator('#modal-aesthetic-item')).toContainText('6.10 / 10')
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(0)
  await page.screenshot({ path: testInfo.outputPath(`waifu-preview-${viewport.width}.png`) })
})
}

test('a picture without a Waifu score shows no Waifu row', async ({ page }) => {
  await page.route(
    (url) => /\/api\/images\/\d+$/.test(url.pathname),
    async (route) => {
      const response = await route.fetch()
      const body = await response.json()
      body.image = { ...body.image, aesthetic_waifu: null }
      await route.fulfill({ response, json: body })
    },
  )
  await openGallery(page)

  await page.locator('#gallery-grid .gallery-item').first().click()
  await expect(page.locator('#image-modal.visible')).toBeVisible({ timeout: 10_000 })

  await expect(page.locator('#modal-filename')).not.toHaveText('')
  await expect(page.locator('#modal-waifu-item')).toBeHidden()
})

function sortOf(url: string): string | null {
  const parsed = new URL(url)
  return parsed.pathname === '/api/images' ? parsed.searchParams.get('sort_by') : null
}

test('the gallery sorts by the Waifu score both ways', async ({ page }) => {
  await openGallery(page)
  const sort = page.locator('#gallery-sort')
  await expect(sort.locator('option[value="aesthetic_waifu"]')).toHaveText('Waifu Score')

  const bestFirst = page.waitForResponse((r) => sortOf(r.url()) === 'aesthetic_waifu')
  await sort.selectOption('aesthetic_waifu')
  expect((await bestFirst).status()).toBe(200)

  const worstFirst = page.waitForResponse((r) => sortOf(r.url()) === 'aesthetic_waifu_asc')
  await page.locator('#sort-reverse-btn').click()
  expect((await worstFirst).status()).toBe(200)
  await expect(page.locator('#gallery-grid .gallery-item').first()).toBeVisible()
})

async function openAestheticTab(page: Page, status: Record<string, unknown>) {
  await page.route('**/api/aesthetic/status', (route) => route.fulfill({ json: status }))
  await openGallery(page)
  await page.locator('#btn-tag').click()
  await expect(page.locator('#tag-modal')).toHaveClass(/visible/)
  await page.locator('#tag-modal .tagger-tab[data-tagger-tab="aesthetic"]').click()
}

test('the Aesthetic tab says which pictures only get the Waifu score', async ({ page }) => {
  await openAestheticTab(page, {
    available: true,
    message: null,
    scored_count: 10,
    outdated_count: 0,
    missing_extra_count: 6,
    to_score_count: 8,
  })

  await expect(page.locator('#tagger-aesthetic-scope')).toHaveText(
    'This run scores the 2 images in this library that have no aesthetic score yet. '
      + 'It also adds the newly installed anime scores to 6 images that already have an aesthetic score.',
  )
})

test('when every picture is scored the Aesthetic tab only mentions the Waifu score', async ({ page }) => {
  await openAestheticTab(page, {
    available: true,
    message: null,
    scored_count: 10,
    outdated_count: 0,
    missing_extra_count: 10,
    to_score_count: 10,
  })

  const scope = page.locator('#tagger-aesthetic-scope')
  await expect(scope).toHaveText('Every image already has an aesthetic score. This run adds the newly installed anime scores to 10 of them.')
  await expect(scope).toBeInViewport()
})
