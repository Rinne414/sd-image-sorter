import path from 'node:path'
import { expect, test, type Page, type Route } from '../fixtures/click-ledger'

import { cleanupImages, dbPath, pageOverflow, runBackendScript, seedImages, tmpRoot } from '../fixtures/v4-seed'

/**
 * V4 check step, caption checks over the whole batch:
 *
 *  1. Health by purpose reads folder images too (by their captions): a
 *     subject-count conflict in a folder image is listed and fixed like a
 *     Library image's.
 *  2. A count tag that comes from the batch's common tags ("solo") cannot be
 *     taken off one caption, so the fix offers to move it into the captions:
 *     only the images that do not have it in their own caption get it written
 *     in, it leaves the common tags, and one Undo puts both back.
 *  3. Exact token counts for SDXL (CLIP ViT-L/14), not only Anima: the card
 *     names the model and its download, and the long-caption notes name CLIP.
 *
 * Health and export-preview run for real; only the tokenizer endpoints are
 * answered here (no tokenizer is downloaded).
 *
 * Needs the V4 build: `cd frontend-v4 && npm ci && npm run build`.
 */

test.describe.configure({ mode: 'serial' })

const TOKEN = 'v4capchktoken'
const PREFIX = 'v4capchk-'
const DIR = 'v4-capchk'
const FOLDER_DIR = 'v4-capchk-folder'
const NAME = 'v4capchk'
const folderFile = path.join(tmpRoot, FOLDER_DIR, 'two-girls.png')

let ids: number[] = []
let batchId = 0
let projectId = 0

const py = JSON.stringify

/** Library tags: A has a second girl, B is solo in its own tags, C does not say. The folder image has two girls. */
const LIBRARY_TAGS = [
  ['1girl', '2girls', 'smile'],
  ['1girl', 'solo', 'smile'],
  ['1girl', 'smile'],
]

function seedRows(): void {
  const out = runBackendScript(`
import sqlite3
from pathlib import Path
from PIL import Image

folder = Path(${py(folderFile)}).parent
folder.mkdir(parents=True, exist_ok=True)
Image.new("RGB", (600, 600), (90, 120, 150)).save(${py(folderFile)})
Path(${py(folderFile)}).with_suffix(".txt").write_text("1girl, 2girls, forest", encoding="utf-8")
tags = ${py(LIBRARY_TAGS)}
with sqlite3.connect(${py(dbPath)}) as conn:
    rows = conn.execute("SELECT id FROM images WHERE filename LIKE ? ORDER BY filename", (${py(PREFIX + '%')},)).fetchall()
    for (image_id,), own in zip(rows, tags):
        conn.execute("DELETE FROM tags WHERE image_id = ?", (image_id,))
        for tag in own:
            conn.execute("INSERT INTO tags (image_id, tag, confidence) VALUES (?, ?, 0.9)", (image_id, tag))
    conn.commit()
print(",".join(str(r[0]) for r in rows))
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
    conn.execute("DELETE FROM tags WHERE image_id IN (SELECT id FROM images WHERE filename LIKE ?)", (${py(PREFIX + '%')},))
    conn.commit()
print("ok")
`)
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
    const flag = 'v4e2e-init-capchk'
    if (sessionStorage.getItem(flag)) return
    sessionStorage.setItem(flag, '1')
    localStorage.setItem('sd-image-sorter-lang', 'en')
    localStorage.setItem('sd-v4-theme', 'dark')
    localStorage.removeItem('sd-v4-dataset-check')
  })
  await page.goto(`/vopus/${hash}`, { waitUntil: 'domcontentloaded' })
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
  settings: { caption_render: { common_tags: string[] } & Record<string, unknown> } & Record<string, unknown>
}

const project = async (page: Page) => (await apiJson<Project>(page, `/api/dataset/projects/${projectId}`)).body

interface HeadRow {
  generation: number
  item: { image_id?: number | null; path?: string | null }
  active_revision?: { content?: { booru_caption?: string } } | null
}

/** Each image's own caption as saved (Library id or folder path), or nothing when it was never edited. */
async function savedCaptions(page: Page): Promise<Record<string, string>> {
  const p = await project(page)
  const answer = await apiJson<{ items: HeadRow[] }>(
    page,
    `/api/annotations/projects/${projectId}/training-captions/heads?expected_project_revision=${p.revision}&limit=200`,
  )
  const out: Record<string, string> = {}
  for (const row of answer.body.items) {
    if (row.generation <= 0) continue
    const key = row.item.image_id ? String(row.item.image_id) : 'folder'
    out[key] = row.active_revision?.content?.booru_caption ?? ''
  }
  return out
}

async function putSettings(page: Page, change: (s: Project['settings']) => Project['settings']): Promise<void> {
  const p = await project(page)
  const items = [...ids.map((id) => ({ item_type: 'library', image_id: id, keep_as_saved: true })), { item_type: 'local', path: folderFile, keep_as_saved: false }]
  const put = await apiJson(page, `/api/dataset/projects/${projectId}`, { method: 'PUT', body: { expected_revision: p.revision, name: p.name, items, settings: change(p.settings) } })
  expect(put.status).toBe(200)
}

const issue = (page: Page, kind: string) => page.locator(`[data-testid="check-issue"][data-kind="${kind}"]`)

async function openCheck(page: Page): Promise<void> {
  await openV4(page, `#/batch/${batchId}`)
  await page.locator('[data-testid="rail-step"][data-step-id="check"]').click()
  await expect(page.getByTestId('check-step')).toBeVisible()
}

test('a dataset batch: three Library images and a folder image, "solo" in the common tags', async ({ page }) => {
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
  await putSettings(page, (s) => ({ ...s, caption_render: { ...s.caption_render, common_tags: ['solo'] } }))
  expect((await project(page)).settings.caption_render.common_tags).toEqual(['solo'])
})

test('the folder image is checked too; "solo" from the common tags moves into the captions, and Undo puts it back', async ({ page }) => {
  await openCheck(page)
  const subject = issue(page, 'subject_count')
  await expect(subject).toBeVisible({ timeout: 30_000 })
  const rows = subject.getByTestId('check-subject-row')
  // A (two girls) and the folder image, not B or C.
  await expect(rows).toHaveCount(2)
  await expect(subject.locator(`[data-testid="check-subject-row"][data-key="lib:${ids[0]}"]`)).toBeVisible()
  await expect(rows.filter({ hasText: 'two-girls.png' })).toBeVisible()

  // Health reads the folder image too: no "not applicable to folder images" beside it.
  const health = page.locator('[data-testid="check-source"][data-source="health"]')
  await expect(health).toContainText('4 checked')
  await expect(health).not.toContainText('Not applicable')

  const common = subject.getByTestId('check-subject-common')
  await expect(common).toContainText('The batch’s common tags put “solo” on every picture')
  for (const [width, height] of [[1366, 768], [1920, 1080], [2560, 1440]] as const) {
    await page.setViewportSize({ width, height })
    await common.scrollIntoViewIfNeeded()
    expect(await pageOverflow(page)).toBe(0)
    await page.screenshot({ path: test.info().outputPath(`subject-common-${width}.png`), fullPage: false })
  }

  await subject.getByTestId('check-subject-move-common').click()
  // Only C lacked "solo" in its own caption: it gets it at the end, where the template put it.
  await expect.poll(async () => (await project(page)).settings.caption_render.common_tags).toEqual([])
  expect(await savedCaptions(page)).toEqual({ [String(ids[2])]: '1girl, smile, solo' })

  // One Undo puts "solo" back into the common tags and C's caption back as it was.
  await page.getByRole('button', { name: 'Undo' }).last().click()
  await expect.poll(async () => (await project(page)).settings.caption_render.common_tags).toEqual(['solo'])
  expect((await savedCaptions(page))[String(ids[2])]).toBe('1girl, smile')
})

test('after the move the fix takes the extra count tag off both pictures, the folder image included', async ({ page }) => {
  await openCheck(page)
  const subject = issue(page, 'subject_count')
  await expect(subject.getByTestId('check-subject-common')).toBeVisible({ timeout: 30_000 })
  await subject.getByTestId('check-subject-move-common').click()
  await expect.poll(async () => (await project(page)).settings.caption_render.common_tags).toEqual([])

  // The check reads the captions again: "solo" is no longer the batch's, only 1girl contradicts.
  await expect(subject.getByTestId('check-subject-common')).toHaveCount(0, { timeout: 30_000 })
  await expect(subject.getByTestId('check-subject-apply')).toHaveText('Apply to the 2 ticked')
  await subject.getByTestId('check-subject-apply').click()
  await expect.poll(async () => savedCaptions(page)).toMatchObject({ [String(ids[0])]: '2girls, smile', folder: '2girls, forest' })
  await expect(issue(page, 'subject_count')).toHaveCount(0, { timeout: 30_000 })
})

test('SDXL counts tokens exactly with CLIP: the card names the model and the 2 MB download, notes name CLIP', async ({ page }) => {
  let available = false
  const profiles: string[] = []
  const profileOf = (route: Route) => new URL(route.request().url()).searchParams.get('profile') || ''
  await page.route('**/api/dataset/caption-tokens/status**', (route) => {
    profiles.push(profileOf(route))
    return route.fulfill({
      json: {
        profile: 'sdxl', model: 'SDXL', limit: 75, available, tokenizers_package: true,
        files: [{ id: 'clip_vit_l_14', label: 'CLIP ViT-L/14', size_bytes: 2224003, present: available }],
        download_bytes: available ? 0 : 2224003, download_bytes_total: 2224003, preparing: false, step: '', error: null,
      },
    })
  })
  await page.route('**/api/dataset/caption-tokens/prepare**', (route) => {
    profiles.push(`prepare:${profileOf(route)}`)
    available = true
    return route.fulfill({ json: { status: 'started' } })
  })
  await page.route('**/api/dataset/caption-tokens', async (route) => {
    const body = route.request().postDataJSON() as { profile: string; texts: string[] }
    profiles.push(`count:${body.profile}`)
    await route.fulfill({
      json: {
        profile: 'sdxl', limit: 75, available: true, missing: [], metrics: [{ id: 'clip_vit_l_14', label: 'CLIP ViT-L/14' }],
        counts: body.texts.map((text) => ({ clip_vit_l_14: text.includes('forest') ? 600 : 5 })),
      },
    })
  })
  await openV4(page, '#/batch')
  await putSettings(page, (s) => ({ ...s, target_model: 'sdxl' }))
  await openCheck(page)

  const card = page.getByTestId('check-tokenizers')
  await expect(card).toContainText('SDXL token counts')
  await expect(card.getByTestId('tokenizers-estimate')).toContainText('tokenizer files of the SDXL text encoder are here (CLIP ViT-L/14): about 2 MB')
  await card.getByTestId('tokenizers-download').click()
  await expect(card.getByTestId('tokenizers-ready')).toHaveText('Exact: every caption is counted with CLIP ViT-L/14, as the SDXL text encoder reads it.')

  const long = issue(page, 'too_long')
  await expect(long).toBeVisible({ timeout: 30_000 })
  await expect(long).toContainText('CLIP 600 tokens')
  expect(profiles.filter((p) => !p.endsWith('sdxl'))).toEqual([])
})
