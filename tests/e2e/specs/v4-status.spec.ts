import { expect, test, type Page } from '@playwright/test'

import { cleanupImages, openLibrary, seedImages } from '../fixtures/v4-seed'

/**
 * V4 library status rows that carry their own fix: tag the untagged images,
 * run colour analysis until none are left, and a colour search with no
 * results that says why. Tagging and colour analysis are stubbed; the colour
 * search runs on the real backend.
 *
 * Needs the V4 build: `cd frontend-v4 && npm ci && npm run build`.
 */

test.describe.configure({ mode: 'serial' })

const TOKEN = 'v4stattoken'
const PREFIX = 'v4stat-'
const COUNT = 3
const DIR = 'v4-stat'

test.beforeAll(() => seedImages({ prefix: PREFIX, token: TOKEN, count: COUNT, dir: DIR }))
test.afterAll(() => cleanupImages(PREFIX, [DIR]))

const HEALTH = (untagged: number) => ({
  summary: { total_images: 100, readable_images: 100, tagged_percent: 97, actionable_count: untagged },
  issue_counts: { untagged, unreadable: 0, metadata_error: 0 },
})

interface ColorStub {
  /** Images still without colour analysis, as the backend would report after each run. */
  missing: number[]
  analyses: number
  running: boolean
}

/** Stubs the status sources; call before the page loads so the rail reads them. */
async function stubStatus(page: Page, untagged: number, colors: ColorStub) {
  await page.route('**/api/library-health', (route) => route.fulfill({ json: HEALTH(untagged) }))
  await page.route('**/api/images/missing-summary', (route) => route.fulfill({ json: { total: 0 } }))
  await page.route('**/api/colors/missing-count', (route) =>
    route.fulfill({ json: { missing: colors.missing[Math.min(colors.analyses, colors.missing.length - 1)], total: 100 } }),
  )
  await page.route('**/api/colors/analyze', (route) => {
    const total = colors.missing[colors.analyses] ?? 0
    colors.analyses += 1
    colors.running = true
    return route.fulfill({ json: { status: 'started', total } })
  })
  let polls = 0
  await page.route('**/api/colors/progress', (route) => {
    const total = colors.missing[colors.analyses - 1] ?? 0
    if (colors.running && ++polls % 2 === 0) colors.running = false
    return route.fulfill({
      json: { running: colors.running, cancel_requested: false, total, completed: colors.running ? 1 : total, failed: 0, current_image: 'a.png' },
    })
  })
}

test('the untagged row tags exactly the untagged images', async ({ page }) => {
  const started: Record<string, unknown>[] = []
  await stubStatus(page, 3, { missing: [0], analyses: 0, running: false })
  await page.route('**/api/models/status', (route) =>
    route.fulfill({ json: { models: [{ id: 'wd14', status: 'ready', available: true, variants: ['wd-swinv2-tagger-v3'], installed_variants: ['wd-swinv2-tagger-v3'] }] } }),
  )
  await page.route('**/api/tag/start', async (route) => {
    started.push(route.request().postDataJSON())
    await route.fulfill({ json: { status: 'started' } })
  })
  await page.route('**/api/tag/progress', (route) =>
    route.fulfill({ json: started.length ? { status: 'done', run_id: 2, current: 3, total: 3, tagged: 3, errors: 0 } : { status: 'idle', run_id: 1 } }),
  )
  await page.setViewportSize({ width: 1366, height: 768 })
  await openLibrary(page, TOKEN, COUNT)

  const status = page.getByTestId('library-status')
  await expect(status).toContainText('3 not tagged yet')
  await status.getByRole('button', { name: 'Tag…' }).click()
  const dialog = page.getByTestId('tag-dialog')
  await expect(dialog).toContainText('Tag the 3 untagged images')
  await expect(dialog).toContainText('tagged ones are left alone')
  await dialog.getByRole('button', { name: 'Tag 3' }).click()
  await expect.poll(() => started.length).toBe(1)
  expect(started[0]).not.toHaveProperty('image_ids')
})

test('colour analysis continues run after run until none are left', async ({ page }) => {
  const colors: ColorStub = { missing: [7, 2, 0], analyses: 0, running: false }
  await stubStatus(page, 0, colors)
  await page.setViewportSize({ width: 1366, height: 768 })
  await openLibrary(page, TOKEN, COUNT)

  const status = page.getByTestId('library-status')
  await expect(status).toContainText('7 without colour analysis yet')
  await status.getByRole('button', { name: 'Analyse' }).click()
  await expect.poll(() => colors.analyses, { timeout: 15_000 }).toBe(2)
  await expect(status).toContainText('Nothing needs attention', { timeout: 15_000 })

  await page.getByTestId('jobs-button').click()
  const jobs = page.getByTestId('jobs-drawer').getByTestId('job')
  await expect(jobs).toHaveCount(2)
  await expect(jobs.first()).toContainText('Colour analysis done for 2')
})

test('a colour search that finds nothing says why and offers the analysis', async ({ page }) => {
  const colors: ColorStub = { missing: [5, 0], analyses: 0, running: false }
  await stubStatus(page, 0, colors)
  await page.setViewportSize({ width: 1920, height: 1080 })
  await openLibrary(page, TOKEN, COUNT)

  const input = page.getByTestId('query-input')
  await input.fill(`${TOKEN} color:red`)
  await input.press('Enter')
  await expect(page.getByTestId('result-count')).toHaveText('0 images')
  const hint = page.getByTestId('color-hint')
  await expect(hint).toContainText('5 images have no colour analysis yet')
  await page.getByRole('button', { name: 'Analyse colours now' }).click()
  await expect.poll(() => colors.analyses).toBe(1)
})
