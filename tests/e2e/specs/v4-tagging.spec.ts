import { expect, test, type Page, type Route } from '@playwright/test'

import { cleanupImages, openLibrary, pageOverflow, seedImages, VIEWPORTS } from '../fixtures/v4-seed'

/**
 * V4 "Tag…" for the picks: the tagger panel, first-use download, and the
 * tagging job in the jobs drawer. Every model and tagging endpoint is stubbed:
 * the test server must never download weights or run a tagger.
 *
 * Needs the V4 build: `cd frontend-v4 && npm ci && npm run build`.
 */

test.describe.configure({ mode: 'serial' })

const TOKEN = 'v4tagtoken'
const PREFIX = 'v4tag-'
const COUNT = 6
const DIR = 'v4-tag'

test.beforeAll(() => seedImages({ prefix: PREFIX, token: TOKEN, count: COUNT, dir: DIR }))
test.afterAll(() => cleanupImages(PREFIX, [DIR]))

const STATUS = {
  models: [
    {
      id: 'wd14',
      status: 'ready',
      available: true,
      variants: ['wd-eva02-large-tagger-v3', 'wd-swinv2-tagger-v3', 'wd-vit-tagger-v3'],
      installed_variants: ['wd-swinv2-tagger-v3'],
    },
  ],
}

interface TagStub {
  started: Record<string, unknown>[]
  /** What POST /api/tag/start answers. */
  startStatus: 'started' | 'queued'
  /** Polls of our run that still report "running" before it is done. */
  runningPolls: number
  /** While true, progress keeps showing the older run 7 with a queued job. */
  holdQueue: boolean
}

/** A fake tagging backend: run 7 is the last finished run; ours is run 8. */
async function stubTagging(page: Page, stub: TagStub) {
  await page.route('**/api/models/status', (route) => route.fulfill({ json: STATUS }))
  await page.route('**/api/tag/start', async (route) => {
    stub.started.push(route.request().postDataJSON())
    await route.fulfill({ json: { status: stub.startStatus } })
  })
  let ours = 0
  await page.route('**/api/tag/progress', (route: Route) => {
    const before = { status: 'done', run_id: 7, current: 50, total: 50, tagged: 50, errors: 0 }
    if (stub.started.length === 0) return route.fulfill({ json: before })
    if (stub.holdQueue) return route.fulfill({ json: { ...before, pipeline_queue: { total_queued: 1 } } })
    ours += 1
    const total = (stub.started.at(-1)!.image_ids as number[]).length
    return route.fulfill({
      json:
        ours <= stub.runningPolls
          ? { status: 'running', run_id: 8, current: 1, total, tagged: 1, errors: 0 }
          : {
              status: 'done', run_id: 8, current: total, total, tagged: total, errors: 0,
              last_run_stats: { top_tags: [{ tag: '1girl', count: total }, { tag: 'smile', count: 1 }] },
            },
    })
  })
}

async function pickTwo(page: Page) {
  const tiles = page.getByTestId('tile')
  await tiles.nth(0).click({ modifiers: ['Control'] })
  await tiles.nth(1).click({ modifiers: ['Control'] })
  await expect(page.getByTestId('selection-bar')).toContainText('2 picked')
}

async function openTagDialog(page: Page) {
  await page.getByTestId('selection-bar').getByRole('button', { name: 'Tag…' }).click()
  const dialog = page.getByTestId('tag-dialog')
  await expect(dialog.getByText('WD SwinV2 v3')).toBeVisible()
  return dialog
}

for (const viewport of VIEWPORTS) {
  test(`tag panel fits at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport)
    for (const theme of ['dark', 'light'] as const) {
      await openLibrary(page, TOKEN, COUNT, theme)
      await page.route('**/api/models/status', (route) => route.fulfill({ json: STATUS }))
      await pickTwo(page)
      const dialog = await openTagDialog(page)
      await dialog.getByText('Advanced').click()
      await expect(dialog.getByText('Drop these tags while tagging')).toBeVisible()
      await expect(dialog).toBeInViewport({ ratio: 1 })
      await expect(dialog.getByRole('button', { name: 'Tag 2' })).toBeInViewport({ ratio: 1 })
      expect(await pageOverflow(page)).toBeLessThanOrEqual(0)
      await page.keyboard.press('Escape')
      await expect(dialog).toHaveCount(0)
      await page.unroute('**/api/models/status')
    }
  })
}

test('a downloaded tagger starts at once; the advanced choices reach the backend and are remembered', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await openLibrary(page, TOKEN, COUNT)
  const stub: TagStub = { started: [], startStatus: 'started', runningPolls: 2, holdQueue: false }
  await stubTagging(page, stub)
  await pickTwo(page)
  const dialog = await openTagDialog(page)

  // the recommended, downloaded tagger is chosen; the others say what first use costs
  const swin = dialog.locator('label', { hasText: 'WD SwinV2 v3' })
  await expect(swin.getByRole('radio')).toBeChecked()
  await expect(swin).toContainText('Downloaded')
  await expect(dialog.locator('label', { hasText: 'WD EVA02 Large v3' })).toContainText('Downloads first, about 1.2 GB')
  await expect(dialog.locator('label', { hasText: 'Camie v2' })).toContainText('Checked on first use')

  await dialog.getByText('Advanced').click()
  await dialog.getByLabel('General tag threshold').fill('0.5')
  await dialog.getByLabel('Drop these tags while tagging').fill('watermark, signature')
  await dialog.getByRole('button', { name: 'Tag 2' }).click()
  await expect(dialog).toHaveCount(0)

  await expect.poll(() => stub.started.length).toBe(1)
  expect(stub.started[0]).toMatchObject({
    model_name: 'wd-swinv2-tagger-v3',
    threshold: 0.5,
    character_threshold: null,
    pre_tag_blacklist: ['watermark', 'signature'],
    use_gpu: true,
  })
  expect(stub.started[0]!.image_ids).toHaveLength(2)

  await page.getByTestId('jobs-button').click()
  const job = page.getByTestId('jobs-drawer').getByTestId('job').first()
  await expect(job).toContainText('Tagged 2')
  await expect(job.getByTestId('job-top-tags')).toContainText('1girl ×2')
  await page.keyboard.press('Escape')

  // the next time, the same tagger comes with the threshold it was given
  await openTagDialog(page)
  await page.getByTestId('tag-dialog').getByText('Advanced').click()
  await expect(page.getByTestId('tag-dialog').getByLabel('General tag threshold')).toHaveValue('0.5')
})

test('a tagger that is not downloaded is downloaded first, then the tagging starts', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await openLibrary(page, TOKEN, COUNT)
  const stub: TagStub = { started: [], startStatus: 'started', runningPolls: 1, holdQueue: false }
  await stubTagging(page, stub)
  const prepared: Record<string, unknown>[] = []
  let downloadPolls = 0
  await page.route('**/api/models/prepare', async (route) => {
    prepared.push(route.request().postDataJSON())
    await route.fulfill({ json: { status: 'downloading', model_id: 'wd14' } })
  })
  await page.route('**/api/models/download-progress', (route) => {
    downloadPolls += 1
    const downloading = downloadPolls < 3
    return route.fulfill({
      json: downloading
        ? { active: true, downloaded: 300 * 1048576, total: 1200 * 1048576, filename: 'model.onnx', prepare_result: { active: true, model_id: 'wd14', status: 'downloading' } }
        : { active: false, downloaded: 0, total: 0, prepare_result: { active: false, model_id: 'wd14', status: 'ok', message: 'ready' } },
    })
  })

  await pickTwo(page)
  const dialog = await openTagDialog(page)
  await dialog.locator('label', { hasText: 'WD EVA02 Large v3' }).click()
  await dialog.getByRole('button', { name: 'Download and tag 2' }).click()
  await expect(dialog).toHaveCount(0)

  await expect.poll(() => prepared.length).toBe(1)
  expect(prepared[0]).toMatchObject({ model_id: 'wd14', variant: 'wd-eva02-large-tagger-v3' })
  // tagging waits for the download, then starts with the same tagger
  await expect.poll(() => stub.started.length, { timeout: 10_000 }).toBe(1)
  expect(stub.started[0]).toMatchObject({ model_name: 'wd-eva02-large-tagger-v3' })

  await page.getByTestId('jobs-button').click()
  const drawer = page.getByTestId('jobs-drawer')
  await expect(drawer).toContainText('WD EVA02 Large v3 is ready')
  await expect(drawer).toContainText('Tagged 2')
})

test('a tagging run queued behind another one waits, and is never reported done early', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await openLibrary(page, TOKEN, COUNT)
  const stub: TagStub = { started: [], startStatus: 'queued', runningPolls: 0, holdQueue: true }
  await stubTagging(page, stub)
  await pickTwo(page)
  const dialog = await openTagDialog(page)
  await dialog.getByRole('button', { name: 'Tag 2' }).click()

  await page.getByTestId('jobs-button').click()
  const job = page.getByTestId('jobs-drawer').getByTestId('job').first()
  await expect(job).toContainText('Queued')
  // several polls of the older, finished run must not end our job
  await page.waitForTimeout(2000)
  await expect(job).toContainText('Queued')
  await expect(job).not.toContainText('Tagged')

  stub.holdQueue = false
  await expect(job).toContainText('Tagged 2')
})
