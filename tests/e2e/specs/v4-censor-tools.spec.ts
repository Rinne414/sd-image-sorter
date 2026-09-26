import { expect, test, type Page } from '@playwright/test'

import { cleanupImages, dbPath, openLibrary, pageOverflow, runBackendScript, seedImages, tmpRoot, VIEWPORTS } from '../fixtures/v4-seed'
import { PY_DELETE_IMAGES } from '../fixtures/e2e-db'

/**
 * V4 censor step extras: the clone stamp (Alt+click source, copies the
 * original), a filter applied to both images landing in both saved copies
 * (and sitting before the strokes), "show changes", the export name and F2, remove
 * background (SAM3 stubbed), the shortcut list, and "Censor…" from the
 * library's selection bar. Nothing runs a model: remove-background and the
 * model status are answered with page.route.
 *
 * Needs the V4 build: `cd frontend-v4 && npm ci && npm run build`.
 */

test.describe.configure({ mode: 'serial' })

const PREFIX = 'v4ctool-'
const DIR = 'v4-ctool'
const NAME = 'v4ctool'
const QUICK = { prefix: 'v4cquick-', token: 'v4cquicktoken', count: 2, dir: 'v4-cquick' }
const W = 240
const H = 180

let ids: number[] = []
let batchId = 0
let quickBatch = 0

function seedNoise(): number[] {
  const out = runBackendScript(`
${PY_DELETE_IMAGES}
import json, random, shutil, sqlite3
from pathlib import Path
from PIL import Image

root = Path(${JSON.stringify(tmpRoot)}) / ${JSON.stringify(DIR)}
shutil.rmtree(root, ignore_errors=True)
root.mkdir(parents=True, exist_ok=True)
rng = random.Random(23)
prefix = ${JSON.stringify(PREFIX)}
meta = json.dumps({"_parsed": {"generation_params": {"steps": 28}}})
ids = []
with sqlite3.connect(${JSON.stringify(dbPath)}) as conn:
    cur = conn.cursor()
    delete_images(cur, "filename LIKE ?", (prefix + "%",))
    for i in range(2):
        data = bytes(rng.randrange(40, 160) for _ in range(${W} * ${H} * 3))
        name = f"{prefix}{i:02d}.png"
        path = (root / name).resolve()
        Image.frombytes("RGB", (${W}, ${H}), data).save(path)
        cur.execute(
            """INSERT INTO images (path, filename, generator, prompt, negative_prompt, metadata_json,
                   width, height, file_size, source_size, source_mtime_ns, is_readable, metadata_status,
                   created_at, library_order_time, user_rating)
               VALUES (?, ?, 'nai', 'v4ctooltoken', 'lowres', ?, ?, ?, ?, ?, ?, 1, 'complete',
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
  seedImages(QUICK)
})

test.afterAll(async ({ request }) => {
  if (quickBatch) await request.delete(`/api/batches/${quickBatch}`)
  cleanupDb()
  cleanupImages(QUICK.prefix, [QUICK.dir])
})

async function openBatch(page: Page, theme: 'dark' | 'light' = 'dark'): Promise<void> {
  await page.addInitScript((th) => {
    if (sessionStorage.getItem('v4e2e-init-ctool')) return
    sessionStorage.setItem('v4e2e-init-ctool', '1')
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
  output_name: string | null
  item_state: { censor?: { ops: { type: string; tool?: string; offset?: number[] }[] } } | null
}

const apiItem = async (page: Page, imageId: number) =>
  ((await (await page.request.get(`/api/batches/${batchId}`)).json()) as { items: ApiItem[] }).items.find((i) => i.image_id === imageId) as ApiItem

const stripItem = (page: Page, i: number) => page.getByTestId('censor-strip-item').nth(i)

/** The original's pixels and the editor canvas's (`copy` false) or the saved copy's (true). */
async function pixels(page: Page, imageId: number, copy: boolean): Promise<{ a: number[]; b: number[] }> {
  return page.evaluate(
    async ({ id, batch, fromCopy }) => {
      const decode = async (url: string) => {
        const res = await fetch(url)
        const bmp = await createImageBitmap(await res.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' })
        const off = new OffscreenCanvas(bmp.width, bmp.height)
        const ctx = off.getContext('2d') as OffscreenCanvasRenderingContext2D
        ctx.drawImage(bmp, 0, 0)
        return ctx.getImageData(0, 0, bmp.width, bmp.height)
      }
      const a = await decode(`/api/image-file/${id}`)
      let b: ImageData
      if (fromCopy) b = await decode(`/api/batches/${batch}/items/${id}/censored`)
      else {
        const canvas = document.querySelector('[data-testid="censor-canvas"]') as HTMLCanvasElement
        b = (canvas.getContext('2d') as CanvasRenderingContext2D).getImageData(0, 0, canvas.width, canvas.height)
      }
      return { a: Array.from(a.data), b: Array.from(b.data) }
    },
    { id: imageId, batch: batchId, fromCopy: copy },
  )
}

const px = (d: number[], x: number, y: number) => d.slice((y * W + x) * 4, (y * W + x) * 4 + 4)

/** A pixel at brightness +50 (x 1.5), stored the way pixel buffers round (half to even), opaque. */
const brighter = (rgb: number[]) => [...Array.from(Uint8ClampedArray.from(rgb.slice(0, 3).map((v) => v * 1.5))), 255]

async function at(page: Page, x: number, y: number): Promise<[number, number]> {
  const box = await page.getByTestId('censor-canvas').boundingBox()
  if (!box) throw new Error('no canvas')
  return [box.x + (x + 0.5) * (box.width / W), box.y + (y + 0.5) * (box.height / H)]
}

async function paint(page: Page, points: [number, number][]): Promise<void> {
  const [x0, y0] = await at(page, ...(points[0] as [number, number]))
  await page.mouse.move(x0, y0)
  await page.mouse.down()
  for (const p of points.slice(1)) {
    const [x, y] = await at(page, ...p)
    await page.mouse.move(x, y, { steps: 6 })
  }
  await page.mouse.up()
}

test('create the Pixiv batch at the censor step', async ({ page }) => {
  const created = await page.request.post('/api/batches', { data: { kind: 'pixiv', name: `${NAME} post`, image_ids: ids } })
  const batch = (await created.json()).batch as { id: number; revision: number }
  batchId = batch.id
  expect((await page.request.patch(`/api/batches/${batchId}`, { data: { revision: batch.revision, current_step: 'censor' } })).ok()).toBe(true)
})

test('clone stamp: Alt+click sets the source, a stroke copies the original from there, the copy keeps it', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await openBatch(page)
  const a = ids[0] as number
  await page.keyboard.press('g')
  await expect(page.getByTestId('censor-tool-clone')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('censor-clone-hint')).toBeVisible()
  // painting without a source does nothing
  await page.getByTestId('censor-size').fill('10')
  await paint(page, [[40, 40], [42, 40]])
  await expect(stripItem(page, 0)).toHaveAttribute('data-state', 'clean')

  const [sx, sy] = await at(page, 180, 120)
  await page.keyboard.down('Alt')
  await page.mouse.click(sx, sy)
  await page.keyboard.up('Alt')
  await expect(page.getByTestId('censor-clone-hint')).toHaveCount(0)
  await expect(page.getByTestId('censor-clone-source')).toBeVisible()
  await paint(page, [[40, 40], [44, 40]])
  const shown = await pixels(page, a, false)
  // (40, 40) now shows the original at (180, 120): the offset is source minus where the stroke began
  expect(px(shown.b, 40, 40)).toEqual(px(shown.a, 180, 120))
  expect(px(shown.b, 42, 40)).toEqual(px(shown.a, 182, 120))
  expect(px(shown.b, 100, 100)).toEqual(px(shown.a, 100, 100))

  await page.keyboard.press('ArrowRight')
  await expect(stripItem(page, 0)).toHaveAttribute('data-state', 'saved')
  const copy = await pixels(page, a, true)
  expect(px(copy.b, 40, 40)).toEqual(px(copy.a, 180, 120))
  const saved = await apiItem(page, a)
  expect(saved.item_state?.censor?.ops).toMatchObject([{ type: 'stroke', tool: 'clone', offset: [140, 80] }])
})

test('show changes (H) marks the pixels that differ from the original', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await openBatch(page)
  await stripItem(page, 1).click()
  await expect(page.getByTestId('censor-position')).toHaveText('2 / 2')
  await page.getByTestId('censor-position').click()
  await page.keyboard.press('h')
  const overlay = page.getByTestId('censor-changes')
  await expect(overlay).toHaveAttribute('data-changed', '0')
  await page.keyboard.press('b')
  await page.getByTestId('censor-style-black').click()
  await page.getByTestId('censor-size').fill('20')
  await paint(page, [[60, 60], [120, 60]])
  await expect.poll(async () => Number(await overlay.getAttribute('data-changed'))).toBeGreaterThan(1000)
  await expect(page.getByTestId('censor-changes-toggle')).toHaveAttribute('aria-pressed', 'true')
  await page.getByTestId('censor-position').click()
  await page.keyboard.press('h')
  await expect(overlay).toHaveCount(0)
  // undo, so the next test starts from a clean second image
  await page.keyboard.press('Control+z')
  await expect(stripItem(page, 1)).not.toHaveAttribute('data-state', 'dirty')
})

test('a filter applied to both images lands in both saved copies, before the strokes', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await openBatch(page)
  const [a, b] = ids as [number, number]
  await page.getByTestId('censor-tab-adjust').click()
  await page.getByTestId('censor-adjust-brightness').fill('50')
  // the picture previews it before anything is applied
  await expect.poll(async () => px((await pixels(page, a, false)).b, 100, 100)).not.toEqual(px((await pixels(page, a, false)).a, 100, 100))
  await expect(page.getByTestId('censor-histogram')).toBeVisible()
  await page.getByTestId('censor-adjust-apply-all').click()
  await expect.poll(async () => (await apiItem(page, b)).has_censored, { timeout: 15_000 }).toBe(true)
  await expect.poll(async () => (await apiItem(page, a)).item_state?.censor?.ops.map((op) => op.type)).toEqual(['adjust', 'stroke'])
  for (const id of [a, b]) {
    const copy = await pixels(page, id, true)
    const [r, g, bl] = px(copy.a, 200, 150) as [number, number, number]
    expect(px(copy.b, 200, 150)).toEqual(brighter([r, g, bl]))
  }
  // the clone stroke still copies the (now brighter) picture
  const first = await pixels(page, a, true)
  const [r, g, bl] = px(first.a, 180, 120) as [number, number, number]
  expect(px(first.b, 40, 40)).toEqual(brighter([r, g, bl]))
  // the sliders go back to 0 after applying
  await expect(page.getByTestId('censor-adjust-brightness')).toHaveValue('0')
})

/** The name the export would write for an image now, as the server works it out with the default Name settings. */
async function serverName(page: Page, imageId: number): Promise<string | null> {
  const res = await page.request.post(`/api/batches/${batchId}/export/names`, {
    data: { name_template: '{batch}_{n:02}', start_number: 1, output_format: 'original', missing_censored: 'block' },
  })
  const items = ((await res.json()) as { items: { image_id: number; output_name: string | null }[] }).items
  return items.find((i) => i.image_id === imageId)?.output_name ?? null
}

test('the bar shows the export name the server computes; F2 sets an own name, empty goes back to the rule', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await openBatch(page)
  const a = ids[0] as number
  await stripItem(page, 0).click()
  const shown = page.getByTestId('censor-output-name')
  const byRule = await serverName(page, a)
  expect(byRule).toMatch(/_01\.png$/)
  await expect(shown).toHaveText(byRule as string)
  await page.getByTestId('censor-position').click()
  await page.keyboard.press('F2')
  const dialog = page.getByTestId('censor-rename-dialog')
  await expect(dialog).toContainText(byRule as string)
  const input = page.getByTestId('censor-rename-input')
  await expect(input).toBeFocused()
  await input.fill('cover_01')
  await input.press('Enter')
  await expect(dialog).toHaveCount(0)
  await expect(shown).toHaveText('cover_01.png')
  expect((await apiItem(page, a)).output_name).toBe('cover_01')
  expect(await serverName(page, a)).toBe('cover_01.png')
  // empty: the Name step's rule again
  await page.getByTestId('censor-rename').click()
  await page.getByTestId('censor-rename-input').fill('')
  await page.getByTestId('censor-rename-ok').click()
  await expect(shown).toHaveText(byRule as string)
  expect((await apiItem(page, a)).output_name).toBeNull()
})

test('remove background (R): SAM3 finds the subject, white fill previews and applies as a picture edit', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await page.route('**/api/models/status', (route) => route.fulfill({ json: { models: [{ id: 'sam3', status: 'ready', available: true }] } }))
  const bodies: Record<string, unknown>[] = []
  await openBatch(page)
  // the subject: x 60-179, y 40-139 opaque, the rest transparent (what the backend sends)
  const preview = await page.evaluate(async ([w, h]) => {
    const c = new OffscreenCanvas(w as number, h as number)
    const ctx = c.getContext('2d') as OffscreenCanvasRenderingContext2D
    ctx.fillStyle = '#808080'
    ctx.fillRect(60, 40, 120, 100)
    const blob = await c.convertToBlob({ type: 'image/png' })
    return new Promise<string>((resolve) => {
      const r = new FileReader()
      r.onload = () => resolve(r.result as string)
      r.readAsDataURL(blob)
    })
  }, [W, H])
  await page.route('**/api/censor/remove-background', async (route) => {
    bodies.push(route.request().postDataJSON())
    await route.fulfill({ json: { status: 'ok', preview, fill_mode: 'transparent', edge_threshold: 0.5 } })
  })
  const b = ids[1] as number
  await stripItem(page, 1).click()
  await page.getByTestId('censor-position').click()
  await page.keyboard.press('r')
  const dialog = page.getByTestId('censor-bg-dialog')
  await expect(dialog).toBeVisible()
  await page.getByTestId('censor-bg-fill-white').click()
  await page.getByTestId('censor-bg-find').click()
  await expect(dialog.locator('canvas')).toBeVisible()
  expect(bodies[0]).toMatchObject({ image_id: b, fill_mode: 'transparent', upright: true })
  await page.getByTestId('censor-bg-apply').click()
  await expect(dialog).toHaveCount(0)
  const shown = await pixels(page, b, false)
  expect(px(shown.b, 10, 10)).toEqual([255, 255, 255, 255])
  const inside = px(shown.a, 100, 100) as [number, number, number, number]
  // the subject keeps its (brightened) pixels
  expect(px(shown.b, 100, 100)).toEqual(brighter(inside))
  await page.keyboard.press('Control+z')
  await expect.poll(async () => px((await pixels(page, b, false)).b, 10, 10)).not.toEqual([255, 255, 255, 255])
})

test('cloning from inside a detected region copies its censoring, never the picture under it; an eraser over it shows in review', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await page.route('**/api/censor/models', (route) =>
    route.fulfill({ json: { status: 'ok', recommended_backend: 'nudenet', models: [{ id: 'nudenet', name: 'NudeNet v3', available: true }] } }),
  )
  await page.route('**/api/models/status', (route) => route.fulfill({ json: { models: [{ id: 'censor-nudenet', status: 'ready', available: true }] } }))
  await page.route('**/api/censor/detect', (route) =>
    route.fulfill({
      json: {
        status: 'ok',
        detections: [{ box: [20, 20, 80, 70], class: 'breasts', confidence: 0.9 }],
        combined_mask: null,
        combined_mask_ref: null,
        combined_mask_bounds: null,
        image_width: W,
        image_height: H,
        warnings: [],
      },
    }),
  )
  await openBatch(page)
  const b = ids[1] as number
  await stripItem(page, 1).click()
  await expect(page.getByTestId('censor-position')).toHaveText('2 / 2')
  await page.getByTestId('censor-style-black').click()
  await page.getByTestId('censor-position').click()
  await page.keyboard.press('d')
  await expect(stripItem(page, 1)).toHaveAttribute('data-review', 'waiting')
  await expect.poll(async () => px((await pixels(page, b, false)).b, 50, 45)).toEqual([0, 0, 0, 255])

  // Alt+click inside the black region, paint on a clean spot
  await page.keyboard.press('g')
  await page.getByTestId('censor-size').fill('10')
  const [sx, sy] = await at(page, 50, 45)
  await page.keyboard.down('Alt')
  await page.mouse.click(sx, sy)
  await page.keyboard.up('Alt')
  await paint(page, [[150, 120], [154, 120]])
  await expect.poll(async () => px((await pixels(page, b, false)).b, 150, 120)).toEqual([0, 0, 0, 255])

  // the eraser over the region's edge: review says the region was changed by hand
  await page.keyboard.press('e')
  await paint(page, [[76, 45], [90, 45]])
  await page.getByTestId('censor-tab-review').click()
  await expect(page.getByTestId('censor-review-region')).toHaveAttribute('data-erased', 'true')
  await expect(page.getByTestId('censor-review-region')).toContainText('erased by hand')

  await page.getByTestId('censor-position').click()
  await page.keyboard.press('ArrowLeft')
  await expect(stripItem(page, 1)).toHaveAttribute('data-state', 'saved')
  const copy = await pixels(page, b, true)
  // the destination holds the censored source pixels, not the (brightened) picture under the region
  expect(px(copy.b, 150, 120)).toEqual(px(copy.b, 50, 45))
  expect(px(copy.b, 150, 120)).toEqual([0, 0, 0, 255])
  expect(px(copy.b, 150, 120)).not.toEqual(brighter(px(copy.a, 50, 45)))
})

test('the shortcut list shows the editor keys', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await openBatch(page)
  await page.getByTestId('censor-shortcuts').click()
  const list = page.getByTestId('censor-shortcut-list')
  await expect(list).toBeVisible()
  for (const text of ['Clone', 'Show changes', 'Rename this image', 'Remove background', '(in review)']) await expect(list).toContainText(text)
  await expect(list).toBeInViewport({ ratio: 1 })
  await page.keyboard.press('Escape')
  await expect(list).toHaveCount(0)
})

test('the tabs and tools fit every desktop size', async ({ page }) => {
  for (const [i, vp] of VIEWPORTS.entries()) {
    await page.setViewportSize(vp)
    if (i === 0) await openBatch(page)
    else await page.reload()
    await page.getByTestId('censor-tab-adjust').click()
    expect(await pageOverflow(page), `overflow at ${vp.width}`).toBeLessThanOrEqual(0)
    for (const id of ['censor-adjust-apply', 'censor-preset-reset', 'censor-reset', 'step-next', 'censor-rename', 'censor-shortcuts']) {
      await expect(page.getByTestId(id), `${id} at ${vp.width}`).toBeInViewport({ ratio: 1 })
    }
    await page.getByTestId('censor-tab-brush').click()
    for (const id of ['censor-tool-clone', 'censor-changes-toggle', 'censor-undo']) {
      await expect(page.getByTestId(id), `${id} at ${vp.width}`).toBeInViewport({ ratio: 1 })
    }
  }
})

test('"Censor…" on two picks makes a pick → censor → export batch and opens its censor step', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await openLibrary(page, QUICK.token, 2)
  const tiles = page.getByTestId('tile')
  await tiles.nth(0).click({ modifiers: ['Control'] })
  await tiles.nth(1).click({ modifiers: ['Control'] })
  const bar = page.getByTestId('selection-bar')
  await bar.getByRole('button', { name: 'More' }).click()
  await page.getByRole('menuitem', { name: 'Censor…' }).click()
  await expect(page.getByTestId('censor-editor')).toBeVisible()
  await expect(page.getByTestId('censor-strip-item')).toHaveCount(2)
  const id = Number(/#\/batch\/(\d+)/.exec(page.url())?.[1])
  expect(id).toBeGreaterThan(0)
  quickBatch = id
  const batch = (await (await page.request.get(`/api/batches/${id}`)).json()) as { kind: string; steps: { id: string }[]; current_step: string; name: string }
  expect(batch.kind).toBe('custom')
  expect(batch.steps.map((s) => s.id)).toEqual(['pick', 'censor', 'export'])
  expect(batch.current_step).toBe('censor')
  expect(batch.name).toMatch(/^Censor /)
})

test('delete the batch', async ({ page }) => {
  expect((await page.request.delete(`/api/batches/${batchId}`)).ok()).toBe(true)
})
