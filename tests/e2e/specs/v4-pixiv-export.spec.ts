import fs from 'node:fs'
import path from 'node:path'

import { expect, test, type Page } from '@playwright/test'

import { dbPath, pageOverflow, runBackendScript, tmpRoot } from '../fixtures/v4-seed'

/**
 * V4 Pixiv batch, Order -> Name -> Export, with a REAL export into a temp
 * folder: three images whose files carry generation data (PNG text chunks,
 * EXIF UserComment, XMP; one JPEG), two of them censored through the API.
 * Reorder by keys and by drag, name with a template (a duplicate blocks
 * "next"), export: blocked with the missing one listed, "leave out" writes
 * two files with the right names and no generation data whose pixels are the
 * censored copies; "export originals" needs a second confirm and still strips.
 *
 * Needs the V4 build: `cd frontend-v4 && npm ci && npm run build`.
 */

test.describe.configure({ mode: 'serial' })

const PREFIX = 'v4pxe-'
const DIR = 'v4-pxe'
const NAME = 'v4pxe'
const OUT = path.join(tmpRoot, DIR, 'out')
const MARKER = 'secret_prompt_marker_7f3a'

let ids: number[] = []
let batchId = 0
const nameOf: Record<number, string> = {}

/** a.png, b.png (PNG text chunks + EXIF + XMP), c.jpg (EXIF UserComment + XMP); censored PNGs of a and c. */
function seed(): number[] {
  const out = runBackendScript(`
import shutil, sqlite3, sys
from pathlib import Path
sys.path.insert(0, "backend")
from tests.batch_fixtures import gradient_image, write_jpeg_with_generation_data, write_png_with_generation_data

root = Path(${JSON.stringify(path.join(tmpRoot, DIR))})
shutil.rmtree(root, ignore_errors=True)
(root / "out").mkdir(parents=True, exist_ok=True)
prefix = ${JSON.stringify(PREFIX)}
files = [
    write_png_with_generation_data(root / f"{prefix}a.png", 1),
    write_png_with_generation_data(root / f"{prefix}b.png", 2),
    write_jpeg_with_generation_data(root / f"{prefix}c.jpg", 3),
]
for name, seed in (("a", 1), ("c", 3)):
    censored = gradient_image(seed)
    censored.paste((0, 0, 0), (2, 2, 38, 28))
    censored.save(root / f"censored-{name}.png")
ids = []
with sqlite3.connect(${JSON.stringify(dbPath)}) as conn:
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("DELETE FROM batches WHERE name LIKE ?", (${JSON.stringify(NAME + '%')},))
    conn.execute("DELETE FROM images WHERE filename LIKE ?", (prefix + "%",))
    for path in files:
        path = path.resolve()
        cur = conn.execute(
            """INSERT INTO images (path, filename, generator, prompt, metadata_json, width, height, file_size,
                   source_size, source_mtime_ns, is_readable, metadata_status, created_at, library_order_time, user_rating)
               VALUES (?, ?, 'nai', 'v4pxetoken', '{}', 40, 30, ?, ?, ?, 1, 'complete', datetime('now'), datetime('now'), 0)""",
            (str(path), path.name, path.stat().st_size, path.stat().st_size, path.stat().st_mtime_ns),
        )
        ids.append(cur.lastrowid)
    conn.commit()
print(" ".join(str(i) for i in ids))
`)
  return (out.split('\n').at(-1) ?? '').trim().split(' ').map(Number)
}

function cleanup(): void {
  runBackendScript(`
import shutil, sqlite3
from pathlib import Path
with sqlite3.connect(${JSON.stringify(dbPath)}) as conn:
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("DELETE FROM batches WHERE name LIKE ?", (${JSON.stringify(NAME + '%')},))
    conn.execute("DELETE FROM images WHERE filename LIKE ?", (${JSON.stringify(PREFIX + '%')},))
    conn.commit()
shutil.rmtree(Path(${JSON.stringify(path.join(tmpRoot, DIR))}), ignore_errors=True)
print("ok")
`)
}

/**
 * Mean absolute pixel difference of an exported file against a picture:
 * {"censored": ..., "original": ...} per file (Pillow, RGB).
 */
function pixelDiffs(pairs: { file: string; censored: string | null; original: string }[]): { censored: number | null; original: number }[] {
  const out = runBackendScript(`
import json
from PIL import Image, ImageChops, ImageStat
pairs = json.loads(${JSON.stringify(JSON.stringify(pairs))})
def mad(a, b):
    with Image.open(a) as x, Image.open(b) as y:
        diff = ImageChops.difference(x.convert("RGB"), y.convert("RGB"))
        return sum(ImageStat.Stat(diff).mean) / 3
print(json.dumps([{"censored": mad(p["file"], p["censored"]) if p["censored"] else None, "original": mad(p["file"], p["original"])} for p in pairs]))
`)
  return JSON.parse(out.split('\n').at(-1) ?? '[]')
}

/** Every metadata carrier in a PNG or JPEG file, and whether the prompt marker appears anywhere in its bytes. */
function metadataOf(file: string): { carriers: string[]; marker: boolean } {
  const bytes = fs.readFileSync(file)
  const carriers: string[] = []
  if (bytes.subarray(1, 4).toString('latin1') === 'PNG') {
    let at = 8
    while (at + 8 <= bytes.length) {
      const length = bytes.readUInt32BE(at)
      const type = bytes.subarray(at + 4, at + 8).toString('latin1')
      if (['tEXt', 'iTXt', 'zTXt', 'eXIf'].includes(type)) carriers.push(type)
      at += 12 + length
    }
  } else {
    let at = 2
    while (at + 4 <= bytes.length && bytes[at] === 0xff) {
      const marker = bytes[at + 1] as number
      if (marker === 0xda) break
      const length = bytes.readUInt16BE(at + 2)
      const head = bytes.subarray(at + 4, at + 4 + 29).toString('latin1')
      if (marker === 0xe1) carriers.push(head.startsWith('Exif') ? 'Exif' : head.startsWith('http://ns.adobe.com/xap') ? 'XMP' : 'APP1')
      if (marker === 0xfe) carriers.push('COM')
      at += 2 + length
    }
  }
  return { carriers, marker: bytes.includes(Buffer.from(MARKER)) }
}

function watchErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console: ${msg.text()}`)
  })
  page.on('pageerror', (err) => errors.push(`page: ${err.message}`))
  page.on('response', (res) => {
    if (res.status() >= 400 && new URL(res.url()).pathname.startsWith('/api/')) errors.push(`${res.status()} ${res.url()}`)
  })
  return errors
}

async function openBatch(page: Page): Promise<void> {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('v4e2e-init-pxe')) return
    sessionStorage.setItem('v4e2e-init-pxe', '1')
    localStorage.setItem('sd-image-sorter-lang', 'en')
    localStorage.setItem('sd-v4-theme', 'dark')
    localStorage.removeItem('sd-v4-pixiv-export')
  })
  const res = await page.goto(`/v4/#/batch/${batchId}`, { waitUntil: 'domcontentloaded' })
  expect(res?.status(), 'V4 is not built: run npm run build in frontend-v4').toBe(200)
  await expect(page.getByTestId('batch-view')).toBeVisible()
}

async function apiOrder(page: Page): Promise<number[]> {
  const batch = (await (await page.request.get(`/api/batches/${batchId}`)).json()) as { items: { image_id: number }[] }
  return batch.items.map((item) => item.image_id)
}

async function tileIds(page: Page): Promise<number[]> {
  return page.getByTestId('order-tile').evaluateAll((tiles) => tiles.map((t) => Number(t.getAttribute('data-id'))))
}

test.beforeAll(() => {
  cleanup()
  ids = seed()
  expect(ids).toHaveLength(3)
  ;['a.png', 'b.png', 'c.jpg'].forEach((file, i) => (nameOf[ids[i] as number] = `${PREFIX}${file}`))
})

test.afterAll(() => cleanup())

test('a Pixiv batch with two of three images censored through the API', async ({ page }) => {
  const created = await page.request.post('/api/batches', { data: { kind: 'pixiv', name: `${NAME} Set`, image_ids: ids } })
  expect(created.status()).toBe(201)
  const batch = (await created.json()).batch as { id: number; revision: number }
  batchId = batch.id
  const [a, , c] = ids as [number, number, number]
  for (const [id, file] of [
    [a, 'censored-a.png'],
    [c, 'censored-c.png'],
  ] as const) {
    const data = fs.readFileSync(path.join(tmpRoot, DIR, file)).toString('base64')
    const put = await page.request.put(`/api/batches/${batchId}/items/${id}/censored`, { data: { image_data: `data:image/png;base64,${data}` } })
    expect(put.ok()).toBe(true)
  }
  const patched = await page.request.patch(`/api/batches/${batchId}`, { data: { revision: batch.revision, current_step: 'order' } })
  expect(patched.ok()).toBe(true)
})

test('order: numbers and badges, reorder by Alt+keys and by drag, saved in the batch', async ({ page }) => {
  const errors = watchErrors(page)
  await page.setViewportSize({ width: 1366, height: 768 })
  await openBatch(page)
  const [a, b, c] = ids as [number, number, number]
  await expect(page.getByTestId('order-tile')).toHaveCount(3)
  await expect(page.getByTestId('order-number')).toHaveText(['1', '2', '3'])
  const tile = (id: number) => page.locator(`[data-testid="order-tile"][data-id="${id}"]`)
  await expect(tile(a).getByTestId('badge-censored')).toBeVisible()
  await expect(tile(b).getByTestId('badge-missing')).toBeVisible()
  await expect(tile(c).getByTestId('badge-censored')).toBeVisible()
  // the censored copy is what the tile shows
  await expect(tile(a).locator('img[data-censored]')).toHaveAttribute('src', /^blob:/)

  await tile(c).click()
  await page.keyboard.press('Alt+Home')
  await expect.poll(() => tileIds(page)).toEqual([c, a, b])
  await expect.poll(() => apiOrder(page)).toEqual([c, a, b])
  await page.keyboard.press('Alt+ArrowRight')
  await expect.poll(() => tileIds(page)).toEqual([a, c, b])
  await page.keyboard.press('Alt+ArrowLeft')
  await expect.poll(() => tileIds(page)).toEqual([c, a, b])
  // arrows without Alt only move the selection
  await page.keyboard.press('ArrowRight')
  await expect(tile(a)).toHaveAttribute('aria-selected', 'true')
  expect(await tileIds(page)).toEqual([c, a, b])

  // drag b onto the left half of a: [c, b, a]; then Alt+ArrowRight puts b back last
  const box = await tile(a).boundingBox()
  if (!box) throw new Error('no tile box')
  await tile(b).dragTo(tile(a), { targetPosition: { x: 10, y: box.height / 2 } })
  await expect.poll(() => tileIds(page)).toEqual([c, b, a])
  await expect(tile(b)).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Alt+ArrowRight')
  await expect.poll(() => tileIds(page)).toEqual([c, a, b])
  await expect.poll(() => apiOrder(page)).toEqual([c, a, b])
  await expect(page.getByTestId('order-number')).toHaveText(['1', '2', '3'])

  // the page never went back in history on Alt+arrows
  expect(page.url()).toContain(`#/batch/${batchId}`)
  expect(await pageOverflow(page)).toBeLessThanOrEqual(0)
  await expect(page.getByTestId('step-next')).toBeInViewport()
  expect(errors).toEqual([])
})

test('name: template preview matches, a duplicate (any case) blocks next, own names can be cleared', async ({ page }) => {
  const errors = watchErrors(page)
  await page.setViewportSize({ width: 1366, height: 768 })
  await openBatch(page)
  await page.getByTestId('step-next').click()
  await expect(page.getByTestId('name-step')).toBeVisible()
  const [a, b, c] = ids as [number, number, number]
  const finalOf = (id: number) => page.locator(`[data-testid="name-row"][data-id="${id}"]`).getByTestId('name-final')

  // default template {batch}_{n:02}
  await expect(page.getByTestId('name-template')).toHaveValue('{batch}_{n:02}')
  await expect(finalOf(c)).toHaveText(`${NAME} Set_01.jpg`)

  await page.getByTestId('name-template').fill('post-')
  await page.getByTestId('name-token').filter({ hasText: '{n:02}' }).click()
  await expect(page.getByTestId('name-template')).toHaveValue('post-{n:02}')
  await expect(finalOf(c)).toHaveText('post-01.jpg')
  await expect(finalOf(a)).toHaveText('post-02.png')
  await expect(finalOf(b)).toHaveText('post-03.png')

  // an unknown token is named and blocks next
  await page.getByTestId('name-template').fill('post-{index}')
  await expect(page.getByTestId('name-template-problem')).toContainText('{index}')
  await expect(page.getByTestId('step-next')).toBeDisabled()
  await page.getByTestId('name-template').fill('post-{n:02}')
  await expect(finalOf(b)).toHaveText('post-03.png')

  // b's own name "POST-02" collides with a's "post-02.png"
  await finalOf(b).click()
  await page.getByTestId('inline-name').fill('POST-02')
  await page.getByTestId('inline-name').press('Enter')
  await expect(finalOf(b)).toHaveText('POST-02.png')
  const rowOf = (id: number) => page.locator(`[data-testid="name-row"][data-id="${id}"]`)
  await expect(rowOf(a)).toHaveAttribute('data-duplicate', 'true')
  await expect(rowOf(b)).toHaveAttribute('data-duplicate', 'true')
  await expect(page.getByTestId('name-blocked')).toBeVisible()
  await expect(page.getByTestId('step-next')).toBeDisabled()

  await rowOf(b).getByTestId('name-clear').click()
  await expect(finalOf(b)).toHaveText('post-03.png')
  await expect(rowOf(a)).not.toHaveAttribute('data-duplicate', 'true')
  await expect(page.getByTestId('step-next')).toBeEnabled()
  const saved = (await (await page.request.get(`/api/batches/${batchId}`)).json()) as { items: { image_id: number; output_name: string | null }[] }
  expect(saved.items.find((i) => i.image_id === b)?.output_name).toBeNull()
  expect(await pageOverflow(page)).toBeLessThanOrEqual(0)
  expect(errors).toEqual([])
})

test('export: blocked with the missing one listed, "leave out" writes 2 clean files that are the censored copies', async ({ page }) => {
  const errors = watchErrors(page)
  await page.setViewportSize({ width: 1366, height: 768 })
  await openBatch(page)
  // the batch reopens at the step it was left on
  await expect(page.getByTestId('name-step')).toBeVisible()
  // the template was saved with the batch
  await expect(page.getByTestId('name-template')).toHaveValue('post-{n:02}')
  await page.getByTestId('step-next').click()
  await expect(page.getByTestId('export-step')).toBeVisible()
  const b = ids[1] as number

  // the server refuses an export with a missing copy, naming it, and writes nothing
  const refused = await page.request.post(`/api/batches/${batchId}/export`, { data: { output_folder: OUT, name_template: 'post-{n:02}' } })
  expect(refused.status()).toBe(409)
  expect((await refused.json()).missing).toEqual([{ image_id: b, filename: nameOf[b] }])
  expect(fs.readdirSync(OUT)).toEqual([])

  await expect(page.getByTestId('export-meta-strip')).toBeChecked()
  await expect(page.getByTestId('count-censored')).toHaveText('2 / 3')
  await expect(page.getByTestId('count-missing')).toHaveText('1')
  await expect(page.getByTestId('missing-names')).toHaveText(nameOf[b] as string)
  await expect(page.getByTestId('export-run')).toHaveCount(0)
  await expect(page.getByTestId('preflight-censor')).toBeVisible()
  await expect(page.getByTestId('preflight-skip')).toBeDisabled()

  await page.getByTestId('export-choose-folder').click()
  const chooser = page.getByTestId('export-folder-picker')
  const pathInput = chooser.getByTestId('folder-path')
  await pathInput.fill(OUT)
  await pathInput.press('Enter')
  await expect(pathInput).toHaveValue(OUT)
  await chooser.getByRole('button', { name: 'Use this folder' }).click()
  await expect(chooser).toHaveCount(0)
  await expect(page.getByTestId('export-folder')).toHaveText(OUT)

  await expect(page.getByTestId('preflight-skip')).toHaveText('Leave them out, export the other 2')
  await page.getByTestId('preflight-skip').click()
  const result = page.getByTestId('export-result')
  await expect(result).toBeVisible({ timeout: 30_000 })
  await expect(result.getByTestId('result-row')).toHaveCount(2)
  await expect(result.getByTestId('result-row').nth(0)).toContainText('post-01.jpg')
  await expect(result.getByTestId('result-row').nth(1)).toContainText('post-02.png')
  await expect(result.getByTestId('result-meta')).toHaveText(['Removed', 'Removed'])
  await expect(result.getByTestId('result-skipped')).toContainText(nameOf[b] as string)
  await expect(result.getByTestId('result-folder')).toHaveText(OUT)

  expect(fs.readdirSync(OUT).sort()).toEqual(['post-01.jpg', 'post-02.png'])
  for (const file of ['post-01.jpg', 'post-02.png']) {
    expect(metadataOf(path.join(OUT, file)), file).toEqual({ carriers: [], marker: false })
  }
  const lib = path.join(tmpRoot, DIR)
  const [jpg, png] = pixelDiffs([
    { file: path.join(OUT, 'post-01.jpg'), censored: path.join(lib, 'censored-c.png'), original: path.join(lib, `${PREFIX}c.jpg`) },
    { file: path.join(OUT, 'post-02.png'), censored: path.join(lib, 'censored-a.png'), original: path.join(lib, `${PREFIX}a.png`) },
  ])
  expect(png?.censored).toBe(0)
  expect(png?.original).toBeGreaterThan(20)
  // JPEG is lossy (small picture, hard edges): near the censored copy, far from the original
  expect(jpg?.censored).toBeLessThan(8)
  expect(jpg?.original).toBeGreaterThan(8 * (jpg?.censored ?? 0))
  expect(await pageOverflow(page)).toBeLessThanOrEqual(0)
  expect(errors).toEqual([])
})

test('export originals needs a second confirm (focus on Cancel) and still removes generation data', async ({ page }) => {
  const errors = watchErrors(page)
  await page.setViewportSize({ width: 1366, height: 768 })
  await openBatch(page)
  await page.getByTestId('rail-step').and(page.locator('[data-step-id="export"]')).click()
  await expect(page.getByTestId('export-step')).toBeVisible()
  // settings came back with the batch
  await expect(page.getByTestId('export-folder')).toHaveText(OUT)
  await page.getByTestId('export-overwrite').check()

  await page.getByTestId('preflight-originals').click()
  const dialog = page.getByTestId('originals-dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('Generation data is still removed.')
  await expect(page.getByTestId('originals-cancel')).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(page.getByTestId('export-result')).toHaveCount(0)

  await page.getByTestId('preflight-originals').click()
  await page.getByTestId('originals-ok').click()
  const result = page.getByTestId('export-result')
  await expect(result).toBeVisible({ timeout: 30_000 })
  await expect(result.getByTestId('result-row')).toHaveCount(3)
  await expect(result.locator('[data-testid="result-row"][data-source="original"]')).toHaveCount(1)
  await expect(result.locator('[data-testid="result-row"][data-source="original"]')).toContainText('post-03.png')
  await expect(result.getByTestId('result-meta')).toHaveText(['Removed', 'Removed', 'Removed'])

  expect(fs.readdirSync(OUT).sort()).toEqual(['post-01.jpg', 'post-02.png', 'post-03.png'])
  for (const file of fs.readdirSync(OUT)) expect(metadataOf(path.join(OUT, file)), file).toEqual({ carriers: [], marker: false })
  const lib = path.join(tmpRoot, DIR)
  const [orig] = pixelDiffs([{ file: path.join(OUT, 'post-03.png'), censored: null, original: path.join(lib, `${PREFIX}b.png`) }])
  expect(orig?.original).toBe(0)
  expect(errors).toEqual([])
})
