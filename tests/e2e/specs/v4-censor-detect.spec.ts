import { expect, test, type Page, type Route } from '@playwright/test'

import { dbPath, pageOverflow, runBackendScript, tmpRoot, VIEWPORTS } from '../fixtures/v4-seed'

/**
 * V4 censor step, AI detection and review: detect all as a job (stop, go on,
 * a failure named per image), the review keys (1-9 / A / Enter / S), detect
 * with D on top of a hand-painted stroke (the stroke's pixels never change;
 * re-detect replaces detections only), settings remembered, and a missing
 * model asks before anything downloads. Every detector, mask and model call is
 * stubbed with page.route: no model ever runs or downloads.
 *
 * Needs the V4 build: `cd frontend-v4 && npm ci && npm run build`.
 */

test.describe.configure({ mode: 'serial' })

const PREFIX = 'v4cdet-'
const DIR = 'v4-cdet'
const NAME = 'v4cdet'
const W = 240
const H = 180

let ids: number[] = []
let batchId = 0
/** A JPEG stored 240 x 180 with EXIF orientation 6: shown upright it is 180 x 240. */
let rotatedId = 0
let rotatedBatch = 0

function seedNoise(): number[] {
  const out = runBackendScript(`
import json, random, shutil, sqlite3
from pathlib import Path
from PIL import Image

root = Path(${JSON.stringify(tmpRoot)}) / ${JSON.stringify(DIR)}
shutil.rmtree(root, ignore_errors=True)
root.mkdir(parents=True, exist_ok=True)
rng = random.Random(11)
prefix = ${JSON.stringify(PREFIX)}
meta = json.dumps({"_parsed": {"generation_params": {"steps": 28}}})
ids = []
with sqlite3.connect(${JSON.stringify(dbPath)}) as conn:
    cur = conn.cursor()
    cur.execute("DELETE FROM images WHERE filename LIKE ?", (prefix + "%",))
    for i in range(3):
        data = bytes(rng.randrange(256) for _ in range(${W} * ${H} * 3))
        name = f"{prefix}{i:02d}.png"
        path = (root / name).resolve()
        Image.frombytes("RGB", (${W}, ${H}), data).save(path)
        cur.execute(
            """INSERT INTO images (path, filename, generator, prompt, negative_prompt, metadata_json,
                   width, height, file_size, source_size, source_mtime_ns, is_readable, metadata_status,
                   created_at, library_order_time, user_rating)
               VALUES (?, ?, 'nai', 'v4cdettoken', 'lowres', ?, ?, ?, ?, ?, ?, 1, 'complete',
                   datetime('now'), datetime('now'), 0)""",
            (str(path), name, meta, ${W}, ${H}, path.stat().st_size, path.stat().st_size, path.stat().st_mtime_ns),
        )
        ids.append(cur.lastrowid)
    data = bytes(rng.randrange(256) for _ in range(${W} * ${H} * 3))
    exif = Image.Exif()
    exif[0x0112] = 6
    path = (root / f"{prefix}rotated.jpg").resolve()
    Image.frombytes("RGB", (${W}, ${H}), data).save(path, quality=92, exif=exif)
    cur.execute(
        """INSERT INTO images (path, filename, generator, prompt, negative_prompt, metadata_json,
               width, height, file_size, source_size, source_mtime_ns, is_readable, metadata_status,
               created_at, library_order_time, user_rating)
           VALUES (?, ?, 'nai', 'v4cdettoken', 'lowres', ?, ?, ?, ?, ?, ?, 1, 'complete',
               datetime('now'), datetime('now'), 0)""",
        (str(path), path.name, meta, ${W}, ${H}, path.stat().st_size, path.stat().st_size, path.stat().st_mtime_ns),
    )
    ids.append(cur.lastrowid)
    conn.commit()
print(" ".join(str(i) for i in ids))
`)
  return (out.split('\n').at(-1) ?? '').trim().split(' ').map(Number)
}

function cleanupDb(): void {
  runBackendScript(`
import shutil, sqlite3
from pathlib import Path
with sqlite3.connect(${JSON.stringify(dbPath)}) as conn:
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("DELETE FROM batches WHERE name LIKE ?", (${JSON.stringify(NAME + '%')},))
    conn.execute("DELETE FROM images WHERE filename LIKE ?", (${JSON.stringify(PREFIX + '%')},))
    conn.commit()
shutil.rmtree(Path(${JSON.stringify(tmpRoot)}) / ${JSON.stringify(DIR)}, ignore_errors=True)
print("ok")
`)
}

test.beforeAll(() => {
  cleanupDb()
  const seeded = seedNoise()
  expect(seeded).toHaveLength(4)
  ids = seeded.slice(0, 3)
  rotatedId = seeded[3] as number
})

test.afterAll(() => cleanupDb())

// ---- stubs ----

const LEGACY_FILE = { path: 'X:\\models\\yolo\\privacy-seg.pt', name: 'privacy-seg.pt', profile: 'privacy-censor', recommended_for_censor: true }
const CENSOR_MODELS = {
  status: 'ok',
  recommended_backend: 'nudenet',
  models: [
    { id: 'legacy', name: 'Legacy YOLO', available: true, files: [LEGACY_FILE], default_model_path: LEGACY_FILE.path },
    { id: 'nudenet', name: 'NudeNet v3', available: true },
    { id: 'sam3', name: 'SAM 3', available: true },
  ],
}

type Box = [number, number, number, number]
interface Found {
  box: Box
  cls: string
  confidence: number
}

interface Stub {
  /** Model card statuses for /api/models/status. */
  cards: Record<string, string>
  /** What the detector finds, per image id (default: nothing). */
  found: Map<number, Found[]>
  /** A combined mask data URL + bounds to send with the next answers (precise shape). */
  mask: { url: string; bounds: Box } | null
  /** Image ids whose next detect fails with this reason. */
  failOnce: Map<number, string>
  /** Detect requests seen, in order. */
  detects: Record<string, unknown>[]
  prepares: Record<string, unknown>[]
  /** An image whose detect answer waits until `release` is called. */
  hold: { id: number; release: () => void; wait: Promise<void> } | null
  /** The picture size the detector reports, per image id (default: the seeded 240 x 180). */
  sizes: Map<number, [number, number]>
}

function newStub(): Stub {
  return {
    cards: { 'censor-nudenet': 'ready', 'censor-legacy': 'ready', sam3: 'ready' },
    found: new Map(),
    mask: null,
    failOnce: new Map(),
    detects: [],
    prepares: [],
    hold: null,
    sizes: new Map(),
  }
}

/** Hold the next detect answer for `id`; returns what lets it go. */
function holdImage(stub: Stub, id: number): () => void {
  let release = () => {}
  const wait = new Promise<void>((resolve) => (release = resolve))
  stub.hold = { id, release, wait }
  return release
}

async function stubDetection(page: Page, stub: Stub): Promise<void> {
  await page.route('**/api/censor/models', (route) => route.fulfill({ json: CENSOR_MODELS }))
  await page.route('**/api/models/status', (route) =>
    route.fulfill({ json: { models: Object.entries(stub.cards).map(([id, status]) => ({ id, status, available: status === 'ready' })) } }),
  )
  await page.route('**/api/models/prepare', async (route) => {
    stub.prepares.push(route.request().postDataJSON())
    stub.cards['censor-nudenet'] = 'ready'
    await route.fulfill({ json: { status: 'downloading', model_id: 'censor-nudenet' } })
  })
  await page.route('**/api/models/download-progress', (route) =>
    route.fulfill({ json: { active: false, downloaded: 0, total: 0, prepare_result: { active: false, model_id: 'censor-nudenet', status: 'ok', message: 'ready' } } }),
  )
  await page.route('**/api/censor/detect', async (route: Route) => {
    const body = route.request().postDataJSON() as { image_id: number }
    stub.detects.push(body)
    if (stub.hold && stub.hold.id === body.image_id) {
      const { wait } = stub.hold
      stub.hold = null
      await wait
    }
    const failure = stub.failOnce.get(body.image_id)
    if (failure) {
      stub.failOnce.delete(body.image_id)
      return route.fulfill({ status: 422, json: { detail: failure } })
    }
    const found = stub.found.get(body.image_id) ?? []
    await route.fulfill({
      json: {
        status: 'ok',
        image_id: body.image_id,
        detections: found.map((f) => ({ box: f.box, class: f.cls, label: f.cls.toUpperCase(), confidence: f.confidence })),
        combined_mask: stub.mask?.url ?? null,
        combined_mask_ref: null,
        combined_mask_bounds: stub.mask?.bounds ?? null,
        image_width: stub.sizes.get(body.image_id)?.[0] ?? W,
        image_height: stub.sizes.get(body.image_id)?.[1] ?? H,
        geometry_mode: 'box',
        warnings: [],
      },
    })
  })
}

// ---- page helpers ----

async function openBatch(page: Page, theme: 'dark' | 'light' = 'dark', id = batchId): Promise<void> {
  await page.addInitScript((th) => {
    if (sessionStorage.getItem('v4e2e-init-cdet')) return
    sessionStorage.setItem('v4e2e-init-cdet', '1')
    localStorage.setItem('sd-image-sorter-lang', 'en')
    localStorage.setItem('sd-v4-theme', th)
    for (const key of Object.keys(localStorage)) if (key.startsWith('sd-v4-censor-')) localStorage.removeItem(key)
  }, theme)
  const res = await page.goto(`/v4/#/batch/${id}`, { waitUntil: 'domcontentloaded' })
  expect(res?.status(), 'V4 is not built: run npm run build in frontend-v4').toBe(200)
  await expect(page.getByTestId('censor-editor')).toBeVisible()
  await expect(page.getByTestId('censor-canvas')).toBeVisible()
}

interface ApiItem {
  image_id: number
  has_censored: boolean
  item_state: { censor?: { ops: { type: string; label?: string; off?: boolean; box?: number[] }[]; reviewed?: boolean } } | null
}

async function apiItems(page: Page): Promise<ApiItem[]> {
  const res = await page.request.get(`/api/batches/${batchId}`)
  return ((await res.json()) as { items: ApiItem[] }).items
}

const apiItem = async (page: Page, imageId: number) => (await apiItems(page)).find((i) => i.image_id === imageId) as ApiItem

const stripItem = (page: Page, i: number) => page.getByTestId('censor-strip-item').nth(i)

async function goToImage(page: Page, i: number): Promise<void> {
  await stripItem(page, i).click()
  await expect(page.getByTestId('censor-position')).toHaveText(`${i + 1} / 3`)
  await expect(page.getByTestId('censor-canvas')).toBeVisible()
}

/** Pixels of the editor canvas (`copy` false) or the saved copy (true), plus the original's. */
async function pixels(page: Page, imageId: number, copy: boolean, batch = batchId): Promise<{ a: number[]; b: number[] } | null> {
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
      return a && b ? { a: Array.from(a.data), b: Array.from(b.data) } : null
    },
    { id: imageId, batch, fromCopy: copy },
  )
}

const px = (d: number[], x: number, y: number) => d.slice((y * W + x) * 4, (y * W + x) * 4 + 3)
const same = (p: { a: number[]; b: number[] }, x: number, y: number) => px(p.a, x, y).join() === px(p.b, x, y).join()

/** How many pixels of the rectangle differ from the original. */
function changedIn(p: { a: number[]; b: number[] }, [x1, y1, x2, y2]: Box): number {
  let n = 0
  for (let y = y1; y < y2; y++) for (let x = x1; x < x2; x++) if (!same(p, x, y)) n++
  return n
}

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

/** Keys go to the editor, not to whatever control was clicked last. */
async function focusEditor(page: Page): Promise<void> {
  await page.getByTestId('censor-position').click()
}

// ---- tests ----

test('create the Pixiv batch at the censor step', async ({ page }) => {
  const created = await page.request.post('/api/batches', { data: { kind: 'pixiv', name: `${NAME} post`, image_ids: ids } })
  expect(created.status()).toBe(201)
  const batch = (await created.json()).batch as { id: number; revision: number }
  batchId = batch.id
  const patched = await page.request.patch(`/api/batches/${batchId}`, { data: { revision: batch.revision, current_step: 'censor' } })
  expect(patched.ok()).toBe(true)
})

test('detect all runs as a job: stop after the first, a failure is named, go on with the rest, then review opens', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  const stub = newStub()
  const [a, b, c] = ids as [number, number, number]
  stub.found.set(a, [{ box: [20, 20, 80, 70], cls: 'breasts', confidence: 0.91 }, { box: [150, 100, 200, 150], cls: 'pussy', confidence: 0.77 }, { box: [0, 0, 10, 10], cls: 'anus', confidence: 0.2 }])
  stub.found.set(b, [{ box: [30, 30, 90, 90], cls: 'buttocks', confidence: 0.66 }])
  stub.found.set(c, [{ box: [100, 40, 160, 100], cls: 'dick', confidence: 0.83 }])
  await stubDetection(page, stub)
  await openBatch(page)

  await page.getByTestId('censor-tab-detect').click()
  const all = page.getByTestId('censor-detect-all')
  await expect(all).toHaveText('Detect all (3 not detected yet)')
  // the recommended detector is used until the user picks one
  await expect(page.getByTestId('censor-detector-nudenet')).toBeChecked()
  const release = holdImage(stub, b)
  await all.click()
  // the first image's result is saved with a "waiting for review" mark
  await expect(stripItem(page, 0)).toHaveAttribute('data-review', 'waiting')
  await expect.poll(async () => (await apiItem(page, a)).item_state?.censor?.reviewed).toBe(false)
  // stop while the second image is being detected: it finishes, the third never starts
  await expect.poll(() => stub.detects.length).toBe(2)
  await page.getByTestId('jobs-button').click()
  const job = page.getByTestId('job').first()
  await job.getByRole('button', { name: 'Stop' }).click()
  release()
  await expect(job).toContainText('Stopped after 2 of 3')
  expect(stub.detects.map((d) => d.image_id)).toEqual([a, b])
  await page.keyboard.press('Escape')

  const first = await apiItem(page, a)
  expect(first.has_censored).toBe(true)
  // below the confidence: left out; most confident first
  expect(first.item_state?.censor?.ops.map((op) => op.label)).toEqual(['breasts', 'pussy'])
  expect((await apiItem(page, c)).item_state?.censor).toBeUndefined()

  // go on: only the third image; this time it fails and the drawer names it
  await expect(all).toHaveText('Detect all (1 not detected yet)')
  stub.failOnce.set(c, 'NudeNet could not read image file (test)')
  await all.click()
  await page.getByTestId('jobs-button').click()
  const failed = page.getByTestId('job').first()
  await expect(failed).toContainText(`${PREFIX}02.png`)
  await expect(failed).toContainText('NudeNet could not read image file (test)')
  await page.keyboard.press('Escape')
  expect(stub.detects.map((d) => d.image_id)).toEqual([a, b, c])

  // and again: it goes through, and review opens on the first image waiting
  await goToImage(page, 2)
  await all.click()
  await expect(page.getByTestId('censor-tab-review')).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByTestId('censor-position')).toHaveText('1 / 3')
  await expect(page.getByTestId('censor-review-progress')).toContainText('0 / 3 reviewed')
  await expect(page.getByTestId('censor-review-region')).toHaveCount(2)
  await expect(stripItem(page, 2)).toHaveAttribute('data-review', 'waiting')
  expect(stub.detects.map((d) => d.image_id)).toEqual([a, b, c, c])
  // every request named the detector, the confidence, the targets
  expect(stub.detects[0]).toMatchObject({ model_type: 'nudenet', confidence_threshold: 0.5, exposed_only: true, target_classes: ['breasts', 'pussy', 'dick', 'anus', 'buttocks'], upright: true })
  expect(stub.detects.every((d) => d.upright === true)).toBe(true)
  await page.getByTestId('censor-tab-detect').click()
  await expect(all).toHaveText('Detect the 3 waiting again')
})

test('review keys: 1 switches a region off, A all, Enter approves and moves on, S skips', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  const stub = newStub()
  await stubDetection(page, stub)
  await openBatch(page)
  await goToImage(page, 0)
  await page.getByTestId('censor-tab-review').click()
  await expect(page.getByTestId('censor-region-overlay')).toBeVisible()
  const regions = page.getByTestId('censor-review-region')
  await expect(regions.nth(0)).toContainText('Breasts')
  await expect(regions.nth(0)).toContainText('91%')
  await expect(regions.nth(1)).toContainText('Vulva')

  const [a, b, c] = ids as [number, number, number]
  const box1: Box = [20, 20, 80, 70]
  await expect.poll(async () => changedIn((await pixels(page, a, false))!, box1)).toBeGreaterThan(1000)
  await focusEditor(page)
  await page.keyboard.press('1')
  await expect(regions.nth(0)).toHaveAttribute('aria-pressed', 'false')
  // switched off: its area is the original again, the other region stays censored
  await expect.poll(async () => changedIn((await pixels(page, a, false))!, box1)).toBe(0)
  expect(changedIn((await pixels(page, a, false))!, [150, 100, 200, 150])).toBeGreaterThan(1000)
  await page.keyboard.press('a')
  await expect(regions.nth(1)).toHaveAttribute('aria-pressed', 'false')
  await page.keyboard.press('a')
  await expect(regions.nth(0)).toHaveAttribute('aria-pressed', 'true')
  await expect(regions.nth(1)).toHaveAttribute('aria-pressed', 'true')
  await page.keyboard.press('1')

  // Enter: approve, save, next image
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('censor-position')).toHaveText('2 / 3')
  await expect(stripItem(page, 0)).toHaveAttribute('data-review', 'approved')
  await expect(page.getByTestId('censor-review-progress')).toContainText('1 / 3 reviewed')
  await expect.poll(async () => (await apiItem(page, a)).item_state?.censor?.reviewed).toBe(true)
  const approved = await apiItem(page, a)
  // the switched-off region is kept in the list, marked off
  expect(approved.item_state?.censor?.ops.map((op) => [op.label, !!op.off])).toEqual([
    ['breasts', true],
    ['pussy', false],
  ])
  const copy = (await pixels(page, a, true))!
  expect(changedIn(copy, box1)).toBe(0)
  expect(changedIn(copy, [150, 100, 200, 150])).toBeGreaterThan(1000)

  // S: skip without approving
  await page.keyboard.press('s')
  await expect(page.getByTestId('censor-position')).toHaveText('3 / 3')
  await expect(stripItem(page, 1)).toHaveAttribute('data-review', 'waiting')
  // Enter on the last one wraps to the one skipped
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('censor-position')).toHaveText('2 / 3')
  await expect.poll(async () => (await apiItem(page, c)).item_state?.censor?.reviewed).toBe(true)
  expect((await apiItem(page, b)).item_state?.censor?.reviewed).toBe(false)
  // the review keys stay in review mode: in the brush tab, 1 and Enter do nothing
  await page.getByTestId('censor-tab-brush').click()
  await focusEditor(page)
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('censor-position')).toHaveText('2 / 3')
  await expect(page.getByTestId('censor-region-overlay')).toHaveCount(0)
})

test('D detects over a hand-painted stroke: the stroke pixels never change; re-detect replaces detections only', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  const stub = newStub()
  const b = ids[1] as number
  await stubDetection(page, stub)
  await openBatch(page)
  await goToImage(page, 1)
  // start from a clean image: back to original drops the earlier detection
  await page.getByTestId('censor-reset').click()
  await page.getByTestId('censor-reset-ok').click()
  await expect(stripItem(page, 1)).toHaveAttribute('data-state', 'clean')

  // a solid pen stroke across the middle, then black detections
  await page.getByTestId('censor-style-black').click()
  await page.keyboard.press('p')
  await page.getByTestId('censor-color').fill('#3366cc')
  await page.getByTestId('censor-opacity').fill('100')
  await page.getByTestId('censor-size').fill('10')
  await paint(page, [[40, 90], [120, 90], [200, 90]])
  const painted = (await pixels(page, b, false))!
  const strokeRow = Array.from({ length: 140 }, (_, i) => px(painted.b, 50 + i, 90).join())
  expect(new Set(strokeRow)).toEqual(new Set(['51,102,204']))

  // precise: a mask covering only the left half of the detected box
  const detected: Box = [100, 60, 180, 120]
  const url = await page.evaluate(async () => {
    const c = new OffscreenCanvas(40, 60)
    const ctx = c.getContext('2d') as OffscreenCanvasRenderingContext2D
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, 40, 60)
    const blob = await c.convertToBlob({ type: 'image/png' })
    return new Promise<string>((resolve) => {
      const r = new FileReader()
      r.onload = () => resolve(r.result as string)
      r.readAsDataURL(blob)
    })
  })
  stub.mask = { url, bounds: [100, 60, 140, 120] }
  stub.found.set(b, [{ box: detected, cls: 'dick', confidence: 0.8 }])
  await focusEditor(page)
  await page.keyboard.press('d')
  await expect(stripItem(page, 1)).toHaveAttribute('data-review', 'waiting')
  await expect.poll(async () => changedIn((await pixels(page, b, false))!, [100, 60, 140, 85])).toBe(40 * 25)

  // leave the image: the saved copy has the stroke exactly as painted and the mask area censored
  await page.keyboard.press('ArrowRight')
  await expect(stripItem(page, 1)).toHaveAttribute('data-state', 'saved')
  const copy = (await pixels(page, b, true))!
  expect(Array.from({ length: 140 }, (_, i) => px(copy.b, 50 + i, 90).join())).toEqual(strokeRow)
  // inside the mask (off the stroke): black; the box's right half outside the mask: untouched
  expect(px(copy.b, 110, 70).join()).toBe('0,0,0')
  expect(changedIn(copy, [141, 60, 180, 85])).toBe(0)
  const saved = await apiItem(page, b)
  expect(saved.item_state?.censor?.ops.map((op) => op.type)).toEqual(['region', 'stroke'])
  expect(saved.item_state?.censor?.reviewed).toBe(false)
  const strokeOps = JSON.stringify(saved.item_state?.censor?.ops.filter((op) => op.type === 'stroke'))

  // re-detect (R in review): a different box replaces the old detection, the stroke stays
  await goToImage(page, 1)
  stub.mask = null
  stub.found.set(b, [{ box: [10, 10, 50, 40], cls: 'anus', confidence: 0.7 }])
  await page.getByTestId('censor-tab-review').click()
  await focusEditor(page)
  await page.keyboard.press('r')
  await expect(page.getByTestId('censor-review-region')).toHaveCount(1)
  await expect(page.getByTestId('censor-review-region')).toContainText('Anus')
  await expect.poll(async () => changedIn((await pixels(page, b, false))!, [100, 60, 140, 85])).toBe(0)
  await page.keyboard.press('Enter')
  await expect.poll(async () => (await apiItem(page, b)).item_state?.censor?.reviewed).toBe(true)
  const after = await apiItem(page, b)
  expect(after.item_state?.censor?.ops.map((op) => [op.type, op.label ?? ''])).toEqual([
    ['region', 'anus'],
    ['stroke', ''],
  ])
  expect(JSON.stringify(after.item_state?.censor?.ops.filter((op) => op.type === 'stroke'))).toBe(strokeOps)
  const final = (await pixels(page, b, true))!
  expect(Array.from({ length: 140 }, (_, i) => px(final.b, 50 + i, 90).join())).toEqual(strokeRow)
  expect(changedIn(final, [10, 10, 50, 40])).toBeGreaterThan(1000)
})

test('detection settings survive a reload and never fall back to the recommendation', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  const stub = newStub()
  await stubDetection(page, stub)
  await openBatch(page)
  await page.getByTestId('censor-tab-detect').click()
  await page.getByTestId('censor-detector-legacy').check()
  await page.getByTestId('censor-target-buttocks').uncheck()
  await page.getByTestId('censor-target-cum').check()
  await page.getByTestId('censor-confidence').fill('35')
  await page.getByTestId('censor-shape-box').click()
  await page.getByTestId('censor-sam3-common').click()
  await page.getByTestId('censor-sam3-chips').getByRole('button', { name: 'Tattoo' }).click()
  await page.getByTestId('censor-sam3-chips').getByRole('button', { name: 'face' }).click()
  await expect(page.getByTestId('censor-sam3-words')).toHaveValue('tattoo, face')

  await page.reload()
  await expect(page.getByTestId('censor-editor')).toBeVisible()
  await page.getByTestId('censor-tab-detect').click()
  await expect(page.getByTestId('censor-detector-legacy')).toBeChecked()
  await expect(page.getByTestId('censor-target-buttocks')).not.toBeChecked()
  await expect(page.getByTestId('censor-target-cum')).toBeChecked()
  await expect(page.getByTestId('censor-confidence')).toHaveValue('35')
  await expect(page.getByTestId('censor-shape-box')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('censor-sam3-words')).toHaveValue('tattoo, face')

  // a detect run sends exactly these
  stub.found.set(ids[0] as number, [])
  await goToImage(page, 0)
  await page.getByTestId('censor-detect-current').click()
  await expect.poll(() => stub.detects.length).toBe(1)
  expect(stub.detects[0]).toMatchObject({
    image_id: ids[0],
    model_type: 'legacy',
    model_path: '',
    confidence_threshold: 0.35,
    target_classes: ['breasts', 'pussy', 'dick', 'anus', 'cum'],
  })
})

test('a missing model asks first (name and size): Cancel downloads nothing; yes downloads, then detects', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  const stub = newStub()
  stub.cards['censor-nudenet'] = 'missing'
  const c = ids[2] as number
  stub.found.set(c, [{ box: [60, 60, 120, 120], cls: 'breasts', confidence: 0.9 }])
  await stubDetection(page, stub)
  await openBatch(page)
  await goToImage(page, 2)
  await focusEditor(page)
  await page.keyboard.press('d')
  const dialog = page.getByTestId('censor-download-dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('NudeNet v3')
  await expect(dialog).toContainText('about 12 MB')
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused()
  // keys stay with the dialog
  await page.keyboard.press('d')
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  expect(stub.prepares).toEqual([])
  expect(stub.detects).toEqual([])

  await page.getByTestId('censor-tab-detect').click()
  await page.getByTestId('censor-detect-current').click()
  await page.getByTestId('censor-download-yes').click()
  await expect.poll(() => stub.detects.length).toBe(1)
  expect(stub.prepares).toEqual([{ model_id: 'censor-nudenet', variant: null }])
  await expect(page.getByTestId('censor-tab-review')).toBeVisible()
  await page.getByTestId('censor-tab-review').click()
  await expect(page.getByTestId('censor-review-region')).toHaveCount(1)
})

test('SAM3 refine reshapes the detected box and text segmentation adds one area per word; the stroke stays', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  const stub = newStub()
  await stubDetection(page, stub)
  const square = await page.evaluate(async () => {
    const c = new OffscreenCanvas(10, 10)
    const ctx = c.getContext('2d') as OffscreenCanvasRenderingContext2D
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, 10, 10)
    const blob = await c.convertToBlob({ type: 'image/png' })
    return new Promise<string>((resolve) => {
      const r = new FileReader()
      r.onload = () => resolve(r.result as string)
      r.readAsDataURL(blob)
    })
  })
  const refines: { items: { box: number[] }[]; upright?: boolean }[] = []
  const segments: { upright?: boolean }[] = []
  await page.route('**/api/censor/batch-refine-mask', async (route) => {
    const body = route.request().postDataJSON() as { items: { image_id: number; box: number[] }[] }
    refines.push(body)
    const results = body.items.map((item, index) => ({
      index,
      image_id: item.image_id,
      status: 'ok',
      mask: square,
      mask_ref: null,
      mask_bounds: [item.box[0], item.box[1], (item.box[0] as number) + 10, (item.box[1] as number) + 10],
      image_width: W,
      image_height: H,
    }))
    await route.fulfill({ json: { status: 'ok', total: results.length, completed: results.length, results, errors: [] } })
  })
  await page.route('**/api/censor/segment-text', async (route) => {
    const body = route.request().postDataJSON() as { text_prompt: string; upright?: boolean }
    segments.push(body)
    const { text_prompt } = body
    if (text_prompt !== 'tattoo') return route.fulfill({ json: { status: 'no_match', message: 'nothing', mask: null } })
    await route.fulfill({ json: { status: 'ok', mask: square, mask_ref: null, mask_bounds: [5, 5, 15, 15], image_width: W, image_height: H, text_prompt } })
  })
  await openBatch(page)
  const c = ids[2] as number
  await goToImage(page, 2)
  await page.keyboard.press('p')
  await page.getByTestId('censor-size').fill('10')
  await paint(page, [[40, 160], [200, 160]])
  const painted = (await pixels(page, c, false))!
  const strokeRow = Array.from({ length: 140 }, (_, i) => px(painted.b, 50 + i, 160).join())
  expect(new Set(strokeRow).size).toBe(1)

  await page.getByTestId('censor-tab-detect').click()
  await page.getByTestId('censor-refine-current').click()
  await expect.poll(() => refines.length).toBe(1)
  // the image as detect all saved it: one box (the detection made while the model was missing was never left, so not saved)
  expect(refines[0]?.items.map((i) => i.box)).toEqual([[100, 40, 160, 100]])
  expect(refines[0]?.upright).toBe(true)
  // the box became the 10 x 10 mask SAM3 gave: its corner censored, the rest of the old box back to the original
  await expect.poll(async () => changedIn((await pixels(page, c, false))!, [120, 64, 160, 100])).toBe(0)
  expect(changedIn((await pixels(page, c, false))!, [100, 40, 110, 50])).toBeGreaterThan(50)

  await page.getByTestId('censor-sam3-words').fill('tattoo, logo')
  await page.getByTestId('censor-sam3-segment').click()
  await expect(page.getByText('Nothing matched: logo')).toBeVisible()
  expect(segments.map((s) => s.upright)).toEqual([true, true])
  await page.getByTestId('censor-tab-review').click()
  await expect(page.getByTestId('censor-review-region')).toHaveCount(2)
  await expect(page.getByTestId('censor-review-region').nth(1)).toContainText('tattoo')

  await focusEditor(page)
  await page.keyboard.press('ArrowLeft')
  await expect.poll(async () => (await apiItem(page, c)).item_state?.censor?.ops.map((op) => [op.type, op.label ?? ''])).toEqual([
    ['region', 'dick'],
    ['region', 'tattoo'],
    ['stroke', ''],
  ])
  const copy = (await pixels(page, c, true))!
  expect(Array.from({ length: 140 }, (_, i) => px(copy.b, 50 + i, 160).join())).toEqual(strokeRow)
  expect(changedIn(copy, [5, 5, 15, 15])).toBeGreaterThan(50)
})

test('a rotated JPEG is drawn upright; an answer measured on another frame is refused, the right one applied', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  const created = await page.request.post('/api/batches', { data: { kind: 'pixiv', name: `${NAME} rotated`, image_ids: [rotatedId] } })
  const batch = (await created.json()).batch as { id: number; revision: number }
  rotatedBatch = batch.id
  await page.request.patch(`/api/batches/${rotatedBatch}`, { data: { revision: batch.revision, current_step: 'censor' } })
  const stub = newStub()
  await stubDetection(page, stub)
  await openBatch(page, 'dark', rotatedBatch)
  const canvas = page.getByTestId('censor-canvas')
  // the browser applies the EXIF orientation: the picture is 180 wide, 240 high
  await expect.poll(() => canvas.evaluate((el: HTMLCanvasElement) => `${el.width}x${el.height}`)).toBe(`${H}x${W}`)

  // an answer for the file's raw frame (a backend that ignored `upright`): nothing is applied
  stub.found.set(rotatedId, [{ box: [10, 10, 120, 60], cls: 'breasts', confidence: 0.9 }])
  stub.sizes.set(rotatedId, [W, H])
  await focusEditor(page)
  await page.keyboard.press('d')
  await expect(page.getByText(`The detector measured this picture as ${W}×${H}, but it shows as ${H}×${W}; the result was not used.`, { exact: false })).toBeVisible()
  expect(stub.detects.at(-1)).toMatchObject({ image_id: rotatedId, upright: true })
  await expect(stripItem(page, 0)).toHaveAttribute('data-state', 'clean')
  await expect(stripItem(page, 0)).not.toHaveAttribute('data-review', /.+/)

  // measured upright: applied, waiting for review
  stub.sizes.set(rotatedId, [H, W])
  await page.keyboard.press('d')
  await expect(stripItem(page, 0)).toHaveAttribute('data-review', 'waiting')
  await page.getByTestId('censor-tab-review').click()
  await expect(page.getByTestId('censor-review-region')).toHaveCount(1)

  // approved with every region switched off: the batch holds a copy, and it is the original picture
  const sameAsOriginal = async () => {
    const p = await pixels(page, rotatedId, true, rotatedBatch)
    return p ? p.a.filter((v, i) => v !== p.b[i]).length + Math.abs(p.a.length - p.b.length) : -1
  }
  await focusEditor(page)
  await page.keyboard.press('a')
  await expect(page.getByTestId('censor-review-region')).toHaveAttribute('aria-pressed', 'false')
  await page.keyboard.press('Enter')
  const rotatedItem = async () => ((await (await page.request.get(`/api/batches/${rotatedBatch}`)).json()) as { items: ApiItem[] }).items[0] as ApiItem
  await expect.poll(async () => (await rotatedItem()).item_state?.censor?.reviewed).toBe(true)
  expect((await rotatedItem()).has_censored).toBe(true)
  expect((await page.request.get(`/api/batches/${rotatedBatch}/items/${rotatedId}/censored`)).status()).toBe(200)
  expect(await sameAsOriginal()).toBe(0)

  // approved with nothing at all to censor (the detection undone): still a copy, not deleted
  await page.keyboard.press('Control+z')
  await page.keyboard.press('Control+z')
  await expect(page.getByTestId('censor-review-region')).toHaveCount(0)
  await page.keyboard.press('Control+s')
  await expect.poll(async () => (await rotatedItem()).item_state?.censor?.ops.length).toBe(0)
  const approvedNothing = await rotatedItem()
  expect(approvedNothing.item_state?.censor?.reviewed).toBe(true)
  expect(approvedNothing.has_censored).toBe(true)
  expect((await page.request.get(`/api/batches/${rotatedBatch}/items/${rotatedId}/censored`)).status()).toBe(200)
  expect(await sameAsOriginal()).toBe(0)

  // "Back to original" takes the approval back: waiting for review, no copy kept
  await page.getByTestId('censor-reset').click()
  await page.getByTestId('censor-reset-ok').click()
  await expect.poll(async () => (await rotatedItem()).has_censored).toBe(false)
  expect((await rotatedItem()).item_state?.censor?.reviewed).toBe(false)
  await expect(stripItem(page, 0)).toHaveAttribute('data-review', 'waiting')
})

test('the detect and review tabs fit every desktop size', async ({ page }) => {
  const stub = newStub()
  await stubDetection(page, stub)
  for (const [i, vp] of VIEWPORTS.entries()) {
    await page.setViewportSize(vp)
    if (i === 0) await openBatch(page)
    else await page.reload()
    await expect(page.getByTestId('censor-canvas')).toBeVisible()
    await page.getByTestId('censor-tab-detect').click()
    expect(await pageOverflow(page), `overflow at ${vp.width}`).toBeLessThanOrEqual(0)
    for (const id of ['censor-detect-current', 'censor-detect-all', 'censor-reset', 'step-next']) {
      await expect(page.getByTestId(id), `${id} at ${vp.width}`).toBeInViewport({ ratio: 1 })
    }
    await page.getByTestId('censor-tab-review').click()
    for (const id of ['censor-review-approve', 'censor-review-skip', 'censor-review-redetect']) {
      await expect(page.getByTestId(id), `${id} at ${vp.width}`).toBeInViewport({ ratio: 1 })
    }
    expect(await pageOverflow(page), `overflow at ${vp.width}`).toBeLessThanOrEqual(0)
  }
})

test('delete the batch', async ({ page }) => {
  const res = await page.request.delete(`/api/batches/${batchId}`)
  expect(res.ok()).toBe(true)
})
