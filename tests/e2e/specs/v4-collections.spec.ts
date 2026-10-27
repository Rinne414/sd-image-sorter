import { expect, test, type Page } from '../fixtures/click-ledger'

import { cleanupImages, dbPath, pageOverflow, runBackendScript, seedImages } from '../fixtures/v4-seed'

/**
 * Classic adds dataset images to a collection; in V Opus a batch is the group of
 * images (classic collections open as batches), so a batch's pick step sends its
 * selected images into another batch: a new one, a template or a recent one.
 *
 * Needs the V4 build: `cd frontend-v4 && npm ci && npm run build`.
 */

test.describe.configure({ mode: 'serial' })

const PREFIX = 'v4col-'
const TOKEN = 'v4coltoken'
const DIR = 'v4-col'
const NAME = 'v4col'

let ids: number[] = []

function seededIds(): number[] {
  const out = runBackendScript(`
import json, sqlite3
with sqlite3.connect(${JSON.stringify(dbPath)}) as conn:
    rows = conn.execute("SELECT id FROM images WHERE filename LIKE ? ORDER BY id", (${JSON.stringify(PREFIX + '%')},)).fetchall()
print(json.dumps([r[0] for r in rows]))
`)
  return JSON.parse(out.trim().split('\n').pop() ?? '[]') as number[]
}

function cleanupBatches(): void {
  runBackendScript(`
import sqlite3
with sqlite3.connect(${JSON.stringify(dbPath)}) as conn:
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("DELETE FROM batches WHERE name LIKE ?", (${JSON.stringify(NAME + '%')},))
    conn.commit()
print("ok")
`)
}

test.beforeAll(() => {
  cleanupBatches()
  seedImages({ prefix: PREFIX, token: TOKEN, count: 3, dir: DIR })
  ids = seededIds()
  expect(ids).toHaveLength(3)
})

test.afterAll(() => {
  cleanupBatches()
  cleanupImages(PREFIX, [DIR])
})

async function newBatch(page: Page, name: string, imageIds: number[]): Promise<number> {
  const res = await page.request.post('/api/batches', { data: { kind: 'custom', name, image_ids: imageIds } })
  expect(res.status()).toBe(201)
  return ((await res.json()).batch as { id: number }).id
}

async function itemsOf(page: Page, batchId: number): Promise<number[]> {
  const res = await page.request.get(`/api/batches/${batchId}`)
  return ((await res.json()).items as { image_id: number }[]).map((item) => item.image_id)
}

async function openBatch(page: Page, batchId: number, lang: 'en' | 'zh-CN'): Promise<void> {
  await page.addInitScript((l) => {
    if (!localStorage.getItem('sd-image-sorter-lang')) localStorage.setItem('sd-image-sorter-lang', l)
    localStorage.setItem('sd-v4-update-autocheck', '0')
  }, lang)
  await page.goto(`/vopus/#/batch/${batchId}`)
  await expect(page.getByTestId('pick-tile')).toHaveCount(3)
}

test('the selected images of a batch go into another batch', async ({ page }) => {
  const source = await newBatch(page, `${NAME} source`, ids)
  const target = await newBatch(page, `${NAME} target`, [])
  await openBatch(page, source, 'en')

  await page.getByTestId('pick-select-all').click()
  await expect(page.getByTestId('pick-selected')).toHaveText('3 selected')
  const menu = page.getByTestId('pick-add-to-batch')
  await expect(menu).toHaveText(/Add to batch/)
  await menu.click()
  // The batch on screen is not offered as a place to add its own images.
  await expect(page.locator(`[data-item="batch-add-${source}"]`)).toHaveCount(0)
  await page.locator(`[data-item="batch-add-${target}"]`).click()

  await expect.poll(() => itemsOf(page, target)).toEqual(ids)
  // The source batch keeps its images.
  expect(await itemsOf(page, source)).toEqual(ids)
})

test('the pick bar keeps the new menu on one line at every desktop size, in both languages', async ({ page }) => {
  const source = await newBatch(page, `${NAME} fit`, ids)
  await openBatch(page, source, 'en')
  for (const lang of ['en', 'zh-CN'] as const) {
    if (lang !== 'en') {
      await page.evaluate((l) => localStorage.setItem('sd-image-sorter-lang', l), lang)
      await page.reload()
      await expect(page.getByTestId('pick-tile')).toHaveCount(3)
    }
    await page.getByTestId('pick-select-all').click()
    await expect(page.getByTestId('pick-add-to-batch')).toHaveText(lang === 'en' ? /Add to batch/ : /加入批次/)
    for (const [width, height] of [[1366, 768], [1920, 1080], [2560, 1440]] as const) {
      await page.setViewportSize({ width, height })
      // The top bar measures which places fit after a resize; let it settle.
      await expect.poll(() => pageOverflow(page), { message: `${lang} ${width}px` }).toBeLessThanOrEqual(0)
      const bar = await page.getByTestId('pick-bar').boundingBox()
      const button = await page.getByTestId('pick-add-to-batch').boundingBox()
      expect(bar && button, `${lang} ${width}px`).toBeTruthy()
      // inside the bar, not wrapped below it
      expect(button!.y + button!.height, `${lang} ${width}px`).toBeLessThanOrEqual(bar!.y + bar!.height + 1)
    }
  }
})
