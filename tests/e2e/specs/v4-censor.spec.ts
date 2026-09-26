import { expect, test, type Page } from '@playwright/test'

import { dbPath, pageOverflow, runBackendScript, tmpRoot, VIEWPORTS } from '../fixtures/v4-seed'
import { PY_DELETE_IMAGES } from '../fixtures/e2e-db'

/**
 * V4 censor step of a Pixiv batch: paint a mosaic stroke, leave the image and
 * the censored copy is saved (differs inside the stroke, identical far from
 * it); undo/redo/eraser; reload restores the editable ops; "Back to original"
 * removes the copy; a failed save shows on the item and is retried; settings
 * are remembered; [ ] only act inside the editor; the layout fits 1366-2560.
 *
 * Needs the V4 build: `cd frontend-v4 && npm ci && npm run build`.
 */

test.describe.configure({ mode: 'serial' })

const PREFIX = 'v4cen-'
const DIR = 'v4-cen'
const NAME = 'v4cen'
const W = 240
const H = 180
// A horizontal stroke through the middle; mosaic cells of 16 px touch rows 64-111 at most.
const STROKE: [number, number][] = [[60, 90], [120, 90], [180, 90]]

let ids: number[] = []
let batchId = 0

/** Two noise pictures (a mosaic or blur of noise always changes pixels). */
function seedNoise(): number[] {
  const out = runBackendScript(`
${PY_DELETE_IMAGES}
import json, random, shutil, sqlite3
from pathlib import Path
from PIL import Image

root = Path(${JSON.stringify(tmpRoot)}) / ${JSON.stringify(DIR)}
shutil.rmtree(root, ignore_errors=True)
root.mkdir(parents=True, exist_ok=True)
rng = random.Random(4)
prefix = ${JSON.stringify(PREFIX)}
meta = json.dumps({"_parsed": {"generation_params": {"steps": 28}}})
ids = []
with sqlite3.connect(${JSON.stringify(dbPath)}) as conn:
    cur = conn.cursor()
    delete_images(cur, "filename LIKE ?", (prefix + "%",))
    for i in range(2):
        data = bytes(rng.randrange(256) for _ in range(${W} * ${H} * 3))
        name = f"{prefix}{i:02d}.png"
        path = (root / name).resolve()
        Image.frombytes("RGB", (${W}, ${H}), data).save(path)
        cur.execute(
            """INSERT INTO images (path, filename, generator, prompt, negative_prompt, metadata_json,
                   width, height, file_size, source_size, source_mtime_ns, is_readable, metadata_status,
                   created_at, library_order_time, user_rating)
               VALUES (?, ?, 'nai', 'v4centoken', 'lowres', ?, ?, ?, ?, ?, ?, 1, 'complete',
                   datetime('now'), datetime('now'), 0)""",
            (str(path), name, meta, ${W}, ${H}, path.stat().st_size, path.stat().st_size, path.stat().st_mtime_ns),
        )
        ids.append(cur.lastrowid)
    conn.commit()
print(" ".join(str(i) for i in ids))
`)
  return (out.split('\n').at(-1) ?? '').trim().split(' ').map(Number)
}

function cleanupDb(): void {
  runBackendScript(`
${PY_DELETE_IMAGES}
import shutil, sqlite3
from pathlib import Path
with sqlite3.connect(${JSON.stringify(dbPath)}) as conn:
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("DELETE FROM batches WHERE name LIKE ?", (${JSON.stringify(NAME + '%')},))
    delete_images(conn, "filename LIKE ?", (${JSON.stringify(PREFIX + '%')},))
    conn.commit()
shutil.rmtree(Path(${JSON.stringify(tmpRoot)}) / ${JSON.stringify(DIR)}, ignore_errors=True)
print("ok")
`)
}

test.beforeAll(() => {
  cleanupDb()
  ids = seedNoise()
  expect(ids).toHaveLength(2)
})

test.afterAll(() => cleanupDb())

async function openBatch(page: Page, theme: 'dark' | 'light' = 'dark'): Promise<void> {
  await page.addInitScript((th) => {
    if (sessionStorage.getItem('v4e2e-init-censor')) return
    sessionStorage.setItem('v4e2e-init-censor', '1')
    localStorage.setItem('sd-image-sorter-lang', 'en')
    localStorage.setItem('sd-v4-theme', th)
    for (const key of Object.keys(localStorage)) if (key.startsWith('sd-v4-censor-')) localStorage.removeItem(key)
  }, theme)
  const res = await page.goto(`/v4/#/batch/${batchId}`, { waitUntil: 'domcontentloaded' })
  expect(res?.status(), 'V4 is not built: run npm run build in frontend-v4').toBe(200)
  await expect(page.getByTestId('censor-editor')).toBeVisible()
  await expect(page.getByTestId('censor-canvas')).toBeVisible()
}

interface ApiItem {
  image_id: number
  has_censored: boolean
  item_state: { censor?: { ops: unknown[] } } | null
}

async function apiItem(page: Page, imageId: number): Promise<ApiItem> {
  const res = await page.request.get(`/api/batches/${batchId}`)
  const batch = (await res.json()) as { items: ApiItem[] }
  return batch.items.find((item) => item.image_id === imageId) as ApiItem
}

const stripItem = (page: Page, i: number) => page.getByTestId('censor-strip-item').nth(i)

/** The batch writes the page sends from now on, as "METHOD /path" (plus whether a body came with it). */
function recordWrites(page: Page): string[] {
  const writes: string[] = []
  page.on('request', (req) => {
    const url = new URL(req.url())
    if (req.method() === 'GET' || !url.pathname.startsWith('/api/batches/')) return
    // The export-name preview (shown in the editor bar) is a POST that writes nothing.
    if (url.pathname.endsWith('/export/names')) return
    // The copy is a multipart upload: its body is not shown to Playwright, its content type is.
    const multipart = (req.headers()['content-type'] ?? '').startsWith('multipart/form-data')
    writes.push(`${req.method()} ${url.pathname}${req.postData() || multipart ? ' +body' : ''}`)
  })
  return writes
}

/** Drag through image-pixel points on the canvas. */
async function paint(page: Page, points: [number, number][]): Promise<void> {
  const box = await page.getByTestId('censor-canvas').boundingBox()
  if (!box) throw new Error('no canvas')
  const scale = box.width / W
  const at = ([x, y]: [number, number]) => [box.x + x * scale, box.y + y * scale] as const
  const [x0, y0] = at(points[0] as [number, number])
  await page.mouse.move(x0, y0)
  await page.mouse.down()
  for (const p of points.slice(1)) {
    const [x, y] = at(p)
    await page.mouse.move(x, y, { steps: 8 })
  }
  await page.mouse.up()
}

interface Diff {
  /** Pixels on the stroke's centre line (x 70-169, y 90) that differ from the original. */
  inside: number
  /** Pixels in rows 0-47 (far above the stroke) that differ. */
  far: number
  /** Every pixel that differs. */
  total: number
  width: number
  height: number
}

/** Compare the original with the editor canvas (`censored` false) or the saved copy (true); null when there is no copy. */
async function diffFromOriginal(page: Page, imageId: number, censored: boolean): Promise<Diff | null> {
  return page.evaluate(
    async ({ id, batch, fromCopy }) => {
      const decode = async (url: string) => {
        const res = await fetch(url)
        if (!res.ok) return null
        const bmp = await createImageBitmap(await res.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' })
        const off = new OffscreenCanvas(bmp.width, bmp.height)
        const ctx = off.getContext('2d') as OffscreenCanvasRenderingContext2D
        ctx.drawImage(bmp, 0, 0)
        return ctx.getImageData(0, 0, bmp.width, bmp.height)
      }
      const a = await decode(`/api/image-file/${id}`)
      let b: ImageData | null
      if (fromCopy) b = await decode(`/api/batches/${batch}/items/${id}/censored`)
      else {
        const canvas = document.querySelector('[data-testid="censor-canvas"]') as HTMLCanvasElement
        b = (canvas.getContext('2d') as CanvasRenderingContext2D).getImageData(0, 0, canvas.width, canvas.height)
      }
      if (!a || !b) return null
      const differs = (x: number, y: number) => {
        const i = (y * a.width + x) * 4
        return a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] || a.data[i + 2] !== b.data[i + 2]
      }
      let inside = 0
      for (let x = 70; x < 170; x++) if (differs(x, 90)) inside++
      let far = 0
      let total = 0
      for (let y = 0; y < a.height; y++) {
        for (let x = 0; x < a.width; x++) {
          if (!differs(x, y)) continue
          total++
          if (y < 48) far++
        }
      }
      return { inside, far, total, width: b.width, height: b.height }
    },
    { id: imageId, batch: batchId, fromCopy: censored },
  )
}

test('create the Pixiv batch at the censor step', async ({ page }) => {
  const created = await page.request.post('/api/batches', { data: { kind: 'pixiv', name: `${NAME} post`, image_ids: ids } })
  expect(created.status()).toBe(201)
  const batch = (await created.json()).batch as { id: number; revision: number }
  batchId = batch.id
  const patched = await page.request.patch(`/api/batches/${batchId}`, { data: { revision: batch.revision, current_step: 'censor' } })
  expect(patched.ok()).toBe(true)
})

test('paint, leave the image, and the saved copy differs only where painted; undo, redo and the eraser', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await openBatch(page)
  await expect(page.getByTestId('censor-position')).toHaveText('1 / 2')
  await expect(page.getByTestId('censor-strip-item')).toHaveCount(2)
  await expect(stripItem(page, 0)).toHaveAttribute('aria-current', 'true')
  await expect(stripItem(page, 0)).toHaveAttribute('data-state', 'clean')
  await expect(page.getByTestId('censor-undo')).toHaveAttribute('title', 'Undo (Ctrl+Z)')
  await expect(page.getByTestId('censor-redo')).toHaveAttribute('title', 'Redo (Ctrl+Shift+Z / Ctrl+Y)')

  await page.keyboard.press('b')
  await page.getByTestId('censor-style-mosaic').click()
  await page.getByTestId('censor-size').fill('40')
  await page.getByTestId('censor-block').fill('16')
  await paint(page, STROKE)
  await expect(stripItem(page, 0)).toHaveAttribute('data-state', 'dirty')
  await expect(page.getByTestId('censor-status')).toHaveText('Changed; saved when you leave this image')
  const painted = await diffFromOriginal(page, ids[0] as number, false)
  expect(painted?.inside).toBeGreaterThan(90)
  expect(painted?.far).toBe(0)

  // leaving the image saves its copy and its ops in one request
  const writes = recordWrites(page)
  await page.keyboard.press('ArrowRight')
  await expect(page.getByTestId('censor-position')).toHaveText('2 / 2')
  await expect(stripItem(page, 0)).toHaveAttribute('data-state', 'saved')
  await expect(stripItem(page, 0)).toContainText('Censored')
  const copy = await diffFromOriginal(page, ids[0] as number, true)
  expect(copy).toMatchObject({ width: W, height: H, far: 0 })
  expect(copy?.inside).toBeGreaterThan(90)
  expect(copy?.total).toBe(painted?.total)
  const saved = await apiItem(page, ids[0] as number)
  expect(saved.has_censored).toBe(true)
  expect(saved.item_state?.censor?.ops).toHaveLength(1)
  expect(writes).toEqual([`PUT /api/batches/${batchId}/items/${ids[0]}/censored/file +body`])
  // the second image has no edits and no copy
  await expect(stripItem(page, 1)).toHaveAttribute('data-state', 'clean')
  expect((await page.request.get(`/api/batches/${batchId}/items/${ids[1]}/censored`)).status()).toBe(404)

  // history survives switching images: undo, Ctrl+Shift+Z, Ctrl+Y
  await page.getByTestId('censor-prev').click()
  await expect(page.getByTestId('censor-position')).toHaveText('1 / 2')
  await expect.poll(async () => (await diffFromOriginal(page, ids[0] as number, false))?.total).toBe(painted?.total)
  await page.keyboard.press('Control+z')
  await expect.poll(async () => (await diffFromOriginal(page, ids[0] as number, false))?.total).toBe(0)
  await expect(stripItem(page, 0)).toHaveAttribute('data-state', 'dirty')
  await page.keyboard.press('Control+Shift+z')
  await expect.poll(async () => (await diffFromOriginal(page, ids[0] as number, false))?.total).toBe(painted?.total)
  await expect(stripItem(page, 0)).toHaveAttribute('data-state', 'saved')
  await page.keyboard.press('Control+z')
  await page.keyboard.press('Control+y')
  await expect.poll(async () => (await diffFromOriginal(page, ids[0] as number, false))?.total).toBe(painted?.total)
  await expect(stripItem(page, 0)).toHaveAttribute('data-state', 'saved')

  // the eraser brings back the exact original pixels
  await page.keyboard.press('e')
  await expect(page.getByTestId('censor-tool-eraser')).toHaveAttribute('aria-pressed', 'true')
  await page.getByTestId('censor-size').fill('200')
  await paint(page, [[20, 90], [120, 90], [220, 90]])
  await expect.poll(async () => (await diffFromOriginal(page, ids[0] as number, false))?.total).toBe(0)
  await expect(stripItem(page, 0)).toHaveAttribute('data-state', 'dirty')
  await page.getByTestId('censor-undo').click()
  await expect.poll(async () => (await diffFromOriginal(page, ids[0] as number, false))?.total).toBe(painted?.total)
  await expect(stripItem(page, 0)).toHaveAttribute('data-state', 'saved')
  await page.keyboard.press('b')
})

test('reload restores the editable ops and the "censored" mark', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await openBatch(page)
  // it opens on the first image without a copy
  await expect(page.getByTestId('censor-position')).toHaveText('2 / 2')
  await expect(stripItem(page, 0)).toHaveAttribute('data-state', 'saved')
  await stripItem(page, 0).click()
  await expect(page.getByTestId('censor-position')).toHaveText('1 / 2')
  await expect.poll(async () => (await diffFromOriginal(page, ids[0] as number, false))?.inside ?? 0).toBeGreaterThan(90)
  const canvas = await diffFromOriginal(page, ids[0] as number, false)
  const copy = await diffFromOriginal(page, ids[0] as number, true)
  expect(canvas?.total).toBe(copy?.total)
  await expect(page.getByTestId('censor-undo')).toBeDisabled()
})

test('"Back to original" asks first (Cancel focused) and removes the copy', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await openBatch(page)
  await stripItem(page, 0).click()
  await page.getByTestId('censor-reset').click()
  const dialog = page.getByTestId('censor-reset-dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused()
  // keys stay with the dialog: Ctrl+Z does nothing underneath
  await page.keyboard.press('Control+z')
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(stripItem(page, 0)).toHaveAttribute('data-state', 'saved')

  await page.getByTestId('censor-reset').click()
  const writes = recordWrites(page)
  await page.getByTestId('censor-reset-ok').click()
  await expect(stripItem(page, 0)).toHaveAttribute('data-state', 'clean')
  expect(writes).toEqual([`DELETE /api/batches/${batchId}/items/${ids[0]}/censored +body`])
  await expect.poll(async () => (await page.request.get(`/api/batches/${batchId}/items/${ids[0]}/censored`)).status()).toBe(404)
  const item = await apiItem(page, ids[0] as number)
  expect(item.has_censored).toBe(false)
  expect(item.item_state?.censor).toBeUndefined()
  await expect.poll(async () => (await diffFromOriginal(page, ids[0] as number, false))?.total).toBe(0)
  await expect(page.getByTestId('censor-reset')).toBeDisabled()
  // the reset is one undo step
  await page.keyboard.press('Control+z')
  await expect(stripItem(page, 0)).toHaveAttribute('data-state', 'dirty')
  await page.keyboard.press('Control+s')
  await expect(stripItem(page, 0)).toHaveAttribute('data-state', 'saved')
  expect((await apiItem(page, ids[0] as number)).has_censored).toBe(true)
})

test('a failed save shows on the item with its reason and is retried on the next leave', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await openBatch(page)
  await expect(page.getByTestId('censor-position')).toHaveText('2 / 2')
  const failing = /\/api\/batches\/\d+\/items\/\d+\/censored\/file$/
  // the save fails once
  await page.route(
    failing,
    (route) => (route.request().method() === 'PUT' ? route.fulfill({ status: 500, json: { detail: 'disk full (test)' } }) : route.continue()),
    { times: 1 },
  )
  const writes = recordWrites(page)
  await paint(page, STROKE)
  await page.keyboard.press('ArrowLeft')
  await expect(stripItem(page, 1)).toHaveAttribute('data-state', 'error')
  await expect(stripItem(page, 1)).toHaveAttribute('title', /the server failed \(500\)/)
  await expect(page.getByTestId('censor-strip-failed')).toHaveText('1 failed to save')
  const item = await apiItem(page, ids[1] as number)
  expect(item.has_censored).toBe(false)
  expect(item.item_state?.censor).toBeUndefined()
  // still unsaved: leaving the image it failed on does not count it as censored
  await page.keyboard.press('ArrowRight')
  await expect(page.getByTestId('censor-status')).toContainText('Save failed: the server failed (500). Tried again')
  await page.keyboard.press('ArrowLeft')
  await expect(stripItem(page, 1)).toHaveAttribute('data-state', 'saved')
  await expect(page.getByTestId('censor-strip-failed')).toHaveCount(0)
  // the retry wrote the copy and the ops together; no separate state request was ever sent
  const retried = await apiItem(page, ids[1] as number)
  expect(retried.has_censored).toBe(true)
  expect(retried.item_state?.censor?.ops).toHaveLength(1)
  const copy = `PUT /api/batches/${batchId}/items/${ids[1]}/censored/file +body`
  expect(writes).toEqual([copy, copy])
})

test('a save refused as too large is not retried on every leave; Retry sends it again', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await openBatch(page)
  await stripItem(page, 1).click()
  await expect(page.getByTestId('censor-position')).toHaveText('2 / 2')
  await expect.poll(() => page.getByTestId('censor-canvas').evaluate((c: HTMLCanvasElement) => !c.hidden && c.width > 0)).toBe(true)
  await page.route(
    /\/api\/batches\/\d+\/items\/\d+\/censored\/file$/,
    (route) => route.fulfill({ status: 413, json: { error: 'The picture has 400,000,000 pixels (test)' } }),
    { times: 1 },
  )
  const writes = recordWrites(page)
  await paint(page, [[30, 150], [90, 150]])
  await page.keyboard.press('ArrowLeft')
  await expect(stripItem(page, 1)).toHaveAttribute('data-state', 'error')
  await page.keyboard.press('ArrowRight')
  const status = page.getByTestId('censor-status')
  await expect(status).toContainText('the picture has more pixels than a censored copy may have')
  await expect(status).toContainText('Not retried by itself')
  // leaving again does not upload again
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('ArrowRight')
  await expect(page.getByTestId('censor-position')).toHaveText('2 / 2')
  expect(writes).toHaveLength(1)
  await page.getByTestId('censor-save').click()
  await expect(stripItem(page, 1)).toHaveAttribute('data-state', 'saved')
  expect(writes).toHaveLength(2)
  await expect(page.getByTestId('censor-save')).toHaveCount(0)
})

test('an unsaved edit makes closing the tab ask first', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await openBatch(page)
  await paint(page, [[30, 30], [60, 40]])
  await expect(stripItem(page, 0)).toHaveAttribute('data-state', 'dirty')
  const asked = page.waitForEvent('dialog')
  await page.close({ runBeforeUnload: true })
  const dialog = await asked
  expect(dialog.type()).toBe('beforeunload')
  await dialog.dismiss()
})

test('settings are remembered; [ and ] only act inside the editor', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await openBatch(page)
  const size = page.getByTestId('censor-size')
  await page.getByTestId('censor-style-blur').click()
  await page.getByTestId('censor-block').fill('20')
  await size.fill('50')
  // the slider has the focus: the brackets still resize, the arrows stay with the slider
  await page.keyboard.press(']')
  await page.keyboard.press(']')
  await expect(size).toHaveValue('60')
  await page.keyboard.press('p')
  await page.getByTestId('censor-color').fill('#3366cc')
  await page.getByTestId('censor-opacity').fill('40')

  await page.reload()
  await expect(page.getByTestId('censor-editor')).toBeVisible()
  // the tool always starts on the brush; everything else comes back
  await expect(page.getByTestId('censor-tool-brush')).toHaveAttribute('aria-pressed', 'true')
  await expect(size).toHaveValue('60')
  await expect(page.getByTestId('censor-style-blur')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('censor-block')).toHaveValue('20')
  await page.keyboard.press('p')
  await expect(page.getByTestId('censor-color')).toHaveValue('#3366cc')
  await expect(page.getByTestId('censor-opacity')).toHaveValue('40')

  // on the library page the brackets change nothing
  await page.getByRole('button', { name: 'Library', exact: true }).click()
  await expect(page.getByTestId('censor-editor')).toHaveCount(0)
  await page.keyboard.press(']')
  await page.keyboard.press('[')
  await page.keyboard.press('[')
  expect(await page.evaluate(() => localStorage.getItem('sd-v4-censor-size'))).toBe('60')

  await page.goto(`/v4/#/batch/${batchId}`)
  await expect(page.getByTestId('censor-editor')).toBeVisible()
  await page.keyboard.press(']')
  await expect(size).toHaveValue('65')
})

test('zoom around the pointer, fit with 0, pan with Space and the middle button', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await openBatch(page)
  const zoom = page.getByTestId('censor-zoom')
  const fitted = await zoom.textContent()
  await page.getByTestId('censor-zoom-in').click()
  await expect(zoom).not.toHaveText(fitted ?? '')
  await page.keyboard.press('0')
  await expect(zoom).toHaveText(fitted ?? '')

  const canvas = page.getByTestId('censor-canvas')
  const before = await canvas.boundingBox()
  if (!before) throw new Error('no canvas')
  const cx = before.x + before.width / 2
  const cy = before.y + before.height / 2
  await page.mouse.move(cx, cy)
  await page.keyboard.down('Control')
  await page.mouse.wheel(0, -300)
  await page.keyboard.up('Control')
  await expect(zoom).not.toHaveText(fitted ?? '')
  const zoomed = await canvas.boundingBox()
  // the pixel under the pointer stays under it
  expect(Math.abs((cx - (zoomed?.x ?? 0)) / (zoomed?.width ?? 1) - 0.5)).toBeLessThan(0.02)

  await page.keyboard.down(' ')
  await page.mouse.down()
  await page.mouse.move(cx + 60, cy + 30, { steps: 4 })
  await page.mouse.up()
  await page.keyboard.up(' ')
  const panned = await canvas.boundingBox()
  expect(Math.round((panned?.x ?? 0) - (zoomed?.x ?? 0))).toBe(60)
  await page.mouse.move(cx, cy)
  await page.mouse.down({ button: 'middle' })
  await page.mouse.move(cx - 40, cy, { steps: 4 })
  await page.mouse.up({ button: 'middle' })
  const middle = await canvas.boundingBox()
  expect(Math.round((middle?.x ?? 0) - (panned?.x ?? 0))).toBe(-40)
  // panning painted nothing
  expect(await stripItem(page, 0).getAttribute('data-state')).not.toBe('dirty')
})

test('fits every desktop size: no overflow, the canvas uncovered, actions on screen', async ({ page }) => {
  for (const [i, vp] of VIEWPORTS.entries()) {
    await page.setViewportSize(vp)
    if (i === 0) await openBatch(page)
    else await page.reload()
    await expect(page.getByTestId('censor-canvas')).toBeVisible()
    expect(await pageOverflow(page), `overflow at ${vp.width}`).toBeLessThanOrEqual(0)
    await expect(page.getByTestId('step-next')).toBeInViewport()
    await expect(page.getByTestId('censor-reset')).toBeInViewport()
    for (const id of ['censor-tool-brush', 'censor-tool-eraser', 'censor-undo', 'censor-redo', 'censor-fit', 'censor-next']) {
      await expect(page.getByTestId(id), `${id} at ${vp.width}`).toBeInViewport({ ratio: 1 })
    }
    const covered = await page.getByTestId('censor-viewport').evaluate((el) => {
      const r = el.getBoundingClientRect()
      const probes = [
        [r.left + 4, r.top + 4],
        [r.right - 4, r.top + 4],
        [r.left + 4, r.bottom - 4],
        [r.right - 4, r.bottom - 4],
        [r.left + r.width / 2, r.top + r.height / 2],
      ]
      return probes.filter(([x, y]) => {
        const top = document.elementFromPoint(x as number, y as number)
        return !top || !el.contains(top)
      }).length
    })
    expect(covered, `canvas covered at ${vp.width}`).toBe(0)
  }
})

test('delete the batch: its censored copies go with it', async ({ page }) => {
  const res = await page.request.delete(`/api/batches/${batchId}`)
  expect(res.ok()).toBe(true)
  expect((await page.request.get(`/api/batches/${batchId}`)).status()).toBe(404)
})
