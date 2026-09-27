import { expect, test, type Page } from '../fixtures/click-ledger'

/**
 * Colour analysis keeps going until every image is analyzed (V3.5 3-2).
 *
 * One analyze request covers at most 50,000 images. A library with more used
 * to stop after the first 50,000 and say "done". A run the user starts now
 * continues round after round until nothing is missing, and the finish
 * message counts every round. Cancel stops the rounds.
 */

test.describe.configure({ mode: 'serial' })

interface FakeColorBackend {
  analyzeTotals: number[]
  missing: number
}

async function fakeColorBackend(page: Page, missingAtStart: number): Promise<FakeColorBackend> {
  const state: FakeColorBackend = { analyzeTotals: [], missing: missingAtStart }
  let running = false
  let round = { total: 0, polls: 0, cancelled: false }

  await page.route('**/api/colors/missing-count', (route) =>
    route.fulfill({ json: { missing: state.missing, total: missingAtStart + 1000 } }))
  await page.route('**/api/colors/analyze', (route) => {
    const total = Math.min(50000, state.missing)
    state.analyzeTotals.push(total)
    running = total > 0
    round = { total, polls: 0, cancelled: false }
    return route.fulfill({ json: { status: 'started', total } })
  })
  await page.route('**/api/colors/cancel', (route) => {
    round.cancelled = true
    running = false
    return route.fulfill({ json: { status: 'cancel_requested' } })
  })
  await page.route('**/api/colors/progress', (route) => {
    let completed = 0
    if (running) {
      round.polls += 1
      if (round.polls >= 2) {
        running = false
        state.missing -= round.total
      }
    }
    if (!running && !round.cancelled) completed = round.total
    return route.fulfill({
      json: {
        running,
        total: round.total,
        completed: running ? Math.floor(round.total / 2) : completed,
        failed: 0,
        cancel_requested: round.cancelled,
        current_image: '',
      },
    })
  })
  return state
}

async function openApp(page: Page) {
  await page.addInitScript(() => localStorage.setItem('sd-image-sorter-lang', 'zh-CN'))
  await page.setViewportSize({ width: 1366, height: 768 })
  await page.goto('/')
  await page.waitForFunction(() => Boolean((window as any).ColorBackfill?.startAnalysis && (window as any).showToast))
  // Toasts are short-lived: keep every message the run shows.
  await page.evaluate(() => {
    const w = window as any
    const show = w.showToast
    w.__toasts = []
    w.showToast = (message: string, level: string) => {
      w.__toasts.push(String(message))
      return show(message, level)
    }
  })
}

const toasts = (page: Page) => page.evaluate(() => (window as any).__toasts as string[])

test('a run past 50,000 images continues until none are missing and counts every round', async ({ page }) => {
  const backend = await fakeColorBackend(page, 120000)
  await openApp(page)

  await page.evaluate(() => (window as any).ColorBackfill.startAnalysis())

  await expect.poll(() => backend.analyzeTotals, { timeout: 30000 }).toEqual([50000, 50000, 20000])
  await expect.poll(() => toasts(page), { timeout: 15000 }).toContain('色彩分析完成 — 已分析 120,000 张。')
  expect(await toasts(page)).toEqual([
    '已开始补算 120,000 张图的色彩，每批 50,000 张，自动接着做到全部完成。',
    '已分析 50,000 张，还剩 70,000 张，继续下一批 50,000 张。',
    '已分析 100,000 张，还剩 20,000 张，继续下一批 20,000 张。',
    '色彩分析完成 — 已分析 120,000 张。',
  ])
  expect(backend.missing).toBe(0)
})

test('cancel stops the rounds', async ({ page }) => {
  const backend = await fakeColorBackend(page, 120000)
  await openApp(page)

  await page.evaluate(() => (window as any).ColorBackfill.startAnalysis())
  await page.evaluate(() => (window as any).ColorBackfill.cancelAnalysis())
  await page.waitForTimeout(4000)

  expect(backend.analyzeTotals).toEqual([50000])
})
