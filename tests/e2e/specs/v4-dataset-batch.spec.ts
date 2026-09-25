import fsSync from 'node:fs'
import path from 'node:path'

import { expect, test, type Page } from '@playwright/test'

import { cleanupImages, dbPath, openLibrary, runBackendScript, seedImages, tmpRoot } from '../fixtures/v4-seed'

/**
 * V4 dataset batches (slice 3b): the pick step holds Library images and folder
 * images (added from a folder by path, or dropped and copied into the batch)
 * that never enter the Library; the order set here is the order V3.5 reads;
 * a change V3.5 made meanwhile is reloaded and said, never overwritten; V3.5
 * projects open as batches; a collection's batch is reused; deleting refuses a
 * project that changed after the confirmation opened.
 *
 * Needs the V4 build: `cd frontend-v4 && npm ci && npm run build`.
 */

test.describe.configure({ mode: 'serial' })

const TOKEN = 'v4dsbtoken'
const PREFIX = 'v4dsb-'
const COUNT = 4
const DIR = 'v4-dsb'
const FOLDER_DIR = 'v4-dsb-folder'
const NAME = 'v4dsb'
const COLLECTION_SLUG = 'v4dsb-collection'
const folderPath = path.join(tmpRoot, FOLDER_DIR)

let batchId = 0
let projectId = 0

interface ProjectItem {
  item_type: 'library' | 'local'
  source_image_id?: number
  image_id?: number | null
  path?: string
}

interface Project {
  id: number
  name: string
  revision: number
  items: ProjectItem[]
  settings: Record<string, unknown>
}

function writeFolderImages(): void {
  runBackendScript(`
import shutil
from pathlib import Path
from PIL import Image
root = Path(${JSON.stringify(folderPath)})
shutil.rmtree(root, ignore_errors=True)
(root / "sub").mkdir(parents=True, exist_ok=True)
Image.new("RGB", (48, 64), (200, 60, 60)).save(root / "local-a.png")
Image.new("RGB", (64, 48), (60, 200, 60)).save(root / "sub" / "local-b.png")
Image.new("RGB", (40, 40), (60, 60, 200)).save(root.parent / "${FOLDER_DIR}-dropped.png")
print("ok")
`)
}

function cleanupRows(): void {
  runBackendScript(`
import sqlite3
with sqlite3.connect(${JSON.stringify(dbPath)}) as conn:
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("DELETE FROM batches WHERE name LIKE ?", (${JSON.stringify(NAME + '%')},))
    conn.execute("DELETE FROM dataset_projects WHERE name LIKE ?", (${JSON.stringify(NAME + '%')},))
    conn.execute("DELETE FROM collection_items WHERE collection_id IN (SELECT id FROM collections WHERE slug = ?)", (${JSON.stringify(COLLECTION_SLUG)},))
    conn.execute("DELETE FROM collections WHERE slug = ?", (${JSON.stringify(COLLECTION_SLUG)},))
    conn.commit()
print("ok")
`)
}

/** Library rows that point at the folder images: there must never be any. */
function folderRowsInLibrary(): number {
  const out = runBackendScript(`
import sqlite3
with sqlite3.connect(${JSON.stringify(dbPath)}) as conn:
    print(conn.execute("SELECT COUNT(*) FROM images WHERE path LIKE ? OR filename LIKE ?", ("%${FOLDER_DIR}%", "%dropped%")).fetchone()[0])
`)
  return Number(out.split(/\s+/).at(-1))
}

test.beforeAll(() => {
  seedImages({ prefix: PREFIX, token: TOKEN, count: COUNT, dir: DIR })
  writeFolderImages()
  cleanupRows()
})

test.afterAll(() => {
  cleanupRows()
  cleanupImages(PREFIX, [DIR, FOLDER_DIR])
  fsSync.rmSync(path.join(tmpRoot, `${FOLDER_DIR}-dropped.png`), { force: true })
})

async function openV4(page: Page, hash: string): Promise<void> {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('v4e2e-init-dsb')) return
    sessionStorage.setItem('v4e2e-init-dsb', '1')
    localStorage.setItem('sd-image-sorter-lang', 'en')
    localStorage.setItem('sd-v4-theme', 'dark')
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

const project = async (page: Page, id = projectId) => (await apiJson<Project>(page, `/api/dataset/projects/${id}`)).body
const itemKey = (item: ProjectItem) => (item.item_type === 'library' ? `lib:${item.source_image_id}` : `dir:${(item.path ?? '').replace(/\\/g, '/')}`)
const tileKeys = (page: Page) => page.getByTestId('pick-tile').evaluateAll((els) => els.map((el) => el.getAttribute('data-key') ?? ''))

/** A V3.5-style save: the same project with these items (kept as saved). */
async function v35Save(page: Page, p: Project, items: ProjectItem[]): Promise<number> {
  const body = {
    expected_revision: p.revision,
    name: p.name,
    items: items.map((item) =>
      item.item_type === 'library'
        ? { item_type: 'library', image_id: item.source_image_id, keep_as_saved: true }
        : { item_type: 'local', path: item.path, keep_as_saved: true },
    ),
    settings: p.settings,
  }
  return (await apiJson(page, `/api/dataset/projects/${p.id}`, { method: 'PUT', body })).status
}

async function dropFile(page: Page, file: string): Promise<void> {
  const bytes = [...fsSync.readFileSync(file)]
  const name = path.basename(file)
  const data = await page.evaluateHandle(
    ({ b, n }) => {
      const dt = new DataTransfer()
      dt.items.add(new File([new Uint8Array(b)], n, { type: 'image/png' }))
      return dt
    },
    { b: bytes, n: name },
  )
  await page.dispatchEvent('[data-testid="pick-grid"]', 'dragenter', { dataTransfer: data })
  await expect(page.getByTestId('dataset-drop-overlay')).toBeVisible()
  await expect(page.getByTestId('drop-overlay'), 'the Library import stands aside').toHaveCount(0)
  await page.dispatchEvent('[data-testid="pick-grid"]', 'drop', { dataTransfer: data })
}

test('Library picks, a folder and a dropped file join the dataset in the order set here; V3.5 reads the same', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await openLibrary(page, TOKEN, COUNT)
  const tiles = page.getByTestId('tile')
  for (const i of [2, 0, 1]) await tiles.nth(i).click({ modifiers: ['Control'] })
  await page.getByTestId('add-to-batch').click()
  await page.getByRole('menuitem', { name: 'New dataset…' }).click()
  await page.getByTestId('batch-name-input').fill(`${NAME} set`)
  await page.getByTestId('batch-create-dialog').getByRole('button', { name: 'Create (3)' }).click()
  await page.getByRole('status').getByRole('button', { name: 'Open' }).click()
  const view = page.getByTestId('batch-view')
  await expect(view).toContainText('Dataset')
  await expect(page.getByTestId('pick-tile')).toHaveCount(3)
  batchId = Number(await view.getAttribute('data-batch-id'))
  projectId = (await apiJson<{ dataset_project_id: number }>(page, `/api/batches/${batchId}`)).body.dataset_project_id
  expect(projectId).toBeGreaterThan(0)

  // a folder, subfolders included, joins by path
  await page.getByTestId('add-from-folder').click()
  const dialog = page.getByTestId('dataset-folder-dialog')
  await dialog.getByTestId('folder-path').fill(folderPath)
  await dialog.getByTestId('folder-path').press('Enter')
  await expect(dialog.getByTestId('folder-target')).toContainText(FOLDER_DIR)
  await dialog.getByRole('button', { name: "Add this folder's images" }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByTestId('pick-tile')).toHaveCount(5)
  await expect(page.getByTestId('folder-badge')).toHaveCount(2)
  await expect(page.getByTestId('pick-count')).toHaveText('5 images (2 from folders)')

  // a dropped file is copied into the batch
  await dropFile(page, path.join(tmpRoot, `${FOLDER_DIR}-dropped.png`))
  await expect(page.getByTestId('pick-tile')).toHaveCount(6)
  await expect(page.getByTestId('folder-badge')).toHaveCount(3)
  await expect(page.getByTestId('pick-tile').last()).toHaveAttribute('data-source', 'folder')

  // reorder: the dropped image to the front by key, then the second one dragged before the fourth
  await page.getByTestId('pick-tile').last().click()
  await page.keyboard.press('Alt+Home')
  await expect(page.getByTestId('pick-tile').first()).toHaveAttribute('data-key', /dropped/)
  const second = await page.getByTestId('pick-tile').nth(1).getAttribute('data-key')
  const tilesNow = page.getByTestId('pick-tile')
  await tilesNow.nth(1).dragTo(tilesNow.nth(3), { targetPosition: { x: 4, y: 40 } })
  await expect.poll(async () => (await tileKeys(page)).indexOf(second ?? '')).toBe(2)
  await expect.poll(async () => (await project(page)).items.map(itemKey)).toEqual(await tileKeys(page))
  const saved = await project(page)
  expect(saved.items[0]?.path).toContain(`${FOLDER_DIR}-dropped`)
  expect(saved.items.filter((i) => i.item_type === 'local')).toHaveLength(3)
  expect(folderRowsInLibrary()).toBe(0)

  await page.reload()
  await expect(page.getByTestId('pick-tile')).toHaveCount(6)
  expect(await tileKeys(page)).toEqual(saved.items.map(itemKey))
})

test('several images out at once, and undo puts each back in its place', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await openV4(page, `#/batch/${batchId}`)
  await expect(page.getByTestId('pick-tile')).toHaveCount(6)
  const before = await tileKeys(page)
  await page.getByTestId('pick-tile').nth(0).click()
  await page.getByTestId('pick-tile').nth(3).click({ modifiers: ['Control'] })
  await page.getByTestId('pick-tile').nth(4).click({ modifiers: ['Control'] })
  await expect(page.getByTestId('pick-selected')).toHaveText('2 selected')
  await page.getByTestId('pick-remove-selected').click()
  await expect(page.getByTestId('pick-tile')).toHaveCount(4)
  expect((await project(page)).items).toHaveLength(4)

  await page.getByRole('status').getByRole('button', { name: 'Undo' }).click()
  await expect.poll(() => tileKeys(page)).toEqual(before)
  expect((await project(page)).items.map(itemKey)).toEqual(before)
})

test('a change V3.5 made meanwhile is loaded again and said; nothing is overwritten', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await openV4(page, `#/batch/${batchId}`)
  await expect(page.getByTestId('pick-tile')).toHaveCount(6)
  const now = await project(page)
  expect(await v35Save(page, now, now.items.slice(0, 5))).toBe(200)

  await page.getByTestId('pick-tile').nth(0).click()
  await page.keyboard.press('Delete')
  await expect(page.getByRole('status')).toContainText('This dataset was just changed elsewhere')
  await expect(page.getByTestId('pick-tile')).toHaveCount(5)
  const after = await project(page)
  expect(after.revision).toBe(now.revision + 1)
  expect(after.items.map(itemKey)).toEqual(now.items.slice(0, 5).map(itemKey))
})

test('a V3.5 dataset project shows in the Batch list and opens as a batch', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await openV4(page, '#/batch')
  const ids = runBackendScript(`
import sqlite3
with sqlite3.connect(${JSON.stringify(dbPath)}) as conn:
    print(",".join(str(r[0]) for r in conn.execute("SELECT id FROM images WHERE filename LIKE ? ORDER BY filename", (${JSON.stringify(PREFIX + '%')},))))
`).split(/\s+/).at(-1)!.split(',').map(Number)
  const settings = (await project(page)).settings
  const made = await apiJson<Project>(page, '/api/dataset/projects', {
    method: 'POST',
    body: { name: `${NAME} from v35`, items: [ids[3], ids[1]].map((id) => ({ item_type: 'library', image_id: id })), settings },
  })
  expect(made.status).toBe(201)
  await page.reload()

  const row = page.getByTestId('v35-project-row').filter({ hasText: `${NAME} from v35` })
  await expect(row).toContainText('2 images')
  await row.getByTestId('v35-project-open').click()
  const view = page.getByTestId('batch-view')
  await expect(view).toContainText(`${NAME} from v35`)
  await expect(view).toContainText('Dataset')
  await expect(page.getByTestId('pick-tile')).toHaveCount(2)
  expect(await tileKeys(page)).toEqual([`lib:${ids[3]}`, `lib:${ids[1]}`])

  await page.getByTestId('batch-back').click()
  await expect(page.getByTestId('batch-row').filter({ hasText: `${NAME} from v35` })).toHaveCount(1)
  await expect(page.getByTestId('v35-project-row').filter({ hasText: `${NAME} from v35` })).toHaveCount(0)
})

test('a collection that became a batch opens that batch instead of making another', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  runBackendScript(`
import sqlite3
with sqlite3.connect(${JSON.stringify(dbPath)}) as conn:
    cur = conn.cursor()
    cur.execute("INSERT INTO collections (slug, name, folder_path, library_id) VALUES (?, ?, '', 'main')", (${JSON.stringify(COLLECTION_SLUG)}, "v4dsb collection"))
    cid = cur.lastrowid
    for image_id, path in cur.execute("SELECT id, path FROM images WHERE filename LIKE ? ORDER BY filename LIMIT 2", (${JSON.stringify(PREFIX + '%')},)).fetchall():
        conn.execute("INSERT INTO collection_items (collection_id, source_image_id, copied_path) VALUES (?, ?, ?)", (cid, image_id, path))
    conn.commit()
print("ok")
`)
  await openV4(page, '#/batch')
  const row = page.getByTestId('collection-row').filter({ hasText: 'v4dsb collection' })
  await row.getByRole('button', { name: 'Make a batch' }).click()
  const view = page.getByTestId('batch-view')
  await expect(view).toContainText('Custom')
  const first = Number(await view.getAttribute('data-batch-id'))

  await page.getByTestId('batch-back').click()
  await expect(row.getByTestId('collection-batch')).toContainText('v4dsb collection')
  await row.getByTestId('collection-open-batch').click()
  await expect(view).toHaveAttribute('data-batch-id', String(first))
})

test('deleting a dataset batch says what goes, and refuses a project V3.5 changed after the confirmation opened', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await openV4(page, '#/batch')
  const row = page.getByTestId('batch-row').filter({ hasText: `${NAME} set` })
  await row.getByRole('button', { name: 'Delete…' }).click()
  const dialog = page.getByTestId('batch-delete-dialog')
  await expect(dialog.getByTestId('dataset-delete-body')).toContainText('disappears from V3.5 too')
  await expect(dialog.getByTestId('dataset-delete-uploads')).toContainText('files uploaded into this batch (1)')
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused()

  const now = await project(page)
  expect(await v35Save(page, now, now.items.slice(0, 4))).toBe(200)
  await page.getByTestId('batch-delete-ok').click()
  await expect(page.getByRole('status')).toContainText('was just changed elsewhere')
  expect((await apiJson(page, `/api/batches/${batchId}`)).status).toBe(200)

  // the confirmation now shows the new version; deleting it goes through
  await expect(dialog.getByTestId('dataset-delete-body')).toContainText('its 4 images')
  await page.getByTestId('batch-delete-ok').click()
  await expect(row).toHaveCount(0)
  expect((await apiJson(page, `/api/batches/${batchId}`)).status).toBe(404)
  expect((await apiJson(page, `/api/dataset/projects/${projectId}`)).status).toBe(404)
  expect(fsSync.existsSync(path.join(folderPath, 'local-a.png')), 'folder images stay on disk').toBe(true)
  expect(folderRowsInLibrary()).toBe(0)
})
