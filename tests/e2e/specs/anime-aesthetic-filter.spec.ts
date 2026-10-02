import fs from 'node:fs'
import path from 'node:path'

import { expect, test, type Page } from '../fixtures/click-ledger'
import { createTestImage } from '../fixtures/test-helpers'

/**
 * Anime aesthetic filter (2026-09-30): the Filter panel's Aesthetic section
 * picks any of the deepghs grades and a Waifu Scorer V3 range. Which pictures
 * match is covered by backend/tests/test_anime_aesthetic_filter.py; this spec
 * covers the panel itself and what it sends.
 */

const fixtureDir = path.join(__dirname, '..', '..', '..', '.tmp', 'manual-test', 'anime-aesthetic-filter')

test.beforeAll(async ({ request }) => {
  fs.mkdirSync(fixtureDir, { recursive: true })
  await createTestImage(fixtureDir, 'anime-filter-seed.png', { generator: 'nai', prompt: 'seed picture' })
  const response = await request.post('/api/scan', { data: { folder_path: fixtureDir, recursive: true } })
  expect(response.ok()).toBeTruthy()
  await expect.poll(async () => {
    const progress = await (await request.get('/api/scan/progress')).json()
    return String(progress.status || '')
  }, { timeout: 60_000 }).toBe('done')
})

async function openFilterPanel(page: Page, lang: 'en' | 'zh-CN') {
  await page.addInitScript((language) => {
    localStorage.setItem('sd-image-sorter-lang', language)
    localStorage.setItem('sd-sorter-entry-skip-session', '1')
  }, lang)
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await expect(page.locator('#view-gallery')).toBeVisible()
  await expect.poll(() => page.evaluate(() => (window as any).App.AppState?.isLoading === false)).toBe(true)
  await page.evaluate(() => (window as any).App.openFilterModal())
  await expect(page.locator('#filter-modal.visible')).toBeVisible()
  await page.locator('#filter-anime-grades').scrollIntoViewIfNeeded()
}

async function expectChipsFitTheirPanel(page: Page) {
  const layout = await page.evaluate(() => {
    const group = document.getElementById('filter-anime-grades')!
    const panel = group.closest('.filter-panel')!.getBoundingClientRect()
    const chips = [...group.querySelectorAll('.filter-choice-card')].map((chip) => chip.getBoundingClientRect())
    const groupStyle = getComputedStyle(group)
    const gap = parseFloat(groupStyle.columnGap) || 0
    const contentRight = group.getBoundingClientRect().right
      - parseFloat(groupStyle.paddingRight) - parseFloat(groupStyle.borderRightWidth)
    return {
      panelLeft: panel.left,
      panelRight: panel.right,
      chips: chips.map((r) => ({ left: r.left, right: r.right, top: r.top, height: r.height })),
      // A chip starts a new row only when it would not fit after the one before:
      // the row count follows the font, the packing does not.
      earlyWraps: chips.filter((r, i) => i > 0 && r.top > chips[i - 1].top + 1
        && chips[i - 1].right + gap + r.width <= contentRight + 0.5).length,
      // Each chip hugs its word (not the 88px cards the other choices use).
      looseChips: [...group.querySelectorAll<HTMLElement>('.filter-choice-card')].filter((chip) => {
        const style = getComputedStyle(chip)
        const range = document.createRange()
        range.selectNodeContents(chip)
        const frame = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight)
          + parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth)
        // Rects carry the UI scale (large screens), computed styles and offsetWidth do not.
        const scale = chip.getBoundingClientRect().width / chip.offsetWidth || 1
        return chip.offsetWidth > range.getBoundingClientRect().width / scale + frame + 1
      }).length,
      pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      // Each subheading sits as close to its controls as the other one does.
      headingGaps: [...document.querySelectorAll('#filter-modal .anime-aesthetic-heading')].map((heading) => {
        const next = heading.nextElementSibling!.getBoundingClientRect()
        return Math.round(next.top - heading.getBoundingClientRect().bottom)
      }),
    }
  })
  expect(layout.headingGaps).toHaveLength(2)
  expect(Math.abs(layout.headingGaps[0] - layout.headingGaps[1])).toBeLessThanOrEqual(2)
  expect(layout.chips).toHaveLength(7)
  for (const chip of layout.chips) {
    expect(chip.left).toBeGreaterThanOrEqual(layout.panelLeft)
    expect(chip.right).toBeLessThanOrEqual(layout.panelRight)
    expect(chip.height).toBeLessThan(48)
  }
  expect(layout.earlyWraps).toBe(0)
  expect(layout.looseChips).toBe(0)
  expect(layout.pageOverflow).toBeLessThanOrEqual(0)
}

for (const viewport of [
  { width: 1366, height: 768 },
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 },
]) {
  test(`picking anime grades and a Waifu range filters the gallery at ${viewport.width}px`, async ({ page }, testInfo) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(String(error)))
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text())
    })
    await page.setViewportSize(viewport)
    await openFilterPanel(page, 'en')
    await expectChipsFitTheirPanel(page)

    await page.locator('#filter-anime-grades label', { hasText: 'best' }).click()
    await page.locator('#filter-anime-grades label', { hasText: 'great' }).click()
    await page.locator('#filter-waifu-min').fill('6')
    await expect(page.locator('#filter-modal-count-aesthetic')).toHaveText('2 grades · Waifu 6+')
    await page.locator('#filter-anime-grades').screenshot({ path: testInfo.outputPath(`anime-grade-chips-${viewport.width}.png`) })
    await page.locator('#filter-anime-grades').evaluate((el) => el.closest('.filter-panel')!.scrollIntoView({ block: 'center' }))
    await page.screenshot({ path: testInfo.outputPath(`anime-aesthetic-panel-${viewport.width}.png`) })

    const listing = page.waitForRequest((request) => {
      const url = new URL(request.url())
      return url.pathname === '/api/images' && url.searchParams.has('anime_grades')
    })
    await page.locator('#btn-apply-modal-filters').click()
    const url = new URL((await listing).url())
    expect(url.searchParams.get('anime_grades')).toBe('best,great')
    expect(url.searchParams.get('min_waifu')).toBe('6')
    expect(url.searchParams.has('max_waifu')).toBe(false)
    await expect(page.locator('#filter-modal')).toBeHidden()
    expect(await page.evaluate(() => (window as any).App.AppState.filters.animeGrades)).toEqual(['best', 'great'])

    // Reopening the panel shows what is applied.
    await page.evaluate(() => (window as any).App.openFilterModal())
    await expect(page.locator('#filter-anime-grades input[value="best"]')).toBeChecked()
    await expect(page.locator('#filter-anime-grades input[value="great"]')).toBeChecked()
    await expect(page.locator('#filter-anime-grades input[value="worst"]')).not.toBeChecked()
    await expect(page.locator('#filter-waifu-min')).toHaveValue('6')
    expect(errors).toEqual([])
  })
}

test('the anime grade section reads in Chinese and still fits at 1366px', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await openFilterPanel(page, 'zh-CN')
  await expect(page.locator('#filter-modal h5[data-i18n="filter.animeGradeTitle"]')).toHaveText('二次元档位')
  await expect(page.locator('#filter-modal h5[data-i18n="filter.waifuTitle"]')).toHaveText('Waifu 分')
  await expectChipsFitTheirPanel(page)
  await page.locator('#filter-anime-grades label', { hasText: 'worst' }).click()
  await expect(page.locator('#filter-modal-count-aesthetic')).toHaveText('1 个档位')
  await page.locator('#filter-anime-grades').evaluate((el) => el.closest('.filter-panel')!.scrollIntoView({ block: 'center' }))
  await page.screenshot({ path: testInfo.outputPath('anime-aesthetic-panel-zh-1366.png') })
})

test('a Waifu value above 10 is clamped and Unscored shows on the stat card', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await openFilterPanel(page, 'en')
  await page.locator('#filter-waifu-max').fill('15')
  await expect(page.locator('#filter-modal-count-aesthetic')).toHaveText('Waifu ≤10')
  await page.locator('.aesthetic-quick[data-unscored="1"]').click()
  await expect(page.locator('#filter-modal-count-aesthetic')).toHaveText('Unscored · Waifu ≤10')

  const listing = page.waitForRequest((request) => {
    const url = new URL(request.url())
    return url.pathname === '/api/images' && url.searchParams.has('max_waifu')
  })
  await page.locator('#btn-apply-modal-filters').click()
  const url = new URL((await listing).url())
  expect(url.searchParams.get('max_waifu')).toBe('10')
  expect(url.searchParams.get('aesthetic_unscored')).toBe('true')
})
