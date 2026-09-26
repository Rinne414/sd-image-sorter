import { expect, test, type Page } from '@playwright/test'

import { cleanupImages, dbPath, pageOverflow, runBackendScript, seedImages, VIEWPORTS } from '../fixtures/v4-seed'

/**
 * V4 bulk caption changes (slice 3f): in the edit step's "many at once" mode
 * every operation names its scope and how many captions it changes; removing
 * a tag from 40 captions is one request; one undo puts every caption back
 * exactly (the export renders the same text); the Library's tags never
 * change; the frequency table picks, blacklists, hints character traits and
 * finds tags the tagger nearly gave (stored scores, run for real).
 *
 * Nothing is stubbed. Needs the V4 build: `cd frontend-v4 && npm ci && npm run build`.
 */

test.describe.configure({ mode: 'serial' })

const TOKEN = 'v4dbktoken'
const PREFIX = 'v4dbk-'
const DIR = 'v4-dbk'
const NAME = 'v4dbk'
const COUNT = 40
const TRIGGER = 'bkchar'

let ids: number[] = []
let batchId = 0
let projectId = 0

const py = JSON.stringify

function seedTags(): void {
  const out = runBackendScript(`
import sqlite3
with sqlite3.connect(${py(dbPath)}) as conn:
    ids = [r[0] for r in conn.execute("SELECT id FROM images WHERE filename LIKE ? ORDER BY filename", (${py(PREFIX + '%')},))]
    for n, image_id in enumerate(ids):
        conn.execute("DELETE FROM tags WHERE image_id = ?", (image_id,))
        conn.execute("DELETE FROM tag_scores WHERE image_id = ?", (image_id,))
        tags = [("1girl", 0.95), ("silver_hair", 0.9), ("watermark", 0.7)]
        if n % 2 == 0:
            tags.append(("smile", 0.8))
        if n < 10:
            tags.append(("outdoors", 0.6))
        for tag, conf in tags:
            conn.execute("INSERT INTO tags (image_id, tag, confidence) VALUES (?, ?, ?)", (image_id, tag, conf))
        # the tagger nearly saw "blush" on the last five (just under its threshold)
        if n >= ${COUNT - 5}:
            conn.execute(
                "INSERT INTO tag_scores (image_id, model, tag, score, category) VALUES (?, 'wd-swinv2-tagger-v3', 'blush', 0.3, 'general')",
                (image_id,),
            )
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

/** Every Library tag row of the seeded images, as one comparable string. */
function libraryTags(): string {
  return runBackendScript(`
import sqlite3
with sqlite3.connect(${py(dbPath)}) as conn:
    rows = conn.execute("SELECT image_id, tag FROM tags WHERE image_id IN (SELECT id FROM images WHERE filename LIKE ?) ORDER BY image_id, tag", (${py(PREFIX + '%')},)).fetchall()
print("|".join(f"{a}:{b}" for a, b in rows))
`).split(/\r?\n/).at(-1) ?? ''
}

test.beforeAll(() => {
  seedImages({ prefix: PREFIX, token: TOKEN, count: COUNT, dir: DIR })
  cleanupRows()
  seedTags()
})

test.afterAll(() => {
  cleanupRows()
  cleanupImages(PREFIX, [DIR])
})

async function openV4(page: Page, hash: string): Promise<void> {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('v4e2e-init-dbk')) return
    sessionStorage.setItem('v4e2e-init-dbk', '1')
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

interface Project {
  id: number
  name: string
  revision: number
  items: unknown[]
  settings: { caption_render: Record<string, unknown> & { blacklist: string[] } } & Record<string, unknown>
}

interface Head {
  item: { item_type: 'library'; image_id: number }
  generation: number
  active_revision: { id: number; author_class: string; source: string; content: { booru_caption: string; caption_type: string } } | null
}

const project = async (page: Page) => (await apiJson<Project>(page, `/api/dataset/projects/${projectId}`)).body

async function heads(page: Page): Promise<Map<number, Head>> {
  const p = await project(page)
  const res = await apiJson<{ items: Head[] }>(page, `/api/annotations/projects/${projectId}/training-captions/heads?expected_project_revision=${p.revision}&limit=200`)
  expect(res.status).toBe(200)
  return new Map(res.body.items.filter((h) => h.generation > 0).map((h) => [h.item.image_id, h]))
}

/** What the export writes for every image now (each edited image by its revision), by image id. */
async function finalCaptions(page: Page): Promise<Map<number, string>> {
  const p = await project(page)
  const current = await heads(page)
  const selections = Object.fromEntries(
    ids.map((id) => {
      const rev = current.get(id)?.active_revision?.id
      return [String(id), rev ? { kind: 'revision_ref', revision_id: rev } : { kind: 'dynamic_source' }]
    }),
  )
  const res = await apiJson<{ items: { image_id: number; caption: string }[] }>(page, '/api/dataset/export-preview', {
    method: 'POST',
    body: {
      image_ids: ids,
      content_mode: 'template',
      trigger: TRIGGER,
      template_options: { preset_id: 'custom', template_override: '{trigger}, {tags:filtered}, {append}', trigger: TRIGGER },
      caption_transforms: { prepend: [TRIGGER], remove: [], remove_categories: [] },
      dataset_project_id: projectId,
      dataset_project_revision: p.revision,
      annotation_selections: selections,
      limit: 500,
    },
  })
  expect(res.status).toBe(200)
  return new Map(res.body.items.map((i) => [i.image_id, i.caption]))
}

const row = (page: Page, tag: string) => page.locator(`[data-testid="freq-row"][data-tag="${tag}"]`)

async function openBulk(page: Page): Promise<void> {
  await openV4(page, `#/batch/${batchId}`)
  await page.locator('[data-testid="rail-step"][data-step-id="edit"]').click()
  await page.getByTestId('edit-mode-bulk').click()
  await expect(row(page, '1girl')).toBeVisible({ timeout: 20_000 })
}

test('a dataset batch of 40 Library images with a trigger', async ({ page }) => {
  await openV4(page, '#/batch')
  const made = await apiJson<{ batch: { id: number; dataset_project_id: number } }>(page, '/api/batches', {
    method: 'POST',
    body: { kind: 'dataset', name: `${NAME} set`, image_ids: ids },
  })
  expect(made.status).toBe(201)
  batchId = made.body.batch.id
  projectId = made.body.batch.dataset_project_id
  const p = await project(page)
  const settings = { ...p.settings, target_model: '', caption_render: { ...p.settings.caption_render, trigger: TRIGGER } }
  const put = await apiJson(page, `/api/dataset/projects/${projectId}`, {
    method: 'PUT',
    body: { expected_revision: p.revision, name: p.name, items: ids.map((id) => ({ item_type: 'library', image_id: id, keep_as_saved: true })), settings },
  })
  expect(put.status).toBe(200)
})

test('removing a tag from all 40 captions is one request; one undo puts every caption back exactly; Library tags never change', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  const tagsBefore = libraryTags()
  await openBulk(page)
  await expect(page.getByTestId('bulk-scope')).toHaveText('For all 40')
  await expect(row(page, 'watermark')).toContainText('40')
  const before = await finalCaptions(page)
  expect([...before.values()].every((c) => c.startsWith(`${TRIGGER}, `) && c.includes('watermark'))).toBe(true)

  const writes: string[] = []
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url().includes('/training-captions/revisions')) writes.push(req.url())
  })
  await row(page, 'watermark').getByTestId('freq-remove').click()
  await expect(row(page, 'watermark')).toHaveCount(0)
  expect(writes.filter((u) => u.endsWith('revisions:batch'))).toHaveLength(1)
  expect(writes.filter((u) => u.endsWith('/revisions'))).toHaveLength(0)
  const after = await finalCaptions(page)
  expect([...after.values()].some((c) => c.includes('watermark'))).toBe(false)
  expect(libraryTags(), 'bulk changes are this batch’s captions, never the Library').toBe(tagsBefore)
  expect((await heads(page)).size).toBe(COUNT)

  await page.getByTestId('bulk-undo').click()
  await expect(row(page, 'watermark')).toBeVisible()
  await expect(page.getByTestId('bulk-undo')).toHaveCount(0)
  expect(writes.filter((u) => u.endsWith('revisions:batch'))).toHaveLength(2)
  const undone = await finalCaptions(page)
  expect([...undone.entries()]).toEqual([...before.entries()])
  // images nobody had edited come back as the template's caption, not as the user's writing
  const restored = await heads(page)
  expect([...restored.values()].every((h) => h.active_revision?.author_class === 'system' && h.active_revision.source === 'legacy_snapshot')).toBe(true)
  await expect(page.getByTestId('edit-filter-edited')).toContainText('0')
  expect(libraryTags()).toBe(tagsBefore)
})

test('picked images are the scope: a range with Shift, then add at the front, a regex, the type', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await openBulk(page)
  const items = page.getByTestId('edit-item')
  await items.nth(0).click()
  await items.nth(2).click({ modifiers: ['Shift'] })
  await expect(page.getByTestId('bulk-scope')).toHaveText('For the 3 picked')

  await page.getByTestId('bulk-tags').fill('solo')
  await page.getByLabel('At the front').check()
  await expect(page.getByTestId('bulk-add')).toHaveText('Add (3 captions)')
  await page.getByTestId('bulk-add').click()
  await expect(page.getByRole('status')).toContainText('Changed 3 captions: add solo')

  await page.getByTestId('bulk-find').fill('^silver (\\w+)$')
  await page.getByTestId('bulk-replace-with').fill('grey $1')
  await page.getByTestId('bulk-find-mode').selectOption('regex')
  await expect(page.getByTestId('bulk-replace')).toHaveText('Replace (3 captions)')
  await page.getByTestId('bulk-replace').click()
  await page.getByTestId('bulk-type-both').click()

  const now = await heads(page)
  const picked = ids.slice(0, 3)
  for (const id of picked) {
    const content = now.get(id)?.active_revision?.content
    expect(content?.booru_caption.split(', ')[0]).toBe('solo')
    expect(content?.booru_caption).toContain('grey hair')
    expect(content?.caption_type).toBe('both')
  }
  expect(now.get(ids[5] as number)?.active_revision?.content.booru_caption).not.toContain('solo')
  expect(now.get(ids[5] as number)?.active_revision?.content.caption_type).toBe('booru')
})

test('the frequency table: character trait hints, blacklist, pick, and tags the tagger nearly found (added to captions only)', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  const tagsBefore = libraryTags()
  await openBulk(page)

  // silver hair is on 37 of 40 captions (3 were renamed): a hair trait
  await page.getByTestId('freq-traits').click()
  await expect(row(page, 'silver hair').getByTestId('freq-trait')).toContainText('Hair trait')
  await expect(row(page, 'smile').getByTestId('freq-trait')).toHaveCount(0)

  // blacklist from the table: the batch setting changes, no caption does
  await row(page, 'outdoors').getByTestId('freq-blacklist').click()
  await expect.poll(async () => (await project(page)).settings.caption_render.blacklist).toContain('outdoors')
  await expect(row(page, 'outdoors').getByTestId('freq-blacklist')).toHaveText('Unlist')

  // pick the images that have a tag
  await row(page, 'outdoors').getByTestId('freq-locate').click()
  await expect(page.getByTestId('bulk-scope')).toHaveText('For the 10 picked')
  await page.getByTestId('edit-pick-clear').click()
  await expect(page.getByTestId('bulk-scope')).toHaveText('For all 40')

  // a tag every image has: nothing was nearly missed
  await row(page, '1girl').getByTestId('freq-missed').click()
  await expect(page.getByTestId('freq-missed-box')).toContainText('No image came close')

  // blush on one caption (so it has a row); the stored scores say five more nearly had it
  await page.getByTestId('edit-item').nth(0).click()
  await page.getByTestId('bulk-tags').fill('blush')
  await page.getByTestId('bulk-add').click()
  await expect(row(page, 'blush')).toBeVisible()
  await page.getByTestId('edit-pick-clear').click()
  await row(page, 'blush').getByTestId('freq-missed').click()
  await expect(page.getByTestId('freq-missed-count')).toContainText('the 5')
  await page.getByTestId('freq-missed-add').click()
  await expect(row(page, 'blush')).toContainText('6')
  const now = await heads(page)
  for (const id of ids.slice(COUNT - 5)) expect(now.get(id)?.active_revision?.content.booru_caption).toContain('blush')
  expect(libraryTags(), 'found tags go into captions only').toBe(tagsBefore)
})

for (const viewport of VIEWPORTS) {
  test(`bulk mode fits at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport)
    await openBulk(page)
    for (const id of ['edit-list', 'freq-table', 'bulk-panel', 'bulk-scope', 'bulk-tags', 'freq-traits', 'edit-mode-one']) {
      await expect(page.getByTestId(id)).toBeInViewport()
    }
    await expect(row(page, '1girl').getByTestId('freq-missed')).toBeInViewport({ ratio: 1 })
    expect(await pageOverflow(page)).toBeLessThanOrEqual(0)
    for (const id of ['freq-table', 'bulk-panel', 'edit-list']) {
      expect(await page.getByTestId(id).evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0)
    }
  })
}
