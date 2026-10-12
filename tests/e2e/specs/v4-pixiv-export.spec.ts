import fs from 'node:fs'
import path from 'node:path'

import { expect, test, type Page } from '../fixtures/click-ledger'

import { dbPath, pageOverflow, runBackendScript, tmpRoot } from '../fixtures/v4-seed'
import { PY_DELETE_IMAGES } from '../fixtures/e2e-db'

/**
 * V4 Pixiv batch, Order -> Name -> Export, with a REAL export into a temp
 * folder: three images whose files carry generation data (PNG text chunks,
 * EXIF UserComment, XMP; one JPEG), two of them censored through the API.
 * Reorder by keys and by drag, name with a template (a duplicate blocks
 * "next"), export: blocked with the missing one listed, "leave out" writes
 * two files with the right names and no generation data whose pixels are the
 * censored copies; "export originals" needs a second confirm and still strips.
 * A second batch of six orders several selected images together (buttons,
 * drag, Ctrl+Z back to the saved order) and filters them by name and by a
 * library condition.
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
/** Three more images (d, e, f; d and f made by ComfyUI) for the six-image order batch. */
let more: number[] = []
let batchId = 0
let orderBatchId = 0
const nameOf: Record<number, string> = {}

/** a.png, b.png (PNG text chunks + EXIF + XMP), c.jpg (EXIF UserComment + XMP); censored PNGs of a and c; then d, e, f PNGs. */
function seed(): number[] {
  const out = runBackendScript(`
${PY_DELETE_IMAGES}
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
    write_png_with_generation_data(root / f"{prefix}d.png", 4),
    write_png_with_generation_data(root / f"{prefix}e.png", 5),
    write_png_with_generation_data(root / f"{prefix}f.png", 6),
]
generators = ["nai", "nai", "nai", "comfyui", "nai", "comfyui"]
for name, seed in (("a", 1), ("c", 3)):
    censored = gradient_image(seed)
    censored.paste((0, 0, 0), (2, 2, 38, 28))
    censored.save(root / f"censored-{name}.png")
ids = []
with sqlite3.connect(${JSON.stringify(dbPath)}) as conn:
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("DELETE FROM batches WHERE name LIKE ?", (${JSON.stringify(NAME + '%')},))
    delete_images(conn, "filename LIKE ?", (prefix + "%",))
    for path, generator in zip(files, generators):
        path = path.resolve()
        cur = conn.execute(
            """INSERT INTO images (path, filename, generator, prompt, metadata_json, width, height, file_size,
                   source_size, source_mtime_ns, is_readable, metadata_status, created_at, library_order_time, user_rating)
               VALUES (?, ?, ?, 'v4pxetoken', '{}', 40, 30, ?, ?, ?, 1, 'complete', datetime('now'), datetime('now'), 0)""",
            (str(path), path.name, generator, path.stat().st_size, path.stat().st_size, path.stat().st_mtime_ns),
        )
        ids.append(cur.lastrowid)
    conn.commit()
print(" ".join(str(i) for i in ids))
`)
  return (out.split('\n').at(-1) ?? '').trim().split(' ').map(Number)
}

function cleanup(): void {
  runBackendScript(`
${PY_DELETE_IMAGES}
import shutil, sqlite3
from pathlib import Path
with sqlite3.connect(${JSON.stringify(dbPath)}) as conn:
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("DELETE FROM batches WHERE name LIKE ?", (${JSON.stringify(NAME + '%')},))
    delete_images(conn, "filename LIKE ?", (${JSON.stringify(PREFIX + '%')},))
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

async function openBatch(page: Page, id = batchId): Promise<void> {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('v4e2e-init-pxe')) return
    sessionStorage.setItem('v4e2e-init-pxe', '1')
    localStorage.setItem('sd-image-sorter-lang', 'en')
    localStorage.setItem('sd-v4-theme', 'dark')
    localStorage.removeItem('sd-v4-pixiv-export')
  })
  const res = await page.goto(`/v4/#/batch/${id}`, { waitUntil: 'domcontentloaded' })
  expect(res?.status(), 'V4 is not built: run npm run build in frontend-v4').toBe(200)
  await expect(page.getByTestId('batch-view')).toBeVisible()
}

async function apiOrder(page: Page, id = batchId): Promise<number[]> {
  const batch = (await (await page.request.get(`/api/batches/${id}`)).json()) as { items: { image_id: number }[] }
  return batch.items.map((item) => item.image_id)
}

async function tileIds(page: Page): Promise<number[]> {
  return page.getByTestId('order-tile').evaluateAll((tiles) => tiles.map((t) => Number(t.getAttribute('data-id'))))
}

test.beforeAll(() => {
  cleanup()
  const seeded = seed()
  expect(seeded).toHaveLength(6)
  ids = seeded.slice(0, 3)
  more = seeded.slice(3)
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

  // drag b onto the left half of a: [c, b, a]; Alt+ArrowRight and back, it stays in the middle
  const box = await tile(a).boundingBox()
  if (!box) throw new Error('no tile box')
  await tile(b).dragTo(tile(a), { targetPosition: { x: 10, y: box.height / 2 } })
  await expect.poll(() => tileIds(page)).toEqual([c, b, a])
  await expect(tile(b)).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Alt+ArrowRight')
  await expect.poll(() => tileIds(page)).toEqual([c, a, b])
  await page.keyboard.press('Alt+ArrowLeft')
  await expect.poll(() => tileIds(page)).toEqual([c, b, a])
  await expect.poll(() => apiOrder(page)).toEqual([c, b, a])
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
  await expect(finalOf(b)).toHaveText('post-02.png')
  await expect(finalOf(a)).toHaveText('post-03.png')
  // b has no censored copy: the page says its number closes up if it is left out
  await expect(page.getByTestId('name-missing-note')).toContainText('1')
  await expect(page.locator(`[data-testid="name-row"][data-id="${b}"]`).getByTestId('name-no-copy')).toBeVisible()

  // an unknown token is named and blocks next
  await page.getByTestId('name-template').fill('post-{index}')
  await expect(page.getByTestId('name-template-problem')).toContainText('{index}')
  await expect(page.getByTestId('step-next')).toBeDisabled()
  await page.getByTestId('name-template').fill('post-{n:02}')
  await expect(finalOf(a)).toHaveText('post-03.png')

  // a's own name "POST-02" collides with b's "post-02.png"
  await finalOf(a).click()
  await page.getByTestId('inline-name').fill('POST-02')
  await page.getByTestId('inline-name').press('Enter')
  await expect(finalOf(a)).toHaveText('POST-02.png')
  const rowOf = (id: number) => page.locator(`[data-testid="name-row"][data-id="${id}"]`)
  await expect(rowOf(a)).toHaveAttribute('data-duplicate', 'true')
  await expect(rowOf(b)).toHaveAttribute('data-duplicate', 'true')
  await expect(page.getByTestId('name-blocked')).toBeVisible()
  await expect(page.getByTestId('step-next')).toBeDisabled()

  await rowOf(a).getByTestId('name-clear').click()
  await expect(finalOf(a)).toHaveText('post-03.png')
  await expect(rowOf(b)).not.toHaveAttribute('data-duplicate', 'true')
  await expect(page.getByTestId('step-next')).toBeEnabled()
  const saved = (await (await page.request.get(`/api/batches/${batchId}`)).json()) as { items: { image_id: number; output_name: string | null }[] }
  expect(saved.items.find((i) => i.image_id === a)?.output_name).toBeNull()
  expect(await pageOverflow(page)).toBeLessThanOrEqual(0)
  expect(errors).toEqual([])
})

test('export: blocked with the missing one listed, "leave out" confirms the renumbered names and writes exactly those, clean and censored', async ({ page }) => {
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
  // the Name step showed a as post-03.png; left out, the numbers close up and the confirmation says so
  const confirm = page.getByTestId('export-confirm')
  await expect(confirm.getByTestId('export-confirm-body')).toHaveAttribute('data-policy', 'skip')
  await expect(confirm.getByTestId('confirm-name')).toHaveText(['post-01.jpg', 'post-02.png'])
  await expect(confirm.getByTestId('confirm-left-out')).toContainText(nameOf[b] as string)
  await expect(page.getByTestId('export-result')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(confirm).toHaveCount(0)
  expect(fs.readdirSync(OUT)).toEqual([])
  await page.getByTestId('preflight-skip').click()
  await expect(confirm.getByTestId('confirm-name')).toHaveText(['post-01.jpg', 'post-02.png'])
  await confirm.getByTestId('confirm-ok').click()
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

test('export originals: the confirmation lists every final name (focus on Cancel); generation data is still removed', async ({ page }) => {
  const errors = watchErrors(page)
  await page.setViewportSize({ width: 1366, height: 768 })
  await openBatch(page)
  await page.getByTestId('rail-step').and(page.locator('[data-step-id="export"]')).click()
  await expect(page.getByTestId('export-step')).toBeVisible()
  // settings came back with the batch
  await expect(page.getByTestId('export-folder')).toHaveText(OUT)
  await page.getByTestId('export-overwrite').check()

  const b = ids[1] as number
  await page.getByTestId('preflight-originals').click()
  const dialog = page.getByTestId('export-confirm')
  await expect(dialog.getByTestId('export-confirm-body')).toHaveAttribute('data-policy', 'original')
  await expect(dialog).toContainText('Generation data is still removed.')
  await expect(dialog.getByTestId('confirm-name')).toHaveText(['post-01.jpg', 'post-02.png', 'post-03.png'])
  await expect(dialog.locator('[data-testid="confirm-row"][data-source="original"]')).toContainText(nameOf[b] as string)
  await expect(page.getByTestId('confirm-cancel')).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(page.getByTestId('export-result')).toHaveCount(0)

  await page.getByTestId('preflight-originals').click()
  await expect(dialog.getByTestId('confirm-name')).toHaveText(['post-01.jpg', 'post-02.png', 'post-03.png'])
  await page.getByTestId('confirm-ok').click()
  const result = page.getByTestId('export-result')
  await expect(result).toBeVisible({ timeout: 30_000 })
  await expect(result.getByTestId('result-row')).toHaveCount(3)
  await expect(result.locator('[data-testid="result-row"][data-source="original"]')).toHaveCount(1)
  await expect(result.locator('[data-testid="result-row"][data-source="original"]')).toContainText('post-02.png')
  await expect(result.getByTestId('result-meta')).toHaveText(['Removed', 'Removed', 'Removed'])

  expect(fs.readdirSync(OUT).sort()).toEqual(['post-01.jpg', 'post-02.png', 'post-03.png'])
  for (const file of fs.readdirSync(OUT)) expect(metadataOf(path.join(OUT, file)), file).toEqual({ carriers: [], marker: false })
  const lib = path.join(tmpRoot, DIR)
  const [orig, censoredA] = pixelDiffs([
    { file: path.join(OUT, 'post-02.png'), censored: null, original: path.join(lib, `${PREFIX}b.png`) },
    { file: path.join(OUT, 'post-03.png'), censored: path.join(lib, 'censored-a.png'), original: path.join(lib, `${PREFIX}a.png`) },
  ])
  expect(orig?.original).toBe(0)
  expect(censoredA?.censored).toBe(0)
  expect(errors).toEqual([])
})

const orderTile = (page: Page, id: number) => page.locator(`[data-testid="order-tile"][data-id="${id}"]`)
const railStep = (page: Page, id: string) => page.locator(`[data-testid="rail-step"][data-step-id="${id}"]`)

test('order: three selected move to the front together and stay after a reload; a drag carries the selection; Ctrl+Z saves the order back', async ({ page }) => {
  const errors = watchErrors(page)
  await page.setViewportSize({ width: 1366, height: 768 })
  const [a, b, c] = ids as [number, number, number]
  const [d, e, f] = more as [number, number, number]
  const created = await page.request.post('/api/batches', { data: { kind: 'pixiv', name: `${NAME} Order`, image_ids: [a, b, c, d, e, f] } })
  expect(created.status()).toBe(201)
  const made = (await created.json()).batch as { id: number; revision: number }
  orderBatchId = made.id
  expect((await page.request.patch(`/api/batches/${orderBatchId}`, { data: { revision: made.revision, current_step: 'order' } })).ok()).toBe(true)
  await openBatch(page, orderBatchId)
  await expect(page.getByTestId('order-tile')).toHaveCount(6)

  // Ctrl+click f, b, d: they go to the front in their batch order
  for (const id of [f, b, d]) await orderTile(page, id).click({ modifiers: ['Control'] })
  await expect(page.locator('[data-testid="order-tile"][data-selected]')).toHaveCount(3)
  await page.getByTestId('order-top').click()
  const front = [b, d, f, a, c, e]
  await expect.poll(() => tileIds(page)).toEqual(front)
  await expect.poll(() => apiOrder(page, orderBatchId)).toEqual(front)
  await expect(page.getByTestId('order-number')).toHaveText(['1', '2', '3', '4', '5', '6'])

  // dragging one of the three carries all three, dropped after c
  const box = await orderTile(page, c).boundingBox()
  if (!box) throw new Error('no tile box')
  await orderTile(page, f).dragTo(orderTile(page, c), { targetPosition: { x: box.width - 10, y: box.height / 2 } })
  const dragged = [a, c, b, d, f, e]
  await expect.poll(() => tileIds(page)).toEqual(dragged)
  await expect.poll(() => apiOrder(page, orderBatchId)).toEqual(dragged)

  // Ctrl+Z puts the saved order back, not only the view
  await expect(page.getByTestId('order-undo')).toBeEnabled()
  await page.keyboard.press('Control+z')
  await expect.poll(() => tileIds(page)).toEqual(front)
  await expect.poll(() => apiOrder(page, orderBatchId)).toEqual(front)

  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(page.getByTestId('order-tile')).toHaveCount(6)
  await expect.poll(() => tileIds(page)).toEqual(front)
  expect(await pageOverflow(page)).toBeLessThanOrEqual(0)
  await expect(page.getByTestId('step-next')).toBeInViewport()
  expect(errors).toEqual([])
})

test('filters: the name filter narrows Order, Pick and Censor, moves while filtered skip hidden images, a condition selects its matches', async ({ page }) => {
  const errors = watchErrors(page)
  await page.setViewportSize({ width: 1366, height: 768 })
  const [a, b, c] = ids as [number, number, number]
  const [d, e, f] = more as [number, number, number]
  await openBatch(page, orderBatchId)
  await expect.poll(() => tileIds(page)).toEqual([b, d, f, a, c, e])

  await page.getByTestId('batch-name-filter').fill('.png')
  await expect.poll(() => tileIds(page)).toEqual([b, d, f, a, e])
  // the numbers stay the posting places
  await expect(page.getByTestId('order-number')).toHaveText(['1', '2', '3', '4', '6'])
  await expect(page.getByTestId('batch-name-shown')).toHaveText('Showing 5 of 6')
  await expect(page.getByTestId('batch-hidden-note')).toBeVisible()
  // e sits after the hidden c: "Earlier" swaps it with a, c keeps its place
  await orderTile(page, e).click()
  await page.getByTestId('order-up').click()
  await expect.poll(() => apiOrder(page, orderBatchId)).toEqual([b, d, f, e, c, a])

  await railStep(page, 'pick').click()
  await expect(page.getByTestId('pick-tile')).toHaveCount(5)
  await expect(page.getByTestId('batch-name-filter')).toHaveValue('.png')
  await railStep(page, 'censor').click()
  await expect(page.getByTestId('censor-strip-filter')).toHaveValue('.png')
  await expect(page.getByTestId('censor-strip-item')).toHaveCount(5)
  await page.getByTestId('censor-strip-filter').fill('jpg')
  await expect(page.getByTestId('censor-strip-item')).toHaveCount(1)
  await expect(page.getByTestId('censor-strip-item')).toHaveAttribute('data-id', String(c))

  await railStep(page, 'order').click()
  await expect.poll(() => tileIds(page)).toEqual([c])
  await page.getByTestId('batch-filter-clear').click()
  await expect(page.getByTestId('order-tile')).toHaveCount(6)

  // a library condition: the two made by ComfyUI
  await page.getByTestId('batch-condition').fill('gen:comfyui')
  await expect(page.getByTestId('batch-condition-count')).toHaveText('2 matching')
  await expect(page.getByTestId('batch-condition-outside')).toHaveCount(0)
  await expect(page.locator('[data-testid="order-tile"][data-dim]')).toHaveCount(4)
  await page.getByTestId('batch-select-matches').click()
  const selected = () => page.locator('[data-testid="order-tile"][data-selected]').evaluateAll((els) => els.map((el) => Number(el.getAttribute('data-id'))))
  await expect.poll(selected).toEqual([d, f])
  await page.getByTestId('order-bottom').click()
  await expect.poll(() => apiOrder(page, orderBatchId)).toEqual([b, e, c, a, d, f])

  // a match the name filter hides is counted and said, but not selected
  await page.getByTestId('batch-name-filter').fill('.png')
  await page.getByTestId('batch-condition').fill('gen:nai')
  await expect(page.getByTestId('batch-condition-count')).toHaveText('4 matching; hidden by the name filter and not selected: 1')
  await expect(page.getByTestId('batch-select-matches')).toHaveText('Select the 3 matching')
  await page.getByTestId('batch-select-matches').click()
  await expect.poll(selected).toEqual([b, e, a])

  expect(await pageOverflow(page)).toBeLessThanOrEqual(0)
  expect(errors).toEqual([])
})

/** Today's local date and the time now as {date} / {time} write them (YYYYMMDD, HHMMSS). */
function stampNow(): { date: string; time: string } {
  const now = new Date()
  const two = (n: number) => String(n).padStart(2, '0')
  return { date: `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}`, time: `${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}` }
}

test('name: {date} and {time} are the moment of the export; the confirmation lists exactly the files written', async ({ page }) => {
  const errors = watchErrors(page)
  await page.setViewportSize({ width: 1366, height: 768 })
  await openBatch(page)
  await railStep(page, 'name').click()
  await expect(page.getByTestId('name-step')).toBeVisible()
  const template = page.getByTestId('name-template')
  // the token buttons put {date} and {time} in at the caret
  await template.fill('post-')
  await page.getByTestId('name-token').filter({ hasText: '{date}' }).click()
  await expect(template).toHaveValue('post-{date}')
  // the input takes the focus back (caret after the token) before more typing
  await expect(template).toBeFocused()
  await template.fill('post-{date}-')
  await page.getByTestId('name-token').filter({ hasText: '{time}' }).click()
  await expect(template).toHaveValue('post-{date}-{time}')
  await expect(template).toBeFocused()
  await template.fill('post-{date}-{time}-{n:02}')
  await expect(page.getByTestId('name-token').filter({ hasText: '{date}' })).toContainText('export date')

  // the preview writes the date and time in; the server renders the rest
  const c = ids[2] as number
  const before = stampNow()
  const finalC = page.locator(`[data-testid="name-row"][data-id="${c}"]`).getByTestId('name-final')
  await expect(finalC).toHaveText(/^post-\d{8}-\d{6}-01\.jpg$/)
  expect((await finalC.textContent())?.slice(5, 13)).toBe(before.date)

  await railStep(page, 'export').click()
  await expect(page.getByTestId('export-step')).toBeVisible()
  await expect(page.getByTestId('export-folder')).toHaveText(OUT)
  await page.getByTestId('preflight-originals').click()
  const dialog = page.getByTestId('export-confirm')
  await expect(dialog.getByTestId('confirm-name')).toHaveCount(3)
  const listed = await dialog.getByTestId('confirm-name').allTextContents()
  for (const [i, name] of listed.entries()) expect(name).toMatch(new RegExp(`^post-${before.date}-\\d{6}-0${i + 1}\\.(png|jpg)$`))
  // wait past a whole second: the export still writes the moment the confirmation showed
  await page.waitForTimeout(1100)
  await page.getByTestId('confirm-ok').click()
  const result = page.getByTestId('export-result')
  await expect(result).toBeVisible({ timeout: 30_000 })
  await expect(result.getByTestId('result-row')).toHaveCount(3)
  for (const name of listed) {
    await expect(result.getByTestId('result-row').filter({ hasText: name })).toHaveCount(1)
    expect(fs.existsSync(path.join(OUT, name)), name).toBe(true)
  }
  const time = Number(listed[0]?.slice(14, 20))
  expect(time).toBeGreaterThanOrEqual(Number(before.time) - 1)
  expect(await pageOverflow(page)).toBeLessThanOrEqual(0)
  expect(errors).toEqual([])
})

/** The selected tiles of a grid, in the order shown. */
const selectedIn = (page: Page, testId: string) =>
  page.locator(`[data-testid="${testId}"][data-selected]`).evaluateAll((els) => els.map((el) => Number(el.getAttribute('data-id'))))

/** Drag a box from the grid's top-left padding (empty space) to the middle of the `to`-th tile. */
async function boxTo(page: Page, tileId: string, to: number): Promise<void> {
  const first = await page.getByTestId(tileId).nth(0).boundingBox()
  const last = await page.getByTestId(tileId).nth(to).boundingBox()
  if (!first || !last) throw new Error('no tile box')
  await page.mouse.move(first.x - 8, first.y - 8)
  await page.mouse.down()
  await page.mouse.move(first.x + 20, first.y + 20, { steps: 4 })
  await expect(page.getByTestId('batch-marquee')).toBeVisible()
  await page.mouse.move(last.x + last.width / 2, last.y + 20, { steps: 4 })
  await page.mouse.up()
  await expect(page.getByTestId('batch-marquee')).toHaveCount(0)
}

test('order and pick: a box from empty space adds what it touches to the Ctrl picks; a hover shows the picture larger; tiles show the aesthetic score', async ({ page }) => {
  const errors = watchErrors(page)
  await page.setViewportSize({ width: 1366, height: 768 })
  const [a, b] = ids as [number, number, number]
  const [d, , f] = more as [number, number, number]
  runBackendScript(`
import sqlite3
with sqlite3.connect(${JSON.stringify(dbPath)}) as conn:
    conn.execute("UPDATE images SET aesthetic_score = 6.42 WHERE id = ?", (${d},))
    conn.commit()
print("ok")
`)
  await openBatch(page, orderBatchId)
  await railStep(page, 'order').click()
  await expect(page.getByTestId('order-tile')).toHaveCount(6)
  const shown = await tileIds(page)

  // the score shows on the one image that has one
  await expect(page.getByTestId('order-aesthetic')).toHaveCount(1)
  await expect(orderTile(page, d).getByTestId('order-aesthetic')).toHaveText('AES 6.42')

  // Ctrl picks the last one, then a box over the first two adds them
  await orderTile(page, shown[5] as number).click({ modifiers: ['Control'] })
  await boxTo(page, 'order-tile', 1)
  await expect.poll(() => selectedIn(page, 'order-tile')).toEqual([shown[0], shown[1], shown[5]])
  await page.getByTestId('order-top').click()
  await expect.poll(() => apiOrder(page, orderBatchId)).toEqual([shown[0], shown[1], shown[5], shown[2], shown[3], shown[4]])

  // hover: after a moment the picture shows larger beside the pointer; leaving puts it away.
  // None of this batch's images has a censored copy, so the file itself shows.
  const hoverOver = async (id: number) => {
    const box = await orderTile(page, id).boundingBox()
    if (!box) throw new Error('no tile box')
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 3)
  }
  const preview = page.getByTestId('order-hover-preview')
  await hoverOver(a)
  await expect(preview).toHaveAttribute('data-id', String(a))
  await expect(preview.locator('img').last()).toHaveAttribute('src', `/api/image-file/${a}`)
  await expect(preview.locator('img[data-censored]')).toHaveCount(0)
  await page.mouse.move(200, 20)
  await expect(preview).toHaveCount(0)
  await hoverOver(b)
  await expect(preview).toHaveAttribute('data-id', String(b))
  await page.keyboard.press('Escape')
  await expect(preview).toHaveCount(0)

  // the pick grid boxes the same way
  await railStep(page, 'pick').click()
  await expect(page.getByTestId('pick-tile')).toHaveCount(6)
  const picked = await page.getByTestId('pick-tile').evaluateAll((els) => els.map((el) => Number(el.getAttribute('data-id'))))
  await boxTo(page, 'pick-tile', 1)
  await expect.poll(() => selectedIn(page, 'pick-tile')).toEqual([picked[0], picked[1]])
  expect(f).toBeGreaterThan(0)
  expect(await pageOverflow(page)).toBeLessThanOrEqual(0)
  await expect(page.getByTestId('step-next')).toBeInViewport()

  // in the first batch a has a censored copy: the hover shows that copy, never the original
  await page.goto(`/v4/#/batch/${batchId}`)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await railStep(page, 'order').click()
  await expect(page.getByTestId('order-tile')).toHaveCount(3)
  await hoverOver(a)
  await expect(preview).toHaveAttribute('data-id', String(a))
  await expect(preview.locator('img[data-censored]')).toHaveAttribute('src', /^blob:/)
  await expect(preview.locator('img:not([data-censored])')).toHaveCount(0)
  expect(errors).toEqual([])
})

/** Near: within 2 px (the box's 1 px border and sub-pixel rounding). */
const near = (actual: number, expected: number, what: string) => expect(Math.abs(actual - expected), `${what}: ${actual} vs ${expected}`).toBeLessThanOrEqual(2)

/**
 * A box from the grid's bottom-right empty corner to the middle of the `to`-th tile: it must start
 * and be drawn exactly under the pointer while held. Returns the ids of the tiles the pointer's
 * rectangle covers on screen, in grid order (what the box must pick).
 */
async function boxFromCorner(page: Page, gridId: string, tileId: string, to: number): Promise<number[]> {
  const grid = await page.getByTestId(gridId).boundingBox()
  const target = await page.getByTestId(tileId).nth(to).boundingBox()
  if (!grid || !target) throw new Error('no grid or tile box')
  const from = { x: grid.x + grid.width - 16, y: grid.y + grid.height - 16 }
  const end = { x: target.x + target.width / 2, y: target.y + 20 }
  const covered: number[] = []
  for (const el of await page.getByTestId(tileId).all()) {
    const b = await el.boundingBox()
    if (b && b.x < from.x && b.x + b.width > end.x && b.y < from.y && b.y + b.height > end.y) covered.push(Number(await el.getAttribute('data-id')))
  }
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(end.x, end.y, { steps: 8 })
  const drawn = await page.getByTestId('batch-marquee').boundingBox()
  if (!drawn) throw new Error('no box drawn')
  near(drawn.x, end.x, 'box left')
  near(drawn.y, end.y, 'box top')
  near(drawn.x + drawn.width, from.x, 'box right')
  near(drawn.y + drawn.height, from.y, 'box bottom')
  await page.mouse.up()
  await expect(page.getByTestId('batch-marquee')).toHaveCount(0)
  return covered
}

test('at 2560 x 1440 (the automatic 130 % zoom) the box starts from the far corner, is drawn under the pointer and picks what it covers; the hover preview sits beside the pointer', async ({ page }) => {
  const errors = watchErrors(page)
  await page.setViewportSize({ width: 2560, height: 1440 })
  await openBatch(page, orderBatchId)
  expect(await page.evaluate(() => document.documentElement.style.zoom)).toBe('1.3')

  await railStep(page, 'order').click()
  await expect(page.getByTestId('order-tile')).toHaveCount(6)
  const shown = await tileIds(page)
  const coveredInOrder = await boxFromCorner(page, 'order-grid', 'order-tile', 3)
  expect(coveredInOrder).toEqual([shown[3], shown[4], shown[5]])
  await expect.poll(() => selectedIn(page, 'order-tile')).toEqual(coveredInOrder)

  // the hover preview: right of the pointer and a little above it, 16 and 60 page px (x 1.3 on screen)
  await page.keyboard.press('Escape')
  const tile = await orderTile(page, shown[1] as number).boundingBox()
  if (!tile) throw new Error('no tile box')
  const pointer = { x: tile.x + tile.width / 2, y: tile.y + tile.height / 2 }
  await page.mouse.move(pointer.x, pointer.y)
  const preview = page.getByTestId('order-hover-preview')
  await expect(preview).toHaveAttribute('data-id', String(shown[1]))
  const at = await preview.boundingBox()
  if (!at) throw new Error('no preview box')
  near(at.x, pointer.x + 16 * 1.3, 'preview left')
  near(at.y, pointer.y - 60 * 1.3, 'preview top')
  expect(at.x + at.width, 'the preview stays in the window').toBeLessThanOrEqual(2560)
  await page.mouse.move(200, 20)
  await expect(preview).toHaveCount(0)

  // the pick grid boxes the same way
  await railStep(page, 'pick').click()
  await expect(page.getByTestId('pick-tile')).toHaveCount(6)
  const coveredInPick = await boxFromCorner(page, 'pick-grid', 'pick-tile', 3)
  expect(coveredInPick.length).toBeGreaterThan(0)
  await expect.poll(() => selectedIn(page, 'pick-tile')).toEqual(coveredInPick)
  expect(await pageOverflow(page)).toBeLessThanOrEqual(0)
  expect(errors).toEqual([])
})

test('condition: one click takes the library\'s current search, its generator and "only favorites" scope included', async ({ page }) => {
  const errors = watchErrors(page)
  await page.setViewportSize({ width: 1366, height: 768 })
  const [d, , f] = more as [number, number, number]
  await openBatch(page, orderBatchId)
  await railStep(page, 'order').click()
  const use = page.getByTestId('batch-use-library-search')
  // the library shows everything: nothing to take
  await page.evaluate(() => localStorage.removeItem('sd-v4-browse'))
  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(use).toBeDisabled()

  // the library searches ComfyUI images in its rail, only favorites; d is a favorite
  // (favorites follow the file path: this spec's rows get the path identity a scan would give them)
  runBackendScript(`
import sqlite3, sys
sys.path.insert(0, "backend")
from utils.source_paths import indexed_image_path_casefold
with sqlite3.connect(${JSON.stringify(dbPath)}) as conn:
    path = conn.execute("SELECT path FROM images WHERE id = ?", (${d},)).fetchone()[0]
    conn.execute(
        "INSERT INTO image_path_identities (image_id, path_key) VALUES (?, ?) "
        "ON CONFLICT(image_id) DO UPDATE SET path_key = excluded.path_key",
        (${d}, indexed_image_path_casefold(path)),
    )
    conn.commit()
print("ok")
`)
  expect((await page.request.post('/api/collections/favorites', { data: { image_id: d, favorited: true }, headers: { 'X-SD-Library-Id': 'main' } })).ok()).toBe(true)
  await page.evaluate(() =>
    localStorage.setItem('sd-v4-browse', JSON.stringify({ main: { queryText: 'width>=20', scope: { generators: ['comfyui'], folder: null, favorites: true } } })),
  )
  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(use).toBeEnabled()
  await use.click()
  await expect(page.getByTestId('batch-condition')).toHaveValue('width>=20 gen:comfyui')
  await expect(page.getByTestId('batch-only-favorites')).toBeVisible()
  await expect(page.getByTestId('batch-condition-count')).toHaveText('1 matching')
  await page.getByTestId('batch-select-matches').click()
  await expect.poll(() => selectedIn(page, 'order-tile')).toEqual([d])

  // dropping "only favorites" leaves the search: both ComfyUI images
  await page.getByTestId('batch-only-favorites').click()
  await expect(page.getByTestId('batch-only-favorites')).toHaveCount(0)
  await expect(page.getByTestId('batch-condition-count')).toHaveText('2 matching')
  await page.getByTestId('batch-select-matches').click()
  await expect.poll(async () => (await selectedIn(page, 'order-tile')).sort()).toEqual([d, f].sort())
  await page.getByTestId('batch-filter-clear').click()
  await expect(page.getByTestId('batch-condition')).toHaveValue('')

  expect((await page.request.post('/api/collections/favorites', { data: { image_id: d, favorited: false }, headers: { 'X-SD-Library-Id': 'main' } })).ok()).toBe(true)
  await page.evaluate(() => localStorage.removeItem('sd-v4-browse'))
  expect(await pageOverflow(page)).toBeLessThanOrEqual(0)
  await expect(page.getByTestId('step-next')).toBeInViewport()
  expect(errors).toEqual([])
})
