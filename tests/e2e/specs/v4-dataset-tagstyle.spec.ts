import fs from 'node:fs'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'

import { cleanupImages, dbPath, runBackendScript, seedImages, tmpRoot } from '../fixtures/v4-seed'

/**
 * V4 dataset tag spelling (slice 3h follow-up): a batch template writes
 * `blue_sky` as `blue sky` (its underscore option, on by default). Tags added
 * in the caption editor are written the same way, so the exported caption
 * never mixes the two; captions already mixed are listed by the check step
 * and fixed by "write tags one way" (bulk panel or check step), one undoable
 * change. Emoticon tags keep their glyphs. The export runs for real.
 *
 * Needs the V4 build: `cd frontend-v4 && npm ci && npm run build`.
 */

test.describe.configure({ mode: 'serial' })

const TOKEN = 'v4tstoken'
const PREFIX = 'v4ts-'
const DIR = 'v4-ts'
const NAME = 'v4ts'
const OUT = path.join(tmpRoot, 'v4-ts-out')

let ids: number[] = []
let batchId = 0
let projectId = 0

const py = JSON.stringify

function seedTags(): void {
  const out = runBackendScript(`
import sqlite3
from pathlib import Path
Path(${py(OUT)}).mkdir(parents=True, exist_ok=True)
with sqlite3.connect(${py(dbPath)}) as conn:
    rows = conn.execute("SELECT id FROM images WHERE filename LIKE ? AND filename NOT LIKE '%sentinel%' ORDER BY filename", (${py(PREFIX + '%')},)).fetchall()
    for (image_id,) in rows:
        conn.execute("DELETE FROM tags WHERE image_id = ?", (image_id,))
        for tag in ("1girl", "silver_hair", "smile"):
            conn.execute("INSERT INTO tags (image_id, tag, confidence) VALUES (?, ?, 0.9)", (image_id, tag))
    conn.commit()
print(",".join(str(r[0]) for r in rows))
`)
  ids = out.split(/\s+/).at(-1)!.split(',').map(Number)
}

function cleanupRows(): void {
  runBackendScript(`
import shutil, sqlite3
from pathlib import Path
with sqlite3.connect(${py(dbPath)}) as conn:
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("DELETE FROM batches WHERE name LIKE ?", (${py(NAME + '%')},))
    conn.execute("DELETE FROM dataset_projects WHERE name LIKE ?", (${py(NAME + '%')},))
    conn.execute("DELETE FROM tags WHERE image_id IN (SELECT id FROM images WHERE filename LIKE ?)", (${py(PREFIX + '%')},))
    conn.commit()
shutil.rmtree(Path(${py(OUT)}), ignore_errors=True)
print("ok")
`)
}

test.beforeAll(() => {
  seedImages({ prefix: PREFIX, token: TOKEN, count: 3, dir: DIR })
  cleanupRows()
  seedTags()
})

test.afterAll(() => {
  cleanupRows()
  cleanupImages(PREFIX, [DIR])
})

async function openV4(page: Page, hash: string): Promise<void> {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('v4e2e-init-ts')) return
    sessionStorage.setItem('v4e2e-init-ts', '1')
    localStorage.setItem('sd-image-sorter-lang', 'en')
    localStorage.setItem('sd-v4-theme', 'dark')
  })
  await page.goto(`/v4/${hash}`, { waitUntil: 'domcontentloaded' })
}

async function apiJson<T>(page: Page, url: string, init?: { method: string; body?: unknown }): Promise<{ status: number; body: T }> {
  return page.evaluate(
    async ({ u, i }) => {
      const res = await fetch(u, { method: i?.method ?? 'GET', headers: { 'Content-Type': 'application/json' }, body: i?.body === undefined ? undefined : JSON.stringify(i.body) })
      return { status: res.status, body: await res.json() }
    },
    { u: url, i: init },
  ) as Promise<{ status: number; body: T }>
}

interface Project {
  revision: number
  name: string
  settings: { caption_render: Record<string, unknown> } & Record<string, unknown>
}

/** Each Library image's own caption (tags part), by id. */
async function captions(page: Page): Promise<Record<number, string>> {
  const p = (await apiJson<Project>(page, `/api/dataset/projects/${projectId}`)).body
  const heads = await apiJson<{ items: { item: { image_id?: number }; active_revision: { content: { booru_caption: string } } | null }[] }>(
    page,
    `/api/annotations/projects/${projectId}/training-captions/heads?expected_project_revision=${p.revision}&limit=200`,
  )
  return Object.fromEntries(heads.body.items.filter((h) => h.item.image_id && h.active_revision).map((h) => [h.item.image_id, h.active_revision!.content.booru_caption]))
}

async function writeCaption(page: Page, imageId: number, booru: string): Promise<void> {
  const p = (await apiJson<Project>(page, `/api/dataset/projects/${projectId}`)).body
  const res = await apiJson(page, `/api/annotations/projects/${projectId}/training-captions/revisions`, {
    method: 'POST',
    body: { expected_project_revision: p.revision, expected_head_generation: 0, subject: { item_type: 'library', image_id: imageId }, content: { content_version: 1, booru_caption: booru, nl_caption: '', caption_type: 'booru' } },
  })
  expect(res.status).toBe(201)
}

const styleIssue = (page: Page) => page.locator('[data-testid="check-issue"][data-kind="tag_style"]')

async function openStep(page: Page, step: string, ready: string): Promise<void> {
  await openV4(page, `#/batch/${batchId}`)
  await page.locator(`[data-testid="rail-step"][data-step-id="${step}"]`).click()
  await expect(page.getByTestId(ready)).toBeVisible()
}

test('a dataset batch with two captions written the other way (one with an emoticon)', async ({ page }) => {
  await openV4(page, '#/batch')
  const made = await apiJson<{ batch: { id: number; dataset_project_id: number } }>(page, '/api/batches', { method: 'POST', body: { kind: 'dataset', name: `${NAME} set`, image_ids: ids } })
  expect(made.status).toBe(201)
  batchId = made.body.batch.id
  projectId = made.body.batch.dataset_project_id
  const p = (await apiJson<Project>(page, `/api/dataset/projects/${projectId}`)).body
  const settings = { ...p.settings, caption_render: { ...p.settings.caption_render, trigger: 'tschar' } }
  const items = ids.map((id) => ({ item_type: 'library', image_id: id, keep_as_saved: true }))
  expect((await apiJson(page, `/api/dataset/projects/${projectId}`, { method: 'PUT', body: { expected_revision: p.revision, name: p.name, items, settings } })).status).toBe(200)
  await writeCaption(page, ids[0]!, 'blue_sky, 1girl')
  await writeCaption(page, ids[2]!, 'hair_ribbon, solo, ^_^')
})

test('a tag added in the editor is written with spaces, and the exported caption has it so', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await openStep(page, 'edit', 'edit-step')
  await page.getByTestId('edit-list').locator(`[data-key="lib:${ids[1]}"]`).click()
  await expect(page.getByTestId('edit-panel')).toHaveAttribute('data-key', `lib:${ids[1]}`)
  await page.getByTestId('edit-tag-input').fill('red_ribbon')
  await page.getByTestId('edit-tag-input').press('Enter')
  await expect(page.locator('[data-testid="edit-chip"][data-tag="red ribbon"]')).toBeVisible()
  await expect(page.getByTestId('edit-save-state')).toHaveText('Saved', { timeout: 10_000 })
  await expect.poll(async () => (await captions(page))[ids[1]!]).toContain('red ribbon')
  expect((await captions(page))[ids[1]!]).not.toContain('red_ribbon')

  await page.locator('[data-testid="rail-step"][data-step-id="export"]').click()
  await page.getByTestId('ds-format-folder').check()
  await page.getByTestId('ds-export-choose-folder').click()
  const picker = page.getByTestId('ds-export-folder-picker')
  await picker.getByTestId('folder-path').fill(OUT)
  await picker.getByTestId('folder-path').press('Enter')
  await picker.getByRole('button', { name: 'Use this folder' }).click()
  await page.getByTestId('ds-export-run').click()
  await expect(page.getByTestId('ds-export-result')).toHaveAttribute('data-status', 'ok', { timeout: 60_000 })
  const txt = fs.readFileSync(path.join(OUT, `${PREFIX}01.txt`), 'utf8')
  expect(txt.startsWith('tschar, ')).toBe(true)
  expect(txt).toContain('red ribbon')
  expect(txt).not.toContain('_')
})

test('the check lists the captions written the other way; the bulk panel writes them one way and undoes it in one step', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await openStep(page, 'check', 'check-step')
  await expect(styleIssue(page)).toBeVisible({ timeout: 20_000 })
  expect(await styleIssue(page).getByTestId('check-thumb').evaluateAll((els) => els.map((e) => e.getAttribute('data-key')))).toEqual([`lib:${ids[0]}`, `lib:${ids[2]}`])

  await page.locator('[data-testid="rail-step"][data-step-id="edit"]').click()
  await page.getByTestId('edit-mode-bulk').click()
  // the frequency table shows the emoticon as it is written, not as "^ ^"
  await expect(page.locator('[data-testid="freq-row"][data-tag="^_^"]')).toContainText('^_^')
  const unify = page.getByTestId('bulk-unify-style')
  await expect(unify).toHaveText('Write tags one way (2 captions)')
  await unify.click()
  await expect.poll(async () => (await captions(page))[ids[0]!]).toBe('blue sky, 1girl')
  // the emoticon keeps its glyphs
  expect((await captions(page))[ids[2]!]).toBe('hair ribbon, solo, ^_^')
  await expect(unify).toHaveText('Nothing to change')

  await page.getByTestId('bulk-undo').click()
  await expect.poll(async () => (await captions(page))[ids[0]!]).toBe('blue_sky, 1girl')
  expect((await captions(page))[ids[2]!]).toBe('hair_ribbon, solo, ^_^')
})

test('the check step fixes them too, and the issue goes', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await openStep(page, 'check', 'check-step')
  await expect(styleIssue(page)).toBeVisible({ timeout: 20_000 })
  await styleIssue(page).getByTestId('check-unify-style').click()
  await expect(styleIssue(page)).toHaveCount(0, { timeout: 20_000 })
  const now = await captions(page)
  expect(now[ids[0]!]).toBe('blue sky, 1girl')
  expect(now[ids[2]!]).toBe('hair ribbon, solo, ^_^')
})
