import { expect, test, type Page } from '@playwright/test'

import { cleanupImages, dbPath, pageOverflow, runBackendScript, seedImages, VIEWPORTS } from '../fixtures/v4-seed'

/**
 * V4 training masks in the dataset check step (slice 3g2): the mask editor
 * paints on a mask layer (leave out / keep, undo, redo) and saving flips the
 * image to "has a mask" (the saved PNG is black where it was painted);
 * removing it flips it back; leaving with unsaved changes asks first; the
 * check list names Library images without a mask once masks are in use;
 * "mask automatically" downloads the engine on first use and runs one job
 * that marks the images. The engine download, the automatic masks and the
 * job are stubbed (no model is downloaded or run); saving, loading and
 * removing masks run for real.
 *
 * Needs the V4 build: `cd frontend-v4 && npm ci && npm run build`.
 */

test.describe.configure({ mode: 'serial' })

const TOKEN = 'v4msktoken'
const PREFIX = 'v4msk-'
const DIR = 'v4-msk'
const NAME = 'v4msk'
const W = 400
const H = 300

let ids: number[] = []
let batchId = 0

const py = JSON.stringify

/** Three Library images of W x H with a textured picture (and the masks folder cleared for them). */
function seedRows(): void {
  const out = runBackendScript(`
import random, sqlite3, sys
from pathlib import Path
from PIL import Image
sys.path.insert(0, "backend")
from services import mask_service
with sqlite3.connect(${py(dbPath)}) as conn:
    rows = conn.execute("SELECT id, path FROM images WHERE filename LIKE ? ORDER BY filename", (${py(PREFIX + '%')},)).fetchall()
    for n, (image_id, image_path) in enumerate(rows):
        rnd = random.Random(n)
        img = Image.new("RGB", (8, 6))
        img.putdata([(rnd.randrange(256), rnd.randrange(256), rnd.randrange(256)) for _ in range(48)])
        img.resize((${W}, ${H}), Image.NEAREST).save(image_path)
        st = Path(image_path).stat()
        conn.execute("UPDATE images SET width = ?, height = ?, file_size = ?, source_size = ?, source_mtime_ns = ? WHERE id = ?", (${W}, ${H}, st.st_size, st.st_size, st.st_mtime_ns, image_id))
        mask_service.delete_mask(image_id)
    conn.commit()
print(",".join(str(r[0]) for r in rows))
`)
  ids = out.split(/\s+/).at(-1)!.split(',').map(Number)
}

function cleanupRows(): void {
  runBackendScript(`
import sqlite3, sys
sys.path.insert(0, "backend")
from services import mask_service
with sqlite3.connect(${py(dbPath)}) as conn:
    conn.execute("PRAGMA foreign_keys = ON")
    for (image_id,) in conn.execute("SELECT id FROM images WHERE filename LIKE ?", (${py(PREFIX + '%')},)).fetchall():
        mask_service.delete_mask(image_id)
    conn.execute("DELETE FROM batches WHERE name LIKE ?", (${py(NAME + '%')},))
    conn.execute("DELETE FROM dataset_projects WHERE name LIKE ?", (${py(NAME + '%')},))
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
  cleanupImages(PREFIX, [DIR])
})

async function openV4(page: Page, hash: string): Promise<void> {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('v4e2e-init-msk')) return
    sessionStorage.setItem('v4e2e-init-msk', '1')
    localStorage.setItem('sd-image-sorter-lang', 'en')
    localStorage.setItem('sd-v4-theme', 'dark')
  })
  await page.goto(`/v4/${hash}`, { waitUntil: 'domcontentloaded' })
}

async function apiJson<T>(page: Page, url: string, init?: { method: string; body?: unknown }): Promise<{ status: number; body: T }> {
  return page.evaluate(
    async ({ u, i }) => {
      const res = await fetch(u, { method: i?.method ?? 'GET', headers: { 'Content-Type': 'application/json' }, body: i?.body === undefined ? undefined : JSON.stringify(i.body) })
      return { status: res.status, body: await res.json() }
    },
    { u: url, i: init },
  ) as Promise<{ status: number; body: T }>
}

const hasMask = async (page: Page, id: number) =>
  (await apiJson<{ masks: Record<string, boolean> }>(page, '/api/masks/status', { method: 'POST', body: { image_ids: [id] } })).body.masks[String(id)]

/** Grey values of the saved mask at image points (read back from the backend's PNG). */
async function maskPixels(page: Page, id: number, points: [number, number][]): Promise<number[]> {
  return page.evaluate(
    async ({ url, pts }) => {
      const bitmap = await createImageBitmap(await (await fetch(url)).blob())
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
      const ctx = canvas.getContext('2d')!
      ctx.drawImage(bitmap, 0, 0)
      return pts.map(([x, y]) => ctx.getImageData(x, y, 1, 1).data[0] as number)
    },
    { url: `/api/masks/${id}?t=${Date.now()}`, pts: points },
  )
}

/** Drag across the middle of the picture on screen. */
async function paintMiddle(page: Page): Promise<void> {
  const box = (await page.getByTestId('mask-canvas').boundingBox())!
  const y = box.y + box.height / 2
  await page.mouse.move(box.x + box.width * 0.3, y)
  await page.mouse.down()
  for (let k = 1; k <= 8; k++) await page.mouse.move(box.x + box.width * (0.3 + k * 0.05), y)
  await page.mouse.up()
}

async function openCheck(page: Page): Promise<void> {
  await openV4(page, `#/batch/${batchId}`)
  await page.locator('[data-testid="rail-step"][data-step-id="check"]').click()
  await expect(page.getByTestId('check-step')).toBeVisible()
}

const state = (page: Page) => page.getByTestId('mask-state')

test('a dataset batch with three Library images', async ({ page }) => {
  await openV4(page, '#/batch')
  const made = await apiJson<{ batch: { id: number } }>(page, '/api/batches', { method: 'POST', body: { kind: 'dataset', name: `${NAME} set`, image_ids: ids } })
  expect(made.status).toBe(201)
  batchId = made.body.batch.id
})

test('painting and saving a mask flips the image to "has a mask"; the saved PNG is black where it was painted', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await openCheck(page)
  await expect(page.getByTestId('mask-coverage')).toHaveText('Masks: 0 of 3 Library images')
  // no mask anywhere and none exported: nothing to say in the list
  await expect(page.locator('[data-testid="check-issue"][data-kind="no_mask"]')).toHaveCount(0)

  await page.getByTestId('mask-edit').click()
  await expect(page.getByTestId('mask-editor')).toBeVisible()
  await expect(state(page)).toHaveText('No mask: the whole picture is trained')
  await expect(page.getByTestId('mask-share')).toHaveText('Trains 100% of this picture')
  await expect(page.getByTestId('mask-tool-drop')).toHaveAttribute('aria-pressed', 'true')

  await paintMiddle(page)
  await expect(state(page)).toHaveText('Changed, not saved')
  await expect(page.getByTestId('mask-share')).not.toHaveText('Trains 100% of this picture')
  // undo takes the stroke back (nothing left to save), redo brings it again
  await page.keyboard.press('Control+z')
  await expect(page.getByTestId('mask-share')).toHaveText('Trains 100% of this picture')
  await expect(page.getByTestId('mask-save')).toBeDisabled()
  await page.keyboard.press('Control+Shift+z')
  await expect(state(page)).toHaveText('Changed, not saved')

  expect(await hasMask(page, ids[0]!)).toBe(false)
  await page.getByTestId('mask-save').click()
  await expect(state(page)).toHaveText('Has a mask')
  expect(await hasMask(page, ids[0]!)).toBe(true)
  const [middle, corner] = await maskPixels(page, ids[0]!, [[W / 2, H / 2], [2, 2]])
  expect(middle).toBe(0)
  expect(corner).toBe(255)

  // leaving with a change not saved asks first; discarding keeps the saved mask as it was
  await paintMiddle(page)
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('mask-leave')).toBeVisible()
  await page.getByTestId('mask-discard').click()
  await expect(page.getByTestId('mask-editor')).toHaveCount(0)

  await expect(page.getByTestId('mask-coverage')).toHaveText('Masks: 1 of 3 Library images')
  // masks in use now: the two without one are listed
  const noMask = page.locator('[data-testid="check-issue"][data-kind="no_mask"]')
  await expect(noMask).toBeVisible()
  await expect(noMask.getByTestId('check-thumb')).toHaveCount(2)

  for (const vp of VIEWPORTS) {
    await page.setViewportSize(vp)
    await expect.poll(() => pageOverflow(page)).toBeLessThanOrEqual(0)
  }
})

test('the saved mask opens again and can be removed; the image is then trained whole', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await openCheck(page)
  await expect(page.getByTestId('mask-coverage')).toHaveText('Masks: 1 of 3 Library images')
  // the editor starts at the first image without a mask; A goes back to the one with it
  await page.getByTestId('mask-edit').click()
  await expect(state(page)).toHaveText('No mask: the whole picture is trained')
  await page.keyboard.press('a')
  await expect(state(page)).toHaveText('Has a mask')
  await expect(page.getByTestId('mask-share')).not.toHaveText('Trains 100% of this picture')

  await page.getByTestId('mask-remove').click()
  await page.getByTestId('mask-remove-yes').click()
  await expect(state(page)).toHaveText('No mask: the whole picture is trained')
  await expect(page.getByTestId('mask-share')).toHaveText('Trains 100% of this picture')
  expect(await hasMask(page, ids[0]!)).toBe(false)
})

test('the automatic mask on one image is shown, not saved, until saved', async ({ page }) => {
  await page.route('**/api/models/status', (route) => route.fulfill({ json: { models: [{ id: 'rembg', status: 'ready', available: true }, { id: 'lucida', status: 'ready', available: true }] } }))
  let asked = ''
  await page.route(/\/api\/masks\/\d+\/auto$/, async (route) => {
    asked = (route.request().postDataJSON() as { method: string }).method
    // the left half is the subject
    const dataUrl = await page.evaluate(async ([w, h]) => {
      const canvas = new OffscreenCanvas(w as number, h as number)
      const ctx = canvas.getContext('2d')!
      const img = ctx.createImageData(w as number, h as number)
      for (let i = 0; i < img.data.length; i += 4) {
        const x = (i / 4) % (w as number)
        const v = x < (w as number) / 2 ? 255 : 0
        img.data.set([v, v, v, 255], i)
      }
      ctx.putImageData(img, 0, 0)
      const blob = await canvas.convertToBlob({ type: 'image/png' })
      return await new Promise<string>((r) => {
        const reader = new FileReader()
        reader.onload = () => r(String(reader.result))
        reader.readAsDataURL(blob)
      })
    }, [W, H])
    await route.fulfill({ json: { image_id: ids[1], method: asked, width: W, height: H, data_url: dataUrl, saved: false } })
  })
  await page.setViewportSize({ width: 1366, height: 768 })
  await openCheck(page)
  await page.getByTestId('mask-edit').click()
  await expect(state(page)).toHaveText('No mask: the whole picture is trained')
  await page.getByTestId('mask-auto').click()
  await expect(page.getByTestId('mask-share')).toHaveText('Trains 50% of this picture')
  await expect(state(page)).toHaveText('Changed, not saved')
  expect(asked).toBe('rembg')
  expect(await hasMask(page, ids[0]!)).toBe(false)
  // invert: the other half
  await page.getByTestId('mask-invert').click()
  await expect(page.getByTestId('mask-share')).toHaveText('Trains 50% of this picture')
  await page.getByTestId('mask-close').click()
  await page.getByTestId('mask-discard').click()
  await expect(page.getByTestId('mask-editor')).toHaveCount(0)
})

test('"mask automatically" downloads the engine first, then one job marks the images', async ({ page }) => {
  let ready = false
  const started: { image_ids: number[]; method: string; overwrite: boolean }[] = []
  let finished = false
  await page.route('**/api/models/status', (route) =>
    route.fulfill({ json: { models: [{ id: 'lucida', status: ready ? 'ready' : 'missing', available: ready }, { id: 'rembg', status: 'ready', available: true }] } }),
  )
  await page.route('**/api/models/prepare', (route) => {
    ready = true
    return route.fulfill({ json: { status: 'started', model_id: 'lucida' } })
  })
  await page.route('**/api/models/download-progress', (route) =>
    route.fulfill({ json: { active: false, downloaded: 0, total: 0, prepare_result: { model_id: 'lucida', status: 'ok', active: false } } }),
  )
  await page.route('**/api/masks/auto-batch', (route) => {
    started.push(route.request().postDataJSON())
    return route.fulfill({ status: 202, json: { id: 'e2e-mask', job_id: 'e2e-mask', kind: 'mask_auto_batch', status: 'queued', total: 3, processed: 0 } })
  })
  await page.route('**/api/bulk-jobs/e2e-mask', (route) => {
    finished = true
    return route.fulfill({
      json: { id: 'e2e-mask', job_id: 'e2e-mask', status: 'done', total: 3, processed: 3, error_count: 0, result: { saved: 3, skipped: 0, error_count: 0, errors: [] } },
    })
  })
  // the stubbed job "saved" masks: the status says so once it has finished
  await page.route('**/api/masks/status', async (route) => {
    const body = route.request().postDataJSON() as { image_ids: number[] }
    await route.fulfill({ json: { masks: Object.fromEntries(body.image_ids.map((id) => [String(id), finished])) } })
  })

  await page.setViewportSize({ width: 1366, height: 768 })
  await openCheck(page)
  await expect(page.getByTestId('mask-coverage')).toHaveText('Masks: 0 of 3 Library images')
  await expect(page.getByTestId('mask-all')).toHaveText('Download Lucida (about 885 MB) and mask 3')
  await page.getByTestId('mask-all').click()

  await expect.poll(() => started.length, { timeout: 15_000 }).toBe(1)
  expect(started[0]).toEqual({ image_ids: ids, method: 'lucida', overwrite: false })
  await expect(page.getByTestId('mask-coverage')).toHaveText('Masks: 3 of 3 Library images', { timeout: 15_000 })
  await expect(page.locator('[data-testid="check-issue"][data-kind="no_mask"]')).toHaveCount(0)
})
