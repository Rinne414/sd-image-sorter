import { expect, test, type Page } from '@playwright/test'

import { cleanupImages, dbPath, pageOverflow, runBackendScript, seedImages, VIEWPORTS } from '../fixtures/v4-seed'

/**
 * V4 dataset settings (slice 3c): one strip per dataset batch; the final
 * caption preview follows every change at once; the trigger leads each
 * caption and a replaced trigger disappears from all of them; the purpose's
 * categories and the blacklist are taken out; the saved settings are ones
 * V3.5 reads back (its strict GET succeeds); the panel fits every desktop size.
 *
 * Needs the V4 build: `cd frontend-v4 && npm ci && npm run build`.
 */

test.describe.configure({ mode: 'serial' })

const TOKEN = 'v4dstoken'
const PREFIX = 'v4dst-'
const COUNT = 3
const DIR = 'v4-dst'
const NAME = 'v4dst'

let batchId = 0
let projectId = 0

function seedTags(): void {
  runBackendScript(`
import sqlite3
with sqlite3.connect(${JSON.stringify(dbPath)}) as conn:
    ids = [r[0] for r in conn.execute("SELECT id FROM images WHERE filename LIKE ?", (${JSON.stringify(PREFIX + '%')},))]
    for image_id in ids:
        conn.execute("DELETE FROM tags WHERE image_id = ?", (image_id,))
        for tag, conf in (("1girl", 0.95), ("long_hair", 0.9), ("smile", 0.8), ("watermark", 0.7), ("outdoors", 0.6)):
            conn.execute("INSERT INTO tags (image_id, tag, confidence) VALUES (?, ?, ?)", (image_id, tag, conf))
    conn.commit()
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
    conn.execute("DELETE FROM tags WHERE image_id IN (SELECT id FROM images WHERE filename LIKE ?)", (${JSON.stringify(PREFIX + '%')},))
    conn.commit()
print("ok")
`)
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
    if (sessionStorage.getItem('v4e2e-init-dst')) return
    sessionStorage.setItem('v4e2e-init-dst', '1')
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

interface V35Project {
  settings: {
    target_model: string
    caption_render: { trigger: string; blacklist: string[]; common_tags: string[]; template: { template_override: string; max_tags: number } }
  }
}

const v35 = async (page: Page) => {
  const res = await apiJson<V35Project>(page, `/api/dataset/projects/${projectId}`)
  expect(res.status, 'V3.5 reads the saved settings with its strict model').toBe(200)
  return res.body.settings
}

const captions = (page: Page) => page.getByTestId('preview-caption').allTextContents()
const firstTokens = async (page: Page) => (await captions(page)).map((c) => c.split(',')[0]?.trim())

async function setTrigger(page: Page, value: string): Promise<void> {
  const input = page.getByTestId('dataset-trigger')
  await input.fill(value)
  await input.press('Enter')
}

async function saved(page: Page): Promise<void> {
  await expect(page.getByTestId('dataset-settings-state')).toHaveText('Saved', { timeout: 10_000 })
}

test('a dataset batch opens with its settings strip', async ({ page }) => {
  await openV4(page, '#/batch')
  const ids = runBackendScript(`
import sqlite3
with sqlite3.connect(${JSON.stringify(dbPath)}) as conn:
    print(",".join(str(r[0]) for r in conn.execute("SELECT id FROM images WHERE filename LIKE ? ORDER BY filename", (${JSON.stringify(PREFIX + '%')},))))
`).split(/\s+/).at(-1)!.split(',').map(Number)
  const made = await apiJson<{ batch: { id: number; dataset_project_id: number } }>(page, '/api/batches', {
    method: 'POST',
    body: { kind: 'dataset', name: `${NAME} set`, image_ids: ids },
  })
  expect(made.status).toBe(201)
  batchId = made.body.batch.id
  projectId = made.body.batch.dataset_project_id

  await page.setViewportSize({ width: 1366, height: 768 })
  await openV4(page, `#/batch/${batchId}`)
  const strip = page.getByTestId('dataset-settings-strip')
  await expect(strip).toContainText('No trigger word yet')
  await expect(strip).toContainText('Base model')
})

test('the preview follows each change: trigger first, a replaced trigger gone, blacklist and categories out', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await openV4(page, `#/batch/${batchId}`)
  await page.getByTestId('dataset-settings-open').click()
  const panel = page.getByTestId('dataset-settings-panel')
  await expect(panel).toBeVisible()
  await expect(page.getByTestId('dataset-trigger')).toBeFocused()
  await expect(page.getByTestId('preview-caption')).toHaveCount(COUNT)
  expect((await captions(page)).join(' ')).toContain('watermark')

  // the trigger leads every caption, while typing already
  await page.getByTestId('dataset-trigger').fill('dsxchar')
  await expect.poll(() => firstTokens(page)).toEqual(['dsxchar', 'dsxchar', 'dsxchar'])
  await page.getByTestId('dataset-trigger').press('Enter')
  await saved(page)
  expect((await v35(page)).caption_render.trigger).toBe('dsxchar')

  // the blacklist takes a tag out of every caption
  await page.getByTestId('dataset-blacklist').fill('watermark')
  await expect.poll(async () => (await captions(page)).some((c) => c.includes('watermark'))).toBe(false)
  await saved(page)
  expect((await v35(page)).caption_render.blacklist).toEqual(['watermark'])

  // a new trigger: the old one is on the blacklist and in no caption
  await setTrigger(page, 'dsxnew')
  await expect(page.getByTestId('dataset-old-trigger')).toContainText('dsxchar')
  await expect.poll(() => firstTokens(page)).toEqual(['dsxnew', 'dsxnew', 'dsxnew'])
  expect((await captions(page)).some((c) => c.includes('dsxchar'))).toBe(false)
  await saved(page)
  const afterTrigger = await v35(page)
  expect(afterTrigger.caption_render.trigger).toBe('dsxnew')
  expect(afterTrigger.caption_render.blacklist).toEqual(['watermark', 'dsxchar'])

  // a character LoRA leaves character tags (1girl) out; the choice is the batch's
  await page.getByTestId('dataset-purpose').selectOption('character')
  await expect(page.locator('[data-cat="character"]')).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(async () => (await captions(page)).some((c) => c.includes('1girl'))).toBe(false)
  // body tags (long hair) go with a character LoRA; expressions stay
  expect((await captions(page)).every((c) => c.includes('smile') && !c.includes('long hair'))).toBe(true)
  await saved(page)
  const batch = await apiJson<{ settings: { dataset?: { training_purpose: string; remove_categories: string[] } } }>(page, `/api/batches/${batchId}`)
  expect(batch.body.settings.dataset?.training_purpose).toBe('character')
  expect(batch.body.settings.dataset?.remove_categories).toContain('character')

  // max tags and the base model are V3.5 settings too
  await page.getByTestId('dataset-max-tags').fill('2')
  await page.getByTestId('dataset-model').selectOption('anima')
  await expect(page.getByTestId('dataset-template')).toHaveValue(/\{quality\}, \{safety\}/)
  await expect.poll(() => firstTokens(page)).toEqual(['dsxnew', 'dsxnew', 'dsxnew'])
  await saved(page)
  const afterModel = await v35(page)
  expect(afterModel.target_model).toBe('anima')
  expect(afterModel.caption_render.template.max_tags).toBe(2)
  expect(afterModel.caption_render.template.template_override).toContain('{quality}')

  // Esc closes the panel only; the strip shows what was set
  await page.keyboard.press('Escape')
  await expect(panel).toHaveCount(0)
  await expect(page.getByTestId('batch-view')).toBeVisible()
  await expect(page.getByTestId('dataset-settings-summary')).toContainText('dsxnew')
  await expect(page.getByTestId('dataset-settings-summary')).toContainText('Anima')
})

test('a trigger the backend would refuse is named and not saved', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await openV4(page, `#/batch/${batchId}`)
  await page.getByTestId('dataset-settings-open').click()
  await setTrigger(page, 'two, words')
  await expect(page.getByTestId('dataset-settings-form')).toContainText('The trigger is one word: no commas.')
  await expect(page.getByTestId('dataset-trigger')).toHaveAttribute('aria-invalid', 'true')
  expect((await v35(page)).caption_render.trigger).toBe('dsxnew')
})

test('a trigger typed and then left with Esc still counts', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await openV4(page, `#/batch/${batchId}`)
  await page.getByTestId('dataset-settings-open').click()
  await page.getByTestId('dataset-trigger').fill('dsxesc')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('dataset-settings-panel')).toHaveCount(0)
  await saved(page)
  const settings = await v35(page)
  expect(settings.caption_render.trigger).toBe('dsxesc')
  expect(settings.caption_render.blacklist).toContain('dsxnew')
})

for (const viewport of VIEWPORTS) {
  test(`the settings panel fits at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport)
    await openV4(page, `#/batch/${batchId}`)
    await expect(page.getByTestId('dataset-settings-open')).toBeInViewport({ ratio: 1 })
    expect(await pageOverflow(page)).toBeLessThanOrEqual(0)
    await page.getByTestId('dataset-settings-open').click()
    await expect(page.getByTestId('preview-caption')).toHaveCount(COUNT)
    for (const id of ['dataset-trigger', 'dataset-model', 'dataset-purpose', 'dataset-settings-open']) {
      await expect(page.getByTestId(id)).toBeInViewport({ ratio: 1 })
    }
    expect(await pageOverflow(page)).toBeLessThanOrEqual(0)
    const strip = page.getByTestId('dataset-settings-strip')
    expect(await strip.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0)
  })
}
