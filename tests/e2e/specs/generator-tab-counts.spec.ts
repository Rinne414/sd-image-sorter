import fs from 'node:fs'
import path from 'node:path'

import { expect, test, type Page } from '../fixtures/click-ledger'
import { createTestImage } from '../fixtures/test-helpers'

/**
 * Generator tab counts follow the filters (2026-10-26). The tabs above the
 * gallery showed the whole library's count per generator even with a search
 * on, so "WebUI (500)" opened a gallery of 2. They now count what the
 * current filters leave, ignoring the generator filter itself (the tabs choose
 * the generator), and go back to the library counts when the filters clear.
 */

const fixtureDir = path.join(__dirname, '..', '..', '..', '.tmp', 'manual-test', 'generator-tab-counts')
const PROBE = 'gentabcountprobe'

test.beforeAll(async ({ request }) => {
  fs.mkdirSync(fixtureDir, { recursive: true })
  await createTestImage(fixtureDir, 'gtc-webui-1.png', { generator: 'webui', prompt: `${PROBE}, 1girl`, color: 'red' })
  await createTestImage(fixtureDir, 'gtc-webui-2.png', { generator: 'webui', prompt: `${PROBE}, smile`, color: 'green' })
  await createTestImage(fixtureDir, 'gtc-nai-1.png', { generator: 'nai', prompt: `${PROBE}, solo`, color: 'yellow' })
  await createTestImage(fixtureDir, 'gtc-forge-1.png', { generator: 'forge', prompt: 'unrelated landscape', color: 'purple' })
  const response = await request.post('/api/scan', { data: { folder_path: fixtureDir, recursive: true } })
  expect(response.ok()).toBeTruthy()
  await expect.poll(async () => {
    const progress = await (await request.get('/api/scan/progress')).json()
    return String(progress.status || '')
  }, { timeout: 60_000 }).toBe('done')
})

async function openGallery(page: Page, lang: 'en' | 'zh-CN') {
  await page.addInitScript((language) => {
    localStorage.setItem('sd-image-sorter-lang', language)
    localStorage.setItem('sd-sorter-entry-skip-session', '1')
  }, lang)
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await expect(page.locator('#view-gallery')).toBeVisible()
  await expect.poll(() => page.evaluate(() => (window as any).App.AppState?.isLoading === false)).toBe(true)
  await expect.poll(() => page.evaluate(() => Boolean((window as any).App.AppState?.analytics))).toBe(true)
}

async function libraryCounts(page: Page) {
  // Through the page: the browser retries a kept-alive connection the server
  // has just closed; page.request does not (an ECONNRESET flake on CI).
  const stats = await page.evaluate(async () => (await fetch('/api/stats')).json())
  const counts: Record<string, number> = {}
  for (const row of stats.generators) counts[row.generator] = row.count
  return { counts, total: Number(stats.total_images) }
}

async function search(page: Page, text: string) {
  const counted = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/images/generator-counts')
  const input = page.locator('#gallery-search-input')
  await input.fill(text)
  await input.press('Enter')
  return counted
}

for (const run of [
  { lang: 'en' as const, viewport: { width: 1366, height: 768 }, filteredTitle: 'match the current filters' },
  { lang: 'zh-CN' as const, viewport: { width: 2560, height: 1440 }, filteredTitle: '当前筛选下' },
]) {
  test(`the generator tabs count what a search leaves (${run.lang}, ${run.viewport.width}px)`, async ({ page }, testInfo) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(String(error)))
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text())
    })
    await page.setViewportSize(run.viewport)
    await openGallery(page, run.lang)
    const library = await libraryCounts(page)
    await expect(page.locator('#count-forge')).toHaveText(String(library.counts.forge || 0))

    const response = await search(page, PROBE)
    expect(response.ok()).toBeTruthy()
    await expect(page.locator('#count-webui')).toHaveText('2')
    await expect(page.locator('#count-nai')).toHaveText('1')
    await expect(page.locator('#count-forge')).toHaveText('0')
    await expect(page.locator('#count-all')).toHaveText('3')
    await expect(page.locator('#count-webui')).toHaveAttribute('title', new RegExp(run.filteredTitle))
    // The image-count label still compares with the whole library.
    await expect(page.locator('#image-count')).toContainText(String(library.total))
    await page.locator('#generator-tabs').screenshot({
      path: testInfo.outputPath(`generator-tabs-filtered-${run.lang}-${run.viewport.width}.png`),
    })

    // Opening a tab narrows the gallery to its count; the other tabs keep theirs.
    await page.locator('.gen-tab[data-gen="nai"]').click()
    await expect(page.locator('#gallery-grid .gallery-item[data-id]')).toHaveCount(1)
    await expect(page.locator('#count-webui')).toHaveText('2')
    await page.locator('.gen-tab[data-gen="webui"]').click()
    await expect(page.locator('#gallery-grid .gallery-item[data-id]')).toHaveCount(2)

    // Clearing the search brings the library counts back.
    await page.locator('.gen-tab[data-gen="all"]').click()
    await page.locator('#gallery-search-input').fill('')
    await page.locator('#gallery-search-input').press('Enter')
    await expect(page.locator('#count-forge')).toHaveText(String(library.counts.forge || 0))
    await expect(page.locator('#count-all')).toHaveText(String(library.total))
    await expect(page.locator('#count-all')).not.toHaveAttribute('title', new RegExp(run.filteredTitle))

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow).toBeLessThanOrEqual(0)
    expect(errors).toEqual([])
  })
}
