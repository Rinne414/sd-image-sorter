import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { expect, test, type Page, type Route } from '@playwright/test'

import { cleanupImages, dbPath, openLibrary, pageOverflow, runBackendScript, seedImages, tmpRoot, VIEWPORTS } from '../fixtures/v4-seed'
import { expectSuggestions, stubTagSuggest, suggestList } from '../fixtures/v4-suggest'

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

/** Opens 高级设置 unless it is open already (it stays as the user left it). */
async function openAdvanced(dialog: ReturnType<Page['getByTestId']>) {
  const details = dialog.getByTestId('tag-advanced')
  if ((await details.getAttribute('open')) === null) await details.locator('summary').click()
  await expect(details).toHaveAttribute('open', '')
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
      await openAdvanced(dialog)
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

test('PixAI v1.0 sits under v0.9 as the PixAI pick, with its cost, and its name fits its column', async ({ page }) => {
  const status = {
    models: [
      {
        id: 'wd14',
        status: 'ready',
        available: true,
        variants: ['wd-swinv2-tagger-v3', 'pixai-tagger-v0.9', 'pixai-tagger-v1.0'],
        installed_variants: ['wd-swinv2-tagger-v3', 'pixai-tagger-v0.9'],
      },
    ],
  }
  for (const viewport of VIEWPORTS) {
    await page.setViewportSize(viewport)
    await openLibrary(page, TOKEN, COUNT)
    await page.route('**/api/models/status', (route) => route.fulfill({ json: status }))
    await pickTwo(page)
    const dialog = await openTagDialog(page)

    const names = await dialog.locator('label').evaluateAll((rows) => rows.map((row) => row.querySelector('span')?.textContent ?? ''))
    const v09 = names.findIndex((n) => n.startsWith('PixAI v0.9'))
    expect(v09).toBeGreaterThanOrEqual(0)
    expect(names[v09 + 1]).toContain('PixAI v1.0')

    const v1 = dialog.locator('label', { hasText: 'PixAI v1.0' })
    await expect(v1).toContainText('Best PixAI')
    await expect(v1).not.toContainText('Recommended')
    await expect(v1).toContainText('better at characters and series, weak at artist styles')
    await expect(v1).toContainText('7.5 GB')
    await expect(v1).toContainText('Downloads first, about 2 GB')
    await expect(dialog.locator('label', { hasText: 'PixAI v0.9' })).toContainText('Downloaded')
    await expect(dialog.locator('label', { hasText: 'WD SwinV2 v3' })).toContainText('Recommended')

    // The badge stays inside the name column instead of running into the note.
    const [name, note] = await v1.evaluate((row) => {
      const spans = row.querySelectorAll(':scope > span')
      return [spans[0]!.getBoundingClientRect(), spans[1]!.getBoundingClientRect()].map((r) => ({ right: r.right, left: r.left }))
    })
    const badgeRight = await v1.locator('[data-kind="family"]').evaluate((b) => b.getBoundingClientRect().right)
    expect(badgeRight).toBeLessThanOrEqual(note!.left + 0.5)
    expect(name!.right).toBeLessThanOrEqual(note!.left + 0.5)
    expect(await pageOverflow(page)).toBeLessThanOrEqual(0)
    await v1.scrollIntoViewIfNeeded()
    await page.screenshot({ path: `test-results/v4-tagging-pixai-${viewport.width}.png` })

    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await page.unroute('**/api/models/status')
  }
})

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
  // and 高级设置 is open again, as it was left
  await expect(page.getByTestId('tag-dialog').getByTestId('tag-advanced')).toHaveAttribute('open', '')
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

// ---- slice 6k1: the tagging options V3.5 had ----

/** Smart Tag runs the panel starts (tag and describe, or describe only), finishing at once. */
async function stubSmartTag(page: Page): Promise<Record<string, unknown>[]> {
  const starts: Record<string, unknown>[] = []
  await page.route('**/api/vlm/settings', (route) =>
    route.fulfill({ json: { provider: 'openai', endpoint: 'https://vlm.example.test/v1', model: 'e2e-vision', api_key_display: 'sk-...e2e' } }),
  )
  await page.route('**/api/smart-tag/start', async (route) => {
    starts.push(route.request().postDataJSON() as Record<string, unknown>)
    await route.fulfill({ json: { job_id: `e2e-6k1-${starts.length}`, status: 'running' } })
  })
  await page.route('**/api/smart-tag/progress**', (route) => {
    const n = ((starts.at(-1)?.image_ids as number[]) ?? []).length
    return route.fulfill({
      json: { job_id: `e2e-6k1-${starts.length}`, status: 'completed', active: false, total: n, processed: n, succeeded: n, failed: 0, errors: [], pipeline_queue: { total_queued: 0, queued: [] } },
    })
  })
  return starts
}

async function jobSays(page: Page, text: string) {
  await page.getByTestId('jobs-button').click()
  await expect(page.getByTestId('jobs-drawer').getByTestId('job').first()).toContainText(text)
  await page.keyboard.press('Escape')
}

test('a custom ONNX file, copyright threshold, noise switch, append and the tagger switch reach the backend and are remembered', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await openLibrary(page, TOKEN, COUNT)
  const stub: TagStub = { started: [], startStatus: 'started', runningPolls: 0, holdQueue: false }
  await stubTagging(page, stub)
  const smart = await stubSmartTag(page)
  await pickTwo(page)

  // your own ONNX file: Start waits for its path, then the plain run sends type and paths
  let dialog = await openTagDialog(page)
  await dialog.getByTestId('tagger-custom').click()
  await expect(dialog.getByTestId('tag-reason')).toHaveText('Enter the full path of the model file (.onnx) to start.')
  await expect(dialog.getByRole('button', { name: 'Tag 2' })).toBeDisabled()
  await dialog.getByTestId('tag-custom-profile').selectOption('camie-tagger-v2')
  await dialog.getByTestId('tag-custom-model').fill('D:\\models\\camie.onnx')
  await dialog.getByTestId('tag-custom-tags').fill('D:\\models\\meta.json')
  // it tags on its own: a describer cannot be chosen with it
  await expect(dialog.locator('input[name="describer"][value="florence2"]')).toBeDisabled()
  await dialog.getByRole('button', { name: 'Tag 2' }).click()
  await expect(dialog).toHaveCount(0)
  await expect.poll(() => stub.started.length).toBe(1)
  expect(stub.started[0]).toMatchObject({ model_name: 'camie-tagger-v2', model_path: 'D:\\models\\camie.onnx', tags_path: 'D:\\models\\meta.json', custom_profile: 'camie-tagger-v2' })
  await jobSays(page, 'Tagged 2')

  // tag and describe: the Smart Tag options reach its body
  dialog = await openTagDialog(page)
  await expect(dialog.getByTestId('tag-custom-model')).toHaveValue('D:\\models\\camie.onnx')
  await dialog.locator('label', { hasText: 'WD SwinV2 v3' }).click()
  await dialog.locator('input[name="describer"][value="vlm"]').check()
  await expect(dialog.getByTestId('tag-describe-calls')).toContainText('Calls e2e-vision 2 times')
  await dialog.getByTestId('tag-merge').selectOption('append')
  await expect(dialog.getByTestId('tag-describe')).toContainText("the Library's AI tags are still replaced by this run's")
  await dialog.getByTestId('tag-advanced').locator('summary').click()
  await dialog.getByLabel('Copyright tag threshold').fill('0.4')
  await dialog.getByTestId('tag-strip-noise').uncheck()
  await dialog.getByRole('button', { name: 'Tag and describe 2' }).click()
  await expect(dialog).toHaveCount(0)
  await expect.poll(() => smart.length).toBe(1)
  expect(smart[0]).toMatchObject({
    enable_wd14: true,
    enable_vlm: true,
    natural_language_mode: 'vlm',
    tagger_model: 'wd-swinv2-tagger-v3',
    copyright_threshold: 0.4,
    auto_strip_noise: false,
    merge_strategy: 'append',
    skip_existing: false,
  })
  await jobSays(page, 'Tagged 2')

  // describe only: the panel says the tags stay, and Start waits for a describer
  dialog = await openTagDialog(page)
  await expect(dialog.getByTestId('tag-advanced')).toHaveAttribute('open', '')
  await expect(dialog.getByLabel('Copyright tag threshold')).toHaveCount(0)
  await dialog.locator('input[name="describer"][value="vlm"]').check()
  await expect(dialog.getByLabel('Copyright tag threshold')).toHaveValue('0.4')
  await expect(dialog.getByTestId('tag-strip-noise')).not.toBeChecked()
  await dialog.locator('input[name="describer"][value="off"]').check()
  await dialog.getByTestId('tag-tagger-on').uncheck()
  await expect(dialog.getByTestId('tag-tagger-off')).toHaveText('No tagging this time: the images keep the tags they have; only descriptions are written.')
  await expect(dialog.getByRole('heading', { name: 'Describe 2 images' })).toBeVisible()
  await expect(dialog.getByTestId('tag-reason')).toHaveText('Choose tagging, a description, or both to start.')
  await expect(dialog.getByRole('button', { name: 'Describe 2' })).toBeDisabled()
  await dialog.locator('input[name="describer"][value="vlm"]').check()
  await expect(dialog.getByTestId('tag-merge')).toHaveValue('append')
  await dialog.getByRole('button', { name: 'Describe 2' }).click()
  await expect(dialog).toHaveCount(0)
  await expect.poll(() => smart.length).toBe(2)
  expect(smart[1]).toMatchObject({ enable_wd14: false, enable_vlm: true, tagger_model: '', merge_strategy: 'append', skip_existing: false })
  expect('copyright_threshold' in smart[1]!).toBe(false)
  await jobSays(page, 'Described 2')

  // Restore defaults forgets the new choices too; the next open starts tagging again
  dialog = await openTagDialog(page)
  await expect(dialog.getByTestId('tag-tagger-on')).toBeChecked()
  await dialog.getByRole('button', { name: 'Restore defaults' }).click()
  await expect(dialog.locator('label', { hasText: 'WD SwinV2 v3' }).getByRole('radio')).toBeChecked()
  await dialog.locator('input[name="describer"][value="vlm"]').check()
  await expect(dialog.getByTestId('tag-merge')).toHaveValue('replace')
  await expect(dialog.getByLabel('Copyright tag threshold')).toHaveValue('')
  await expect(dialog.getByTestId('tag-strip-noise')).toBeChecked()
  await dialog.locator('input[name="describer"][value="off"]').check()
  await dialog.getByTestId('tagger-custom').click()
  await expect(dialog.getByTestId('tag-custom-model')).toHaveValue('')
  expect(await page.evaluate(() => localStorage.getItem('sd-v4-tag-options'))).toBeNull()
})

test('a custom ONNX path the backend refuses is said in plain words, and nothing starts', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  const dir = path.join(tmpRoot, DIR)
  const fakeModel = path.join(dir, 'e2e-fake-model.onnx')
  fs.writeFileSync(fakeModel, 'not a model')
  await openLibrary(page, TOKEN, COUNT)
  await page.route('**/api/models/status', (route) => route.fulfill({ json: STATUS }))
  const answers: number[] = []
  page.on('response', (res) => {
    if (res.url().endsWith('/api/tag/start')) answers.push(res.status())
  })
  await pickTwo(page)
  const dialog = await openTagDialog(page)
  await dialog.getByTestId('tagger-custom').click()
  const start = dialog.getByRole('button', { name: 'Tag 2' })
  const error = dialog.getByTestId('tag-custom-error')

  // the real backend checks the paths, the way V3.5 does
  await dialog.getByTestId('tag-custom-model').fill(path.join(dir, 'no-such-model.onnx'))
  await start.click()
  await expect(error).toHaveText('There is no model file at that path. Check it for typos.')
  await expect(dialog.getByTestId('tag-custom-model')).toHaveAttribute('aria-invalid', 'true')

  // typing again clears it; a picture is not a model
  await dialog.getByTestId('tag-custom-model').fill(path.join(dir, `${PREFIX}00.png`))
  await expect(error).toHaveCount(0)
  await start.click()
  await expect(error).toHaveText('The model file must be an .onnx file.')

  // a model file with a tags file of the wrong kind for its family
  await dialog.getByTestId('tag-custom-model').fill(fakeModel)
  await dialog.getByTestId('tag-custom-tags').fill(path.join(dir, 'tags.txt'))
  await start.click()
  await expect(error).toHaveText('This kind of model needs a .csv tags file.')
  await expect(dialog.getByTestId('tag-custom-tags')).toHaveAttribute('aria-invalid', 'true')

  expect(answers).toEqual([400, 400, 400])
  await expect(dialog).toBeVisible()
  await page.keyboard.press('Escape')
  // no job was started: the Jobs button only shows once there is one
  await expect(page.getByTestId('jobs-button')).toHaveCount(0)
  fs.rmSync(fakeModel, { force: true })
})

/** An OpenAI-compatible service on this computer that describes every picture with the same sentence. */
async function fakeVlm(text: string): Promise<{ url: string; calls: () => number; close: () => Promise<void> }> {
  let calls = 0
  const server = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      calls += 1
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: 'stop' }], usage: { total_tokens: 12 } }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { url: `http://127.0.0.1:${port}/v1`, calls: () => calls, close: () => new Promise((resolve) => server.close(() => resolve())) }
}

interface Row {
  id: number
  tags: string[]
  ai: string | null
  nl: string | null
  taggedAt: string | null
}

/** The first seeded image with tagger tags and a caption, as a tagging run leaves them. */
function seedTaggedImage(): Row {
  return readRow(`
cur.execute("UPDATE images SET ai_caption = '1girl, smile', nl_caption = NULL, tagged_at = '2026-09-01 10:00:00' WHERE id = ?", (image_id,))
cur.execute("DELETE FROM tags WHERE image_id = ?", (image_id,))
for tag, conf in (("1girl", 0.97), ("smile", 0.71)):
    cur.execute("INSERT INTO tags (image_id, tag, confidence, source, category) VALUES (?, ?, ?, 'tagger', 'general')", (image_id, tag, conf))
conn.commit()
`)
}

function readRow(change = ''): Row {
  const out = runBackendScript(`
import json, sqlite3
with sqlite3.connect(${JSON.stringify(dbPath)}) as conn:
    cur = conn.cursor()
    image_id = cur.execute("SELECT id FROM images WHERE filename = ?", (${JSON.stringify(`${PREFIX}00.png`)},)).fetchone()[0]
${change
  .split('\n')
  .filter(Boolean)
  .map((line) => `    ${line}`)
  .join('\n')}
    row = cur.execute("SELECT ai_caption, nl_caption, tagged_at FROM images WHERE id = ?", (image_id,)).fetchone()
    tags = sorted(f"{r[0]}:{r[1]}" for r in cur.execute("SELECT tag, source FROM tags WHERE image_id = ?", (image_id,)))
    print(json.dumps({"id": image_id, "tags": tags, "ai": row[0], "nl": row[1], "taggedAt": row[2]}))
`)
  return JSON.parse(out.split(/\r?\n/).at(-1) ?? '{}') as Row
}

test('describing one image from its right-click menu writes its description and keeps its AI tags (real backend)', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  const sentence = 'A girl with silver hair smiles at the viewer.'
  const vlm = await fakeVlm(sentence)
  const before = seedTaggedImage()
  expect(before.tags).toEqual(['1girl:tagger', 'smile:tagger'])
  try {
    await openLibrary(page, TOKEN, COUNT)
    const saved = await page.evaluate(
      async (endpoint) =>
        (
          await fetch('/api/vlm/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ provider: 'openai_compat', endpoint, model: 'e2e-fake-vlm', max_retries: 0, concurrent_requests: 1, output_format: 'nl_caption' }),
          })
        ).status,
      vlm.url,
    )
    expect(saved).toBe(200)

    await page.locator(`[data-testid="tile"][data-id="${before.id}"]`).click({ button: 'right' })
    await page.getByTestId('card-menu').getByRole('menuitem', { name: 'Analyze' }).hover()
    await page.locator('[data-ctx-sub]').getByRole('menuitem', { name: 'Describe…' }).click()
    const dialog = page.getByTestId('tag-dialog')
    await expect(dialog.getByRole('heading', { name: 'Describe 1 image' })).toBeVisible()
    await expect(dialog.getByTestId('tag-tagger-on')).not.toBeChecked()
    await expect(dialog.getByTestId('tag-tagger-off')).toBeVisible()
    await dialog.locator('input[name="describer"][value="vlm"]').check()
    await expect(dialog.getByTestId('tag-describe-calls')).toHaveText('Calls e2e-fake-vlm 1 time; it runs on this computer, so it costs nothing.')
    await dialog.getByRole('button', { name: 'Describe 1' }).click()
    await expect(dialog).toHaveCount(0)

    await expect.poll(() => readRow().nl, { timeout: 30_000 }).toBe(sentence)
    const after = readRow()
    // the AI tags, the tag caption and when it was tagged stay as they were
    expect(after.tags).toEqual(before.tags)
    expect(after.ai).toBe(before.ai)
    expect(after.taggedAt).toBe(before.taggedAt)
    expect(vlm.calls()).toBe(1)
    await jobSays(page, 'Described 1')

    // V4's card shows the description; its own button opens the same describe-only panel
    await page.locator(`[data-testid="tile"][data-id="${before.id}"]`).click()
    const card = page.getByTestId('generation-card')
    await expect(card).toContainText(sentence)
    await card.getByTestId('card-describe').click()
    await expect(page.getByTestId('tag-dialog').getByRole('heading', { name: 'Describe 1 image' })).toBeVisible()
    await expect(page.getByTestId('tag-dialog').getByTestId('tag-tagger-on')).not.toBeChecked()
    await page.keyboard.press('Escape')

    // V3.5's preview shows it beside the tag caption, which stayed
    await page.evaluate(() => localStorage.setItem('sd-sorter-entry-skip-session', '1'))
    await page.goto('/', { waitUntil: 'domcontentloaded' })
    await expect(page.locator('#view-gallery')).toBeVisible({ timeout: 20_000 })
    await expect.poll(() => page.evaluate(() => (window as unknown as { App: { AppState?: { isLoading?: boolean } } }).App.AppState?.isLoading === false)).toBe(true)
    await page.evaluate((id) => (window as unknown as { Gallery: { openPreview: (id: number) => Promise<void> } }).Gallery.openPreview(id), before.id)
    await expect(page.locator('#image-modal.visible')).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('#modal-nl-caption-text')).toHaveText(sentence)
    await expect(page.locator('#modal-caption-text')).toHaveText('1girl, smile')
  } finally {
    await page.evaluate(() =>
      fetch('/api/vlm/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: '', model: '' }) }),
    )
    await vlm.close()
    readRow(['cur.execute("DELETE FROM tags WHERE image_id = ?", (image_id,))', 'conn.commit()'].join('\n'))
  }
})

test('the tags to drop are suggested as they are typed, and Esc closes only the list', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await openLibrary(page, TOKEN, COUNT)
  const stub: TagStub = { started: [], startStatus: 'started', runningPolls: 1, holdQueue: false }
  await stubTagging(page, stub)
  await stubTagSuggest(page)
  await pickTwo(page)
  const dialog = await openTagDialog(page)
  await openAdvanced(dialog)
  const drop = dialog.getByLabel('Drop these tags while tagging')
  await drop.fill('')
  await drop.pressSequentially('signature, wat')
  await expectSuggestions(page, ['watermark', 'water'])
  await drop.press('Enter')
  await expect(drop).toHaveValue('signature, watermark, ')

  await drop.pressSequentially('lo')
  await expectSuggestions(page, ['long hair', 'long sleeves', 'looking at viewer'])
  await page.keyboard.press('Escape')
  await expect(suggestList(page)).toHaveCount(0)
  await expect(dialog).toBeVisible()
  await drop.press('Backspace')
  await drop.press('Backspace')
  await dialog.getByRole('button', { name: 'Tag 2' }).click()
  await expect.poll(() => stub.started.length).toBe(1)
  expect(stub.started[0]).toMatchObject({ pre_tag_blacklist: ['signature', 'watermark'] })
})
