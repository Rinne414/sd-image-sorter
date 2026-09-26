import fs from 'node:fs'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'

import { cleanupImages, dbPath, pageOverflow, runBackendScript, seedImages, tmpRoot, VIEWPORTS } from '../fixtures/v4-seed'

/**
 * V4 dataset export (slice 3h): one form, one "check and export" job, a real
 * export into .tmp. Four Library images (one with a hand-edited caption) and
 * two folder images, one of which changed after it was added: that one is
 * listed and left out (the backend would refuse the whole request for it),
 * the other five are written as kohya pairs with dataset_config.toml. Then a
 * plain-folder export with the _nl.txt twin and implication dedup. Nothing is
 * stubbed: the backend's check (Readiness) and export run for real.
 *
 * Needs the V4 build: `cd frontend-v4 && npm ci && npm run build`.
 */

test.describe.configure({ mode: 'serial' })

const TOKEN = 'v4dsxtoken'
const PREFIX = 'v4dsx-'
const DIR = 'v4-dsx'
const FOLDER_DIR = 'v4-dsx-folder'
const NAME = 'v4dsx'
const TRIGGER = 'dsxchar'
const OUT = path.join(tmpRoot, 'v4-dsx-out', 'kohya')
const OUT2 = path.join(tmpRoot, 'v4-dsx-out', 'plain')
const folderA = path.join(tmpRoot, FOLDER_DIR, 'local-a.png')
const folderB = path.join(tmpRoot, FOLDER_DIR, 'local-b.png')
const EDITED = 'edited by hand, blue sky'

let ids: number[] = []
let batchId = 0
let projectId = 0

const py = JSON.stringify

function seedRows(): void {
  const out = runBackendScript(`
import sqlite3
from pathlib import Path
from PIL import Image

folder = Path(${py(folderA)}).parent
folder.mkdir(parents=True, exist_ok=True)
# Empty output folders the user picks (the chooser opens existing folders).
for out in (${py(OUT)}, ${py(OUT2)}):
    Path(out).mkdir(parents=True, exist_ok=True)
for name, color in ((${py(folderA)}, (200, 40, 40)), (${py(folderB)}, (40, 200, 40))):
    Image.new("RGB", (96, 96), color).save(name)
    Path(name).with_suffix(".txt").write_text("1girl, forest", encoding="utf-8")
with sqlite3.connect(${py(dbPath)}) as conn:
    rows = conn.execute("SELECT id FROM images WHERE filename LIKE ? AND filename NOT LIKE '%sentinel%' ORDER BY filename", (${py(PREFIX + '%')},)).fetchall()
    for (image_id,) in rows:
        conn.execute("DELETE FROM tags WHERE image_id = ?", (image_id,))
        for tag in ("1girl", "silver_hair", "cat_ears", "animal_ears"):
            conn.execute("INSERT INTO tags (image_id, tag, confidence) VALUES (?, ?, 0.9)", (image_id, tag))
    conn.execute("UPDATE images SET nl_caption = 'A girl smiles.' WHERE id = ?", (rows[0][0],))
    conn.commit()
print(",".join(str(r[0]) for r in rows))
`)
  ids = out.split(/\s+/).at(-1)!.split(',').map(Number)
}

function changeFolderB(): void {
  runBackendScript(`
import time
from PIL import Image
time.sleep(0.05)
Image.new("RGB", (120, 96), (10, 10, 200)).save(${py(folderB)})
print("ok")
`)
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
shutil.rmtree(Path(${py(path.dirname(OUT))}), ignore_errors=True)
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
    const flag = 'v4e2e-init-dsx-' + th
    if (sessionStorage.getItem(flag)) return
    sessionStorage.setItem(flag, '1')
    localStorage.setItem('sd-image-sorter-lang', 'en')
    localStorage.setItem('sd-v4-theme', th)
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

interface Project {
  id: number
  name: string
  revision: number
  items: { item_type: string; source_image_id?: number; path?: string; source_status?: string }[]
  settings: { caption_render: Record<string, unknown> } & Record<string, unknown>
}

async function openExport(page: Page, theme: 'dark' | 'light' = 'dark'): Promise<void> {
  await openV4(page, `#/batch/${batchId}`, theme)
  await page.locator('[data-testid="rail-step"][data-step-id="export"]').click()
  await expect(page.getByTestId('ds-export-step')).toBeVisible()
}

async function chooseFolder(page: Page, folder: string): Promise<void> {
  await page.getByTestId('ds-export-choose-folder').click()
  const chooser = page.getByTestId('ds-export-folder-picker')
  const input = chooser.getByTestId('folder-path')
  await input.fill(folder)
  await input.press('Enter')
  await expect(input).toHaveValue(folder)
  await chooser.getByRole('button', { name: 'Use this folder' }).click()
  await expect(chooser).toHaveCount(0)
  await expect(page.getByTestId('ds-export-folder')).toHaveText(folder)
}

/** What landed in a folder: file names, and each caption's text. */
function readOut(folder: string): { files: string[]; text: Record<string, string> } {
  const files = fs.readdirSync(folder).sort()
  const text: Record<string, string> = {}
  for (const f of files) if (f.endsWith('.txt') || f.endsWith('.toml')) text[f] = fs.readFileSync(path.join(folder, f), 'utf8')
  return { files, text }
}

test('a dataset batch: four Library images (one caption edited), two folder images, a trigger', async ({ page }) => {
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
    body: { folder_path: path.dirname(folderA), recursive: false, include_thumbnails: false, limit: 10, offset: 0 },
  })
  expect(scan.status).toBe(200)
  const p = (await apiJson<Project>(page, `/api/dataset/projects/${projectId}`)).body
  const items = [
    ...ids.map((id) => ({ item_type: 'library', image_id: id, keep_as_saved: true })),
    { item_type: 'local', path: folderA, keep_as_saved: false },
    { item_type: 'local', path: folderB, keep_as_saved: false },
  ]
  const settings = { ...p.settings, caption_render: { ...p.settings.caption_render, trigger: TRIGGER } }
  const put = await apiJson<Project>(page, `/api/dataset/projects/${projectId}`, { method: 'PUT', body: { expected_revision: p.revision, name: p.name, items, settings } })
  expect(put.status).toBe(200)

  const edited = await apiJson(page, `/api/annotations/projects/${projectId}/training-captions/revisions`, {
    method: 'POST',
    body: {
      expected_project_revision: put.body.revision,
      expected_head_generation: 0,
      subject: { item_type: 'library', image_id: ids[1] },
      content: { content_version: 1, booru_caption: EDITED, nl_caption: '', caption_type: 'booru' },
    },
  })
  expect(edited.status).toBe(201)

  changeFolderB()
  const now = (await apiJson<Project>(page, `/api/dataset/projects/${projectId}`)).body
  expect(now.items.filter((i) => i.item_type === 'local').map((i) => i.source_status)).toEqual(['available', 'changed'])
})

test('kohya: the changed file is listed and left out, five pairs and dataset_config.toml are written', async ({ page }) => {
  const refused: string[] = []
  page.on('response', (res) => res.url().includes('/api/') && res.status() >= 400 && refused.push(`${res.status()} ${res.url()}`))
  await page.setViewportSize({ width: 1366, height: 768 })
  await openExport(page)

  await expect(page.getByTestId('ds-format-kohya')).toBeChecked()
  const leftOut = page.getByTestId('ds-left-out')
  await expect(leftOut).toContainText('local-b.png')
  await expect(leftOut.locator('li[data-reason="changed"]')).toHaveCount(1)
  await expect(page.getByTestId('ds-count-send')).toHaveText('5')
  await expect(page.getByTestId('ds-count-left')).toHaveText('1')
  await expect(page.getByTestId('ds-count-edited')).toHaveText('1')
  // kohya sets are checked file by file: the _nl.txt twin and crops say why they are off
  await expect(page.getByTestId('ds-nl-on')).toBeDisabled()
  await expect(page.getByTestId('ds-nl-why')).toContainText('Plain folder')
  await expect(page.getByTestId('ds-crop-why')).toBeVisible()
  await expect(page.getByTestId('ds-problem')).toHaveAttribute('data-problem', 'noFolder')
  await expect(page.getByTestId('ds-export-run')).toBeDisabled()

  await chooseFolder(page, OUT)
  await page.getByTestId('ds-naming-renumber').check()
  await page.getByTestId('ds-repeats').fill('7')
  await page.getByTestId('ds-keep-trigger').click()
  await expect(page.getByTestId('ds-keep-tokens')).toHaveValue('1')
  await expect(page.getByTestId('ds-writes')).toContainText('repeats 7, keep_tokens 1')
  await expect(page.getByTestId('ds-sample-name')).toContainText(`${TRIGGER}_001.png`)

  for (const vp of VIEWPORTS) {
    await page.setViewportSize(vp)
    await expect.poll(() => pageOverflow(page)).toBeLessThanOrEqual(0)
    await expect(page.getByTestId('ds-export-run')).toBeInViewport()
  }
  await page.setViewportSize({ width: 1366, height: 768 })

  const run = page.getByTestId('ds-export-run')
  await expect(run).toHaveText('Leave out 1, check and export 5')
  await run.click()
  const result = page.getByTestId('ds-export-result')
  await expect(result).toBeVisible({ timeout: 60_000 })
  await expect(result).toHaveAttribute('data-status', 'ok')
  await expect(result.getByTestId('ds-result-row')).toHaveCount(5)
  await expect(result.getByTestId('ds-result-config')).toContainText('dataset_config.toml')
  await expect(result.getByTestId('ds-result-folder')).toHaveText(OUT)
  expect(refused).toEqual([])

  const { files, text } = readOut(OUT)
  const pngs = files.filter((f) => f.endsWith('.png'))
  const txts = files.filter((f) => f.endsWith('.txt'))
  expect(pngs).toHaveLength(5)
  expect(txts.map((f) => f.replace(/\.txt$/, '.png')).sort()).toEqual(pngs)
  expect(pngs.every((f) => f.startsWith(`${TRIGGER}_`))).toBe(true)
  for (const f of txts) expect(text[f]?.split(',')[0]?.trim(), f).toBe(TRIGGER)
  expect(Object.values(text).filter((t) => t.includes(EDITED))).toHaveLength(1)
  expect(Object.values(text).some((t) => t.includes('forest'))).toBe(true)
  const toml = text['dataset_config.toml'] ?? ''
  expect(toml).toContain('num_repeats = 7')
  expect(toml).toContain('keep_tokens = 1')
  expect(toml).toContain('shuffle_caption = true')

  // the drawer has one job for the check and the export together
  await page.getByTestId('jobs-button').click()
  const job = page.getByTestId('jobs-drawer').getByTestId('job').first()
  await expect(job).toHaveAttribute('data-status', 'done')
  await expect(job).toContainText('Exported 5 image and caption pairs')
})

test('V3.5 still opens the project with every item and the edited caption; the Library is unchanged', async ({ page }) => {
  await openV4(page, '#/batch')
  const p = (await apiJson<Project>(page, `/api/dataset/projects/${projectId}`)).body
  expect(p.items).toHaveLength(6)
  expect(p.items.filter((i) => i.item_type === 'library').map((i) => i.source_image_id)).toEqual(ids)
  const heads = await apiJson<{ items: { item: { image_id?: number }; active_revision: { content: { booru_caption: string } } | null }[] }>(
    page,
    `/api/annotations/projects/${projectId}/training-captions/heads?expected_project_revision=${p.revision}&limit=200`,
  )
  expect(heads.status).toBe(200)
  const edited = heads.body.items.find((h) => h.item.image_id === ids[1])
  expect(edited?.active_revision?.content.booru_caption).toBe(EDITED)
  expect(libraryCount()).toBe(4)
})

test('a plain folder with the _nl.txt twin and dropped parent tags; the result opens again from the step', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await openExport(page, 'light')
  // the last result is gone after a reload: the form is back
  await page.getByTestId('ds-format-folder').check()
  await expect(page.getByTestId('ds-format-notes')).toContainText('keep_tokens set back to 0')
  await expect(page.getByTestId('ds-nl-on')).toBeEnabled()
  await page.getByTestId('ds-nl-on').check()
  await page.getByTestId('ds-dedupe-on').check()
  await chooseFolder(page, OUT2)
  await expect(page.getByTestId('ds-writes')).toContainText('5 _nl.txt files')

  await page.getByTestId('ds-export-run').click()
  const result = page.getByTestId('ds-export-result')
  await expect(result).toBeVisible({ timeout: 60_000 })
  await expect(result).toHaveAttribute('data-status', 'ok')
  await expect(result.getByTestId('ds-result-config')).toHaveCount(0)

  const { files, text } = readOut(OUT2)
  expect(files.filter((f) => f.endsWith('.png'))).toHaveLength(5)
  expect(files.filter((f) => f.endsWith('_nl.txt'))).toHaveLength(5)
  expect(files).not.toContain('dataset_config.toml')
  expect(Object.entries(text).filter(([f, t]) => f.endsWith('_nl.txt') && t === `${TRIGGER}, A girl smiles.`)).toHaveLength(1)
  const captions = Object.entries(text).filter(([f]) => !f.endsWith('_nl.txt'))
  const rendered = captions.filter(([, t]) => t.includes('cat ears'))
  expect(rendered.length).toBeGreaterThan(0)
  for (const [f, t] of rendered) expect(t, f).not.toContain('animal ears')

  for (const vp of VIEWPORTS) {
    await page.setViewportSize(vp)
    await expect.poll(() => pageOverflow(page)).toBeLessThanOrEqual(0)
    await expect(result.getByTestId('ds-result-again')).toBeInViewport()
  }
  await result.getByTestId('ds-result-again').click()
  await expect(page.getByTestId('ds-export-form')).toBeVisible()
  await expect(page.getByTestId('ds-format-folder')).toBeChecked()
  await expect(page.getByTestId('ds-nl-on')).toBeChecked()
})

test('an unreadable original stops the check and nothing is written; the user skips it and the rest is exported', async ({ page }) => {
  // the fourth Library image's file is broken on disk (same size class, no picture)
  runBackendScript(`
import sqlite3
from pathlib import Path
with sqlite3.connect(${py(dbPath)}) as conn:
    p = conn.execute("SELECT path FROM images WHERE id = ?", (${ids[3]},)).fetchone()[0]
Path(p).write_bytes(b"not a picture" * 20)
print("ok")
`)
  const out = path.join(path.dirname(OUT), 'skip')
  fs.mkdirSync(out, { recursive: true })
  await page.setViewportSize({ width: 1366, height: 768 })
  await openExport(page)
  await expect(page.getByTestId('ds-format-folder')).toBeChecked()
  await page.getByTestId('ds-nl-on').uncheck()
  await chooseFolder(page, out)
  await page.getByTestId('ds-export-run').click()

  const blocked = page.getByTestId('ds-blocked')
  await expect(blocked).toBeVisible({ timeout: 60_000 })
  await expect(blocked).toContainText('Nothing was written')
  const issue = blocked.locator('[data-testid="ds-issue"][data-label="unreadable"]')
  await expect(issue).toContainText(`${PREFIX}03.png`)
  expect(fs.readdirSync(out)).toEqual([])
  await page.getByTestId('jobs-button').click()
  await expect(page.getByTestId('jobs-drawer').getByTestId('job').first()).toHaveAttribute('data-status', 'error')
  await page.keyboard.press('Escape')

  await page.getByTestId('ds-skip-blocked').click()
  const result = page.getByTestId('ds-export-result')
  await expect(result).toBeVisible({ timeout: 60_000 })
  await expect(result.getByTestId('ds-result-skipped')).toContainText(`${PREFIX}03.png`)
  await expect(result.getByTestId('ds-result-row')).toHaveCount(4)
  expect(fs.readdirSync(out).filter((f) => f.endsWith('.png'))).toHaveLength(4)
})

test('the folder chooser opening on "This computer" keeps the first character typed', async ({ page }) => {
  await openV4(page, '#/batch')
  const p = (await apiJson<Project>(page, `/api/dataset/projects/${projectId}`)).body
  const output = { ...(p.settings.output as Record<string, unknown>), folder: '' }
  const put = await apiJson(page, `/api/dataset/projects/${projectId}`, {
    method: 'PUT',
    body: { expected_revision: p.revision, name: p.name, items: p.items.map((i) => (i.item_type === 'library' ? { item_type: 'library', image_id: i.source_image_id, keep_as_saved: true } : { item_type: 'local', path: i.path, keep_as_saved: true })), settings: { ...p.settings, output } },
  })
  expect(put.status).toBe(200)
  await page.setViewportSize({ width: 1366, height: 768 })
  await openExport(page)
  await page.getByTestId('ds-export-choose-folder').click()
  const chooser = page.getByTestId('ds-export-folder-picker')
  const input = chooser.getByTestId('folder-path')
  // no folder yet and nothing recent: it opens on the drive list, with the cursor in the box
  await expect(chooser.getByTestId('folder-list').getByRole('button').first()).toBeVisible()
  await expect(input).toBeFocused()
  await page.keyboard.type(OUT)
  await expect(input).toHaveValue(OUT)
})
