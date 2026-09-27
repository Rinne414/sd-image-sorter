import { expect, test, type Page, type Route } from '../fixtures/click-ledger'

import { markModelsReady } from '../fixtures/model-status'
import { cleanupImages, openLibrary, pageOverflow, seedImages, VIEWPORTS } from '../fixtures/v4-seed'

/**
 * V4 signals (slice 5b): the AI-busy chip in the top bar, refusals that say who
 * holds the AI, a tagging run that waits in line and says so, work started
 * elsewhere joining the Jobs drawer, the tab title while in the background,
 * next steps after tagging, and the tag panel's "Restore defaults".
 *
 * The AI snapshot, tagging progress and tagging start are all stubbed: the
 * test server never runs a tagger or touches a GPU.
 */

test.describe.configure({ mode: 'serial' })

const TOKEN = 'v4sigtoken'
const PREFIX = 'v4sig-'
const COUNT = 4
const DIR = 'v4-sig'

test.beforeAll(() => seedImages({ prefix: PREFIX, token: TOKEN, count: COUNT, dir: DIR }))
test.afterAll(() => cleanupImages(PREFIX, [DIR]))
test.beforeEach(async ({ page }) => markModelsReady(page))

type Json = Record<string, unknown>

const lease = (label: string, elapsed: number, extra: Json = {}): Json => ({
  label, tier: 'vram', priority: 50, estimated_vram_mb: null, elapsed_seconds: elapsed, stuck: false, ...extra,
})
const snapshot = (...jobs: Json[]): Json => ({
  active: jobs.length, vram_active: jobs.length, cpu_active: 0, cpu_pool_size: 7, vram_estimated_mb: 0, stuck_after_seconds: 180, jobs,
})
const IDLE_RUN: Json = { status: 'done', run_id: 3, current: 0, total: 0, tagged: 0, errors: 0 }

interface Stub {
  ai: Json
  tag: Json
  /** What POST /api/tag/start answers, in turn (the last one repeats). */
  answers: { status: number; json: Json }[]
  started: Json[]
  /** When each POST /api/tag/start was answered. */
  answered: number[]
  /** When each GET /api/system/ai-jobs arrived. */
  aiHits: number[]
}

function newStub(fields: Partial<Stub> = {}): Stub {
  return { ai: snapshot(), tag: IDLE_RUN, answers: [{ status: 200, json: { status: 'started' } }], started: [], answered: [], aiHits: [], ...fields }
}

async function stubAll(page: Page, stub: Stub) {
  await page.route('**/api/system/ai-jobs', (route: Route) => {
    stub.aiHits.push(Date.now())
    return route.fulfill({ json: stub.ai })
  })
  await page.route('**/api/tag/progress', (route: Route) => route.fulfill({ json: stub.tag }))
  await page.route('**/api/tag/start', async (route: Route) => {
    stub.started.push(route.request().postDataJSON())
    const answer = stub.answers[Math.min(stub.started.length - 1, stub.answers.length - 1)]!
    stub.answered.push(Date.now())
    await route.fulfill({ status: answer.status, json: answer.json })
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

/** Let the page believe it is in a background tab (Playwright's page never really is). */
async function fakeVisibility(page: Page) {
  await page.evaluate(() => {
    let state: DocumentVisibilityState = 'visible'
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => state === 'hidden' })
    ;(window as unknown as { setVisibility: (s: DocumentVisibilityState) => void }).setVisibility = (s) => {
      state = s
      document.dispatchEvent(new Event('visibilitychange'))
    }
  })
}

const setVisibility = (page: Page, state: 'visible' | 'hidden') =>
  page.evaluate((s) => (window as unknown as { setVisibility: (v: string) => void }).setVisibility(s), state)

test('the AI chip says what holds the AI, for how long, flags a stuck one, and lists all on click', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  const stub = newStub({ ai: snapshot(lease('censor-onnx-inference', 200, { stuck: true, estimated_vram_mb: 1500 }), lease('aesthetic', 30)) })
  await stubAll(page, stub)
  await openLibrary(page, TOKEN, COUNT)

  const chip = page.getByTestId('ai-busy')
  // room is short: the chip names the model; its title and the list say the rest
  await expect(chip).toContainText('YOLO')
  await expect(chip).toHaveAttribute('title', /Censor detection · YOLO \(3:2\d\); Aesthetic scoring/)
  await expect(chip).toContainText(/≥3:2\d/)
  await expect(chip).toContainText('+1')
  await expect(chip.getByLabel('may be stuck')).toHaveText('!')

  await chip.click()
  const panel = page.getByTestId('ai-busy-panel')
  const rows = panel.getByTestId('ai-busy-row')
  await expect(rows).toHaveCount(2)
  await expect(rows.nth(0)).toContainText('Censor detection · YOLO')
  await expect(rows.nth(0)).toContainText('Running for at least 3 min')
  await expect(rows.nth(0)).toContainText('About 1,500 MB of VRAM')
  await expect(rows.nth(0)).toContainText('so it looks stuck')
  await expect(rows.nth(1)).toContainText('Aesthetic scoring')
  await expect(panel).toBeInViewport({ ratio: 1 })

  // Esc closes the list only
  await page.keyboard.press('Escape')
  await expect(panel).toHaveCount(0)
  await expect(chip).toBeVisible()
  await expect(page.getByTestId('result-count')).toBeVisible()

  // the AI is free again: the chip goes (after the pause allowed between two batches)
  stub.ai = snapshot()
  await expect(chip).toHaveCount(0, { timeout: 15_000 })
})

test('a Library tagging run started elsewhere shows on the chip and joins the drawer without a reload', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  const stub = newStub()
  await stubAll(page, stub)
  await openLibrary(page, TOKEN, COUNT)
  await expect(page.getByTestId('ai-busy')).toHaveCount(0)
  await expect(page.getByTestId('jobs-button')).toHaveCount(0)

  // V3.5 (or another window) starts tagging on the GPU
  stub.tag = { status: 'running', run_id: 4, current: 5, total: 40, tagged: 5, errors: 0, runtime_backend_actual: 'gpu' }
  const chip = page.getByTestId('ai-busy')
  await expect(chip).toContainText('Tagging', { timeout: 10_000 })
  await expect(chip).toContainText('GPU')

  await page.getByTestId('jobs-button').click()
  const job = page.getByTestId('jobs-drawer').getByTestId('job').first()
  await expect(job).toContainText('Tagging 40')
  await expect(job).toContainText('Started elsewhere')
  await page.keyboard.press('Escape')

  await chip.click()
  const row = page.getByTestId('ai-busy-row').first()
  await expect(row).toContainText('GPU · 5 of 40 · Started elsewhere')
  await page.keyboard.press('Escape')

  stub.tag = { status: 'done', run_id: 4, current: 40, total: 40, tagged: 40, errors: 0, last_run_stats: { top_tags: [{ tag: '1girl', count: 40 }] } }
  await page.getByTestId('jobs-button').click()
  await expect(page.getByTestId('jobs-drawer').getByTestId('job').first()).toContainText('Tagged 40')
  await expect(chip).toHaveCount(0, { timeout: 15_000 })
})

test('a refused AI start says who holds it or that a restart is needed; other refusals keep the old sentence', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  const refusal = (reason: string, blocker: Json | null) => ({
    status: 409,
    json: { error: 'busy', type: 'AiRuntimeBusyError', status_code: 409, reason, blocker, waited_seconds: 180 },
  })
  const stub = newStub({
    answers: [
      refusal('busy', { scope: 'process', pid: 4242, label: 'wd14-tagger', elapsed_seconds: 125, holder_alive: true }),
      refusal('stale_lock_holder_gone', { scope: 'process', pid: 9, label: 'tagger-load:wd-swinv2-tagger-v3', elapsed_seconds: 9000, holder_alive: false }),
      { status: 409, json: { detail: 'Could not determine Smart Tag status, so AI Tag was not started.' } },
    ],
  })
  await stubAll(page, stub)
  await openLibrary(page, TOKEN, COUNT)
  await pickTwo(page)
  const dialog = await openTagDialog(page)
  const start = dialog.getByRole('button', { name: 'Tag 2' })

  const said = [
    'Tagging is using the AI in another process (running for 2 min). Try again when it ends; if it is a tagging run started here, you can stop it under Jobs.',
    'The AI is still locked, but Tagging · WD SwinV2 v3 (loading the model), which locked it, is no longer running. Waiting will not help: restart the app to clear it.',
    'A job like this is still running; start this one when it ends.',
  ]
  for (const [i, text] of said.entries()) {
    await start.click()
    await expect.poll(() => stub.answered.length).toBe(i + 1)
    await expect(page.getByText(text)).toBeVisible()
    // only the refusal that waiting cannot fix offers a restart (which asks first)
    const restart = page.locator('[data-tone="error"]').filter({ hasText: text }).getByRole('button', { name: 'Restart app…' })
    await expect(restart).toHaveCount(i === 1 ? 1 : 0)
    // a refusal is fresher than the 6 s idle poll: the chip looks again at once
    const refused = stub.answered[i]!
    await expect.poll(() => stub.aiHits.some((at) => at >= refused && at - refused < 1500), { timeout: 3000 }).toBe(true)
  }
  // a refusal does not close the panel: the choices are still there to try again
  await expect(dialog).toBeVisible()
})

test('starting while tagging holds the GPU says it will wait in line, and queues behind it', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  const theirs = { status: 'running', run_id: 8, current: 10, total: 50, tagged: 10, errors: 0, runtime_backend_actual: 'gpu', pipeline_queue: { total_queued: 0, queued: [] } }
  const stub = newStub({
    tag: theirs,
    answers: [{ status: 200, json: { status: 'queued', pipeline_queued: true, queue_id: 'q1', queue_position: 1, queue_length: 1 } }],
  })
  await stubAll(page, stub)
  await openLibrary(page, TOKEN, COUNT)
  await pickTwo(page)
  const dialog = await openTagDialog(page)

  const notice = dialog.getByTestId('tag-gpu-notice')
  // it was running before the page opened: no made-up run time
  await expect(notice).toContainText('Tagging is using the AI. This run waits in line and starts by itself when that one ends')
  await dialog.getByRole('button', { name: 'Queue tagging 2' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByText('Queued: 2 images. They start by themselves when the tagging ahead ends; see Jobs.')).toBeVisible()
  stub.tag = { ...theirs, pipeline_queue: { total_queued: 1, queued: [{ queue_id: 'q1', kind: 'gallery', position: 1 }] } }

  await page.getByTestId('jobs-button').click()
  const jobs = page.getByTestId('jobs-drawer').getByTestId('job')
  await expect(jobs).toHaveCount(2)
  await expect(jobs.nth(0)).toContainText('Queued: Tagging 2 (after the tagging job ahead of it)')
  await expect(jobs.nth(1)).toContainText('Started elsewhere')

  // the run ahead ends and ours (run 9) runs and ends between two looks at run 8
  stub.tag = { status: 'done', run_id: 9, current: 2, total: 2, tagged: 2, errors: 0, last_run_stats: { top_tags: [{ tag: 'smile', count: 2 }] } }
  await expect(jobs.nth(0)).toContainText('Tagged 2')
  await expect(jobs.nth(1)).toContainText('Tagged 10')
})

test('beside other AI work the panel says the two will take turns, and starts at once', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  const stub = newStub({ ai: snapshot(lease('clip-similarity-inference', 12)) })
  await stubAll(page, stub)
  await openLibrary(page, TOKEN, COUNT)
  await pickTwo(page)
  const dialog = await openTagDialog(page)
  const notice = dialog.getByTestId('tag-gpu-notice')
  await expect(notice).toContainText('Similarity index · CLIP is using the AI. Starting now makes the two take turns on the GPU')
  await expect(dialog.getByRole('button', { name: 'Tag 2' })).toBeEnabled()
})

test('a finished run in a background tab marks the title; its next steps act on its images', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  const stub = newStub()
  await stubAll(page, stub)
  await openLibrary(page, TOKEN, COUNT)
  await fakeVisibility(page)
  const title = await page.title()
  await pickTwo(page)
  const dialog = await openTagDialog(page)
  await dialog.getByRole('button', { name: 'Tag 2' }).click()
  await expect.poll(() => stub.started.length).toBe(1)
  stub.tag = { status: 'running', run_id: 4, current: 1, total: 2, tagged: 1, errors: 0, runtime_backend_actual: 'gpu' }
  await expect(page.getByTestId('jobs-button')).toContainText('1/2')

  await setVisibility(page, 'hidden')
  stub.tag = { status: 'done', run_id: 4, current: 2, total: 2, tagged: 2, errors: 0 }
  await expect.poll(() => page.title()).toBe(`(1) ${title}`)
  await setVisibility(page, 'visible')
  await expect.poll(() => page.title()).toBe(title)

  await page.getByTestId('selection-bar').getByRole('button', { name: 'Clear picks' }).click()
  await expect(page.getByTestId('selection-bar')).toHaveCount(0)
  await page.getByTestId('jobs-button').click()
  const next = page.getByTestId('jobs-drawer').getByTestId('tag-next')
  await expect(next.getByRole('button', { name: 'Pick the 2 in the Library' })).toBeVisible()
  await next.getByRole('button', { name: 'Add to batch' }).click()
  await expect(next.getByRole('button', { name: 'New dataset…' })).toBeVisible()
  await next.getByRole('button', { name: 'Pick the 2 in the Library' }).click()
  await expect(page.getByTestId('selection-bar')).toContainText('2 picked')

  await page.getByTestId('jobs-button').click()
  await page.getByTestId('jobs-drawer').getByTestId('tag-next').getByRole('button', { name: 'Edit tags…' }).click()
  await expect(page.getByTestId('tagedit-dialog')).toContainText('Edit tags on 2 images')
})

test('"Restore defaults" in the tag panel forgets the remembered tagger, thresholds and switches', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await stubAll(page, newStub())
  await openLibrary(page, TOKEN, COUNT)
  await page.evaluate(() =>
    localStorage.setItem(
      'sd-v4-tag-options',
      JSON.stringify({ model: 'wd-vit-tagger-v3', useGpu: false, blacklist: ['watermark'], maxTags: 5, thresholds: { 'wd-vit-tagger-v3': { general: 0.6, character: null } } }),
    ),
  )
  await pickTwo(page)
  const dialog = await openTagDialog(page)
  await expect(dialog.locator('label', { hasText: 'WD ViT v3' }).getByRole('radio')).toBeChecked()
  await dialog.getByText('Advanced').click()
  await expect(dialog.getByLabel('General tag threshold')).toHaveValue('0.6')
  await expect(dialog.getByRole('checkbox', { name: 'Use the GPU' })).not.toBeChecked()

  await dialog.getByRole('button', { name: 'Restore defaults' }).click()
  await expect(dialog.locator('label', { hasText: 'WD SwinV2 v3' }).getByRole('radio')).toBeChecked()
  await expect(dialog.getByLabel('General tag threshold')).toHaveValue('')
  await expect(dialog.getByLabel('Drop these tags while tagging')).toHaveValue('')
  await expect(dialog.getByRole('checkbox', { name: 'Use the GPU' })).toBeChecked()
  await expect(dialog.getByText('Defaults restored')).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Restore defaults' })).toBeDisabled()
  expect(await page.evaluate(() => localStorage.getItem('sd-v4-tag-options'))).toBeNull()
})

for (const viewport of VIEWPORTS) {
  test(`chip, its list and the queue notice fit at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport)
    for (const theme of ['dark', 'light'] as const) {
      const stub = newStub({
        ai: snapshot(lease('sam3-inference', 400, { stuck: true })),
        tag: { status: 'running', run_id: 4, current: 12, total: 300, tagged: 12, errors: 0, runtime_backend_actual: 'gpu' },
      })
      await stubAll(page, stub)
      await openLibrary(page, TOKEN, COUNT, theme)
      const chip = page.getByTestId('ai-busy')
      await expect(chip).toBeInViewport({ ratio: 1 })
      await chip.click()
      await expect(page.getByTestId('ai-busy-panel')).toBeInViewport({ ratio: 1 })
      expect(await pageOverflow(page)).toBeLessThanOrEqual(0)
      await page.keyboard.press('Escape')
      await pickTwo(page)
      const dialog = await openTagDialog(page)
      await expect(dialog.getByTestId('tag-gpu-notice')).toBeVisible()
      await expect(dialog.getByRole('button', { name: 'Queue tagging 2' })).toBeInViewport({ ratio: 1 })
      await expect(dialog.getByRole('button', { name: 'Restore defaults' })).toBeInViewport({ ratio: 1 })
      expect(await pageOverflow(page)).toBeLessThanOrEqual(0)
      await page.keyboard.press('Escape')
      await page.unrouteAll({ behavior: 'ignoreErrors' })
      await markModelsReady(page)
    }
  })
}
