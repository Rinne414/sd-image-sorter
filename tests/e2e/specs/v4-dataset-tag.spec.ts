import fsSync from 'node:fs'
import path from 'node:path'
import { expect, test, type Page, type Route } from '../fixtures/click-ledger'

import { cleanupImages, dbPath, pageOverflow, runBackendScript, seedImages, tmpRoot, VIEWPORTS } from '../fixtures/v4-seed'

/**
 * V4 dataset tag step (slice 3d): the counts are said before a run (untagged,
 * tagged, folder images, paid VLM calls); the Smart Tag request never sends
 * the trigger and skips tagged images unless asked; the caption profile
 * follows the base model; folder results become caption revisions marked as
 * AI output while a user's edit stays until they choose the new tags; new
 * thresholds from stored scores run for real; the step fits every desktop size.
 *
 * Smart Tag, the model status and the VLM settings are stubbed: nothing is
 * downloaded and no tagger runs.
 *
 * Needs the V4 build: `cd frontend-v4 && npm ci && npm run build`.
 */

test.describe.configure({ mode: 'serial' })

const TOKEN = 'v4dtgtoken'
const PREFIX = 'v4dtg-'
const DIR = 'v4-dtg'
const FOLDER_DIR = 'v4-dtg-folder'
const NAME = 'v4dtg'
const MODEL = 'wd-swinv2-tagger-v3'
const folderPath = path.join(tmpRoot, FOLDER_DIR)
const folderFiles = ['local-a.png', 'local-b.png'].map((f) => path.join(folderPath, f))

let ids: number[] = []
let batchId = 0
let projectId = 0

const py = JSON.stringify

function seedRows(): void {
  const out = runBackendScript(`
import sqlite3, time
from pathlib import Path
from PIL import Image
root = Path(${py(folderPath)})
root.mkdir(parents=True, exist_ok=True)
Image.new("RGB", (48, 64), (200, 60, 60)).save(root / "local-a.png")
Image.new("RGB", (64, 48), (60, 200, 60)).save(root / "local-b.png")
with sqlite3.connect(${py(dbPath)}) as conn:
    ids = [r[0] for r in conn.execute("SELECT id FROM images WHERE filename LIKE ? ORDER BY filename", (${py(PREFIX + '%')},))]
    first, second, third = ids
    conn.execute("UPDATE images SET tagged_at = NULL WHERE id IN (?, ?, ?)", ids)
    # the first image was tagged: its tags and the scores they came from
    conn.execute("UPDATE images SET tagged_at = ? WHERE id = ?", (time.strftime("%Y-%m-%d %H:%M:%S"), first))
    for tag, conf in (("1girl", 0.95), ("smile", 0.6), ("general", 0.9)):
        conn.execute("INSERT INTO tags (image_id, tag, confidence) VALUES (?, ?, ?)", (first, tag, conf))
    for tag, score, cat in (("1girl", 0.95, "general"), ("smile", 0.6, "general"), ("outdoors", 0.3, "general"), ("hat", 0.1, "general"), ("general", 0.9, "rating")):
        conn.execute("INSERT OR REPLACE INTO tag_scores (image_id, model, tag, score, category) VALUES (?, ?, ?, ?, ?)", (first, ${py(MODEL)}, tag, score, cat))
    # the third has tags written by hand: not tagged by the tagger
    for tag in ("1girl", "solo"):
        conn.execute("INSERT INTO tags (image_id, tag, confidence) VALUES (?, ?, 1.0)", (third, tag))
    conn.commit()
print(",".join(str(i) for i in ids))
`)
  ids = out.split(/\s+/).at(-1)!.split(',').map(Number)
}

function cleanupRows(): void {
  runBackendScript(`
import sqlite3
with sqlite3.connect(${py(dbPath)}) as conn:
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("DELETE FROM batches WHERE name LIKE ?", (${py(NAME + '%')},))
    conn.execute("DELETE FROM dataset_projects WHERE name LIKE ?", (${py(NAME + '%')},))
    image_ids = "SELECT id FROM images WHERE filename LIKE ?"
    conn.execute(f"DELETE FROM tags WHERE image_id IN ({image_ids})", (${py(PREFIX + '%')},))
    conn.execute(f"DELETE FROM tag_scores WHERE image_id IN ({image_ids})", (${py(PREFIX + '%')},))
    conn.commit()
print("ok")
`)
}

function libraryTags(imageId: number): string[] {
  const out = runBackendScript(`
import sqlite3
with sqlite3.connect(${py(dbPath)}) as conn:
    print(",".join(sorted(r[0] for r in conn.execute("SELECT tag FROM tags WHERE image_id = ?", (${imageId},)))))
`)
  return (out.split(/\r?\n/).at(-1) ?? '').split(',').filter(Boolean)
}

test.beforeAll(() => {
  seedImages({ prefix: PREFIX, token: TOKEN, count: 3, dir: DIR })
  cleanupRows()
  seedRows()
})

test.afterAll(() => {
  cleanupRows()
  cleanupImages(PREFIX, [DIR, FOLDER_DIR])
})

async function openV4(page: Page, hash: string): Promise<void> {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('v4e2e-init-dtg')) return
    sessionStorage.setItem('v4e2e-init-dtg', '1')
    localStorage.setItem('sd-image-sorter-lang', 'en')
    localStorage.setItem('sd-v4-theme', 'dark')
    localStorage.removeItem('sd-v4-tag-options')
  })
  await page.goto(`/v4/${hash}`, { waitUntil: 'domcontentloaded' })
}

async function apiJson<T>(page: Page, url: string, init?: { method: string; body?: unknown }): Promise<{ status: number; body: T }> {
  return page.evaluate(
    async ({ u, i }) => {
      const res = await fetch(u, {
        method: i?.method ?? 'GET',
        headers: { 'Content-Type': 'application/json' },
        body: i?.body === undefined ? undefined : JSON.stringify(i.body),
      })
      return { status: res.status, body: await res.json() }
    },
    { u: url, i: init },
  ) as Promise<{ status: number; body: T }>
}

interface Project {
  id: number
  name: string
  revision: number
  items: { item_type: 'library' | 'local'; source_image_id?: number; path?: string }[]
  settings: Record<string, unknown>
}

interface Head {
  item: { item_type: 'library'; image_id: number } | { item_type: 'local'; path: string }
  generation: number
  active_revision: { author_class: string; source: string; model: string | null; content: { booru_caption: string; nl_caption: string } } | null
}

const project = async (page: Page) => (await apiJson<Project>(page, `/api/dataset/projects/${projectId}`)).body

async function heads(page: Page): Promise<Head[]> {
  const p = await project(page)
  const res = await apiJson<{ items: Head[] }>(page, `/api/annotations/projects/${projectId}/training-captions/heads?expected_project_revision=${p.revision}&limit=200`)
  expect(res.status).toBe(200)
  return res.body.items.filter((h) => h.generation > 0)
}

const sameFile = (a: string, b: string) => a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase()

interface StubRun {
  /** The run is over (it is running until then). */
  finished: () => boolean
  booru: string
  /** The description each folder result carries (default: the red room). */
  nl?: string
}

/** Smart Tag, the model cards and the VLM settings, stubbed; the start bodies are kept. */
async function stubAi(page: Page, vlm: 'configured' | 'none', run: StubRun = { finished: () => true, booru: '1girl, solo, e2e_tag' }): Promise<unknown[]> {
  const starts: Record<string, unknown>[] = []
  await page.route('**/api/vlm/settings', (route) =>
    route.fulfill({
      json:
        vlm === 'configured'
          ? { provider: 'openai', endpoint: 'https://vlm.example.test/v1', model: 'e2e-vision', api_key_display: 'sk-...e2e' }
          : { provider: 'openai', endpoint: '', model: '', api_key_display: '' },
    }),
  )
  await page.route('**/api/models/status', (route) =>
    route.fulfill({
      json: {
        models: [
          { id: 'wd14', status: 'ready', available: true, variants: [MODEL], installed_variants: [MODEL] },
          { id: 'florence2', status: 'ready', available: true },
          { id: 'toriigate', status: 'missing', available: false },
        ],
      },
    }),
  )
  await page.route('**/api/smart-tag/start', async (route: Route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>
    starts.push(body)
    await route.fulfill({ json: { job_id: `e2e-st-${starts.length}`, status: 'running', total: 0 } })
  })
  await page.route('**/api/smart-tag/progress**', (route) => {
    // nothing started yet: no run to report (V4 adopts a run it finds going)
    if (starts.length === 0) return route.fulfill({ json: { status: 'idle', active: false, pipeline_queue: { total_queued: 0, queued: [] } } })
    const last = starts.at(-1) ?? {}
    const n = ((last.image_ids as number[]) ?? []).length + ((last.image_paths as string[]) ?? []).length
    return route.fulfill({
      json: {
        job_id: `e2e-st-${starts.length}`,
        status: run.finished() ? 'completed' : 'running',
        active: !run.finished(),
        total: n,
        processed: run.finished() ? n : 0,
        succeeded: run.finished() ? n : 0,
        failed: 0,
        skipped: 0,
        errors: [],
        pipeline_queue: { total_queued: 0, queued: [] },
      },
    })
  })
  await page.route('**/api/smart-tag/results**', (route) => {
    const paths = ((starts.at(-1)?.image_paths as string[]) ?? [])
    const results = paths.map((p) => ({ path: p, caption: '', booru_text: run.booru, nl_text: run.nl ?? 'A girl stands in a red room.' }))
    return route.fulfill({ json: { results, has_more: false, limit: 1000 } })
  })
  await page.route('**/api/smart-tag/cancel**', (route) => route.fulfill({ json: { status: 'cancelled' } }))
  return starts
}

async function openTagStep(page: Page): Promise<void> {
  await openV4(page, `#/batch/${batchId}`)
  await page.locator('[data-testid="rail-step"][data-step-id="tag"]').click()
  await expect(page.getByTestId('tag-step')).toBeVisible()
}

test('a dataset batch with Library and folder images, one caption edited by the user', async ({ page }) => {
  await openV4(page, '#/batch')
  const made = await apiJson<{ batch: { id: number; dataset_project_id: number } }>(page, '/api/batches', {
    method: 'POST',
    body: { kind: 'dataset', name: `${NAME} set`, image_ids: ids },
  })
  expect(made.status).toBe(201)
  batchId = made.body.batch.id
  projectId = made.body.batch.dataset_project_id

  // the folder images join by path (the backend only takes paths a scan showed it)
  const scan = await apiJson(page, '/api/dataset/folder-scan', {
    method: 'POST',
    body: { folder_path: folderPath, recursive: false, include_thumbnails: false, limit: 10, offset: 0 },
  })
  expect(scan.status).toBe(200)
  const p = await project(page)
  const items = [
    ...ids.map((id) => ({ item_type: 'library', image_id: id, keep_as_saved: true })),
    ...folderFiles.map((f) => ({ item_type: 'local', path: f, keep_as_saved: false })),
  ]
  const settings = { ...p.settings, target_model: 'krea2' }
  const put = await apiJson(page, `/api/dataset/projects/${projectId}`, { method: 'PUT', body: { expected_revision: p.revision, name: p.name, items, settings } })
  expect(put.status).toBe(200)

  const after = await project(page)
  const edit = await apiJson(page, `/api/annotations/projects/${projectId}/training-captions/revisions`, {
    method: 'POST',
    body: {
      expected_project_revision: after.revision,
      expected_head_generation: 0,
      subject: { item_type: 'library', image_id: ids[2] },
      content: { content_version: 1, booru_caption: 'my own words', nl_caption: '', caption_type: 'booru' },
    },
  })
  expect(edit.status).toBe(201)
})

test('the counts come first; the run sends no trigger, skips tagged images, and writes folder results as AI captions', async ({ page }) => {
  const starts = await stubAi(page, 'none')
  await page.setViewportSize({ width: 1366, height: 768 })
  await openTagStep(page)

  await expect(page.getByTestId('scope-library')).toHaveText('Library images: 2 without tags, 1 already tagged')
  await expect(page.getByTestId('scope-folder')).toHaveText('Folder images: 2 without a caption, 0 with one')
  await expect(page.getByTestId('tag-scope')).toContainText('You edited 1 caption')
  await expect(page.getByTestId('tag-total')).toHaveText('This run takes 4 images')
  // captions are off by default; without a VLM set up it cannot be chosen
  await expect(page.getByRole('radio', { name: /None/ })).toBeChecked()
  await expect(page.locator('input[name="describer"][value="vlm"]')).toBeDisabled()
  await expect(page.getByTestId('tag-describer')).toContainText('No VLM service is set up')
  await expect(page.getByTestId('tag-model-state')).toHaveText('Downloaded')

  await page.getByTestId('tag-start').click()
  await expect.poll(() => starts.length).toBe(1)
  const body = starts[0] as Record<string, unknown>
  expect(body.trigger_word).toBe('')
  expect(body.skip_existing).toBe(true)
  expect(body.enable_vlm).toBe(false)
  expect(body.tagger_model).toBe(MODEL)
  expect(body.image_ids).toEqual([ids[1], ids[2]])
  expect((body.image_paths as string[]).map((f) => f.replace(/\\/g, '/'))).toEqual(folderFiles.map((f) => f.replace(/\\/g, '/')))
  expect('caption_profile' in body).toBe(false)

  // the job ends in the drawer; the folder results become AI revisions
  await expect(page.getByTestId('tag-report-state')).toHaveText(
    'Done. The Library images\' tags are updated; 2 folder images got their results as captions (marked as AI output).',
    { timeout: 15_000 },
  )
  const written = await heads(page)
  for (const file of folderFiles) {
    const head = written.find((h) => h.item.item_type === 'local' && sameFile(h.item.path, file))
    expect(head?.active_revision).toMatchObject({ author_class: 'ai', source: 'wd14', model: MODEL })
    expect(head?.active_revision?.content).toMatchObject({ booru_caption: '1girl, solo, e2e_tag', nl_caption: 'A girl stands in a red room.' })
  }
  // the edited caption is still the user's, and the step offers the new tags
  const mine = written.find((h) => h.item.item_type === 'library' && h.item.image_id === ids[2])
  expect(mine?.active_revision).toMatchObject({ author_class: 'user' })
  await expect(page.getByTestId('tag-kept')).toContainText('1 caption you edited kept your version')

  await page.getByTestId('tag-replace').click()
  await expect(page.getByRole('status')).toContainText('1 caption now uses the new tags.')
  await expect(page.getByTestId('tag-kept')).toHaveCount(0)
  const replaced = (await heads(page)).find((h) => h.item.item_type === 'library' && h.item.image_id === ids[2])
  expect(replaced?.active_revision?.author_class).toBe('ai')
  expect(replaced?.active_revision?.content.booru_caption).toContain('solo')
  expect(replaced?.active_revision?.content.booru_caption).not.toContain('my own words')
  // the trigger word never went to the Library
  expect(libraryTags(ids[2])).toEqual(['1girl', 'solo'])
})

test('a paid VLM: the number of calls is said before the run; the base model picks the caption profile', async ({ page }) => {
  const starts = await stubAi(page, 'configured')
  await page.setViewportSize({ width: 1366, height: 768 })
  await openTagStep(page)

  // folder images have captions now: only the two untagged Library images go
  await expect(page.getByTestId('tag-total')).toHaveText('This run takes 2 images')
  await expect(page.getByTestId('tag-vlm-calls')).toHaveCount(0)
  await page.locator('input[name="describer"][value="vlm"]').check()
  await expect(page.getByTestId('tag-vlm-calls')).toHaveText('Calls e2e-vision 2 times (once per image). A service billed per call will charge for them.')

  // tagging the rest again widens the run, and the count follows
  await page.getByTestId('tag-retag').check()
  await expect(page.getByTestId('tag-total')).toHaveText('This run takes 5 images')
  await expect(page.getByTestId('tag-vlm-calls')).toContainText('Calls e2e-vision 5 times')
  await page.getByTestId('tag-retag').uncheck()

  await page.getByTestId('tag-start').click()
  await expect.poll(() => starts.length).toBe(1)
  expect(starts[0]).toMatchObject({ enable_vlm: true, natural_language_mode: 'vlm', caption_profile: 'krea2_long_nl', trigger_word: '', skip_existing: true })
  // only Library images went: the report says just that
  await expect(page.getByTestId('tag-report-state')).toHaveText("Done. The Library images' tags are updated.", { timeout: 15_000 })
})

test('a run still going when the page reloads writes its folder results once it ends', async ({ page }) => {
  let over = false
  const starts = await stubAi(page, 'none', { finished: () => over, booru: '1girl, resumed_tag' })
  await page.setViewportSize({ width: 1366, height: 768 })
  await openTagStep(page)
  await page.getByTestId('tag-retag').check()
  await page.getByTestId('tag-start').click()
  await expect.poll(() => starts.length).toBe(1)
  expect(starts[0]).toMatchObject({ skip_existing: false })
  await expect(page.getByTestId('tag-report-state')).toHaveText('Running; its progress is in Jobs.')

  await page.reload({ waitUntil: 'domcontentloaded' })
  over = true
  await expect(page.getByTestId('tag-step')).toBeVisible()
  await expect(page.getByTestId('tag-report-state')).toContainText('2 folder images got their results as captions', { timeout: 15_000 })
  const written = await heads(page)
  for (const file of folderFiles) {
    const head = written.find((h) => h.item.item_type === 'local' && sameFile(h.item.path, file))
    expect(head?.active_revision).toMatchObject({ author_class: 'ai', source: 'wd14' })
    expect(head?.active_revision?.content.booru_caption).toBe('1girl, resumed_tag')
  }
})

test('a start refused because the AI lock outlived its job offers a restart', async ({ page }) => {
  await stubAi(page, 'none')
  await page.route('**/api/smart-tag/start', (route) =>
    route.fulfill({
      status: 409,
      json: { error: 'busy', type: 'AiRuntimeBusyError', status_code: 409, reason: 'stale_lock_holder_gone', blocker: { label: 'wd14-tagger-load', stuck: true }, waited_seconds: 0 },
    }),
  )
  await page.setViewportSize({ width: 1366, height: 768 })
  await openTagStep(page)
  await page.getByTestId('tag-start').click()
  const toast = page.locator('[data-tone="error"]').filter({ hasText: 'Waiting will not help' })
  await expect(toast.getByRole('button', { name: 'Restart app…' })).toBeVisible()
})

test('without a VLM service the describer says so and links to Settings › AI services', async ({ page }) => {
  await stubAi(page, 'none')
  await page.setViewportSize({ width: 1366, height: 768 })
  await openTagStep(page)
  await expect(page.getByTestId('tag-describer')).toContainText('No VLM service is set up yet')
  await page.getByTestId('tag-describe-setup').click()
  await expect(page).toHaveURL(/#\/settings\/ai$/)
  await expect(page.getByTestId('ai-services')).toBeVisible()
})

test('the tagger off: a description-only run keeps the tags, and append joins the new words to the old', async ({ page }) => {
  const starts = await stubAi(page, 'none', { finished: () => true, booru: '', nl: 'A second look at the room.' })
  await page.setViewportSize({ width: 1366, height: 768 })
  await openTagStep(page)

  await page.getByTestId('tag-tagger-on').uncheck()
  await expect(page.getByTestId('tag-tagger-off')).toHaveText('No tagging this time: the images keep the tags they have; only descriptions are written.')
  await expect(page.getByTestId('tag-model')).toHaveCount(0)
  // nothing to do yet: Start says why it waits
  await expect(page.getByTestId('tag-idle')).toHaveText('Choose tagging, a description, or both to start.')
  await expect(page.getByTestId('tag-start')).toBeDisabled()
  await page.locator('input[name="describer"][value="florence2"]').check()
  await expect(page.getByTestId('tag-idle')).toHaveCount(0)

  await page.getByTestId('tag-retag').check()
  await expect(page.getByTestId('tag-scope')).toContainText('Describe the 3 that already have tags or a caption too (their tags stay)')
  await page.getByTestId('tag-merge').selectOption('append')
  await expect(page.getByTestId('tag-start')).toHaveText('Describe 5')
  await page.getByTestId('tag-start').click()
  await expect.poll(() => starts.length).toBe(1)
  expect(starts[0]).toMatchObject({
    enable_wd14: false,
    enable_vlm: true,
    natural_language_mode: 'florence2',
    merge_strategy: 'append',
    auto_strip_noise: true,
    tagger_model: '',
    taggers: [],
    skip_existing: false,
  })

  await expect(page.getByTestId('tag-report-state')).toContainText('kept their tags', { timeout: 15_000 })
  // the folder captions keep their tags; the new words follow the old ones
  const written = await heads(page)
  for (const file of folderFiles) {
    const head = written.find((h) => h.item.item_type === 'local' && sameFile(h.item.path, file))
    expect(head?.active_revision).toMatchObject({ author_class: 'ai', source: 'vlm' })
    expect(head?.active_revision?.content).toMatchObject({ booru_caption: '1girl, resumed_tag', nl_caption: 'A girl stands in a red room. A second look at the room.' })
  }
  await page.getByTestId('jobs-button').click()
  await expect(page.getByTestId('jobs-drawer').getByTestId('job').first()).toContainText('Described 5')
})

type QueuePhase = 'waiting' | 'running' | 'done' | 'gone'

const ENQUEUED_AT = '2026-09-27T01:02:03+00:00'

/**
 * A Smart Tag run queued behind other AI work at place q9, answered as the
 * backend does: by its queue place (`?queue_id=`, also after it ended), by
 * job id, or (neither) the active run. `gone`: the backend no longer knows q9.
 */
async function stubQueuedRun(page: Page, phase: () => QueuePhase, booru: string): Promise<{ results: () => number }> {
  await stubAi(page, 'none')
  let sent = 0
  let paths: string[] = []
  let results = 0
  await page.route('**/api/smart-tag/start', async (route: Route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>
    paths = (body.image_paths as string[]) ?? []
    sent = ((body.image_ids as number[]) ?? []).length + paths.length
    await route.fulfill({ json: { status: 'queued', pipeline_queued: true, queue_id: 'q9', enqueued_at: ENQUEUED_AT, queue_position: 1 } })
  })
  await page.route('**/api/smart-tag/progress**', (route) => {
    const query = new URL(route.request().url()).searchParams
    const now = phase()
    const done = now === 'done'
    const empty = { total_queued: 0, queued: [] }
    const waiting = { total_queued: 1, queued: [{ queue_id: 'q9', kind: 'smart', position: 1, enqueued_at: ENQUEUED_AT }] }
    const job = {
      job_id: 'e2e-q9', active: !done, status: done ? 'completed' : 'running', total: sent, processed: done ? sent : 1, succeeded: done ? sent : 0,
      failed: 0, errors: [], settings: { queue_id: 'q9', queue_enqueued_at: ENQUEUED_AT }, pipeline_queue: empty,
    }
    if (query.get('queue_id') === 'q9') {
      if (now === 'gone') return route.fulfill({ json: { status: 'unknown', active: false, found: false, queue_id: 'q9', pipeline_queue: empty } })
      if (now === 'waiting') return route.fulfill({ json: { status: 'queued', active: false, found: true, queue_id: 'q9', pipeline_queue: waiting } })
      return route.fulfill({ json: { ...job, found: true, queue_id: 'q9' } })
    }
    const started = now === 'running' || done
    if (query.get('job_id') === 'e2e-q9' && started) return route.fulfill({ json: job })
    if (!query.has('job_id') && now === 'running') return route.fulfill({ json: job })
    return route.fulfill({ json: { status: 'idle', active: false, pipeline_queue: now === 'waiting' ? waiting : empty } })
  })
  await page.route('**/api/smart-tag/results**', (route) => {
    results += 1
    return route.fulfill({ json: { results: paths.map((p) => ({ path: p, caption: '', booru_text: booru, nl_text: '' })), has_more: false, limit: 1000 } })
  })
  return { results: () => results }
}

/** Start the tag step on every image: the run is queued, and the page keeps its queue place. */
async function startQueued(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1366, height: 768 })
  await openTagStep(page)
  await page.getByTestId('tag-retag').check()
  await page.getByTestId('tag-start').click()
  await expect(page.getByTestId('tag-report-state')).toHaveText('Running; its progress is in Jobs.')
  const kept = await page.evaluate(() => JSON.parse(localStorage.getItem('sd-v4-dataset-tag-runs') ?? '[]'))
  expect(kept).toEqual([expect.objectContaining({ batchId, jobId: null, queueId: 'q9', enqueuedAt: ENQUEUED_AT })])
}

async function expectFolderCaptions(page: Page, booru: string): Promise<void> {
  const written = await heads(page)
  for (const file of folderFiles) {
    const head = written.find((h) => h.item.item_type === 'local' && sameFile(h.item.path, file))
    expect(head?.active_revision).toMatchObject({ author_class: 'ai', source: 'wd14' })
    expect(head?.active_revision?.content.booru_caption).toBe(booru)
  }
}

test('a batch run that started out queued survives a reload and still writes its folder results', async ({ page }) => {
  let phase: QueuePhase = 'waiting'
  await stubQueuedRun(page, () => phase, '1girl, queued_tag')
  await startQueued(page)

  // the page reloads while the run still waits; it starts and ends later
  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(page.getByTestId('tag-step')).toBeVisible()
  await page.getByTestId('jobs-button').click()
  await expect(page.getByTestId('jobs-drawer').getByTestId('job').first()).toContainText('Queued')
  await page.keyboard.press('Escape')
  // it starts: asked for by its queue place, the backend names the job it became
  phase = 'running'
  await page.getByTestId('jobs-button').click()
  const job = page.getByTestId('jobs-drawer').getByTestId('job').first()
  await expect(job).toContainText('Tagging 5', { timeout: 10_000 })
  await expect(job).not.toContainText('Queued')
  await page.keyboard.press('Escape')
  phase = 'done'
  await expect(page.getByTestId('tag-report-state')).toContainText('2 folder images got their results as captions', { timeout: 15_000 })
  await expectFolderCaptions(page, '1girl, queued_tag')
  expect(await page.evaluate(() => localStorage.getItem('sd-v4-dataset-tag-runs'))).toBe('[]')
})

test('a queued batch run that started and ended while no page watched still writes its folder results', async ({ page }) => {
  let phase: QueuePhase = 'waiting'
  await stubQueuedRun(page, () => phase, '1girl, away_tag')
  await startQueued(page)

  // the page goes away; meanwhile the run leaves the queue, runs and ends
  await page.goto('/api/libraries', { waitUntil: 'domcontentloaded' })
  phase = 'done'
  await openTagStep(page)
  await expect(page.getByTestId('tag-report-state')).toContainText('2 folder images got their results as captions', { timeout: 15_000 })
  await expectFolderCaptions(page, '1girl, away_tag')
  expect(await page.evaluate(() => localStorage.getItem('sd-v4-dataset-tag-runs'))).toBe('[]')
})

test('a queued batch run the backend no longer knows ends with a plain message, never a guess', async ({ page }) => {
  let phase: QueuePhase = 'waiting'
  const stub = await stubQueuedRun(page, () => phase, '1girl, never_written')
  await startQueued(page)

  // the page goes away; when it comes back the backend has forgotten place q9 (it restarted)
  await page.goto('/api/libraries', { waitUntil: 'domcontentloaded' })
  phase = 'gone'
  await openTagStep(page)
  await expect(page.getByTestId('tag-report-state')).toHaveText(
    "We couldn't find how this run ended (the app may have restarted since), so the folder images' results were not written. Run the step again.",
    { timeout: 15_000 },
  )
  expect(await page.evaluate(() => localStorage.getItem('sd-v4-dataset-tag-runs'))).toBe('[]')
  expect(stub.results()).toBe(0)
  await expectFolderCaptions(page, '1girl, away_tag')
  // the step can run again at once
  await expect(page.getByTestId('tag-start')).toBeEnabled()
})

test('a Smart Tag run started elsewhere (V3.5) joins the Jobs drawer and ends there', async ({ page }) => {
  await stubAi(page, 'none')
  let over = false
  await page.route('**/api/smart-tag/progress**', (route) =>
    route.fulfill({
      json: {
        job_id: 'v35-run', active: !over, status: over ? 'completed' : 'running', total: 12, processed: over ? 12 : 5,
        succeeded: over ? 12 : 5, failed: 0, errors: [], settings: { enable_wd14: false }, pipeline_queue: { total_queued: 0, queued: [] },
      },
    }),
  )
  await page.setViewportSize({ width: 1366, height: 768 })
  await openV4(page, '#/library')
  await page.getByTestId('jobs-button').click()
  const job = page.getByTestId('jobs-drawer').getByTestId('job').first()
  // it only describes (the tagger was off), and the drawer says so
  await expect(job).toContainText('Describing 12')
  over = true
  await expect(job).toContainText('Described 12', { timeout: 15_000 })
})

test('new thresholds from the stored scores: a dry run says what changes, then the Library tags change', async ({ page }) => {
  await stubAi(page, 'none')
  await page.setViewportSize({ width: 1366, height: 768 })
  await openTagStep(page)
  const panel = page.getByTestId('rethreshold')
  await expect(panel).toBeVisible()
  await expect(page.getByTestId('re-model')).toHaveValue(MODEL)
  // at the tagger's own threshold nothing changes
  await expect(page.getByTestId('re-report')).toContainText('Would change 0 images')
  await expect(page.getByTestId('re-report')).toContainText('Does not apply to folder images (2).')
  await expect(page.getByTestId('re-apply')).toBeDisabled()

  await page.getByTestId('re-threshold').evaluate((el: HTMLInputElement) => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    set?.call(el, '0.25')
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await expect(panel).toContainText('Threshold 0.25')
  await expect(page.getByTestId('re-report')).toContainText('Would change 1 image: 1 tag added, 0 removed.')
  expect(libraryTags(ids[0])).not.toContain('outdoors')

  await page.getByTestId('re-apply').click()
  await expect(page.getByRole('status')).toContainText('Updated 1 image: 1 tag added, 0 removed.')
  expect(libraryTags(ids[0])).toContain('outdoors')
})

for (const viewport of VIEWPORTS) {
  test(`the tag step fits at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await stubAi(page, 'configured')
    await page.setViewportSize(viewport)
    await openTagStep(page)
    await expect(page.getByTestId('tag-total')).toBeVisible()
    for (const id of ['tag-model', 'tag-describer', 'tag-start']) {
      await expect(page.getByTestId(id)).toBeInViewport()
    }
    // 高级设置 open (the copyright threshold and noise switch show) keeps Start in reach
    const advanced = page.getByTestId('tag-advanced')
    if ((await advanced.getAttribute('open')) === null) await advanced.locator('summary').click()
    await expect(page.getByTestId('tag-strip-noise')).toBeVisible()
    await expect(page.getByTestId('tag-start')).toBeInViewport()
    await page.screenshot({ path: `test-results/v4-dataset-tag-options-${viewport.width}.png` })
    expect(await pageOverflow(page)).toBeLessThanOrEqual(0)
    const scroller = page.getByTestId('tag-step')
    expect(await scroller.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0)
    expect(fsSync.existsSync(folderFiles[0]!), 'folder images stay on disk').toBe(true)
  })
}
