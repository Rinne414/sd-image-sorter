import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'

import { cleanupImages, dbPath, pageOverflow, runBackendScript, seedImages, tmpRoot, VIEWPORTS } from '../fixtures/v4-seed'

/**
 * V4 dataset check step (slice 3g1): one list of issues from every check.
 * A 200px image, a duplicate pair, an empty caption and a folder image whose
 * file changed after it was added are all listed; each can be taken out of
 * the batch (never out of the Library or off the disk); the changed file can
 * be re-added as it is now; "open" and "pick" lead into the edit step;
 * character purity (CCIP) downloads its model, runs as jobs and names the
 * outlier. CCIP is stubbed (no model is downloaded or run); everything else
 * (review queue, audit with perceptual hashes, health, export-preview) runs for real.
 *
 * Needs the V4 build: `cd frontend-v4 && npm ci && npm run build`.
 */

test.describe.configure({ mode: 'serial' })

const TOKEN = 'v4chktoken'
const PREFIX = 'v4chk-'
const DIR = 'v4-chk'
const FOLDER_DIR = 'v4-chk-folder'
const NAME = 'v4chk'
const TRIGGER = 'chkchar'
const folderFile = path.join(tmpRoot, FOLDER_DIR, 'local-a.png')

let ids: number[] = []
let batchId = 0
let projectId = 0

const py = JSON.stringify

/**
 * Four Library images with textured pictures (flat colours would all hash
 * alike): 0 and 1 identical (a duplicate pair), 2 is 200px, 3 has no tags
 * (an empty caption); and a folder image with its own caption file.
 */
function seedRows(): void {
  const out = runBackendScript(`
import random, sqlite3
from pathlib import Path
from PIL import Image

def picture(seed, size):
    rnd = random.Random(seed)
    img = Image.new("RGB", (16, 16))
    img.putdata([(rnd.randrange(256), rnd.randrange(256), rnd.randrange(256)) for _ in range(256)])
    return img.resize(size, Image.NEAREST)

folder = Path(${py(folderFile)}).parent
folder.mkdir(parents=True, exist_ok=True)
picture(9, (600, 600)).save(${py(folderFile)})
Path(${py(folderFile)}).with_suffix(".txt").write_text("1girl, forest", encoding="utf-8")
plan = [(1, (600, 600)), (1, (600, 600)), (2, (200, 200)), (3, (600, 600))]
with sqlite3.connect(${py(dbPath)}) as conn:
    rows = conn.execute("SELECT id, path FROM images WHERE filename LIKE ? ORDER BY filename", (${py(PREFIX + '%')},)).fetchall()
    for (image_id, image_path), (seed, size) in zip(rows, plan):
        picture(seed, size).save(image_path)
        st = Path(image_path).stat()
        conn.execute(
            "UPDATE images SET width = ?, height = ?, file_size = ?, source_size = ?, source_mtime_ns = ?, aesthetic_score = NULL WHERE id = ?",
            (size[0], size[1], st.st_size, st.st_size, st.st_mtime_ns, image_id),
        )
        conn.execute("DELETE FROM tags WHERE image_id = ?", (image_id,))
    for image_id, _ in rows[:3]:
        for tag, conf in (("1girl", 0.95), ("silver_hair", 0.9), ("smile", 0.8)):
            conn.execute("INSERT INTO tags (image_id, tag, confidence) VALUES (?, ?, ?)", (image_id, tag, conf))
    conn.commit()
print(",".join(str(r[0]) for r in rows))
`)
  ids = out.split(/\s+/).at(-1)!.split(',').map(Number)
}

/** The folder image's file replaced by another picture (a new size and time). */
function changeFolderFile(seed: number): void {
  runBackendScript(`
import random, time
from PIL import Image
rnd = random.Random(${seed})
img = Image.new("RGB", (16, 16))
img.putdata([(rnd.randrange(256), rnd.randrange(256), rnd.randrange(256)) for _ in range(256)])
time.sleep(0.05)
img.resize((640 + ${seed}, 600), Image.NEAREST).save(${py(folderFile)})
print("ok")
`)
}

function cleanupRows(): void {
  runBackendScript(`
import sqlite3
with sqlite3.connect(${py(dbPath)}) as conn:
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("DELETE FROM batches WHERE name LIKE ?", (${py(NAME + '%')},))
    conn.execute("DELETE FROM dataset_projects WHERE name LIKE ?", (${py(NAME + '%')},))
    conn.execute("DELETE FROM tags WHERE image_id IN (SELECT id FROM images WHERE filename LIKE ?)", (${py(PREFIX + '%')},))
    conn.commit()
print("ok")
`)
}

function libraryCount(): number {
  const out = runBackendScript(`
import sqlite3
with sqlite3.connect(${py(dbPath)}) as conn:
    print(conn.execute("SELECT COUNT(*) FROM images WHERE filename LIKE ? AND filename NOT LIKE '%sentinel%'", (${py(PREFIX + '%')},)).fetchone()[0])
`)
  return Number(out.split(/\s+/).at(-1))
}

test.beforeAll(() => {
  seedImages({ prefix: PREFIX, token: TOKEN, count: 4, dir: DIR })
  cleanupRows()
  seedRows()
})

test.afterAll(() => {
  cleanupRows()
  cleanupImages(PREFIX, [DIR, FOLDER_DIR])
})

async function openV4(page: Page, hash: string, theme: 'dark' | 'light' = 'dark'): Promise<void> {
  await page.addInitScript((th) => {
    const flag = 'v4e2e-init-chk-' + th
    if (sessionStorage.getItem(flag)) return
    sessionStorage.setItem(flag, '1')
    localStorage.setItem('sd-image-sorter-lang', 'en')
    localStorage.setItem('sd-v4-theme', th)
    localStorage.removeItem('sd-v4-dataset-check')
  }, theme)
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

interface ProjectItem {
  item_type: 'library' | 'local'
  source_image_id?: number
  path?: string
  source_status?: string
}

interface Project {
  id: number
  name: string
  revision: number
  items: ProjectItem[]
  settings: { caption_render: Record<string, unknown> } & Record<string, unknown>
}

const project = async (page: Page) => (await apiJson<Project>(page, `/api/dataset/projects/${projectId}`)).body
const libraryIn = async (page: Page) => (await project(page)).items.filter((i) => i.item_type === 'library').map((i) => i.source_image_id)
const localIn = async (page: Page) => (await project(page)).items.filter((i) => i.item_type === 'local')

const issue = (page: Page, kind: string) => page.locator(`[data-testid="check-issue"][data-kind="${kind}"]`)
const thumbKeys = async (page: Page, kind: string) => issue(page, kind).getByTestId('check-thumb').evaluateAll((els) => els.map((e) => e.getAttribute('data-key')))

async function openCheck(page: Page, theme: 'dark' | 'light' = 'dark'): Promise<void> {
  await openV4(page, `#/batch/${batchId}`, theme)
  await page.locator('[data-testid="rail-step"][data-step-id="check"]').click()
  await expect(page.getByTestId('check-step')).toBeVisible()
}

/** CCIP answered here: the model is "downloaded" on first use, the analysis names image 2. */
async function stubPurity(page: Page): Promise<string[]> {
  const calls: string[] = []
  let ready = false
  await page.route('**/api/dataset/character-purity/**', async (route) => {
    const url = route.request().url()
    calls.push(url.replace(/^.*character-purity/, ''))
    if (url.includes('/status')) {
      return route.fulfill({ json: { available: ready, preparing: false, prepare_error: null, default_threshold: 0.178, missing_files: ready ? [] : ['ccip.onnx'], download: { active: false } } })
    }
    if (url.includes('/prepare')) {
      ready = true
      return route.fulfill({ json: { status: 'started' } })
    }
    const result = {
      medoid_image_id: ids[0],
      threshold: 0.178,
      extracted: 4,
      failed: 0,
      items: [
        { image_id: ids[2], distance: 0.52, outlier: true },
        { image_id: ids[1], distance: 0.01, outlier: false },
        { image_id: ids[0], distance: 0, outlier: false },
        { image_id: ids[3], distance: 0.1, outlier: false },
      ],
    }
    return route.fulfill({ json: { status: 'done', job_id: 'e2e-ccip', current: 4, total: 4, extracted: 4, failed: 0, result, message: '' } })
  })
  await page.route('**/api/dataset/character-purity', (route) => {
    calls.push('start')
    return route.fulfill({ json: { status: 'starting', job_id: 'e2e-ccip', total: 4, message: '' } })
  })
  return calls
}

test('a dataset batch: four Library images, a folder image, a trigger; then the folder file changes', async ({ page }) => {
  await openV4(page, '#/batch')
  const made = await apiJson<{ batch: { id: number; dataset_project_id: number } }>(page, '/api/batches', {
    method: 'POST',
    body: { kind: 'dataset', name: `${NAME} set`, image_ids: ids },
  })
  expect(made.status).toBe(201)
  batchId = made.body.batch.id
  projectId = made.body.batch.dataset_project_id

  const scan = await apiJson(page, '/api/dataset/folder-scan', {
    method: 'POST',
    body: { folder_path: path.dirname(folderFile), recursive: false, include_thumbnails: false, limit: 10, offset: 0 },
  })
  expect(scan.status).toBe(200)
  const p = await project(page)
  const items = [...ids.map((id) => ({ item_type: 'library', image_id: id, keep_as_saved: true })), { item_type: 'local', path: folderFile, keep_as_saved: false }]
  const settings = { ...p.settings, caption_render: { ...p.settings.caption_render, trigger: TRIGGER } }
  const put = await apiJson(page, `/api/dataset/projects/${projectId}`, { method: 'PUT', body: { expected_revision: p.revision, name: p.name, items, settings } })
  expect(put.status).toBe(200)

  changeFolderFile(10)
  expect((await localIn(page))[0]?.source_status).toBe('changed')
})

test('every issue is listed: small, duplicates, empty caption, changed file; CCIP names the outlier; no overflow', async ({ page }) => {
  const calls = await stubPurity(page)
  const refused: string[] = []
  page.on('response', (res) => res.url().includes('/api/') && res.status() >= 400 && refused.push(`${res.status()} ${res.url()}`))
  await page.setViewportSize({ width: 1366, height: 768 })
  await openCheck(page)

  await expect(issue(page, 'small')).toBeVisible({ timeout: 20_000 })
  expect(await thumbKeys(page, 'small')).toEqual([`lib:${ids[2]}`])
  await expect(issue(page, 'duplicates')).toBeVisible({ timeout: 20_000 })
  expect(await thumbKeys(page, 'duplicates')).toEqual([`lib:${ids[0]}`, `lib:${ids[1]}`])
  await expect(issue(page, 'empty_caption')).toBeVisible()
  expect(await thumbKeys(page, 'empty_caption')).toEqual([`lib:${ids[3]}`])
  await expect(issue(page, 'file_changed')).toBeVisible()
  expect(await thumbKeys(page, 'file_changed')).toHaveLength(1)
  await expect(issue(page, 'file_changed')).toHaveAttribute('data-severity', 'high')
  // every source answered, and the export preview never refused (the changed file is left out of it)
  await expect(page.locator('[data-testid="check-source"][data-status="checking"]')).toHaveCount(0, { timeout: 20_000 })
  await expect(page.locator('[data-testid="check-source"][data-status="failed"]')).toHaveCount(0)
  expect(refused).toEqual([])

  // a tag that always goes with another: where it is, what rides along, which taggers said it
  await issue(page, 'cooccur').getByTestId('check-pair').first().getByRole('button').first().click()
  await expect(page.getByTestId('check-tag-detail')).toContainText('in 3 captions')
  await expect(page.getByTestId('check-tag-audit')).toContainText('No scores saved')

  // character purity: the model downloads first (a job), then the analysis (a job) names image 2
  await page.getByTestId('check-purity-run').click()
  await expect(issue(page, 'character_outlier')).toBeVisible({ timeout: 15_000 })
  expect(await thumbKeys(page, 'character_outlier')).toEqual([`lib:${ids[2]}`])
  await expect(page.getByTestId('check-purity-result')).toContainText('1 look like another character')
  expect(calls[0]).toBe('/status')
  expect(calls).toContain('/prepare')
  expect(calls.indexOf('start')).toBeGreaterThan(calls.indexOf('/prepare'))

  for (const vp of VIEWPORTS) {
    await page.setViewportSize(vp)
    await expect.poll(() => pageOverflow(page)).toBeLessThanOrEqual(0)
    await expect(page.getByTestId('check-again')).toBeInViewport()
    await expect(issue(page, 'file_changed').getByTestId('check-remove')).toBeVisible()
  }
})

test('an empty or broken audit answer says the check failed and offers Try again, instead of breaking the step', async ({ page }) => {
  await stubPurity(page)
  const pageErrors: string[] = []
  page.on('pageerror', (e) => pageErrors.push(String(e)))
  // first an empty 204, then {} (no image list; the app asks once more by itself), then the real audit
  let audits = 0
  await page.route('**/api/dataset/audit', (route) => {
    audits += 1
    if (audits === 1) return route.fulfill({ status: 204, body: '' })
    if (audits === 2) return route.fulfill({ json: {} })
    return route.continue()
  })
  await page.setViewportSize({ width: 1366, height: 768 })
  await openCheck(page)
  const audit = page.locator('[data-testid="check-source"][data-source="audit"]')
  await expect(audit).toHaveAttribute('data-status', 'failed', { timeout: 20_000 })
  await expect(audit).toContainText('incomplete')
  await expect(page.getByTestId('check-step')).toBeVisible()
  expect(audits).toBe(2)
  await audit.getByRole('button', { name: 'Try again' }).click()
  await expect(audit).toHaveAttribute('data-status', 'done', { timeout: 20_000 })
  expect(audits).toBe(3)
  await expect(issue(page, 'small')).toBeVisible()
  expect(pageErrors).toEqual([])
})

test('open and pick lead into the edit step with those images', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await openCheck(page)
  await issue(page, 'empty_caption').getByTestId('check-open').click()
  await expect(page.getByTestId('edit-step')).toBeVisible()
  await expect(page.getByTestId('edit-panel')).toHaveAttribute('data-key', `lib:${ids[3]}`)

  await page.locator('[data-testid="rail-step"][data-step-id="check"]').click()
  await issue(page, 'duplicates').getByTestId('check-pick').click()
  await expect(page.getByTestId('edit-step')).toBeVisible()
  await expect(page.getByTestId('edit-mode-bulk')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('[data-testid="edit-item"][aria-pressed="true"]')).toHaveCount(2)
})

test('each is removable; a changed file can be re-added as it is now; the Library keeps every image', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await openCheck(page)
  await expect(issue(page, 'file_changed')).toBeVisible({ timeout: 20_000 })

  // re-added: the project takes the file as it is now, the issue goes
  await issue(page, 'file_changed').getByTestId('check-readd').click()
  await expect(issue(page, 'file_changed')).toHaveCount(0)
  await expect.poll(async () => (await localIn(page))[0]?.source_status).toBe('available')
  // the re-added file was not part of the last size / near-duplicate check, and the page says so
  await expect(page.getByTestId('check-unchecked')).toContainText('1 images were added after the last check')

  // changed again: "Check again" reads the project again and lists it; this time it is taken out
  changeFolderFile(11)
  await page.getByTestId('check-again').click()
  await expect(issue(page, 'file_changed')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByTestId('check-unchecked')).toHaveCount(0)
  await issue(page, 'file_changed').getByTestId('check-remove').click()
  await expect(issue(page, 'file_changed')).toHaveCount(0)
  await expect.poll(async () => (await localIn(page)).length).toBe(0)

  await expect(issue(page, 'small')).toBeVisible({ timeout: 20_000 })
  await issue(page, 'small').getByTestId('check-remove').click()
  await expect(issue(page, 'small')).toHaveCount(0)

  await issue(page, 'duplicates').getByTestId('check-keep-first').click()
  await expect(issue(page, 'duplicates')).toHaveCount(0)

  await issue(page, 'empty_caption').getByTestId('check-remove').click()
  await expect(issue(page, 'empty_caption')).toHaveCount(0)

  await expect.poll(() => libraryIn(page)).toEqual([ids[0]])
  expect(libraryCount(), 'taking images out of a batch never removes them from the Library').toBe(4)
})
